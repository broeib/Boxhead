//! Independent comparisons with the complete sealed v13 graph implementation.
//! These fixtures do not replace any of the existing 37 graph/v6/v4 tests.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::object::{BoxedF64, super_object::SuperObject};
use crate::avm1::test_utils::with_avm;
use std::time::Duration;

#[path = "frozen_v13.rs"]
mod frozen_v13;

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
    panic!("raw anchor classification or insertion invoked an AVM callback")
}

fn registry<'gc>(a: &Activation<'_, 'gc>, rows: &[(&str, Value<'gc>, bool)]) -> Object<'gc> {
    let array = bare(a);
    array.set_native(a.gc(), NativeObject::Array(()));
    field(a, array, "length", (rows.len() as f64).into());
    for (index, (id, value, deep)) in rows.iter().enumerate() {
        let row = bare(a);
        field(a, row, "id", text(a, id).into()); field(a, row, "value", *value);
        field(a, row, "deep", (*deep).into()); field(a, array, &index.to_string(), row.into());
    }
    array
}

fn current_table<'gc>(rows: Value<'gc>, a: &mut Activation<'_, 'gc>, collisions: bool) -> ResultG<Anchors<'gc>> {
    let mut table = Anchors::empty();
    if collisions { table.name_bucket_mask = 0; }
    Anchors::read_into(rows, a, table)
}

fn current_packet<'gc>(root: Value<'gc>, rows: Value<'gc>, a: &mut Activation<'_, 'gc>, collisions: bool) -> ResultG<String> {
    let table = current_table(rows, a, collisions)?;
    pack(&export_graph(root, &table, a)?)
}

fn insertion<'gc>(table: &mut Anchors<'gc>, id: &str, value: Value<'gc>) -> ResultG<(String, bool)> {
    table.insert(AnchorName::Explicit(Rc::from(id)), value).map(|(id, fresh)| (table.materialize(id), fresh))
}

#[test]
fn native_graph_inline_classification_matches_frozen_v13_values_and_errors() {
    with_avm(8, |a, clip| {
        let ordinary = bare(a);
        let array = Object::new_with_native(&a.context.strings, None::<Value<'_>>, NativeObject::Array(()));
        let method = function(a, forbidden);
        ordinary.add_property(a.gc(), text(a, "trap"), method, Some(method), Attribute::DONT_ENUM);
        let bitmap = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::BitmapData(BitmapData::new(a.gc(), 1, 1, true, 0)));
        let boolean = Object::new_with_native(&a.context.strings, None::<Value<'_>>, NativeObject::Bool(true));
        let number = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::Number(BoxedF64::new(a.gc(), -0.0)));
        let string = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::String(text(a, "boxed")));
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        for (value, expected) in [(ordinary.into(), 0), (array.into(), 1), (method.into(), 2),
            (clip.into(), 3), (bitmap.into(), 7), (boolean.into(), 8), (number.into(), 9),
            (string.into(), 10), (Value::MovieClip(reference), 64)] {
            assert_eq!(anchor_kind(value), Ok(expected));
            assert_eq!(anchor_kind(value), frozen_v13::kind(value));
        }
        for value in [Value::Undefined, Value::Null, Value::Bool(false), Value::Number(f64::NAN), text(a, "plain").into()] {
            assert_eq!(anchor_kind(value), frozen_v13::kind(value));
            assert_eq!(anchor_kind(value).unwrap_err(), "anchor value must be an object, function or MovieClip reference");
        }
        let super_object = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::Super(SuperObject::new(ordinary, 1)));
        assert_eq!(anchor_kind(super_object.into()), frozen_v13::kind(super_object.into()));
        assert_eq!(anchor_kind(super_object.into()).unwrap_err(), "super objects cannot be anchors");
        Ok(())
    });
}

#[test]
fn native_graph_inline_entries_match_frozen_v13_resizes_aliases_and_collisions() {
    with_avm(8, |a, _| {
        let value: Value<'_> = bare(a).into(); let other: Value<'_> = bare(a).into();
        for collisions in [false, true] {
            let mut current = Anchors::empty();
            if collisions { current.name_bucket_mask = 0; }
            let mut old = frozen_v13::Table::new(collisions);
            for index in 0..513 {
                let id = format!("name:{index}:0061");
                assert_eq!(insertion(&mut current, &id, value), old.insert(&id, value));
            }
            for (id, target) in [("name:0:0061", value), ("name:512:0061", value),
                ("name:3:0061", other), ("name:3:0061", Value::Null), ("new", other)] {
                assert_eq!(insertion(&mut current, id, target), old.insert(id, target));
                assert_eq!(current.values.len(), old.len());
                assert_eq!(current.name_buckets.len(), old.bucket_count());
            }
            assert_eq!(current.values.len(), 514);
            assert_eq!(current.name_buckets.len(), if collisions { 1 } else { 514 });
            assert_eq!(current.materialize(*current.names.get(&identity(value).unwrap()).unwrap()), "name:0:0061");
        }
        Ok(())
    });
}

#[test]
fn native_graph_inline_packet_and_receiving_aliases_match_frozen_v13() {
    with_avm(8, |a, clip| {
        let host = bare(a); let host_leaf = bare(a); let guest = bare(a); let guest_leaf = bare(a);
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        let method = function(a, forbidden);
        let key = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 0xffff][..]));
        for (asset, leaf, reverse) in [(host, host_leaf, false), (guest, guest_leaf, true)] {
            let names = if reverse { ["z", "a"] } else { ["a", "z"] };
            for name in names { field(a, asset, name, leaf.into()); }
            leaf.define_value(a.gc(), key, asset.into(), Attribute::DONT_ENUM | Attribute::VERSION_10);
            field(a, asset, "opaque", method.into());
        }
        let host_rows = registry(a, &[("canonical", host.into(), false), ("expanded", host.into(), true),
            ("later", host.into(), true), ("clip", Value::MovieClip(reference), false)]);
        let guest_rows = registry(a, &[("canonical", guest.into(), false), ("expanded", guest.into(), true),
            ("later", guest.into(), true), ("clip", clip.into(), false)]);
        let root = bare(a); field(a, root, "asset", host_leaf.into()); field(a, root, "clip", clip.into());
        field(a, root, "reference", Value::MovieClip(reference)); field(a, root, "bits", (-0.0_f64).into());
        let bitmap = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::BitmapData(BitmapData::new_with_pixels(a.gc(), 2, 1, true,
                vec![Color::rgba(7, 13, 29, 255), Color::rgba(1, 2, 3, 7)])));
        field(a, root, "pixels", bitmap.into());
        for collisions in [false, true] {
            let packet = current_packet(root.into(), host_rows.into(), a, collisions).unwrap();
            assert_eq!(packet, frozen_v13::packet(root.into(), host_rows.into(), a, collisions).unwrap());
            let graph = unpack(text(a, &packet)).unwrap();
            let table = current_table(guest_rows.into(), a, collisions).unwrap();
            let restored = import_graph(&graph, &table, a).unwrap();
            assert_eq!(pack(&export_graph(restored, &table, a).unwrap()).unwrap(), packet);
            let (old_restored, old_packet) = frozen_v13::roundtrip(text(a, &packet), guest_rows.into(), a).unwrap();
            assert_eq!(old_packet, packet);
            for value in [restored, old_restored] {
                let Value::Object(object) = value else { panic!("restored root") };
                assert_eq!(raw(object, "asset", a), Some(guest_leaf.into()));
                assert_eq!(raw(object, "clip", a), Some(clip.into()));
                let Some(Value::MovieClip(actual)) = raw(object, "reference", a) else { panic!("MovieClip value kind") };
                assert!(Object::ptr_eq(actual.coerce_to_object(a).unwrap(), clip));
            }
        }
        Ok(())
    });
}

#[test]
fn native_graph_inline_capacity_preserves_duplicate_errors_without_reservation() {
    with_avm(8, |a, _| {
        let value: Value<'_> = bare(a).into(); let other: Value<'_> = bare(a).into();
        let mut current = Anchors::empty(); let mut old = frozen_v13::Table::new(false);
        for index in 0..MAX_ANCHORS {
            let id = index.to_string();
            assert_eq!(insertion(&mut current, &id, value), old.insert(&id, value));
        }
        let capacity = current.name_buckets.capacity(); let old_capacity = old.bucket_capacity();
        for (id, target, error) in [("0", value, None),
            ("0", other, Some("anchor ID points to different objects: 0")),
            ("new", value, Some("anchor count limit exceeded")),
            ("new", Value::Null, Some("anchor has a primitive value"))] {
            let actual = insertion(&mut current, id, target);
            assert_eq!(actual, old.insert(id, target));
            assert_eq!(actual.err().as_deref(), error);
            assert_eq!(current.values.len(), MAX_ANCHORS); assert_eq!(old.len(), MAX_ANCHORS);
            assert_eq!(current.name_buckets.capacity(), capacity); assert_eq!(old.bucket_capacity(), old_capacity);
        }
        Ok(())
    });
}

#[test]
fn native_graph_inline_repeated_observations_read_new_native_kinds() {
    with_avm(8, |a, _| {
        let value = bare(a); let child = bare(a); field(a, value, "child", child.into());
        let rows = registry(a, &[("root", value.into(), true)]);
        let root = bare(a); field(a, root, "same", value.into());
        let before = current_packet(root.into(), rows.into(), a, false).unwrap();
        assert_eq!(before, frozen_v13::packet(root.into(), rows.into(), a, false).unwrap());
        assert_eq!(anchor_kind(value.into()), Ok(0));
        value.set_native(a.gc(), NativeObject::Array(())); field(a, value, "length", 3.0.into());
        assert_eq!(anchor_kind(value.into()), Ok(1));
        assert_eq!(anchor_kind(value.into()), frozen_v13::kind(value.into()));
        let after = current_packet(root.into(), rows.into(), a, false).unwrap();
        assert_eq!(after, frozen_v13::packet(root.into(), rows.into(), a, false).unwrap());
        assert_ne!(before, after, "an anchored Object becoming an Array changes its actual wire kind");
        let mut current = Anchors::empty(); let mut old = frozen_v13::Table::new(false);
        let boxed = bare(a);
        assert_eq!(insertion(&mut current, "kind", boxed.into()), old.insert("kind", boxed.into()));
        boxed.set_native(a.gc(), NativeObject::Bool(false));
        assert_eq!(anchor_kind(boxed.into()), Ok(8));
        assert_eq!(insertion(&mut current, "kind", boxed.into()), old.insert("kind", boxed.into()));
        Ok(())
    });
}

#[test]
fn native_graph_inline_rejection_and_timeout_order_match_frozen_v13() {
    with_avm(8, |a, _| {
        let asset = bare(a); let child = bare(a); field(a, asset, "a", child.into());
        let conflicting = bare(a); let callback = function(a, forbidden);
        let virtual_asset = bare(a);
        virtual_asset.add_property(a.gc(), text(a, "__proto__"), callback, Some(callback), Attribute::DONT_ENUM);
        let super_object = Object::new_with_native(&a.context.strings, None::<Value<'_>>,
            NativeObject::Super(SuperObject::new(asset, 1)));
        let long = "x".repeat(2044);
        let cases = [Value::Null,
            registry(a, &[("bad", Value::Null, true)]).into(),
            registry(a, &[("super", super_object.into(), true)]).into(),
            registry(a, &[("asset", asset.into(), true), ("asset/0061", conflicting.into(), false)]).into(),
            registry(a, &[("known", child.into(), true), (&long, asset.into(), true)]).into(),
            registry(a, &[(&long, virtual_asset.into(), true)]).into()];
        let virtual_error = format!("deep anchor {long}: object has a virtual own property");
        let expected = ["anchors must be an Array", "anchor has a primitive value", "super objects cannot be anchors",
            "anchor ID points to different objects: asset/0061", "deep anchor path limit exceeded",
            virtual_error.as_str()];
        for collisions in [false, true] {
            for (rows, message) in cases.into_iter().zip(expected) {
                let current = current_table(rows, a, collisions).err();
                assert_eq!(current, frozen_v13::read_error(rows, a, collisions));
                assert_eq!(current.as_deref(), Some(message));
            }
        }
        let empty = registry(a, &[]); let duration = a.context.max_execution_duration;
        a.context.max_execution_duration = Duration::ZERO;
        assert_eq!(check_time(a), frozen_v13::time(a));
        assert_eq!(check_time(a).unwrap_err(), "native graph execution timeout");
        for rows in [empty.into(), cases[1], cases[4], Value::Null] {
            assert_eq!(current_table(rows, a, false).err(), frozen_v13::read_error(rows, a, false));
        }
        a.context.max_execution_duration = duration;
        Ok(())
    });
}
