//! Included beneath activation.rs so the private real ActionCallMethod
//! completion boundary is tested without changing the engine interpreter.

use super::{FrameControl, ReturnType};
use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::globals::array::ArrayBuilder;
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;

fn key<'gc>(activation: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), text)
}
fn object<'gc>(activation: &Activation<'_, 'gc>) -> Object<'gc> {
    Object::new(&activation.context.strings, Some(activation.prototypes().object))
}
fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}
fn define<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(activation.gc(), key(activation, name), value, Attribute::DONT_ENUM);
}
fn forbidden<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    define(activation, global, "unexpectedSourceRead", true.into());
    Err(Error::ThrownValue(key(activation, "source read after removal").into()))
}
fn unload<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    activation.base_clip().avm1_unload(activation.context);
    Ok(true.into())
}

#[test]
fn native_project_removal_returns_through_the_real_action_call_method_boundary() {
    with_avm(8, |activation, _| {
        let owner = object(activation);
        let expected = function(activation, forbidden);
        define(activation, owner, "BH_Project", expected.into());
        let cache = Object::new_without_proto(activation.gc());
        define(activation, owner, "mBHFieldCache", cache.into());
        let global = activation.global_object();
        define(activation, global, "CMain", owner.into());

        let context = object(activation);
        let objects = ArrayBuilder::new(activation).with([]);
        let path = ArrayBuilder::new(activation).with([]);
        define(activation, context, "objects", objects.into());
        define(activation, context, "errorPath", path.into());
        define(activation, context, "fields", 0.0.into());
        define(activation, context, "projectionKernel", Value::Undefined);
        define(activation, context, "nativeProjectOwner", owner.into());
        define(activation, context, "nativeProjectFunction", expected.into());

        let source = object(activation);
        define(activation, source, "hasOwnProperty", function(activation, unload).into());
        source.add_property(activation.gc(), key(activation, "unread"), function(activation, forbidden), None, Attribute::empty());
        let operation = key(activation, "run");
        for argument in [owner.into(), context.into(), source.into(), operation.into()] {
            activation.context.avm1.push(argument);
        }
        activation.context.avm1.push(4.0.into());
        activation.context.avm1.push(global.into());
        let method = key(activation, "boxheadNativeProjectV1");
        activation.context.avm1.push(method.into());
        let control = activation.action_call_method()?;
        assert!(matches!(control, FrameControl::Return(ReturnType::Explicit(Value::Undefined))));
        assert_eq!(activation.context.avm1.pop(), Value::Undefined);
        assert!(activation.base_clip().avm1_removed());
        assert_eq!(objects.length(activation)?, 1);
        assert_eq!(global.get_data(key(activation, "unexpectedSourceRead"), activation), None);
        Ok(())
    });
}

fn unload_nan<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    activation.base_clip().avm1_unload(activation.context);
    Ok(f64::NAN.into())
}
fn conversion_after_removal<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    define(activation, global, "convertedAfterRemoval", true.into());
    Ok(args[0].coerce_to_string(activation)?.into())
}

#[test]
fn active_scan_nonfinite_helper_keeps_its_real_removal_boundary_before_result_validation() {
    with_avm(8, |activation, _| {
        let owner = object(activation);
        let expected = function(activation, forbidden);
        define(activation, owner, "BH_Project", expected.into());
        define(activation, owner, "BH_Integer", function(activation, forbidden).into());
        define(activation, owner, "BH_NativeScalarString", function(activation, conversion_after_removal).into());
        let cache = Object::new_without_proto(activation.gc());
        define(activation, cache, "nan", false.into());
        define(activation, owner, "mBHFieldCache", cache.into());
        let global = activation.global_object();
        define(activation, global, "CMain", owner.into());
        let scan = global.get(key(activation, "boxheadNativeProjectionScanV1"), activation)?;
        let context = object(activation);
        let objects = ArrayBuilder::new(activation).with([]);
        let path = ArrayBuilder::new(activation).with([]);
        define(activation, context, "objects", objects.into());
        define(activation, context, "errorPath", path.into());
        define(activation, context, "fields", 0.0.into());
        define(activation, context, "projectionKernel", scan);
        define(activation, context, "nativeProjectOwner", owner.into());
        define(activation, context, "nativeProjectFunction", expected.into());
        let source = object(activation);
        source.add_property(activation.gc(), key(activation, "nan"), function(activation, unload_nan), None, Attribute::empty());
        let operation = key(activation, "run");
        for argument in [owner.into(), context.into(), source.into(), operation.into()] {
            activation.context.avm1.push(argument);
        }
        activation.context.avm1.push(4.0.into());
        activation.context.avm1.push(global.into());
        let method = key(activation, "boxheadNativeProjectV1");
        activation.context.avm1.push(method.into());
        let control = activation.action_call_method()?;
        assert!(matches!(control, FrameControl::Return(ReturnType::Explicit(Value::Undefined))));
        assert_eq!(activation.context.avm1.pop(), Value::Undefined);
        assert!(activation.base_clip().avm1_removed());
        assert_eq!(global.get_data(key(activation, "convertedAfterRemoval"), activation), Some(true.into()));
        assert_eq!(global.get_data(key(activation, "unexpectedSourceRead"), activation), None);
        assert_eq!(objects.length(activation)?, 1);
        Ok(())
    });
}
