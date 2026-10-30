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
use fnv::FnvHashMap;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::rc::Rc;

const FORMAT: &str = "bh-avm1-graph-v1";
const PREFIX: &str = "BHG1:";
// All 18 saved original map grids were reviewed. The largest is 87x87;
// CMap rounds mArea/32, so three RGBA surfaces can occupy nearly 94,080,000
// bytes before cell objects and caches. Keep the decoded graph finite at
// 128 MiB; native ASCII and application 16 MiB / 4 MiB caps stay unchanged.
const MAX_BYTES: usize = 128 * 1024 * 1024;
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

fn deep_field_total(previous: usize, raw_fields: usize) -> ResultG<usize> {
    let total = previous.checked_add(raw_fields).ok_or("deep anchor field limit exceeded")?;
    if total > MAX_FIELDS * 4 { return Err("deep anchor field limit exceeded".into()); }
    Ok(total)
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct AnchorNameId(u32);

enum AnchorName<'gc> {
    Explicit(Rc<str>),
    // AVM strings are immutable. Retain the original UTF-16 key without
    // allocating its hexadecimal suffix or copying its parent's full path.
    Child { parent: AnchorNameId, key: AvmString<'gc> },
}

struct NamedAnchor<'gc> {
    name: AnchorName<'gc>,
    length: usize,
    // The raw FNV state excludes Hash::hash's string terminator, so a child
    // extends exactly the parent's bytes with '/' and four hex digits/unit.
    hash: u64,
    collision: Option<AnchorNameId>,
    value: Value<'gc>,
}

const ANCHOR_NAME_HASH_START: u64 = 0xcbf29ce484222325;
const ANCHOR_NAME_HEX: &[u8; 16] = b"0123456789abcdef";

fn anchor_name_hash_byte(hash: u64, byte: u8) -> u64 {
    (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
}

fn anchor_name_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(ANCHOR_NAME_HASH_START, |hash, byte| anchor_name_hash_byte(hash, *byte))
}

struct Anchors<'gc> {
    // None of these maps is enumerated to determine wire order or names.
    // The explicit input order and sorted-edge BFS remain authoritative.
    // Each distinct textual name has one arena entry for this call only.
    // Hash collisions link through that arena and always compare exact bytes.
    values: Vec<NamedAnchor<'gc>>,
    name_buckets: FnvHashMap<u64, AnchorNameId>,
    names: FnvHashMap<Identity, AnchorNameId>,
    // AVM1 stores both direct StageObject values and path-based MovieClip
    // values. They can denote the same native clip without being the same
    // Value kind. Preserve that kind in the wire and at the receiving VM.
    stage_variants: FnvHashMap<(AnchorNameId, u8), Value<'gc>>,
    // Force collisions in differential tests without replacing comparison,
    // traversal, insertion, packet encoding or resolution implementations.
    #[cfg(test)]
    name_bucket_mask: u64,
}

impl<'gc> Anchors<'gc> {
    fn empty() -> Self {
        Self { values: Vec::new(), name_buckets: FnvHashMap::default(), names: FnvHashMap::default(),
            stage_variants: FnvHashMap::default(), #[cfg(test)] name_bucket_mask: u64::MAX }
    }

    fn bucket(&self, hash: u64) -> u64 {
        #[cfg(test)]
        { hash & self.name_bucket_mask }
        #[cfg(not(test))]
        { hash }
    }

    fn name_metrics(&self, name: &AnchorName<'gc>) -> (usize, u64) {
        match name {
            AnchorName::Explicit(text) => (text.len(), anchor_name_hash(text.as_bytes())),
            AnchorName::Child { parent, key } => {
                let parent = &self.values[parent.0 as usize];
                let mut hash = anchor_name_hash_byte(parent.hash, b'/');
                for unit in key.iter() {
                    for shift in [12, 8, 4, 0] {
                        hash = anchor_name_hash_byte(hash, ANCHOR_NAME_HEX[((unit >> shift) & 15) as usize]);
                    }
                }
                (parent.length + 1 + key.len() * 4, hash)
            }
        }
    }

    // Iterative, bounded expansion: even a path of empty keys cannot recurse
    // on the Rust stack. Only emitted atoms/errors allocate a String.
    fn name_bytes<'a>(&'a self, mut name: &'a AnchorName<'gc>, length: usize, bytes: &mut [u8]) {
        let mut end = length;
        loop {
            match name {
                AnchorName::Explicit(text) => {
                    let start = end - text.len();
                    bytes[start..end].copy_from_slice(text.as_bytes());
                    debug_assert_eq!(start, 0);
                    return;
                }
                AnchorName::Child { parent, key } => {
                    let start = end - key.len() * 4;
                    for (index, unit) in key.iter().enumerate() {
                        for (digit, shift) in [12, 8, 4, 0].into_iter().enumerate() {
                            bytes[start + index * 4 + digit] = ANCHOR_NAME_HEX[((unit >> shift) & 15) as usize];
                        }
                    }
                    end = start - 1;
                    bytes[end] = b'/';
                    name = &self.values[parent.0 as usize].name;
                }
            }
        }
    }

    fn materialize(&self, id: AnchorNameId) -> String {
        let entry = &self.values[id.0 as usize];
        let mut bytes = vec![0; entry.length];
        self.name_bytes(&entry.name, entry.length, &mut bytes);
        String::from_utf8(bytes).expect("anchor names contain ASCII bytes only")
    }

    fn same_name(&self, left: &AnchorName<'gc>, right: &AnchorName<'gc>, length: usize) -> bool {
        match (left, right) {
            (AnchorName::Explicit(left), AnchorName::Explicit(right)) => return left == right,
            (AnchorName::Child { parent: left_parent, key: left_key },
             AnchorName::Child { parent: right_parent, key: right_key })
                if left_parent == right_parent && left_key == right_key => return true,
            _ => {},
        }
        // Explicit IDs may themselves contain '/0061'. Structural equality
        // alone would miss those exact explicit/generated name collisions.
        let mut left_bytes = [0; 2048];
        let mut right_bytes = [0; 2048];
        self.name_bytes(left, length, &mut left_bytes);
        self.name_bytes(right, length, &mut right_bytes);
        left_bytes[..length] == right_bytes[..length]
    }

    fn find_name(&self, text: &str) -> Option<AnchorNameId> {
        if text.len() > 2048 { return None; }
        let mut next = self.name_buckets.get(&self.bucket(anchor_name_hash(text.as_bytes()))).copied();
        while let Some(id) = next {
            let entry = &self.values[id.0 as usize];
            if entry.length == text.len() {
                let same = match &entry.name {
                    AnchorName::Explicit(value) => value.as_ref() == text,
                    _ => {
                        let mut bytes = [0; 2048];
                        self.name_bytes(&entry.name, entry.length, &mut bytes);
                        &bytes[..entry.length] == text.as_bytes()
                    }
                };
                if same { return Some(id); }
            }
            next = entry.collision;
        }
        None
    }

    #[cfg(test)]
    fn insert(&mut self, name: AnchorName<'gc>, value: Value<'gc>) -> ResultG<(AnchorNameId, bool)> {
        use std::collections::hash_map::Entry;
        let key = identity(value).ok_or("anchor has a primitive value")?;
        let kind = anchor_kind(value)?;
        let (id, added) = self.insert_name(name, value, &key, kind)?;
        if !added { return Ok((id, false)); }
        let new_identity = match self.names.entry(key) {
            Entry::Occupied(_) => false,
            Entry::Vacant(entry) => { entry.insert(id); true }
        };
        Ok((id, new_identity))
    }

    // Identity selection is separate so the fresh reader can retain one
    // identity-map Entry across this name-table operation. The collision,
    // kind and capacity rules are exactly the original insertion order.
    fn insert_name(&mut self, name: AnchorName<'gc>, value: Value<'gc>,
        key: &Identity, kind: u8) -> ResultG<(AnchorNameId, bool)> {
        let (length, hash) = self.name_metrics(&name);
        debug_assert!(length <= 2048);
        let bucket = self.bucket(hash);
        let head = self.name_buckets.get(&bucket).copied();
        let mut next = head;
        while let Some(id) = next {
            let entry = &self.values[id.0 as usize];
            if entry.length == length && self.same_name(&entry.name, &name, length) {
                let previous = entry.value;
                if identity(previous).as_ref() != Some(key) || anchor_kind(previous)? != kind {
                    return Err(format!("anchor ID points to different objects: {}", self.materialize(id)));
                }
                return Ok((id, false));
            }
            next = entry.collision;
        }
        // A repeated valid name still succeeds at capacity, and a conflicting
        // repeated name still reports its identity error before this bound.
        if self.values.len() >= MAX_ANCHORS { return Err("anchor count limit exceeded".into()); }
        let id = AnchorNameId(self.values.len() as u32);
        self.values.push(NamedAnchor { name, length, hash, collision: head, value });
        self.name_buckets.insert(bucket, id);
        Ok((id, true))
    }

    fn insert_stage_variants(&mut self, id: AnchorNameId, value: Value<'gc>, kind: u8,
        names: &mut FnvHashMap<Identity, AnchorNameId>, activation: &mut Activation<'_, 'gc>) -> ResultG<()> {
        use std::collections::hash_map::Entry;
        let (object, reference) = match value {
            Value::MovieClip(reference) => {
                let object = reference.coerce_to_object(activation)
                    .ok_or_else(|| format!("unresolved MovieClip anchor: {}", self.materialize(id)))?;
                if !matches!(object.boxhead_graph_native(), NativeObject::MovieClip(_)) {
                    return Err(format!("MovieClip anchor resolved to another native kind: {}", self.materialize(id)));
                }
                (object, reference)
            }
            Value::Object(object) if kind == 3 => {
                let reference = MovieClipReference::try_from_stage_object(activation, object)
                    .ok_or_else(|| format!("native MovieClip anchor has no stage reference: {}", self.materialize(id)))?;
                (object, reference)
            }
            _ => return Ok(()),
        };
        // Native display-tree resolution does not read AS2 properties, invoke
        // user getters or run game code. No arbitrary same-path object match
        // is accepted: the direct object comes from this actual reference.
        for (kind, variant) in [(3, Value::Object(object)), (64, Value::MovieClip(reference))] {
            let key = identity(variant).ok_or("invalid MovieClip anchor identity")?;
            match names.entry(key) {
                Entry::Occupied(entry) => {
                    if let Some(Value::Object(previous_object)) = self.stage_variants.get(&(*entry.get(),3)) {
                        if !Object::ptr_eq(*previous_object,object) {
                            return Err(format!("ambiguous MovieClip anchor path: {}", self.materialize(id)));
                        }
                    }
                }
                Entry::Vacant(entry) => { entry.insert(id); }
            }
            self.stage_variants.insert((id,kind),variant);
        }
        Ok(())
    }

    fn queue_deep(prefix: AnchorNameId, canonical: AnchorNameId, value: Value<'gc>, kind: u8,
        pending: &mut VecDeque<(AnchorNameId, Object<'gc>)>, scheduled: &mut Vec<u64>) {
        if kind != 0 && kind != 1 { return; }
        let Value::Object(object) = value else { return; };
        // Canonical binding identifies the object, but the first scheduled
        // deep alias supplies the expansion prefix. MovieClip variants cannot
        // reach this ordinary/Array-only branch. One bit replaces a second
        // pointer hash-table lookup; no state survives this read call.
        let word = canonical.0 as usize / 64;
        let bit = 1_u64 << (canonical.0 % 64);
        if word >= scheduled.len() { scheduled.resize(word + 1, 0); }
        if scheduled[word] & bit == 0 {
            scheduled[word] |= bit;
            pending.push_back((prefix, object));
        }
    }

    fn read(value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Self> {
        Self::read_into(value, activation, Self::empty())
    }

    fn read_into(value: Value<'gc>, activation: &mut Activation<'_, 'gc>, mut result: Self) -> ResultG<Self> {
        use std::collections::hash_map::Entry;
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
        let mut deep = VecDeque::new();
        let mut scheduled = Vec::new();
        // No AVM code runs inside this reader. Keeping the identity map local
        // lets a single Entry probe coexist with name-table construction.
        // Restore it before the completed Anchors object can be observed.
        let mut names = std::mem::take(&mut result.names);
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
            let id: Rc<str> = Rc::from(ascii_id(id)?);
            let value = raw(row, "value", activation).ok_or("anchor row lacks value")?;
            let deep_flag = match raw(row, "deep", activation) {
                None | Some(Value::Bool(false)) => false,
                Some(Value::Bool(true)) => true,
                _ => return Err("anchor deep flag must be boolean".into()),
            };
            let key = identity(value).ok_or("anchor has a primitive value")?;
            let kind = anchor_kind(value)?;
            let (id, _) = result.insert_name(AnchorName::Explicit(id), value, &key, kind)?;
            let canonical = *names.entry(key).or_insert(id);
            result.insert_stage_variants(id, value, kind, &mut names, activation)?;
            if deep_flag { Self::queue_deep(id, canonical, value, kind, &mut deep, &mut scheduled); }
        }
        // Explicit names always win over generated immutable-asset paths.
        // Anchor expansion never calls AVM code. Native kinds, descriptors
        // and edges therefore cannot mutate between scheduling and reading.
        // Deduplicate at first scheduling, keeping the original BFS winner.
        let mut walked_fields = 0usize;
        let mut fields = Vec::new();
        while let Some((id, object)) = deep.pop_front() {
            check_time(activation)?;
            let raw_fields = object.boxhead_graph_anchor_edges_into(&mut fields)
                .map_err(|e| format!("deep anchor {}: {e}", result.materialize(id)))?;
            // The raw reader validates every descriptor and counts primitive
            // payload too; only non-prototype object edges allocate entries.
            walked_fields = deep_field_total(walked_fields, raw_fields)?;
            fields.sort_by(|a, b| a.0.iter().cmp(b.0.iter()));
            for (edge_index, (key, child)) in fields.drain(..).enumerate() {
                // Pruned opaque/alias queue entries used to provide later
                // timeout checks. Keep bounded edge progress and a final
                // check even when no traversable children remain.
                if edge_index % 128 == 0 { check_time(activation)?; }
                // Preserve the previous path bound even for aliases whose
                // generated path is not used. Newly discovered identities
                // retain only a parent/key name; no full path is allocated.
                let child_len = key.len().checked_mul(4).and_then(|n| n.checked_add(result.values[id.0 as usize].length + 1))
                    .ok_or("deep anchor path limit exceeded")?;
                if child_len > 2048 { return Err("deep anchor path limit exceeded".into()); }
                let identity = identity(child).unwrap();
                let kind = anchor_kind(child)?;
                // Do not create alias paths recursively; retain one canonical name.
                let (child_id, fresh) = match names.entry(identity) {
                    Entry::Occupied(entry) => (*entry.get(), false),
                    Entry::Vacant(entry) => {
                        let (child_id, _) = result.insert_name(AnchorName::Child { parent: id, key }, child, entry.key(), kind)?;
                        entry.insert(child_id);
                        (child_id, true)
                    }
                };
                if fresh { result.insert_stage_variants(child_id, child, kind, &mut names, activation)?; }
                Self::queue_deep(child_id, child_id, child, kind, &mut deep, &mut scheduled);
            }
        }
        check_time(activation)?;
        result.names = names;
        Ok(result)
    }

    fn atom(&self, value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Option<Atom>> {
        let Some(key) = identity(value) else { return Ok(None); };
        let Some(id) = self.names.get(&key) else { return Ok(None); };
        if let Value::MovieClip(reference) = value {
            let object = reference.coerce_to_object(activation)
                .ok_or_else(|| format!("checkpoint MovieClip anchor no longer resolves: {}", self.materialize(*id)))?;
            let Some(Value::Object(expected)) = self.stage_variants.get(&(*id,3)) else {
                return Err(format!("checkpoint MovieClip anchor lacks its native object: {}", self.materialize(*id)));
            };
            if !Object::ptr_eq(object,*expected) {
                return Err(format!("checkpoint MovieClip anchor identity differs: {}", self.materialize(*id)));
            }
        }
        Ok(Some(Atom::Anchor(self.materialize(*id),anchor_kind(value)?)))
    }

    fn resolve(&self, name: &str, kind: u8) -> ResultG<Value<'gc>> {
        let id = self.find_name(name).ok_or_else(|| format!("missing checkpoint anchor: {name}"))?;
        let value = self.values[id.0 as usize].value;
        if anchor_kind(value)? == kind { return Ok(value); }
        self.stage_variants.get(&(id,kind)).copied()
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
            w.0.extend_from_slice(bitmap.rgba.as_flattened());
        }
        w.u32(node.fields.len() as u32);
        for field in &node.fields { w.string(&field.name)?; w.u16(field.flags); w.atom(&field.value)?; }
        w.check()?;
    }
    let mut compressor = ZlibEncoder::new(Vec::new(), Compression::fast());
    compressor.write_all(&w.0).map_err(|e| format!("graph compression failed: {e}"))?;
    let packed = compressor.finish().map_err(|e| format!("graph compression failed: {e}"))?;
    // The compressed encoder no longer borrows the decoded writer. Release
    // it before producing hex, and reject oversized wire before allocating it.
    drop(w);
    let wire_len = packed.len().checked_mul(2).and_then(|n| n.checked_add(PREFIX.len()))
        .ok_or("graph wire limit exceeded")?;
    if wire_len > MAX_WIRE { return Err("graph wire limit exceeded".into()); }
    let mut out = String::with_capacity(wire_len); out.push_str(PREFIX);
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

// FROZEN_V13_ANCHOR_INLINE_ORACLE_ADAPTER_START
pub(super) fn kind(value: Value<'_>) -> ResultG<u8> { anchor_kind(value) }
pub(super) fn time(activation: &Activation<'_, '_>) -> ResultG<()> { check_time(activation) }

pub(super) struct Table<'gc>(Anchors<'gc>);
impl<'gc> Table<'gc> {
    pub(super) fn new(collisions: bool) -> Self {
        let mut value = Anchors::empty();
        if collisions { value.name_bucket_mask = 0; }
        Self(value)
    }
    pub(super) fn insert(&mut self, text: &str, value: Value<'gc>) -> ResultG<(String, bool)> {
        self.0.insert(AnchorName::Explicit(Rc::from(text)), value)
            .map(|(id, fresh)| (self.0.materialize(id), fresh))
    }
    pub(super) fn len(&self) -> usize { self.0.values.len() }
    pub(super) fn bucket_count(&self) -> usize { self.0.name_buckets.len() }
    pub(super) fn bucket_capacity(&self) -> usize { self.0.name_buckets.capacity() }
}

pub(super) fn packet<'gc>(root: Value<'gc>, registry: Value<'gc>, activation: &mut Activation<'_, 'gc>,
    collisions: bool) -> ResultG<String> {
    let mut table = Anchors::empty();
    if collisions { table.name_bucket_mask = 0; }
    let table = Anchors::read_into(registry, activation, table)?;
    pack(&export_graph(root, &table, activation)?)
}

pub(super) fn roundtrip<'gc>(packet: AvmString<'gc>, registry: Value<'gc>, activation: &mut Activation<'_, 'gc>)
    -> ResultG<(Value<'gc>, String)> {
    let graph = unpack(packet)?;
    let table = Anchors::read(registry, activation)?;
    let value = import_graph(&graph, &table, activation)?;
    let encoded = pack(&export_graph(value, &table, activation)?)?;
    Ok((value, encoded))
}

pub(super) fn read_error<'gc>(registry: Value<'gc>, activation: &mut Activation<'_, 'gc>, collisions: bool)
    -> Option<String> {
    let mut table = Anchors::empty();
    if collisions { table.name_bucket_mask = 0; }
    Anchors::read_into(registry, activation, table).err()
}
