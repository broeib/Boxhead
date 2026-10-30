//! Semantic fixtures against real pinned AVM1 objects. The whole-game/native
//! A/B remains a separate required qualification; these tests do not award FPS.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::globals::array::ArrayBuilder;
use crate::avm1::test_utils::with_avm;
use std::time::Duration;

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
    object.define_value(activation.gc(), key(activation, name), value, Attribute::empty());
}
fn hidden<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(activation.gc(), key(activation, name), value, Attribute::DONT_ENUM);
}
fn stored<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Value<'gc> {
    object.get_data(key(activation, name), activation).unwrap_or(Value::Undefined)
}
fn as_object(value: Value<'_>) -> Object<'_> {
    match value { Value::Object(object) => object, _ => panic!("Expected ordinary object: {value:?}") }
}
fn array<'gc>(activation: &mut Activation<'_, 'gc>, values: &[Value<'gc>]) -> Object<'gc> {
    ArrayBuilder::new(activation).with(values.iter().copied()).into()
}
fn count<'gc>(activation: &mut Activation<'_, 'gc>, name: &str) -> f64 {
    let global = activation.global_object();
    let n = match stored(activation, global, name) { Value::Number(value) => value, _ => 0.0 } + 1.0;
    hidden(activation, global, name, n.into());
    n
}
fn policy<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let name = args[0].coerce_to_string(activation)?;
    let skip = name.eq_with_case(b"skip", true) || name.eq_with_case(b"mParent", true)
        || name.eq_with_case(b"mXSI_Animation", true);
    let cache = as_object(stored(activation, owner, "mBHFieldCache"));
    cache.set(name, skip, activation)?;
    count(activation, "policyCalls");
    Ok(skip.into())
}
fn process_name<'gc>(activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    args[0].coerce_to_object_or_bare(activation)?.get(key(activation, "Process"), activation)?;
    count(activation, "processNameCalls");
    Ok(key(activation, "Process_Actual").into())
}
fn fixture<'gc>(activation: &mut Activation<'_, 'gc>) -> (Object<'gc>, Object<'gc>) {
    let owner = object(activation);
    let cache = Object::new_without_proto(activation.gc());
    define(activation, owner, "mBHFieldCache", cache.into());
    hidden(activation, owner, "BH_SkipField", function(activation, policy).into());
    hidden(activation, owner, "BH_ProcessName", function(activation, process_name).into());
    let original_projector = function(activation, forbidden);
    hidden(activation, owner, "BH_Project", original_projector.into());
    let global = activation.global_object();
    hidden(activation, global, "CMain", owner.into());
    let context = object(activation);
    let objects = array(activation, &[]);
    let error_path = array(activation, &[]);
    define(activation, context, "objects", objects.into());
    define(activation, context, "errorPath", error_path.into());
    define(activation, context, "fields", 0.0.into());
    define(activation, context, "projectionKernel", Value::Undefined);
    define(activation, context, "nativeProjectOwner", owner.into());
    define(activation, context, "nativeProjectFunction", original_projector.into());
    (owner, context)
}
fn invoke<'gc>(activation: &mut Activation<'_, 'gc>, source: Value<'gc>, context: Value<'gc>, owner: Value<'gc>) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    let operation = key(activation, "run");
    let result = call(activation, global, &[operation.into(), source, context, owner])?;
    if let Value::Object(envelope) = result {
        assert_eq!(stored(activation, envelope, "version"), 1.0.into());
        Ok(stored(activation, envelope, "value"))
    } else { Ok(result) }
}
fn clean<'gc>(activation: &mut Activation<'_, 'gc>, context: Object<'gc>) {
    let objects = as_object(stored(activation, context, "objects"));
    for index in 0..objects.length(activation).unwrap() {
        if let Value::Object(value) = objects.get_element(activation, index) {
            value.delete(activation, key(activation, "__bhSnapshotRef"));
        }
    }
}

#[test]
fn capability_is_registered_fresh_hidden_and_readonly() {
    with_avm(8, |activation, _| {
        let global = activation.global_object();
        let name = key(activation, "boxheadNativeProjectV1");
        let original = global.get(name, activation)?;
        assert!(matches!(original, Value::Object(value) if value.as_function().is_some()));
        assert!(!global.get_keys(activation, false).contains(&name));
        global.set(name, Value::Undefined, activation)?;
        assert_eq!(global.get(name, activation)?, original);
        assert!(!global.delete(activation, name));
        let first = capability(activation);
        let second = capability(activation);
        assert!(!Object::ptr_eq(first, second));
        assert_eq!(first.get_keys(activation, false).len(), 8);
        assert_eq!(stored(activation, first, "contract"), key(activation, "bh-native-project-v1").into());
        for field in ["calls", "completed", "unsupported", "nodes", "keys", "ownReads"] {
            assert_eq!(stored(activation, first, field), 0.0.into());
        }
        Ok(())
    });
}

fn forbidden<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "forbiddenReads");
    Err(rejected(activation, "forbidden fixture read"))
}

#[test]
fn unsupported_roots_and_malformed_calls_do_not_touch_source() {
    with_avm(8, |activation, clip| {
        let (owner, context) = fixture(activation);
        let source = function(activation, forbidden);
        source.add_property(activation.gc(), key(activation, "fail"), function(activation, forbidden), None, Attribute::empty());
        for value in [source.into(), clip.into(), Value::Undefined, Value::Null, 1.0.into()] {
            assert_eq!(invoke(activation, value, context.into(), owner.into())?, Value::Bool(false));
        }
        let root = object(activation);
        root.add_property(activation.gc(), key(activation, "fail"), function(activation, forbidden), None, Attribute::empty());
        assert_eq!(invoke(activation, root.into(), Value::Null, owner.into())?, Value::Bool(false));
        assert_eq!(invoke(activation, root.into(), context.into(), Value::Null)?, Value::Bool(false));
        assert_eq!(invoke(activation, context.into(), context.into(), owner.into())?, Value::Bool(false));
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!((stats.calls, stats.unsupported, stats.completed, stats.nodes, stats.keys), (8, 8, 0, 0, 0));
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "forbiddenReads"), Value::Undefined);
        let operation = key(activation, "run");
        assert!(call(activation, global, &[operation.into()]).is_err());
        Ok(())
    });
}

#[test]
fn recursive_sorted_graph_preserves_shared_references_cycles_and_field_count() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = object(activation);
        let child = object(activation);
        define(activation, root, "zeta", child.into());
        define(activation, root, "primitive", 7.0.into());
        define(activation, root, "alpha", child.into());
        define(activation, child, "number", 3.0.into());
        define(activation, child, "back", root.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        let alpha = as_object(stored(activation, output, "alpha"));
        assert_eq!(stored(activation, alpha, "number"), 3.0.into());
        let back = as_object(stored(activation, alpha, "back"));
        assert_eq!(stored(activation, back, "$ref"), 0.0.into());
        let zeta = as_object(stored(activation, output, "zeta"));
        assert_eq!(stored(activation, zeta, "$ref"), 1.0.into());
        assert_eq!(stored(activation, context, "fields"), 5.0.into());
        assert_eq!(as_object(stored(activation, context, "objects")).length(activation)?, 2);
        assert!(!root.get_keys(activation, false).contains(&key(activation, "__bhSnapshotRef")));
        clean(activation, context);
        assert_eq!(stored(activation, root, "__bhSnapshotRef"), Value::Undefined);
        Ok(())
    });
}

#[test]
fn scalar_values_include_undefined_nonfinite_negative_zero_and_own_only_policy() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let prototype = object(activation);
        prototype.add_property(activation.gc(), key(activation, "inherited"), function(activation, forbidden), None, Attribute::empty());
        let root = Object::new(&activation.context.strings, Some(prototype));
        for (name, value) in [("undefined", Value::Undefined), ("null", Value::Null),
            ("false", false.into()), ("zero", (-0.0_f64).into()), ("nan", f64::NAN.into()),
            ("infinity", f64::INFINITY.into()), ("skip", 99.0.into()),
            ("method", function(activation, forbidden).into())] {
            define(activation, root, name, value);
        }
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        let undefined = as_object(stored(activation, output, "undefined"));
        assert_eq!(stored(activation, undefined, "$undefined"), 1.0.into());
        assert_eq!(stored(activation, output, "null"), Value::Null);
        assert_eq!(stored(activation, output, "false"), false.into());
        let Value::Number(zero) = stored(activation, output, "zero") else { panic!("zero") };
        assert_eq!(zero.to_bits(), (-0.0_f64).to_bits());
        for (name, text) in [("nan", "NaN"), ("infinity", "Infinity")] {
            let tag = as_object(stored(activation, output, name));
            assert_eq!(stored(activation, tag, "$number"), key(activation, text).into());
        }
        for name in ["skip", "method", "inherited"] { assert_eq!(stored(activation, output, name), Value::Undefined); }
        assert_eq!(stored(activation, context, "fields"), 6.0.into());
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn sparse_arrays_keep_original_length_and_scalar_metadata_overrides() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let source = array(activation, &[1.0.into(), 2.0.into(), 3.0.into()]);
        source.delete(activation, key(activation, "1"));
        let output = as_object(invoke(activation, source.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "$length"), 3.0.into());
        assert_eq!(stored(activation, output, "1"), Value::Undefined);
        assert_eq!(stored(activation, context, "fields"), 2.0.into());
        clean(activation, context);
        let (owner, context) = fixture(activation);
        define(activation, source, "$length", 99.0.into());
        let output = as_object(invoke(activation, source.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "$length"), 99.0.into());
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn map_and_cell_specialcases_do_not_allocate_reference_ids() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = object(activation);
        let cell = object(activation);
        let position = object(activation);
        define(activation, position, "x", 2.0.into()); define(activation, position, "y", 7.0.into());
        define(activation, cell, "_CLASSID_", key(activation, "CMap_Cell").into());
        define(activation, cell, "mPosition", position.into());
        let map = object(activation);
        let collide = object(activation);
        define(activation, map, "_CLASSID_", key(activation, "CMap").into());
        define(activation, map, "mSize", position.into());
        define(activation, map, "mCollide", collide.into());
        define(activation, map, "mFirstTime", true.into());
        define(activation, root, "cellA", cell.into()); define(activation, root, "cellB", cell.into());
        define(activation, root, "map", map.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        for name in ["cellA", "cellB"] {
            let cell = as_object(stored(activation, output, name));
            assert_eq!(stored(activation, cell, "$cell"), key(activation, "2,7").into());
        }
        let projected = as_object(stored(activation, output, "map"));
        assert_eq!(stored(activation, projected, "width"), 2.0.into());
        assert_eq!(stored(activation, projected, "height"), 7.0.into());
        let flag = as_object(stored(activation, projected, "collideFlag"));
        assert_eq!(stored(activation, flag, "$undefined"), 1.0.into());
        assert_eq!(as_object(stored(activation, context, "objects")).length(activation)?, 1);
        assert_eq!(stored(activation, cell, "__bhSnapshotRef"), Value::Undefined);
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn upgrade_definitions_are_read_but_only_original_active_indices_are_projected() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = object(activation);
        define(activation, root, "_CLASSID_", key(activation, "CUpgrades").into());
        define(activation, root, "mLevels", object(activation).into());
        let mut definitions = Vec::new();
        for enabled in [false.into(), 1.0.into(), key(activation, "1").into(), key(activation, "true").into()] {
            let definition = object(activation);
            define(activation, definition, "mActive", enabled);
            definitions.push(definition.into());
        }
        let first = array(activation, &definitions[..2]);
        let second = array(activation, &definitions[2..]);
        let levels = array(activation, &[first.into(), second.into()]);
        define(activation, root, "mMultipliers", levels.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "mLevels"), Value::Undefined);
        let active = as_object(stored(activation, output, "mMultipliers"));
        assert_eq!(active.length(activation)?, 2);
        assert_eq!(active.get_element(activation, 0), key(activation, "0:1").into());
        assert_eq!(active.get_element(activation, 1), key(activation, "1:0").into());
        assert_eq!(stored(activation, context, "fields"), 1.0.into());
        assert_eq!(as_object(stored(activation, context, "objects")).length(activation)?, 1);
        clean(activation, context);
        Ok(())
    });
}

fn change_child<'gc>(activation: &mut Activation<'_, 'gc>, source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let reads = count(activation, "childReads");
    Ok(stored(activation, source, if reads == 1.0 { "firstChild" } else { "secondChild" }))
}

#[test]
fn deferred_getter_is_read_again_at_recursive_traversal_position() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = object(activation);
        for (name, n) in [("firstChild", 1.0), ("secondChild", 2.0)] {
            let child = object(activation); define(activation, child, "n", n.into());
            hidden(activation, root, name, child.into());
        }
        root.add_property(activation.gc(), key(activation, "child"), function(activation, change_child), None, Attribute::empty());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        let child = as_object(stored(activation, output, "child"));
        assert_eq!(stored(activation, child, "n"), 2.0.into());
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "childReads"), 2.0.into());
        clean(activation, context);
        Ok(())
    });
}

fn add_field<'gc>(activation: &mut Activation<'_, 'gc>, source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    define(activation, source, "addedDuringEnumeration", 9.0.into());
    Ok(1.0.into())
}

#[test]
fn enumeration_is_captured_once_and_does_not_admit_later_keys() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let source = object(activation);
        source.add_property(activation.gc(), key(activation, "trigger"), function(activation, add_field), None, Attribute::empty());
        let output = as_object(invoke(activation, source.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "trigger"), 1.0.into());
        assert_eq!(stored(activation, output, "addedDuringEnumeration"), Value::Undefined);
        assert_eq!(stored(activation, source, "addedDuringEnumeration"), 9.0.into());
        clean(activation, context);
        Ok(())
    });
}

fn imposed_sort<'gc>(activation: &mut Activation<'_, 'gc>, array: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    array.set(key(activation, "0"), key(activation, "zeta"), activation)?;
    array.set(key(activation, "1"), key(activation, "alpha"), activation)?;
    count(activation, "sortCalls");
    Ok(array.into())
}

#[test]
fn actual_array_sort_override_determines_recursive_reference_order() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let prototype = activation.prototypes().array;
        hidden(activation, prototype, "sort", function(activation, imposed_sort).into());
        let root = object(activation); let child = object(activation);
        define(activation, child, "n", 1.0.into());
        define(activation, root, "alpha", child.into()); define(activation, root, "zeta", child.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        let zeta = as_object(stored(activation, output, "zeta"));
        assert_eq!(stored(activation, zeta, "n"), 1.0.into());
        let alpha = as_object(stored(activation, output, "alpha"));
        assert_eq!(stored(activation, alpha, "$ref"), 1.0.into());
        let global = activation.global_object(); assert_eq!(stored(activation, global, "sortCalls"), 1.0.into());
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn collisions_budget_and_getter_failures_never_fall_back_after_partial_work() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let source = object(activation);
        define(activation, source, "__bhSnapshotRef", 99.0.into());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        source.delete(activation, key(activation, "__bhSnapshotRef"));
        define(activation, context, "fields", 1000001.0.into());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        assert_eq!(stored(activation, source, "__bhSnapshotRef"), Value::Undefined);
        define(activation, context, "fields", 0.0.into());
        source.add_property(activation.gc(), key(activation, "throws"), function(activation, forbidden), None, Attribute::empty());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        assert_eq!(stored(activation, source, "__bhSnapshotRef"), 0.0.into());
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!((stats.calls, stats.completed, stats.unsupported), (3, 0, 0));
        clean(activation, context);
        assert_eq!(stored(activation, source, "__bhSnapshotRef"), Value::Undefined);
        Ok(())
    });
}

#[test]
fn recursion_budget_stops_before_marking_depth_65_and_keeps_cleanup_list() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = object(activation); let mut cursor = root;
        for _ in 0..70 {
            let child = object(activation); define(activation, cursor, "child", child.into()); cursor = child;
        }
        assert!(invoke(activation, root.into(), context.into(), owner.into()).is_err());
        assert_eq!(as_object(stored(activation, context, "objects")).length(activation)?, 65);
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn execution_timeout_is_checked_before_source_reads() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation); let root = object(activation);
        root.add_property(activation.gc(), key(activation, "fail"), function(activation, forbidden), None, Attribute::empty());
        activation.context.max_execution_duration = Duration::ZERO;
        assert!(matches!(invoke(activation, root.into(), context.into(), owner.into()), Err(Error::ExecutionTimeout)));
        assert_eq!(activation.context.avm1.native_project_stats.nodes, 0);
        Ok(())
    });
}

#[test]
fn no_world_values_or_shapes_survive_between_projections() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation); let root = object(activation);
        define(activation, root, "n", 1.0.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "n"), 1.0.into());
        clean(activation, context);
        let (owner, context) = fixture(activation);
        define(activation, root, "n", 2.0.into()); define(activation, root, "newField", 7.0.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "n"), 2.0.into());
        assert_eq!(stored(activation, output, "newField"), 7.0.into());
        clean(activation, context);
        Ok(())
    });
}

fn counted_process<'gc>(activation: &mut Activation<'_, 'gc>, source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "processReads");
    Ok(stored(activation, source, "fixtureProcess"))
}
fn counted_animation<'gc>(activation: &mut Activation<'_, 'gc>, source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "animationReads");
    Ok(stored(activation, source, "fixtureAnimation"))
}

fn metadata_source<'gc>(activation: &mut Activation<'_, 'gc>, shadow: bool) -> Object<'gc> {
    let root = object(activation);
    let parent = object(activation);
    define(activation, parent, "mUniqueID", 12.0.into());
    define(activation, root, "mParent", parent.into());
    hidden(activation, root, "fixtureProcess", function(activation, forbidden).into());
    root.add_property(activation.gc(), key(activation, "Process"), function(activation, counted_process), None, Attribute::empty());

    let target = object(activation);
    let matching = object(activation);
    define(activation, matching, "mAnimationObject", target.into());
    let items_proto = object(activation);
    define(activation, items_proto, "inheritedMatch", matching.into());
    let items = Object::new(&activation.context.strings, Some(items_proto));
    define(activation, items, "unmatched", object(activation).into());
    let collection = object(activation);
    define(activation, collection, "mItems", items.into());
    let animation = object(activation);
    define(activation, animation, "mCollection", collection.into());
    define(activation, animation, "mAnimationObject", target.into());
    for (name, value) in [("mCurrentFrameID", 4.0.into()), ("mFrameCount", 9.0.into()),
        ("mAnimEnd", false.into()), ("mPreUpdate", true.into())] {
        define(activation, animation, name, value);
    }
    let muzzle = object(activation);
    define(activation, muzzle, "x", 2.0.into()); define(activation, muzzle, "y", 3.0.into());
    let model = object(activation); define(activation, model, "nPosition", muzzle.into());
    let info = object(activation); define(activation, info, "XSI_Model_GunPosition_Right", model.into());
    let frame = object(activation); define(activation, frame, "XSI_Info", info.into());
    define(activation, animation, "mCurrentFrame", frame.into());
    hidden(activation, root, "fixtureAnimation", animation.into());
    root.add_property(activation.gc(), key(activation, "mXSI_Animation"), function(activation, counted_animation), None, Attribute::empty());
    define(activation, root, "laterMuzzle", muzzle.into());
    if shadow {
        define(activation, root, "$parentID", 99.0.into());
        define(activation, root, "$process", key(activation, "source process").into());
        define(activation, root, "$animation", 88.0.into());
    }
    root
}

#[test]
fn synthetic_metadata_preserves_live_reads_inherited_animation_names_and_reference_order() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = metadata_source(activation, false);
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "$parentID"), 12.0.into());
        assert_eq!(stored(activation, output, "$process"), key(activation, "Process_Actual").into());
        let animation = as_object(stored(activation, output, "$animation"));
        assert_eq!(stored(activation, animation, "name"), key(activation, "inheritedMatch").into());
        for (name, value) in [("frame", 4.0.into()), ("count", 9.0.into()),
            ("ended", false.into()), ("preUpdate", true.into())] {
            assert_eq!(stored(activation, animation, name), value);
        }
        let muzzle = as_object(stored(activation, animation, "muzzle"));
        assert_eq!(stored(activation, muzzle, "x"), 2.0.into());
        let later = as_object(stored(activation, output, "laterMuzzle"));
        assert_eq!(stored(activation, later, "$ref"), 2.0.into());
        assert_eq!(as_object(stored(activation, context, "objects")).length(activation)?, 3);
        assert_eq!(stored(activation, context, "fields"), 9.0.into());
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "processReads"), 3.0.into());
        assert_eq!(stored(activation, global, "processNameCalls"), 1.0.into());
        assert_eq!(stored(activation, global, "animationReads"), 3.0.into());
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn scalar_metadata_shadows_output_but_animation_still_allocates_its_reference_ids() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let root = metadata_source(activation, true);
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "$parentID"), 99.0.into());
        assert_eq!(stored(activation, output, "$process"), key(activation, "source process").into());
        assert_eq!(stored(activation, output, "$animation"), 88.0.into());
        let later = as_object(stored(activation, output, "laterMuzzle"));
        assert_eq!(stored(activation, later, "$ref"), 2.0.into());
        assert_eq!(as_object(stored(activation, context, "objects")).length(activation)?, 3);
        assert_eq!(stored(activation, context, "fields"), 12.0.into());
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "processNameCalls"), 1.0.into());
        assert_eq!(stored(activation, global, "animationReads"), 3.0.into());
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn virtual_or_replaced_code_identity_is_rejected_without_reading_the_getter_or_world() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let source = object(activation);
        source.add_property(activation.gc(), key(activation, "_CLASSID_"), function(activation, forbidden), None, Attribute::empty());
        owner.add_property(activation.gc(), key(activation, "BH_Project"), function(activation, forbidden), None, Attribute::empty());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        assert_eq!(activation.context.avm1.native_project_stats.nodes, 0);
        assert_eq!(activation.context.avm1.native_project_stats.unsupported, 0);

        let (owner, context) = fixture(activation);
        let global = activation.global_object();
        global.add_property(activation.gc(), key(activation, "CMain"), function(activation, forbidden), None, Attribute::DONT_ENUM);
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        assert_eq!(activation.context.avm1.native_project_stats.nodes, 0);

        let (owner, context) = fixture(activation);
        hidden(activation, owner, "BH_Project", function(activation, process_name).into());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        assert_eq!(activation.context.avm1.native_project_stats.nodes, 0);
        assert_eq!(stored(activation, global, "forbiddenReads"), Value::Undefined);
        Ok(())
    });
}

fn replace_projector<'gc>(activation: &mut Activation<'_, 'gc>, _source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let global = activation.global_object();
    let owner = as_object(stored(activation, global, "CMain"));
    hidden(activation, owner, "BH_Project", function(activation, process_name).into());
    count(activation, "replacementReads");
    Ok(7.0.into())
}

#[test]
fn code_mutation_after_source_reads_is_fatal_and_retains_the_outer_cleanup_list() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let cache = as_object(stored(activation, owner, "mBHFieldCache"));
        define(activation, cache, "mutatesCode", false.into());
        let source = object(activation);
        source.add_property(activation.gc(), key(activation, "mutatesCode"), function(activation, replace_projector), None, Attribute::empty());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!((stats.calls, stats.completed, stats.unsupported, stats.nodes), (1, 0, 0, 1));
        assert_eq!(stored(activation, source, "__bhSnapshotRef"), 0.0.into());
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "replacementReads"), 1.0.into());
        clean(activation, context);
        assert_eq!(stored(activation, source, "__bhSnapshotRef"), Value::Undefined);
        Ok(())
    });
}

#[test]
fn custom_or_virtual_scan_callbacks_fall_back_before_any_world_read() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let source = object(activation);
        source.add_property(activation.gc(), key(activation, "_CLASSID_"), function(activation, forbidden), None, Attribute::empty());
        define(activation, context, "projectionKernel", function(activation, forbidden).into());
        assert_eq!(invoke(activation, source.into(), context.into(), owner.into())?, false.into());
        context.add_property(activation.gc(), key(activation, "projectionKernel"), function(activation, forbidden), None, Attribute::empty());
        assert_eq!(invoke(activation, source.into(), context.into(), owner.into())?, false.into());
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!((stats.calls, stats.completed, stats.unsupported, stats.nodes, stats.keys), (2, 0, 2, 0, 0));
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "forbiddenReads"), Value::Undefined);
        Ok(())
    });
}

fn replace_scan<'gc>(activation: &mut Activation<'_, 'gc>, source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let context = as_object(stored(activation, source, "fixtureContext"));
    define(activation, context, "projectionKernel", function(activation, forbidden).into());
    Ok(3.0.into())
}

#[test]
fn scan_callback_mutation_during_projection_is_fatal_without_restarting_the_graph() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let cache = as_object(stored(activation, owner, "mBHFieldCache"));
        define(activation, cache, "changesScan", false.into());
        let source = object(activation);
        hidden(activation, source, "fixtureContext", context.into());
        source.add_property(activation.gc(), key(activation, "changesScan"), function(activation, replace_scan), None, Attribute::empty());
        assert!(invoke(activation, source.into(), context.into(), owner.into()).is_err());
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!((stats.calls, stats.completed, stats.unsupported, stats.nodes), (1, 0, 0, 1));
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "forbiddenReads"), Value::Undefined);
        clean(activation, context);
        Ok(())
    });
}

fn coordinate_text<'gc>(activation: &mut Activation<'_, 'gc>, _source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "coordinateConversions");
    Ok(key(activation, "coordinate").into())
}

#[test]
fn pinned_to_string_opcodes_do_not_resolve_the_replaceable_global_string_function() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation);
        let global = activation.global_object();
        hidden(activation, global, "String", function(activation, forbidden).into());
        let root = object(activation);
        define(activation, root, "nan", f64::NAN.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        let nan = as_object(stored(activation, output, "nan"));
        assert_eq!(stored(activation, nan, "$number"), key(activation, "NaN").into());
        clean(activation, context);
        // A deferred property would legitimately box its string key for
        // key.length through global.String. Use a direct cell root to isolate
        // the separate ActionToString conversion without removing that rule.
        let (owner, context) = fixture(activation);
        let cell = object(activation);
        define(activation, cell, "_CLASSID_", key(activation, "CMap_Cell").into());
        let coordinate = object(activation);
        hidden(activation, coordinate, "toString", function(activation, coordinate_text).into());
        let position = object(activation);
        define(activation, position, "x", coordinate.into());
        define(activation, position, "y", 7.0.into());
        define(activation, cell, "mPosition", position.into());
        let projected_cell = as_object(invoke(activation, cell.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, projected_cell, "$cell"), key(activation, "coordinate,7").into());
        assert_eq!(stored(activation, global, "coordinateConversions"), 1.0.into());
        assert_eq!(stored(activation, global, "forbiddenReads"), Value::Undefined);
        assert_eq!(activation.context.avm1.native_project_stats.completed, 2);
        clean(activation, context);
        Ok(())
    });
}

fn active_mode<'gc>(activation: &mut Activation<'_, 'gc>, mode: &str) -> bool {
    let global = activation.global_object();
    stored(activation, global, "activeFixtureMode") == key(activation, mode).into()
}
fn active_integer<'gc>(activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "activeIntegerCalls");
    if active_mode(activation, "integer-throw") { return Err(rejected(activation, "active integer sentinel")); }
    Ok(matches!(args[0], Value::Number(value) if value.is_finite() && value.fract() == 0.0
        && value >= 0.0 && value <= MAX_COUNTER as f64).into())
}
fn active_string<'gc>(activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "activeStringCalls");
    if active_mode(activation, "string-throw") { return Err(rejected(activation, "active string sentinel")); }
    Ok(args[0].coerce_to_string(activation)?.into())
}
fn active_owns<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    if args[0] == key(activation, "keys").into() && this.get_data(key(activation, "scalarFields"), activation).is_some() {
        count(activation, "activeEnvelopeOwnCalls");
        if active_mode(activation, "own-throw") { return Err(rejected(activation, "active own sentinel")); }
        if active_mode(activation, "mutate-envelope") {
            define(activation, this, "scalarFields", key(activation, "4").into());
        }
    }
    crate::avm1::globals::object::has_own_property(activation, this, args)
}
fn enable_scan<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, context: Object<'gc>) -> Result<(), Error<'gc>> {
    let global = activation.global_object();
    let scan = global.get(key(activation, "boxheadNativeProjectionScanV1"), activation)?;
    assert!(matches!(scan, Value::Object(function) if function.as_function().is_some()));
    define(activation, context, "projectionKernel", scan);
    hidden(activation, owner, "BH_Integer", function(activation, active_integer).into());
    hidden(activation, owner, "BH_NativeScalarString", function(activation, active_string).into());
    let prototype = activation.prototypes().object;
    hidden(activation, prototype, "hasOwnProperty", function(activation, active_owns).into());
    Ok(())
}
fn scan_stat<'gc>(activation: &mut Activation<'_, 'gc>, name: &str) -> Result<u64, Error<'gc>> {
    let global = activation.global_object();
    let operation = key(activation, "capability");
    let result = crate::avm1::globals::boxhead_native_projection_scan::call(activation, global, &[operation.into()])?;
    let Value::Number(value) = stored(activation, as_object(result), name) else { panic!("scan counter") };
    Ok(value as u64)
}

#[test]
fn active_frozen_scan_keeps_nonfinite_helper_validation_calls_and_actual_counter_deltas() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation); enable_scan(activation, owner, context)?;
        let root = object(activation); let child = object(activation);
        define(activation, root, "nan", f64::NAN.into());
        define(activation, child, "n", 7.0.into()); define(activation, root, "child", child.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        let child = as_object(stored(activation, output, "child"));
        assert_eq!(stored(activation, child, "n"), 7.0.into());
        assert_eq!(stored(activation, context, "fields"), 3.0.into());
        let global = activation.global_object();
        assert_eq!(stored(activation, global, "activeStringCalls"), 1.0.into());
        assert_eq!(stored(activation, global, "activeIntegerCalls"), 2.0.into());
        assert_eq!(stored(activation, global, "activeEnvelopeOwnCalls"), 2.0.into());
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!(stats.keys, scan_stat(activation, "keys")?);
        assert_eq!(stats.own_reads, scan_stat(activation, "ownReads")?);
        assert_eq!(scan_stat(activation, "calls")?, 2);
        assert_eq!(scan_stat(activation, "completed")?, 2);
        clean(activation, context);
        Ok(())
    });
}

#[test]
fn active_scan_envelope_fields_are_reread_after_has_own_property_mutates_them() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation); enable_scan(activation, owner, context)?;
        let global = activation.global_object();
        hidden(activation, global, "activeFixtureMode", key(activation, "mutate-envelope").into());
        let root = object(activation); define(activation, root, "n", 1.0.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "n"), 1.0.into());
        assert_eq!(stored(activation, context, "fields"), key(activation, "04").into());
        assert_eq!(stored(activation, global, "activeIntegerCalls"), 1.0.into());
        assert_eq!(stored(activation, global, "activeEnvelopeOwnCalls"), 1.0.into());
        clean(activation, context);
        Ok(())
    });
}

fn active_leaf<'gc>(activation: &mut Activation<'_, 'gc>, _source: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "activeLeafReads"); Ok(f64::NAN.into())
}

#[test]
fn active_scan_helper_and_validation_errors_preserve_their_boundary_without_fallback() {
    for (mode, text, completed) in [("integer-throw", "active integer sentinel", 1),
        ("own-throw", "active own sentinel", 1), ("string-throw", "active string sentinel", 0)] {
        with_avm(8, |activation, _| {
            let (owner, context) = fixture(activation); enable_scan(activation, owner, context)?;
            let global = activation.global_object();
            hidden(activation, global, "activeFixtureMode", key(activation, mode).into());
            let root = object(activation);
            root.add_property(activation.gc(), key(activation, "nan"), function(activation, active_leaf), None, Attribute::empty());
            let result = invoke(activation, root.into(), context.into(), owner.into());
            assert!(matches!(result, Err(Error::ThrownValue(value)) if value == key(activation, text).into()));
            assert_eq!(stored(activation, global, "activeLeafReads"), 1.0.into());
            let stats = activation.context.avm1.native_project_stats;
            assert_eq!((stats.calls, stats.completed, stats.unsupported, stats.nodes), (1, 0, 0, 1));
            assert_eq!(stats.keys, scan_stat(activation, "keys")?);
            assert_eq!(stats.own_reads, scan_stat(activation, "ownReads")?);
            assert_eq!(scan_stat(activation, "calls")?, 1);
            assert_eq!(scan_stat(activation, "completed")?, completed);
            clean(activation, context);
            Ok(())
        });
    }
}

fn primitive_cache<'gc>(activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    count(activation, "primitiveCacheReads"); Ok(true.into())
}

#[test]
fn active_scan_strict_false_reuses_the_captured_cache_and_runs_the_inline_scan_once() {
    with_avm(8, |activation, _| {
        let (owner, context) = fixture(activation); enable_scan(activation, owner, context)?;
        let global = activation.global_object();
        let boolean = as_object(global.get(key(activation, "Boolean"), activation)?);
        let prototype = as_object(boolean.get(key(activation, "prototype"), activation)?);
        hidden(activation, prototype, "n", false.into());
        owner.add_property(activation.gc(), key(activation, "mBHFieldCache"), function(activation, primitive_cache), None, Attribute::empty());
        let root = object(activation); define(activation, root, "n", 1.0.into());
        let output = as_object(invoke(activation, root.into(), context.into(), owner.into())?);
        assert_eq!(stored(activation, output, "n"), 1.0.into());
        assert_eq!(stored(activation, global, "primitiveCacheReads"), 1.0.into());
        assert_eq!(stored(activation, global, "activeIntegerCalls"), Value::Undefined);
        assert_eq!(scan_stat(activation, "calls")?, 1);
        assert_eq!(scan_stat(activation, "unsupported")?, 1);
        assert_eq!(scan_stat(activation, "keys")?, 0);
        let stats = activation.context.avm1.native_project_stats;
        assert_eq!((stats.completed, stats.keys, stats.own_reads), (1, 1, 1));
        clean(activation, context);
        Ok(())
    });
}
