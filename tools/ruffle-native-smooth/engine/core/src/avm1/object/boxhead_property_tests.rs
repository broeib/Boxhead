//! Differential fixtures for the ordinary property read/write fast paths.
//! The two reference routines below are copied from the pinned pre-fastpath
//! object.rs. They deliberately do not call either new descriptor helper.

use super::*;
use crate::avm1::function::NativeFunction;
use crate::avm1::globals::array::ArrayBuilder;
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::string::WStr;

fn original_search_prototype<'gc>(
    mut proto: Value<'gc>,
    name: AvmString<'gc>,
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    call_resolve_fn: bool,
) -> Result<Option<(Value<'gc>, u8)>, Error<'gc>> {
    let mut depth = 0;
    let orig_proto = proto;

    while let Value::Object(p) = proto {
        if depth == 255 {
            return Err(Error::PrototypeRecursionLimit);
        }

        if let Some(result) = p.call_getter(name, this.into(), activation).transpose() {
            match result {
                Err(Error::PropertyRecursionLimit) => {
                    // Flash falls back to local resolution for compatibility
                    // with SWF<7.
                }
                // TODO Should we propagate all errors here?
                Err(e @ Error::ThrownValue(_)) => return Err(e),
                Err(e @ Error::FunctionRecursionLimit(_)) => return Err(e),
                _ => {
                    let value = result.unwrap_or(Value::Undefined);
                    return Ok(Some((value, depth)));
                }
            };
        }

        if let Some(value) = p.get_local_stored(name, activation) {
            return Ok(Some((value, depth)));
        }

        proto = p.proto(activation);
        depth += 1;
    }

    if call_resolve_fn && let Some(resolve) = find_resolve_method(orig_proto, activation)? {
        let result = resolve.call(istr!("__resolve"), activation, this.into(), &[name.into()])?;
        return Ok(Some((result, 0)));
    }

    Ok(None)
}

fn original_set<'gc>(
        object: Object<'gc>,
        name: AvmString<'gc>,
        mut value: Value<'gc>,
        activation: &mut Activation<'_, 'gc>,
    ) -> Result<(), Error<'gc>> {
        if name.is_empty() {
            return Ok(());
        }

        let (this, mut proto) = if let Some(super_object) = object.as_super_object() {
            (super_object.this(), super_object.proto(activation))
        } else {
            (object, Value::Object(object))
        };
        let watcher_result = object.call_watcher(activation, name, &mut value, this);

        if !object.has_own_property(activation, name) {
            // Before actually inserting a new property, we need to crawl the
            // prototype chain for virtual setters.
            while let Value::Object(this_proto) = proto {
                if this_proto.has_own_virtual(activation, name) {
                    let result = this_proto.call_setter(name, this.into(), value, activation);
                    match result {
                        Ok(_) => {}
                        Err(Error::PropertyRecursionLimit) => {
                            // Flash ignores it for compatibility with SWF<7.
                        }
                        Err(e) => {
                            return Err(e);
                        }
                    }
                    return Ok(());
                }

                proto = this_proto.proto(activation);
            }
        }

        let result = object.set_local(name, value, activation, this);
        watcher_result.and(result)
    }

fn key<'gc>(activation: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), text)
}
fn bare<'gc>(activation: &Activation<'_, 'gc>) -> Object<'gc> {
    Object::new_without_proto(activation.gc())
}
fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}
fn put<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(activation.gc(), key(activation, name), value, Attribute::empty());
}
fn raw<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Value<'gc> {
    object.get_data(key(activation, name), activation).unwrap_or(Value::Undefined)
}
fn reset_trace(activation: &mut Activation<'_, '_>) {
    let global = activation.global_object();
    for name in ["propertyCalls", "propertyThis", "propertyArgument"] {
        put(activation, global, name, Value::Undefined);
    }
}
fn record<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, argument: Value<'gc>) {
    let global = activation.global_object();
    let previous = match raw(activation, global, "propertyCalls") { Value::Number(value) => value, _ => 0.0 };
    put(activation, global, "propertyCalls", (previous + 1.0).into());
    put(activation, global, "propertyThis", this.into());
    put(activation, global, "propertyArgument", argument);
}
fn calls(activation: &mut Activation<'_, '_>) -> f64 {
    let global = activation.global_object();
    match raw(activation, global, "propertyCalls") { Value::Number(value) => value, _ => 0.0 }
}
fn undefined_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Ok(Value::Undefined)
}
fn throwing_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Err(Error::ThrownValue(key(activation, "property-sentinel").into()))
}
fn ignored_error_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Err(Error::ExecutionTimeout)
}
fn replace_then_recurse<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    put(activation, this, "value", 37.0.into());
    Err(Error::PropertyRecursionLimit)
}
fn delete_and_reparent<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    let replacement = raw(activation, this, "replacement");
    this.delete(activation, key(activation, "value"));
    this.set_data(key(activation, "__proto__"), replacement, activation)?;
    Err(Error::PropertyRecursionLimit)
}
fn resolve_value<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[0]);
    Ok(91.0.into())
}
fn setter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[0]);
    Ok(Value::Undefined)
}
fn watcher<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[2]);
    Ok((args[2].coerce_to_f64(activation)? + 5.0).into())
}
fn descriptors<'gc>(object: Object<'gc>) -> Vec<(AvmString<'gc>, Value<'gc>, u16)> {
    object.boxhead_graph_properties().unwrap().into_iter()
        .map(|(key, value, attributes)| (key, value, attributes.bits())).collect()
}
fn compare_lookup<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: AvmString<'gc>, resolve: bool) {
    let expected = original_search_prototype(object.into(), name, activation, object, resolve);
    let actual = search_prototype(object.into(), name, activation, object, resolve);
    match (expected, actual) {
        (Ok(expected), Ok(actual)) => assert_eq!(actual, expected),
        (Err(Error::ThrownValue(expected)), Err(Error::ThrownValue(actual))) => assert_eq!(actual, expected),
        (Err(Error::PrototypeRecursionLimit), Err(Error::PrototypeRecursionLimit)) => {},
        (expected, actual) => panic!("lookup differs: expected {expected:?}, actual {actual:?}"),
    }
}

#[test]
fn ordinary_data_and_inherited_depth_match_the_original_lookup() {
    with_avm(8, |activation, _| {
        let function_object = function(activation, throwing_getter);
        put(activation, function_object, "value", 42.0.into());
        let array = ArrayBuilder::empty(activation);
        put(activation, array, "__proto__", function_object.into());
        let child = Object::new(&activation.context.strings, Some(array));
        let name = key(activation, "value");
        for object in [function_object, array, child] { compare_lookup(activation, object, name, true); }
        assert_eq!(search_prototype(child.into(), name, activation, child, true)?, Some((42.0.into(), 2)));
        for object in [bare(activation), array, function_object] {
            put(activation, object, "own", 7.0.into());
            assert!(matches!(object.boxhead_own_property(key(activation, "own"), activation), BoxheadOwnProperty::Stored(Value::Number(7.0))));
        }
        assert_eq!(calls(activation), 0.0);
        Ok(())
    });
}

#[test]
fn stored_undefined_shadows_parent_getters_and_resolvers() {
    with_avm(8, |activation, _| {
        let proto = bare(activation);
        let name = key(activation, "value");
        proto.add_property(activation.gc(), name, function(activation, throwing_getter), None, Attribute::empty());
        put(activation, proto, "__resolve", function(activation, throwing_getter).into());
        let child = Object::new(&activation.context.strings, Some(proto));
        put(activation, child, "value", Value::Undefined);
        compare_lookup(activation, child, name, true);
        assert_eq!(search_prototype(child.into(), name, activation, child, true)?, Some((Value::Undefined, 0)));
        assert_eq!(calls(activation), 0.0);
        Ok(())
    });
}

#[test]
fn getter_returning_undefined_stops_at_its_original_depth_and_receiver() {
    with_avm(8, |activation, _| {
        let proto = bare(activation);
        let name = key(activation, "value");
        proto.add_property(activation.gc(), name, function(activation, undefined_getter), None, Attribute::empty());
        put(activation, proto, "__resolve", function(activation, throwing_getter).into());
        let child = Object::new(&activation.context.strings, Some(proto));
        compare_lookup(activation, child, name, true);
        assert_eq!(calls(activation), 2.0);
        let global = activation.global_object();
        assert_eq!(raw(activation, global, "propertyThis"), child.into());
        assert!(matches!(proto.boxhead_own_property(name, activation), BoxheadOwnProperty::Special));
        Ok(())
    });
}

#[test]
fn getter_throws_and_nonfatal_error_handling_match_original() {
    with_avm(8, |activation, _| {
        for callback in [throwing_getter as NativeFunction, ignored_error_getter as NativeFunction] {
            let object = bare(activation);
            let name = key(activation, "value");
            object.add_property(activation.gc(), name, function(activation, callback), None, Attribute::empty());
            reset_trace(activation);
            compare_lookup(activation, object, name, true);
            assert_eq!(calls(activation), 2.0);
        }
        Ok(())
    });
}

#[test]
fn recursive_getter_error_reads_the_descriptor_again_after_replacement() {
    with_avm(8, |activation, _| {
        for optimized in [false, true] {
            let object = bare(activation);
            let name = key(activation, "value");
            object.add_property(activation.gc(), name, function(activation, replace_then_recurse), None, Attribute::empty());
            reset_trace(activation);
            let result = if optimized { search_prototype(object.into(), name, activation, object, true) }
                else { original_search_prototype(object.into(), name, activation, object, true) }?;
            assert_eq!(result, Some((37.0.into(), 0))); assert_eq!(calls(activation), 1.0);
            assert!(matches!(object.boxhead_own_property(name, activation), BoxheadOwnProperty::Stored(Value::Number(37.0))));
        }
        Ok(())
    });
}

#[test]
fn getter_deletion_and_prototype_mutation_preserve_live_continuation() {
    with_avm(8, |activation, _| {
        for optimized in [false, true] {
            let old_proto = bare(activation); put(activation, old_proto, "value", 1.0.into());
            let replacement = bare(activation); put(activation, replacement, "value", 99.0.into());
            let object = Object::new(&activation.context.strings, Some(old_proto));
            put(activation, object, "replacement", replacement.into());
            let name = key(activation, "value");
            object.add_property(activation.gc(), name, function(activation, delete_and_reparent), None, Attribute::empty());
            reset_trace(activation);
            let result = if optimized { search_prototype(object.into(), name, activation, object, true) }
                else { original_search_prototype(object.into(), name, activation, object, true) }?;
            assert_eq!(result, Some((99.0.into(), 1))); assert_eq!(calls(activation), 1.0);
        }
        Ok(())
    });
}

#[test]
fn version_hidden_stored_and_virtual_descriptors_follow_the_parent() {
    for version in [5, 6, 7, 8, 9, 10] {
        with_avm(version, |activation, _| {
            let proto = bare(activation); put(activation, proto, "data", 1.0.into()); put(activation, proto, "virtual", 2.0.into());
            let object = Object::new(&activation.context.strings, Some(proto));
            let data = key(activation, "data"); let virtual_name = key(activation, "virtual");
            object.define_value(activation.gc(), data, 3.0.into(), Attribute::VERSION_10);
            object.add_property(activation.gc(), virtual_name, function(activation, undefined_getter), None, Attribute::VERSION_10);
            compare_lookup(activation, object, data, true);
            compare_lookup(activation, object, virtual_name, true);
            if version < 10 {
                assert!(matches!(object.boxhead_own_property(data, activation), BoxheadOwnProperty::Missing));
                assert!(matches!(object.boxhead_own_property(virtual_name, activation), BoxheadOwnProperty::Missing));
                assert_eq!(object.get(data, activation)?, 1.0.into()); assert_eq!(calls(activation), 0.0);
            } else {
                assert_eq!(object.get(data, activation)?, 3.0.into()); assert_eq!(calls(activation), 2.0);
            }
            Ok(())
        });
    }
}

#[test]
fn mixed_case_stored_names_use_the_same_runtime_collision_choice() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            let object = bare(activation);
            put(activation, object, "Thing", 1.0.into()); put(activation, object, "thing", 2.0.into());
            for text in ["Thing", "thing", "THING", "missing"] {
                compare_lookup(activation, object, key(activation, text), true);
            }
            Ok(())
        });
    }
}

#[test]
fn own_watchers_do_not_change_read_semantics() {
    with_avm(8, |activation, _| {
        let object = bare(activation); let name = key(activation, "value");
        put(activation, object, "value", 12.0.into());
        let callback = function(activation, throwing_getter);
        object.watch(activation, name, callback, Value::Undefined);
        compare_lookup(activation, object, name, true);
        assert_eq!(object.get(name, activation)?, 12.0.into()); assert_eq!(calls(activation), 0.0);
        Ok(())
    });
}

#[test]
fn unresolved_lookup_retains_resolver_switch_receiver_and_arguments() {
    with_avm(8, |activation, _| {
        let proto = bare(activation); put(activation, proto, "__resolve", function(activation, resolve_value).into());
        let object = Object::new(&activation.context.strings, Some(proto));
        let name = key(activation, "absent");
        compare_lookup(activation, object, name, false); assert_eq!(calls(activation), 0.0);
        compare_lookup(activation, object, name, true); assert_eq!(calls(activation), 2.0);
        let global = activation.global_object();
        assert_eq!(raw(activation, global, "propertyThis"), object.into());
        assert_eq!(raw(activation, global, "propertyArgument"), name.into());
        put(activation, object, "__resolve", bare(activation).into());
        reset_trace(activation); compare_lookup(activation, object, name, true);
        assert_eq!(object.get(name, activation)?, Value::Undefined); assert_eq!(calls(activation), 0.0);
        Ok(())
    });
}

#[test]
fn special_native_and_super_objects_keep_the_original_lookup_path() {
    with_avm(8, |activation, clip| {
        let ordinary = bare(activation); put(activation, ordinary, "value", 7.0.into());
        let super_object = Object::new_with_native(&activation.context.strings, None::<Value<'_>>,
            NativeObject::Super(SuperObject::new(ordinary, 1)));
        let boxed = Object::new_with_native(&activation.context.strings, None::<Value<'_>>,
            NativeObject::Number(BoxedF64::new(activation.gc(), 7.0)));
        put(activation, boxed, "value", 8.0.into());
        for (object, text) in [(clip, "_x"), (super_object, "value"), (boxed, "value")] {
            let name = key(activation, text);
            assert!(matches!(object.boxhead_own_property(name, activation), BoxheadOwnProperty::Special));
            compare_lookup(activation, object, name, true);
        }
        Ok(())
    });
}

#[test]
fn prototype_cycle_reaches_the_original_recursion_limit() {
    with_avm(8, |activation, _| {
        let first = bare(activation); let second = Object::new(&activation.context.strings, Some(first));
        put(activation, first, "__proto__", second.into());
        let name = key(activation, "absent");
        assert!(matches!(original_search_prototype(first.into(), name, activation, first, true), Err(Error::PrototypeRecursionLimit)));
        assert!(matches!(search_prototype(first.into(), name, activation, first, true), Err(Error::PrototypeRecursionLimit)));
        Ok(())
    });
}

#[test]
fn own_data_writes_preserve_flags_order_and_version_clearing() {
    with_avm(8, |activation, _| {
        for readonly in [false, true] {
            let objects = [bare(activation), bare(activation)];
            let name = key(activation, "value");
            let flags = Attribute::DONT_ENUM | Attribute::DONT_DELETE | Attribute::VERSION_10
                | if readonly { Attribute::READ_ONLY } else { Attribute::empty() };
            for object in objects {
                put(activation, object, "first", 1.0.into());
                object.define_value(activation.gc(), name, 7.0.into(), flags);
                put(activation, object, "last", 2.0.into());
            }
            let [reference, actual] = objects;
            original_set(reference, name, 9.0.into(), activation)?; actual.set(name, 9.0, activation)?;
            assert_eq!(descriptors(actual), descriptors(reference));
            assert_eq!(actual.get_data(name, activation), Some(if readonly { 7.0.into() } else { 9.0.into() }));
            assert_eq!(actual.get(name, activation)?, if readonly { Value::Undefined } else { 9.0.into() });
            assert!(!actual.delete(activation, name)); assert!(!actual.get_keys(activation, false).contains(&name));
            // A second eligible write updates the same descriptor, without reordering.
            original_set(reference, name, 10.0.into(), activation)?; actual.set(name, 10.0, activation)?;
            assert_eq!(descriptors(actual), descriptors(reference));
        }
        Ok(())
    });
}

#[test]
fn own_data_shadows_inherited_virtual_setters_even_when_initially_hidden() {
    with_avm(8, |activation, _| {
        let proto = bare(activation); let name = key(activation, "value");
        proto.add_property(activation.gc(), name, function(activation, throwing_getter), Some(function(activation, setter)), Attribute::empty());
        let reference = Object::new(&activation.context.strings, Some(proto));
        let actual = Object::new(&activation.context.strings, Some(proto));
        for object in [reference, actual] { object.define_value(activation.gc(), name, 1.0.into(), Attribute::VERSION_10); }
        original_set(reference, name, 20.0.into(), activation)?; actual.set(name, 20.0, activation)?;
        assert_eq!(descriptors(actual), descriptors(reference)); assert_eq!(calls(activation), 0.0);
        assert_eq!(actual.get(name, activation)?, 20.0.into());
        Ok(())
    });
}

#[test]
fn watchers_and_own_virtual_setters_still_receive_every_write() {
    with_avm(8, |activation, _| {
        for virtual_slot in [false, true] {
            for optimized in [false, true] {
                let object = bare(activation); let name = key(activation, "value");
                if virtual_slot {
                    object.add_property(activation.gc(), name, function(activation, undefined_getter), Some(function(activation, setter)), Attribute::empty());
                } else {
                    put(activation, object, "value", 1.0.into());
                    let callback = function(activation, watcher); object.watch(activation, name, callback, Value::Undefined);
                }
                reset_trace(activation);
                assert!(matches!(object.boxhead_set_own_data(name, 12.0.into(), activation), BoxheadOwnWrite::Slow)); assert_eq!(calls(activation), 0.0);
                if optimized { object.set(name, 12.0, activation)?; } else { original_set(object, name, 12.0.into(), activation)?; }
                assert_eq!(calls(activation), 1.0);
                assert_eq!(object.get_data(name, activation), Some(if virtual_slot { 12.0.into() } else { 17.0.into() }));
                let global = activation.global_object();
                assert_eq!(raw(activation, global, "propertyThis"), object.into());
                assert_eq!(raw(activation, global, "propertyArgument"), 12.0.into());
            }
        }
        Ok(())
    });
}

#[test]
fn missing_write_falls_back_without_insertion_and_preserves_inherited_setter() {
    with_avm(8, |activation, _| {
        for inherited_setter in [false, true] {
            for optimized in [false, true] {
                let proto = bare(activation); let name = key(activation, "value");
                if inherited_setter {
                    proto.add_property(activation.gc(), name, function(activation, undefined_getter), Some(function(activation, setter)), Attribute::empty());
                }
                let object = Object::new(&activation.context.strings, Some(proto));
                reset_trace(activation);
                assert!(matches!(object.boxhead_set_own_data(name, 3.0.into(), activation),
                    BoxheadOwnWrite::MissingOrdinaryUnwatched { raw_proto: Value::Object(value) } if Object::ptr_eq(value, proto)));
                assert!(!object.has_own_property(activation, name)); assert_eq!(calls(activation), 0.0);
                if optimized { object.set(name, 3.0, activation)?; } else { original_set(object, name, 3.0.into(), activation)?; }
                assert_eq!(object.has_own_property(activation, name), !inherited_setter);
                assert_eq!(calls(activation), if inherited_setter { 1.0 } else { 0.0 });
                if !inherited_setter { assert_eq!(object.get(name, activation)?, 3.0.into()); }
            }
        }
        Ok(())
    });
}

#[test]
fn native_arrays_display_super_and_functions_never_use_the_write_fast_path() {
    with_avm(8, |activation, clip| {
        let reference = ArrayBuilder::new(activation).with([1.0.into(), 2.0.into(), 3.0.into()]);
        let actual = ArrayBuilder::new(activation).with([1.0.into(), 2.0.into(), 3.0.into()]);
        let name = key(activation, "length");
        assert!(matches!(actual.boxhead_set_own_data(name, 1.0.into(), activation), BoxheadOwnWrite::Slow));
        assert_eq!(actual.length(activation)?, 3);
        original_set(reference, name, 1.0.into(), activation)?; actual.set(name, 1.0, activation)?;
        let fifth = key(activation, "5");
        original_set(reference, fifth, 8.0.into(), activation)?; actual.set(fifth, 8.0, activation)?;
        assert_eq!(descriptors(actual), descriptors(reference)); assert_eq!(actual.length(activation)?, 6);
        assert_eq!(actual.get_element(activation, 1), Value::Undefined);
        let ordinary = bare(activation);
        let super_object = Object::new_with_native(&activation.context.strings, None::<Value<'_>>,
            NativeObject::Super(SuperObject::new(ordinary, 1)));
        let callable = function(activation, throwing_getter);
        for object in [clip, super_object, callable] {
            let name = key(activation, "value"); put(activation, object, "value", 1.0.into());
            let before = object.get_data(name, activation);
            assert!(matches!(object.boxhead_set_own_data(name, 2.0.into(), activation), BoxheadOwnWrite::Slow));
            assert_eq!(object.get_data(name, activation), before);
        }
        Ok(())
    });
}

#[test]
fn empty_property_name_keeps_its_original_early_return() {
    with_avm(8, |activation, _| {
        let reference = bare(activation); let actual = bare(activation); let name = key(activation, "");
        for object in [reference, actual] { object.define_value(activation.gc(), name, 7.0.into(), Attribute::empty()); }
        original_set(reference, name, 99.0.into(), activation)?; actual.set(name, 99.0, activation)?;
        assert_eq!(descriptors(actual), descriptors(reference)); assert_eq!(actual.get_data(name, activation), Some(7.0.into()));
        Ok(())
    });
}

#[test]
fn stored_proto_write_changes_subsequent_lookup_without_any_cached_shape() {
    with_avm(8, |activation, _| {
        let old_proto = bare(activation); put(activation, old_proto, "value", 1.0.into());
        let new_proto = bare(activation); put(activation, new_proto, "value", 2.0.into());
        let reference = Object::new(&activation.context.strings, Some(old_proto));
        let actual = Object::new(&activation.context.strings, Some(old_proto));
        let proto = key(activation, "__proto__"); let name = key(activation, "value");
        assert_eq!(actual.get(name, activation)?, 1.0.into());
        original_set(reference, proto, new_proto.into(), activation)?; actual.set(proto, new_proto, activation)?;
        assert_eq!(descriptors(actual), descriptors(reference)); assert_eq!(actual.get(name, activation)?, 2.0.into());
        Ok(())
    });
}

#[test]
fn mixed_case_writes_retain_collision_selection_and_enumeration_order() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            let reference = bare(activation); let actual = bare(activation);
            for object in [reference, actual] {
                put(activation, object, "Thing", 1.0.into()); put(activation, object, "thing", 2.0.into());
                put(activation, object, "last", 3.0.into());
            }
            for (index, text) in ["THING", "Thing", "thing", "Thing"].into_iter().enumerate() {
                let name = key(activation, text); let value = (index + 10) as f64;
                original_set(reference, name, value.into(), activation)?; actual.set(name, value, activation)?;
                assert_eq!(descriptors(actual), descriptors(reference));
            }
            Ok(())
        });
    }
}

// These cases exercise the new missing-slot prefix against original_set.
// set_local, call_watcher, the inherited-setter loop and their error handling
// are still the unchanged pinned implementation in both arms.
fn write_outcome<'gc>(result: Result<(), Error<'gc>>) -> (u8, Value<'gc>) {
    match result {
        Ok(()) => (0, Value::Undefined),
        Err(Error::ThrownValue(value)) => (1, value),
        Err(Error::PropertyRecursionLimit) => (2, Value::Undefined),
        Err(Error::ExecutionTimeout) => (3, Value::Undefined),
        Err(error) => panic!("unexpected write error: {error:?}"),
    }
}

fn write_mode<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>) -> u8 {
    match raw(activation, object, "writeMode") {
        Value::Number(mode) => mode as u8,
        _ => panic!("missing write fixture mode"),
    }
}

fn write_arm<'gc>(object: Object<'gc>, name: AvmString<'gc>, value: Value<'gc>,
    activation: &mut Activation<'_, 'gc>, optimized: bool) -> Result<(), Error<'gc>> {
    if optimized { object.set(name, value, activation) }
    else { original_set(object, name, value, activation) }
}

fn mutating_inherited_setter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[0]);
    let mode = write_mode(activation, this);
    let replacement = raw(activation, this, "replacement");
    put(activation, this, "value", 99.0.into());
    this.set_data(key(activation, "__proto__"), replacement, activation)?;
    match mode {
        1 => Err(Error::ThrownValue(key(activation, "setter-sentinel").into())),
        2 => Err(Error::PropertyRecursionLimit),
        3 => Err(Error::ExecutionTimeout),
        _ => Ok(Value::Undefined),
    }
}

fn mutating_missing_watcher<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[2]);
    let global = activation.global_object();
    put(activation, global, "watchedOldValue", args[1]);
    let mode = write_mode(activation, this);
    if mode % 2 == 0 {
        put(activation, this, "value", 44.0.into());
    } else {
        let replacement = raw(activation, this, "replacement");
        this.set_data(key(activation, "__proto__"), replacement, activation)?;
    }
    if mode >= 2 {
        Err(Error::ThrownValue(key(activation, "watcher-sentinel").into()))
    } else {
        Ok(17.0.into())
    }
}

#[test]
fn missing_write_searches_past_inherited_stored_slots_for_a_deeper_setter() {
    with_avm(8, |activation, _| {
        for flags in [Attribute::empty(), Attribute::READ_ONLY | Attribute::VERSION_10] {
            let far = bare(activation);
            let name = key(activation, "value");
            far.add_property(activation.gc(), name, function(activation, throwing_getter),
                Some(function(activation, setter)), Attribute::empty());
            let near = Object::new(&activation.context.strings, Some(far));
            near.define_value(activation.gc(), name, 41.0.into(), flags);
            put(activation, near, "__resolve", function(activation, throwing_getter).into());
            let reference = Object::new(&activation.context.strings, Some(near));
            let actual = Object::new(&activation.context.strings, Some(near));
            for (object, optimized) in [(reference, false), (actual, true)] {
                reset_trace(activation);
                if optimized { object.set(name, 12.0, activation)?; }
                else { original_set(object, name, 12.0.into(), activation)?; }
                assert_eq!(calls(activation), 1.0);
                assert!(!object.has_own_property(activation, name));
                let global = activation.global_object();
                assert_eq!(raw(activation, global, "propertyThis"), object.into());
                assert_eq!(raw(activation, global, "propertyArgument"), 12.0.into());
                assert_eq!(near.get_data(name, activation), Some(41.0.into()));
            }
            assert_eq!(descriptors(actual), descriptors(reference));
        }
        Ok(())
    });
}

#[test]
fn missing_write_keeps_visible_getter_only_and_hidden_virtual_stopping_rules() {
    for version in [6, 8, 10] {
        with_avm(version, |activation, _| {
            for hidden in [false, true] {
                for noncallable_setter in [false, true] {
                    let name = key(activation, "value");
                    let far = bare(activation);
                    far.add_property(activation.gc(), name, function(activation, throwing_getter),
                        Some(function(activation, setter)), Attribute::empty());
                    let near = Object::new(&activation.context.strings, Some(far));
                    let setter = if noncallable_setter { Some(bare(activation)) } else { None };
                    near.add_property(activation.gc(), name, function(activation, throwing_getter), setter,
                        if hidden { Attribute::VERSION_10 } else { Attribute::empty() });
                    let reference = Object::new(&activation.context.strings, Some(near));
                    let actual = Object::new(&activation.context.strings, Some(near));
                    let expected_calls = if hidden && version < 10 { 1.0 } else { 0.0 };
                    for (object, optimized) in [(reference, false), (actual, true)] {
                        reset_trace(activation);
                        if optimized { object.set(name, 12.0, activation)?; }
                        else { original_set(object, name, 12.0.into(), activation)?; }
                        assert_eq!(calls(activation), expected_calls);
                        assert!(!object.has_own_property(activation, name));
                    }
                    assert_eq!(descriptors(actual), descriptors(reference));
                }
            }
            Ok(())
        });
    }
}

#[test]
fn missing_write_preserves_inherited_setter_mutations_and_error_precedence() {
    with_avm(8, |activation, _| {
        let name = key(activation, "value");
        for mode in 0..4 {
            let mut outcomes = Vec::new();
            for optimized in [false, true] {
                let prototype = bare(activation);
                prototype.add_property(activation.gc(), name, function(activation, throwing_getter),
                    Some(function(activation, mutating_inherited_setter)), Attribute::empty());
                let replacement = bare(activation);
                let object = Object::new(&activation.context.strings, Some(prototype));
                put(activation, object, "writeMode", (mode as f64).into());
                put(activation, object, "replacement", replacement.into());
                reset_trace(activation);
                let result = if optimized { object.set(name, 12.0, activation) }
                    else { original_set(object, name, 12.0.into(), activation) };
                let outcome = write_outcome(result);
                assert_eq!(outcome.0, match mode { 1 => 1, 3 => 3, _ => 0 });
                assert_eq!(calls(activation), 1.0);
                assert_eq!(object.get_data(name, activation), Some(99.0.into()));
                assert_eq!(object.proto(activation), replacement.into());
                let global = activation.global_object();
                assert_eq!(raw(activation, global, "propertyThis"), object.into());
                assert_eq!(raw(activation, global, "propertyArgument"), 12.0.into());
                outcomes.push(outcome);
            }
            assert_eq!(outcomes[1], outcomes[0]);
        }
        Ok(())
    });
}

#[test]
fn missing_write_watchers_keep_slot_creation_reparenting_and_thrown_value_rules() {
    with_avm(8, |activation, _| {
        let name = key(activation, "value");
        for mode in 0..4 {
            let mut outcomes = Vec::new();
            for optimized in [false, true] {
                let prototype = bare(activation);
                put(activation, prototype, "value", 12.0.into());
                let replacement = bare(activation);
                replacement.add_property(activation.gc(), name, function(activation, throwing_getter),
                    Some(function(activation, setter)), Attribute::empty());
                let object = Object::new(&activation.context.strings, Some(prototype));
                put(activation, object, "writeMode", (mode as f64).into());
                put(activation, object, "replacement", replacement.into());
                let callback = function(activation, mutating_missing_watcher);
                object.watch(activation, name, callback, Value::Undefined);
                assert!(matches!(object.boxhead_set_own_data(name, 7.0.into(), activation), BoxheadOwnWrite::Slow));
                reset_trace(activation);
                let result = if optimized { object.set(name, 7.0, activation) }
                    else { original_set(object, name, 7.0.into(), activation) };
                let outcome = write_outcome(result);
                // The pinned inherited-setter return can consume a watcher
                // error; the own-slot branch propagates it after storing undefined.
                assert_eq!(outcome.0, if mode == 2 { 1 } else { 0 });
                assert_eq!(calls(activation), if mode % 2 == 0 { 1.0 } else { 2.0 });
                assert_eq!(object.get_data(name, activation), if mode % 2 == 0 {
                    Some(if mode >= 2 { Value::Undefined } else { 17.0.into() })
                } else { None });
                assert_eq!(object.proto(activation), if mode % 2 == 0 { prototype.into() } else { replacement.into() });
                let global = activation.global_object();
                assert_eq!(raw(activation, global, "watchedOldValue"), 12.0.into());
                assert_eq!(raw(activation, global, "propertyThis"), object.into());
                outcomes.push(outcome);
            }
            assert_eq!(outcomes[1], outcomes[0]);
        }
        Ok(())
    });
}

#[test]
fn missing_write_reads_proto_data_with_original_case_and_attribute_rules() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            for spelling in ["__proto__", "__PROTO__"] {
                for virtual_link in [false, true] {
                    let prototype = bare(activation);
                    let name = key(activation, "value");
                    prototype.add_property(activation.gc(), name, function(activation, throwing_getter),
                        Some(function(activation, setter)), Attribute::empty());
                    let reference = bare(activation);
                    let actual = bare(activation);
                    for object in [reference, actual] {
                        let proto_name = key(activation, spelling);
                        object.define_value(activation.gc(), proto_name, prototype.into(), Attribute::VERSION_10);
                        if virtual_link {
                            object.add_property(activation.gc(), proto_name, function(activation, throwing_getter), None, Attribute::VERSION_10);
                        }
                    }
                    let follows = spelling == "__proto__" || version < 7;
                    for (object, optimized) in [(reference, false), (actual, true)] {
                        reset_trace(activation);
                        if optimized { object.set(name, 12.0, activation)?; }
                        else { original_set(object, name, 12.0.into(), activation)?; }
                        assert_eq!(calls(activation), if follows { 1.0 } else { 0.0 });
                        assert_eq!(object.get_data(name, activation), if follows { None } else { Some(12.0.into()) });
                    }
                    // The fixture's __proto__ getter must remain untouched,
                    // including when it is hidden by the current SWF version.
                    assert_eq!(actual.get_data(key(activation, spelling), activation), Some(prototype.into()));
                }
            }
            Ok(())
        });
    }
}

#[test]
fn missing_ordinary_write_retains_native_and_super_prototype_setter_paths() {
    with_avm(8, |activation, clip| {
        let name = key(activation, "value");
        for kind in 0..4 {
            let holder = match kind {
                0 => Object::new_with_native(&activation.context.strings, None::<Value<'_>>, NativeObject::Array(())),
                1 => function(activation, throwing_getter),
                2 => bare(activation),
                _ => clip,
            };
            holder.add_property(activation.gc(), name, function(activation, throwing_getter),
                Some(function(activation, setter)), Attribute::empty());
            let prototype = if kind == 2 {
                Object::new_with_native(&activation.context.strings, None::<Value<'_>>,
                    NativeObject::Super(SuperObject::new(holder, 1)))
            } else { holder };
            let reference = Object::new(&activation.context.strings, Some(prototype));
            let actual = Object::new(&activation.context.strings, Some(prototype));
            for (object, optimized) in [(reference, false), (actual, true)] {
                reset_trace(activation);
                if optimized { object.set(name, 12.0, activation)?; }
                else { original_set(object, name, 12.0.into(), activation)?; }
                assert_eq!(calls(activation), 1.0);
                assert!(!object.has_own_property(activation, name));
                let global = activation.global_object();
                assert_eq!(raw(activation, global, "propertyThis"), object.into());
                assert_eq!(raw(activation, global, "propertyArgument"), 12.0.into());
            }
            assert_eq!(descriptors(actual), descriptors(reference));
            assert!(holder.delete(activation, name));
        }
        Ok(())
    });
}

#[test]
fn missing_write_keeps_new_field_case_flags_order_and_raw_proto_insertion() {
    for version in [5, 6, 7, 8, 10] {
        with_avm(version, |activation, _| {
            let reference = bare(activation);
            let actual = bare(activation);
            for (index, text) in ["one", "TWO", "two", "", "__proto__", "last", "one"].into_iter().enumerate() {
                let name = key(activation, text);
                let value: Value<'_> = if text == "__proto__" { Value::Null } else { ((index + 10) as f64).into() };
                original_set(reference, name, value, activation)?;
                actual.set(name, value, activation)?;
                assert_eq!(descriptors(actual), descriptors(reference));
            }
            let wide = AvmString::new(activation.gc(), WStr::from_units(&[0xd800u16, 0, 0xffff][..]));
            original_set(reference, wide, true.into(), activation)?;
            actual.set(wide, true, activation)?;
            assert_eq!(descriptors(actual), descriptors(reference));
            let empty = key(activation, "");
            assert!(!actual.has_own_property(activation, empty));
            assert!(descriptors(actual).iter().all(|(_, _, flags)| *flags == 0));
            assert_eq!(actual.get_data(key(activation, "__proto__"), activation), Some(Value::Null));
            Ok(())
        });
    }
}

#[test]
fn missing_write_rechecks_prototypes_watchers_and_native_kind_between_writes() {
    with_avm(8, |activation, _| {
        let mut outcomes = Vec::new();
        for optimized in [false, true] {
            let prototype = bare(activation);
            let object = Object::new(&activation.context.strings, Some(prototype));
            reset_trace(activation);
            write_arm(object, key(activation, "first"), 1.0.into(), activation, optimized)?;
            let second = key(activation, "second");
            prototype.add_property(activation.gc(), second, function(activation, throwing_getter),
                Some(function(activation, setter)), Attribute::empty());
            write_arm(object, second, 20.0.into(), activation, optimized)?;
            assert!(!object.has_own_property(activation, second));
            let third = key(activation, "third");
            let callback = function(activation, watcher);
            object.watch(activation, third, callback, Value::Undefined);
            write_arm(object, third, 30.0.into(), activation, optimized)?;
            assert_eq!(object.get_data(third, activation), Some(35.0.into()));
            assert!(object.unwatch(activation, third));
            object.set_native(activation.gc(), NativeObject::Array(()));
            write_arm(object, key(activation, "5"), 40.0.into(), activation, optimized)?;
            assert_eq!(object.length(activation)?, 6);
            assert_eq!(calls(activation), 2.0);
            let fields: Vec<_> = descriptors(object).into_iter()
                .filter(|(name, _, _)| !name.eq_with_case(b"__proto__", true)).collect();
            outcomes.push(fields);
        }
        assert_eq!(outcomes[1], outcomes[0]);
        Ok(())
    });
}
