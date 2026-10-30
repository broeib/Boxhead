//! Optional loading preparation, global admission bounds and actual weak GC.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::object_reference::MovieClipReference;
use crate::avm1::test_utils::with_avm;
use crate::string::WStr;
use gc_arena::{Arena, Rootable};

fn key<'gc>(a: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> { AvmString::new_utf8(a.gc(), value) }
fn bare<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> { Object::new_without_proto(a.gc()) }
fn put<'gc>(a: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(a.gc(), key(a, name), value, Attribute::empty());
}
fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&a.context.strings, None, None)
}
fn forbidden<'gc>(_: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    panic!("loading preparation invoked original/native code");
}

fn namespace<'gc>(a: &Activation<'_, 'gc>, roots: [Object<'gc>; 6]) -> Object<'gc> {
    let thing = bare(a); let creature = bare(a);
    let player = function(a, forbidden); let players = bare(a);
    let zombie = function(a, forbidden); let devil = function(a, forbidden);
    put(a, a.global_object(), "Thing", thing.into()); put(a, thing, "Creature", creature.into());
    put(a, creature, "CThing_Creature_Player", player.into());
    put(a, creature, "CThing_Creature_Zombie", zombie.into());
    put(a, creature, "CThing_Creature_Devil", devil.into());
    put(a, player, "mXSI_Collections", players.into());
    for (index, root) in roots[..4].iter().enumerate() { put(a, players, &index.to_string(), (*root).into()); }
    put(a, zombie, "mXSI_Collection", roots[4].into());
    put(a, devil, "mXSI_Collection", roots[5].into());
    thing
}

#[test]
fn anchor_metadata_loading_uses_exact_six_raw_roots_and_deduplicates_cycles() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let shared = bare(a); let ignored_proto = bare(a);
        for root in roots {
            put(a, root, "shared", shared.into()); put(a, root, "scalar", 9.0.into());
            put(a, root, "__proto__", ignored_proto.into());
        }
        put(a, shared, "cycle", roots[0].into());
        namespace(a, roots);
        assert!(original_roots(a).unwrap().into_iter().zip(roots).all(|(left, right)| Object::ptr_eq(left, right)));
        let global = a.global_object(); let operation = key(a, "prewarm");
        for _ in 0..MAX_SLICES {
            if call(a, global, &[operation.into()])? == Value::Bool(true) { break; }
        }
        let state = &a.context.avm1.anchor_metadata;
        let report = state.report();
        assert!(report.completed && !report.capped);
        assert_eq!(report.objects, 7); assert_eq!(report.cached, 7);
        assert_eq!(report.properties, 19); assert_eq!(report.skipped, 0);
        assert!(report.calls >= 1 && report.calls <= MAX_SLICES);
        assert!(report.bytes > 0 && report.bytes <= CACHE_BYTES && report.work_bytes <= WORK_BYTES);
        let before = report;
        assert_eq!(call(a, global, &[operation.into()])?, Value::Bool(true));
        assert_eq!(a.context.avm1.anchor_metadata.report(), before, "no repeated preparation after readiness");
        Ok(())
    });
}

#[test]
fn anchor_metadata_loading_rejects_virtual_or_inherited_namespace_without_coercion() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let thing = namespace(a, roots); let global = a.global_object();
        let original = global.get_data(key(a, "Thing"), a).unwrap();
        assert!(global.delete(a, key(a, "Thing")));
        let proto = bare(a); put(a, proto, "Thing", original); put(a, global, "__proto__", proto.into());
        assert!(original_roots(a).is_none());
        global.add_property(a.gc(), key(a, "Thing"), function(a, forbidden), None, Attribute::empty());
        assert!(original_roots(a).is_none());
        assert_eq!(call(a, global, &[key(a, "prewarm").into()])?, Value::Bool(true));
        put(a, global, "Thing", thing.into());
        thing.watch(a, key(a, "Creature"), function(a, forbidden), Value::Undefined);
        assert!(original_roots(a).is_none());
        let argument = bare(a);
        argument.add_property(a.gc(), key(a, "toString"), function(a, forbidden), None, Attribute::empty());
        assert_eq!(call(a, global, &[argument.into()])?, Value::Bool(true));
        assert_eq!(a.context.avm1.anchor_metadata.report().calls, 0);
        assert_eq!(a.context.avm1.anchor_metadata.budget.used(), 0);
        Ok(())
    });
}

#[test]
fn anchor_metadata_loading_keeps_movieclip_references_opaque_until_original_resolution() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let reference = MovieClipReference::from_path(a.gc(), WStr::from_units(b"_level91"));
        put(a, roots[0], "clip", Value::MovieClip(reference));
        assert!(a.get_level(91).is_none());
        let mut state = MetadataState::default();
        for _ in 0..MAX_SLICES { if state.warm(a, roots) { break; } }
        assert!(state.report().completed && !state.report().capped);
        assert_eq!(state.report().cached, 6);
        assert!(a.get_level(91).is_none(), "prewarm must not create or resolve a level");
        let mut edges = Vec::new();
        assert_eq!(roots[0].boxhead_graph_anchor_edges_cached_into(&mut edges), Ok(1));
        let Value::MovieClip(raw) = edges[0].1 else { panic!("raw reference retained"); };
        assert_eq!(raw.path(), reference.path());
        assert!(raw.coerce_to_object(a).is_some(), "ordinary later resolution remains live");
        assert!(a.get_level(91).is_some());
        Ok(())
    });
}

#[test]
fn anchor_metadata_loading_caps_call_object_and_property_work_without_weakening_fresh_reads() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let retained: Vec<_> = (0..600).map(|_| bare(a)).collect();
        let mut state = MetadataState::default();
        state.roots = roots.iter().map(|root| root.as_weak()).collect();
        assert!(state.start_work());
        for object in &retained { state.schedule(*object); }
        state.report.calls = MAX_SLICES - 1;
        assert!(state.warm(a, roots));
        let report = state.report();
        assert_eq!(report.calls, MAX_SLICES);
        assert!(report.capped && !report.completed);
        assert!(report.objects > 0 && report.objects <= MAX_OBJECTS_PER_SLICE);
        assert!(state.pending.is_empty() && state.seen.is_empty());
        let before = report;
        assert!(state.warm(a, roots)); assert_eq!(state.report(), before);
        let large = roots[0];
        for index in 0..MAX_FIELDS_PER_SLICE + 1 { put(a, large, &format!("p{index}"), 1.0.into()); }
        let mut other = MetadataState::default();
        for _ in 0..MAX_SLICES { if other.warm(a, roots) { break; } }
        assert!(other.report().completed && other.report().skipped >= 1);
        assert!(other.report().properties <= MAX_FIELDS_PER_SLICE * MAX_SLICES);
        assert_eq!(large.boxhead_graph_anchor_edges_cached_into(&mut Vec::new()), Ok(MAX_FIELDS_PER_SLICE + 1));
        Ok(())
    });
}

#[test]
fn anchor_metadata_global_budget_covers_inactive_entries_and_reports_denied_admission() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let fields = vec![(key(a, "edge"), bare(a).into()); MAX_FIELDS_PER_SLICE];
        let mut held = Vec::new();
        while let Some(entry) = CachedEdges::new(&budget, fields.len(), &fields) {
            held.push(entry); assert!(held.len() < 1000);
        }
        assert!(!held.is_empty() && budget.used() <= CACHE_BYTES);
        let before = budget.used();
        assert!(CachedEdges::new(&budget, fields.len(), &fields).is_none());
        assert_eq!(budget.used(), before);
        held.pop(); assert!(budget.used() < before);
        assert!(CachedEdges::new(&budget, fields.len(), &fields).is_some());
        drop(held); assert_eq!(budget.used(), 0);
        let reserved = budget.charge(CACHE_BYTES).unwrap();
        let roots = std::array::from_fn(|_| bare(a));
        let mut state = MetadataState { budget: budget.clone(), ..MetadataState::default() };
        assert!(state.warm(a, roots));
        let report = state.report();
        assert!(report.capped && !report.completed);
        assert_eq!(report.cached, 0); assert_eq!(report.skipped, 1);
        assert_eq!(report.bytes, CACHE_BYTES);
        drop(reserved); assert_eq!(budget.used(), 0);
        Ok(())
    });
}

#[test]
fn anchor_metadata_status_is_bounded_plain_snapshot_without_vm_traversal_or_work() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a)); namespace(a, roots);
        let global = a.global_object();
        for _ in 0..MAX_SLICES {
            if call(a, global, &[key(a, "prewarm").into()])? == Value::Bool(true) { break; }
        }
        let before = a.context.avm1.anchor_metadata.report();
        // Deliberately make the original namespace unreadable afterwards.
        global.add_property(a.gc(), key(a, "Thing"), function(a, forbidden), None, Attribute::empty());
        let Value::Object(status) = call(a, global, &[key(a, "status").into()])? else { panic!("plain status"); };
        let fields = status.boxhead_graph_properties().unwrap();
        assert_eq!(fields.len(), 11);
        assert!(!status.has_own_property(a, key(a, "__proto__")));
        let original_fields: Vec<_> = fields.into_iter()
            .filter(|(name, _, _)| !name.eq_with_case(b"assetIndex", true)).collect();
        assert_eq!(original_fields.len(), 10, "all ten original snapshot fields remain");
        for (_, value, flags) in original_fields {
            assert!(matches!(value, Value::Number(_) | Value::Bool(_)));
            assert!(flags.contains(Attribute::READ_ONLY | Attribute::DONT_DELETE));
        }
        let Some(Value::Object(index)) = status.get_data(key(a, "assetIndex"), a) else { panic!("versioned index snapshot"); };
        let fields = index.boxhead_graph_properties().unwrap();
        assert_eq!(fields.len(), 5);
        for (_, value, flags) in fields {
            assert!(matches!(value, Value::Number(_) | Value::Bool(_) | Value::String(_)));
            assert!(flags.contains(Attribute::READ_ONLY | Attribute::DONT_DELETE));
        }
        assert_eq!(index.get_data(key(a, "version"), a), Some(1.0.into()));
        assert_eq!(index.get_data(key(a, "ready"), a), Some(true.into()));
        assert_eq!(index.get_data(key(a, "entries"), a), Some(6.0.into()));
        assert_eq!(index.get_data(key(a, "displayEdges"), a), Some(0.0.into()));
        assert_eq!(index.get_data(key(a, "reason"), a), Some(key(a, "ready").into()));
        assert_eq!(status.get_data(key(a, "completed"), a), Some(Value::Bool(true)));
        assert_eq!(status.get_data(key(a, "calls"), a), Some((before.calls as f64).into()));
        assert_eq!(a.context.avm1.anchor_metadata.report(), before);
        Ok(())
    });
}

#[derive(Collect)]
#[collect(no_drop)]
struct WeakPreparation<'gc> {
    state: MetadataState<'gc>,
    witness: ObjectWeak<'gc>,
}

#[test]
fn anchor_metadata_weak_loading_queue_cannot_keep_removed_asset_roots_alive() {
    let budget = Rc::new(MetadataBudget::default());
    let mut arena = Arena::<Rootable![WeakPreparation<'_>]>::new(|mc| {
        let object = Object::new_without_proto(mc);
        assert_eq!(object.boxhead_graph_anchor_edges_warm_into(mc, &budget, 8192, &mut Vec::new()), Some((0, true)));
        let mut state = MetadataState { budget: budget.clone(), ..MetadataState::default() };
        state.roots.push(object.as_weak());
        assert!(state.start_work()); state.schedule(object);
        WeakPreparation { state, witness: object.as_weak() }
    });
    assert!(budget.used() > 0);
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|mc, root| {
        assert!(root.witness.upgrade(mc).is_none());
        assert!(root.state.pending[0].upgrade(mc).is_none());
        assert!(root.state.roots[0].upgrade(mc).is_none());
        assert!(root.state.report().work_bytes <= WORK_BYTES);
    });
    assert_eq!(budget.used(), 0, "weak work state does not retain an entry's owning object");
}
