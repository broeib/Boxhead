//! v20 capacity admission, actual container replacement, and complete fresh
//! packet/import oracles. The default production time/count caps stay active.

use super::*;
use asset_index::capacity_test_support as capacity;
use fnv::FnvHashMap;
use std::mem::size_of;

fn finish<'gc>(gc: &Mutation<'gc>, roots: [Object<'gc>; 6], mut state: asset_index::State<'gc>)
    -> asset_index::State<'gc> {
    for _ in 0..asset_index::MAX_CALLS { if state.warm(gc, roots) { break; } }
    let report = state.report();
    assert!(report.completed || report.unavailable, "optional preparation must terminate");
    assert!(report.calls <= asset_index::MAX_CALLS && report.entries <= asset_index::MAX_ENTRIES);
    assert!(report.bytes <= asset_index::MAX_STORAGE_BYTES);
    state
}

fn opaque_catalog<'gc>(a: &Activation<'_, 'gc>) -> ([Object<'gc>; 6], [Object<'gc>; 4]) {
    let roots = std::array::from_fn(|_| bare(a));
    let mut selected = [roots[0]; 4];
    // Many modest property maps keep fixture setup bounded. Opaque leaves are
    // counted/indexed but do not consume a traversal slot each during warming.
    // Zero-padded names make the selected positions unambiguous in sorted BFS.
    for block in 0..512 {
        let parent = bare(a); put(a, roots[0], &format!("block{block:03}"), parent.into());
        for index in 0..240 {
            let leaf = function(a, forbidden);
            put(a, parent, &format!("n{index:03}"), leaf.into());
            match (block, index) {
                (0, 0) => selected[0] = leaf,
                (300, 0) => selected[1] = leaf,
                (500, 0) => selected[2] = leaf,
                (511, 239) => selected[3] = leaf,
                _ => {},
            }
        }
    }
    (roots, selected)
}

#[test]
fn native_graph_asset_capacity_large_catalog_rebinds_beyond_initial_map_capacity() {
    const ENTRIES: usize = 6 + 512 + 512 * 240;
    let initial_map_capacity = FnvHashMap::<usize, usize>::with_capacity_and_hasher(
        65_536, Default::default()).capacity();
    assert!(ENTRIES > initial_map_capacity && ENTRIES < asset_index::MAX_ENTRIES,
        "the real fixture must force both the entry vector and initial name table to grow");
    with_avm(8, |a, _| {
        let (host, host_objects) = opaque_catalog(a);
        let (guest, guest_objects) = opaque_catalog(a);
        let names = ["early", "afterVector", "afterMap", "last"];
        let world = bare(a);
        for (name, object) in names.into_iter().zip(host_objects) { put(a, world, name, object.into()); }
        put(a, world, "self", world.into());
        let host_registry = rows(a, &bindings(host));
        let guest_registry = rows(a, &bindings(guest));
        let expected = frozen_v15::packet(world.into(), host_registry, a).unwrap();
        for (roots, objects) in [(host, host_objects), (guest, guest_objects)] {
            let state = finish(a.gc(), roots, asset_index::State::default());
            let report = state.report();
            assert!(report.completed && report.valid && !report.unavailable, "{report:?}");
            assert_eq!(report.entries, ENTRIES);
            assert_eq!(report.reason, "ready");
            let index = state.current().unwrap();
            assert!(index.entries.capacity() > 65_536 && index.entries.capacity() <= asset_index::MAX_ENTRIES);
            for object in objects {
                let id = index.object_id(object).expect("every selected native asset is indexed");
                let name = index.materialize(id);
                assert_eq!(index.find_name(&name), Some(id), "name lookup survives table replacement");
            }
            a.context.avm1.anchor_metadata.index = state;
            let registry = if Object::ptr_eq(roots[0], host[0]) { host_registry } else { guest_registry };
            assert!(Anchors::read(registry, a).unwrap().assets.is_some());
            let global = a.global_object();
            if Object::ptr_eq(roots[0], host[0]) {
                let export = key(a, "export");
                let Value::String(wire) = call(a, global, &[export.into(), world.into(), host_registry])?
                    else { panic!("large-catalog export must return a packet"); };
                assert_eq!(wire.to_utf8_lossy(), expected);
            } else {
                let import = key(a, "import"); let wire = key(a, &expected);
                let Value::Object(restored) = call(a, global, &[import.into(), wire.into(), guest_registry])?
                    else { panic!("large-catalog import must return a world object"); };
                assert_eq!(raw(restored, "self", a), Some(restored.into()));
                for (name, object) in names.into_iter().zip(guest_objects) {
                    assert_eq!(raw(restored, name, a), Some(object.into()), "import must use receiving assets");
                }
                assert_eq!(compare(restored.into(), guest_registry, a).unwrap(), expected);
            }
            assert!(a.context.avm1.anchor_metadata.index.report().hits >= 2);
        }
        Ok(())
    });
}

#[test]
fn native_graph_asset_capacity_tiny_tiers_preserve_aliases_and_collision_chains() {
    for collisions in [false, true] {
        with_avm(8, |a, _| {
            let roots = std::array::from_fn(|_| bare(a));
            let children: Vec<_> = (0..256).map(|_| bare(a)).collect();
            for (index, child) in children.iter().enumerate() {
                put(a, roots[0], &format!("n{index:03}"), (*child).into());
            }
            put(a, roots[1], "laterAlias", children[255].into());
            put(a, children[0], "self", children[0].into());
            let mut state = asset_index::State::with_capacity_for_test(8, asset_index::MAX_STORAGE_BYTES);
            if collisions { state.force_collisions_for_test(); }
            let state = finish(a.gc(), roots, state);
            assert!(state.report().valid && state.report().completed, "{:?}", state.report());
            assert_eq!(state.report().entries, 262);
            assert_eq!(state.report().fields, 258);
            let index = state.current().unwrap();
            assert!(index.entries.capacity() >= 262);
            for (position, child) in children.iter().enumerate() {
                let id = index.object_id(*child).unwrap();
                let name = index.materialize(id);
                assert_eq!(index.find_name(&name), Some(id));
                let mut expected = String::from("asset:player:0/");
                for unit in format!("n{position:03}").encode_utf16() { expected.push_str(&format!("{unit:04x}")); }
                assert_eq!(name, expected, "the first sorted BFS owner remains canonical");
            }
            a.context.avm1.anchor_metadata.index = state;
            let registry = rows(a, &bindings(roots)); let world = bare(a);
            for position in [0, 7, 14, 127, 255] {
                put(a, world, &format!("selected{position}"), children[position].into());
            }
            assert!(Anchors::read(registry, a).unwrap().assets.is_some());
            compare(world.into(), registry, a).unwrap();
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_capacity_map_replacement_charges_old_and_new_tables() {
    let mut map = FnvHashMap::<u64, usize>::with_capacity_and_hasher(8, Default::default());
    let old_capacity = map.capacity();
    for key in 0..old_capacity { map.insert(key as u64, key * 3 + 1); }
    let expected = map.clone();
    let target = capacity::growth_capacity(old_capacity, map.len() + 1).unwrap();
    let old_bytes = capacity::map_bytes(old_capacity).unwrap();
    let requested = capacity::new_map_bytes(target).unwrap();
    let current = old_bytes + 4096;
    let held_key = 14;
    // This budget funds final storage but omits the still-live old table.
    let missing_old = current - old_bytes + requested + held_key;
    assert_eq!(capacity::replace_map(&mut map, target, current, held_key, missing_old), Err("storage-limit"));
    assert_eq!(map, expected); assert_eq!(map.capacity(), old_capacity);
    // A future key is also live during the admission, even before allocation.
    assert_eq!(capacity::replace_map(&mut map, target, current, held_key, current + requested), Err("storage-limit"));
    assert_eq!(map, expected); assert_eq!(map.capacity(), old_capacity);
    capacity::replace_map(&mut map, target, current, held_key, current + requested + held_key).unwrap();
    assert!(map.capacity() >= target && map.capacity() > old_capacity);
    assert!(capacity::map_bytes(map.capacity()).unwrap() <= requested);
    assert_eq!(map, expected, "replacement preserves every identity/hash bucket scalar pair");
    let after_capacity = map.capacity();
    map.insert(u64::MAX, 17);
    assert_eq!(map.capacity(), after_capacity, "the next admitted insert must not allocate again");
}

#[test]
fn native_graph_asset_capacity_storage_denial_uses_complete_fresh_fallback() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let empty = finish(a.gc(), roots,
            asset_index::State::with_capacity_for_test(8, asset_index::MAX_STORAGE_BYTES));
        assert!(empty.report().valid);
        // Fund the actual small index, maximum field/sort scratch and a little
        // setup slack, but not thousands of entries or a hidden table resize.
        let limit = empty.report().bytes + 2 * 8192 * size_of::<(AvmString<'_>, Value<'_>)>() + 4096;
        assert!(limit < asset_index::MAX_STORAGE_BYTES);
        drop(empty);
        let mut last = roots[0];
        for block in 0..32 {
            let branch = bare(a); put(a, roots[0], &format!("b{block:02}"), branch.into());
            for child in 0..128 {
                last = bare(a); put(a, branch, &format!("n{child:03}"), last.into());
            }
        }
        let state = finish(a.gc(), roots, asset_index::State::with_capacity_for_test(8, limit));
        let report = state.report();
        assert!(report.unavailable && !report.completed && !report.valid && state.current().is_none(), "{report:?}");
        assert_eq!(report.reason, "storage-limit");
        assert!(report.entries >= 6 && report.entries < 6 + 32 + 4096);
        assert_eq!(report.bytes, 0, "denied partial coverage is retired");
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(roots)); let world = bare(a);
        put(a, world, "lateAsset", last.into());
        assert!(Anchors::read(registry, a).unwrap().assets.is_none());
        compare(world.into(), registry, a).unwrap();
        assert!(a.context.avm1.anchor_metadata.index.report().fallbacks > 0);
        Ok(())
    });
}

#[test]
fn native_graph_asset_capacity_growth_math_rejects_overflow_and_unfunded_keys() {
    assert_eq!(asset_index::MAX_ENTRIES, 250_000);
    assert_eq!(asset_index::MAX_STORAGE_BYTES, 64 * 1024 * 1024);
    assert_eq!(capacity::growth_capacity(65_536, 65_537), Some(131_072));
    assert_eq!(capacity::growth_capacity(131_072, 131_073), Some(250_000));
    assert_eq!(capacity::growth_capacity(250_000, 250_001), None);
    assert!(capacity::admit_growth(512, 1024, 31, 1567));
    assert!(!capacity::admit_growth(512, 1024, 31, 1566));
    assert!(!capacity::admit_growth(usize::MAX, 1, 0, usize::MAX));
    assert!(!capacity::admit_growth(usize::MAX - 7, 4, 4, usize::MAX));
    assert!(!capacity::admit_growth(2, 0, 0, 1));
    assert_eq!(capacity::new_map_bytes(usize::MAX), None);
    assert_eq!(capacity::map_bytes(usize::MAX), None);
    let mut map = FnvHashMap::<u64, usize>::default(); map.insert(7, 11);
    let previous = map.clone(); let old_capacity = map.capacity();
    assert_eq!(capacity::replace_map(&mut map, 8, usize::MAX, 0, usize::MAX), Err("storage-limit"));
    assert_eq!(capacity::replace_map(&mut map, 1, 0, 0, usize::MAX), Err("entry-limit"));
    assert_eq!(capacity::replace_map(&mut map, 250_001, 0, 0, usize::MAX), Err("entry-limit"));
    assert_eq!(map, previous); assert_eq!(map.capacity(), old_capacity);
}

#[test]
fn native_graph_asset_capacity_root_and_call_limits_remain_fail_closed() {
    assert_eq!(asset_index::MAX_CALLS, 128);
    assert_eq!(asset_index::SLICE_MICROS, 4000);
    assert_eq!(asset_index::MAX_STAGE_EDGES, 8192);
    with_avm(8, |a, _| {
        let mut roots = std::array::from_fn(|_| bare(a));
        roots[0] = function(a, forbidden);
        let state = finish(a.gc(), roots,
            asset_index::State::with_capacity_for_test(8, asset_index::MAX_STORAGE_BYTES));
        assert!(state.report().unavailable && state.current().is_none());
        assert_eq!(state.report().reason, "root-kind-or-storage-limit");
        assert_eq!(state.report().bytes, 0);
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(roots));
        assert!(Anchors::read(registry, a).unwrap().assets.is_none());
        compare(roots[0].into(), registry, a).unwrap();
        Ok(())
    });
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let mut last = roots[0];
        for block in 0..32 {
            let branch = bare(a); put(a, roots[0], &format!("b{block:02}"), branch.into());
            for child in 0..128 { last = bare(a); put(a, branch, &format!("n{child:03}"), last.into()); }
        }
        let mut state = asset_index::State::with_capacity_for_test(8, asset_index::MAX_STORAGE_BYTES);
        assert!(!state.warm(a.gc(), roots), "the unchanged 2048-object slice cannot consume this graph");
        assert!(state.report().entries > 6);
        state.exhaust_calls_for_test();
        assert!(state.warm(a.gc(), roots));
        assert_eq!(state.report().calls, 128);
        assert_eq!(state.report().reason, "call-limit");
        assert!(state.report().unavailable && !state.report().completed && !state.report().valid);
        assert_eq!(state.report().bytes, 0);
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(roots));
        assert!(Anchors::read(registry, a).unwrap().assets.is_none());
        compare(last.into(), registry, a).unwrap();
        Ok(())
    });
}
