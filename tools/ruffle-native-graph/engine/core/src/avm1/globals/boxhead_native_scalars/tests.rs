//! Engine-level semantic fixtures. The companion AS2 probe separately compares
//! the actual original scalar source with this builtin on the compiled SWF.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::test_utils::with_avm;
use std::time::Duration;

fn name<'gc>(activation: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), value)
}

fn object<'gc>(activation: &Activation<'_, 'gc>) -> Object<'gc> {
    Object::new(&activation.context.strings, Some(activation.prototypes().object))
}

fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}

fn define<'gc>(
    activation: &Activation<'_, 'gc>,
    object: Object<'gc>,
    key: &str,
    value: Value<'gc>,
    attributes: Attribute,
) {
    object.define_value(activation.gc(), name(activation, key), value, attributes);
}

fn stored<'gc>(
    activation: &mut Activation<'_, 'gc>,
    object: Object<'gc>,
    key: &str,
) -> Value<'gc> {
    object.get_data(name(activation, key), activation).unwrap_or(Value::Undefined)
}

fn add_count<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, key: &str) -> u64 {
    let count = match stored(activation, owner, key) {
        Value::Number(value) => value as u64,
        _ => 0,
    } + 1;
    define(activation, owner, key, Value::Number(count as f64), Attribute::DONT_ENUM);
    count
}

fn string_value<'gc>(
    activation: &mut Activation<'_, 'gc>,
    owner: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, owner, "stringCalls");
    Ok(args[0].coerce_to_string(activation)?.into())
}

fn skip_false<'gc>(
    activation: &mut Activation<'_, 'gc>,
    owner: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, owner, "policyCalls");
    let Value::Object(cache) = stored(activation, owner, "mBHFieldCache") else {
        panic!("fixture cache must be an object");
    };
    let key = args[0].coerce_to_string(activation)?;
    cache.set(key, Value::Bool(false), activation)?;
    Ok(Value::Bool(false))
}

fn owner_and_cache<'gc>(activation: &Activation<'_, 'gc>) -> (Object<'gc>, Object<'gc>) {
    let owner = object(activation);
    let cache = Object::new_without_proto(activation.gc());
    define(activation, owner, "mBHFieldCache", cache.into(), Attribute::empty());
    define(activation, owner, "BH_SkipField", function(activation, skip_false).into(), Attribute::DONT_ENUM);
    define(activation, owner, "BH_NativeScalarString", function(activation, string_value).into(), Attribute::DONT_ENUM);
    (owner, cache)
}

fn invoke<'gc>(
    activation: &mut Activation<'_, 'gc>,
    source: Value<'gc>,
    output: Object<'gc>,
    cache: Object<'gc>,
    owner: Object<'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    let operation = name(activation, "run");
    call(activation, global, &[operation.into(), source, output.into(), cache.into(), owner.into()])
}

fn throws<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    Err(rejected(activation, "fixture getter throw"))
}

#[test]
fn registered_capability_is_hidden_readonly_fresh_and_data_only() {
    with_avm(8, |activation, _this| {
        let global = activation.global_object();
        let key = name(activation, "boxheadNativeScalarsV1");
        let before = global.get(key, activation)?;
        assert!(matches!(before, Value::Object(value) if value.as_function().is_some()));
        assert!(!global.get_keys(activation, false).contains(&key));
        global.set(key, Value::Undefined, activation)?;
        assert_eq!(global.get(key, activation)?, before);

        let operation = name(activation, "capability");
        let first = global.call_method(key, &[operation.into()], activation, ExecutionReason::FunctionCall)?;
        let second = global.call_method(key, &[operation.into()], activation, ExecutionReason::FunctionCall)?;
        let (Value::Object(first), Value::Object(second)) = (first, second) else {
            panic!("capability must return objects");
        };
        assert!(!Object::ptr_eq(first, second));
        assert_eq!(first.get_keys(activation, false).len(), 7);
        assert_eq!(stored(activation, first, "version"), Value::Number(1.0));
        for key in ["calls", "completed", "unsupported", "keys", "ownReads"] {
            assert_eq!(stored(activation, first, key), Value::Number(0.0));
        }
        assert_eq!(activation.context.avm1.native_scalar_stats.calls, 0);
        Ok(())
    });
}

#[test]
fn unsupported_kinds_and_malformed_arguments_never_read_source_properties() {
    with_avm(8, |activation, root| {
        let array = Object::new_with_native(&activation.context.strings, Some(activation.prototypes().array), NativeObject::Array(()));
        let getter = function(activation, throws);
        array.add_property(activation.gc(), name(activation, "failIfRead"), getter, None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        for source in [array.into(), root.into(), Value::Undefined, Value::Number(7.0)] {
            assert_eq!(invoke(activation, source, output, cache, owner)?, Value::Bool(false));
        }
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.unsupported, stats.keys, stats.own_reads), (4, 0, 4, 0, 0));
        assert!(output.get_keys(activation, false).is_empty());
        let source = object(activation);
        assert!(matches!(invoke(activation, source.into(), source, cache, owner), Err(Error::ThrownValue(_))));
        let global = activation.global_object();
        let operation = name(activation, "run");
        assert!(matches!(call(activation, global, &[operation.into()]), Err(Error::ThrownValue(_))));
        assert_eq!(activation.context.avm1.native_scalar_stats.keys, 0);
        Ok(())
    });
}

fn owns_true<'gc>(
    _activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    Ok(Value::Bool(true))
}

fn owns_false<'gc>(
    _activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    Ok(Value::Bool(false))
}

fn changing_own_method<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let count = add_count(activation, this, "lookupCount");
    Ok(stored(activation, this, if count == 1 { "firstOwnMethod" } else { "laterOwnMethod" }))
}

#[test]
fn own_method_is_resolved_live_for_every_collected_key() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "a", Value::Number(1.0), Attribute::empty());
        define(activation, source, "b", Value::Number(2.0), Attribute::empty());
        define(activation, source, "firstOwnMethod", function(activation, owns_true).into(), Attribute::DONT_ENUM);
        define(activation, source, "laterOwnMethod", function(activation, owns_false).into(), Attribute::DONT_ENUM);
        let getter = function(activation, changing_own_method);
        source.add_property(activation.gc(), name(activation, "hasOwnProperty"), getter, None, Attribute::DONT_ENUM);
        let keys = source.get_keys(activation, false);
        assert_eq!(keys.len(), 2);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(1.0));
        assert_eq!(stored(activation, source, "lookupCount"), Value::Number(2.0));
        assert!(output.has_own_property(activation, keys[0]));
        assert!(!output.has_own_property(activation, keys[1]));
        assert_eq!(activation.context.avm1.native_scalar_stats.keys, 2);
        Ok(())
    });
}

fn delete_later_key<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, this, "getterCalls");
    let Value::String(victim) = stored(activation, this, "victim") else {
        panic!("fixture victim name");
    };
    this.delete(activation, victim);
    this.set(name(activation, "addedAfterEnumeration"), Value::Number(99.0), activation)?;
    Ok(Value::Number(17.0))
}

#[test]
fn getter_mutation_uses_the_original_key_list_and_live_membership() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "a", Value::Number(1.0), Attribute::empty());
        define(activation, source, "b", Value::Number(2.0), Attribute::empty());
        let keys = source.get_keys(activation, false);
        define(activation, source, "victim", keys[1].into(), Attribute::DONT_ENUM);
        let getter = function(activation, delete_later_key);
        source.add_property(activation.gc(), keys[0], getter, None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(1.0));
        assert_eq!(output.get(keys[0], activation)?, Value::Number(17.0));
        assert!(!output.has_own_property(activation, keys[1]));
        let late = name(activation, "addedAfterEnumeration");
        assert!(source.has_own_property(activation, late));
        assert!(!output.has_own_property(activation, late));
        assert_eq!(stored(activation, source, "getterCalls"), Value::Number(1.0));
        assert_eq!(activation.context.avm1.native_scalar_stats.keys, 2);
        Ok(())
    });
}

fn replace_cache<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, this, "policyCalls");
    let next = Object::new_without_proto(activation.gc());
    let current = args[0].coerce_to_string(activation)?;
    next.set(current, Value::Bool(false), activation)?;
    let Value::String(skip) = stored(activation, this, "skipNext") else {
        panic!("fixture skip name");
    };
    next.set(skip, Value::Bool(true), activation)?;
    this.set(name(activation, "mBHFieldCache"), next, activation)?;
    Ok(Value::Bool(false))
}

#[test]
fn policy_miss_refreshes_the_local_cache_before_the_next_key() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "a", Value::Number(1.0), Attribute::empty());
        define(activation, source, "b", Value::Number(2.0), Attribute::empty());
        let keys = source.get_keys(activation, false);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        define(activation, owner, "skipNext", keys[1].into(), Attribute::DONT_ENUM);
        define(activation, owner, "BH_SkipField", function(activation, replace_cache).into(), Attribute::DONT_ENUM);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(2.0));
        assert!(output.has_own_property(activation, keys[0]));
        assert!(!output.has_own_property(activation, keys[1]));
        assert_eq!(stored(activation, owner, "policyCalls"), Value::Number(1.0));
        assert!(cache.get_keys(activation, false).is_empty());
        assert_ne!(stored(activation, owner, "mBHFieldCache"), Value::Object(cache));
        Ok(())
    });
}

#[test]
fn finite_bits_and_nonfinite_tags_are_preserved_without_value_caching() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        for (key, number) in [
            ("negativeZero", -0.0), ("maximum", f64::MAX), ("minimumNormal", f64::MIN_POSITIVE),
            ("subnormal", f64::from_bits(1)), ("nan", f64::NAN),
            ("positiveInfinity", f64::INFINITY), ("negativeInfinity", f64::NEG_INFINITY),
        ] {
            define(activation, source, key, Value::Number(number), Attribute::empty());
        }
        define(activation, source, "nullValue", Value::Null, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(8.0));
        for (key, expected) in [("negativeZero", -0.0_f64), ("maximum", f64::MAX),
            ("minimumNormal", f64::MIN_POSITIVE), ("subnormal", f64::from_bits(1))] {
            let Value::Number(actual) = output.get(name(activation, key), activation)? else {
                panic!("finite result must remain a number");
            };
            assert_eq!(actual.to_bits(), expected.to_bits());
        }
        for (key, expected) in [("nan", "NaN"), ("positiveInfinity", "Infinity"), ("negativeInfinity", "-Infinity")] {
            let Value::Object(tag) = output.get(name(activation, key), activation)? else {
                panic!("nonfinite result must be a tag object");
            };
            let Value::String(text) = tag.get(name(activation, "$number"), activation)? else {
                panic!("tag text");
            };
            assert_eq!(text.to_utf8_lossy(), expected);
        }
        let null_key = name(activation, "nullValue");
        assert!(!output.has_own_property(activation, null_key));
        assert_eq!(stored(activation, owner, "stringCalls"), Value::Number(3.0));
        source.set(name(activation, "maximum"), Value::Number(123.0), activation)?;
        let second = object(activation);
        invoke(activation, source.into(), second, cache, owner)?;
        assert_eq!(second.get(name(activation, "maximum"), activation)?, Value::Number(123.0));
        assert_eq!(output.get(name(activation, "maximum"), activation)?, Value::Number(f64::MAX));
        Ok(())
    });
}

#[test]
fn getter_exceptions_are_not_retried_or_published_as_completed() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let getter = function(activation, throws);
        source.add_property(activation.gc(), name(activation, "value"), getter, None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let result = invoke(activation, source.into(), output, cache, owner);
        assert!(matches!(result, Err(Error::ThrownValue(Value::String(text))) if text.eq_with_case(b"fixture getter throw", true)));
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 1, 0));
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}

fn intercept_write<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    define(activation, this, "capturedWrite", args[0], Attribute::DONT_ENUM);
    Ok(Value::Undefined)
}

#[test]
fn output_writes_use_the_original_prototype_setter_semantics() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "value", Value::Number(42.0), Attribute::empty());
        let prototype = object(activation);
        let getter = function(activation, owns_false);
        let setter = function(activation, intercept_write);
        prototype.add_property(activation.gc(), name(activation, "value"), getter, Some(setter), Attribute::empty());
        let output = Object::new(&activation.context.strings, Some(prototype));
        let (owner, cache) = owner_and_cache(activation);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(1.0));
        assert_eq!(stored(activation, output, "capturedWrite"), Value::Number(42.0));
        let value_key = name(activation, "value");
        assert!(!output.has_own_property(activation, value_key));
        Ok(())
    });
}

#[test]
fn timeout_at_entry_precedes_enumeration_and_value_reads() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let getter = function(activation, throws);
        source.add_property(activation.gc(), name(activation, "value"), getter, None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let previous = activation.context.max_execution_duration;
        activation.context.max_execution_duration = Duration::ZERO;
        let result = invoke(activation, source.into(), output, cache, owner);
        activation.context.max_execution_duration = previous;
        assert!(matches!(result, Err(Error::ExecutionTimeout)));
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 0, 0));
        Ok(())
    });
}

fn expire_budget<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    // A real context limit, made deterministic without sleeping or altering
    // the engine's clock. This native callback adds no AVM1 opcodes.
    activation.context.max_execution_duration = Duration::ZERO;
    let key = args[0].coerce_to_string(activation)?;
    Ok(this.has_own_property(activation, key).into())
}

#[test]
fn timeout_is_checked_again_after_at_most_32_visited_keys() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        define(activation, source, "hasOwnProperty", function(activation, expire_budget).into(), Attribute::DONT_ENUM);
        for index in 0..65 {
            let key = name(activation, &format!("key{index}"));
            source.define_value(activation.gc(), key, Value::Number(index as f64), Attribute::empty());
            cache.define_value(activation.gc(), key, Value::Bool(false), Attribute::empty());
        }
        let previous = activation.context.max_execution_duration;
        activation.context.max_execution_duration = Duration::from_secs(3600);
        let result = invoke(activation, source.into(), output, cache, owner);
        activation.context.max_execution_duration = previous;
        assert!(matches!(result, Err(Error::ExecutionTimeout)));
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 32, 32));
        assert_eq!(output.get_keys(activation, false).len(), 32);
        Ok(())
    });
}

fn unload_and_true<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let clip = activation.base_clip();
    clip.avm1_unload(activation.context);
    Ok(Value::Bool(true))
}

fn unload_and_false<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let clip = activation.base_clip();
    clip.avm1_unload(activation.context);
    Ok(Value::Bool(false))
}

fn unload_and_string<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let clip = activation.base_clip();
    clip.avm1_unload(activation.context);
    Ok(name(activation, "NaN").into())
}

#[test]
fn removal_in_has_own_stops_before_the_source_getter() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let getter = function(activation, throws);
        source.add_property(activation.gc(), name(activation, "value"), getter, None, Attribute::empty());
        define(activation, source, "hasOwnProperty", function(activation, unload_and_true).into(), Attribute::DONT_ENUM);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Undefined);
        assert!(activation.base_clip().avm1_removed());
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 1, 0));
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}

#[test]
fn removal_in_policy_stops_before_cache_refresh_and_output_write() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "value", Value::Number(7.0), Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        define(activation, owner, "BH_SkipField", function(activation, unload_and_false).into(), Attribute::DONT_ENUM);
        let getter = function(activation, throws);
        owner.add_property(activation.gc(), name(activation, "mBHFieldCache"), getter, None, Attribute::empty());
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Undefined);
        assert!(activation.base_clip().avm1_removed());
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 1, 1));
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}

#[test]
fn removal_in_string_stops_before_constructing_the_number_tag() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "value", Value::Number(f64::NAN), Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        define(activation, cache, "value", Value::Bool(false), Attribute::empty());
        define(activation, owner, "BH_NativeScalarString", function(activation, unload_and_string).into(), Attribute::DONT_ENUM);
        let prototype = activation.prototypes().object;
        let getter = function(activation, owns_false);
        let setter = function(activation, throws);
        prototype.add_property(activation.gc(), name(activation, "$number"), getter, Some(setter), Attribute::DONT_ENUM);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Undefined);
        assert!(activation.base_clip().avm1_removed());
        let stats = activation.context.avm1.native_scalar_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 1, 1));
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}
