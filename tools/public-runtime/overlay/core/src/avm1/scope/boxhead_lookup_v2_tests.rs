//! Real AVM1 scope fixtures with an independently frozen complete v10 Scope.
//! The old arm never calls boxhead_scope_lookup. These tests do not establish
//! whole-game parity, browser performance, or a stable frame rate.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::globals::array::ArrayBuilder;
use crate::avm1::globals::boxhead_native_project::lookup_names::{FixedName, FixedNames};
use crate::avm1::object::{BoxedF64, NativeObject};
use crate::avm1::object::super_object::SuperObject;
use crate::avm1::test_utils::with_avm;
use crate::string::WStr;

#[path = "frozen_v10.rs"]
mod frozen;

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

fn old_class(class: ScopeClass) -> frozen::ScopeClass {
    match class {
        ScopeClass::Global => frozen::ScopeClass::Global,
        ScopeClass::Target => frozen::ScopeClass::Target,
        ScopeClass::Local => frozen::ScopeClass::Local,
        ScopeClass::With => frozen::ScopeClass::With,
    }
}

/// Entries are outermost/global first, then progressively more local scopes.
fn resolve<'gc>(
    activation: &mut Activation<'_, 'gc>,
    optimized: bool,
    objects: &[(ScopeClass, Object<'gc>)],
    name: AvmString<'gc>,
) -> Result<CallableValue<'gc>, Error<'gc>> {
    assert!(!objects.is_empty());
    assert_eq!(objects[0].0, ScopeClass::Global);
    if optimized {
        let mut scope = Gc::new(activation.gc(), Scope::from_global_object(objects[0].1));
        for &(class, object) in &objects[1..] {
            scope = Gc::new(activation.gc(), Scope::new(scope, class, object));
        }
        scope.resolve(name, activation)
    } else {
        let mut scope = Gc::new(activation.gc(), frozen::Scope::from_global_object(objects[0].1));
        for &(class, object) in &objects[1..] {
            scope = Gc::new(activation.gc(), frozen::Scope::new(scope, old_class(class), object));
        }
        scope.resolve(name, activation)
    }
}

fn pair<'gc>(
    activation: &mut Activation<'_, 'gc>,
    objects: &[(ScopeClass, Object<'gc>)],
    name: AvmString<'gc>,
) -> Result<(CallableValue<'gc>, CallableValue<'gc>), Error<'gc>> {
    let old = resolve(activation, false, objects, name)?;
    let new = resolve(activation, true, objects, name)?;
    assert_eq!(parts(old.clone()), parts(new.clone()));
    Ok((old, new))
}

fn parts<'gc>(value: CallableValue<'gc>) -> (Value<'gc>, Value<'gc>) {
    match value {
        CallableValue::Callable(owner, value) => (owner.into(), value),
        CallableValue::UnCallable(value) => (Value::Undefined, value),
    }
}

fn assert_callable<'gc>(value: CallableValue<'gc>, owner: Object<'gc>, expected: Value<'gc>) {
    assert_eq!(parts(value), (owner.into(), expected));
}

fn reset_trace(activation: &Activation<'_, '_>) {
    let global = activation.global_object();
    put(activation, global, "lookupCalls", 0.0.into());
    put(activation, global, "lookupThis", Value::Undefined);
    put(activation, global, "lookupArgument", Value::Undefined);
}

fn record<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, argument: Value<'gc>) {
    let global = activation.global_object();
    let before = match raw(activation, global, "lookupCalls") {
        Value::Number(value) => value,
        _ => 0.0,
    };
    put(activation, global, "lookupCalls", (before + 1.0).into());
    put(activation, global, "lookupThis", this.into());
    put(activation, global, "lookupArgument", argument);
}

fn calls(activation: &mut Activation<'_, '_>) -> f64 {
    let global = activation.global_object();
    match raw(activation, global, "lookupCalls") {
        Value::Number(value) => value,
        _ => 0.0,
    }
}

fn undefined_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Ok(Value::Undefined)
}

fn throwing_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Err(Error::ThrownValue(key(activation, "lookup-sentinel").into()))
}

fn ignored_error_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Err(Error::ExecutionTimeout)
}

fn resolver<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[0]);
    Ok(91.0.into())
}

fn receiver<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Ok(this.into())
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

fn reenter_scope<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    let optimized = raw(activation, this, "optimized") == Value::Bool(true);
    let global = match raw(activation, this, "scopeGlobal") {
        Value::Object(value) => value,
        _ => panic!("fixture scope global missing"),
    };
    put(activation, this, "value", 53.0.into());
    let name = key(activation, "value");
    let value = resolve(activation, optimized, &[(ScopeClass::Global, global), (ScopeClass::Local, this)], name)?;
    assert_callable(value, this, 53.0.into());
    Ok(54.0.into())
}

#[test]
fn lookup_v2_fixed_names_preserve_literals_and_lazy_identity() {
    // Independent literal inventory, intentionally separate from enum->bytes.
    let expected = [
        "", "$animation", "$cell", "$length", "$number", "$parentID", "$process", "$ref", "$undefined",
        ",", "/", "/animation", ":", "ASSetPropFlags", "Array", "BH_Integer", "BH_NativeScalarString",
        "BH_ProcessName", "BH_Project", "BH_SkipField", "CMain", "CMap", "CMap_Cell", "CUpgrades",
        "Error", "Object", "Process", "XSI_Info", "XSI_Model_GunPosition_Right", "_CLASSID_",
        "__bhSnapshotRef", "boxheadNativeProjectionScanV1", "calls", "collideFlag", "completed",
        "contract", "count", "ended", "errorPath", "fields", "first", "frame", "hasOwnProperty", "height",
        "invalid native projection result", "join", "keys", "length", "mActive", "mAnimEnd",
        "mAnimationObject", "mBHFieldCache", "mBHFieldCacheCount", "mCollection", "mCollide",
        "mCollideFlag", "mCurrentFrame", "mCurrentFrameID", "mFirstTime", "mFrameCount", "mItems",
        "mMultipliers", "mParent", "mPosition", "mPreUpdate", "mSize", "mUniqueID", "mXSI_Animation",
        "muzzle", "nPosition", "name", "native snapshot budget exceeded at ", "objects", "ownReads",
        "preUpdate", "projectionKernel", "push", "root", "run", "scalarFields", "slice",
        "snapshot marker collision", "sort", "unsupported", "version", "width", "x", "y",
    ];
    assert_eq!(expected.len(), FixedName::COUNT);
    with_avm(8, |activation, _| {
        let mut names = FixedNames::new();
        assert_eq!(names.initialized(), 0);
        for (index, (name, text)) in FixedName::ALL.into_iter().zip(expected).enumerate() {
            assert_eq!(name as usize, index);
            assert_eq!(name.bytes(), text.as_bytes());
            let actual = names.get(name, activation);
            assert_eq!(actual.as_wstr(), key(activation, text).as_wstr());
            assert!(actual.as_interned().is_some());
            assert_eq!(names.initialized(), index + 1);
            assert!(AvmString::ptr_eq(&actual, &names.get(name, activation)));
            assert_eq!(names.initialized(), index + 1);
        }
        let mut second = FixedNames::new();
        assert_eq!(second.initialized(), 0);
        for name in FixedName::ALL {
            assert!(AvmString::ptr_eq(&names.get(name, activation), &second.get(name, activation)));
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_fixed_names_reobserve_values_getters_and_prototypes() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let local = bare(activation);
        let chain = [(ScopeClass::Global, global), (ScopeClass::Local, local)];
        let mut names = FixedNames::new();
        let name = names.get(FixedName::Object, activation);
        put(activation, global, "Object", 11.0.into());
        assert_callable(pair(activation, &chain, name)?.1, global, 11.0.into());
        put(activation, local, "Object", 12.0.into());
        assert_callable(pair(activation, &chain, name)?.1, local, 12.0.into());
        local.delete(activation, name);
        let proto = bare(activation);
        put(activation, proto, "Object", 13.0.into());
        put(activation, local, "__proto__", proto.into());
        assert_callable(pair(activation, &chain, name)?.1, local, 13.0.into());
        proto.add_property(activation.gc(), name, function(activation, undefined_getter), None, Attribute::empty());
        reset_trace(activation);
        assert_callable(pair(activation, &chain, name)?.1, local, Value::Undefined);
        assert_eq!(calls(activation), 2.0);
        assert!(AvmString::ptr_eq(&name, &names.get(FixedName::Object, activation)));
        Ok(())
    });
}

#[test]
fn lookup_v2_fixed_names_keep_case_utf16_and_enumeration_contents() {
    for version in [6, 7, 8] {
        with_avm(version, |activation, _| {
            let old = bare(activation);
            let new = bare(activation);
            let mut names = FixedNames::new();
            for (index, name) in [FixedName::Object, FixedName::Array, FixedName::TagUndefined, FixedName::Version].into_iter().enumerate() {
                let text = std::str::from_utf8(name.bytes()).unwrap();
                old.define_value(activation.gc(), key(activation, text), (index as f64).into(), Attribute::empty());
                let interned = names.get(name, activation);
                new.define_value(activation.gc(), interned, (index as f64).into(), Attribute::empty());
            }
            for spelling in ["Object", "object", "OBJECT", "Array", "array", "$undefined", "VERSION"] {
                let wide: Vec<u16> = spelling.encode_utf16().collect();
                let query = AvmString::new(activation.gc(), WStr::from_units(&wide[..]));
                assert_eq!(old.get(query, activation)?, new.get(query, activation)?);
                assert_eq!(old.has_own_property(activation, query), new.has_own_property(activation, query));
            }
            let old_keys: Vec<_> = old.get_keys(activation, false).into_iter().map(|s| s.to_utf8_lossy().into_owned()).collect();
            let new_keys: Vec<_> = new.get_keys(activation, false).into_iter().map(|s| s.to_utf8_lossy().into_owned()).collect();
            assert_eq!(new_keys, old_keys);
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_visible_own_values_keep_callable_receiver_and_flags() {
    for version in [5, 6, 7, 8, 10] {
        with_avm(version, |activation, _| {
            let global = bare(activation);
            let local = bare(activation);
            let name = key(activation, "value");
            put(activation, global, "value", 99.0.into());
            put(activation, local, "__resolve", function(activation, throwing_getter).into());
            let opaque = bare(activation);
            let values = [Value::Undefined, Value::Null, false.into(), (-0.0).into(),
                key(activation, "scalar").into(), opaque.into(), function(activation, receiver).into()];
            for value in values {
                local.define_value(activation.gc(), name, value, Attribute::READ_ONLY | Attribute::DONT_ENUM | Attribute::DONT_DELETE);
                reset_trace(activation);
                let result = pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?.1;
                assert_callable(result, local, value);
                assert_eq!(calls(activation), 0.0);
                assert_eq!(local.get_data(name, activation), Some(value));
                assert!(!local.delete(activation, name));
            }
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_missing_slots_follow_parent_without_resolver_calls() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let local = bare(activation);
        put(activation, global, "value", 29.0.into());
        put(activation, local, "__resolve", function(activation, throwing_getter).into());
        let name = key(activation, "value");
        reset_trace(activation);
        assert_callable(pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?.1, global, 29.0.into());
        global.delete(activation, name);
        let result = pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?.1;
        assert!(matches!(result, CallableValue::UnCallable(Value::Undefined)));
        assert_eq!(calls(activation), 0.0);
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_hidden_stored_membership_keeps_original_get_path() {
    for version in [6, 8, 10] {
        with_avm(version, |activation, _| {
            for inherited in [false, true] {
                let global = bare(activation);
                put(activation, global, "value", 99.0.into());
                let proto = bare(activation);
                if inherited { put(activation, proto, "value", 31.0.into()); }
                let local = Object::new(&activation.context.strings, Some(proto));
                let name = key(activation, "value");
                local.define_value(activation.gc(), name, 17.0.into(), Attribute::VERSION_10);
                let expected = if version >= 10 { 17.0.into() } else if inherited { 31.0.into() } else { Value::Undefined };
                assert_callable(pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?.1, local, expected);
                assert_eq!(local.get_data(name, activation), Some(17.0.into()));
            }
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_hidden_virtual_slots_do_not_run_the_hidden_getter() {
    for version in [6, 8, 10] {
        with_avm(version, |activation, _| {
            for optimized in [false, true] {
                let global = bare(activation);
                let proto = bare(activation);
                put(activation, global, "value", 99.0.into());
                put(activation, proto, "value", 31.0.into());
                let local = Object::new(&activation.context.strings, Some(proto));
                let name = key(activation, "value");
                local.add_property(activation.gc(), name, function(activation, undefined_getter), None, Attribute::VERSION_10);
                reset_trace(activation);
                let result = resolve(activation, optimized, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?;
                assert_callable(result, local, if version >= 10 { Value::Undefined } else { 31.0.into() });
                assert_eq!(calls(activation), if version >= 10 { 1.0 } else { 0.0 });
            }
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_visible_getter_undefined_and_error_precedence_match_frozen() {
    with_avm(8, |activation, _| {
        for (index, callback) in [undefined_getter as NativeFunction, throwing_getter, ignored_error_getter].into_iter().enumerate() {
            for optimized in [false, true] {
                let global = bare(activation);
                let local = bare(activation);
                put(activation, global, "value", 99.0.into());
                let name = key(activation, "value");
                local.add_property(activation.gc(), name, function(activation, callback), None, Attribute::empty());
                reset_trace(activation);
                let result = resolve(activation, optimized, &[(ScopeClass::Global, global), (ScopeClass::With, local)], name);
                match (index, result) {
                    (1, Err(Error::ThrownValue(value))) => assert_eq!(value, key(activation, "lookup-sentinel").into()),
                    (0 | 2, Ok(value)) => assert_callable(value, local, Value::Undefined),
                    (_, result) => panic!("unexpected scope outcome: {result:?}"),
                }
                assert_eq!(calls(activation), 1.0);
                let trace = activation.global_object();
                assert_eq!(raw(activation, trace, "lookupThis"), local.into());
            }
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_recursive_getter_error_reobserves_mutated_descriptor() {
    with_avm(8, |activation, _| {
        for (callback, expected) in [(replace_then_recurse as NativeFunction, 37.0), (delete_and_reparent, 73.0)] {
            for optimized in [false, true] {
                let global = bare(activation);
                let replacement = bare(activation);
                put(activation, replacement, "value", 73.0.into());
                let local = bare(activation);
                put(activation, local, "replacement", replacement.into());
                let name = key(activation, "value");
                local.add_property(activation.gc(), name, function(activation, callback), None, Attribute::empty());
                reset_trace(activation);
                let result = resolve(activation, optimized, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?;
                assert_callable(result, local, expected.into());
                assert_eq!(calls(activation), 1.0);
            }
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_resolver_requires_positive_raw_membership() {
    with_avm(8, |activation, _| {
        for hidden_member in [false, true] {
            for optimized in [false, true] {
                let global = bare(activation);
                let local = bare(activation);
                put(activation, local, "__resolve", function(activation, resolver).into());
                let name = key(activation, "value");
                if hidden_member { local.define_value(activation.gc(), name, 17.0.into(), Attribute::VERSION_10); }
                reset_trace(activation);
                let result = resolve(activation, optimized, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?;
                if hidden_member {
                    assert_callable(result, local, 91.0.into());
                    assert_eq!(calls(activation), 1.0);
                    let trace = activation.global_object();
                    assert_eq!(raw(activation, trace, "lookupThis"), local.into());
                    assert_eq!(raw(activation, trace, "lookupArgument"), name.into());
                } else {
                    assert!(matches!(result, CallableValue::UnCallable(Value::Undefined)));
                    assert_eq!(calls(activation), 0.0);
                }
            }
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_inherited_getters_keep_original_receiver() {
    with_avm(8, |activation, _| {
        for optimized in [false, true] {
            let global = bare(activation);
            let proto = bare(activation);
            let name = key(activation, "value");
            proto.add_property(activation.gc(), name, function(activation, undefined_getter), None, Attribute::empty());
            let local = Object::new(&activation.context.strings, Some(proto));
            reset_trace(activation);
            let result = resolve(activation, optimized, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?;
            assert_callable(result, local, Value::Undefined);
            assert_eq!(calls(activation), 1.0);
            let trace = activation.global_object();
            assert_eq!(raw(activation, trace, "lookupThis"), local.into());
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_raw_proto_keeps_case_visibility_and_virtual_data() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            for spelling in ["__proto__", "__PROTO__"] {
                for virtual_proto in [false, true] {
                    let global = bare(activation);
                    let proto = bare(activation);
                    let local = bare(activation);
                    put(activation, global, "value", 99.0.into());
                    put(activation, proto, "value", 71.0.into());
                    let proto_key = key(activation, spelling);
                    if virtual_proto {
                        local.add_property(activation.gc(), proto_key, function(activation, throwing_getter), None, Attribute::VERSION_10);
                        local.set_data(proto_key, proto.into(), activation)?;
                        local.set_attributes(activation.gc(), Some(proto_key), Attribute::VERSION_10, Attribute::empty());
                    } else {
                        local.define_value(activation.gc(), proto_key, proto.into(), Attribute::VERSION_10);
                    }
                    reset_trace(activation);
                    let follows = spelling == "__proto__" || version <= 6;
                    let name = key(activation, "value");
                    let result = pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?.1;
                    assert_callable(result, if follows { local } else { global }, if follows { 71.0.into() } else { 99.0.into() });
                    assert_eq!(calls(activation), 0.0);
                }
            }
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_case_collision_winners_match_frozen_after_mutations() {
    for version in [6, 7, 8] {
        with_avm(version, |activation, _| {
            let global = bare(activation);
            let local = bare(activation);
            let chain = [(ScopeClass::Global, global), (ScopeClass::Local, local)];
            for (index, text) in ["Alpha", "alpha", "ALPHA", "aLpHa", "beta"].into_iter().enumerate() {
                put(activation, local, text, (index as f64).into());
            }
            for round in 0..20 {
                for text in ["Alpha", "alpha", "ALPHA", "aLpHa", "missing"] {
                    let name = key(activation, text);
                    pair(activation, &chain, name)?;
                }
                let name = key(activation, if round % 2 == 0 { "alpha" } else { "Alpha" });
                local.delete(activation, name);
                local.define_value(activation.gc(), name, (round as f64 + 20.0).into(), Attribute::empty());
            }
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_arrays_and_functions_keep_ordinary_fields() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let array: Object<'_> = ArrayBuilder::new(activation).with([1.0.into(), 2.0.into()]).into();
        let callable = function(activation, receiver);
        put(activation, callable, "value", 41.0.into());
        for (local, field, expected) in [(array, "length", 2.0), (array, "1", 2.0), (callable, "value", 41.0)] {
            let name = key(activation, field);
            assert_callable(pair(activation, &[(ScopeClass::Global, global), (ScopeClass::With, local)], name)?.1, local, expected.into());
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_native_display_boxed_and_super_paths_match_frozen() {
    with_avm(8, |activation, clip| {
        let global = bare(activation);
        let ordinary = bare(activation);
        let prototype = bare(activation);
        put(activation, prototype, "value", 37.0.into());
        put(activation, ordinary, "__proto__", prototype.into());
        put(activation, ordinary, "value", 17.0.into());
        let super_object = Object::new_with_native(&activation.context.strings, None::<Value<'_>>,
            NativeObject::Super(SuperObject::new(ordinary, 1)));
        let boxed = Object::new_with_native(&activation.context.strings, None::<Value<'_>>,
            NativeObject::Number(BoxedF64::new(activation.gc(), 7.0)));
        put(activation, boxed, "value", 31.0.into());
        for (local, field) in [(clip, "_x"), (boxed, "value"), (super_object, "value")] {
            let name = key(activation, field);
            assert!(matches!(local.boxhead_scope_lookup(name, activation), OwnScopeLookup::Special));
            pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Target, local)], name)?;
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_removed_clip_fallback_keeps_root_and_callable_undefined() {
    with_avm(8, |activation, clip| {
        let global = bare(activation);
        let name = key(activation, "value");
        put(activation, clip, "value", 73.0.into());
        activation.base_clip().avm1_unload(activation.context);
        assert!(activation.base_clip().avm1_removed());
        let chain = [(ScopeClass::Global, global), (ScopeClass::Target, clip)];
        assert_callable(pair(activation, &chain, name)?.1, clip, 73.0.into());
        // A parent Callable(undefined) is distinct from an unresolved result.
        put(activation, global, "value", Value::Undefined);
        assert_callable(pair(activation, &chain, name)?.1, global, Value::Undefined);
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_with_local_global_calls_keep_exact_this_owner() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let target = bare(activation);
        let local = bare(activation);
        let with = bare(activation);
        let chain = [(ScopeClass::Global, global), (ScopeClass::Target, target),
            (ScopeClass::Local, local), (ScopeClass::With, with)];
        let name = key(activation, "method");
        for object in [global, target, local, with] { put(activation, object, "method", function(activation, receiver).into()); }
        let default_this = bare(activation);
        for owner in [with, local, target, global] {
            for optimized in [false, true] {
                reset_trace(activation);
                let resolved = resolve(activation, optimized, &chain, name)?;
                let actual = resolved.call_with_default_this(default_this.into(), name, activation, &[])?;
                assert_eq!(actual, owner.into());
                let trace = activation.global_object();
                assert_eq!(raw(activation, trace, "lookupThis"), owner.into());
                assert_eq!(calls(activation), 1.0);
            }
            owner.delete(activation, name);
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_fresh_reads_observe_reparenting_own_writes_and_watchers() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let first = bare(activation);
        let second = bare(activation);
        let local = bare(activation);
        let chain = [(ScopeClass::Global, global), (ScopeClass::Local, local)];
        let name = key(activation, "value");
        put(activation, first, "value", 11.0.into());
        put(activation, second, "value", 12.0.into());
        let watcher = function(activation, throwing_getter);
        local.watch(activation, name, watcher, Value::Undefined);
        reset_trace(activation);
        for (proto, expected) in [(first, 11.0), (second, 12.0), (first, 11.0)] {
            put(activation, local, "__proto__", proto.into());
            assert_callable(pair(activation, &chain, name)?.1, local, expected.into());
            put(activation, local, "value", 19.0.into());
            assert_callable(pair(activation, &chain, name)?.1, local, 19.0.into());
            local.delete(activation, name);
        }
        assert_eq!(calls(activation), 0.0);
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_getter_reentry_observes_new_slot_and_keeps_outer_result() {
    with_avm(8, |activation, _| {
        for optimized in [false, true] {
            let global = bare(activation);
            let local = bare(activation);
            put(activation, local, "optimized", optimized.into());
            put(activation, local, "scopeGlobal", global.into());
            let name = key(activation, "value");
            local.add_property(activation.gc(), name, function(activation, reenter_scope), None, Attribute::empty());
            reset_trace(activation);
            let chain = [(ScopeClass::Global, global), (ScopeClass::Local, local)];
            assert_callable(resolve(activation, optimized, &chain, name)?, local, 54.0.into());
            assert_callable(resolve(activation, optimized, &chain, name)?, local, 53.0.into());
            assert_eq!(calls(activation), 1.0);
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_deep_parent_chains_preserve_shadowing_and_receiver() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let mut chain = vec![(ScopeClass::Global, global)];
        for index in 0..80 {
            let object = bare(activation);
            if index % 7 == 0 { put(activation, object, "value", (index as f64).into()); }
            chain.push((if index % 2 == 0 { ScopeClass::Local } else { ScopeClass::With }, object));
        }
        let name = key(activation, "value");
        for _ in 0..12 {
            pair(activation, &chain, name)?;
            if let Some(&(_, object)) = chain.iter().rev().find(|(_, object)| object.has_own_property(activation, name)) {
                object.delete(activation, name);
            }
        }
        assert!(matches!(pair(activation, &chain, name)?.1, CallableValue::UnCallable(Value::Undefined)));
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_positive_membership_keeps_get_prototype_recursion_error() {
    with_avm(8, |activation, _| {
        let global = bare(activation);
        let first = bare(activation);
        let second = Object::new(&activation.context.strings, Some(first));
        put(activation, first, "__proto__", second.into());
        let name = key(activation, "value");
        // Raw membership terminates immediately; get must still traverse the
        // cycle after ignoring this version-hidden descriptor.
        first.define_value(activation.gc(), name, 17.0.into(), Attribute::VERSION_10);
        let chain = [(ScopeClass::Global, global), (ScopeClass::Local, first)];
        for optimized in [false, true] {
            assert!(matches!(resolve(activation, optimized, &chain, name), Err(Error::PrototypeRecursionLimit)));
        }
        Ok(())
    });
}

#[test]
fn lookup_v2_scope_empty_and_utf16_names_keep_exact_membership() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            let global = bare(activation);
            let local = bare(activation);
            let units: &[&[u16]] = &[&[], &[0], &[0xd800], &[0xd83d, 0xde42], &[0xffff, 0, 0x41]];
            for (index, units) in units.iter().enumerate() {
                let name = AvmString::new(activation.gc(), WStr::from_units(*units));
                local.define_value(activation.gc(), name, (index as f64).into(), Attribute::empty());
            }
            for (index, units) in units.iter().enumerate() {
                let name = AvmString::new(activation.gc(), WStr::from_units(*units));
                assert_callable(pair(activation, &[(ScopeClass::Global, global), (ScopeClass::Local, local)], name)?.1,
                    local, (index as f64).into());
            }
            Ok(())
        });
    }
}

#[test]
fn lookup_v2_scope_actual_activation_resolves_fresh_values_and_special_this() {
    with_avm(8, |activation, _| {
        let original_scope = activation.scope();
        let global = bare(activation);
        let local = bare(activation);
        let parent = Gc::new(activation.gc(), Scope::from_global_object(global));
        let scope = Gc::new(activation.gc(), Scope::new(parent, ScopeClass::Local, local));
        activation.set_scope(scope);
        let name = key(activation, "value");
        put(activation, global, "value", 11.0.into());
        assert_callable(activation.get_variable(name)?, global, 11.0.into());
        put(activation, local, "value", 12.0.into());
        assert_callable(activation.get_variable(name)?, local, 12.0.into());
        put(activation, local, "this", 99.0.into());
        let actual_this: Value<'_> = activation.resolve(key(activation, "this"))?.into();
        assert_eq!(actual_this, activation.this_cell());
        activation.set_scope(original_scope);
        Ok(())
    });
}
