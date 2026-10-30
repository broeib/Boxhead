//! Real asset-index preparation and the sealed complete v15 fresh-reader oracle.
//! The existing 375 cases remain intact. Successful production export/import,
//! exact rejection order, actual mutation APIs and actual weak GC are exercised.

use super::*;
use crate::avm1::anchor_metadata;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::object::{ObjectWeak, super_object::SuperObject};
use crate::avm1::test_utils::with_avm;
use gc_arena::{Arena, Collect, Mutation, Rootable, arena::CollectionPhase};
use std::time::Duration;

#[path = "frozen_v15.rs"]
mod frozen_v15;

fn key<'gc>(a: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> { AvmString::new_utf8(a.gc(), value) }
fn bare<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> { Object::new_without_proto(a.gc()) }
fn put<'gc>(a: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(a.gc(), key(a, name), value, Attribute::empty());
}
fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&a.context.strings, None, None)
}
fn forbidden<'gc>(_: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    panic!("asset-index preparation or graph read invoked an AVM callback");
}
fn rows<'gc>(a: &Activation<'_, 'gc>, bindings: &[(&str, Value<'gc>, bool)]) -> Value<'gc> {
    let list = bare(a); list.set_native(a.gc(), NativeObject::Array(()));
    put(a, list, "length", (bindings.len() as f64).into());
    for (index, (name, value, deep)) in bindings.iter().enumerate() {
        let row = bare(a); put(a, row, "id", key(a, name).into());
        put(a, row, "value", *value); put(a, row, "deep", (*deep).into());
        put(a, list, &index.to_string(), row.into());
    }
    list.into()
}
fn bindings<'gc>(roots: [Object<'gc>; 6]) -> Vec<(&'static str, Value<'gc>, bool)> {
    asset_index::ROOT_IDS.into_iter().zip(roots).map(|(name, root)| (name, root.into(), true)).collect()
}
fn prepared<'gc>(gc: &Mutation<'gc>, roots: [Object<'gc>; 6], collisions: bool) -> asset_index::State<'gc> {
    let mut state = asset_index::State::default();
    if collisions { state.force_collisions_for_test(); }
    for _ in 0..asset_index::MAX_CALLS { if state.warm(gc, roots) { break; } }
    let report = state.report();
    assert!(report.completed || report.unavailable, "optional preparation must terminate");
    assert!(report.calls <= asset_index::MAX_CALLS && report.entries <= asset_index::MAX_ENTRIES);
    assert!(report.bytes <= asset_index::MAX_STORAGE_BYTES);
    state
}
fn warm<'gc>(a: &mut Activation<'_, 'gc>, roots: [Object<'gc>; 6], collisions: bool) {
    let state = prepared(a.gc(), roots, collisions);
    assert!(state.current().is_some(), "supported fixture must build a complete index");
    a.context.avm1.anchor_metadata.index = state;
}
fn packet<'gc>(root: Value<'gc>, bindings: Value<'gc>, a: &mut Activation<'_, 'gc>) -> ResultG<String> {
    let anchors = Anchors::read(bindings, a)?;
    pack(&export_graph(root, &anchors, a)?)
}
fn compare<'gc>(root: Value<'gc>, bindings: Value<'gc>, a: &mut Activation<'_, 'gc>) -> ResultG<String> {
    let actual = packet(root, bindings, a);
    let expected = frozen_v15::packet(root, bindings, a);
    assert_eq!(actual, expected, "complete compressed bytes/exact fresh rejection differ");
    actual
}

#[test]
fn native_graph_asset_index_production_calls_match_fresh_packets_and_receiving_objects() {
    for collisions in [false, true] {
        with_avm(8, |a, clip| {
            let host: [Object<'_>; 6] = std::array::from_fn(|_| bare(a));
            let guest: [Object<'_>; 6] = std::array::from_fn(|_| bare(a));
            let host_leaf = bare(a); let guest_leaf = bare(a);
            let host_wide = bare(a); let guest_wide = bare(a);
            let host_empty = bare(a); let guest_empty = bare(a);
            let host_method = function(a, forbidden); let guest_method = function(a, forbidden);
            let wide = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 0xffff, 0xdc00][..]));
            for (roots, leaf, method, wide_child, empty_child, reverse) in [
                (host, host_leaf, host_method, host_wide, host_empty, false),
                (guest, guest_leaf, guest_method, guest_wide, guest_empty, true)] {
                for root in roots {
                    for name in if reverse { ["z", "a"] } else { ["a", "z"] } { put(a, root, name, leaf.into()); }
                    put(a, root, "opaque", method.into());
                }
                leaf.define_value(a.gc(), wide, wide_child.into(), Attribute::DONT_ENUM | Attribute::VERSION_10);
                put(a, leaf, "", empty_child.into()); put(a, wide_child, "cycle", roots[0].into());
                let array = bare(a); array.set_native(a.gc(), NativeObject::Array(()));
                put(a, array, "length", 2.0.into()); put(a, array, "0", leaf.into());
                put(a, roots[1], "array", array.into());
            }
            let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
            let mut host_bindings = bindings(host); host_bindings.push(("live:clip", clip.into(), false));
            let mut guest_bindings = bindings(guest); guest_bindings.push(("live:clip", Value::MovieClip(reference), false));
            let host_rows = rows(a, &host_bindings); let guest_rows = rows(a, &guest_bindings);
            let root = bare(a); put(a, root, "leaf", host_leaf.into()); put(a, root, "opaque", host_method.into());
            put(a, root, "wideAsset", host_wide.into()); put(a, root, "emptyAsset", host_empty.into());
            put(a, root, "clip", clip.into()); put(a, root, "reference", Value::MovieClip(reference));
            put(a, root, "self", root.into()); put(a, root, "negativeZero", (-0.0_f64).into());
            root.define_value(a.gc(), key(a, "hidden"), f64::from_bits(0x7ff8_0000_0000_0017).into(),
                Attribute::DONT_ENUM | Attribute::READ_ONLY | Attribute::VERSION_10);
            let pixels = vec![Color::rgba(3, 11, 29, 255), Color::rgba(1, 2, 3, 7)];
            let bitmap = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
                NativeObject::BitmapData(BitmapData::new_with_pixels(a.gc(), 2, 1, true, pixels.clone())));
            put(a, root, "pixels", bitmap.into());
            let expected = frozen_v15::packet(root.into(), host_rows, a).unwrap();
            warm(a, host, collisions);
            assert!(Anchors::read(host_rows, a).unwrap().assets.is_some());
            let global = a.global_object(); let export = key(a, "export");
            let Value::String(wire) = call(a, global, &[export.into(), root.into(), host_rows])? else { panic!("wire"); };
            assert_eq!(wire.to_utf8_lossy(), expected);
            assert!(a.context.avm1.anchor_metadata.index.report().hits >= 2);
            warm(a, guest, collisions);
            let import = key(a, "import");
            let Value::Object(restored) = call(a, global, &[import.into(), wire.into(), guest_rows])? else { panic!("restored root"); };
            assert_eq!(raw(restored, "self", a), Some(restored.into()));
            assert_eq!(raw(restored, "leaf", a), Some(guest_leaf.into()));
            assert_eq!(raw(restored, "opaque", a), Some(guest_method.into()));
            assert_eq!(raw(restored, "wideAsset", a), Some(guest_wide.into()));
            assert_eq!(raw(restored, "emptyAsset", a), Some(guest_empty.into()));
            assert_eq!(raw(restored, "clip", a), Some(clip.into()));
            let Some(Value::MovieClip(actual)) = raw(restored, "reference", a) else { panic!("reference kind"); };
            assert!(Object::ptr_eq(actual.coerce_to_object(a).unwrap(), clip));
            let Some(Value::Object(restored_bitmap)) = raw(restored, "pixels", a) else { panic!("pixels"); };
            let NativeObject::BitmapData(restored_bitmap) = restored_bitmap.boxhead_graph_native() else { panic!("native pixels"); };
            assert_eq!(restored_bitmap.sync(a.context.renderer).borrow().pixels(), pixels);
            assert_eq!(compare(restored.into(), guest_rows, a).unwrap(), expected);
            Ok(())
        });
    }
    with_avm(8, |a, _| {
        let root = bare(a); let leaf = bare(a); put(a, root, "leaf", leaf.into());
        let roots = [root; 6]; let registry = rows(a, &bindings(roots));
        warm(a, roots, false);
        assert!(Anchors::read(registry, a).unwrap().assets.is_some());
        compare(leaf.into(), registry, a).unwrap();
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_explicit_aliases_and_name_collisions_use_exact_fresh_fallback() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a)); let leaf = bare(a); let other = bare(a);
        put(a, roots[0], "leaf", leaf.into()); warm(a, roots, false);
        for case in 0..5 {
            let mut list = bindings(roots);
            match case {
                0 => list.insert(0, ("explicit:leaf", leaf.into(), false)),
                1 => list.insert(0, ("explicit:root", roots[0].into(), false)),
                2 => list.push(("asset:player:0/006c006500610066", other.into(), false)),
                3 => list.push(("asset:player:0/006c006500610066", leaf.into(), false)),
                _ => list.push(("asset:player:0/not-a-generated-key", other.into(), false)),
            }
            let registry = rows(a, &list);
            if let Ok(table) = Anchors::read(registry, a) { assert!(table.assets.is_none()); }
            let result = compare(leaf.into(), registry, a);
            if case == 2 { assert_eq!(result.unwrap_err(), "anchor ID points to different objects: asset:player:0/006c006500610066"); }
            else { result.unwrap(); }
        }
        assert_eq!(a.context.avm1.anchor_metadata.index.report().hits, 0);
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_requires_complete_ordered_current_roots_and_no_extra_deep_rows() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a)); let leaf = bare(a); put(a, roots[0], "leaf", leaf.into());
        warm(a, roots, false);
        for case in 0..6 {
            let mut list = bindings(roots);
            match case {
                0 => list.reverse(),
                1 => { list.pop(); },
                2 => list.push(("extra:deep", bare(a).into(), true)),
                3 => list[0].1 = bare(a).into(),
                4 => list[0].2 = false,
                _ => list[0].0 = "different:root",
            }
            let registry = rows(a, &list);
            assert!(Anchors::read(registry, a).unwrap().assets.is_none());
            compare(leaf.into(), registry, a).unwrap();
        }
        assert!(a.context.avm1.anchor_metadata.index.current().is_some(), "registry misses do not forge or mutate a certificate");
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_real_semantic_write_routes_invalidate_before_reuse() {
    for case in 0..12 {
        with_avm(8, |a, _| {
            let roots = std::array::from_fn(|_| bare(a)); let child = bare(a); let old = bare(a); let replacement = bare(a);
            put(a, roots[0], "child", child.into()); put(a, child, "edge", old.into());
            let registry = rows(a, &bindings(roots)); let callback = function(a, forbidden);
            warm(a, roots, false); assert!(Anchors::read(registry, a).unwrap().assets.is_some());
            match case {
                0 => child.set_data(key(a, "edge"), replacement.into(), a)?,
                1 => assert!(matches!(child.boxhead_set_own_data(key(a, "edge"), replacement.into(), a),
                    crate::avm1::object::BoxheadOwnWrite::Written)),
                2 => {
                    // A missing own slot reaches the original set_local route
                    // through the public setter, including property creation.
                    child.set(key(a, "freshLocal"), replacement, a)?;
                    assert_eq!(raw(child, "freshLocal", a), Some(replacement.into()));
                }
                3 => child.define_value(a.gc(), key(a, "edge"), replacement.into(), Attribute::VERSION_10),
                4 => child.set_attributes(a.gc(), Some(key(a, "edge")), Attribute::DONT_ENUM, Attribute::empty()),
                5 => { assert!(child.delete(a, key(a, "edge"))); },
                6 => child.set_data(key(a, "__proto__"), replacement.into(), a)?,
                7 => { assert!(!child.delete(a, key(a, "absent"))); },
                8 => { child.watch(a, key(a, "edge"), callback, Value::Undefined); },
                9 => { assert!(!child.unwatch(a, key(a, "absent"))); },
                10 => child.set_interfaces(a.gc(), Vec::new()),
                _ => child.add_property(a.gc(), key(a, "virtual"), callback, Some(callback), Attribute::DONT_ENUM),
            }
            assert!(a.context.avm1.anchor_metadata.index.current().is_none(), "mutation route {case} kept its certificate");
            let world = bare(a); put(a, world, "old", old.into()); put(a, world, "replacement", replacement.into());
            let result = compare(world.into(), registry, a);
            if [8, 10, 11].contains(&case) { assert!(result.is_err()); } else { result.unwrap(); }
            assert_eq!(a.context.avm1.anchor_metadata.index.report().bytes, 0, "invalid persistent buffers are retired on the next read");
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_array_native_and_opaque_leaf_mutations_are_observed() {
    for case in 0..6 {
        with_avm(8, |a, _| {
            let roots = std::array::from_fn(|_| bare(a)); let child = bare(a); let target = bare(a); let replacement = bare(a);
            let method = function(a, forbidden);
            if case < 4 {
                child.set_native(a.gc(), NativeObject::Array(())); child.set_length(a, 2)?;
                child.set_element(a, 0, target.into())?;
            }
            put(a, roots[0], "child", child.into()); put(a, roots[0], "opaque", method.into());
            let registry = rows(a, &bindings(roots)); warm(a, roots, false);
            match case {
                0 => child.set_element(a, 3, replacement.into())?,
                1 => child.set_length(a, 0)?,
                2 => { assert!(child.delete_element(a, 0)); },
                3 => {
                    child.set(key(a, "4"), target, a)?;
                    assert_eq!(child.length(a)?, 5, "public Array write keeps index/length semantics");
                    assert_eq!(raw(child, "4", a), Some(target.into()));
                }
                4 => child.set_native(a.gc(), NativeObject::Array(())),
                _ => put(a, method, "opaqueOwnChange", 1.0.into()),
            }
            assert!(a.context.avm1.anchor_metadata.index.current().is_none());
            compare(child.into(), registry, a).unwrap();
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_partial_work_restarts_after_writes_and_call_cap_finishes_loading() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        for block in 0..32 {
            let parent = bare(a); put(a, roots[0], &format!("block{block}"), parent.into());
            for index in 0..128 { put(a, parent, &format!("n{index}"), bare(a).into()); }
        }
        let mut state = asset_index::State::default();
        assert!(!state.warm(a.gc(), roots), "object slice cannot traverse 4000 objects in one call");
        put(a, roots[0], "newPrimitive", 17.0.into());
        for _ in 1..asset_index::MAX_CALLS { if state.warm(a.gc(), roots) { break; } }
        assert!(state.current().is_some());
        assert_eq!(state.report().entries, 6 + 32 + 32 * 128);
        assert_eq!(state.report().fields, 33 + 32 * 128);
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(roots));
        assert!(Anchors::read(registry, a).unwrap().assets.is_some()); compare(Value::Null, registry, a).unwrap();
        let mut limited = asset_index::State::default();
        assert!(!limited.warm(a.gc(), roots)); limited.exhaust_calls_for_test();
        assert!(limited.warm(a.gc(), roots));
        assert!(limited.report().unavailable && !limited.report().valid && limited.report().bytes == 0);
        a.context.avm1.anchor_metadata.index = limited;
        assert!(Anchors::read(registry, a).unwrap().assets.is_none()); compare(Value::Null, registry, a).unwrap();
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_stage_super_and_virtual_inputs_fall_back_without_callbacks() {
    for case in 0..4 {
        with_avm(8, |a, clip| {
            let roots = std::array::from_fn(|_| bare(a));
            let reference = MovieClipReference::from_path(a.gc(), WStr::from_units(b"_level98"));
            match case {
                0 => put(a, roots[0], "clip", Value::MovieClip(reference)),
                1 => put(a, roots[0], "clip", clip.into()),
                2 => {
                    let object = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
                        NativeObject::Super(SuperObject::new(roots[0], 1)));
                    put(a, roots[0], "super", object.into());
                }
                _ => roots[0].add_property(a.gc(), key(a, "hidden"), function(a, forbidden), None, Attribute::DONT_ENUM),
            }
            let state = prepared(a.gc(), roots, false);
            if case < 2 {
                assert!(state.report().valid && state.current().is_some(), "display edges are deferred, never resolved during preparation");
                assert_eq!(state.report().stage_edges, 1);
            } else {
                assert!(state.report().unavailable && state.current().is_none());
            }
            assert!(a.get_level(98).is_none(), "preparation never resolves or creates a stage level");
            a.context.avm1.anchor_metadata.index = state;
            let registry = rows(a, &bindings(roots));
            let result = compare(Value::Null, registry, a);
            if case >= 2 { assert!(result.is_err()); } else { result.unwrap(); }
            if case == 0 { assert!(a.get_level(98).is_some(), "only the original fresh reader resolves the reference"); }
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_path_and_field_caps_keep_alias_errors_and_fresh_limits() {
    for case in 0..3 {
        with_avm(8, |a, _| {
            let roots = std::array::from_fn(|_| bare(a));
            if case == 0 { put(a, roots[0], &"x".repeat(512), roots[0].into()); }
            else {
                for index in 0..8193 {
                    roots[0].define_value(a.gc(), key(a, &format!("hidden{index}")), (index as f64).into(),
                        Attribute::DONT_ENUM | Attribute::VERSION_10);
                }
                if case == 2 { roots[0].add_property(a.gc(), key(a, "virtual"), function(a, forbidden), None, Attribute::DONT_ENUM); }
            }
            let state = prepared(a.gc(), roots, false);
            assert!(state.report().unavailable && state.current().is_none());
            a.context.avm1.anchor_metadata.index = state;
            let registry = rows(a, &bindings(roots)); let result = compare(Value::Null, registry, a);
            match case {
                0 => assert_eq!(result.unwrap_err(), "deep anchor path limit exceeded"),
                1 => { result.unwrap(); },
                _ => assert!(result.unwrap_err().contains("object has a virtual own property")),
            }
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_entry_budget_never_publishes_partial_coverage() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        // The optional index now admits the fresh reader's existing 250000
        // anchor envelope. Exceed that actual limit; the smaller v19 fixture
        // is exercised as supported by the new capacity regression below.
        for block in 0..(asset_index::MAX_ENTRIES / 8192 + 1) {
            let parent = bare(a); put(a, roots[0], &format!("block{block}"), parent.into());
            for index in 0..8192 { put(a, parent, &index.to_string(), bare(a).into()); }
        }
        let state = prepared(a.gc(), roots, false);
        assert!(state.report().unavailable && !state.report().completed && state.current().is_none());
        assert_eq!(state.report().entries, asset_index::MAX_ENTRIES);
        assert_eq!(state.report().reason, "entry-limit");
        assert_eq!(state.report().bytes, 0);
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(roots));
        assert_eq!(Anchors::read(registry, a).err().unwrap(), "anchor count limit exceeded");
        assert_eq!(compare(Value::Null, registry, a).unwrap_err(), "anchor count limit exceeded");
        Ok(())
    });
}

#[derive(Collect)]
#[collect(no_drop)]
struct WeakFixture<'gc> {
    roots: Option<[Object<'gc>; 6]>,
    weak: Vec<ObjectWeak<'gc>>,
    state: asset_index::State<'gc>,
}

#[test]
fn native_graph_asset_index_weak_gc_does_not_retain_removed_children_or_roots() {
    let mut arena = Arena::<Rootable![WeakFixture<'_>]>::new(|gc| {
        let roots = std::array::from_fn(|_| Object::new_without_proto(gc));
        let child = Object::new_without_proto(gc);
        roots[0].define_value(gc, AvmString::new_utf8(gc, "child"), child.into(), Attribute::empty());
        let state = prepared(gc, roots, false); assert!(state.current().is_some());
        WeakFixture { roots: Some(roots), weak: vec![child.as_weak(), roots[0].as_weak()], state }
    });
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|gc, root| {
        assert!(root.state.current().is_some() && root.weak[0].upgrade(gc).is_some());
        root.roots.unwrap()[0].define_value(gc, AvmString::new_utf8(gc, "child"), Value::Null, Attribute::empty());
        assert!(root.state.current().is_none());
    });
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|gc, root| assert!(root.weak[0].upgrade(gc).is_none(), "persistent index must not retain a removed asset"));
    arena.mutate_root(|_, root| root.roots = None);
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate_root(|gc, root| {
        assert!(root.weak.iter().all(|weak| weak.upgrade(gc).is_none()));
        assert!(root.state.current().is_none(), "collected/potentially reused pointers cannot retain a valid certificate");
        let replacement = std::array::from_fn(|_| Object::new_without_proto(gc));
        root.state = prepared(gc, replacement, false); root.roots = Some(replacement);
        let index = root.state.current().unwrap();
        for (position, object) in replacement.into_iter().enumerate() { assert!(index.root_matches(position, object, gc)); }
        assert!(root.weak.iter().all(|weak| weak.upgrade(gc).is_none()));
    });
}

#[test]
fn native_graph_asset_index_publication_during_marking_keeps_only_live_asset_references() {
    let mut arena = Arena::<Rootable![WeakFixture<'_>]>::new(|gc| {
        let roots = std::array::from_fn(|_| Object::new_without_proto(gc)); let old = Object::new_without_proto(gc);
        roots[0].define_value(gc, AvmString::new_utf8(gc, "child"), old.into(), Attribute::empty());
        WeakFixture { roots: Some(roots), weak: vec![old.as_weak()], state: asset_index::State::default() }
    });
    assert!(arena.finish_marking().is_some());
    assert_eq!(arena.collection_phase(), CollectionPhase::Marked);
    arena.mutate_root(|gc, root| {
        let roots = root.roots.unwrap(); let current = Object::new_without_proto(gc);
        roots[0].define_value(gc, AvmString::new_utf8(gc, "child"), current.into(), Attribute::DONT_ENUM);
        root.weak.push(current.as_weak()); root.state = prepared(gc, roots, false);
        assert!(root.state.current().is_some());
    });
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|gc, root| {
        assert!(root.weak[0].upgrade(gc).is_none());
        let current = root.weak[1].upgrade(gc).unwrap(); let index = root.state.current().unwrap();
        assert_eq!(index.materialize(index.object_id(current).unwrap()), "asset:player:0/006300680069006c0064");
        assert_eq!(index.find_name("asset:player:0/006300680069006c0064"), index.object_id(current));
    });
}

fn mutate_in_getter<'gc>(a: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = a.global_object();
    let Some(Value::Object(target)) = global.get_data(key(a, "assetIndexTarget"), a) else { panic!("target"); };
    target.set_data(key(a, "edge"), Value::Null, a)?;
    put(a, global, "assetIndexCalls", 1.0.into());
    Ok(Value::Undefined)
}

#[test]
fn native_graph_asset_index_reentrant_write_invalidates_active_lookup_and_next_read_is_fresh() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a)); let child = bare(a); let leaf = bare(a);
        put(a, roots[0], "child", child.into()); put(a, child, "edge", leaf.into());
        let global = a.global_object(); put(a, global, "assetIndexTarget", child.into()); put(a, global, "assetIndexCalls", 0.0.into());
        let trigger = bare(a); trigger.add_property(a.gc(), key(a, "invoke"), function(a, mutate_in_getter), None, Attribute::empty());
        let registry = rows(a, &bindings(roots)); warm(a, roots, false);
        let active = Anchors::read(registry, a).unwrap(); assert!(active.assets.is_some());
        trigger.get(key(a, "invoke"), a)?;
        assert_eq!(raw(global, "assetIndexCalls", a), Some(1.0.into()));
        assert!(a.context.avm1.anchor_metadata.index.current().is_none());
        assert_eq!(active.atom(child.into(), a).unwrap_err(), "asset anchor index changed during native graph call");
        assert_eq!(active.resolve("asset:player:0/006300680069006c0064", 0).unwrap_err(), "asset anchor index changed during native graph call");
        assert!(Anchors::read(registry, a).unwrap().assets.is_none()); compare(leaf.into(), registry, a).unwrap();
        Ok(())
    });
}

fn namespace<'gc>(a: &Activation<'_, 'gc>, roots: [Object<'gc>; 6]) {
    let thing = bare(a); let creature = bare(a); let player = function(a, forbidden); let players = bare(a);
    let zombie = function(a, forbidden); let devil = function(a, forbidden);
    put(a, a.global_object(), "Thing", thing.into()); put(a, thing, "Creature", creature.into());
    put(a, creature, "CThing_Creature_Player", player.into()); put(a, creature, "CThing_Creature_Zombie", zombie.into());
    put(a, creature, "CThing_Creature_Devil", devil.into()); put(a, player, "mXSI_Collections", players.into());
    for (index, root) in roots[..4].iter().enumerate() { put(a, players, &index.to_string(), (*root).into()); }
    put(a, zombie, "mXSI_Collection", roots[4].into()); put(a, devil, "mXSI_Collection", roots[5].into());
}

#[test]
fn native_graph_asset_index_readonly_status_and_timeout_keep_existing_contracts() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a)); let leaf = bare(a); put(a, roots[0], "leaf", leaf.into());
        namespace(a, roots); let global = a.global_object(); let operation = key(a, "prewarm");
        for _ in 0..asset_index::MAX_CALLS {
            if anchor_metadata::call(a, global, &[operation.into()])? == Value::Bool(true) { break; }
        }
        let before = a.context.avm1.anchor_metadata.index.report(); assert!(before.valid);
        let old_status = key(a, "status");
        let Value::Object(old) = anchor_metadata::call(a, global, &[old_status.into()])? else { panic!("old status"); };
        let old_fields = old.boxhead_graph_properties().unwrap();
        assert_eq!(old_fields.len(), 11);
        assert_eq!(old_fields.iter().filter(|(name, _, _)| !name.eq_with_case(b"assetIndex", true)).count(), 10);
        let Some(Value::Object(snapshot)) = raw(old, "assetIndex", a) else { panic!("index snapshot"); };
        assert_eq!(raw(snapshot, "ready", a), Some(true.into()));
        assert_eq!(raw(snapshot, "reason", a), Some(key(a, "ready").into()));
        global.add_property(a.gc(), key(a, "Thing"), function(a, forbidden), None, Attribute::empty());
        let status = key(a, "indexStatus");
        let Value::Object(status) = anchor_metadata::call(a, global, &[status.into()])? else { panic!("index status"); };
        let fields = status.boxhead_graph_properties().unwrap(); assert_eq!(fields.len(), 14);
        for (_, value, flags) in fields {
            assert!(matches!(value, Value::Number(_) | Value::Bool(_)));
            assert!(flags.contains(Attribute::READ_ONLY | Attribute::DONT_DELETE));
        }
        assert_eq!(a.context.avm1.anchor_metadata.index.report(), before, "diagnostics do no preparation or traversal");
        assert_eq!(raw(status, "valid", a), Some(Value::Bool(true)));
        assert_eq!(raw(status, "sliceMicros", a), Some((asset_index::SLICE_MICROS as f64).into()));
        let registry = rows(a, &bindings(roots)); let duration = a.context.max_execution_duration;
        a.context.max_execution_duration = Duration::ZERO;
        assert_eq!(compare(leaf.into(), registry, a).unwrap_err(), "native graph execution timeout");
        a.context.max_execution_duration = duration;
        compare(leaf.into(), registry, a).unwrap();
        Ok(())
    });
}

#[path = "asset_display_tests.rs"]
mod display_tests;

#[path = "asset_capacity_tests.rs"]
mod capacity_tests;
