//! Optional Boxhead scalar-loop experiment. No game objects survive a call.
//!
//! This is deliberately a loop fusion, not a raw-slot projection: enumerate
//! once, call the current hasOwnProperty method for each listed key, read the
//! current value once, then apply the existing AS2 field policy and normal
//! property writes. Unsupported source kinds are rejected before enumeration.

use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::ExecutionReason;
use crate::avm1::object::NativeObject;
use crate::avm1::property::Attribute;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;
use ruffle_macros::istr;

const MAX_COUNTER: u64 = (1_u64 << 53) - 1;
const TIMEOUT_KEY_INTERVAL: usize = 32;

/// The only state retained by the experiment: exact integer witnesses, with
/// no GC pointers, source/output/cache references or source-shape information.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct NativeScalarStats {
    calls: u64,
    completed: u64,
    unsupported: u64,
    keys: u64,
    own_reads: u64,
}

fn increment(counter: &mut u64) -> bool {
    if *counter >= MAX_COUNTER {
        false
    } else {
        *counter += 1;
        true
    }
}

fn rejected<'gc>(activation: &mut Activation<'_, 'gc>, message: &str) -> Error<'gc> {
    Error::ThrownValue(Value::String(AvmString::new_utf8(activation.gc(), message)))
}

fn timeout<'gc>(activation: &Activation<'_, 'gc>) -> Result<(), Error<'gc>> {
    if activation.context.update_start.elapsed() >= activation.context.max_execution_duration {
        Err(Error::ExecutionTimeout)
    } else {
        Ok(())
    }
}

/// Registered as a non-enumerable, read-only global. Native functions execute
/// in their caller's Activation, preserving its SWF version, scope and clip.
pub fn call<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let Some(Value::String(operation)) = args.first() else {
        return Err(rejected(activation, "Native scalar operation must be a string"));
    };
    if operation.eq_with_case(b"capability", true) {
        if args.len() != 1 {
            return Err(rejected(activation, "Native scalar capability takes no arguments"));
        }
        return Ok(capability(activation).into());
    }
    if !operation.eq_with_case(b"run", true) || args.len() != 5 {
        return Err(rejected(activation, "Invalid native scalar operation or argument count"));
    }
    run(activation, args[1], args[2], args[3], args[4])
}

fn capability<'gc>(activation: &mut Activation<'_, 'gc>) -> Object<'gc> {
    // The witness is a fresh data-only envelope. Defining the metadata fields
    // directly avoids invoking user setters during this diagnostic query.
    let stats = activation.context.avm1.native_scalar_stats;
    let object = Object::new(&activation.context.strings, Some(activation.prototypes().object));
    for (name, value) in [
        ("version", Value::Number(1.0)),
        (
            "contract",
            Value::String(AvmString::new_utf8(activation.gc(), "bh-scalars-thing-v1")),
        ),
        ("calls", Value::Number(stats.calls as f64)),
        ("completed", Value::Number(stats.completed as f64)),
        ("unsupported", Value::Number(stats.unsupported as f64)),
        ("keys", Value::Number(stats.keys as f64)),
        ("ownReads", Value::Number(stats.own_reads as f64)),
    ] {
        object.define_value(
            activation.gc(),
            AvmString::new_utf8(activation.gc(), name),
            value,
            Attribute::empty(),
        );
    }
    object
}

fn ordinary<'gc>(value: Value<'gc>) -> Option<Object<'gc>> {
    match value {
        Value::Object(object) if matches!(object.native(), NativeObject::None) => Some(object),
        _ => None,
    }
}

fn member<'gc>(
    value: Value<'gc>,
    key: AvmString<'gc>,
    activation: &mut Activation<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    // Match ActionGetMember even if a policy callback changed the cache's type.
    value.coerce_to_object_or_bare(activation)?.get(key, activation)
}

fn run<'gc>(
    activation: &mut Activation<'_, 'gc>,
    source_value: Value<'gc>,
    output_value: Value<'gc>,
    mut field_cache: Value<'gc>,
    owner_value: Value<'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    // No source key/property inspection belongs in this preflight. The AS2
    // caller already created its ordinary output and initialized its local
    // cache in the old order. A false result reuses those same objects.
    let Some(output) = ordinary(output_value) else {
        return Err(rejected(activation, "Native scalar output must be an ordinary object"));
    };
    let Value::Object(owner) = owner_value else {
        return Err(rejected(activation, "Native scalar policy owner must be an object"));
    };
    if ordinary(field_cache).is_none() {
        return Err(rejected(activation, "Native scalar initial cache must be an ordinary object"));
    }
    if Object::ptr_eq(output, owner)
        || matches!(source_value, Value::Object(object) if Object::ptr_eq(output, object))
        || matches!(field_cache, Value::Object(object) if Object::ptr_eq(output, object))
    {
        return Err(rejected(activation, "Native scalar output aliases an input"));
    }
    if !increment(&mut activation.context.avm1.native_scalar_stats.calls) {
        return Err(rejected(activation, "Native scalar witness overflow"));
    }
    let Some(source) = ordinary(source_value) else {
        if !increment(&mut activation.context.avm1.native_scalar_stats.unsupported) {
            return Err(rejected(activation, "Native scalar witness overflow"));
        }
        return Ok(Value::Bool(false));
    };

    timeout(activation)?;
    // ActionEnumerate2 pushes get_keys(false) in reverse and then consumes its
    // stack. Iterating this Vec forwards therefore preserves the AS2 order.
    // A later getter can change membership/values, but not the collected list.
    let keys = source.get_keys(activation, false);
    // The pinned CommonStrings has no hasOwnProperty entry. Reuse only its
    // name; source.call_method still resolves the current method per key.
    let has_own_property = AvmString::new_utf8(activation.gc(), "hasOwnProperty");
    let mut own_reads: u64 = 0;
    for (index, key) in keys.into_iter().enumerate() {
        if index % TIMEOUT_KEY_INTERVAL == 0 {
            timeout(activation)?;
        }
        if !increment(&mut activation.context.avm1.native_scalar_stats.keys) {
            return Err(rejected(activation, "Native scalar witness overflow"));
        }
        let owns = source.call_method(
            has_own_property,
            &[key.into()],
            activation,
            ExecutionReason::FunctionCall,
        )?;
        // ActionCallMethod ends the caller activation after a removed base
        // clip. Returning here lets the outer native call perform that same
        // check without reading another source value or publishing a result.
        if activation.base_clip().avm1_removed() {
            return Ok(Value::Undefined);
        }
        if !owns.as_bool(activation.swf_version()) {
            continue;
        }

        // This read stays before type/policy filtering, including fields that
        // will be omitted. Never use get_local_stored or own_properties here.
        let value = source.get(key, activation)?;
        if !increment(&mut own_reads)
            || !increment(&mut activation.context.avm1.native_scalar_stats.own_reads)
        {
            return Err(rejected(activation, "Native scalar witness overflow"));
        }
        if !matches!(value, Value::Number(_) | Value::Bool(_) | Value::String(_)) {
            continue;
        }

        let mut skip = member(field_cache, key, activation)?;
        // AVM1's loose comparison is intentional: bare objects are not safely
        // comparable with Rust's undefined discriminant test.
        if skip.abstract_eq(Value::Undefined, activation)? {
            skip = owner.call_method(
                AvmString::new_utf8(activation.gc(), "BH_SkipField"),
                &[key.into()],
                activation,
                ExecutionReason::FunctionCall,
            )?;
            if activation.base_clip().avm1_removed() {
                return Ok(Value::Undefined);
            }
            field_cache = owner.get(
                AvmString::new_utf8(activation.gc(), "mBHFieldCache"),
                activation,
            )?;
        }
        if skip.as_bool(activation.swf_version()) {
            continue;
        }

        let projected = match value {
            Value::Number(number) if !number.is_finite() => {
                // The AS2 helper retains the actual String(value) expression
                // and its scope/overrides; the common finite path makes no
                // additional script call. Build the tag exactly as InitObject.
                let text = owner.call_method(
                    AvmString::new_utf8(activation.gc(), "BH_NativeScalarString"),
                    &[value],
                    activation,
                    ExecutionReason::FunctionCall,
                )?;
                if activation.base_clip().avm1_removed() {
                    return Ok(Value::Undefined);
                }
                let proto = activation.resolve_prototype([istr!(activation, "Object")]);
                let tag = Object::new(&activation.context.strings, proto);
                tag.set(
                    AvmString::new_utf8(activation.gc(), "$number"),
                    text,
                    activation,
                )?;
                Value::Object(tag)
            }
            // Keep the original finite number bits, especially negative zero.
            value => value,
        };
        output.set(key, projected, activation)?;
    }
    timeout(activation)?;
    if !increment(&mut activation.context.avm1.native_scalar_stats.completed) {
        return Err(rejected(activation, "Native scalar witness overflow"));
    }
    Ok(Value::Number(own_reads as f64))
}

#[cfg(test)]
mod tests;
