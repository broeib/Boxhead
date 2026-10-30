//! v19 display-edge replay against the sealed complete fresh-reader oracle.
//! The production fresh BFS remains the exact v18 fallback, also exercised
//! below with preparation disabled. No mocked identity or packet digest.

use super::*;
use crate::avm1::function::ExecutionReason;

fn generated(root: &str, key: &str) -> String {
    let mut name = format!("{root}/");
    for unit in key.encode_utf16() { name.push_str(&format!("{unit:04x}")); }
    name
}

fn clip<'gc>(a: &mut Activation<'_, 'gc>, parent: Object<'gc>, name: &str, depth: f64)
    -> Result<Object<'gc>, Error<'gc>> {
    let method = key(a, "createEmptyMovieClip"); let name = key(a, name);
    let value = parent.call_method(method, &[name.into(), depth.into()], a, ExecutionReason::FunctionCall)?;
    Ok(value.as_object(a).expect("original createEmptyMovieClip returns a native clip"))
}

fn remove<'gc>(a: &mut Activation<'_, 'gc>, object: Object<'gc>) -> Result<(), Error<'gc>> {
    object.call_method(key(a, "removeMovieClip"), &[], a, ExecutionReason::FunctionCall)?;
    Ok(())
}

fn compare_v18_fallback<'gc>(root: Value<'gc>, registry: Value<'gc>, a: &mut Activation<'_, 'gc>) -> ResultG<String> {
    let indexed = compare(root, registry, a);
    let prepared = std::mem::take(&mut a.context.avm1.anchor_metadata.index);
    let fallback = packet(root, registry, a);
    a.context.avm1.anchor_metadata.index = prepared;
    assert_eq!(indexed, fallback, "v19 replay must equal the unchanged v18 fresh BFS");
    indexed
}

#[test]
fn native_graph_asset_index_display_both_kinds_preserve_bfs_alias_winners() {
    for reference_first in [false, true] {
        for collisions in [false, true] {
            with_avm(8, |a, root_clip| {
                let roots = std::array::from_fn(|_| bare(a));
                let target = clip(a, root_clip, "assetReplayKinds", 101.0)?;
                let reference = MovieClipReference::try_from_stage_object(a, target).unwrap();
                let first = if reference_first { Value::MovieClip(reference) } else { target.into() };
                let later = if reference_first { target.into() } else { Value::MovieClip(reference) };
                let branch = bare(a);
                put(a, roots[0], "aBranch", branch.into());
                put(a, roots[0], "zFirst", first);
                put(a, roots[1], "aLater", later);
                put(a, branch, "aDeeper", later);
                let world = bare(a); put(a, world, "direct", target.into());
                put(a, world, "reference", Value::MovieClip(reference));
                let registry = rows(a, &bindings(roots)); warm(a, roots, collisions);
                assert_eq!(a.context.avm1.anchor_metadata.index.report().stage_edges, 3);
                let table = Anchors::read(registry, a).unwrap();
                assert!(table.assets.is_some(), "display leaves must use the prepared ordinary topology");
                let winner = generated("asset:player:0", "zFirst");
                assert_eq!(table.atom(target.into(), a).unwrap(), Some(Atom::Anchor(winner.clone(), 3)));
                assert_eq!(table.atom(Value::MovieClip(reference), a).unwrap(), Some(Atom::Anchor(winner.clone(), 64)));
                assert_eq!(table.resolve(&winner, 3).unwrap(), target.into());
                let Value::MovieClip(actual) = table.resolve(&winner, 64).unwrap() else { panic!("reference variant"); };
                assert!(Object::ptr_eq(actual.coerce_to_object(a).unwrap(), target));
                assert!(table.resolve(&generated("asset:player:1", "aLater"), 64).is_err());
                compare_v18_fallback(world.into(), registry, a).unwrap();
                Ok(())
            });
        }
    }
}

#[test]
fn native_graph_asset_index_display_import_rebinds_both_kinds_to_receiving_assets() {
    with_avm(8, |a, root_clip| {
        let host = std::array::from_fn(|_| bare(a)); let guest = std::array::from_fn(|_| bare(a));
        let source = clip(a, root_clip, "assetReplayHost", 102.0)?;
        let target = clip(a, root_clip, "assetReplayGuest", 103.0)?;
        let source_reference = MovieClipReference::try_from_stage_object(a, source).unwrap();
        let target_reference = MovieClipReference::try_from_stage_object(a, target).unwrap();
        put(a, host[0], "clip", Value::MovieClip(source_reference));
        put(a, guest[0], "clip", target.into());
        let world = bare(a); put(a, world, "direct", source.into());
        put(a, world, "reference", Value::MovieClip(source_reference));
        let host_registry = rows(a, &bindings(host)); let guest_registry = rows(a, &bindings(guest));
        warm(a, host, false);
        let expected = compare_v18_fallback(world.into(), host_registry, a).unwrap();
        let global = a.global_object(); let export = key(a, "export");
        let Value::String(wire) = call(a, global, &[export.into(), world.into(), host_registry])? else { panic!("wire"); };
        assert_eq!(wire.to_utf8_lossy(), expected);
        warm(a, guest, false);
        let import = key(a, "import");
        let Value::Object(restored) = call(a, global, &[import.into(), wire.into(), guest_registry])? else { panic!("restored"); };
        assert_eq!(raw(restored, "direct", a), Some(target.into()));
        let Some(Value::MovieClip(reference)) = raw(restored, "reference", a) else { panic!("wire kind64 retained"); };
        assert!(Object::ptr_eq(reference.coerce_to_object(a).unwrap(), target));
        assert!(Object::ptr_eq(target_reference.coerce_to_object(a).unwrap(), target));
        assert_eq!(compare_v18_fallback(restored.into(), guest_registry, a).unwrap(), expected);
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_display_rename_keeps_original_reference_target_semantics() {
    with_avm(8, |a, root_clip| {
        let roots = std::array::from_fn(|_| bare(a));
        let target = clip(a, root_clip, "assetBeforeRename", 104.0)?;
        let reference = MovieClipReference::try_from_stage_object(a, target).unwrap();
        let old_path: Vec<u16> = reference.path().iter().collect();
        put(a, roots[0], "aReference", Value::MovieClip(reference));
        put(a, roots[0], "zDirect", target.into());
        let registry = rows(a, &bindings(roots)); warm(a, roots, false);
        target.set(key(a, "_name"), key(a, "assetAfterRename"), a)?;
        assert!(a.context.avm1.anchor_metadata.index.current().is_some(), "native stage changes do not mutate the owner slot");
        assert_eq!(reference.path().iter().collect::<Vec<_>>(), old_path);
        assert!(Object::ptr_eq(reference.coerce_to_object(a).unwrap(), target));
        let world = bare(a); put(a, world, "reference", Value::MovieClip(reference));
        put(a, world, "direct", target.into());
        compare_v18_fallback(world.into(), registry, a).unwrap();
        assert!(Anchors::read(registry, a).unwrap().assets.is_some());
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_display_remove_recreate_uses_current_original_path_resolution() {
    with_avm(8, |a, root_clip| {
        let roots = std::array::from_fn(|_| bare(a));
        let original = clip(a, root_clip, "assetRecreated", 105.0)?;
        let reference = MovieClipReference::try_from_stage_object(a, original).unwrap();
        put(a, roots[0], "clip", Value::MovieClip(reference));
        let registry = rows(a, &bindings(roots)); warm(a, roots, false);
        remove(a, original)?;
        assert!(a.context.avm1.anchor_metadata.index.current().is_some());
        let missing = compare_v18_fallback(Value::Null, registry, a).unwrap_err();
        assert_eq!(missing, format!("unresolved MovieClip anchor: {}", generated("asset:player:0", "clip")));
        let replacement = clip(a, root_clip, "assetRecreated", 105.0)?;
        assert!(!Object::ptr_eq(original, replacement));
        let world = bare(a); put(a, world, "reference", Value::MovieClip(reference));
        compare_v18_fallback(world.into(), registry, a).unwrap();
        let table = Anchors::read(registry, a).unwrap(); assert!(table.assets.is_some());
        assert_eq!(table.resolve(&generated("asset:player:0", "clip"), 3).unwrap(), replacement.into());
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_display_same_path_conflicts_keep_exact_alias_error_order() {
    for reference_first in [false, true] {
        with_avm(8, |a, root_clip| {
            let roots = std::array::from_fn(|_| bare(a));
            let renamed = clip(a, root_clip, "assetPathConflict", 106.0)?;
            let old_reference = MovieClipReference::try_from_stage_object(a, renamed).unwrap();
            renamed.set(key(a, "_name"), key(a, "assetPathMoved"), a)?;
            let replacement = clip(a, root_clip, "assetPathConflict", 107.0)?;
            let (first, later) = if reference_first { (Value::MovieClip(old_reference), replacement.into()) }
                else { (replacement.into(), Value::MovieClip(old_reference)) };
            put(a, roots[0], "aFirst", first); put(a, roots[0], "zLater", later);
            let registry = rows(a, &bindings(roots)); warm(a, roots, false);
            let result = compare_v18_fallback(Value::Null, registry, a);
            if reference_first {
                assert_eq!(result.unwrap_err(), format!("ambiguous MovieClip anchor path: {}", generated("asset:player:0", "zLater")));
            } else {
                result.unwrap();
                let table = Anchors::read(registry, a).unwrap(); assert!(table.assets.is_some());
                let world = bare(a); put(a, world, "reference", Value::MovieClip(old_reference));
                assert_eq!(compare_v18_fallback(world.into(), registry, a).unwrap_err(),
                    format!("checkpoint MovieClip anchor identity differs: {}", generated("asset:player:0", "aFirst")));
            }
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_explicit_opaque_constructor_wins_and_generated_alias_is_absent() {
    for explicit_first in [false, true] {
        with_avm(8, |a, _| {
            let roots = std::array::from_fn(|_| bare(a)); let child = bare(a);
            let constructor = function(a, forbidden);
            roots[0].define_value(a.gc(), key(a, "__constructor__"), constructor.into(), Attribute::DONT_ENUM);
            child.define_value(a.gc(), key(a, "__constructor__"), constructor.into(), Attribute::DONT_ENUM);
            put(a, roots[0], "child", child.into());
            let mut list = bindings(roots);
            if explicit_first { list.insert(0, ("class:OriginalAsset", constructor.into(), false)); }
            else { list.push(("class:OriginalAsset", constructor.into(), false)); }
            list.push(("class:LaterAlias", constructor.into(), false));
            let registry = rows(a, &list); warm(a, roots, false);
            let table = Anchors::read(registry, a).unwrap(); assert!(table.assets.is_some());
            assert_eq!(table.atom(constructor.into(), a).unwrap(), Some(Atom::Anchor("class:OriginalAsset".into(), 2)));
            assert_eq!(table.resolve("class:LaterAlias", 2).unwrap(), constructor.into());
            let unused = generated("asset:player:0", "__constructor__");
            assert_eq!(table.resolve(&unused, 2).unwrap_err(), format!("missing checkpoint anchor: {unused}"));
            let saved = std::mem::take(&mut a.context.avm1.anchor_metadata.index);
            let fresh = Anchors::read(registry, a).unwrap();
            assert_eq!(fresh.resolve(&unused, 2), table.resolve(&unused, 2));
            a.context.avm1.anchor_metadata.index = saved;
            let world = bare(a); put(a, world, "constructor", constructor.into()); put(a, world, "child", child.into());
            compare_v18_fallback(world.into(), registry, a).unwrap();
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_display_explicit_variants_win_without_generated_aliases() {
    for explicit_reference in [false, true] {
        with_avm(8, |a, root_clip| {
            let roots = std::array::from_fn(|_| bare(a));
            let target = clip(a, root_clip, "assetExplicitStage", 108.0)?;
            let reference = MovieClipReference::try_from_stage_object(a, target).unwrap();
            put(a, roots[0], "direct", target.into()); put(a, roots[0], "reference", Value::MovieClip(reference));
            let mut list = bindings(roots);
            list.push(("surface:existing", if explicit_reference { Value::MovieClip(reference) } else { target.into() }, false));
            let registry = rows(a, &list); warm(a, roots, false);
            let table = Anchors::read(registry, a).unwrap(); assert!(table.assets.is_some());
            for value in [target.into(), Value::MovieClip(reference)] {
                assert_eq!(table.atom(value, a).unwrap(), Some(Atom::Anchor("surface:existing".into(), anchor_kind(value).unwrap())));
            }
            assert!(table.resolve(&generated("asset:player:0", "direct"), 3).is_err());
            compare_v18_fallback(Value::Null, registry, a).unwrap();
            Ok(())
        });
    }
}

#[test]
fn native_graph_asset_index_display_preserves_ordinary_and_namespace_overlap_fallbacks() {
    with_avm(8, |a, root_clip| {
        let roots = std::array::from_fn(|_| bare(a)); let child = bare(a);
        put(a, roots[0], "child", child.into()); put(a, child, "clip", root_clip.into());
        warm(a, roots, false);
        for mode in 0..3 {
            let mut list = bindings(roots);
            match mode {
                0 => list.push(("explicit:child", child.into(), false)),
                1 => list.push(("asset:player:0/custom", function(a, forbidden).into(), false)),
                _ => list.push(("explicit:root", roots[0].into(), false)),
            }
            let registry = rows(a, &list);
            assert!(Anchors::read(registry, a).unwrap().assets.is_none());
            compare_v18_fallback(Value::Null, registry, a).unwrap();
        }
        assert_eq!(a.context.avm1.anchor_metadata.index.report().hits, 0);
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_display_owner_write_invalidates_and_uses_exact_fresh_fallback() {
    with_avm(8, |a, root_clip| {
        let roots = std::array::from_fn(|_| bare(a));
        put(a, roots[0], "clip", root_clip.into());
        let registry = rows(a, &bindings(roots)); warm(a, roots, false);
        assert!(Anchors::read(registry, a).unwrap().assets.is_some());
        let replacement = clip(a, root_clip, "assetOwnerWrite", 109.0)?;
        let reference = MovieClipReference::try_from_stage_object(a, replacement).unwrap();
        put(a, roots[0], "clip", Value::MovieClip(reference));
        assert!(a.context.avm1.anchor_metadata.index.current().is_none());
        assert!(Anchors::read(registry, a).unwrap().assets.is_none());
        compare_v18_fallback(Value::MovieClip(reference), registry, a).unwrap();
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_display_budget_and_alias_path_limits_are_fail_closed() {
    with_avm(8, |a, _| {
        let roots = std::array::from_fn(|_| bare(a));
        let reference = MovieClipReference::from_path(a.gc(), WStr::from_units(b"_level96"));
        for index in 0..=asset_index::MAX_STAGE_EDGES {
            put(a, roots[index / 4096], &format!("clip{index}"), Value::MovieClip(reference));
        }
        let state = prepared(a.gc(), roots, false);
        assert!(state.report().unavailable && state.current().is_none());
        assert_eq!(state.report().reason, "display-edge-limit");
        assert_eq!(state.report().stage_edges, asset_index::MAX_STAGE_EDGES);
        assert!(a.get_level(96).is_none(), "preparation never resolves bounded or rejected display records");
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(roots));
        compare_v18_fallback(Value::Null, registry, a).unwrap();
        assert!(a.get_level(96).is_some());
        let other = std::array::from_fn(|_| bare(a));
        put(a, other[0], &"x".repeat(512), Value::MovieClip(reference));
        let state = prepared(a.gc(), other, false);
        assert_eq!(state.report().reason, "path-limit");
        a.context.avm1.anchor_metadata.index = state;
        let registry = rows(a, &bindings(other));
        assert_eq!(compare_v18_fallback(Value::Null, registry, a).unwrap_err(), "deep anchor path limit exceeded");
        Ok(())
    });
}

#[test]
fn native_graph_asset_index_display_replay_records_do_not_retain_owners_after_gc() {
    let mut arena = Arena::<Rootable![WeakFixture<'_>]>::new(|gc| {
        let roots = std::array::from_fn(|_| Object::new_without_proto(gc));
        let owner = Object::new_without_proto(gc);
        roots[0].define_value(gc, AvmString::new_utf8(gc, "owner"), owner.into(), Attribute::empty());
        let reference = MovieClipReference::from_path(gc, WStr::from_units(b"_level0.assetWeakReplay"));
        owner.define_value(gc, AvmString::new_utf8(gc, "display"), Value::MovieClip(reference), Attribute::empty());
        let state = prepared(gc, roots, false);
        assert!(state.current().is_some()); assert_eq!(state.report().stage_edges, 1);
        WeakFixture { roots: Some(roots), weak: vec![owner.as_weak(), roots[0].as_weak()], state }
    });
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|gc, root| assert!(root.weak.iter().all(|weak| weak.upgrade(gc).is_some())));
    arena.mutate_root(|_, root| root.roots = None);
    arena.finish_cycle(); arena.finish_cycle();
    arena.mutate(|gc, root| {
        assert!(root.weak.iter().all(|weak| weak.upgrade(gc).is_none()), "display replay must own no GC reference");
        assert!(root.state.current().is_none());
    });
}

#[test]
fn native_graph_asset_index_display_loading_snapshot_reports_ready_and_rejection_without_work() {
    with_avm(8, |a, root_clip| {
        let roots = std::array::from_fn(|_| bare(a));
        put(a, roots[0], "clip", root_clip.into()); namespace(a, roots);
        let global = a.global_object(); let prewarm = key(a, "prewarm");
        for _ in 0..asset_index::MAX_CALLS {
            if anchor_metadata::call(a, global, &[prewarm.into()])? == Value::Bool(true) { break; }
        }
        let before = a.context.avm1.anchor_metadata.index.report();
        assert!(before.valid && before.stage_edges == 1);
        let status = key(a, "status");
        let Value::Object(old) = anchor_metadata::call(a, global, &[status.into()])? else { panic!("status"); };
        let Some(Value::Object(snapshot)) = raw(old, "assetIndex", a) else { panic!("index snapshot"); };
        assert_eq!(raw(snapshot, "ready", a), Some(true.into()));
        assert_eq!(raw(snapshot, "displayEdges", a), Some(1.0.into()));
        assert_eq!(raw(snapshot, "reason", a), Some(key(a, "ready").into()));
        assert_eq!(a.context.avm1.anchor_metadata.index.report(), before, "snapshot is a bounded report copy");
        let mut unavailable = asset_index::State::default(); unavailable.exhaust_calls_for_test();
        assert!(unavailable.warm(a.gc(), roots));
        a.context.avm1.anchor_metadata.index = unavailable;
        let Value::Object(rejected) = anchor_metadata::call(a, global, &[status.into()])? else { panic!("status"); };
        let Some(Value::Object(rejected)) = raw(rejected, "assetIndex", a) else { panic!("index snapshot"); };
        assert_eq!(raw(rejected, "ready", a), Some(false.into()));
        assert_eq!(raw(rejected, "reason", a), Some(key(a, "call-limit").into()));
        assert_eq!(raw(snapshot, "ready", a), Some(true.into()), "original saved loading status stays a snapshot");
        Ok(())
    });
}
