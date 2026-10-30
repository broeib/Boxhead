//! Actual Activation fixtures. The oracle dispatch and Push conversion are
//! copied from v13 and checked byte-for-byte by the package source proof.

use super::{Activation, ActivationIdentifier, FrameControl, ReturnType};
use crate::avm1::error::Error;
use crate::avm1::function::FunctionObject;
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;
use crate::tag_utils::{SwfMovie, SwfSlice};
use gc_arena::Gc;
use std::cell::Cell;
use std::sync::Arc;
use std::time::Duration;
use swf::avm1::read::Reader;

#[path = "single_push_frozen_v13.rs"]
mod frozen_v13;

fn push(payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x96];
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn int(value: i32) -> Vec<u8> {
    let mut payload = vec![7]; payload.extend_from_slice(&value.to_le_bytes()); push(&payload)
}

fn code(bytes: &[u8], version: u8) -> SwfSlice {
    SwfSlice::from(Arc::new(SwfMovie::fake_with_compressed_data(version, None, bytes.to_vec())))
}

#[derive(Debug)]
enum Exit<'gc> {
    Continue,
    Implicit,
    Explicit(Value<'gc>),
    Error(String),
}

#[derive(Debug)]
struct Captured<'gc> {
    exit: Exit<'gc>,
    stack: Vec<Value<'gc>>,
    consumed: usize,
    actions: u32,
}

fn same_value<'gc>(left: Value<'gc>, right: Value<'gc>) {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => assert_eq!(left.to_bits(), right.to_bits()),
        _ => assert_eq!(left, right),
    }
}

fn same_values<'gc>(left: &[Value<'gc>], right: &[Value<'gc>]) {
    assert_eq!(left.len(), right.len());
    for (&left, &right) in left.iter().zip(right) { same_value(left, right); }
}

fn same_capture<'gc>(left: &Captured<'gc>, right: &Captured<'gc>) {
    match (&left.exit, &right.exit) {
        (Exit::Continue, Exit::Continue) | (Exit::Implicit, Exit::Implicit) => {}
        (Exit::Explicit(left), Exit::Explicit(right)) => same_value(*left, *right),
        (Exit::Error(left), Exit::Error(right)) => assert_eq!(left, right),
        _ => panic!("different execution boundary: {:?} / {:?}", left.exit, right.exit),
    }
    same_values(&left.stack, &right.stack);
    assert_eq!(left.consumed, right.consumed);
    assert_eq!(left.actions, right.actions);
}

fn captured<'gc>(
    activation: &mut Activation<'_, 'gc>,
    result: Result<FrameControl<'gc>, Error<'gc>>,
    consumed: usize,
) -> Captured<'gc> {
    let exit = match result {
        Ok(FrameControl::Continue) => Exit::Continue,
        Ok(FrameControl::Return(ReturnType::Implicit)) => Exit::Implicit,
        Ok(FrameControl::Return(ReturnType::Explicit(value))) => Exit::Explicit(value),
        Err(error) => Exit::Error(error.to_string()),
    };
    let mut stack = Vec::new();
    while activation.context.avm1.stack_len() != 0 { stack.push(activation.context.avm1.pop()); }
    stack.reverse();
    Captured { exit, stack, consumed, actions: *activation.context.actions_since_timeout_check }
}

fn one<'gc>(activation: &mut Activation<'_, 'gc>, data: &SwfSlice, original: bool) -> Captured<'gc> {
    let input = &data.movie.data()[data.start..];
    let mut reader = Reader::new(input, activation.swf_version());
    let result = if original {
        activation.frozen_do_action(data, &mut reader)
    } else {
        activation.do_action(data, &mut reader)
    };
    captured(activation, result, input.len() - reader.get_ref().len())
}

fn pair<'gc>(activation: &mut Activation<'_, 'gc>, data: &SwfSlice, initial: &[Value<'gc>]) -> Captured<'gc> {
    let actions = *activation.context.actions_since_timeout_check;
    activation.context.avm1.truncate_stack(0);
    for &value in initial { activation.context.avm1.push(value); }
    let original = one(activation, data, true);
    *activation.context.actions_since_timeout_check = actions;
    for &value in initial { activation.context.avm1.push(value); }
    let candidate = one(activation, data, false);
    same_capture(&candidate, &original);
    candidate
}

fn program<'gc>(activation: &mut Activation<'_, 'gc>, data: &SwfSlice, original: bool) -> Captured<'gc> {
    let input = &data.movie.data()[data.start..];
    let mut reader = Reader::new(input, activation.swf_version());
    let mut count = 0;
    let result = loop {
        count += 1;
        assert!(count <= 512, "fixture program must terminate");
        let result = if original { activation.frozen_do_action(data, &mut reader) }
            else { activation.do_action(data, &mut reader) };
        if !matches!(&result, Ok(FrameControl::Continue)) { break result; }
    };
    captured(activation, result, input.len() - reader.get_ref().len())
}

#[test]
fn single_push_activation_fixed_values_match_frozen_execution() {
    for version in [5, 6, 7, 8, 11] {
        with_avm(version, |activation, _| {
            let mut forms = vec![push(&[2]), push(&[3]), push(&[5, 0]), push(&[5, 255]),
                int(i32::MIN), int(i32::MAX), int(0), push(&[1, 0, 0, 0, 128])];
            for bits in [0_u64, 0x8000_0000_0000_0000, 1, 0x7ff0_0000_0000_0000,
                0xfff0_0000_0000_0000, 0x7ff8_1234_5678_9abc, 0x7ff0_0000_0000_0001] {
                let mut payload = vec![6]; payload.extend_from_slice(&bits.rotate_left(32).to_le_bytes());
                forms.push(push(&payload));
            }
            for bytes in forms {
                let result = pair(activation, &code(&bytes, version), &[Value::Bool(true)]);
                assert!(matches!(result.exit, Exit::Continue));
                assert_eq!(result.stack.len(), 2); assert_eq!(result.stack[0], Value::Bool(true));
            }
            Ok(())
        });
    }
}

#[test]
fn single_push_activation_constant_pool_reads_are_fresh_and_keep_invalid_indices() {
    with_avm(8, |activation, _| {
        let code8 = code(&push(&[8, 0]), 8);
        let code16 = code(&push(&[9, 0, 0]), 8);
        for value in [Value::Number(-0.0), Value::Bool(false), Value::Null] {
            let pool = Gc::new(activation.gc(), vec![value]); activation.set_constant_pool(pool);
            for data in [&code8, &code16] {
                let result = pair(activation, data, &[]); same_value(result.stack[0], value);
            }
        }
        let pool = Gc::new(activation.gc(), vec![]); activation.set_constant_pool(pool);
        assert_eq!(pair(activation, &code8, &[]).stack, vec![Value::Undefined]);
        assert_eq!(pair(activation, &code16, &[]).stack, vec![Value::Undefined]);
        for bytes in [push(&[8, 0]), push(&[8, 255]), push(&[9, 0xff, 0xff])] {
            assert_eq!(pair(activation, &code(&bytes, 8), &[]).stack, vec![Value::Undefined]);
        }
        Ok(())
    });
}

#[test]
fn single_push_activation_local_and_global_register_rules_match_player_versions() {
    with_avm(8, |activation, _| {
        for player_version in [8, 10, 11, 32] {
            activation.context.player_version = player_version;
            *activation.context.avm1.get_register_mut(3).unwrap() = 77.0.into();
            let registers = [Cell::new(Value::Number(-0.0)), Cell::new(Value::Undefined)];
            let scope = activation.scope; let pool = activation.constant_pool; let clip = activation.base_clip;
            let this = activation.this;
            let mut child = Activation::from_action(activation.context, ActivationIdentifier::root("[single Push registers]"),
                8, scope, pool, clip, this, None, &registers);
            let local0 = code(&push(&[4, 0]), 8);
            same_value(pair(&mut child, &local0, &[]).stack[0], Value::Number(-0.0));
            for id in [0, 1, 2, 3, 4, 255] {
                let expected = if id == 0 { Value::Number(-0.0) }
                    else if id == 3 && player_version > 10 { 77.0.into() } else { Value::Undefined };
                let result = pair(&mut child, &code(&push(&[4, id]), 8), &[]); same_value(result.stack[0], expected);
            }
            registers[0].set(Value::Bool(true));
            assert_eq!(pair(&mut child, &local0, &[]).stack, vec![Value::Bool(true)]);
        }
        // An activation without local registers uses global registers even in FP10.
        activation.context.player_version = 10;
        *activation.context.avm1.get_register_mut(3).unwrap() = 91.0.into();
        assert_eq!(pair(activation, &code(&push(&[4, 3]), 8), &[]).stack, vec![91.0.into()]);
        Ok(())
    });
}

#[test]
fn single_push_activation_register_and_pool_objects_keep_movieclip_wrapping() {
    for version in [5, 8] {
        with_avm(version, |activation, root| {
            *activation.context.avm1.get_register_mut(1).unwrap() = root.into();
            let pool = Gc::new(activation.gc(), vec![root.into()]); activation.set_constant_pool(pool);
            for bytes in [push(&[4, 1]), push(&[8, 0]), push(&[9, 0, 0])] {
                let result = pair(activation, &code(&bytes, version), &[]);
                let Value::MovieClip(reference) = result.stack[0] else { panic!("root must be wrapped") };
                assert!(Object::ptr_eq(reference.coerce_to_object(activation).unwrap(), root));
                assert_eq!(*activation.context.avm1.get_register(1).unwrap(), Value::Object(root));
            }
            Ok(())
        });
    }
}

fn forbidden<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    Err(Error::ThrownValue(AvmString::new_utf8(activation.gc(), "unexpected Push coercion").into()))
}

#[test]
fn single_push_activation_plain_objects_are_not_coerced() {
    with_avm(8, |activation, _| {
        let object = Object::new_without_proto(activation.gc());
        let getter = FunctionObject::native(forbidden).build(&activation.context.strings, None, None);
        for name in ["valueOf", "toString", "__proto__"] {
            object.add_property(activation.gc(), AvmString::new_utf8(activation.gc(), name), getter, None, Attribute::empty());
        }
        *activation.context.avm1.get_register_mut(2).unwrap() = object.into();
        let pool = Gc::new(activation.gc(), vec![object.into()]); activation.set_constant_pool(pool);
        for bytes in [push(&[4, 2]), push(&[8, 0])] {
            let result = pair(activation, &code(&bytes, 8), &[]);
            assert!(matches!(result.exit, Exit::Continue)); assert_eq!(result.stack, vec![object.into()]);
        }
        Ok(())
    });
}

#[test]
fn single_push_activation_removed_clip_reference_path_is_unchanged() {
    with_avm(8, |activation, root| {
        *activation.context.avm1.get_register_mut(1).unwrap() = root.into();
        let clip = activation.base_clip(); clip.avm1_unload(activation.context);
        let result = pair(activation, &code(&push(&[4, 1]), 8), &[]);
        assert!(matches!(result.exit, Exit::Continue));
        assert!(matches!(result.stack[0], Value::MovieClip(_)));
        assert!(activation.base_clip().avm1_removed());
        Ok(())
    });
}

#[test]
fn single_push_activation_multi_push_parse_errors_do_not_partially_mutate_stack() {
    with_avm(8, |activation, _| {
        let bytes = [0x96, 4, 0, 2, 7, 1, 2];
        let result = pair(activation, &code(&bytes, 8), &[Value::Bool(true)]);
        assert!(matches!(result.exit, Exit::Error(_)));
        assert_eq!(result.stack, vec![Value::Bool(true)]);
        let valid = pair(activation, &code(&push(&[2, 10, 3]), 8), &[]);
        assert_eq!(valid.stack, vec![Value::Null, Value::Undefined]);
        Ok(())
    });
}

#[test]
fn single_push_activation_malformed_lengths_keep_return_stack_and_cursor() {
    with_avm(8, |activation, _| {
        for bytes in [vec![0x96], vec![0x96, 1], vec![0x96, 5, 0, 7, 1],
            vec![0x96, 1, 0, 7, 1, 2, 3, 4, 0x17],
            vec![0x96, 2, 0, 0, b'a', 0, 0x17], vec![0x96, 0xff, 0xff, 2]] {
            pair(activation, &code(&bytes, 8), &[Value::Number(123.0)]);
        }
        let result = pair(activation, &code(&[0x96, 1, 0, 7, 1, 2, 3, 4, 0x17], 8), &[]);
        assert!(matches!(result.exit, Exit::Continue));
        assert_eq!(result.consumed, 4);
        assert_eq!(result.stack, vec![Value::Number(0x0403_0201 as f64)]);
        Ok(())
    });
}

#[test]
fn single_push_activation_function_end_precedes_opcode_but_does_not_bound_operand() {
    with_avm(8, |activation, _| {
        let bytes = int(123456);
        let mut data = code(&bytes, 8);
        data.end = 0;
        let empty = pair(activation, &data, &[]);
        assert!(matches!(empty.exit, Exit::Implicit)); assert_eq!(empty.consumed, 0); assert!(empty.stack.is_empty());
        data.end = 1;
        let crossed = pair(activation, &data, &[]);
        assert!(matches!(crossed.exit, Exit::Continue)); assert_eq!(crossed.consumed, bytes.len());
        assert_eq!(crossed.stack, vec![123456.0.into()]);
        for original in [true, false] {
            *activation.context.actions_since_timeout_check = 0;
            let result = program(activation, &data, original);
            assert!(matches!(result.exit, Exit::Implicit)); assert_eq!(result.actions, 2);
            assert_eq!(result.stack, vec![123456.0.into()]);
        }
        Ok(())
    });
}

#[test]
fn single_push_activation_action_count_and_timeout_precede_decoding() {
    with_avm(8, |activation, _| {
        let previous = activation.context.max_execution_duration;
        activation.context.max_execution_duration = Duration::ZERO;
        for bytes in [int(17), vec![0x96], vec![]] {
            *activation.context.actions_since_timeout_check = 1999;
            let result = pair(activation, &code(&bytes, 8), &[Value::Number(41.0)]);
            assert!(matches!(result.exit, Exit::Error(_))); assert_eq!(result.consumed, 0);
            assert_eq!(result.actions, 0); assert_eq!(result.stack, vec![41.0.into()]);
        }
        activation.context.max_execution_duration = Duration::from_secs(3600);
        *activation.context.actions_since_timeout_check = 1998;
        let first = pair(activation, &code(&int(17), 8), &[]); assert_eq!(first.actions, 1999);
        let next = pair(activation, &code(&push(&[2]), 8), &[]); assert_eq!(next.actions, 0);
        activation.context.max_execution_duration = previous;
        Ok(())
    });
}

#[test]
fn single_push_activation_debug_mode_keeps_parser_route() {
    with_avm(8, |activation, _| {
        activation.context.avm1.set_show_debug_output(true);
        assert_eq!(activation.context.avm1.show_debug_output(), cfg!(feature = "avm_debug"));
        let bytes = int(17);
        // The recognizer's explicit true branch is exercised even when this
        // test build has the upstream avm_debug feature disabled. With that
        // feature enabled the actual Activation takes the same fallback.
        let mut reader = Reader::new(&bytes, 8);
        assert!(super::boxhead_single_push::read_single_push(&mut reader, true).is_none());
        assert_eq!(reader.get_ref().as_ptr(), bytes.as_ptr());
        assert_eq!(pair(activation, &code(&bytes, 8), &[]).stack, vec![17.0.into()]);
        activation.context.avm1.set_show_debug_output(false);
        Ok(())
    });
}

#[test]
fn single_push_activation_mixed_program_keeps_stack_registers_pool_and_jumps() {
    with_avm(8, |activation, _| {
        let mut bytes = vec![0x88, 6, 0, 2, 0, b'a', 0, b'b', 0];
        bytes.extend(push(&[8, 0])); bytes.extend(push(&[9, 1, 0])); bytes.push(0x47);
        bytes.extend_from_slice(&[0x87, 1, 0, 1, 0x17]);
        bytes.extend(int(42)); bytes.extend_from_slice(&[0x87, 1, 0, 2, 0x17]);
        bytes.extend(push(&[4, 1])); bytes.extend(push(&[0, b'_', b't', b'a', b'i', b'l', 0])); bytes.push(0x21);
        bytes.extend(int(2)); bytes.extend(int(3)); bytes.push(0x0a);
        bytes.extend_from_slice(&[0x99, 2, 0, 8, 0]); bytes.extend(int(999));
        bytes.extend(push(&[4, 2])); bytes.extend_from_slice(&[0x0a, 0x3e, 0]);
        let data = code(&bytes, 8);
        let mut saved: Option<(Captured<'_>, Vec<Value<'_>>, Vec<Value<'_>>)> = None;
        for original in [true, false] {
            activation.context.avm1.clear(); *activation.context.actions_since_timeout_check = 0;
            let pool = Gc::new(activation.gc(), vec![]); activation.set_constant_pool(pool);
            let result = program(activation, &data, original);
            assert!(matches!(result.exit, Exit::Explicit(Value::Number(47.0))));
            assert_eq!(result.actions, 19); assert_eq!(result.stack.len(), 1);
            assert_eq!(result.stack[0].coerce_to_string(activation)?.to_utf8_lossy(), "ab_tail");
            assert_eq!(*activation.context.avm1.get_register(2).unwrap(), Value::Number(42.0));
            assert_eq!(activation.constant_pool().len(), 2);
            let registers: Vec<_> = (0..4).map(|id| *activation.context.avm1.get_register(id).unwrap()).collect();
            let pool = activation.constant_pool().to_vec();
            if let Some((previous, previous_registers, previous_pool)) = &saved {
                same_capture(&result, previous); same_values(&registers, previous_registers); same_values(&pool, previous_pool);
            } else { saved = Some((result, registers, pool)); }
        }
        Ok(())
    });
}

#[test]
fn single_push_activation_strings_keep_original_swf_encoding_path() {
    for version in [5, 6, 8] {
        with_avm(version, |activation, _| {
            let result = pair(activation, &code(&push(&[0, b'c', b'a', b'f', 0xe9, 0]), version), &[]);
            let text = result.stack[0].coerce_to_string(activation)?.to_utf8_lossy().into_owned();
            assert_eq!(text, if version == 5 { "café" } else { "caf�" });
            Ok(())
        });
    }
}

#[test]
fn single_push_activation_store_register_then_push_observes_instruction_order() {
    with_avm(8, |activation, _| {
        let mut bytes = int(41); bytes.extend_from_slice(&[0x87, 1, 0, 3, 0x17]);
        bytes.extend(push(&[4, 3])); bytes.push(0x50); bytes.extend_from_slice(&[0x87, 1, 0, 3, 0x17]);
        bytes.extend(push(&[4, 3])); bytes.push(0x3e);
        let data = code(&bytes, 8); let mut saved = None;
        for original in [true, false] {
            activation.context.avm1.clear(); *activation.context.actions_since_timeout_check = 0;
            let result = program(activation, &data, original);
            assert!(matches!(result.exit, Exit::Explicit(Value::Number(42.0))));
            assert_eq!(*activation.context.avm1.get_register(3).unwrap(), Value::Number(42.0));
            if let Some(previous) = &saved { same_capture(&result, previous); }
            else { saved = Some(result); }
        }
        Ok(())
    });
}
