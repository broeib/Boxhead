//! Explicit, bounded original-game checkpoints. This is not VM serialization.
//!
//! All state reachable from the caller-selected roots is transferred exactly,
//! or export fails. Native assets and functions are explicit local anchors.

use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::object::NativeObject;
use crate::avm1::object_reference::MovieClipReference;
use crate::avm1::property::Attribute;
use crate::avm1::{Object, Value};
use crate::bitmap::bitmap_data::{BitmapData, Color};
use crate::display_object::TDisplayObject;
use crate::string::{AvmString, WStr};
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};

const FORMAT: &str = "bh-avm1-graph-v1";
const PREFIX: &str = "BHG1:";
// Three map-14-scale 1856x1504 RGBA surfaces already occupy 33,497,088
// bytes before cell objects, properties and lazy render caches. Bound the
// decoded graph at 64 MiB while retaining the previous native wire ceiling;
// the application's independent 16 MiB ASCII / 4 MiB transport caps remain.
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_WIRE: usize = 2 * (32 * 1024 * 1024) + 1024;
const MAX_NODES: usize = 65_536;
const MAX_FIELDS: usize = 1_000_000;
const MAX_ANCHORS: usize = 250_000;
const MAX_STRING: usize = 1_048_576;
const MAX_PIXELS: usize = 8_388_608;
type ResultG<T> = Result<T, String>;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Atom {
    Undefined,
    Null,
    Bool(bool),
    Number(u64),
    String(Vec<u16>),
    Ref(u32),
    Anchor(String, u8),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Field {
    name: Vec<u16>,
    flags: u16,
    value: Atom,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Pixels {
    width: u32,
    height: u32,
    transparent: bool,
    rgba: Vec<[u8; 4]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Node {
    kind: u8,
    bitmap: Option<Pixels>,
    // Raw PropertyMap iteration order: most recently inserted first.
    fields: Vec<Field>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Graph {
    swf_version: u8,
    root: Atom,
    nodes: Vec<Node>,
    fields: usize,
}

#[derive(Clone, Hash, PartialEq, Eq)]
enum Identity {
    Object(usize),
    MovieClip(Vec<u16>),
}

fn identity(value: Value<'_>) -> Option<Identity> {
    match value {
        Value::Object(value) => Some(Identity::Object(value.as_ptr() as usize)),
        Value::MovieClip(value) => Some(Identity::MovieClip(value.path().iter().collect())),
        _ => None,
    }
}

fn anchor_kind(value: Value<'_>) -> ResultG<u8> {
    let Value::Object(object) = value else {
        return if matches!(value, Value::MovieClip(_)) { Ok(64) }
            else { Err("anchor value must be an object, function or MovieClip reference".into()) };
    };
    Ok(match object.boxhead_graph_native() {
        NativeObject::None => 0,
        NativeObject::Array(_) => 1,
        NativeObject::Function(_) => 2,
        NativeObject::MovieClip(_) => 3,
        NativeObject::Button(_) => 4,
        NativeObject::EditText(_) => 5,
        NativeObject::Video(_) => 6,
        NativeObject::BitmapData(_) => 7,
        NativeObject::Bool(_) => 8,
        NativeObject::Number(_) => 9,
        NativeObject::String(_) => 10,
        NativeObject::Date(_) => 11,
        NativeObject::BlurFilter(_) => 12,
        NativeObject::BevelFilter(_) => 13,
        NativeObject::GlowFilter(_) => 14,
        NativeObject::DropShadowFilter(_) => 15,
        NativeObject::ColorMatrixFilter(_) => 16,
        NativeObject::DisplacementMapFilter(_) => 17,
        NativeObject::ConvolutionFilter(_) => 18,
        NativeObject::GradientBevelFilter(_) => 19,
        NativeObject::GradientGlowFilter(_) => 20,
        NativeObject::ColorTransform(_) => 21,
        NativeObject::Transform(_) => 22,
        NativeObject::TextFormat(_) => 23,
        NativeObject::NetStream(_) => 24,
        NativeObject::Xml(_) => 25,
        NativeObject::XmlNode(_) => 26,
        NativeObject::SharedObject(_) => 27,
        NativeObject::XmlSocket(_) => 28,
        NativeObject::FileReference(_) => 29,
        NativeObject::NetConnection(_) => 30,
        NativeObject::LocalConnection(_) => 31,
        NativeObject::Sound(_) => 32,
        NativeObject::StyleSheet(_) => 33,
        NativeObject::TextSnapshot(_) => 34,
        NativeObject::Super(_) => return Err("super objects cannot be anchors".into()),
    })
}

fn check_time(activation: &Activation<'_, '_>) -> ResultG<()> {
    if activation.context.update_start.elapsed() >= activation.context.max_execution_duration {
        Err("native graph execution timeout".into())
    } else { Ok(()) }
}

fn ascii_id(value: AvmString<'_>) -> ResultG<String> {
    if value.is_empty() || value.len() > 2048 || value.iter().any(|c| !(33..=126).contains(&c)) {
        return Err("anchor ID must be 1..2048 printable ASCII characters".into());
    }
    Ok(value.to_utf8_lossy().into_owned())
}

fn raw<'gc>(object: Object<'gc>, field: &str, activation: &mut Activation<'_, 'gc>) -> Option<Value<'gc>> {
    object.get_data(AvmString::new_utf8(activation.gc(), field), activation)
}

struct Anchors<'gc> {
    values: HashMap<String, Value<'gc>>,
    names: HashMap<Identity, String>,
    // AVM1 stores both direct StageObject values and path-based MovieClip
    // values. They can denote the same native clip without being the same
    // Value kind. Preserve that kind in the wire and at the receiving VM.
    stage_variants: HashMap<(String, u8), Value<'gc>>,
}

impl<'gc> Anchors<'gc> {
    fn insert(&mut self, id: String, value: Value<'gc>) -> ResultG<bool> {
        let key = identity(value).ok_or("anchor has a primitive value")?;
        anchor_kind(value)?;
        if let Some(previous) = self.values.get(&id) {
            if identity(*previous) != Some(key.clone()) || anchor_kind(*previous)? != anchor_kind(value)? {
                return Err(format!("anchor ID points to different objects: {id}"));
            }
            return Ok(false);
        }
        if self.values.len() >= MAX_ANCHORS { return Err("anchor count limit exceeded".into()); }
        self.values.insert(id.clone(), value);
        let new_identity = !self.names.contains_key(&key);
        self.names.entry(key).or_insert(id);
        Ok(new_identity)
    }

    fn insert_stage_variants(&mut self, id: &str, value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<()> {
        let (object, reference) = match value {
            Value::MovieClip(reference) => {
                let object = reference.coerce_to_object(activation)
                    .ok_or_else(|| format!("unresolved MovieClip anchor: {id}"))?;
                if !matches!(object.boxhead_graph_native(), NativeObject::MovieClip(_)) {
                    return Err(format!("MovieClip anchor resolved to another native kind: {id}"));
                }
                (object, reference)
            }
            Value::Object(object) if matches!(object.boxhead_graph_native(), NativeObject::MovieClip(_)) => {
                let reference = MovieClipReference::try_from_stage_object(activation, object)
                    .ok_or_else(|| format!("native MovieClip anchor has no stage reference: {id}"))?;
                (object, reference)
            }
            _ => return Ok(()),
        };
        // Native display-tree resolution does not read AS2 properties, invoke
        // user getters or run game code. No arbitrary same-path object match
        // is accepted: the direct object comes from this actual reference.
        for variant in [Value::Object(object), Value::MovieClip(reference)] {
            let kind = anchor_kind(variant)?;
            let key = identity(variant).ok_or("invalid MovieClip anchor identity")?;
            if let Some(previous) = self.names.get(&key) {
                if let Some(Value::Object(previous_object)) = self.stage_variants.get(&(previous.clone(),3)) {
                    if !Object::ptr_eq(*previous_object,object) {
                        return Err(format!("ambiguous MovieClip anchor path: {id}"));
                    }
                }
            }
            self.names.entry(key).or_insert_with(|| id.to_owned());
            self.stage_variants.insert((id.to_owned(),kind),variant);
        }
        Ok(())
    }

    fn read(value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Self> {
        let Value::Object(array) = value else { return Err("anchors must be an Array".into()); };
        if !matches!(array.boxhead_graph_native(), NativeObject::Array(_)) {
            return Err("anchors must be a native Array".into());
        }
        array.boxhead_graph_properties().map_err(str::to_owned)?;
        let Some(Value::Number(length)) = raw(array, "length", activation) else {
            return Err("anchor Array has no data length".into());
        };
        if !length.is_finite() || length.fract() != 0.0 || !(0.0..=MAX_ANCHORS as f64).contains(&length) {
            return Err("invalid anchor Array length".into());
        }
        let mut result = Self { values: HashMap::new(), names: HashMap::new(), stage_variants: HashMap::new() };
        let mut deep = VecDeque::new();
        for index in 0..length as usize {
            if index % 128 == 0 { check_time(activation)?; }
            let Some(Value::Object(row)) = raw(array, &index.to_string(), activation) else {
                return Err(format!("anchor row {index} is absent or invalid"));
            };
            if !matches!(row.boxhead_graph_native(), NativeObject::None) {
                return Err(format!("anchor row {index} is not an ordinary object"));
            }
            let properties = row.boxhead_graph_properties().map_err(str::to_owned)?;
            for (key, _, _) in &properties {
                if !["id", "value", "deep", "__proto__"].iter().any(|allowed| key.eq_with_case(allowed.as_bytes(), true)) {
                    return Err(format!("unknown anchor row field at {index}"));
                }
            }
            let Some(Value::String(id)) = raw(row, "id", activation) else {
                return Err(format!("anchor row {index} lacks a string ID"));
            };
            let id = ascii_id(id)?;
            let value = raw(row, "value", activation).ok_or("anchor row lacks value")?;
            let deep_flag = match raw(row, "deep", activation) {
                None | Some(Value::Bool(false)) => false,
                Some(Value::Bool(true)) => true,
                _ => return Err("anchor deep flag must be boolean".into()),
            };
            result.insert(id.clone(), value)?;
            result.insert_stage_variants(&id, value, activation)?;
            if deep_flag { deep.push_back((id, value)); }
        }
        // Explicit names always win over generated immutable-asset paths.
        let mut traversed = HashSet::new();
        let mut walked_fields = 0usize;
        while let Some((id, value)) = deep.pop_front() {
            check_time(activation)?;
            let Value::Object(object) = value else { continue; };
            if !matches!(object.boxhead_graph_native(), NativeObject::None | NativeObject::Array(_)) { continue; }
            if !traversed.insert(object.as_ptr() as usize) { continue; }
            let mut fields = object.boxhead_graph_properties().map_err(|e| format!("deep anchor {id}: {e}"))?;
            fields.sort_by(|a, b| a.0.iter().cmp(b.0.iter()));
            for (key, child, _) in fields {
                walked_fields += 1;
                if walked_fields > MAX_FIELDS * 4 { return Err("deep anchor field limit exceeded".into()); }
                if key.eq_with_case(b"__proto__", true) || identity(child).is_none() { continue; }
                let mut child_id = id.clone();
                child_id.push('/');
                for unit in key.iter() { child_id.push_str(&format!("{unit:04x}")); }
                if child_id.len() > 2048 { return Err("deep anchor path limit exceeded".into()); }
                let identity = identity(child).unwrap();
                // Do not create alias paths recursively; retain one canonical name.
                if let Some(existing) = result.names.get(&identity) {
                    deep.push_back((existing.clone(), child));
                } else {
                    result.insert(child_id.clone(), child)?;
                    result.insert_stage_variants(&child_id, child, activation)?;
                    deep.push_back((child_id, child));
                }
            }
        }
        Ok(result)
    }

    fn atom(&self, value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Option<Atom>> {
        let Some(key) = identity(value) else { return Ok(None); };
        let Some(id) = self.names.get(&key) else { return Ok(None); };
        if let Value::MovieClip(reference) = value {
            let object = reference.coerce_to_object(activation)
                .ok_or_else(|| format!("checkpoint MovieClip anchor no longer resolves: {id}"))?;
            let Some(Value::Object(expected)) = self.stage_variants.get(&(id.clone(),3)) else {
                return Err(format!("checkpoint MovieClip anchor lacks its native object: {id}"));
            };
            if !Object::ptr_eq(object,*expected) {
                return Err(format!("checkpoint MovieClip anchor identity differs: {id}"));
            }
        }
        Ok(Some(Atom::Anchor(id.clone(),anchor_kind(value)?)))
    }

    fn resolve(&self, name: &str, kind: u8) -> ResultG<Value<'gc>> {
        let value = *self.values.get(name).ok_or_else(|| format!("missing checkpoint anchor: {name}"))?;
        if anchor_kind(value)? == kind { return Ok(value); }
        self.stage_variants.get(&(name.to_owned(),kind)).copied()
            .ok_or_else(|| format!("checkpoint anchor kind mismatch: {name}"))
    }
}

fn bitmap_pixels(bitmap: BitmapData<'_>, activation: &mut Activation<'_, '_>) -> ResultG<Pixels> {
    let width = bitmap.width();
    let height = bitmap.height();
    let count = (width as usize).checked_mul(height as usize).ok_or("bitmap size overflow")?;
    if bitmap.disposed() || width == 0 || height == 0 || count > MAX_PIXELS {
        return Err("unsupported disposed, empty or oversized BitmapData".into());
    }
    check_time(activation)?;
    let data = bitmap.sync(activation.context.renderer).borrow();
    if data.pixels().len() != count { return Err("BitmapData pixel length mismatch".into()); }
    let rgba = data.pixels().iter().map(|c| [c.red(), c.green(), c.blue(), c.alpha()]).collect();
    Ok(Pixels { width, height, transparent: bitmap.transparency(), rgba })
}

fn export_graph<'gc>(root: Value<'gc>, anchors: &Anchors<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Graph> {
    struct Builder<'gc> {
        ids: HashMap<usize, u32>,
        pending: Vec<(Object<'gc>, String)>,
    }
    impl<'gc> Builder<'gc> {
        fn atom(&mut self, value: Value<'gc>, path: &str, anchors: &Anchors<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Atom> {
            if let Some(anchor) = anchors.atom(value,activation)? { return Ok(anchor); }
            Ok(match value {
                Value::Undefined => Atom::Undefined,
                Value::Null => Atom::Null,
                Value::Bool(v) => Atom::Bool(v),
                Value::Number(v) => Atom::Number(v.to_bits()),
                Value::String(v) => {
                    if v.len() > MAX_STRING { return Err(format!("oversized string at {path}")); }
                    Atom::String(v.iter().collect())
                }
                Value::MovieClip(_) => return Err(format!("unbound MovieClip reference at {path}")),
                Value::Object(object) => {
                    if !matches!(object.boxhead_graph_native(), NativeObject::None | NativeObject::Array(_) | NativeObject::BitmapData(_)) {
                        let detail = if let NativeObject::MovieClip(clip) = object.boxhead_graph_native() {
                            format!(", stage path {}",clip.path().to_utf8_lossy())
                        } else { String::new() };
                        return Err(format!("unbound function/native object at {path}, kind {}{detail}", anchor_kind(value)?));
                    }
                    let key = object.as_ptr() as usize;
                    let id = if let Some(id) = self.ids.get(&key) { *id } else {
                        if self.pending.len() >= MAX_NODES { return Err("graph node count limit exceeded".into()); }
                        let id = self.pending.len() as u32;
                        self.ids.insert(key, id);
                        self.pending.push((object, path.to_owned()));
                        id
                    };
                    Atom::Ref(id)
                }
            })
        }
    }
    let mut builder = Builder { ids: HashMap::new(), pending: Vec::new() };
    let root = builder.atom(root, "root", anchors, activation)?;
    let mut nodes = Vec::new();
    let mut count = 0usize;
    let mut size = 0usize;
    while nodes.len() < builder.pending.len() {
        check_time(activation)?;
        let (object, path) = builder.pending[nodes.len()].clone();
        let (kind, bitmap) = match object.boxhead_graph_native() {
            NativeObject::None => (0, None),
            NativeObject::Array(_) => (1, None),
            NativeObject::BitmapData(bitmap) => (2, Some(bitmap_pixels(bitmap, activation)?)),
            _ => return Err(format!("native kind changed during graph export at {path}")),
        };
        if let Some(bitmap) = &bitmap { size += bitmap.rgba.len() * 4; }
        let properties = object.boxhead_graph_properties().map_err(|e| format!("{path}: {e}"))?;
        let mut fields = Vec::with_capacity(properties.len());
        for (key, value, flags) in properties {
            count += 1;
            if count > MAX_FIELDS { return Err("graph field count limit exceeded".into()); }
            if count % 256 == 0 { check_time(activation)?; }
            let child_path = if path.len() <= 2048 {
                format!("{path}.{}",key.to_utf8_lossy())
            } else { format!("node[{}].{}",nodes.len(),key.to_utf8_lossy()) };
            let atom = builder.atom(value, &child_path, anchors, activation)?;
            if key.eq_with_case(b"__proto__", true) && !matches!(atom, Atom::Anchor(_, _) | Atom::Undefined | Atom::Null) {
                return Err(format!("unbound prototype at {child_path}"));
            }
            size += key.len() * 2 + 16 + match &atom { Atom::String(s) => s.len() * 2, Atom::Anchor(s, _) => s.len(), _ => 0 };
            if size > MAX_BYTES { return Err("graph data size limit exceeded".into()); }
            fields.push(Field { name: key.iter().collect(), flags: flags.bits(), value: atom });
        }
        nodes.push(Node { kind, bitmap, fields });
    }
    Ok(Graph { swf_version: activation.swf_version(), root, nodes, fields: count })
}

struct Writer(Vec<u8>);
impl Writer {
    fn u8(&mut self, v: u8) { self.0.push(v); }
    fn u16(&mut self, v: u16) { self.0.extend(v.to_le_bytes()); }
    fn u32(&mut self, v: u32) { self.0.extend(v.to_le_bytes()); }
    fn string(&mut self, s: &[u16]) -> ResultG<()> {
        if s.len() > MAX_STRING { return Err("string limit exceeded".into()); }
        self.u32(s.len() as u32);
        for c in s { self.u16(*c); }
        self.check()
    }
    fn check(&self) -> ResultG<()> {
        if self.0.len() > MAX_BYTES { Err("encoded data size limit exceeded".into()) } else { Ok(()) }
    }
    fn atom(&mut self, a: &Atom) -> ResultG<()> {
        match a {
            Atom::Undefined => self.u8(0), Atom::Null => self.u8(1),
            Atom::Bool(false) => self.u8(2), Atom::Bool(true) => self.u8(3),
            Atom::Number(v) => { self.u8(4); self.0.extend(v.to_le_bytes()); }
            Atom::String(v) => { self.u8(5); self.string(v)?; }
            Atom::Ref(v) => { self.u8(6); self.u32(*v); }
            Atom::Anchor(id, kind) => {
                self.u8(7); self.u8(*kind); self.string(&id.encode_utf16().collect::<Vec<_>>())?;
            }
        }
        self.check()
    }
}

fn pack(graph: &Graph) -> ResultG<String> {
    let mut w = Writer(Vec::new());
    w.0.extend(b"BHG\x01"); w.u8(graph.swf_version);
    w.u32(graph.nodes.len() as u32); w.u32(graph.fields as u32); w.atom(&graph.root)?;
    for node in &graph.nodes {
        w.u8(node.kind);
        if let Some(bitmap) = &node.bitmap {
            w.u32(bitmap.width); w.u32(bitmap.height); w.u8(u8::from(bitmap.transparent));
            for color in &bitmap.rgba { w.0.extend(color); }
        }
        w.u32(node.fields.len() as u32);
        for field in &node.fields { w.string(&field.name)?; w.u16(field.flags); w.atom(&field.value)?; }
        w.check()?;
    }
    let mut compressor = ZlibEncoder::new(Vec::new(), Compression::fast());
    compressor.write_all(&w.0).map_err(|e| format!("graph compression failed: {e}"))?;
    let packed = compressor.finish().map_err(|e| format!("graph compression failed: {e}"))?;
    let mut out = String::with_capacity(PREFIX.len() + 2 * packed.len()); out.push_str(PREFIX);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in packed { out.push(HEX[(b >> 4) as usize] as char); out.push(HEX[(b & 15) as usize] as char); }
    if out.len() > MAX_WIRE { return Err("graph wire limit exceeded".into()); }
    Ok(out)
}

struct Reader<'a> { bytes: &'a [u8], at: usize }
impl Reader<'_> {
    fn take(&mut self, n: usize) -> ResultG<&[u8]> {
        let end = self.at.checked_add(n).ok_or("wire offset overflow")?;
        let value = self.bytes.get(self.at..end).ok_or("truncated graph packet")?;
        self.at = end; Ok(value)
    }
    fn u8(&mut self) -> ResultG<u8> { Ok(self.take(1)?[0]) }
    fn u16(&mut self) -> ResultG<u16> { Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap())) }
    fn u32(&mut self) -> ResultG<u32> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    fn string(&mut self) -> ResultG<Vec<u16>> {
        let n = self.u32()? as usize;
        if n > MAX_STRING { return Err("graph string limit exceeded".into()); }
        Ok(self.take(n * 2)?.chunks_exact(2).map(|s| u16::from_le_bytes([s[0], s[1]])).collect())
    }
    fn atom(&mut self) -> ResultG<Atom> {
        Ok(match self.u8()? {
            0 => Atom::Undefined, 1 => Atom::Null, 2 => Atom::Bool(false), 3 => Atom::Bool(true),
            4 => Atom::Number(u64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            5 => Atom::String(self.string()?), 6 => Atom::Ref(self.u32()?),
            7 => {
                let kind = self.u8()?;
                if kind > 34 && kind != 64 { return Err("invalid anchor kind".into()); }
                let units = self.string()?;
                if units.is_empty() || units.len() > 2048 || units.iter().any(|v| !(33..=126).contains(v)) {
                    return Err("invalid encoded anchor ID".into());
                }
                Atom::Anchor(units.iter().map(|v| *v as u8 as char).collect(), kind)
            }
            _ => return Err("invalid graph atom tag".into()),
        })
    }
}

fn unpack(wire: AvmString<'_>) -> ResultG<Graph> {
    if wire.len() > MAX_WIRE { return Err("graph wire limit exceeded".into()); }
    let text = wire.to_utf8_lossy();
    let hex = text.strip_prefix(PREFIX).ok_or("wrong native graph prefix")?.as_bytes();
    if hex.len() % 2 != 0 { return Err("odd native graph hex length".into()); }
    fn nibble(v: u8) -> ResultG<u8> { match v { b'0'..=b'9' => Ok(v-b'0'), b'a'..=b'f' => Ok(v-b'a'+10), _ => Err("noncanonical graph hex".into()) } }
    let packed: Vec<u8> = hex.chunks_exact(2).map(|v| Ok(nibble(v[0])? * 16 + nibble(v[1])?)).collect::<ResultG<_>>()?;
    let mut inflater = ZlibDecoder::new(packed.as_slice());
    let mut bytes = Vec::new();
    (&mut inflater).take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| format!("invalid graph compression: {e}"))?;
    if bytes.len() > MAX_BYTES || inflater.total_in() as usize != packed.len() {
        return Err("graph exceeds size bound or has trailing compressed bytes".into());
    }
    let mut r = Reader { bytes: &bytes, at: 0 };
    if r.take(4)? != b"BHG\x01" { return Err("invalid graph header".into()); }
    let swf_version = r.u8()?;
    let count = r.u32()? as usize;
    let declared_fields = r.u32()? as usize;
    if count > MAX_NODES || declared_fields > MAX_FIELDS { return Err("graph counts exceed bounds".into()); }
    let root = r.atom()?;
    let mut fields = 0usize;
    let mut nodes = Vec::with_capacity(count);
    for _ in 0..count {
        let kind = r.u8()?;
        if kind > 2 { return Err("unsupported graph node type".into()); }
        let bitmap = if kind == 2 {
            let width = r.u32()?; let height = r.u32()?; let transparent = r.u8()?;
            let pixels = (width as usize).checked_mul(height as usize).ok_or("bitmap size overflow")?;
            if pixels == 0 || pixels > MAX_PIXELS || transparent > 1 { return Err("invalid graph BitmapData shape".into()); }
            let rgba = r.take(pixels * 4)?.chunks_exact(4).map(|s| [s[0],s[1],s[2],s[3]]).collect();
            Some(Pixels { width, height, transparent: transparent == 1, rgba })
        } else { None };
        let n = r.u32()? as usize;
        fields = fields.checked_add(n).ok_or("field count overflow")?;
        if fields > declared_fields { return Err("incorrect graph field count".into()); }
        let mut names = HashSet::new();
        let mut props = Vec::with_capacity(n);
        for _ in 0..n {
            let name = r.string()?;
            if !names.insert(name.clone()) { return Err("duplicate graph property name".into()); }
            let flags = r.u16()?;
            if Attribute::from_bits(flags).is_none() { return Err("invalid graph property flags".into()); }
            let value = r.atom()?;
            if name.as_slice() == [95,95,112,114,111,116,111,95,95] && !matches!(value, Atom::Anchor(_,_) | Atom::Null | Atom::Undefined) {
                return Err("graph prototype must be a declared anchor".into());
            }
            props.push(Field { name, flags, value });
        }
        nodes.push(Node { kind, bitmap, fields: props });
    }
    if fields != declared_fields || r.at != bytes.len() { return Err("graph count mismatch or trailing data".into()); }
    let graph = Graph { swf_version, root, nodes, fields };
    for atom in std::iter::once(&graph.root).chain(graph.nodes.iter().flat_map(|n| n.fields.iter().map(|f| &f.value))) {
        if let Atom::Ref(id) = atom && *id as usize >= graph.nodes.len() { return Err("graph reference is out of bounds".into()); }
    }
    Ok(graph)
}

fn import_graph<'gc>(graph: &Graph, anchors: &Anchors<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Value<'gc>> {
    if graph.swf_version != activation.swf_version() { return Err("checkpoint SWF version mismatch".into()); }
    // Complete all anchor resolution before creating any imported AVM object.
    for atom in std::iter::once(&graph.root).chain(graph.nodes.iter().flat_map(|n| n.fields.iter().map(|f| &f.value))) {
        if let Atom::Anchor(id, kind) = atom { anchors.resolve(id, *kind)?; }
    }
    let mut objects = Vec::with_capacity(graph.nodes.len());
    for node in &graph.nodes {
        check_time(activation)?;
        let object = Object::new_without_proto(activation.gc());
        match node.kind {
            0 => (),
            1 => object.set_native(activation.gc(), NativeObject::Array(())),
            2 => {
                let p = node.bitmap.as_ref().ok_or("missing bitmap payload")?;
                let pixels = p.rgba.iter().map(|c| Color::rgba(c[0],c[1],c[2],c[3])).collect();
                object.set_native(activation.gc(), NativeObject::BitmapData(BitmapData::new_with_pixels(activation.gc(),p.width,p.height,p.transparent,pixels)));
            }
            _ => return Err("unknown graph kind".into()),
        }
        objects.push(object);
    }
    fn atom<'gc>(a: &Atom, objects: &[Object<'gc>], anchors: &Anchors<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Value<'gc>> {
        Ok(match a {
            Atom::Undefined => Value::Undefined, Atom::Null => Value::Null,
            Atom::Bool(v) => Value::Bool(*v), Atom::Number(bits) => Value::Number(f64::from_bits(*bits)),
            Atom::String(s) => Value::String(AvmString::new(activation.gc(), WStr::from_units(s.as_slice()))),
            Atom::Ref(id) => Value::Object(objects[*id as usize]),
            Atom::Anchor(id, kind) => anchors.resolve(id,*kind)?,
        })
    }
    for (object, node) in objects.iter().zip(&graph.nodes) {
        check_time(activation)?;
        // Reversing raw iteration reconstructs the exact original insertion order.
        for field in node.fields.iter().rev() {
            let value = atom(&field.value, &objects, anchors, activation)?;
            object.define_value(activation.gc(), AvmString::new(activation.gc(),WStr::from_units(field.name.as_slice())),value,Attribute::from_bits(field.flags).unwrap());
        }
    }
    check_time(activation)?;
    atom(&graph.root, &objects, anchors, activation)
}

fn metadata<'gc>(activation: &Activation<'_, 'gc>, fields: &[(&str, Value<'gc>)]) -> Value<'gc> {
    let object = Object::new_without_proto(activation.gc());
    for (name, value) in fields { object.define_value(activation.gc(),AvmString::new_utf8(activation.gc(),*name),*value,Attribute::empty()); }
    object.into()
}

fn bitmap_copy<'gc>(target: Value<'gc>, source: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Value<'gc>> {
    let (Value::Object(target), Value::Object(source)) = (target, source) else { return Err("bitmapCopy requires two BitmapData objects".into()); };
    let (NativeObject::BitmapData(target), NativeObject::BitmapData(source)) = (target.boxhead_graph_native(), source.boxhead_graph_native()) else { return Err("bitmapCopy requires native BitmapData objects".into()); };
    if target.disposed() || source.disposed() || target.width()!=source.width() || target.height()!=source.height() || target.transparency()!=source.transparency() {
        return Err("bitmapCopy shape/transparency mismatch or disposed target".into());
    }
    if target.ptr_eq(source) { return Ok(Value::Bool(true)); }
    let pixels = bitmap_pixels(source,activation)?;
    let colors: Vec<Color> = pixels.rgba.iter().map(|c|Color::rgba(c[0],c[1],c[2],c[3])).collect();
    // Resolve the target's outstanding renderer readback before the commit.
    let data = target.sync(activation.context.renderer);
    check_time(activation)?;
    let mut write = data.borrow_mut(activation.gc());
    *write.raw_pixels_mut() = colors;
    let region = write.full_region();
    write.set_cpu_dirty(activation.gc(),region);
    Ok(Value::Bool(true))
}

pub fn call<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    fn run<'gc>(activation: &mut Activation<'_, 'gc>, args: &[Value<'gc>]) -> ResultG<Value<'gc>> {
        check_time(activation)?;
        let Some(Value::String(operation)) = args.first() else { return Err("native graph operation must be a string".into()); };
        if operation.eq_with_case(b"capability",true) && args.len()==1 {
            return Ok(metadata(activation,&[("version",1.0.into()),("contract",AvmString::new_utf8(activation.gc(),FORMAT).into()),("maxNodes",(MAX_NODES as f64).into()),("maxFields",(MAX_FIELDS as f64).into()),("maxBytes",(MAX_BYTES as f64).into()),("bitmapData",true.into()),("deepAnchors",true.into())]));
        }
        if operation.eq_with_case(b"bitmapCopy",true) && args.len()==3 { return bitmap_copy(args[1],args[2],activation); }
        if operation.eq_with_case(b"export",true) && args.len()==3 {
            let anchors = Anchors::read(args[2],activation)?;
            let graph = export_graph(args[1],&anchors,activation)?;
            let wire = pack(&graph)?;
            check_time(activation)?;
            return Ok(AvmString::new_utf8(activation.gc(),wire).into());
        }
        if (operation.eq_with_case(b"import",true) && args.len()==3) || (operation.eq_with_case(b"inspect",true) && args.len()==2) {
            let Value::String(wire) = args[1] else { return Err("native graph packet must be a string".into()); };
            let graph = unpack(wire)?;
            check_time(activation)?;
            if operation.eq_with_case(b"inspect",true) {
                return Ok(metadata(activation,&[("version",1.0.into()),("contract",AvmString::new_utf8(activation.gc(),FORMAT).into()),("nodes",(graph.nodes.len() as f64).into()),("fields",(graph.fields as f64).into()),("wireBytes",(wire.len() as f64).into()),("swfVersion",(graph.swf_version as f64).into())]));
            }
            let anchors = Anchors::read(args[2],activation)?;
            return import_graph(&graph,&anchors,activation);
        }
        Err("unsupported native graph operation or argument count".into())
    }
    run(activation,args).map_err(|message| Error::ThrownValue(AvmString::new_utf8(activation.gc(),format!("BoxHead native graph: {message}")).into()))
}

#[cfg(test)]
#[path = "boxhead_native_graph/tests.rs"]
mod tests;
