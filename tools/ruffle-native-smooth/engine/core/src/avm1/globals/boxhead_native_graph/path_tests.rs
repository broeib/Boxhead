//! Full predecessor comparisons for deferred diagnostic-path formatting.
//! The previous 43 graph fixtures and all their bodies remain unchanged.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::object::super_object::SuperObject;
use crate::avm1::test_utils::with_avm;
use std::time::Duration;

#[path = "frozen_v14.rs"]
mod frozen_v14;

fn text<'gc>(a: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> {
    AvmString::new_utf8(a.gc(), value)
}

fn bare<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> { Object::new_without_proto(a.gc()) }

fn field<'gc>(a: &Activation<'_, 'gc>, object: Object<'gc>, key: &str, value: Value<'gc>) {
    object.define_value(a.gc(), text(a, key), value, Attribute::empty());
}

fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&a.context.strings, None, None)
}

fn forbidden<'gc>(_: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    panic!("diagnostic formatting invoked an AVM callback")
}

fn registry<'gc>(a: &Activation<'_, 'gc>, entries: &[(&str, Value<'gc>, bool)]) -> Object<'gc> {
    let array = bare(a);
    array.set_native(a.gc(), NativeObject::Array(()));
    field(a, array, "length", (entries.len() as f64).into());
    for (index, (id, value, deep)) in entries.iter().enumerate() {
        let row = bare(a);
        field(a, row, "id", text(a, id).into()); field(a, row, "value", *value);
        field(a, row, "deep", (*deep).into()); field(a, array, &index.to_string(), row.into());
    }
    array
}

fn packet<'gc>(root: Value<'gc>, rows: Value<'gc>, a: &mut Activation<'_, 'gc>) -> ResultG<String> {
    let anchors = Anchors::read(rows, a)?;
    pack(&export_graph(root, &anchors, a)?)
}

fn compared_packet<'gc>(root: Value<'gc>, rows: Value<'gc>, a: &mut Activation<'_, 'gc>) -> ResultG<String> {
    let current = packet(root, rows, a);
    let previous = frozen_v14::packet(root, rows, a);
    assert_eq!(current, previous, "complete compressed packet or exact rejection differs");
    current
}

#[test]
fn native_graph_lazy_paths_keep_mixed_packets_aliases_and_receiving_bitmaps() {
    with_avm(8, |a, clip| {
        let asset = bare(a); let leaf = bare(a); field(a, asset, "leaf", leaf.into());
        let method = function(a, forbidden);
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        let rows = registry(a, &[("asset", asset.into(), true), ("method", method.into(), false),
            ("clip", Value::MovieClip(reference), false)]);
        let root = bare(a); let shared = bare(a); let array = bare(a);
        array.set_native(a.gc(), NativeObject::Array(()));
        field(a, array, "length", 5.0.into()); field(a, array, "3", root.into());
        field(a, root, "self", root.into()); field(a, root, "shared", shared.into());
        field(a, root, "alias", shared.into()); field(a, root, "array", array.into());
        field(a, root, "asset", leaf.into()); field(a, root, "method", method.into());
        field(a, root, "reference", Value::MovieClip(reference)); field(a, root, "direct", clip.into());
        let key = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 0xffff, 0xd83d, 0xde00][..]));
        shared.define_value(a.gc(), key, (-0.0_f64).into(), Attribute::DONT_ENUM | Attribute::READ_ONLY | Attribute::VERSION_10);
        let bits = [0x7ff8_0000_0000_0001_u64, 0xfff0_0000_0000_0000, 0x0000_0000_0000_0001];
        for (index, value) in bits.into_iter().enumerate() {
            field(a, shared, &format!("bits{index}"), f64::from_bits(value).into());
        }
        // Most fields deliberately need neither a new graph node nor an error
        // path. Their UTF16 values, key order and flags must still be encoded.
        for index in 0..512 {
            field(a, shared, &format!("primitive:{index:04}:long-key"), (index as f64).into());
        }
        let pixels = vec![Color::rgba(7, 13, 29, 255), Color::rgba(1, 2, 3, 7)];
        let bitmap = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::BitmapData(BitmapData::new_with_pixels(a.gc(), 2, 1, true, pixels.clone())));
        field(a, root, "pixels", bitmap.into());
        let encoded = compared_packet(root.into(), rows.into(), a).unwrap();
        let graph = unpack(text(a, &encoded)).unwrap();
        assert_eq!(graph.nodes.len(), 4);
        let anchors = Anchors::read(rows.into(), a).unwrap();
        let restored = import_graph(&graph, &anchors, a).unwrap();
        let (prior_restored, prior_encoded) = frozen_v14::roundtrip(text(a, &encoded), rows.into(), a).unwrap();
        assert_eq!(prior_encoded, encoded);
        for value in [restored, prior_restored] {
            let Value::Object(object) = value else { panic!("restored root") };
            assert_eq!(raw(object, "self", a), Some(value));
            assert_eq!(raw(object, "shared", a), raw(object, "alias", a));
            assert_eq!(raw(object, "asset", a), Some(leaf.into()));
            assert_eq!(raw(object, "direct", a), Some(clip.into()));
            let Some(Value::MovieClip(actual)) = raw(object, "reference", a) else { panic!("reference kind") };
            assert!(Object::ptr_eq(actual.coerce_to_object(a).unwrap(), clip));
            let Some(Value::Object(actual)) = raw(object, "pixels", a) else { panic!("bitmap object") };
            let NativeObject::BitmapData(actual) = actual.boxhead_graph_native() else { panic!("bitmap kind") };
            assert_eq!(actual.sync(a.context.renderer).borrow().pixels(), pixels);
            assert_eq!(compared_packet(value, rows.into(), a).unwrap(), encoded);
        }
        Ok(())
    });
}

#[test]
fn native_graph_lazy_paths_keep_utf8_error_text_and_exact_2048_reset() {
    with_avm(8, |a, _| {
        let rows = registry(a, &[]); let method = function(a, forbidden);
        for length in [2043_usize, 2044] {
            let root = bare(a); let child = bare(a); let key = "x".repeat(length);
            field(a, root, &key, child.into()); field(a, child, "bad", method.into());
            let expected_path = if length == 2043 { format!("root.{key}.bad") } else { "node[1].bad".into() };
            assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
                format!("unbound function/native object at {expected_path}, kind 2"));
        }
        let root = bare(a); let middle = bare(a); let last = bare(a);
        field(a, root, &"x".repeat(2043), middle.into()); field(a, middle, "y", last.into());
        field(a, last, "bad", method.into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "unbound function/native object at node[2].bad, kind 2");
        let root = bare(a); let child = bare(a);
        let key = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 97, 0xdc00, 0xd83d, 0xde00, 0, 233][..]));
        root.define_value(a.gc(), key, child.into(), Attribute::empty());
        field(a, child, "bad", method.into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "unbound function/native object at root.\u{fffd}a\u{fffd}\u{1f600}\0\u{e9}.bad, kind 2");
        // The reset tests above use ASCII lengths; this additionally verifies
        // that the saved parent's limit is UTF8 bytes, not UTF16 key length.
        let root = bare(a); let child = bare(a);
        field(a, root, &("x".repeat(2042) + "\u{e9}"), child.into());
        field(a, child, "bad", method.into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "unbound function/native object at node[1].bad, kind 2");
        Ok(())
    });
}

#[test]
fn native_graph_lazy_paths_keep_descriptor_prototype_and_native_error_order() {
    with_avm(8, |a, clip| {
        let rows = registry(a, &[]); let method = function(a, forbidden);
        let root = bare(a); let prototype = bare(a);
        field(a, root, "__proto__", prototype.into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(), "unbound prototype at root.__proto__");
        field(a, root, "__proto__", method.into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "unbound function/native object at root.__proto__, kind 2");
        let root = bare(a); let child = bare(a); field(a, root, "child", child.into());
        field(a, child, "unsupported", method.into());
        child.add_property(a.gc(), text(a, "hidden"), method, Some(method), Attribute::DONT_ENUM);
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "root.child: object has a virtual own property");
        let root = bare(a);
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        field(a, root, "clip", Value::MovieClip(reference));
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "unbound MovieClip reference at root.clip");
        let super_object = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::Super(SuperObject::new(bare(a), 1)));
        field(a, root, "clip", super_object.into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(), "super objects cannot be anchors");
        Ok(())
    });
}

#[test]
fn native_graph_lazy_paths_keep_fresh_values_string_limit_and_timeout() {
    with_avm(8, |a, _| {
        let rows = registry(a, &[]); let root = bare(a); let child = bare(a);
        field(a, root, "child", child.into()); field(a, child, "value", 1.0.into());
        let first = compared_packet(root.into(), rows.into(), a).unwrap();
        field(a, child, "value", 2.0.into());
        assert_ne!(compared_packet(root.into(), rows.into(), a).unwrap(), first);
        let too_long = "x".repeat(MAX_STRING + 1);
        field(a, child, "value", text(a, &too_long).into());
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(), "oversized string at root.child.value");
        let duration = a.context.max_execution_duration;
        a.context.max_execution_duration = Duration::ZERO;
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(), "native graph execution timeout");
        a.context.max_execution_duration = duration;
        // The same parent/key must see the freshly replaced native payload.
        let native = function(a, forbidden).boxhead_graph_native();
        child.set_native(a.gc(), native);
        assert_eq!(compared_packet(root.into(), rows.into(), a).unwrap_err(),
            "unbound function/native object at root.child, kind 2");
        Ok(())
    });
}
