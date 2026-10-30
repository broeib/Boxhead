//! Scan-only fusion of CMain.BH_Project's own-field loop.
//!
//! The AS2 caller still owns identity marks, recursion, sorted reference IDs,
//! metadata, upgrade expansion and the checksum. No source shapes or values
//! survive this call. All enumeration, method lookup, getters, coercions and
//! writes go through the same pinned AVM1 operations as the original loop.

use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::ExecutionReason;
use crate::avm1::object::NativeObject;
use crate::avm1::property::Attribute;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;
use ruffle_macros::istr;
use super::boxhead_native_project::lookup_names::FixedName;

const MAX_COUNTER: u64 = (1_u64 << 53) - 1;
const TIMEOUT_KEY_INTERVAL: usize = 32;

/// Per-AVM1 diagnostics only. In particular, this contains no GC pointers.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct NativeProjectionScanStats {
    calls: u64,
    completed: u64,
    unsupported: u64,
    keys: u64,
    own_reads: u64,
}

// Read-only v5 observer. The public AVM1 ABI and every scan operation remain
// unchanged. A numeric copy avoids allocating capability objects solely to
// account for delegated work inside the full native projector.
impl NativeProjectionScanStats {
    pub(crate) fn work_counts(self) -> (u64, u64) {
        (self.keys, self.own_reads)
    }
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

/// Native functions execute in the caller Activation, including its scope,
/// SWF version and base clip. The old scalar/global ABI is not changed.
pub fn call<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let Some(Value::String(operation)) = args.first() else {
        return Err(rejected(activation, "Native projection operation must be a string"));
    };
    if operation.eq_with_case(b"capability", true) {
        if args.len() != 1 {
            return Err(rejected(activation, "Native projection capability takes no arguments"));
        }
        return Ok(capability(activation).into());
    }
    if !operation.eq_with_case(b"run", true) || args.len() != 6 {
        return Err(rejected(activation, "Invalid native projection operation or argument count"));
    }
    run(activation, args[1], args[2], args[3], args[4], args[5])
}

fn data_object<'gc>(
    activation: &mut Activation<'_, 'gc>,
    fields: &[(FixedName, Value<'gc>)],
) -> Object<'gc> {
    // ABI envelopes are fresh, private data. Do not run prototype setters
    // while publishing diagnostics. Projected tags/fields use normal set.
    let object = Object::new(&activation.context.strings, Some(activation.prototypes().object));
    for &(key, value) in fields {
        let key = key.intern(activation);
        object.define_value(
            activation.gc(),
            key,
            value,
            Attribute::empty(),
        );
    }
    object
}

fn capability<'gc>(activation: &mut Activation<'_, 'gc>) -> Object<'gc> {
    let stats = activation.context.avm1.native_projection_scan_stats;
    let contract = AvmString::new_utf8(activation.gc(), "bh-projection-scan-v1");
    data_object(activation, &[
        (FixedName::Version, Value::Number(1.0)),
        (FixedName::Contract, contract.into()),
        (FixedName::Calls, Value::Number(stats.calls as f64)),
        (FixedName::Completed, Value::Number(stats.completed as f64)),
        (FixedName::Unsupported, Value::Number(stats.unsupported as f64)),
        (FixedName::Keys, Value::Number(stats.keys as f64)),
        (FixedName::OwnReads, Value::Number(stats.own_reads as f64)),
    ])
}

fn ordinary<'gc>(value: Value<'gc>) -> Option<Object<'gc>> {
    match value {
        Value::Object(object) if matches!(object.native(), NativeObject::None) => Some(object),
        _ => None,
    }
}

fn source_object<'gc>(value: Value<'gc>) -> Option<Object<'gc>> {
    match value {
        Value::Object(object)
            if matches!(object.native(), NativeObject::None | NativeObject::Array(_)) => Some(object),
        _ => None,
    }
}

fn member<'gc>(
    value: Value<'gc>,
    key: AvmString<'gc>,
    activation: &mut Activation<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    // A policy callback may replace the field cache with a primitive. Match
    // ActionGetMember again on each key; do not retain a validated Object.
    value.coerce_to_object_or_bare(activation)?.get(key, activation)
}

fn tag<'gc>(
    activation: &mut Activation<'_, 'gc>,
    key: FixedName,
    value: Value<'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    // Exactly the one-property ActionInitObject sequence, including current
    // Object prototype resolution and inherited setters/watchers.
    let proto = activation.resolve_prototype([istr!(activation, "Object")]);
    let result = Object::new(&activation.context.strings, proto);
    result.set(key.intern(activation), value, activation)?;
    Ok(result.into())
}

/// Mirrors the pinned ActionNewObject + ActionCallMethod implementation for
/// `if (keys == undefined) keys = new Array(); keys.push(key);`.
/// Native calls do not create an Activation, so resolve("Array") sees the
/// original BH_Project scope. The constructor and push method are resolved
/// live at their original positions, including arbitrary overrides.
/// False means an explicit call removed the base clip; it is NOT fallback.
fn defer<'gc>(
    activation: &mut Activation<'_, 'gc>,
    keys: &mut Value<'gc>,
    key: AvmString<'gc>,
    push_name: AvmString<'gc>,
) -> Result<bool, Error<'gc>> {
    if keys.abstract_eq(Value::Undefined, activation)? {
        let array_name = FixedName::Array.intern(activation);
        let constructor_value: Value<'gc> = activation.resolve(array_name)?.into();
        let constructor = constructor_value.coerce_to_object_or_bare(activation)?;
        *keys = constructor.construct(activation, &[])?;
        if activation.base_clip().avm1_removed() {
            return Ok(false);
        }
    }
    // The original ActionCallMethod null/undefined branch does not coerce,
    // call __resolve, or check the removed base clip.
    if !matches!(*keys, Value::Undefined | Value::Null) {
        let object = keys.coerce_to_object_or_bare(activation)?;
        object.call_method(push_name, &[key.into()], activation, ExecutionReason::FunctionCall)?;
        if activation.base_clip().avm1_removed() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn unsupported<'gc>(activation: &mut Activation<'_, 'gc>) -> Result<Value<'gc>, Error<'gc>> {
    if !increment(&mut activation.context.avm1.native_projection_scan_stats.unsupported) {
        return Err(rejected(activation, "Native projection witness overflow"));
    }
    Ok(Value::Bool(false))
}

fn run<'gc>(
    activation: &mut Activation<'_, 'gc>,
    source_value: Value<'gc>,
    output_value: Value<'gc>,
    mut field_cache: Value<'gc>,
    owner_value: Value<'gc>,
    upgrades_value: Value<'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    if !increment(&mut activation.context.avm1.native_projection_scan_stats.calls) {
        return Err(rejected(activation, "Native projection witness overflow"));
    }
    // Structural checks only: no enumeration, property lookup, coercion,
    // getter or script callback is permitted before a false fallback.
    let (Some(source), Some(output), Some(cache), Value::Object(owner), Value::Bool(upgrades)) = (
        source_object(source_value), ordinary(output_value), ordinary(field_cache), owner_value, upgrades_value,
    ) else {
        return unsupported(activation);
    };
    if Object::ptr_eq(output, source) || Object::ptr_eq(output, cache) || Object::ptr_eq(output, owner) {
        return unsupported(activation);
    }

    timeout(activation)?;
    // ActionEnumerate2 pushes this vector in reverse and consumes its stack;
    // iterating forwards matches its order. Later mutations affect live
    // membership/reads but must not add keys to this captured list.
    let source_keys = source.get_keys(activation, false);
    let has_own_property = FixedName::HasOwnProperty.intern(activation);
    let skip_field = FixedName::BHSkipField.intern(activation);
    let cache_name = FixedName::MBHFieldCache.intern(activation);
    let push_name = FixedName::Push.intern(activation);
    let mut keys = Value::Undefined;
    let mut scalar_fields: u64 = 0;

    for (index, key) in source_keys.into_iter().enumerate() {
        if index % TIMEOUT_KEY_INTERVAL == 0 {
            timeout(activation)?;
        }
        if !increment(&mut activation.context.avm1.native_projection_scan_stats.keys) {
            return Err(rejected(activation, "Native projection witness overflow"));
        }
        let owns = source.call_method(has_own_property, &[key.into()], activation, ExecutionReason::FunctionCall)?;
        if activation.base_clip().avm1_removed() {
            return Ok(Value::Undefined);
        }
        if !owns.as_bool(activation.swf_version()) {
            continue;
        }

        // Includes keys later omitted by type, policy, or upgrade specialcase.
        let leaf = source.get(key, activation)?;
        if !increment(&mut activation.context.avm1.native_projection_scan_stats.own_reads) {
            return Err(rejected(activation, "Native projection witness overflow"));
        }
        if matches!(leaf, Value::Object(object) if object.as_function().is_some()) {
            continue;
        }

        let mut skip = member(field_cache, key, activation)?;
        if skip.abstract_eq(Value::Undefined, activation)? {
            skip = owner.call_method(skip_field, &[key.into()], activation, ExecutionReason::FunctionCall)?;
            if activation.base_clip().avm1_removed() {
                return Ok(Value::Undefined);
            }
            field_cache = owner.get(cache_name, activation)?;
        }
        if skip.as_bool(activation.swf_version()) {
            continue;
        }
        if upgrades && key.eq_with_case(b"mLevels", true) {
            continue;
        }
        if upgrades && key.eq_with_case(b"mMultipliers", true) {
            if !defer(activation, &mut keys, key, push_name)? {
                return Ok(Value::Undefined);
            }
            continue;
        }

        let projected = if matches!(leaf, Value::Undefined) {
            tag(activation, FixedName::TagUndefined, Value::Number(1.0))?
        } else if leaf.abstract_eq(Value::Null, activation)?
            || matches!(leaf, Value::String(_) | Value::Bool(_))
        {
            // Loose null comparison deliberately precedes the type checks:
            // an object valueOf may run, throw, mutate, or return null.
            leaf
        } else if let Value::Number(number) = leaf {
            if number.is_finite() {
                // Preserve all finite f64 bits, particularly negative zero.
                leaf
            } else {
                let text = owner.call_method(
                    FixedName::BHNativeScalarString.intern(activation),
                    &[leaf], activation, ExecutionReason::FunctionCall,
                )?;
                if activation.base_clip().avm1_removed() {
                    return Ok(Value::Undefined);
                }
                tag(activation, FixedName::TagNumber, text)?
            }
        } else {
            if !defer(activation, &mut keys, key, push_name)? {
                return Ok(Value::Undefined);
            }
            continue;
        };
        output.set(key, projected, activation)?;
        if !increment(&mut scalar_fields) {
            return Err(rejected(activation, "Native projection field count overflow"));
        }
    }

    timeout(activation)?;
    if !increment(&mut activation.context.avm1.native_projection_scan_stats.completed) {
        return Err(rejected(activation, "Native projection witness overflow"));
    }
    Ok(data_object(activation, &[
        (FixedName::Version, Value::Number(1.0)),
        (FixedName::ScalarFields, Value::Number(scalar_fields as f64)),
        (FixedName::Keys, keys),
    ]).into())
}

#[cfg(test)]
mod tests;
