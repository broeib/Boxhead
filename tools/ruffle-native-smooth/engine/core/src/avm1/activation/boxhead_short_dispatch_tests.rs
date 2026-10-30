//! Differential fixtures against the exact v21 do_action method. The existing
//! Reader plus the frozen method independently specify every short route. Real
//! executor comparisons cover values, stateful handlers, exceptions and nested
//! execution; neither the expected decoder nor the oracle dispatch uses the new
//! route table. The complete predecessor method is pinned by the source proof.

use super::{Activation, FrameControl, ReturnType, boxhead_short_dispatch};
use crate::avm1::error::Error;
use crate::avm1::function::FunctionObject;
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;
use crate::tag_utils::{SwfMovie, SwfSlice};
use gc_arena::Gc;
use std::sync::Arc;
use std::time::Duration;
use swf::avm1::read::Reader;
use swf::avm1::types::Action;

#[path = "short_dispatch_frozen_v21.rs"]
mod frozen_v21;

fn code(bytes: &[u8], version: u8) -> SwfSlice {
    SwfSlice::from(Arc::new(SwfMovie::fake_with_compressed_data(
        version, None, bytes.to_vec(),
    )))
}

fn push(payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x96];
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn int(value: i32) -> Vec<u8> {
    let mut payload = vec![7];
    payload.extend_from_slice(&value.to_le_bytes());
    push(&payload)
}

fn string(value: &str) -> Vec<u8> {
    let mut payload = vec![0];
    payload.extend_from_slice(value.as_bytes());
    payload.push(0);
    push(&payload)
}

#[derive(Debug)]
enum Exit<'gc> {
    Continue,
    Implicit,
    Explicit(Value<'gc>),
    Thrown(Value<'gc>),
    Timeout,
    Error(String),
}

#[derive(Debug)]
struct Captured<'gc> {
    exit: Exit<'gc>,
    stack: Vec<Value<'gc>>,
    // Absolute movie position is intentional: AVM1 jumps may precede the
    // current function's start, so an unsigned consumed-byte count is wrong.
    position: usize,
    actions: u32,
}

fn same_value<'gc>(left: Value<'gc>, right: Value<'gc>) {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            assert_eq!(left.to_bits(), right.to_bits());
        }
        _ => assert_eq!(left, right),
    }
}

fn same_values<'gc>(left: &[Value<'gc>], right: &[Value<'gc>]) {
    assert_eq!(left.len(), right.len());
    for (&left, &right) in left.iter().zip(right) {
        same_value(left, right);
    }
}

fn same_capture<'gc>(left: &Captured<'gc>, right: &Captured<'gc>) {
    match (&left.exit, &right.exit) {
        (Exit::Continue, Exit::Continue)
        | (Exit::Implicit, Exit::Implicit)
        | (Exit::Timeout, Exit::Timeout) => {}
        (Exit::Explicit(left), Exit::Explicit(right))
        | (Exit::Thrown(left), Exit::Thrown(right)) => same_value(*left, *right),
        (Exit::Error(left), Exit::Error(right)) => assert_eq!(left, right),
        _ => panic!("different boundary: {:?} / {:?}", left.exit, right.exit),
    }
    same_values(&left.stack, &right.stack);
    assert_eq!(left.position, right.position);
    assert_eq!(left.actions, right.actions);
}

fn reset_stack<'gc>(activation: &mut Activation<'_, 'gc>, initial: &[Value<'gc>]) {
    activation.context.avm1.truncate_stack(0);
    for &value in initial {
        activation.context.avm1.push(value);
    }
}

fn step<'b, 'gc>(
    activation: &mut Activation<'_, 'gc>,
    data: &'b SwfSlice,
    reader: &mut Reader<'b>,
    original: bool,
) -> Result<FrameControl<'gc>, Error<'gc>> {
    if original {
        activation.short_dispatch_frozen_do_action(data, reader)
    } else {
        activation.do_action(data, reader)
    }
}

fn captured<'gc>(
    activation: &mut Activation<'_, 'gc>,
    result: Result<FrameControl<'gc>, Error<'gc>>,
    position: usize,
) -> Captured<'gc> {
    let exit = match result {
        Ok(FrameControl::Continue) => Exit::Continue,
        Ok(FrameControl::Return(ReturnType::Implicit)) => Exit::Implicit,
        Ok(FrameControl::Return(ReturnType::Explicit(value))) => Exit::Explicit(value),
        Err(Error::ThrownValue(value)) => Exit::Thrown(value),
        Err(Error::ExecutionTimeout) => Exit::Timeout,
        Err(error) => Exit::Error(error.to_string()),
    };
    let mut stack = Vec::new();
    while activation.context.avm1.stack_len() != 0 {
        stack.push(activation.context.avm1.pop());
    }
    stack.reverse();
    Captured {
        exit,
        stack,
        position,
        actions: *activation.context.actions_since_timeout_check,
    }
}

fn one<'gc>(
    activation: &mut Activation<'_, 'gc>,
    data: &SwfSlice,
    original: bool,
    initial: &[Value<'gc>],
) -> Captured<'gc> {
    reset_stack(activation, initial);
    let mut reader = Reader::new(&data.movie.data()[data.start..], activation.swf_version());
    let result = step(activation, data, &mut reader, original);
    captured(activation, result, data.movie.data().len() - reader.get_ref().len())
}

fn pair<'gc>(
    activation: &mut Activation<'_, 'gc>,
    data: &SwfSlice,
    initial: &[Value<'gc>],
) -> Captured<'gc> {
    let actions = *activation.context.actions_since_timeout_check;
    let original = one(activation, data, true, initial);
    *activation.context.actions_since_timeout_check = actions;
    let candidate = one(activation, data, false, initial);
    same_capture(&candidate, &original);
    candidate
}

fn program<'gc>(
    activation: &mut Activation<'_, 'gc>,
    data: &SwfSlice,
    original: bool,
    initial: &[Value<'gc>],
) -> Captured<'gc> {
    reset_stack(activation, initial);
    let mut reader = Reader::new(&data.movie.data()[data.start..], activation.swf_version());
    let mut count = 0;
    let result = loop {
        count += 1;
        assert!(count <= 128, "fixture program must terminate");
        let result = step(activation, data, &mut reader, original);
        if !matches!(&result, Ok(FrameControl::Continue)) {
            break result;
        }
    };
    captured(activation, result, data.movie.data().len() - reader.get_ref().len())
}

fn key<'gc>(activation: &Activation<'_, 'gc>, name: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), name)
}

fn put<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(activation.gc(), key(activation, name), value, Attribute::empty());
}

fn raw<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Value<'gc> {
    object.get_data(key(activation, name), activation).unwrap_or(Value::Undefined)
}

fn reset_trace(activation: &mut Activation<'_, '_>) {
    let global = activation.global_object();
    for name in ["dispatch-calls", "dispatch-this", "dispatch-argument"] {
        put(activation, global, name, Value::Undefined);
    }
}

fn record<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, argument: Value<'gc>) {
    let global = activation.global_object();
    let calls = match raw(activation, global, "dispatch-calls") {
        Value::Number(value) => value,
        _ => 0.0,
    };
    put(activation, global, "dispatch-calls", (calls + 1.0).into());
    put(activation, global, "dispatch-this", this.into());
    put(activation, global, "dispatch-argument", argument);
}

#[test]
fn short_dispatch_all_82_routes_match_existing_decoder_and_frozen_handlers() {
    const FROZEN: &str = include_str!("short_dispatch_frozen_v21.rs");
    for version in [4, 5, 6, 8, 11] {
        let mut known = 0;
        for opcode in 0_u8..=0x7f {
            let bytes = [opcode, 0xff];
            let mut reader = Reader::new(&bytes, version);
            let action = reader.read_action().expect("a complete short action has no operands");
            assert_eq!(reader.get_ref(), &bytes[1..]);
            let expected = if matches!(action, Action::Unknown(_)) {
                None
            } else {
                let prefix = format!("Action::{action:?} => self.");
                let matches: Vec<_> = FROZEN.lines().filter_map(|line| {
                    line.trim().strip_prefix(&prefix).and_then(|line| line.strip_suffix("(),"))
                }).collect();
                assert_eq!(matches.len(), 1, "missing independent old handler for {action:?}");
                known += 1;
                Some(matches[0])
            };
            assert_eq!(boxhead_short_dispatch::handler_name(opcode), expected, "opcode {opcode:02x}");
        }
        assert_eq!(known, 82);
        for opcode in 0x80_u8..=0xff {
            assert_eq!(boxhead_short_dispatch::handler_name(opcode), None);
        }
        // Call has an operand-free Action variant but a LONG byte encoding.
        let mut call = Reader::new(&[0x9e, 0, 0], version);
        assert!(matches!(call.read_action().unwrap(), Action::Call));
        assert!(call.get_ref().is_empty());
    }
}

#[test]
fn short_dispatch_nonshort_unknown_and_debug_inputs_leave_state_untouched() {
    with_avm(8, |activation, _| {
        for opcode in 0_u8..=0xff {
            let bytes = [opcode, 0xff, 0xff, 0x50];
            let accepted = boxhead_short_dispatch::handler_name(opcode).is_some();
            for debug in [false, true] {
                if accepted && !debug {
                    continue;
                }
                reset_stack(activation, &[Value::Number(-0.0), Value::Bool(true)]);
                *activation.context.actions_since_timeout_check = 71;
                let mut reader = Reader::new(&bytes, 8);
                assert!(boxhead_short_dispatch::try_short_action(activation, &mut reader, debug).is_none());
                assert_eq!(reader.get_ref().as_ptr(), bytes.as_ptr());
                assert_eq!(reader.get_ref(), bytes);
                assert_eq!(*activation.context.actions_since_timeout_check, 71);
                assert_eq!(activation.context.avm1.stack_len(), 2);
                assert_eq!(activation.context.avm1.pop(), Value::Bool(true));
                same_value(activation.context.avm1.pop(), Value::Number(-0.0));
            }
        }
        for debug in [false, true] {
            let mut reader = Reader::new(&[], 8);
            assert!(boxhead_short_dispatch::try_short_action(activation, &mut reader, debug).is_none());
            assert!(reader.get_ref().is_empty());
        }
        Ok(())
    });
}

#[test]
fn short_dispatch_numeric_boolean_and_bitwise_effects_match_frozen_execution() {
    for version in [4, 5, 6, 8, 11] {
        with_avm(version, |activation, _| {
            activation.context.max_execution_duration = Duration::from_secs(3600);
            let values = [Value::Undefined, Value::Null, Value::Bool(false), Value::Bool(true),
                Value::Number(-0.0), Value::Number(0.0), Value::Number(-2.5), Value::Number(33.0),
                Value::Number(f64::INFINITY), Value::Number(f64::from_bits(0x7ff8_1234_5678_9abc)),
                Value::Number(4_294_967_295.0)];
            for opcode in [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x3f, 0x47,
                0x48, 0x49, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67] {
                for &left in &values {
                    for &right in &values {
                        let result = pair(activation, &code(&[opcode], version), &[left, right]);
                        assert!(matches!(result.exit, Exit::Continue));
                        assert_eq!(result.position, 1);
                        assert_eq!(result.stack.len(), 1);
                    }
                }
                pair(activation, &code(&[opcode], version), &[]);
            }
            for opcode in [0x12, 0x18, 0x44, 0x4a, 0x4b, 0x50, 0x51] {
                for &value in &values {
                    pair(activation, &code(&[opcode], version), &[value]);
                }
            }
            // Nonpositive RandomNumber never consumes RNG state; positive
            // random values are intentionally not compared across two calls.
            for value in [0.0, -1.0, f64::NAN] {
                let result = pair(activation, &code(&[0x30], version), &[value.into()]);
                assert_eq!(result.stack, vec![Value::Number(0.0)]);
            }
            Ok(())
        });
    }
}

#[test]
fn short_dispatch_string_and_character_effects_match_frozen_versions() {
    for version in [5, 6, 8] {
        with_avm(version, |activation, _| {
            let values: Vec<Value<'_>> = ["", "0", "-1.5", "café", "é🕹", "Z"]
                .iter().map(|value| key(activation, value).into()).collect();
            for opcode in [0x13, 0x21, 0x29, 0x47, 0x68] {
                for &left in &values {
                    for &right in &values {
                        pair(activation, &code(&[opcode], version), &[left, right]);
                    }
                }
            }
            for opcode in [0x14, 0x31, 0x32, 0x36, 0x4b] {
                for &value in &values {
                    pair(activation, &code(&[opcode], version), &[value]);
                }
            }
            for opcode in [0x15, 0x35] {
                for &value in &values {
                    for start in [-1.0, 1.0, 2.0, 20.0] {
                        for len in [-1.0, 0.0, 1.0, 4.0] {
                            pair(activation, &code(&[opcode], version), &[value, start.into(), len.into()]);
                        }
                    }
                }
            }
            for opcode in [0x33, 0x37] {
                for number in [-1.0, 0.0, 65.0, 233.0, 0xd800 as f64, 0x1f579 as f64] {
                    pair(activation, &code(&[opcode], version), &[number.into()]);
                }
            }
            Ok(())
        });
    }
}

#[test]
fn short_dispatch_stack_return_and_thrown_identity_commit_exactly_one_byte() {
    with_avm(8, |activation, _| {
        let object = Object::new_without_proto(activation.gc());
        let values = [Value::Undefined, Value::Null, Value::Bool(false), Value::Number(-0.0),
            Value::Number(f64::from_bits(0x7ff8_0000_1234_5678)), object.into()];
        for value in values {
            for opcode in [0x00, 0x17, 0x2a, 0x3e, 0x4c, 0x4d] {
                let result = pair(activation, &code(&[opcode, 0x50], 8), &[123.0.into(), value]);
                assert_eq!(result.position, 1);
                match opcode {
                    0x00 => assert!(matches!(result.exit, Exit::Implicit)),
                    0x2a => match result.exit { Exit::Thrown(thrown) => same_value(thrown, value), _ => panic!("missing throw") },
                    0x3e => match result.exit { Exit::Explicit(returned) => same_value(returned, value), _ => panic!("missing return") },
                    _ => assert!(matches!(result.exit, Exit::Continue)),
                }
            }
        }
        for opcode in [0x17, 0x2a, 0x3e, 0x4c, 0x4d] {
            pair(activation, &code(&[opcode], 8), &[]);
        }
        Ok(())
    });
}

fn member_getter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Ok(raw(activation, this, "dispatch-value"))
}

fn member_setter<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[0]);
    put(activation, this, "dispatch-value", args[0]);
    Ok(Value::Undefined)
}

fn member_throw<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, Value::Undefined);
    Err(Error::ThrownValue(raw(activation, this, "dispatch-sentinel")))
}

#[test]
fn short_dispatch_member_getters_setters_and_prototypes_observe_fresh_state() {
    with_avm(8, |activation, _| {
        let proto = Object::new_without_proto(activation.gc());
        let object = Object::new_without_proto(activation.gc());
        let sentinel = Object::new_without_proto(activation.gc());
        let getter = FunctionObject::native(member_getter).build(&activation.context.strings, None, None);
        let setter = FunctionObject::native(member_setter).build(&activation.context.strings, None, None);
        let thrower = FunctionObject::native(member_throw).build(&activation.context.strings, None, None);
        proto.add_property(activation.gc(), key(activation, "value"), getter, Some(setter), Attribute::empty());
        proto.add_property(activation.gc(), key(activation, "failure"), thrower, None, Attribute::empty());
        put(activation, object, "dispatch-sentinel", sentinel.into());
        let mut saved: Option<Vec<Captured<'_>>> = None;
        for original in [true, false] {
            object.set_data(key(activation, "__proto__"), proto.into(), activation)?;
            *activation.context.actions_since_timeout_check = 0;
            reset_trace(activation);
            put(activation, object, "dispatch-value", 11.0.into());
            let input = [object.into(), key(activation, "value").into()];
            let first = one(activation, &code(&[0x4e], 8), original, &input);
            assert_eq!(first.stack, vec![11.0.into()]);
            put(activation, object, "dispatch-value", 17.0.into());
            let second = one(activation, &code(&[0x4e], 8), original, &input);
            assert_eq!(second.stack, vec![17.0.into()]);
            let assigned = one(activation, &code(&[0x4f], 8), original, &[object.into(), input[1], 23.0.into()]);
            assert!(assigned.stack.is_empty());
            assert_eq!(raw(activation, object, "dispatch-value"), 23.0.into());
            let global = activation.global_object();
            assert_eq!(raw(activation, global, "dispatch-argument"), 23.0.into());
            let third = one(activation, &code(&[0x4e], 8), original, &input);
            assert_eq!(third.stack, vec![23.0.into()]);
            let failure_name = key(activation, "failure");
            let failed = one(activation, &code(&[0x4e, 0x50], 8), original, &[object.into(), failure_name.into()]);
            assert!(matches!(failed.exit, Exit::Thrown(Value::Object(value)) if Object::ptr_eq(value, sentinel)));
            assert_eq!(failed.position, 1);
            assert_eq!(raw(activation, global, "dispatch-calls"), 5.0.into());
            assert_eq!(raw(activation, global, "dispatch-this"), object.into());
            // Prototype replacement must be observed by the next same opcode.
            let replacement = Object::new_without_proto(activation.gc());
            put(activation, replacement, "value", 91.0.into());
            object.set_data(key(activation, "__proto__"), replacement.into(), activation)?;
            let replaced = one(activation, &code(&[0x4e], 8), original, &input);
            assert_eq!(replaced.stack, vec![91.0.into()]);
            let results = vec![first, second, assigned, third, failed, replaced];
            if let Some(previous) = &saved {
                for (actual, expected) in results.iter().zip(previous) { same_capture(actual, expected); }
            } else { saved = Some(results); }
        }
        Ok(())
    });
}

fn reentrant_method<'gc>(activation: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record(activation, this, args[0]);
    let original = raw(activation, this, "dispatch-frozen") == Value::Bool(true);
    let throwing = raw(activation, this, "dispatch-throw") == Value::Bool(true);
    let remove = raw(activation, this, "dispatch-remove") == Value::Bool(true);
    let initial_depth = activation.context.avm1.stack_len();
    let mut bytes = int(if throwing { 13 } else { 19 });
    if throwing { bytes.push(0x2a); }
    else { bytes.extend(int(23)); bytes.extend_from_slice(&[0x0a, 0x3e]); }
    let data = code(&bytes, activation.swf_version());
    let mut reader = Reader::new(data.movie.data(), activation.swf_version());
    // The reference side selects the frozen decoder for nested steps too;
    // no candidate route is used as its nested dispatch oracle.
    for _ in 0..8 {
        match step(activation, &data, &mut reader, original) {
            Ok(FrameControl::Continue) => {}
            Ok(FrameControl::Return(result)) => {
                assert_eq!(activation.context.avm1.stack_len(), initial_depth);
                if remove {
                    let clip = activation.base_clip();
                    clip.avm1_unload(activation.context);
                }
                return Ok(result.value());
            }
            Err(error) => {
                assert_eq!(activation.context.avm1.stack_len(), initial_depth);
                return Err(error);
            }
        }
    }
    panic!("nested fixture must terminate");
}

#[test]
fn short_dispatch_nested_calls_exceptions_and_removed_base_clip_keep_boundaries() {
    with_avm(8, |activation, _| {
        let object = Object::new_without_proto(activation.gc());
        let callable = FunctionObject::native(reentrant_method).build(&activation.context.strings, None, None);
        put(activation, object, "go", callable.into());
        let global = activation.global_object();
        put(activation, global, "dispatch_owner", object.into());
        for opcode in [0x3d, 0x52] {
            let receiver = object;
            for throwing in [false, true] {
                let mut saved = None;
                for original in [true, false] {
                    put(activation, receiver, "dispatch-frozen", original.into());
                    put(activation, receiver, "dispatch-throw", throwing.into());
                    put(activation, receiver, "dispatch-remove", false.into());
                    reset_trace(activation);
                    *activation.context.actions_since_timeout_check = 0;
                    let mut initial = vec![99.0.into(), 17.0.into(), 1.0.into()];
                    if opcode == 0x52 { initial.extend([Value::Object(object), Value::String(key(activation, "go"))]); }
                    else { initial.push(key(activation, "dispatch_owner.go").into()); }
                    let result = one(activation, &code(&[opcode, 0x50], 8), original, &initial);
                    assert_eq!(result.position, 1);
                    assert_eq!(raw(activation, global, "dispatch-calls"), 1.0.into());
                    assert_eq!(raw(activation, global, "dispatch-this"), receiver.into());
                    assert_eq!(raw(activation, global, "dispatch-argument"), 17.0.into());
                    if throwing {
                        assert!(matches!(result.exit, Exit::Thrown(Value::Number(13.0))));
                        assert_eq!(result.stack, vec![99.0.into()]);
                        assert_eq!(result.actions, 3);
                    } else {
                        assert!(matches!(result.exit, Exit::Continue));
                        assert_eq!(result.stack, vec![99.0.into(), 42.0.into()]);
                        assert_eq!(result.actions, 5);
                    }
                    if let Some(previous) = &saved { same_capture(&result, previous); }
                    else { saved = Some(result); }
                }
            }
        }
        Ok(())
    });
    // Each side gets a fresh base clip because removal is an actual side effect.
    for original in [true, false] {
        with_avm(8, |activation, _| {
            let object = Object::new_without_proto(activation.gc());
            let callable = FunctionObject::native(reentrant_method).build(&activation.context.strings, None, None);
            put(activation, object, "go", callable.into());
            put(activation, object, "dispatch-frozen", original.into());
            put(activation, object, "dispatch-remove", true.into());
            *activation.context.actions_since_timeout_check = 0;
            let method = key(activation, "go");
            let result = program(activation, &code(&[0x52, 0x50, 0x3e], 8), original,
                &[99.0.into(), 17.0.into(), 1.0.into(), object.into(), method.into()]);
            assert!(activation.base_clip().avm1_removed());
            assert!(matches!(result.exit, Exit::Explicit(Value::Undefined)));
            assert_eq!(result.stack, vec![99.0.into(), 42.0.into()]);
            assert_eq!(result.position, 1); // following Increment/Return never run
            assert_eq!(result.actions, 5);
            Ok(())
        });
    }
}

#[test]
fn short_dispatch_variable_and_container_routes_match_frozen_effects() {
    with_avm(8, |activation, _| {
        let mut bytes = string("dispatch_var"); bytes.extend(int(11)); bytes.push(0x3c);
        bytes.extend(string("dispatch_var")); bytes.push(0x41);
        bytes.extend(string("dispatch_var")); bytes.push(0x1c);
        bytes.extend(string("dispatch_var")); bytes.extend(int(17)); bytes.push(0x1d);
        bytes.extend(string("dispatch_var")); bytes.push(0x1c);
        bytes.extend(string("dispatch_var")); bytes.push(0x3b);
        bytes.extend(string("dispatch_var")); bytes.extend_from_slice(&[0x1c, 0]);
        let data = code(&bytes, 8);
        let mut saved = None;
        for original in [true, false] {
            *activation.context.actions_since_timeout_check = 0;
            let result = program(activation, &data, original, &[]);
            assert_eq!(result.stack, vec![11.0.into(), 17.0.into(), true.into(), Value::Undefined]);
            assert!(matches!(result.exit, Exit::Implicit));
            if let Some(previous) = &saved { same_capture(&result, previous); }
            else { saved = Some(result); }
        }
        let object = Object::new_without_proto(activation.gc());
        put(activation, object, "first", 1.0.into());
        put(activation, object, "second", 2.0.into());
        pair(activation, &code(&[0x55], 8), &[object.into()]);
        for opcode in [0x42, 0x43] {
            let mut normalized: Option<Vec<Value<'_>>> = None;
            for original in [true, false] {
                *activation.context.actions_since_timeout_check = 0;
                let initial = if opcode == 0x42 {
                    vec![7.0.into(), 13.0.into(), 2.0.into()]
                } else {
                    vec![key(activation, "a").into(), 7.0.into(), key(activation, "b").into(), 13.0.into(), 2.0.into()]
                };
                let result = one(activation, &code(&[opcode], 8), original, &initial);
                assert!(matches!(result.exit, Exit::Continue));
                assert_eq!((result.position, result.actions, result.stack.len()), (1, 1, 1));
                let created = result.stack[0].as_object(activation).expect("container result");
                let names = if opcode == 0x42 { ["0", "1", "length"] } else { ["a", "b", "absent"] };
                let values: Vec<_> = names.iter().map(|name| created.get(key(activation, name), activation).unwrap()).collect();
                if opcode == 0x42 { same_values(&values, &[13.0.into(), 7.0.into(), 2.0.into()]); }
                else { same_values(&values, &[7.0.into(), 13.0.into(), Value::Undefined]); }
                if let Some(previous) = &normalized { same_values(&values, previous); }
                else { normalized = Some(values); }
            }
            // Invalid counts keep pre-existing values and allocate no container.
            pair(activation, &code(&[opcode], 8), &[99.0.into(), (-1.0).into()]);
        }
        Ok(())
    });
}

#[test]
fn short_dispatch_timeout_and_eof_precede_every_dispatch_route() {
    with_avm(8, |activation, _| {
        let previous = activation.context.max_execution_duration;
        // Zero and a one-hour limit make both comparisons deterministic; the
        // fixture does not depend on two wall-clock reads straddling a deadline.
        activation.context.max_execution_duration = Duration::ZERO;
        for opcode in 0_u8..=0xff {
            *activation.context.actions_since_timeout_check = 1999;
            let result = pair(activation, &code(&[opcode, 0, 0], 8), &[41.0.into()]);
            assert!(matches!(result.exit, Exit::Timeout));
            assert_eq!((result.position, result.actions), (0, 0));
            assert_eq!(result.stack, vec![41.0.into()]);
        }
        *activation.context.actions_since_timeout_check = 1999;
        let empty_timeout = pair(activation, &code(&[], 8), &[41.0.into()]);
        assert!(matches!(empty_timeout.exit, Exit::Timeout));
        assert_eq!(empty_timeout.position, 0);
        activation.context.max_execution_duration = Duration::from_secs(3600);
        for opcode in 0_u8..=0xff {
            let mut data = code(&[opcode, 0, 0], 8); data.end = 0;
            *activation.context.actions_since_timeout_check = 0;
            let result = pair(activation, &data, &[41.0.into()]);
            assert!(matches!(result.exit, Exit::Implicit));
            assert_eq!((result.position, result.actions), (0, 1));
            assert_eq!(result.stack, vec![41.0.into()]);
        }
        *activation.context.actions_since_timeout_check = 1998;
        let first = pair(activation, &code(&[0x50], 8), &[1.0.into()]);
        assert_eq!(first.actions, 1999);
        let second = pair(activation, &code(&[0x51], 8), &[2.0.into()]);
        assert_eq!(second.actions, 0);
        activation.context.max_execution_duration = previous;
        Ok(())
    });
}

#[test]
fn short_dispatch_negative_jumps_and_cross_boundary_operands_keep_movie_cursor() {
    with_avm(8, |activation, _| {
        for opcode in [0x99, 0x9d] {
            let mut bytes = int(77); bytes.push(0x3e);
            let start = bytes.len();
            bytes.extend_from_slice(&[opcode, 2, 0]);
            let distance = -((start + 5) as i16);
            bytes.extend_from_slice(&distance.to_le_bytes());
            let mut data = code(&bytes, 8); data.start = start;
            let mut saved = None;
            for original in [true, false] {
                *activation.context.actions_since_timeout_check = 0;
                let initial = if opcode == 0x9d { vec![Value::Bool(true)] } else { vec![] };
                let result = program(activation, &data, original, &initial);
                assert!(matches!(result.exit, Exit::Explicit(Value::Number(77.0))));
                assert_eq!(result.position, start);
                assert_eq!(result.actions, 3);
                if let Some(previous) = &saved { same_capture(&result, previous); }
                else { saved = Some(result); }
            }
            if opcode == 0x9d {
                let skipped = pair(activation, &data, &[false.into()]);
                assert!(matches!(skipped.exit, Exit::Continue));
                assert_eq!(skipped.position, bytes.len());
            }
        }
        let underflow = code(&[0x99, 2, 0, 0, 0x80], 8);
        let mut saved = None;
        for original in [true, false] {
            *activation.context.actions_since_timeout_check = 0;
            let result = program(activation, &underflow, original, &[]);
            assert!(matches!(result.exit, Exit::Implicit));
            assert_eq!((result.position, result.actions), (5, 2));
            if let Some(previous) = &saved { same_capture(&result, previous); }
            else { saved = Some(result); }
        }
        let bytes = int(123456);
        let mut data = code(&bytes, 8); data.end = 1;
        let crossed = pair(activation, &data, &[]);
        assert_eq!(crossed.position, bytes.len());
        assert_eq!(crossed.stack, vec![123456.0.into()]);
        Ok(())
    });
}

#[test]
fn short_dispatch_long_call_unknown_and_malformed_forms_keep_parser_fallback() {
    with_avm(8, |activation, _| {
        for bytes in [vec![0x9e], vec![0x9e, 0], vec![0x96], vec![0x96, 1],
            vec![0x96, 5, 0, 7, 1], vec![0x96, 1, 0, 7, 1, 2, 3, 4, 0x17],
            vec![0x96, 2, 0, 0, b'a', 0, 0x17], vec![0x96, 0xff, 0xff, 2],
            vec![0x96, 4, 0, 2, 7, 1, 2], vec![0x99, 2, 0, 0xff],
            vec![0x01, 0x50], vec![0xff, 3, 0, 1, 2, 3, 0x50]] {
            pair(activation, &code(&bytes, 8), &[Value::Null]);
        }
        for (bytes, position) in [(vec![0x9e, 0, 0, 0x50], 3), (vec![0x9e, 1, 0, 0x7f, 0x50], 4)] {
            let result = pair(activation, &code(&bytes, 8), &[Value::Null]);
            assert_eq!(result.position, position);
        }
        let malformed = pair(activation, &code(&[0x96, 4, 0, 2, 7, 1, 2], 8), &[99.0.into()]);
        assert!(matches!(malformed.exit, Exit::Error(_)));
        assert_eq!(malformed.stack, vec![99.0.into()]);
        let lenient = pair(activation, &code(&push(&[2, 10, 3]), 8), &[]);
        assert_eq!(lenient.stack, vec![Value::Null, Value::Undefined]);
        Ok(())
    });
}

#[test]
fn short_dispatch_mixed_program_debug_pool_registers_and_control_flow_match() {
    with_avm(8, |activation, _| {
        let mut bytes = vec![0x88, 6, 0, 2, 0, b'a', 0, b'b', 0];
        bytes.extend(push(&[8, 0])); bytes.extend(push(&[9, 1, 0])); bytes.push(0x47);
        bytes.extend_from_slice(&[0x87, 1, 0, 1, 0x17]);
        bytes.extend(int(2)); bytes.extend(int(3)); bytes.push(0x0a);
        bytes.extend(push(&[5, 1])); bytes.extend_from_slice(&[0x9d, 2, 0, 8, 0]); bytes.extend(int(999));
        bytes.extend(push(&[4, 1])); bytes.extend(string("_tail")); bytes.push(0x21);
        bytes.extend_from_slice(&[0x87, 1, 0, 3, 0x17]);
        bytes.extend(int(37)); bytes.extend_from_slice(&[0x0a, 0x3e, 0]);
        let data = code(&bytes, 8);
        for debug in [false, true] {
            let mut saved: Option<(Captured<'_>, Vec<Value<'_>>, Vec<Value<'_>>)> = None;
            for original in [true, false] {
                activation.context.avm1.clear();
                activation.context.avm1.set_show_debug_output(debug);
                assert_eq!(activation.context.avm1.show_debug_output(), debug && cfg!(feature = "avm_debug"));
                *activation.context.actions_since_timeout_check = 0;
                let pool = Gc::new(activation.gc(), vec![]); activation.set_constant_pool(pool);
                let result = program(activation, &data, original, &[]);
                assert!(matches!(result.exit, Exit::Explicit(Value::Number(42.0))));
                assert!(result.stack.is_empty());
                assert_eq!(result.position, bytes.len() - 1);
                let registers: Vec<_> = (0..4).map(|id| *activation.context.avm1.get_register(id).unwrap()).collect();
                assert_eq!(registers[3].coerce_to_string(activation)?.to_utf8_lossy(), "ab_tail");
                let pool = activation.constant_pool().to_vec();
                assert_eq!(pool.len(), 2);
                if let Some((previous, previous_registers, previous_pool)) = &saved {
                    same_capture(&result, previous);
                    same_values(&registers, previous_registers);
                    same_values(&pool, previous_pool);
                } else { saved = Some((result, registers, pool)); }
            }
        }
        activation.context.avm1.set_show_debug_output(false);
        Ok(())
    });
}
