//! This module is included only beneath activation.rs under cfg(test), so it
//! can exercise the unchanged real ActionCallMethod completion boundary.

use super::{Activation, FrameControl, ReturnType};
use crate::avm1::error::Error;
use crate::avm1::function::FunctionObject;
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
fn native_scalar_undefined_after_removal_ends_the_actual_caller_activation() {
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
        let method = AvmString::new_utf8(activation.gc(), "boxheadNativeScalarsV1");
        let global = activation.global_object();
        for argument in [owner.into(), cache.into(), output.into(), source.into(), operation.into()] {
            activation.context.avm1.push(argument);
        }
        activation.context.avm1.push(Value::Number(5.0));
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
