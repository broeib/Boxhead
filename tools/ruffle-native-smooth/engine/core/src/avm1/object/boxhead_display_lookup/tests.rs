//! Fresh native/display lookup compared with the frozen v14 prototype walk.
//! The oracle uses the unchanged raw helper and original getter/local fallback;
//! it never calls boxhead_lookup_property.

use super::*;
use crate::avm1::function::NativeFunction;
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::string::WStr;
use crate::tag_utils::{SwfMovie, SwfSlice};
use std::sync::Arc;

#[path = "frozen_v14.rs"]
mod frozen_v14;

fn key<'gc>(a: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(a.gc(), text)
}

fn bare<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> {
    Object::new_without_proto(a.gc())
}

fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&a.context.strings, None, None)
}

fn put<'gc>(a: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(a.gc(), key(a, name), value, Attribute::empty());
}

fn raw<'gc>(a: &mut Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Value<'gc> {
    object.get_data(key(a, name), a).unwrap_or(Value::Undefined)
}

fn reset(a: &Activation<'_, '_>) {
    let global = a.global_object();
    put(a, global, "lookupCalls", 0.0.into());
    put(a, global, "lookupThis", Value::Undefined);
    put(a, global, "lookupArgument", Value::Undefined);
}

fn record<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, argument: Value<'gc>) {
    let global = a.global_object();
    let Value::Number(count) = raw(a, global, "lookupCalls") else { panic!("trace initialized"); };
    put(a, global, "lookupCalls", (count + 1.0).into());
    put(a, global, "lookupThis", this.into());
    put(a, global, "lookupArgument", argument);
}

fn calls(a: &mut Activation<'_, '_>) -> f64 {
    let global = a.global_object();
    let Value::Number(count) = raw(a, global, "lookupCalls") else { panic!("trace initialized"); };
    count
}

fn undefined_getter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(a, this, Value::Undefined);
    Ok(Value::Undefined)
}

fn throwing_getter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(a, this, Value::Undefined);
    Err(Error::ThrownValue(key(a, "display-lookup-sentinel").into()))
}

fn ignored_error_getter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(a, this, Value::Undefined);
    Err(Error::ExecutionTimeout)
}

fn replacing_getter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(a, this, Value::Undefined);
    put(a, this, "value", 37.0.into());
    Err(Error::PropertyRecursionLimit)
}

fn reparenting_getter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(a, this, Value::Undefined);
    let replacement = raw(a, this, "replacement");
    this.delete(a, key(a, "value"));
    this.set_data(key(a, "__proto__"), replacement, a)?;
    Err(Error::PropertyRecursionLimit)
}

fn reentrant_getter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(a, this, Value::Undefined);
    let before = this.get(key(a, "other"), a)?;
    put(a, this, "other", 99.0.into());
    this.set_native(a.gc(), NativeObject::Bool(true));
    Ok(before)
}

fn resolver<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    assert_eq!(args.len(), 1);
    record(a, this, args[0]);
    Ok(91.0.into())
}

fn value_bits<'gc>(actual: Value<'gc>, expected: Value<'gc>) {
    match (actual, expected) {
        (Value::Number(actual), Value::Number(expected)) => assert_eq!(actual.to_bits(), expected.to_bits()),
        _ => assert_eq!(actual, expected),
    }
}

fn result_eq<'gc>(actual: &Result<Option<(Value<'gc>, u8)>, Error<'gc>>, expected: &Result<Option<(Value<'gc>, u8)>, Error<'gc>>) {
    match (actual, expected) {
        (Ok(Some((actual, depth))), Ok(Some((expected, old_depth)))) => {
            value_bits(*actual, *expected); assert_eq!(depth, old_depth);
        }
        (Ok(None), Ok(None)) => {},
        (Err(Error::ThrownValue(actual)), Err(Error::ThrownValue(expected))) => value_bits(*actual, *expected),
        (Err(actual), Err(expected)) => {
            assert_eq!(std::mem::discriminant(actual), std::mem::discriminant(expected));
            assert_eq!(actual.to_string(), expected.to_string());
        }
        _ => panic!("native lookup differs: {actual:?} versus {expected:?}"),
    }
}

fn read<'gc>(a: &mut Activation<'_, 'gc>, object: Object<'gc>, name: AvmString<'gc>, resolve: bool, optimized: bool)
    -> Result<Option<(Value<'gc>, u8)>, Error<'gc>> {
    if optimized { search_prototype(object.into(), name, a, object, resolve) }
    else { frozen_v14::search_prototype(object.into(), name, a, object, resolve) }
}

fn compare<'gc>(a: &mut Activation<'_, 'gc>, object: Object<'gc>, name: AvmString<'gc>, resolve: bool)
    -> Result<Option<(Value<'gc>, u8)>, Error<'gc>> {
    let expected = read(a, object, name, resolve, false);
    let actual = read(a, object, name, resolve, true);
    result_eq(&actual, &expected);
    actual
}

fn child<'gc>(a: &mut Activation<'_, 'gc>, parent: Object<'gc>, name: &str, depth: f64) -> Result<Object<'gc>, Error<'gc>> {
    let method = key(a, "createEmptyMovieClip");
    let name = key(a, name);
    let value = parent.call_method(method, &[name.into(), depth.into()], a, ExecutionReason::FunctionCall)?;
    Ok(value.as_object(a).expect("actual createEmptyMovieClip returns a stage object"))
}

#[test]
fn display_lookup_native_data_values_flags_and_identity_match_frozen_reads() {
    with_avm(8, |a, root| {
        reset(a);
        let callback = function(a, throwing_getter);
        let payloads = [NativeObject::None, NativeObject::Array(()), callback.native(),
            NativeObject::Bool(true), NativeObject::Number(BoxedF64::new(a.gc(), -0.0)),
            NativeObject::String(key(a, "boxed")),
            NativeObject::BitmapData(BitmapData::new(a.gc(), 1, 1, true, 0))];
        let mut objects = vec![root];
        objects.extend(payloads.into_iter().map(|native| Object::new_with_native(&a.context.strings, None::<Value<'_>>, native)));
        let name = key(a, "payload");
        for object in objects {
            for value in [Value::Undefined, Value::Null, Value::Bool(false), Value::Number(-0.0),
                Value::Number(f64::from_bits(0x7ff8_1234_5678_9abc)), key(a, "value").into(), callback.into()] {
                object.define_value(a.gc(), name, value, Attribute::DONT_ENUM | Attribute::READ_ONLY);
                let (actual, depth) = compare(a, object, name, true)?.expect("stored own slot");
                value_bits(actual, value); assert_eq!(depth, 0);
                let BoxheadLookupProperty::Resolved(actual) = object.boxhead_lookup_property(name, a) else { panic!("native data resolved"); };
                value_bits(actual, value);
            }
        }
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_raw_code_identity_helper_remains_side_effect_free_and_native_excluding() {
    with_avm(8, |a, root| {
        reset(a);
        let name = key(a, "_x");
        root.add_property(a.gc(), name, function(a, throwing_getter), None, Attribute::empty());
        let boxed = Object::new_with_native(&a.context.strings, None::<Value<'_>>, NativeObject::Bool(true));
        put(a, boxed, "_x", 7.0.into());
        for object in [root, boxed] {
            assert!(matches!(object.boxhead_own_property(name, a), BoxheadOwnProperty::Special));
        }
        assert!(matches!(root.boxhead_lookup_property(name, a), BoxheadLookupProperty::Slow));
        assert!(matches!(boxed.boxhead_lookup_property(name, a), BoxheadLookupProperty::Resolved(Value::Number(7.0))));
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_stored_undefined_shadows_magic_properties_and_parent_getters() {
    with_avm(8, |a, root| {
        reset(a);
        let proto = bare(a);
        for text in ["_x", "_root", "absent"] {
            let name = key(a, text);
            proto.add_property(a.gc(), name, function(a, throwing_getter), None, Attribute::empty());
            root.define_value(a.gc(), name, Value::Undefined, Attribute::empty());
        }
        put(a, proto, "__resolve", function(a, throwing_getter).into());
        put(a, root, "__proto__", proto.into());
        for text in ["_x", "_root", "absent"] {
            assert_eq!(compare(a, root, key(a, text), true)?, Some((Value::Undefined, 0)));
        }
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_version_hidden_data_and_virtual_slots_keep_native_fallback() {
    for version in [5, 6, 7, 8, 9, 10] {
        with_avm(version, |a, root| {
            reset(a);
            for virtual_slot in [false, true] {
                let name = key(a, "_x");
                root.delete(a, name);
                if virtual_slot {
                    root.add_property(a.gc(), name, function(a, undefined_getter), None, Attribute::VERSION_10);
                } else {
                    root.define_value(a.gc(), name, 37.0.into(), Attribute::VERSION_10);
                }
                let result = compare(a, root, name, true)?;
                if version < 10 { assert_eq!(result, Some((0.0.into(), 0))); assert_eq!(calls(a), 0.0); }
                else if virtual_slot { assert_eq!(result, Some((Value::Undefined, 0))); assert_eq!(calls(a), 2.0); }
                else { assert_eq!(result, Some((37.0.into(), 0))); }
            }
            Ok(())
        });
    }
}

#[test]
fn display_lookup_child_precedence_and_hidden_own_shadowing_match_stage_order() {
    with_avm(8, |a, root| {
        reset(a);
        let child = child(a, root, "target", 1.0)?;
        let name = key(a, "target");
        let proto = bare(a);
        proto.add_property(a.gc(), name, function(a, throwing_getter), None, Attribute::empty());
        put(a, root, "__proto__", proto.into());
        assert_eq!(compare(a, root, name, true)?, Some((child.into(), 0)));
        root.define_value(a.gc(), name, 19.0.into(), Attribute::VERSION_10);
        assert_eq!(compare(a, root, name, true)?, Some((child.into(), 0)));
        root.define_value(a.gc(), name, 23.0.into(), Attribute::empty());
        assert_eq!(compare(a, root, name, true)?, Some((23.0.into(), 0)));
        root.delete(a, name);
        assert_eq!(compare(a, root, name, true)?, Some((child.into(), 0)));
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_magic_case_paths_and_missing_levels_match_frozen_versions() {
    for version in [4, 5, 6, 7, 8, 10] {
        with_avm(version, |a, root| {
            reset(a);
            for text in ["_x", "_X", "_ROOT", "_root", "_parent", "_global", "_GLOBAL",
                "_level0", "_level999", "_flash0", "_flash-1", "_level2147483648", "missing"] {
                compare(a, root, key(a, text), true)?;
            }
            assert_eq!(calls(a), 0.0);
            Ok(())
        });
    }
}

#[test]
fn display_lookup_native_getter_results_errors_receiver_and_depth_match() {
    with_avm(8, |a, root| {
        let name = key(a, "value");
        for callback in [undefined_getter as NativeFunction, throwing_getter as NativeFunction, ignored_error_getter as NativeFunction] {
            root.delete(a, name);
            root.add_property(a.gc(), name, function(a, callback), None, Attribute::empty());
            let child = Object::new(&a.context.strings, Some(root));
            reset(a);
            let expected = read(a, child, name, true, false);
            let actual = read(a, child, name, true, true);
            result_eq(&actual, &expected);
            assert_eq!(calls(a), 2.0);
            let global = a.global_object();
            assert_eq!(raw(a, global, "lookupThis"), child.into());
            match actual {
                Ok(value) => assert_eq!(value, Some((Value::Undefined, 1))),
                Err(Error::ThrownValue(value)) => assert_eq!(value, key(a, "display-lookup-sentinel").into()),
                Err(error) => panic!("unexpected getter error: {error:?}"),
            }
        }
        Ok(())
    });
}

#[test]
fn display_lookup_recursive_getter_replacement_is_read_fresh() {
    for optimized in [false, true] {
        with_avm(8, |a, root| {
            reset(a);
            let name = key(a, "value");
            root.add_property(a.gc(), name, function(a, replacing_getter), None, Attribute::empty());
            assert_eq!(read(a, root, name, true, optimized)?, Some((37.0.into(), 0)));
            assert_eq!(calls(a), 1.0);
            assert_eq!(root.get(name, a)?, 37.0.into());
            assert_eq!(calls(a), 1.0);
            Ok(())
        });
    }
}

#[test]
fn display_lookup_getter_deletion_and_reparenting_keep_live_prototype_walk() {
    for optimized in [false, true] {
        with_avm(8, |a, root| {
            reset(a);
            let before = bare(a); put(a, before, "value", 1.0.into());
            let after = bare(a); put(a, after, "value", 99.0.into());
            put(a, root, "__proto__", before.into()); put(a, root, "replacement", after.into());
            let name = key(a, "value");
            root.add_property(a.gc(), name, function(a, reparenting_getter), None, Attribute::empty());
            assert_eq!(read(a, root, name, true, optimized)?, Some((99.0.into(), 1)));
            assert_eq!(calls(a), 1.0);
            Ok(())
        });
    }
}

#[test]
fn display_lookup_reentrant_virtual_getter_can_mutate_without_retained_borrow() {
    for optimized in [false, true] {
        with_avm(8, |a, _| {
            reset(a);
            let object = Object::new_with_native(&a.context.strings, None::<Value<'_>>, NativeObject::Number(BoxedF64::new(a.gc(), 3.0)));
            put(a, object, "other", 41.0.into());
            let name = key(a, "value");
            object.add_property(a.gc(), name, function(a, reentrant_getter), None, Attribute::empty());
            assert_eq!(read(a, object, name, true, optimized)?, Some((41.0.into(), 0)));
            assert_eq!(object.get(key(a, "other"), a)?, 99.0.into());
            // set_native cannot replace an already constructed native kind.
            // The real data mutation above must still complete without a held borrow.
            let NativeObject::Number(number) = object.native() else { panic!("original native kind retained"); };
            assert_eq!(number.value(), 3.0);
            assert_eq!(calls(a), 1.0);
            Ok(())
        });
    }
}

#[test]
fn display_lookup_noncallable_virtual_getter_still_shadows_native_value() {
    with_avm(8, |a, root| {
        reset(a);
        let name = key(a, "_x");
        root.add_property(a.gc(), name, bare(a), None, Attribute::empty());
        assert_eq!(compare(a, root, name, true)?, Some((Value::Undefined, 0)));
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_resolver_switch_receiver_arguments_and_missing_value_match() {
    with_avm(8, |a, root| {
        reset(a);
        let name = key(a, "absent");
        let proto = bare(a); put(a, proto, "__resolve", function(a, resolver).into());
        put(a, root, "__proto__", proto.into());
        assert_eq!(compare(a, root, name, false)?, None); assert_eq!(calls(a), 0.0);
        assert_eq!(compare(a, root, name, true)?, Some((91.0.into(), 0))); assert_eq!(calls(a), 2.0);
        let global = a.global_object();
        assert_eq!(raw(a, global, "lookupThis"), root.into());
        assert_eq!(raw(a, global, "lookupArgument"), name.into());
        put(a, root, "__resolve", bare(a).into()); reset(a);
        assert_eq!(compare(a, root, name, true)?, Some((Value::Undefined, 0)));
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_super_forwarding_and_native_prototype_recursion_remain_slow() {
    with_avm(8, |a, _| {
        reset(a);
        let holder = bare(a); put(a, holder, "value", 7.0.into());
        let super_object = Object::new_with_native(&a.context.strings, None::<Value<'_>>, NativeObject::Super(SuperObject::new(holder, 1)));
        let name = key(a, "value");
        assert!(matches!(super_object.boxhead_lookup_property(name, a), BoxheadLookupProperty::Slow));
        compare(a, super_object, name, true)?;
        let first = Object::new_with_native(&a.context.strings, None::<Value<'_>>, NativeObject::Bool(false));
        let second = Object::new(&a.context.strings, Some(first)); put(a, first, "__proto__", second.into());
        let missing = key(a, "missing");
        for optimized in [false, true] {
            assert!(matches!(read(a, first, missing, true, optimized), Err(Error::PrototypeRecursionLimit)));
        }
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_case_collisions_and_utf16_names_keep_actual_property_selection() {
    for version in [6, 7, 8] {
        with_avm(version, |a, root| {
            reset(a);
            put(a, root, "Thing", 1.0.into()); put(a, root, "thing", 2.0.into());
            for text in ["Thing", "thing", "THING", "absent"] { compare(a, root, key(a, text), true)?; }
            let wide = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 0x00c9]));
            root.define_value(a.gc(), wide, 73.0.into(), Attribute::DONT_ENUM);
            assert_eq!(compare(a, root, wide, true)?, Some((73.0.into(), 0)));
            assert_eq!(calls(a), 0.0);
            Ok(())
        });
    }
}

#[test]
fn display_lookup_repeated_reads_observe_data_deletion_native_and_prototype_changes() {
    with_avm(8, |a, root| {
        reset(a);
        let proto = bare(a); put(a, proto, "value", 5.0.into());
        let object = Object::new_with_native(&a.context.strings, Some(proto), NativeObject::Bool(false));
        let name = key(a, "value");
        assert_eq!(compare(a, object, name, true)?, Some((5.0.into(), 1)));
        for value in [Value::Number(31.0), Value::Undefined, Value::Number(-0.0)] {
            object.define_value(a.gc(), name, value, Attribute::empty());
            let (actual, depth) = compare(a, object, name, true)?.expect("fresh own data");
            value_bits(actual, value); assert_eq!(depth, 0);
        }
        object.delete(a, name);
        let replacement = bare(a); put(a, replacement, "value", 99.0.into());
        put(a, object, "__proto__", replacement.into());
        assert_eq!(compare(a, object, name, true)?, Some((99.0.into(), 1)));
        let x = key(a, "_x");
        let uninitialized = bare(a);
        assert_eq!(compare(a, uninitialized, x, true)?, None);
        uninitialized.set_native(a.gc(), root.native());
        assert_eq!(compare(a, uninitialized, x, true)?, Some((0.0.into(), 0)));
        // The actual API ignores reconstruction with a different native kind.
        uninitialized.set_native(a.gc(), NativeObject::Bool(false));
        assert!(matches!(uninitialized.native(), NativeObject::MovieClip(_)));
        assert_eq!(compare(a, uninitialized, x, true)?, Some((0.0.into(), 0)));
        Ok(())
    });
}

#[test]
fn display_lookup_real_activation_get_member_keeps_scalar_bits_and_movieclip_wrapping() {
    with_avm(8, |a, root| {
        reset(a);
        let child = child(a, root, "lookupChild", 1.0)?;
        put(a, root, "number", Value::Number(-0.0));
        put(a, root, "undefined", Value::Undefined);
        let data = SwfSlice::from(Arc::new(SwfMovie::fake_with_compressed_data(8, None, vec![0x4e, 0x3e])));
        for text in ["number", "undefined", "lookupChild", "_root", "_x"] {
            let name = key(a, text);
            let expected = frozen_v14::search_prototype(root.into(), name, a, root, true)?
                .expect("visible actual member").0;
            a.context.avm1.truncate_stack(0);
            a.context.avm1.push(root.into()); a.context.avm1.push(name.into());
            let actual = a.run_actions(data.clone())?.value();
            if text == "lookupChild" || text == "_root" {
                assert!(matches!(actual, Value::MovieClip(_)));
                let object = actual.as_object(a).expect("live MovieClip reference");
                assert!(Object::ptr_eq(object, if text == "lookupChild" { child } else { root }));
                assert_eq!(expected, object.into());
            } else { value_bits(actual, expected); }
            assert_eq!(a.context.avm1.stack_len(), 0);
        }
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}

#[test]
fn display_lookup_real_text_field_uses_native_properties_and_own_precedence() {
    with_avm(8, |a, root| {
        reset(a);
        let name = key(a, "lookupText");
        root.call_method(key(a, "createTextField"), &[name.into(), 2.0.into(), 13.0.into(),
            17.0.into(), 30.0.into(), 40.0.into()], a, ExecutionReason::FunctionCall)?;
        let object = root.get(name, a)?.as_object(a).expect("actual text field exists");
        assert!(matches!(object.native(), NativeObject::EditText(_)));
        for text in ["_x", "_y", "_root", "_parent", "_visible", "missing"] { compare(a, object, key(a, text), true)?; }
        let x = key(a, "_x");
        assert_eq!(compare(a, object, x, true)?, Some((13.0.into(), 0)));
        object.define_value(a.gc(), x, 41.0.into(), Attribute::empty());
        assert_eq!(compare(a, object, x, true)?, Some((41.0.into(), 0)));
        object.delete(a, x);
        assert_eq!(compare(a, object, x, true)?, Some((13.0.into(), 0)));
        assert_eq!(calls(a), 0.0);
        Ok(())
    });
}
