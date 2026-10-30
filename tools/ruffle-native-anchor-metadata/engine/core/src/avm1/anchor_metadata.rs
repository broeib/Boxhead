//! Optional raw-own metadata for the six original XSI asset roots.
//!
//! This is not an Anchors/world cache. Only explicit loading preparation may
//! admit an entry. Every semantic ObjectData write eagerly removes it. The
//! graph reader still performs fresh names, kinds, clip resolution and limits.

use super::object::ObjectWeak;
use super::property::Attribute;
use super::{Activation, Error, NativeObject, Object, Value};
use crate::string::AvmString;
use fnv::FnvHashSet;
use gc_arena::Collect;
use std::cell::Cell;
use std::collections::VecDeque;
use std::mem::size_of;
use std::rc::Rc;
use web_time::Instant;

// Six MiB of charged positive entries, including entries on inactive objects.
// The bounded weak queue, pointer set and scratch reserve at most another two
// MiB under the conservative work-size check below. This bounds metadata buffer
// requests, not allocator pages/RSS. ObjectData additionally has one optional
// Box pointer per object, including objects never admitted here.
pub(crate) const CACHE_BYTES: usize = 6 * 1024 * 1024;
const WORK_BYTES: usize = 2 * 1024 * 1024;
const MAX_OBJECTS: usize = 32_768;
const MAX_FIELDS_PER_SLICE: usize = 8_192;
const MAX_OBJECTS_PER_SLICE: usize = 512;
const MAX_SLICES: usize = 64;
const ENTRY_ALLOCATION_MARGIN: usize = 128;

#[derive(Default)]
pub(crate) struct MetadataBudget {
    used: Cell<usize>,
}

impl MetadataBudget {
    pub(crate) fn used(&self) -> usize { self.used.get() }

    fn charge(self: &Rc<Self>, bytes: usize) -> Option<MetadataCharge> {
        let next = self.used.get().checked_add(bytes)?;
        if next > CACHE_BYTES { return None; }
        self.used.set(next);
        Some(MetadataCharge { budget: self.clone(), bytes })
    }
}

// Contains no GC pointer and never inspects one during drop. Clearing an entry
// or collecting its owning ObjectData returns its global per-VM allocation
// charge, even if it is not visited by any later checkpoint/preparation call.
struct MetadataCharge { budget: Rc<MetadataBudget>, bytes: usize }
impl Drop for MetadataCharge {
    fn drop(&mut self) { self.budget.used.set(self.budget.used.get() - self.bytes); }
}

#[derive(Collect)]
#[collect(no_drop)]
pub(crate) struct CachedEdges<'gc> {
    pub(crate) raw_count: usize,
    pub(crate) edges: Vec<(AvmString<'gc>, Value<'gc>)>,
    #[collect(require_static)]
    _charge: MetadataCharge,
}

impl<'gc> CachedEdges<'gc> {
    pub(crate) fn new(budget: &Rc<MetadataBudget>, raw_count: usize,
        fields: &[(AvmString<'gc>, Value<'gc>)]) -> Option<Self> {
        if raw_count > MAX_FIELDS_PER_SLICE || fields.len() > raw_count { return None; }
        let bytes = fields.len().checked_mul(size_of::<(AvmString<'gc>, Value<'gc>)>())?
            .checked_add(size_of::<Self>() + ENTRY_ALLOCATION_MARGIN)?;
        let charge = budget.charge(bytes)?;
        let mut edges = Vec::with_capacity(fields.len());
        edges.extend_from_slice(fields);
        Some(Self { raw_count, edges, _charge: charge })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct WarmReport {
    pub(crate) calls: usize,
    pub(crate) objects: usize,
    pub(crate) properties: usize,
    pub(crate) cached: usize,
    pub(crate) skipped: usize,
    pub(crate) bytes: usize,
    pub(crate) work_bytes: usize,
    pub(crate) completed: bool,
    pub(crate) capped: bool,
}

#[derive(Collect, Default)]
#[collect(no_drop)]
pub(crate) struct MetadataState<'gc> {
    #[collect(require_static)]
    pub(crate) budget: Rc<MetadataBudget>,
    roots: Vec<ObjectWeak<'gc>>,
    pending: VecDeque<ObjectWeak<'gc>>,
    #[collect(require_static)]
    seen: FnvHashSet<usize>,
    #[collect(require_static)]
    report: WarmReport,
}

impl<'gc> MetadataState<'gc> {
    fn clear_work(&mut self) {
        // Release work capacity; positive entries remain owned by the actual
        // asset objects and by the global allocation charge, not this queue.
        self.pending = VecDeque::new();
        self.seen = FnvHashSet::default();
    }

    fn work_bytes(&self) -> usize {
        if self.pending.capacity() == 0 && self.seen.capacity() == 0 {
            return self.roots.capacity() * size_of::<ObjectWeak<'gc>>();
        }
        // std HashSet's reported capacity excludes empty/control buckets. Two
        // pointer-plus-control slots per reported capacity conservatively
        // cover the pinned table layout, including its grouped control tail.
        // The whole 8192-row scratch capacity is reserved even between calls.
        self.pending.capacity() * size_of::<ObjectWeak<'gc>>()
            + 2 * (self.seen.capacity() + 16) * (size_of::<usize>() + 1)
            + self.roots.capacity() * size_of::<ObjectWeak<'gc>>()
            + MAX_FIELDS_PER_SLICE * size_of::<(AvmString<'gc>, Value<'gc>)>()
            + size_of::<Self>() + 4 * ENTRY_ALLOCATION_MARGIN
    }

    fn start_work(&mut self) -> bool {
        // Fixed capacities avoid resizing or unbounded queue growth in later
        // loading callbacks. No object is retained strongly by either buffer.
        self.pending = VecDeque::with_capacity(MAX_OBJECTS);
        self.seen = FnvHashSet::with_capacity_and_hasher(MAX_OBJECTS, Default::default());
        if self.work_bytes() > WORK_BYTES {
            self.report.capped = true;
            self.clear_work();
            return false;
        }
        true
    }

    fn schedule(&mut self, object: Object<'gc>) {
        let identity = object.as_ptr() as usize;
        if self.seen.contains(&identity) { return; }
        if self.seen.len() >= MAX_OBJECTS {
            self.report.capped = true;
            return;
        }
        self.seen.insert(identity);
        self.pending.push_back(object.as_weak());
    }

    pub(crate) fn report(&self) -> WarmReport {
        WarmReport { bytes: self.budget.used(), work_bytes: self.work_bytes(), ..self.report }
    }

    /// Called only from the optional pre-ready loading hook. No original
    /// constructor, getter, MovieClip reference or game step is evaluated.
    pub(crate) fn warm(&mut self, activation: &Activation<'_, 'gc>, roots: [Object<'gc>; 6]) -> bool {
        let started = Instant::now();
        if self.report.completed || self.report.capped {
            // Completion is deliberately sticky for this optional loading
            // preparation. Replaced roots/invalidated objects use fresh reads.
            return true;
        }
        if self.report.calls >= MAX_SLICES {
            self.report.capped = true;
            self.clear_work();
            return true;
        }
        let same_roots = self.roots.len() == roots.len() && self.roots.iter().zip(roots)
            .all(|(old, current)| old.upgrade(activation.gc()).is_some_and(|old| Object::ptr_eq(old, current)));
        if !same_roots {
            self.clear_work();
            self.roots = roots.iter().map(|object| object.as_weak()).collect();
            if !self.start_work() { return true; }
            for root in roots { self.schedule(root); }
        }
        self.report.calls += 1;
        let mut fields = Vec::with_capacity(MAX_FIELDS_PER_SLICE);
        let mut objects = 0;
        let mut remaining = MAX_FIELDS_PER_SLICE;
        while objects < MAX_OBJECTS_PER_SLICE && remaining > 0 {
            let Some(weak) = self.pending.pop_front() else { break; };
            let Some(object) = weak.upgrade(activation.gc()) else {
                self.report.skipped += 1;
                objects += 1;
                continue;
            };
            if !matches!(object.boxhead_graph_native(), NativeObject::None | NativeObject::Array(_)) {
                self.report.skipped += 1;
                objects += 1;
                continue;
            }
            match object.boxhead_graph_anchor_edges_warm_into(activation.gc(), &self.budget, remaining, &mut fields) {
                Some((count, admitted)) => {
                    remaining -= count;
                    self.report.properties += count;
                    self.report.objects += 1;
                    if !admitted {
                        // Do not silently report coverage after the global
                        // cache budget denied this otherwise valid object.
                        self.report.capped = true;
                        self.report.skipped += 1;
                        break;
                    }
                    self.report.cached += 1;
                    for (_, child) in fields.drain(..) {
                        // MovieClipReference is deliberately not resolved. Its
                        // raw Value can be cached in its parent but is opaque
                        // to this optional preparation traversal.
                        if let Value::Object(child) = child {
                            if matches!(child.boxhead_graph_native(), NativeObject::None | NativeObject::Array(_)) {
                                self.schedule(child);
                            }
                        }
                    }
                }
                None if remaining < MAX_FIELDS_PER_SLICE => {
                    // Try one full bounded slice before classifying a large or
                    // unsupported object as a preparation-only miss.
                    self.pending.push_front(weak);
                    break;
                }
                None => { self.report.skipped += 1; remaining = 0; }
            }
            objects += 1;
            if self.report.capped || self.budget.used() >= CACHE_BYTES || started.elapsed().as_micros() >= 1_000 { break; }
        }
        if self.pending.is_empty() && !self.report.capped {
            self.report.completed = true;
            self.clear_work();
            return true;
        }
        if self.report.capped || self.report.calls >= MAX_SLICES || self.budget.used() >= CACHE_BYTES {
            self.report.capped = true;
            self.clear_work();
            return true;
        }
        false
    }
}

fn own<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Option<Object<'gc>> {
    let name = AvmString::new_utf8(activation.gc(), name);
    match object.boxhead_anchor_metadata_own(name)? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

fn original_roots<'gc>(activation: &Activation<'_, 'gc>) -> Option<[Object<'gc>; 6]> {
    let thing = own(activation, activation.global_object(), "Thing")?;
    let creature = own(activation, thing, "Creature")?;
    let player = own(activation, creature, "CThing_Creature_Player")?;
    let players = own(activation, player, "mXSI_Collections")?;
    let zombie = own(activation, creature, "CThing_Creature_Zombie")?;
    let devil = own(activation, creature, "CThing_Creature_Devil")?;
    Some([own(activation, players, "0")?, own(activation, players, "1")?,
        own(activation, players, "2")?, own(activation, players, "3")?,
        own(activation, zombie, "mXSI_Collection")?, own(activation, devil, "mXSI_Collection")?])
}

fn status<'gc>(activation: &Activation<'_, 'gc>) -> Value<'gc> {
    let report = activation.context.avm1.anchor_metadata.report();
    let object = Object::new_without_proto(activation.gc());
    let flags = Attribute::READ_ONLY | Attribute::DONT_DELETE;
    for (name, value) in [("version", 1), ("calls", report.calls), ("objects", report.objects),
        ("properties", report.properties), ("cached", report.cached), ("skipped", report.skipped),
        ("bytes", report.bytes), ("workBytes", report.work_bytes)] {
        object.define_value(activation.gc(), AvmString::new_utf8(activation.gc(), name),
            (value as f64).into(), flags);
    }
    for (name, value) in [("completed", report.completed), ("capped", report.capped)] {
        object.define_value(activation.gc(), AvmString::new_utf8(activation.gc(), name), value.into(), flags);
    }
    object.into()
}

pub(crate) fn call<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>])
    -> Result<Value<'gc>, Error<'gc>> {
    let Some(Value::String(operation)) = args.first() else { return Ok(Value::Bool(true)); };
    if args.len() == 1 && operation.eq_with_case(b"status", true) { return Ok(status(activation)); }
    if args.len() != 1 || !operation.eq_with_case(b"prewarm", true)
        || activation.context.external_interface.step_fence.frozen() { return Ok(Value::Bool(true)); }
    let Some(roots) = original_roots(activation) else { return Ok(Value::Bool(true)); };
    // No AVM callback or arena collection can run while this weak work state
    // is moved out. Its duplicate raw references remain in actual properties.
    let mut state = std::mem::take(&mut activation.context.avm1.anchor_metadata);
    let ready = state.warm(activation, roots);
    activation.context.avm1.anchor_metadata = state;
    Ok(Value::Bool(ready))
}

#[cfg(test)]
#[path = "anchor_metadata_tests.rs"]
mod tests;
