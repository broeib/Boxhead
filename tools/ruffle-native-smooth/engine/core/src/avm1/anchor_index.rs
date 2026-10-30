//! Optional, bounded names for the six original XSI asset graphs.
//!
//! Preparation owns only weak object references and copied UTF-16 property names.
//! Every indexed object, including an opaque non-display native leaf, has a
//! shared write witness. Display edges retain only an owner/key replay record;
//! their native target/path state is resolved fresh during each graph read.
//! A semantic owner write or collection invalidates the whole certificate.
//! A checkpoint still validates its complete explicit registry and every live
//! weak reference/native kind before it can use this index. Anything outside
//! this deliberately narrow contract takes the original fresh reader.

use super::super::object::{NativeObject, ObjectWeak};
use super::super::{Object, Value};
use crate::string::AvmString;
use fnv::FnvHashMap;
use gc_arena::{Collect, Gc, Mutation};
use std::cell::Cell;
use std::collections::VecDeque;
use std::hash::Hash;
use std::mem::size_of;
use std::rc::Rc;
use web_time::Instant;

pub(crate) const ROOT_IDS: [&str; 6] = ["asset:player:0", "asset:player:1", "asset:player:2",
    "asset:player:3", "asset:zombie", "asset:devil"];
// The fresh anchor reader permits 250000 names. Its separate 65536 mutable
// graph-node limit does not bound the immutable asset catalog.
pub(crate) const MAX_ENTRIES: usize = 250_000;
const INITIAL_ENTRIES: usize = 65_536;
pub(crate) const MAX_STAGE_EDGES: usize = 8_192;
pub(crate) const MAX_STORAGE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_CALLS: usize = 128;
pub(crate) const SLICE_MICROS: u128 = 4_000;
const MAX_OBJECTS_PER_SLICE: usize = 2_048;
const MAX_FIELDS_PER_SLICE: usize = 32_768;
const MAX_FIELDS_PER_OBJECT: usize = 8_192;
const MAX_TOTAL_FIELDS: usize = 4_000_000;
const MAX_PATH: usize = 2_048;
const HASH_START: u64 = 0xcbf29ce484222325;
const HEX: &[u8; 16] = b"0123456789abcdef";

fn growth_capacity(capacity: usize, required: usize) -> Option<usize> {
    if required > MAX_ENTRIES { return None; }
    Some(capacity.saturating_mul(2).max(required).min(MAX_ENTRIES))
}

fn admit_growth(current: usize, new_buffer: usize, held_key: usize, limit: usize) -> bool {
    current.checked_add(new_buffer).and_then(|bytes| bytes.checked_add(held_key))
        .is_some_and(|bytes| bytes <= limit)
}

fn new_map_bytes<K, V>(capacity: usize) -> Option<usize> {
    capacity.checked_mul(4)?.checked_mul(size_of::<(K, V)>().checked_add(1)?)
}

fn map_bytes<K, V>(capacity: usize) -> Option<usize> {
    capacity.checked_mul(2)?.checked_mul(size_of::<(K, V)>().checked_add(1)?)
}

fn replace_map<K: Copy + Eq + Hash, V: Copy>(map: &mut FnvHashMap<K, V>, target: usize,
    current: usize, held_key: usize, limit: usize) -> Result<(), &'static str> {
    if target <= map.len() || target > MAX_ENTRIES { return Err("entry-limit"); }
    let reserve = new_map_bytes::<K, V>(target).ok_or("storage-limit")?;
    if !admit_growth(current, reserve, held_key, limit) { return Err("storage-limit"); }
    // Reserve an EMPTY table: no hidden doubling of the old table. The same
    // four-slots/request certificate used for v19's initial allocation covers
    // rounded buckets/control bytes. Current already includes the OLD table,
    // so admission covers both allocations until the final swap/drop.
    let mut replacement = FnvHashMap::<K, V>::default();
    replacement.try_reserve(target).map_err(|_| "storage-limit")?;
    if replacement.capacity() < target || map_bytes::<K, V>(replacement.capacity())
        .is_none_or(|bytes| bytes > reserve) { return Err("storage-limit"); }
    // Only scalar map pairs are copied; no owned UTF-16 keys or GC values.
    // target exceeds the old length, so insert cannot trigger another reserve.
    replacement.extend(map.iter().map(|(key, value)| (*key, *value)));
    *map = replacement;
    Ok(())
}

#[cfg(test)]
pub(crate) mod capacity_test_support {
    use super::*;

    pub(crate) fn new_map_bytes(target: usize) -> Option<usize> {
        super::new_map_bytes::<u64, usize>(target)
    }
    pub(crate) fn map_bytes(capacity: usize) -> Option<usize> {
        super::map_bytes::<u64, usize>(capacity)
    }
    pub(crate) fn replace_map(map: &mut FnvHashMap<u64, usize>, target: usize,
        current: usize, held_key: usize, limit: usize) -> Result<(), &'static str> {
        super::replace_map(map, target, current, held_key, limit)
    }
    pub(crate) fn admit_growth(current: usize, new_buffer: usize, held_key: usize, limit: usize) -> bool {
        super::admit_growth(current, new_buffer, held_key, limit)
    }
    pub(crate) fn growth_capacity(capacity: usize, required: usize) -> Option<usize> {
        super::growth_capacity(capacity, required)
    }
}

pub(crate) struct Validity(Cell<bool>);

impl Validity {
    fn new() -> Self { Self(Cell::new(true)) }
    pub(crate) fn valid(&self) -> bool { self.0.get() }
    fn invalidate(&self) { self.0.set(false); }
}

// There is no GC pointer in this witness. ObjectData owns it, so collection as
// well as metadata_write invalidates the certificate without touching the GC.
pub(crate) struct Witness { token: Rc<Validity> }

impl Witness {
    pub(crate) fn new(token: &Rc<Validity>) -> Self { Self { token: token.clone() } }
    pub(crate) fn matches(&self, token: &Rc<Validity>) -> bool { Rc::ptr_eq(&self.token, token) }
}

impl Drop for Witness {
    fn drop(&mut self) { self.token.invalidate(); }
}

#[derive(Collect)]
#[collect(no_drop)]
enum Name {
    Root(u8),
    Child { parent: usize, #[collect(require_static)] key: Vec<u16> },
}

#[derive(Collect)]
#[collect(no_drop)]
pub(crate) struct Entry<'gc> {
    name: Name,
    pub(crate) object: ObjectWeak<'gc>,
    pub(crate) traversable: bool,
    length: usize,
    hash: u64,
    collision: Option<usize>,
}

// Preserve every display edge in sorted BFS encounter order, including aliases.
// The owner is a weak indexed ordinary object; this record owns only UTF-16.
// A MovieClipReference's native weak-target/path state is read from the actual
// owner slot during each graph call, never reconstructed or retained here.
pub(crate) struct StageEdge {
    pub(crate) parent: usize,
    pub(crate) key: Vec<u16>,
    length: usize,
}

#[derive(Collect)]
#[collect(no_drop)]
pub(crate) struct Index<'gc> {
    pub(crate) entries: Vec<Entry<'gc>>,
    #[collect(require_static)]
    pub(crate) stage_edges: Vec<StageEdge>,
    #[collect(require_static)]
    names: FnvHashMap<usize, usize>,
    #[collect(require_static)]
    buckets: FnvHashMap<u64, usize>,
    #[collect(require_static)]
    token: Rc<Validity>,
    pub(crate) raw_fields: usize,
    owned_key_bytes: usize,
    #[cfg(test)]
    bucket_mask: u64,
}

fn hash_byte(hash: u64, byte: u8) -> u64 { (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3) }
fn hash_text(text: &str) -> u64 { text.bytes().fold(HASH_START, hash_byte) }

impl<'gc> Index<'gc> {
    fn new(capacity: usize) -> Self {
        // Initial reserve remains the v19 size. Later admission grows only the
        // exhausted container, with retained + full new allocation charged.
        Self { entries: Vec::with_capacity(capacity),
            stage_edges: Vec::with_capacity(MAX_STAGE_EDGES),
            names: FnvHashMap::with_capacity_and_hasher(capacity, Default::default()),
            buckets: FnvHashMap::with_capacity_and_hasher(capacity, Default::default()),
            token: Rc::new(Validity::new()), raw_fields: 0, owned_key_bytes: 0,
            #[cfg(test)] bucket_mask: u64::MAX }
    }

    pub(crate) fn valid(&self) -> bool { self.token.valid() }

    fn bucket(&self, hash: u64) -> u64 {
        #[cfg(test)]
        { hash & self.bucket_mask }
        #[cfg(not(test))]
        { hash }
    }

    #[cfg(test)]
    fn force_collisions(&mut self) {
        self.bucket_mask = 0;
        self.buckets.clear();
        for (id, entry) in self.entries.iter_mut().enumerate() {
            entry.collision = self.buckets.insert(0, id);
        }
    }

    pub(crate) fn contains(&self, object: Object<'gc>) -> bool {
        self.names.contains_key(&(object.as_ptr() as usize))
    }

    pub(crate) fn root_matches(&self, index: usize, object: Object<'gc>, gc: &Mutation<'gc>) -> bool {
        self.entries.get(index).and_then(|entry| entry.object.upgrade(gc))
            .is_some_and(|expected| Object::ptr_eq(expected, object))
    }

    pub(crate) fn object_id(&self, object: Object<'gc>) -> Option<usize> {
        self.names.get(&(object.as_ptr() as usize)).copied()
    }

    pub(crate) fn find_name(&self, name: &str) -> Option<usize> {
        if name.len() > MAX_PATH { return None; }
        let mut next = self.buckets.get(&self.bucket(hash_text(name))).copied();
        while let Some(id) = next {
            let entry = &self.entries[id];
            if entry.length == name.len() {
                let mut bytes = [0; MAX_PATH];
                self.name_bytes(id, &mut bytes);
                if &bytes[..entry.length] == name.as_bytes() { return Some(id); }
            }
            next = entry.collision;
        }
        None
    }

    fn name_bytes(&self, mut id: usize, bytes: &mut [u8]) {
        let mut end = self.entries[id].length;
        loop {
            match &self.entries[id].name {
                Name::Root(root) => {
                    let root = ROOT_IDS[*root as usize].as_bytes();
                    let start = end - root.len();
                    bytes[start..end].copy_from_slice(root);
                    debug_assert_eq!(start, 0);
                    return;
                }
                Name::Child { parent, key } => {
                    let start = end - key.len() * 4;
                    for (index, unit) in key.iter().enumerate() {
                        for (digit, shift) in [12, 8, 4, 0].into_iter().enumerate() {
                            bytes[start + index * 4 + digit] = HEX[((unit >> shift) & 15) as usize];
                        }
                    }
                    end = start - 1;
                    bytes[end] = b'/';
                    id = *parent;
                }
            }
        }
    }

    pub(crate) fn materialize(&self, id: usize) -> String {
        let mut bytes = vec![0; self.entries[id].length];
        self.name_bytes(id, &mut bytes);
        String::from_utf8(bytes).expect("asset anchor names contain ASCII bytes only")
    }

    pub(crate) fn stage_name(&self, edge: &StageEdge) -> String {
        let mut name = self.materialize(edge.parent);
        name.reserve(edge.length - name.len());
        name.push('/');
        for unit in &edge.key {
            for shift in [12, 8, 4, 0] {
                name.push(HEX[((unit >> shift) & 15) as usize] as char);
            }
        }
        debug_assert_eq!(name.len(), edge.length);
        name
    }

    fn storage_bytes(&self) -> usize {
        // HashMap capacity excludes empty/control buckets. Two complete slots
        // per reported capacity conservatively charge those buckets as well.
        self.entries.capacity() * size_of::<Entry<'gc>>()
            + self.stage_edges.capacity() * size_of::<StageEdge>()
            + self.names.capacity() * 2 * (size_of::<(usize, usize)>() + 1)
            + self.buckets.capacity() * 2 * (size_of::<(u64, usize)>() + 1)
            + self.owned_key_bytes + size_of::<Self>() + 256
    }

    fn add(&mut self, name: Name, object: Object<'gc>, traversable: bool,
        length: usize, hash: u64, gc: &Mutation<'gc>) -> Option<(usize, bool)> {
        if self.entries.len() >= MAX_ENTRIES || length > MAX_PATH { return None; }
        if let Name::Child { key, .. } = &name { self.owned_key_bytes += key.capacity() * size_of::<u16>(); }
        let id = self.entries.len();
        let collision = self.buckets.insert(self.bucket(hash), id);
        self.entries.push(Entry { name, object: object.as_weak(), traversable, length, hash, collision });
        use std::collections::hash_map::Entry as MapEntry;
        let fresh = match self.names.entry(object.as_ptr() as usize) {
            MapEntry::Occupied(_) => false,
            MapEntry::Vacant(entry) => { entry.insert(id); true }
        };
        object.boxhead_anchor_index_witness(gc, &self.token);
        Some((id, fresh))
    }
}

#[derive(Collect)]
#[collect(no_drop)]
struct Work<'gc> {
    index: Index<'gc>,
    #[collect(require_static)]
    pending: VecDeque<usize>,
    #[collect(require_static)]
    storage_limit: usize,
}

impl<'gc> Work<'gc> {
    fn new(gc: &Mutation<'gc>, roots: [Object<'gc>; 6], capacity: usize, storage_limit: usize) -> Option<Self> {
        if !(ROOT_IDS.len()..=MAX_ENTRIES).contains(&capacity) || storage_limit > MAX_STORAGE_BYTES { return None; }
        if roots.into_iter().any(|object| !matches!(object.boxhead_graph_native(), NativeObject::None | NativeObject::Array(_))) {
            return None;
        }
        // Four slots per requested hash capacity conservatively cover both
        // rounding/load factor and controls. This bounds retained/requested
        // buffers, not allocator pages/RSS. Growth has a separate peak guard.
        let bound = capacity * (size_of::<Entry<'gc>>() + size_of::<usize>())
            + MAX_STAGE_EDGES * size_of::<StageEdge>()
            + capacity * 4 * (size_of::<(usize, usize)>() + size_of::<(u64, usize)>() + 2)
            + MAX_FIELDS_PER_OBJECT * 2 * size_of::<(AvmString<'gc>, Value<'gc>)>()
            + size_of::<Self>() + 1024;
        if bound > storage_limit { return None; }
        let mut work = Self { index: Index::new(capacity), pending: VecDeque::with_capacity(capacity), storage_limit };
        if work.storage_bytes(MAX_FIELDS_PER_OBJECT) > storage_limit { return None; }
        for (root, object) in roots.into_iter().enumerate() {
            let (id, fresh) = work.index.add(Name::Root(root as u8), object, true,
                ROOT_IDS[root].len(), hash_text(ROOT_IDS[root]), gc)?;
            if fresh { work.pending.push_back(id); }
        }
        Some(work)
    }

    fn storage_bytes(&self, fields_capacity: usize) -> usize {
        self.index.storage_bytes() + self.pending.capacity() * size_of::<usize>()
            // The stable edge sort can allocate a second temporary buffer.
            + fields_capacity * 2 * size_of::<(AvmString<'gc>, Value<'gc>)>() + size_of::<Self>()
    }

    fn same_roots(&self, roots: [Object<'gc>; 6], gc: &Mutation<'gc>) -> bool {
        roots.into_iter().enumerate().all(|(index, root)| self.index.root_matches(index, root, gc))
    }

    fn reserve_entry(&mut self, traversable: bool, key_bytes: usize) -> Result<(), &'static str> {
        let required = self.index.entries.len().checked_add(1).ok_or("entry-limit")?;
        if required > MAX_ENTRIES { return Err("entry-limit"); }
        // Reserves/copies are bounded operations during loading; the 4ms slice
        // target is still checked between objects, not a hard realtime bound.
        // The new key has not been allocated yet. Its complete future owned
        // allocation participates in EVERY growth check, including old+new.
        if !admit_growth(self.storage_bytes(MAX_FIELDS_PER_OBJECT), 0, key_bytes, self.storage_limit) {
            return Err("storage-limit");
        }
        if required > self.index.entries.capacity() {
            let target = growth_capacity(self.index.entries.capacity(), required).ok_or("entry-limit")?;
            let reserve = target.checked_mul(size_of::<Entry<'gc>>()).ok_or("storage-limit")?;
            if !admit_growth(self.storage_bytes(MAX_FIELDS_PER_OBJECT), reserve, key_bytes, self.storage_limit) {
                return Err("storage-limit");
            }
            self.index.entries.try_reserve_exact(target - self.index.entries.len()).map_err(|_| "storage-limit")?;
            if self.index.entries.capacity() > target { return Err("storage-limit"); }
        }
        if self.index.names.len() == self.index.names.capacity() {
            let target = growth_capacity(self.index.names.capacity(), self.index.names.len() + 1).ok_or("entry-limit")?;
            let current = self.storage_bytes(MAX_FIELDS_PER_OBJECT);
            replace_map(&mut self.index.names, target, current, key_bytes, self.storage_limit)?;
        }
        if self.index.buckets.len() == self.index.buckets.capacity() {
            let target = growth_capacity(self.index.buckets.capacity(), self.index.buckets.len() + 1).ok_or("entry-limit")?;
            let current = self.storage_bytes(MAX_FIELDS_PER_OBJECT);
            replace_map(&mut self.index.buckets, target, current, key_bytes, self.storage_limit)?;
        }
        if traversable && self.pending.len() == self.pending.capacity() {
            let target = growth_capacity(self.pending.capacity(), self.pending.len() + 1).ok_or("entry-limit")?;
            // Request a power of two explicitly; no ring-buffer rounding can
            // create a buffer larger than the pre-admitted request.
            let allocated = target.checked_next_power_of_two().ok_or("storage-limit")?;
            let reserve = allocated.checked_mul(size_of::<usize>()).ok_or("storage-limit")?;
            if !admit_growth(self.storage_bytes(MAX_FIELDS_PER_OBJECT), reserve, key_bytes, self.storage_limit) {
                return Err("storage-limit");
            }
            self.pending.try_reserve_exact(allocated - self.pending.len()).map_err(|_| "storage-limit")?;
            if self.pending.capacity() > allocated { return Err("storage-limit"); }
        }
        Ok(())
    }

    fn step(&mut self, gc: &Mutation<'gc>) -> Result<bool, &'static str> {
        let started = Instant::now();
        let mut fields = Vec::with_capacity(MAX_FIELDS_PER_OBJECT);
        let mut slice_fields = 0;
        for _ in 0..MAX_OBJECTS_PER_SLICE {
            let Some(id) = self.pending.pop_front() else { return Ok(true); };
            let object = self.index.entries[id].object.upgrade(gc).ok_or("collected-owner")?;
            let count = object.boxhead_anchor_index_edges_into(MAX_FIELDS_PER_OBJECT, &mut fields)
                .ok_or("own-property-limit-or-descriptor")?;
            self.index.raw_fields = self.index.raw_fields.checked_add(count).ok_or("total-field-limit")?;
            if self.index.raw_fields > MAX_TOTAL_FIELDS { return Err("total-field-limit"); }
            slice_fields += count;
            fields.sort_by(|a, b| a.0.iter().cmp(b.0.iter()));
            for (key, child) in fields.drain(..) {
                // Path limits apply to aliases as well, exactly as in the
                // fresh graph reader. No unsupported edge is silently pruned.
                let length = key.len().checked_mul(4)
                    .and_then(|n| n.checked_add(self.index.entries[id].length + 1))
                    .ok_or("path-limit")?;
                if length > MAX_PATH { return Err("path-limit"); }
                let stage = matches!(child, Value::MovieClip(_))
                    || matches!(child, Value::Object(object)
                        if matches!(object.boxhead_graph_native(), NativeObject::MovieClip(_)));
                if stage {
                    if self.index.stage_edges.len() >= MAX_STAGE_EDGES { return Err("display-edge-limit"); }
                    let key_bytes = key.len().checked_mul(size_of::<u16>()).ok_or("storage-limit")?;
                    if self.storage_bytes(MAX_FIELDS_PER_OBJECT).checked_add(key_bytes)
                        .is_none_or(|bytes| bytes > self.storage_limit) { return Err("storage-limit"); }
                    let mut units = Vec::with_capacity(key.len()); units.extend(key.iter());
                    self.index.owned_key_bytes += units.capacity() * size_of::<u16>();
                    self.index.stage_edges.push(StageEdge { parent: id, key: units, length });
                    continue;
                }
                let Value::Object(child) = child else { return Err("unsupported-value"); };
                let traversable = match child.boxhead_graph_native() {
                    NativeObject::None | NativeObject::Array(_) => true,
                    NativeObject::MovieClip(_) | NativeObject::Super(_) => return Err("unsupported-native-kind"),
                    _ => false,
                };
                if self.index.contains(child) { continue; }
                let mut hash = hash_byte(self.index.entries[id].hash, b'/');
                for unit in key.iter() {
                    for shift in [12, 8, 4, 0] { hash = hash_byte(hash, HEX[((unit >> shift) & 15) as usize]); }
                }
                let key_bytes = key.len().checked_mul(size_of::<u16>()).ok_or("storage-limit")?;
                self.reserve_entry(traversable, key_bytes)?;
                // Own the exact units, so an invalidated index cannot retain
                // an arbitrarily large backing AVM string through a short key.
                let mut units = Vec::with_capacity(key.len()); units.extend(key.iter());
                let (child_id, _) = self.index.add(Name::Child { parent: id, key: units }, child,
                    traversable, length, hash, gc).ok_or("entry-limit")?;
                if traversable { self.pending.push_back(child_id); }
            }
            if slice_fields >= MAX_FIELDS_PER_SLICE || started.elapsed().as_micros() >= SLICE_MICROS { break; }
        }
        Ok(self.pending.is_empty())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub(crate) calls: usize,
    pub(crate) entries: usize,
    pub(crate) stage_edges: usize,
    pub(crate) fields: usize,
    pub(crate) bytes: usize,
    pub(crate) completed: bool,
    pub(crate) unavailable: bool,
    pub(crate) valid: bool,
    pub(crate) hits: usize,
    pub(crate) fallbacks: usize,
    pub(crate) reason: &'static str,
}

#[derive(Collect, Default)]
#[collect(no_drop)]
pub(crate) struct State<'gc> {
    work: Option<Work<'gc>>,
    ready: Option<Gc<'gc, Index<'gc>>>,
    #[collect(require_static)]
    report: Report,
    #[collect(require_static)]
    hits: Cell<usize>,
    #[collect(require_static)]
    fallbacks: Cell<usize>,
    #[cfg(test)]
    force_collisions: bool,
    #[cfg(test)]
    test_capacity: Option<(usize, usize)>,
}

impl<'gc> State<'gc> {
    #[cfg(test)]
    pub(crate) fn with_capacity_for_test(capacity: usize, storage_limit: usize) -> Self {
        Self { test_capacity: Some((capacity, storage_limit)), ..Self::default() }
    }

    pub(crate) fn current(&self) -> Option<Gc<'gc, Index<'gc>>> {
        self.ready.filter(|index| index.valid())
    }

    pub(crate) fn report(&self) -> Report {
        Report { valid: self.current().is_some(), hits: self.hits.get(),
            fallbacks: self.fallbacks.get(), ..self.report }
    }

    pub(crate) fn record_use(&self, used: bool) {
        let count = if used { &self.hits } else { &self.fallbacks };
        count.set(count.get().saturating_add(1));
    }

    pub(crate) fn retire_invalid(&mut self) {
        if self.ready.is_some_and(|index| !index.valid()) {
            self.ready = None;
            self.report.bytes = 0;
            self.report.unavailable = true;
            self.report.reason = "invalidated";
        }
    }

    #[cfg(test)]
    pub(crate) fn exhaust_calls_for_test(&mut self) { self.report.calls = MAX_CALLS; }

    #[cfg(test)]
    pub(crate) fn force_collisions_for_test(&mut self) { self.force_collisions = true; }

    fn unavailable(&mut self, reason: &'static str) -> bool {
        if let Some(work) = self.work.take() { work.index.token.invalidate(); }
        self.ready = None;
        self.report.unavailable = true;
        self.report.bytes = 0;
        self.report.reason = reason;
        true
    }

    pub(crate) fn warm(&mut self, gc: &Mutation<'gc>, roots: [Object<'gc>; 6]) -> bool {
        if self.report.completed || self.report.unavailable { return true; }
        if self.report.calls >= MAX_CALLS { return self.unavailable("call-limit"); }
        self.report.calls += 1;
        self.report.reason = "loading";
        if self.work.as_ref().is_some_and(|work| !work.index.valid() || !work.same_roots(roots, gc)) {
            // Never concatenate observations made on different graph versions.
            if let Some(work) = self.work.take() { work.index.token.invalidate(); }
        }
        if self.work.is_none() {
            let capacity = INITIAL_ENTRIES;
            let storage_limit = MAX_STORAGE_BYTES;
            #[cfg(test)]
            let (capacity, storage_limit) = self.test_capacity.unwrap_or((capacity, storage_limit));
            self.work = Work::new(gc, roots, capacity, storage_limit);
            if self.work.is_none() { return self.unavailable("root-kind-or-storage-limit"); }
            #[cfg(test)]
            if self.force_collisions { self.work.as_mut().unwrap().index.force_collisions(); }
        }
        let work = self.work.as_mut().unwrap();
        let progress = work.step(gc);
        self.report.entries = work.index.entries.len();
        self.report.stage_edges = work.index.stage_edges.len();
        self.report.fields = work.index.raw_fields;
        self.report.bytes = work.storage_bytes(0);
        let valid = work.index.valid();
        match progress {
            Ok(true) if valid => {
                let work = self.work.take().unwrap();
                self.report.bytes = work.index.storage_bytes();
                self.ready = Some(Gc::new(gc, work.index));
                self.report.completed = true;
                self.report.reason = "ready";
                true
            }
            Ok(false) if valid && self.report.calls < MAX_CALLS => false,
            Err(reason) => self.unavailable(reason),
            _ => self.unavailable(if valid { "call-limit" } else { "invalidated" }),
        }
    }
}
