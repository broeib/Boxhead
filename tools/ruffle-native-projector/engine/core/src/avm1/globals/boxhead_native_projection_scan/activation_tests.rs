//! This module is included only beneath activation.rs under cfg(test), so it
//! can exercise the unchanged real ActionCallMethod completion boundary.

use super::{Activation, FrameControl, ReturnType};
use crate::avm1::error::Error;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;

fn unload<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let clip = activation.base_clip();
    clip.avm1_unload(activation.context);
    Ok(Value::Bool(true))
}

fn forbidden_read<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    Err(Error::ThrownValue(AvmString::new_utf8(activation.gc(), "read after base-clip removal").into()))
}

#[test]
fn native_projection_scan_undefined_after_removal_ends_the_actual_caller_activation() {
    with_avm(8, |activation, _this| {
        let prototype = activation.prototypes().object;
        let source = Object::new(&activation.context.strings, Some(prototype));
        let output = Object::new(&activation.context.strings, Some(prototype));
        let owner = Object::new(&activation.context.strings, Some(prototype));
        let cache = Object::new_without_proto(activation.gc());
        let owns = FunctionObject::native(unload).build(&activation.context.strings, None, None);
        source.define_value(
            activation.gc(),
            AvmString::new_utf8(activation.gc(), "hasOwnProperty"),
            owns.into(),
            Attribute::DONT_ENUM,
        );
        let getter = FunctionObject::native(forbidden_read).build(&activation.context.strings, None, None);
        source.add_property(
            activation.gc(),
            AvmString::new_utf8(activation.gc(), "value"),
            getter,
            None,
            Attribute::empty(),
        );

        // Real ActionCallMethod stack convention: arguments are popped in
        // call order, followed by receiver and method-name dispatch.
        let operation = AvmString::new_utf8(activation.gc(), "run");
        let method = AvmString::new_utf8(activation.gc(), "boxheadNativeProjectionScanV1");
        let global = activation.global_object();
        for argument in [Value::Bool(false), owner.into(), cache.into(), output.into(), source.into(), operation.into()] {
            activation.context.avm1.push(argument);
        }
        activation.context.avm1.push(Value::Number(6.0));
        activation.context.avm1.push(global.into());
        activation.context.avm1.push(method.into());
        let control = activation.action_call_method()?;
        assert!(matches!(control, FrameControl::Return(ReturnType::Explicit(Value::Undefined))));
        assert!(activation.base_clip().avm1_removed());
        assert_eq!(activation.context.avm1.pop(), Value::Undefined);
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}

fn key<'gc>(activation: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), text)
}
fn ordinary<'gc>(activation: &Activation<'_, 'gc>) -> Object<'gc> {
    Object::new(&activation.context.strings, Some(activation.prototypes().object))
}
fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}
fn put<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(activation.gc(), key(activation, name), value, Attribute::DONT_ENUM);
}
fn stored<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Value<'gc> {
    object.get_data(key(activation, name), activation).unwrap_or(Value::Undefined)
}
fn mode(activation: &mut Activation<'_, '_>) -> u8 {
    let global = activation.global_object();
    match stored(activation, global, "fixtureMode") { Value::Number(mode) => mode as u8, _ => 0 }
}
fn record(activation: &mut Activation<'_, '_>, entry: &str) {
    let global = activation.global_object();
    let previous = match stored(activation, global, "trace") {
        Value::String(text) => text.to_utf8_lossy().into_owned(), _ => String::new(),
    };
    put(activation, global, "trace", key(activation, &(previous + entry + "|" )).into());
}
fn fixture_error<'gc>(activation: &Activation<'_, 'gc>) -> Error<'gc> {
    Error::ThrownValue(key(activation, "fixture exception").into())
}

fn array_lookup<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, "Array");
    if mode(activation) == 8 { return Err(fixture_error(activation)); }
    Ok(stored(activation, this, "fixtureConstructor"))
}
fn prototype_lookup<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, "prototype");
    if mode(activation) == 7 { return Err(fixture_error(activation)); }
    let global = activation.global_object();
    Ok(stored(activation, global, "fixturePrototype"))
}
fn construct<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, "construct");
    match mode(activation) {
        2 => return Ok(Value::Null),
        3 => return Ok(Value::Undefined),
        5 => { activation.base_clip().avm1_unload(activation.context); return Ok(this.into()); }
        9 => return Ok(Value::Number(7.0)),
        _ => {}
    }
    put(activation, this, "length", Value::Number(0.0));
    Ok(this.into())
}
fn keys_valueof<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, "keys.valueOf");
    Ok(if mode(activation) == 1 { Value::Undefined } else { this.into() })
}
fn push_lookup<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, "push.lookup");
    Ok(function(activation, push).into())
}
fn push<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let name = args[0].coerce_to_string(activation)?.to_utf8_lossy().into_owned();
    record(activation, &("push:".to_owned() + &name));
    match mode(activation) {
        4 => return Err(fixture_error(activation)),
        6 => { activation.base_clip().avm1_unload(activation.context); return Ok(Value::Undefined); }
        _ => {}
    }
    crate::avm1::globals::array::push(activation, this, args)
}

#[derive(Debug, PartialEq)]
struct Observation {
    trace: String,
    result: Vec<String>,
    failed: bool,
    removed: bool,
    returned: bool,
}

fn observe(native: bool, scenario: u8) -> Observation {
    let mut observation = None;
    with_avm(8, |activation, _this| {
        let global = activation.global_object();
        put(activation, global, "fixtureMode", Value::Number(scenario as f64));
        let proto = ordinary(activation);
        put(activation, proto, "valueOf", function(activation, keys_valueof).into());
        proto.add_property(activation.gc(), key(activation, "push"), function(activation, push_lookup), None, Attribute::DONT_ENUM);
        let constructor = FunctionObject::constructor(construct, None).build(&activation.context.strings, None, Some(proto));
        constructor.add_property(activation.gc(), key(activation, "prototype"), function(activation, prototype_lookup), None, Attribute::DONT_ENUM);
        put(activation, global, "fixturePrototype", proto.into());
        put(activation, global, "fixtureConstructor", constructor.into());
        global.add_property(activation.gc(), key(activation, "Array"), function(activation, array_lookup), None, Attribute::DONT_ENUM);
        let source = ordinary(activation);
        let leaf = ordinary(activation);
        for name in ["alpha", "omega"] {
            source.define_value(activation.gc(), key(activation, name), leaf.into(), Attribute::empty());
        }
        let names = source.get_keys(activation, false);
        let mut keys = Value::Undefined;
        let outcome = (|| -> Result<bool, Error<'_>> {
            if native {
                let output = ordinary(activation);
                let owner = ordinary(activation);
                let cache = Object::new_without_proto(activation.gc());
                for &name in &names { cache.define_value(activation.gc(), name, Value::Bool(false), Attribute::empty()); }
                let operation = key(activation, "run");
                for argument in [Value::Bool(false), owner.into(), cache.into(), output.into(), source.into(), operation.into()] {
                    activation.context.avm1.push(argument);
                }
                activation.context.avm1.push(Value::Number(6.0));
                activation.context.avm1.push(global.into());
                let method = key(activation, "boxheadNativeProjectionScanV1");
                activation.context.avm1.push(method.into());
                let control = activation.action_call_method()?;
                let result = activation.context.avm1.pop();
                if matches!(control, FrameControl::Return(_)) { return Ok(true); }
                let Value::Object(result) = result else { panic!("native envelope"); };
                keys = stored(activation, result, "keys");
            } else {
                for name in names {
                    // Execute the real unchanged equality, new-object and
                    // call-method opcodes, using their actual stack ABI.
                    activation.context.avm1.push(keys);
                    activation.context.avm1.push(Value::Undefined);
                    assert!(matches!(activation.action_equals_2()?, FrameControl::Continue));
                    let create = activation.context.avm1.pop().as_bool(activation.swf_version());
                    if create {
                        activation.context.avm1.push(Value::Number(0.0));
                        let array = key(activation, "Array");
                        activation.context.avm1.push(array.into());
                        let control = activation.action_new_object()?;
                        let value = activation.context.avm1.pop();
                        if matches!(control, FrameControl::Return(_)) { return Ok(true); }
                        keys = value;
                    }
                    activation.context.avm1.push(name.into());
                    activation.context.avm1.push(Value::Number(1.0));
                    activation.context.avm1.push(keys);
                    let method = key(activation, "push");
                    activation.context.avm1.push(method.into());
                    let control = activation.action_call_method()?;
                    activation.context.avm1.pop();
                    if matches!(control, FrameControl::Return(_)) { return Ok(true); }
                }
            }
            Ok(false)
        })();
        let failed = outcome.is_err();
        let returned = matches!(outcome, Ok(true));
        let mut result = vec![];
        if !failed && !returned {
            match keys {
                Value::Object(object) => {
                    for index in 0..object.length(activation)? {
                        result.push(object.get_element(activation, index).coerce_to_string(activation)?.to_utf8_lossy().into_owned());
                    }
                }
                value => result.push(value.coerce_to_string(activation)?.to_utf8_lossy().into_owned()),
            }
        }
        let trace = match stored(activation, global, "trace") {
            Value::String(value) => value.to_utf8_lossy().into_owned(), _ => String::new(),
        };
        observation = Some(Observation { trace, result, failed, removed: activation.base_clip().avm1_removed(), returned });
        Ok(())
    });
    observation.expect("fixture observation")
}

#[test]
fn native_projection_scan_defer_matches_real_equality_newobject_and_callmethod_opcodes() {
    // Default dynamic constructor, null-like keys, null/undefined/primitive
    // returns, throwing push/prototype/Array getters, and both unload sites.
    for scenario in 0..10 {
        assert_eq!(observe(false, scenario), observe(true, scenario), "scenario {scenario}");
    }
}

