//! Full v15 reader oracle: same bytes and errors with optional metadata warm.

use super::*;
use crate::avm1::anchor_metadata::MetadataState;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::test_utils::with_avm;
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
    panic!("raw graph metadata invoked a callback");
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
fn warm<'gc>(a: &Activation<'_, 'gc>, root: Object<'gc>) -> MetadataState<'gc> {
    let mut state = MetadataState::default();
    for _ in 0..64 { if state.warm(a, [root; 6]) { break; } }
    assert!(state.report().completed && !state.report().capped);
    state
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
fn native_graph_anchor_metadata_warm_packets_keep_alias_names_flags_cycles_and_bitmaps() {
    with_avm(8, |a, clip| {
        let asset = bare(a); let shared = bare(a); let array = bare(a);
        array.set_native(a.gc(), NativeObject::Array(()));
        put(a, array, "length", 2.0.into()); put(a, array, "0", shared.into());
        put(a, asset, "z", shared.into()); put(a, asset, "a", shared.into());
        put(a, asset, "array", array.into()); put(a, shared, "cycle", asset.into());
        let wide = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 233, 0xdc00][..]));
        asset.define_value(a.gc(), wide, shared.into(), Attribute::DONT_ENUM | Attribute::VERSION_10);
        for index in 0..128 { put(a, asset, &format!("p{index}"), (index as f64).into()); }
        let method = function(a, forbidden);
        let bindings = rows(a, &[("alias:first", asset.into(), false), ("asset:deep", asset.into(), true),
            ("method", method.into(), false), ("clip", clip.into(), false)]);
        let root = bare(a); put(a, root, "asset", asset.into()); put(a, root, "leaf", shared.into());
        put(a, root, "method", method.into()); put(a, root, "clip", clip.into());
        put(a, root, "self", root.into());
        let pixels = vec![Color::rgba(5, 7, 9, 255), Color::rgba(1, 2, 3, 7)];
        let bitmap = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::BitmapData(BitmapData::new_with_pixels(a.gc(), 2, 1, true, pixels.clone())));
        put(a, root, "bitmap", bitmap.into());
        let before = compare(root.into(), bindings, a).unwrap();
        let state = warm(a, asset);
        assert_eq!(state.report().cached, 3);
        let after = compare(root.into(), bindings, a).unwrap(); assert_eq!(after, before);
        let graph = unpack(key(a, &after)).unwrap();
        let anchors = Anchors::read(bindings, a).unwrap();
        let Value::Object(restored) = import_graph(&graph, &anchors, a).unwrap() else { panic!("root"); };
        assert_eq!(raw(restored, "self", a), Some(restored.into()));
        assert_eq!(raw(restored, "leaf", a), Some(shared.into()));
        let Some(Value::Object(restored_bitmap)) = raw(restored, "bitmap", a) else { panic!("bitmap"); };
        let NativeObject::BitmapData(restored_bitmap) = restored_bitmap.boxhead_graph_native() else { panic!("native bitmap"); };
        assert_eq!(restored_bitmap.sync(a.context.renderer).borrow().pixels(), pixels);
        assert_eq!(compare(restored.into(), bindings, a).unwrap(), before);
        Ok(())
    });
}

#[test]
fn native_graph_anchor_metadata_child_mutation_rechecks_kinds_descriptors_and_interfaces() {
    with_avm(8, |a, clip| {
        let parent = bare(a); let child = bare(a); put(a, parent, "child", child.into());
        let bindings = rows(a, &[("asset", parent.into(), true)]);
        let root = bare(a); put(a, root, "leaf", child.into());
        let state = warm(a, parent); let before = compare(root.into(), bindings, a).unwrap();
        // Parent remains valid: it caches only the raw child pointer. The
        // child's new native payload must be classified in this actual read.
        child.set_native(a.gc(), NativeObject::Array(()));
        put(a, child, "length", 0.0.into());
        assert_ne!(compare(root.into(), bindings, a).unwrap(), before);
        assert!(state.report().bytes > 0);
        let mut parent_edges = Vec::new();
        assert_eq!(parent.boxhead_graph_anchor_edges_cached_into(&mut parent_edges), Ok(1));
        assert_eq!(parent_edges[0].1, child.into());
        let callback = function(a, forbidden);
        child.add_property(a.gc(), key(a, "bad"), callback, None, Attribute::DONT_ENUM);
        assert!(compare(root.into(), bindings, a).unwrap_err().contains("object has a virtual own property"));
        child.delete(a, key(a, "bad"));
        warm(a, child);
        child.watch(a, key(a, "absent"), callback, Value::Undefined);
        assert!(compare(root.into(), bindings, a).unwrap_err().contains("object has watchers"));
        child.unwatch(a, key(a, "absent")); warm(a, child);
        child.set_interfaces(a.gc(), vec![clip]);
        assert!(compare(root.into(), bindings, a).unwrap_err().contains("object has per-instance interface metadata"));
        Ok(())
    });
}

#[test]
fn native_graph_anchor_metadata_hits_keep_raw_field_path_and_timeout_limits() {
    with_avm(8, |a, _| {
        let asset = bare(a); let child = bare(a);
        for index in 0..8191 {
            asset.define_value(a.gc(), key(a, &format!("hidden{index}")), (index as f64).into(), Attribute::DONT_ENUM | Attribute::VERSION_10);
        }
        put(a, asset, "edge", child.into());
        let state = warm(a, asset); assert_eq!(state.report().properties, 8192);
        let mut fields = Vec::new();
        let count = asset.boxhead_graph_anchor_edges_cached_into(&mut fields).unwrap();
        assert_eq!(count, 8192); assert_eq!(fields.len(), 1);
        for previous in [MAX_FIELDS * 4 - count, MAX_FIELDS * 4 - count + 1, usize::MAX] {
            assert_eq!(deep_field_total(previous, count), frozen_v15::total(previous, count));
        }
        assert!(deep_field_total(MAX_FIELDS * 4 - count + 1, count).is_err());
        let bindings = rows(a, &[(&"x".repeat(2048), asset.into(), true)]);
        assert_eq!(compare(child.into(), bindings, a).unwrap_err(), "deep anchor path limit exceeded");
        let bindings = rows(a, &[("asset", asset.into(), true)]);
        compare(child.into(), bindings, a).unwrap();
        let duration = a.context.max_execution_duration;
        a.context.max_execution_duration = Duration::ZERO;
        assert_eq!(compare(child.into(), bindings, a).unwrap_err(), "native graph execution timeout");
        a.context.max_execution_duration = duration;
        Ok(())
    });
}

#[test]
fn native_graph_anchor_metadata_keeps_movieclip_path_resolution_and_explicit_alias_precedence() {
    with_avm(8, |a, _| {
        let asset = bare(a); let leaf = bare(a); put(a, asset, "leaf", leaf.into());
        let reference = MovieClipReference::from_path(a.gc(), WStr::from_units(b"_level97"));
        put(a, asset, "clip", Value::MovieClip(reference));
        let state = warm(a, asset); assert_eq!(state.report().cached, 2);
        assert!(a.get_level(97).is_none());
        let bindings = rows(a, &[("leaf:explicit", leaf.into(), false), ("asset:alias", asset.into(), false),
            ("asset:deep", asset.into(), true)]);
        let root = bare(a); put(a, root, "leaf", leaf.into()); put(a, root, "clip", Value::MovieClip(reference));
        let encoded = compare(root.into(), bindings, a).unwrap();
        assert!(a.get_level(97).is_some(), "only the original graph read resolves stage variants");
        let graph = unpack(key(a, &encoded)).unwrap();
        assert!(graph.nodes[0].fields.iter().any(|field| field.value == Atom::Anchor("leaf:explicit".into(), 0)));
        put(a, asset, "leaf", bare(a).into());
        assert_eq!(compare(root.into(), bindings, a).unwrap(), encoded,
            "explicit binding remains the winner after another asset edge changes");
        Ok(())
    });
}
