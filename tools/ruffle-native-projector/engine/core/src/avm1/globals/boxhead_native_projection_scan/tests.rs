//! Real AVM1 objects, getters, method overrides and exception paths. No mock
//! projection or Rust-side field-policy substitute is used by the kernel.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::globals::array::ArrayBuilder;
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
    let result = call(activation, global, &[operation.into(), source, output.into(), cache.into(), owner.into(), Value::Bool(false)])?;
    Ok(match result {
        Value::Object(envelope) => stored(activation, envelope, "scalarFields"),
        other => other,
    })
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
        let key = name(activation, "boxheadNativeProjectionScanV1");
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
        assert_eq!(activation.context.avm1.native_projection_scan_stats.calls, 0);
        Ok(())
    });
}

#[test]
fn unsupported_kinds_and_malformed_arguments_never_read_source_properties() {
    with_avm(8, |activation, root| {
        let unsupported_source = function(activation, throws);
        let getter = function(activation, throws);
        unsupported_source.add_property(activation.gc(), name(activation, "failIfRead"), getter, None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        for source in [unsupported_source.into(), root.into(), Value::Undefined, Value::Number(7.0)] {
            assert_eq!(invoke(activation, source, output, cache, owner)?, Value::Bool(false));
        }
        let source = object(activation);
        source.add_property(activation.gc(), name(activation, "failIfRead"), getter, None, Attribute::empty());
        assert_eq!(invoke(activation, source.into(), source, cache, owner)?, Value::Bool(false));
        let global = activation.global_object();
        let operation = name(activation, "run");
        for (bad_out, bad_cache, bad_owner, bad_upgrades) in [
            (root.into(), cache.into(), owner.into(), Value::Bool(false)),
            (output.into(), Value::Null, owner.into(), Value::Bool(false)),
            (output.into(), cache.into(), Value::Undefined, Value::Bool(false)),
            (output.into(), cache.into(), owner.into(), Value::Number(1.0)),
        ] {
            assert_eq!(call(activation, global, &[operation.into(), source.into(), bad_out, bad_cache, bad_owner, bad_upgrades])?, Value::Bool(false));
        }
        let stats = activation.context.avm1.native_projection_scan_stats;
        assert_eq!((stats.calls, stats.completed, stats.unsupported, stats.keys, stats.own_reads), (9, 0, 9, 0, 0));
        assert!(output.get_keys(activation, false).is_empty());
        assert!(matches!(call(activation, global, &[operation.into()]), Err(Error::ThrownValue(_))));
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
        assert_eq!(activation.context.avm1.native_projection_scan_stats.keys, 2);
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
        assert_eq!(activation.context.avm1.native_projection_scan_stats.keys, 2);
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
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(1.0));
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
        assert_eq!(output.get(null_key, activation)?, Value::Null);
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
        let stats = activation.context.avm1.native_projection_scan_stats;
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
        let stats = activation.context.avm1.native_projection_scan_stats;
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
        let stats = activation.context.avm1.native_projection_scan_stats;
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
        let stats = activation.context.avm1.native_projection_scan_stats;
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
        let stats = activation.context.avm1.native_projection_scan_stats;
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
        let stats = activation.context.avm1.native_projection_scan_stats;
        assert_eq!((stats.calls, stats.completed, stats.keys, stats.own_reads), (1, 0, 1, 1));
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}

fn scan<'gc>(
    activation: &mut Activation<'_, 'gc>,
    source: Object<'gc>,
    output: Object<'gc>,
    cache: Object<'gc>,
    owner: Object<'gc>,
    upgrades: bool,
) -> Result<Object<'gc>, Error<'gc>> {
    let global = activation.global_object();
    let operation = name(activation, "run");
    let result = call(activation, global, &[
        operation.into(), source.into(), output.into(), cache.into(), owner.into(), upgrades.into(),
    ])?;
    let Value::Object(envelope) = result else { panic!("successful scan envelope expected"); };
    assert_eq!(stored(activation, envelope, "version"), Value::Number(1.0));
    assert_eq!(envelope.get_keys(activation, false).len(), 3);
    Ok(envelope)
}

fn deferred_names<'gc>(
    activation: &mut Activation<'_, 'gc>,
    envelope: Object<'gc>,
) -> Result<Vec<String>, Error<'gc>> {
    let keys = stored(activation, envelope, "keys");
    if matches!(keys, Value::Undefined) { return Ok(vec![]); }
    let Value::Object(keys) = keys else { panic!("standard Array expected"); };
    let length = keys.length(activation)?;
    (0..length).map(|index| {
        Ok(keys.get_element(activation, index).coerce_to_string(activation)?.to_utf8_lossy().into_owned())
    }).collect()
}

#[test]
fn undefined_tags_null_and_primitive_only_records_do_not_allocate_deferred_arrays() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        for (key, value) in [("a", Value::Undefined), ("b", Value::Undefined), ("null", Value::Null),
            ("bool", Value::Bool(false)), ("text", name(activation, "text").into())] {
            define(activation, source, key, value, Attribute::empty());
        }
        // If Array were resolved eagerly this actual getter would throw.
        let global = activation.global_object();
        global.add_property(activation.gc(), name(activation, "Array"), function(activation, throws), None, Attribute::DONT_ENUM);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let result = scan(activation, source, output, cache, owner, false)?;
        assert_eq!(stored(activation, result, "scalarFields"), Value::Number(5.0));
        assert_eq!(stored(activation, result, "keys"), Value::Undefined);
        let (Value::Object(a), Value::Object(b)) = (stored(activation, output, "a"), stored(activation, output, "b")) else {
            panic!("undefined must be encoded as distinct tag objects");
        };
        assert!(!Object::ptr_eq(a, b));
        assert_eq!(stored(activation, a, "$undefined"), Value::Number(1.0));
        assert_eq!(stored(activation, b, "$undefined"), Value::Number(1.0));
        assert_eq!(stored(activation, output, "null"), Value::Null);
        assert_eq!(activation.context.avm1.native_projection_scan_stats.completed, 1);
        Ok(())
    });
}

fn counted_object<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, this, "leafReads");
    Ok(stored(activation, this, "leaf"))
}

#[test]
fn deferred_keys_keep_enumeration_order_without_a_second_source_read_or_recursive_visit() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let leaf = object(activation);
        leaf.add_property(activation.gc(), name(activation, "neverVisitInScan"), function(activation, throws), None, Attribute::empty());
        define(activation, source, "leaf", leaf.into(), Attribute::DONT_ENUM);
        for key in ["z", "a", "middle"] {
            source.add_property(activation.gc(), name(activation, key), function(activation, counted_object), None, Attribute::empty());
        }
        let expected: Vec<String> = source.get_keys(activation, false).into_iter().map(|key| key.to_utf8_lossy().into_owned()).collect();
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let result = scan(activation, source, output, cache, owner, false)?;
        assert_eq!(deferred_names(activation, result)?, expected);
        assert_eq!(stored(activation, result, "scalarFields"), Value::Number(0.0));
        assert_eq!(stored(activation, source, "leafReads"), Value::Number(3.0));
        assert!(output.get_keys(activation, false).is_empty());
        assert_eq!(activation.context.avm1.native_projection_scan_stats.own_reads, 3);
        Ok(())
    });
}

#[test]
fn functions_are_read_once_but_omitted_before_field_policy_and_upgrade_handling() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "leaf", function(activation, owns_true).into(), Attribute::DONT_ENUM);
        source.add_property(activation.gc(), name(activation, "mMultipliers"), function(activation, counted_object), None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        cache.add_property(activation.gc(), name(activation, "mMultipliers"), function(activation, throws), None, Attribute::empty());
        let result = scan(activation, source, output, cache, owner, true)?;
        assert_eq!(stored(activation, result, "scalarFields"), Value::Number(0.0));
        assert_eq!(stored(activation, result, "keys"), Value::Undefined);
        assert_eq!(stored(activation, source, "leafReads"), Value::Number(1.0));
        assert_eq!(stored(activation, owner, "policyCalls"), Value::Undefined);
        Ok(())
    });
}

#[test]
fn upgrades_omit_levels_and_defer_multipliers_before_leaf_type_or_null_coercion() {
    with_avm(8, |activation, _this| {
        let exotic = object(activation);
        define(activation, exotic, "valueOf", function(activation, throws).into(), Attribute::DONT_ENUM);
        for leaf in [Value::Undefined, Value::Null, Value::Number(4.0), Value::Bool(false), exotic.into()] {
            let source = object(activation);
            define(activation, source, "leaf", leaf, Attribute::DONT_ENUM);
            for key in ["mLevels", "mMultipliers"] {
                source.add_property(activation.gc(), name(activation, key), function(activation, counted_object), None, Attribute::empty());
            }
            let output = object(activation);
            let (owner, cache) = owner_and_cache(activation);
            let result = scan(activation, source, output, cache, owner, true)?;
            assert_eq!(deferred_names(activation, result)?, vec!["mMultipliers"]);
            assert_eq!(stored(activation, result, "scalarFields"), Value::Number(0.0));
            assert_eq!(stored(activation, source, "leafReads"), Value::Number(2.0));
            assert_eq!(stored(activation, owner, "policyCalls"), Value::Number(2.0));
            assert!(output.get_keys(activation, false).is_empty());
        }
        Ok(())
    });
}

#[test]
fn sparse_array_own_fields_preserve_holes_and_leave_length_metadata_to_as2() {
    with_avm(8, |activation, _this| {
        let source = ArrayBuilder::empty(activation);
        source.set_length(activation, 8)?;
        source.set_element(activation, 0, Value::Number(42.0))?;
        source.set_element(activation, 2, Value::Undefined)?;
        let child = object(activation);
        source.set_element(activation, 5, child.into())?;
        define(activation, source, "label", name(activation, "array").into(), Attribute::empty());
        let proto = activation.prototypes().array;
        proto.add_property(activation.gc(), name(activation, "inherited"), function(activation, throws), None, Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let result = scan(activation, source, output, cache, owner, false)?;
        assert_eq!(stored(activation, result, "scalarFields"), Value::Number(3.0));
        assert_eq!(deferred_names(activation, result)?, vec!["5"]);
        assert_eq!(stored(activation, output, "0"), Value::Number(42.0));
        for key in ["1", "3", "4", "6", "7", "length", "$length", "inherited"] {
            let key = name(activation, key);
            assert!(!output.has_own_property(activation, key));
        }
        assert_eq!(source.length(activation)?, 8);
        assert_eq!(activation.context.avm1.native_projection_scan_stats.own_reads, 4);
        Ok(())
    });
}

#[test]
fn loose_undefined_policy_and_loose_null_leaf_comparisons_are_not_discriminant_tests() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let leaf = Object::new_without_proto(activation.gc());
        define(activation, source, "value", leaf.into(), Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let cache_value = Object::new_without_proto(activation.gc());
        define(activation, cache, "value", cache_value.into(), Attribute::empty());
        let result = scan(activation, source, output, cache, owner, false)?;
        assert_eq!(stored(activation, owner, "policyCalls"), Value::Number(1.0));
        assert_eq!(stored(activation, output, "value"), leaf.into());
        assert_eq!(stored(activation, result, "scalarFields"), Value::Number(1.0));
        assert_eq!(stored(activation, result, "keys"), Value::Undefined);
        Ok(())
    });
}

fn event<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, label: &str) {
    let Value::Object(audit) = stored(activation, this, "audit") else { panic!("audit object"); };
    let previous = match stored(activation, audit, "events") {
        Value::String(text) => text.to_utf8_lossy().into_owned(),
        _ => String::new(),
    };
    define(activation, audit, "events", name(activation, &(previous + label + "|" )).into(), Attribute::DONT_ENUM);
}

fn ordered_own<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "own");
    let key = args[0].coerce_to_string(activation)?;
    Ok(this.has_own_property(activation, key).into())
}
fn ordered_leaf<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "leaf");
    Ok(stored(activation, this, "leaf"))
}
fn ordered_cache<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "cache"); Ok(Value::Undefined)
}
fn ordered_policy<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "policy"); Ok(Value::Bool(false))
}
fn ordered_refresh<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "refresh"); Ok(stored(activation, this, "cache"))
}
fn ordered_null<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "valueOf"); Ok(Value::Null)
}
fn ordered_write<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    event(activation, this, "write");
    define(activation, this, "captured", args[0], Attribute::DONT_ENUM);
    Ok(Value::Undefined)
}

#[test]
fn getter_policy_cache_refresh_valueof_and_output_setter_have_original_order() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let leaf = object(activation);
        let output = object(activation);
        let audit = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        for target in [source, leaf, output, owner, cache] {
            define(activation, target, "audit", audit.into(), Attribute::DONT_ENUM);
        }
        define(activation, source, "leaf", leaf.into(), Attribute::DONT_ENUM);
        define(activation, source, "hasOwnProperty", function(activation, ordered_own).into(), Attribute::DONT_ENUM);
        source.add_property(activation.gc(), name(activation, "value"), function(activation, ordered_leaf), None, Attribute::empty());
        cache.add_property(activation.gc(), name(activation, "value"), function(activation, ordered_cache), None, Attribute::empty());
        define(activation, owner, "cache", cache.into(), Attribute::DONT_ENUM);
        define(activation, owner, "BH_SkipField", function(activation, ordered_policy).into(), Attribute::DONT_ENUM);
        owner.add_property(activation.gc(), name(activation, "mBHFieldCache"), function(activation, ordered_refresh), None, Attribute::DONT_ENUM);
        define(activation, leaf, "valueOf", function(activation, ordered_null).into(), Attribute::DONT_ENUM);
        output.add_property(activation.gc(), name(activation, "value"), function(activation, owns_false), Some(function(activation, ordered_write)), Attribute::empty());
        let result = scan(activation, source, output, cache, owner, false)?;
        assert_eq!(stored(activation, audit, "events"), name(activation, "own|leaf|cache|policy|refresh|valueOf|write|").into());
        assert_eq!(stored(activation, output, "captured"), leaf.into());
        assert_eq!(stored(activation, result, "scalarFields"), Value::Number(1.0));
        Ok(())
    });
}

#[test]
fn leaf_valueof_exceptions_propagate_without_defer_or_completed_result() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        let leaf = object(activation);
        define(activation, leaf, "valueOf", function(activation, throws).into(), Attribute::DONT_ENUM);
        define(activation, source, "value", leaf.into(), Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        assert!(matches!(invoke(activation, source.into(), output, cache, owner), Err(Error::ThrownValue(_))));
        assert_eq!(activation.context.avm1.native_projection_scan_stats.own_reads, 1);
        assert_eq!(activation.context.avm1.native_projection_scan_stats.completed, 0);
        assert!(output.get_keys(activation, false).is_empty());
        Ok(())
    });
}

#[test]
fn undefined_tag_uses_live_object_prototype_setter_semantics() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "value", Value::Undefined, Attribute::empty());
        let prototype = activation.prototypes().object;
        prototype.add_property(activation.gc(), name(activation, "$undefined"), function(activation, owns_false), Some(function(activation, intercept_write)), Attribute::DONT_ENUM);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        scan(activation, source, output, cache, owner, false)?;
        let Value::Object(tag) = stored(activation, output, "value") else { panic!("tag object"); };
        assert_eq!(stored(activation, tag, "capturedWrite"), Value::Number(1.0));
        let tag_key = name(activation, "$undefined");
        assert!(!tag.has_own_property(activation, tag_key));
        Ok(())
    });
}

fn construct_keys<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    add_count(activation, global, "arrayConstructs");
    define(activation, global, "createdKeys", this.into(), Attribute::DONT_ENUM);
    define(activation, this, "length", Value::Number(0.0), Attribute::DONT_ENUM);
    Ok(this.into())
}

fn live_array_constructor<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, this, "arrayLookups");
    Ok(stored(activation, this, "testArrayConstructor"))
}

fn live_array_prototype<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    add_count(activation, global, "prototypeReads");
    Ok(stored(activation, global, "testKeyPrototype"))
}

fn first_push<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    add_count(activation, global, "firstPushCalls");
    crate::avm1::globals::array::push(activation, this, args)
}

fn later_push<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    add_count(activation, global, "laterPushCalls");
    crate::avm1::globals::array::push(activation, this, args)
}

fn live_push<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let count = add_count(activation, this, "pushLookups");
    Ok(function(activation, if count == 1 { first_push } else { later_push }).into())
}

fn install_array_override<'gc>(activation: &mut Activation<'_, 'gc>, prototype: Object<'gc>) -> Object<'gc> {
    let global = activation.global_object();
    let constructor = FunctionObject::constructor(construct_keys, None).build(&activation.context.strings, None, Some(prototype));
    constructor.add_property(activation.gc(), name(activation, "prototype"), function(activation, live_array_prototype), None, Attribute::DONT_ENUM);
    define(activation, global, "testKeyPrototype", prototype.into(), Attribute::DONT_ENUM);
    define(activation, global, "testArrayConstructor", constructor.into(), Attribute::DONT_ENUM);
    global.add_property(activation.gc(), name(activation, "Array"), function(activation, live_array_constructor), None, Attribute::DONT_ENUM);
    constructor
}

fn two_deferred_fields<'gc>(activation: &Activation<'_, 'gc>) -> Object<'gc> {
    let source = object(activation);
    let leaf = object(activation);
    define(activation, source, "a", leaf.into(), Attribute::empty());
    define(activation, source, "b", leaf.into(), Attribute::empty());
    source
}

#[test]
fn deferred_array_constructor_prototype_and_push_overrides_are_resolved_live() {
    with_avm(8, |activation, _this| {
        let source = two_deferred_fields(activation);
        let expected: Vec<String> = source.get_keys(activation, false).into_iter().map(|key| key.to_utf8_lossy().into_owned()).collect();
        let key_prototype = object(activation);
        key_prototype.add_property(activation.gc(), name(activation, "push"), function(activation, live_push), None, Attribute::DONT_ENUM);
        install_array_override(activation, key_prototype);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let result = scan(activation, source, output, cache, owner, false)?;
        let global = activation.global_object();
        assert_eq!(deferred_names(activation, result)?, expected);
        assert_eq!(stored(activation, global, "arrayLookups"), Value::Number(1.0));
        assert_eq!(stored(activation, global, "arrayConstructs"), Value::Number(1.0));
        assert_eq!(stored(activation, global, "prototypeReads"), Value::Number(1.0));
        assert_eq!(stored(activation, global, "firstPushCalls"), Value::Number(1.0));
        assert_eq!(stored(activation, global, "laterPushCalls"), Value::Number(1.0));
        let Value::Object(keys) = stored(activation, result, "keys") else { panic!("custom keys object"); };
        assert_eq!(stored(activation, keys, "pushLookups"), Value::Number(2.0));
        assert!(matches!(keys.native(), NativeObject::None));
        Ok(())
    });
}

fn keys_valueof_undefined<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    add_count(activation, global, "keysValueOfCalls");
    Ok(Value::Undefined)
}

#[test]
fn loose_undefined_on_existing_keys_can_reconstruct_the_array_for_each_deferred_field() {
    with_avm(8, |activation, _this| {
        let source = two_deferred_fields(activation);
        let enumeration = source.get_keys(activation, false);
        let key_prototype = object(activation);
        define(activation, key_prototype, "valueOf", function(activation, keys_valueof_undefined).into(), Attribute::DONT_ENUM);
        define(activation, key_prototype, "push", function(activation, first_push).into(), Attribute::DONT_ENUM);
        install_array_override(activation, key_prototype);
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        let result = scan(activation, source, output, cache, owner, false)?;
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "keysValueOfCalls"), Value::Number(1.0));
        assert_eq!(stored(activation, global, "arrayConstructs"), Value::Number(2.0));
        assert_eq!(stored(activation, global, "arrayLookups"), Value::Number(2.0));
        assert_eq!(stored(activation, global, "prototypeReads"), Value::Number(2.0));
        assert_eq!(deferred_names(activation, result)?, vec![enumeration[1].to_utf8_lossy().into_owned()]);
        Ok(())
    });
}

fn constructor_returns_fixture_value<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    add_count(activation, global, "arrayConstructs");
    Ok(stored(activation, global, "arrayReturnValue"))
}

#[test]
fn unusual_native_constructor_return_values_keep_original_null_method_and_coercion_behavior() {
    for mode in 0..4 {
        with_avm(8, |activation, _this| {
            let returned = match mode { 0 => Value::Undefined, 1 => Value::Null, 2 => Value::Number(3.0), _ => Value::Bool(false) };
            let source = two_deferred_fields(activation);
            let global = activation.global_object();
            let constructor = FunctionObject::constructor(constructor_returns_fixture_value, None).build(&activation.context.strings, None, None);
            define(activation, global, "Array", constructor.into(), Attribute::DONT_ENUM);
            define(activation, global, "arrayReturnValue", returned, Attribute::DONT_ENUM);
            let output = object(activation);
            let (owner, cache) = owner_and_cache(activation);
            let result = scan(activation, source, output, cache, owner, false)?;
            assert_eq!(stored(activation, result, "keys"), returned);
            let expected = if matches!(returned, Value::Undefined | Value::Null) { 2.0 } else { 1.0 };
            assert_eq!(stored(activation, global, "arrayConstructs"), Value::Number(expected));
            assert_eq!(stored(activation, result, "scalarFields"), Value::Number(0.0));
            Ok(())
        });
    }
}

#[test]
fn constructor_and_push_exceptions_are_not_retried_or_reported_as_completed() {
    for fail_constructor in [true, false] {
        with_avm(8, |activation, _this| {
            let source = two_deferred_fields(activation);
            let prototype = object(activation);
            define(activation, prototype, "push", function(activation, throws).into(), Attribute::DONT_ENUM);
            let constructor = install_array_override(activation, prototype);
            if fail_constructor {
                constructor.add_property(activation.gc(), name(activation, "prototype"), function(activation, throws), None, Attribute::DONT_ENUM);
            }
            let output = object(activation);
            let (owner, cache) = owner_and_cache(activation);
            assert!(matches!(invoke(activation, source.into(), output, cache, owner), Err(Error::ThrownValue(_))));
            assert_eq!(activation.context.avm1.native_projection_scan_stats.own_reads, 1);
            assert_eq!(activation.context.avm1.native_projection_scan_stats.completed, 0);
            assert_eq!(activation.context.avm1.native_projection_scan_stats.unsupported, 0);
            assert!(output.get_keys(activation, false).is_empty());
            Ok(())
        });
    }
}

#[test]
fn removal_in_array_construction_or_push_stops_before_the_next_source_read() {
    for unload_constructor in [true, false] {
        with_avm(8, |activation, _this| {
            let source = two_deferred_fields(activation);
            let prototype = object(activation);
            define(activation, prototype, "push", function(activation, unload_and_true).into(), Attribute::DONT_ENUM);
            if unload_constructor {
                let constructor = FunctionObject::constructor(unload_and_true, None).build(&activation.context.strings, None, Some(prototype));
                define(activation, activation.global_object(), "Array", constructor.into(), Attribute::DONT_ENUM);
            } else {
                install_array_override(activation, prototype);
            }
            let output = object(activation);
            let (owner, cache) = owner_and_cache(activation);
            assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Undefined);
            assert!(activation.base_clip().avm1_removed());
            assert_eq!(activation.context.avm1.native_projection_scan_stats.own_reads, 1);
            assert_eq!(activation.context.avm1.native_projection_scan_stats.completed, 0);
            assert_eq!(activation.context.avm1.native_projection_scan_stats.unsupported, 0);
            Ok(())
        });
    }
}

fn replace_cache_with_null<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    add_count(activation, this, "policyCalls");
    this.set(name(activation, "mBHFieldCache"), Value::Null, activation)?;
    Ok(Value::Bool(false))
}

#[test]
fn policy_cache_replacement_with_primitive_uses_getmember_coercion_on_later_fields() {
    with_avm(8, |activation, _this| {
        let source = object(activation);
        define(activation, source, "a", Value::Number(1.0), Attribute::empty());
        define(activation, source, "b", Value::Number(2.0), Attribute::empty());
        let output = object(activation);
        let (owner, cache) = owner_and_cache(activation);
        define(activation, owner, "BH_SkipField", function(activation, replace_cache_with_null).into(), Attribute::DONT_ENUM);
        assert_eq!(invoke(activation, source.into(), output, cache, owner)?, Value::Number(2.0));
        assert_eq!(stored(activation, owner, "policyCalls"), Value::Number(2.0));
        assert_eq!(stored(activation, output, "a"), Value::Number(1.0));
        assert_eq!(stored(activation, output, "b"), Value::Number(2.0));
        Ok(())
    });
}

