//! Mutations of actual ObjectData, not a model of property invalidation.

use super::*;
use crate::avm1::function::NativeFunction;
use crate::avm1::object_reference::MovieClipReference;
use crate::avm1::test_utils::with_avm;
use crate::string::WStr;
use gc_arena::{arena::CollectionPhase, Arena};

fn key<'gc>(a: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(a.gc(), text)
}

fn put<'gc>(a: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(a.gc(), key(a, name), value, Attribute::empty());
}

fn bare<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> { Object::new_without_proto(a.gc()) }

fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&a.context.strings, None, None)
}

fn forbidden<'gc>(_: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    panic!("raw anchor metadata invoked an ActionScript getter/watcher");
}

fn cached(object: Object<'_>) -> bool { object.0.borrow().anchor_metadata.is_some() }

fn compare(object: Object<'_>) -> Result<usize, &'static str> {
    let mut fresh = Vec::new();
    let mut result = Vec::new();
    let expected = object.boxhead_graph_anchor_edges_into(&mut fresh);
    let actual = object.boxhead_graph_anchor_edges_cached_into(&mut result);
    assert_eq!(actual, expected);
    // Failed fresh scans may leave a prefix in their temporary buffer. The
    // graph caller propagates the error without reading that prefix.
    if actual.is_ok() { assert_eq!(result, fresh); }
    actual
}

fn warm<'gc>(a: &Activation<'_, 'gc>, object: Object<'gc>, budget: &Rc<MetadataBudget>) -> usize {
    let mut fields = Vec::new();
    let (count, admitted) = object.boxhead_graph_anchor_edges_warm_into(a.gc(), budget, 8192, &mut fields)
        .expect("ordinary small fixture");
    assert!(admitted && cached(object));
    assert_eq!(compare(object), Ok(count));
    count
}

#[test]
fn anchor_metadata_positive_rows_keep_raw_order_hidden_keys_proto_count_and_clip_values() {
    with_avm(8, |a, root| {
        let budget = Rc::new(MetadataBudget::default());
        let object = bare(a); let child = bare(a); let proto = bare(a);
        put(a, object, "primitive", 17.0.into());
        put(a, object, "child", child.into());
        put(a, object, "__proto__", proto.into());
        let reference = MovieClipReference::try_from_stage_object(a, root).unwrap();
        object.define_value(a.gc(), key(a, "hidden"), Value::MovieClip(reference),
            Attribute::DONT_ENUM | Attribute::READ_ONLY | Attribute::VERSION_10);
        let wide = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 0xffff][..]));
        object.define_value(a.gc(), wide, child.into(), Attribute::DONT_DELETE);
        assert_eq!(warm(a, object, &budget), 5);
        let read = object.0.borrow();
        let row = read.anchor_metadata.as_ref().unwrap();
        assert_eq!(row.edges.len(), 3);
        assert!(row.edges.iter().any(|(name, value)| *name == wide && *value == child.into()));
        assert!(row.edges.iter().any(|(_, value)| matches!(value, Value::MovieClip(_))));
        assert!(!row.edges.iter().any(|(name, _)| name.eq_with_case(b"__proto__", true)));
        Ok(())
    });
}

#[test]
fn anchor_metadata_checkpoint_misses_never_admit_gameplay_objects_or_retain_errors() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let object = bare(a);
        put(a, object, "child", bare(a).into());
        for _ in 0..4 { assert_eq!(compare(object), Ok(1)); assert!(!cached(object)); }
        let getter = function(a, forbidden);
        object.add_property(a.gc(), key(a, "bad"), getter, None, Attribute::DONT_ENUM);
        assert_eq!(compare(object), Err("object has a virtual own property"));
        assert_eq!(object.boxhead_graph_anchor_edges_warm_into(a.gc(), &budget, 8192, &mut Vec::new()), None);
        assert!(!cached(object) && budget.used() == 0);
        object.delete(a, key(a, "bad"));
        assert_eq!(compare(object), Ok(1));
        assert!(!cached(object));
        warm(a, object, &budget);
        Ok(())
    });
}

#[test]
fn anchor_metadata_fast_data_local_and_definition_writes_invalidate_before_reuse() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let object = bare(a); let left = bare(a); let right = bare(a);
        put(a, object, "child", left.into());
        warm(a, object, &budget);
        assert!(matches!(object.boxhead_set_own_data(key(a, "child"), right.into(), a),
            crate::avm1::object::BoxheadOwnWrite::Written));
        assert!(!cached(object) && budget.used() == 0); compare(object).unwrap();
        warm(a, object, &budget);
        object.set_data(key(a, "child"), left.into(), a)?;
        assert!(!cached(object) && budget.used() == 0); compare(object).unwrap();
        warm(a, object, &budget);
        object.set_local(key(a, "child"), right.into(), a, object)?;
        assert!(!cached(object) && budget.used() == 0); compare(object).unwrap();
        warm(a, object, &budget);
        object.define_value(a.gc(), key(a, "child"), left.into(), Attribute::VERSION_10);
        assert!(!cached(object)); compare(object).unwrap();
        // Actual full-snapshot marker writes/flags/deletion remain ordinary
        // invalidations. The optimization does not special-case their names.
        warm(a, object, &budget);
        object.set(key(a, "__bhSnapshotRef"), Value::Number(7.0), a)?;
        assert!(!cached(object));
        object.set_attributes(a.gc(), Some(key(a, "__bhSnapshotRef")), Attribute::DONT_ENUM, Attribute::empty());
        warm(a, object, &budget);
        assert!(object.delete(a, key(a, "__bhSnapshotRef")));
        assert!(!cached(object)); assert_eq!(compare(object), Ok(1));
        Ok(())
    });
}

#[test]
fn anchor_metadata_flags_delete_and_readonly_writes_keep_original_descriptor_effects() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let object = bare(a); let child = bare(a);
        object.define_value(a.gc(), key(a, "locked"), child.into(), Attribute::VERSION_10 | Attribute::READ_ONLY | Attribute::DONT_DELETE);
        warm(a, object, &budget);
        object.set_data(key(a, "locked"), Value::Null, a)?;
        assert!(!cached(object)); assert_eq!(object.get_data(key(a, "locked"), a), Some(child.into()));
        warm(a, object, &budget);
        assert!(!object.delete(a, key(a, "locked"))); assert!(!cached(object));
        warm(a, object, &budget);
        object.set_attributes(a.gc(), Some(key(a, "locked")), Attribute::DONT_ENUM,
            Attribute::READ_ONLY | Attribute::DONT_DELETE);
        assert!(!cached(object));
        warm(a, object, &budget);
        object.set_data(key(a, "locked"), Value::Null, a)?;
        let (_, _, flags) = object.boxhead_graph_properties().unwrap()[0];
        assert!(!flags.intersects(Attribute::VERSION_10));
        assert_eq!(compare(object), Ok(1));
        warm(a, object, &budget);
        object.set_attributes(a.gc(), None, Attribute::READ_ONLY, Attribute::empty());
        assert!(!cached(object));
        warm(a, object, &budget);
        assert!(!object.delete(a, key(a, "absent"))); assert!(!cached(object));
        warm(a, object, &budget);
        assert!(object.delete(a, key(a, "locked"))); assert!(!cached(object));
        assert_eq!(compare(object), Ok(0));
        Ok(())
    });
}

#[test]
fn anchor_metadata_virtual_watcher_and_interface_changes_reject_without_callbacks() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let object = bare(a); let callback = function(a, forbidden);
        put(a, object, "child", bare(a).into());
        warm(a, object, &budget);
        object.add_property(a.gc(), key(a, "virtual"), callback, Some(callback), Attribute::DONT_ENUM);
        assert!(!cached(object));
        assert_eq!(compare(object), Err("object has a virtual own property"));
        object.delete(a, key(a, "virtual")); warm(a, object, &budget);
        object.add_property_with_case(a, key(a, "child"), callback, None, Attribute::empty());
        assert!(!cached(object)); assert_eq!(compare(object), Err("object has a virtual own property"));
        put(a, object, "child", bare(a).into()); warm(a, object, &budget);
        object.watch(a, key(a, "absent"), callback, Value::Undefined);
        assert!(!cached(object)); assert_eq!(compare(object), Err("object has watchers"));
        assert!(object.unwatch(a, key(a, "absent"))); assert_eq!(compare(object), Ok(1));
        warm(a, object, &budget);
        assert!(!object.unwatch(a, key(a, "missing"))); assert!(!cached(object));
        warm(a, object, &budget);
        object.set_interfaces(a.gc(), Vec::new());
        assert!(!cached(object));
        assert_eq!(compare(object), Err("object has per-instance interface metadata"));
        assert_eq!(object.boxhead_graph_anchor_edges_warm_into(a.gc(), &budget, 8192, &mut Vec::new()), None);
        assert_eq!(budget.used(), 0);
        Ok(())
    });
}

#[test]
fn anchor_metadata_array_length_indices_proto_and_native_construction_stay_fresh() {
    with_avm(8, |a, root| {
        let budget = Rc::new(MetadataBudget::default());
        let array = bare(a); let child = bare(a);
        warm(a, array, &budget);
        array.set_native(a.gc(), NativeObject::Array(())); assert!(!cached(array));
        array.set_length(a, 0)?; warm(a, array, &budget);
        array.set_element(a, 5, child.into())?;
        assert!(!cached(array)); assert_eq!(array.length(a)?, 6); assert_eq!(compare(array), Ok(2));
        warm(a, array, &budget);
        array.set_length(a, 3)?; assert!(!cached(array)); assert_eq!(compare(array), Ok(1));
        array.set_element(a, 1, child.into())?; warm(a, array, &budget);
        assert!(array.delete_element(a, 1)); assert!(!cached(array));
        warm(a, array, &budget);
        array.set_local(key(a, "4"), child.into(), a, array)?;
        assert!(!cached(array)); assert_eq!(array.length(a)?, 5);
        warm(a, array, &budget);
        array.set_data(key(a, "__proto__"), child.into(), a)?;
        assert!(!cached(array)); assert_eq!(compare(array), Ok(3));
        warm(a, array, &budget);
        array.set_native(a.gc(), NativeObject::Array(()));
        assert!(cached(array), "ignored reconstruction has no semantic mutation");
        let object = bare(a); warm(a, object, &budget);
        object.set_native(a.gc(), root.boxhead_graph_native());
        assert!(!cached(object));
        assert_eq!(object.boxhead_graph_anchor_edges_warm_into(a.gc(), &budget, 8192, &mut Vec::new()), None);
        Ok(())
    });
}

fn mutate_during_property_call<'gc>(a: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = a.global_object();
    let Some(Value::Object(target)) = global.get_data(key(a, "metadataTarget"), a) else { panic!("target"); };
    let replacement = global.get_data(key(a, "metadataReplacement"), a).unwrap();
    target.set_data(key(a, "edge"), replacement, a)?;
    put(a, global, "metadataCallbackCalls", 1.0.into());
    Ok(Value::Undefined)
}

#[test]
fn anchor_metadata_reentrant_property_callback_invalidates_warmed_descendant_only() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let parent = bare(a); let child = bare(a); let old = bare(a); let replacement = bare(a);
        put(a, parent, "child", child.into()); put(a, child, "edge", old.into());
        warm(a, parent, &budget); warm(a, child, &budget);
        let global = a.global_object();
        put(a, global, "metadataTarget", child.into());
        put(a, global, "metadataReplacement", replacement.into());
        put(a, global, "metadataCallbackCalls", 0.0.into());
        let trigger = bare(a);
        trigger.add_property(a.gc(), key(a, "invoke"), function(a, mutate_during_property_call), None, Attribute::empty());
        // Invoke the actual AVM property getter, rather than a synthetic
        // invalidation hook. Its nested write must see no outstanding borrow.
        trigger.get(key(a, "invoke"), a)?;
        assert_eq!(global.get_data(key(a, "metadataCallbackCalls"), a), Some(1.0.into()));
        assert!(cached(parent), "parent's raw child identity did not change");
        assert!(!cached(child), "actual reentrant getter changed child's raw edge");
        let mut edges = Vec::new();
        assert_eq!(child.boxhead_graph_anchor_edges_cached_into(&mut edges), Ok(1));
        assert_eq!(edges[0].1, replacement.into());
        compare(parent).unwrap(); compare(child).unwrap();
        Ok(())
    });
}

#[test]
fn anchor_metadata_large_object_falls_back_without_partial_cache_or_error_cache() {
    with_avm(8, |a, _| {
        let budget = Rc::new(MetadataBudget::default());
        let object = bare(a); let child = bare(a);
        for index in 0..8193 { put(a, object, &format!("p{index}"), child.into()); }
        let mut fields = Vec::new();
        assert_eq!(object.boxhead_graph_anchor_edges_warm_into(a.gc(), &budget, 8192, &mut fields), None);
        assert!(fields.is_empty() && !cached(object) && budget.used() == 0);
        assert_eq!(compare(object), Ok(8193));
        assert!(!cached(object));
        Ok(())
    });
}

#[derive(Collect)]
#[collect(no_drop)]
struct GcFixture<'gc> {
    owner: Option<Object<'gc>>,
    weak: Vec<ObjectWeak<'gc>>,
    #[collect(require_static)]
    budget: Rc<MetadataBudget>,
}

#[test]
fn anchor_metadata_gc_drops_deleted_child_and_refunds_invalidated_and_collected_entries() {
    let budget = Rc::new(MetadataBudget::default());
    let mut arena = Arena::<Rootable![GcFixture<'_>]>::new(|mc| {
        let owner = Object::new_without_proto(mc); let child = Object::new_without_proto(mc);
        owner.define_value(mc, AvmString::new_utf8(mc, "child"), child.into(), Attribute::empty());
        assert_eq!(owner.boxhead_graph_anchor_edges_warm_into(mc, &budget, 8192, &mut Vec::new()), Some((1, true)));
        GcFixture { owner: Some(owner), weak: vec![child.as_weak(), owner.as_weak()], budget: budget.clone() }
    });
    arena.finish_cycle(); arena.finish_cycle();
    assert!(budget.used() > 0);
    arena.mutate(|mc, root| {
        let owner = root.owner.unwrap();
        assert!(root.weak[0].upgrade(mc).is_some());
        owner.define_value(mc, AvmString::new_utf8(mc, "child"), Value::Undefined, Attribute::empty());
        assert_eq!(root.budget.used(), 0);
    });
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|mc, root| {
        assert!(root.weak[0].upgrade(mc).is_none(), "cache cannot retain a removed child");
        assert_eq!(root.owner.unwrap().boxhead_graph_anchor_edges_warm_into(mc, &root.budget, 8192, &mut Vec::new()), Some((1, true)));
    });
    assert!(budget.used() > 0);
    arena.mutate_root(|_, root| root.owner = None);
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|mc, root| assert!(root.weak[1].upgrade(mc).is_none()));
    assert_eq!(budget.used(), 0, "owner collection refunds inactive positive metadata");
}

#[test]
fn anchor_metadata_gc_mutation_and_publication_during_marking_keep_current_alias_only() {
    let budget = Rc::new(MetadataBudget::default());
    let mut arena = Arena::<Rootable![GcFixture<'_>]>::new(|mc| {
        let owner = Object::new_without_proto(mc); let child = Object::new_without_proto(mc);
        owner.define_value(mc, AvmString::new_utf8(mc, "child"), child.into(), Attribute::empty());
        owner.boxhead_graph_anchor_edges_warm_into(mc, &budget, 8192, &mut Vec::new()).unwrap();
        GcFixture { owner: Some(owner), weak: vec![child.as_weak()], budget: budget.clone() }
    });
    assert!(arena.finish_marking().is_some());
    assert_eq!(arena.collection_phase(), CollectionPhase::Marked);
    arena.mutate_root(|mc, root| {
        let owner = root.owner.unwrap(); let current = Object::new_without_proto(mc);
        owner.define_value(mc, AvmString::new_utf8(mc, "child"), current.into(), Attribute::empty());
        owner.define_value(mc, AvmString::new_utf8(mc, "alias"), current.into(), Attribute::DONT_ENUM);
        assert_eq!(owner.boxhead_graph_anchor_edges_warm_into(mc, &root.budget, 8192, &mut Vec::new()), Some((2, true)));
        root.weak.push(current.as_weak());
    });
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|mc, root| {
        assert!(root.weak[0].upgrade(mc).is_none());
        let current = root.weak[1].upgrade(mc).expect("current raw/cache aliases are traced");
        let owner = root.owner.unwrap(); let mut fields = Vec::new();
        assert_eq!(owner.boxhead_graph_anchor_edges_cached_into(&mut fields), Ok(2));
        assert!(fields.iter().all(|(_, value)| *value == current.into()));
        assert!(cached(owner)); compare(owner).unwrap();
    });
}
