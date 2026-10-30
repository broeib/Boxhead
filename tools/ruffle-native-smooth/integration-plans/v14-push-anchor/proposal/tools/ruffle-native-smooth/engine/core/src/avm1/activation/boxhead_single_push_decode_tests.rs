//! The unchanged public SWF Reader is the independent decoding oracle.
//! These fixtures never implement a second manual fixed-width decoder.

use super::read_single_push;
use swf::avm1::read::Reader;
use swf::avm1::types::{Action, Value};

fn instruction(payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x96];
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn same_value(left: &Value<'_>, right: &Value<'_>) {
    match (left, right) {
        (Value::Float(left), Value::Float(right)) => assert_eq!(left.to_bits(), right.to_bits()),
        (Value::Double(left), Value::Double(right)) => assert_eq!(left.to_bits(), right.to_bits()),
        _ => assert_eq!(left, right),
    }
}

fn accepted(bytes: &[u8], version: u8) {
    let mut candidate = Reader::new(bytes, version);
    let mut original = Reader::new(bytes, version);
    let value = read_single_push(&mut candidate, false).expect("eligible singleton");
    let Action::Push(push) = original.read_action().expect("original parser success") else {
        panic!("not an original Push");
    };
    assert_eq!(push.values.len(), 1);
    same_value(&value, &push.values[0]);
    assert_eq!(candidate.get_ref().as_ptr(), original.get_ref().as_ptr());
    assert_eq!(candidate.get_ref().len(), original.get_ref().len());
}

fn rejected_unchanged(bytes: &[u8], debug: bool) {
    let mut candidate = Reader::new(bytes, 8);
    assert!(read_single_push(&mut candidate, debug).is_none());
    assert_eq!(candidate.get_ref().as_ptr(), bytes.as_ptr());
    assert_eq!(candidate.get_ref().len(), bytes.len());
}

fn fixed_forms() -> Vec<Vec<u8>> {
    vec![
        instruction(&[1, 0, 0, 0, 128]),
        instruction(&[2]),
        instruction(&[3]),
        instruction(&[4, 255]),
        instruction(&[5, 255]),
        instruction(&[6, 0x34, 0x12, 0xf8, 0x7f, 0xef, 0xcd, 0xab, 0x90]),
        instruction(&[7, 0, 0, 0, 128]),
        instruction(&[8, 255]),
        instruction(&[9, 0x34, 0x12]),
    ]
}

#[test]
fn single_push_all_fixed_tags_match_original_reader() {
    for version in [4, 5, 6, 7, 8, 10, 11, 32] {
        for bytes in fixed_forms() {
            accepted(&bytes, version);
        }
    }
}

#[test]
fn single_push_u8_payloads_match_all_bool_register_constant_values() {
    for tag in [4, 5, 8] {
        for payload in 0..=u8::MAX {
            accepted(&instruction(&[tag, payload]), 8);
        }
    }
}

#[test]
fn single_push_constant16_preserves_every_index() {
    for index in 0..=u16::MAX {
        let [low, high] = index.to_le_bytes();
        accepted(&instruction(&[9, low, high]), 8);
    }
}

#[test]
fn single_push_ieee_bits_and_middle_endian_doubles_match_reader() {
    let floats = [0, 0x8000_0000, 1, 0x007f_ffff, 0x0080_0000, 0x7f7f_ffff,
        0xff7f_ffff, 0x7f80_0000, 0xff80_0000, 0x7fc0_0000, 0x7fa0_0001, 0xffc1_2345];
    let doubles = [0, 0x8000_0000_0000_0000, 1, 0x000f_ffff_ffff_ffff,
        0x0010_0000_0000_0000, 0x7fef_ffff_ffff_ffff, 0x7ff0_0000_0000_0000,
        0xfff0_0000_0000_0000, 0x7ff8_0000_0000_0000, 0x7ff0_1234_5678_9abc,
        0xfff8_7654_3210_fedc];
    for bits in floats {
        let mut payload = vec![1]; payload.extend_from_slice(&u32::to_le_bytes(bits));
        accepted(&instruction(&payload), 8);
    }
    for bits in doubles {
        let mut payload = vec![6]; payload.extend_from_slice(&u64::rotate_left(bits, 32).to_le_bytes());
        accepted(&instruction(&payload), 8);
    }
    let mut state = 0x7369_6e67_6c65_7075_u64;
    for _ in 0..4096 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let mut float = vec![1]; float.extend_from_slice(&(state as u32).to_le_bytes());
        let mut double = vec![6]; double.extend_from_slice(&state.rotate_left(32).to_le_bytes());
        accepted(&instruction(&float), 8);
        accepted(&instruction(&double), 8);
    }
}

#[test]
fn single_push_accepted_decoding_leaves_following_actions_untouched() {
    for mut bytes in fixed_forms() {
        let end = bytes.len();
        bytes.extend_from_slice(&[0x0a, 0x17, 0x00]);
        accepted(&bytes, 8);
        let mut reader = Reader::new(&bytes, 8);
        assert!(read_single_push(&mut reader, false).is_some());
        assert_eq!(reader.get_ref(), &bytes[end..]);
        assert_eq!(reader.read_action().unwrap(), Action::Add);
        assert_eq!(reader.read_action().unwrap(), Action::Pop);
        assert_eq!(reader.read_action().unwrap(), Action::End);
    }
}

#[test]
fn single_push_every_truncated_fixed_form_keeps_fallback_cursor() {
    for bytes in fixed_forms() {
        for end in 0..bytes.len() {
            rejected_unchanged(&bytes[..end], false);
        }
    }
}

#[test]
fn single_push_wrong_lengths_and_strings_are_immutable_fallbacks() {
    for bytes in fixed_forms() {
        let expected = bytes.len() - 3;
        for length in [0, expected - 1, expected + 1, 255, 256, 65535] {
            let mut wrong = bytes.clone();
            wrong[1..3].copy_from_slice(&(length as u16).to_le_bytes());
            wrong.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            rejected_unchanged(&wrong, false);
        }
    }
    for bytes in [instruction(&[0, 0]), instruction(&[0, b'a', 0]),
        instruction(&[0, b'a']), instruction(&[0, 0xc3, 0xa9, 0]), vec![0x96, 0, 0]] {
        rejected_unchanged(&bytes, false);
    }
}

#[test]
fn single_push_invalid_tags_and_multi_values_keep_original_lenience() {
    for tag in 10..=u8::MAX {
        rejected_unchanged(&instruction(&[tag]), false);
    }
    for bytes in [instruction(&[2, 3]), instruction(&[4, 1, 8, 0]), instruction(&[2, 10, 3])] {
        rejected_unchanged(&bytes, false);
    }
    let bytes = instruction(&[2, 10, 3]);
    let Action::Push(push) = Reader::new(&bytes, 8).read_action().unwrap() else { panic!() };
    assert_eq!(push.values, vec![Value::Null, Value::Undefined]);
}

#[test]
fn single_push_debug_and_other_opcodes_leave_reader_untouched() {
    for bytes in fixed_forms() {
        rejected_unchanged(&bytes, true);
    }
    for opcode in 0..=u8::MAX {
        if opcode != 0x96 {
            rejected_unchanged(&[opcode, 2, 0, 8, 1, 0], false);
        }
    }
}

#[test]
fn single_push_fallback_preserves_parser_error_and_resynchronization() {
    // Incorrect lengths can still produce a successful value after reading
    // beyond their declared end. Truncation can instead return a parse error.
    let fixtures = [
        vec![0x96], vec![0x96, 5], vec![0x96, 5, 0, 7, 1],
        vec![0x96, 1, 0, 7, 1, 2, 3, 4, 0x17],
        vec![0x96, 2, 0, 0, b'a', 0, 0x17],
        vec![0x96, 4, 0, 2, 7, 1, 2, 3, 4, 0x17],
        vec![0x96, 4, 0, 2, 7],
        vec![0x96, 0xff, 0xff, 2],
    ];
    for bytes in fixtures {
        let mut candidate = Reader::new(&bytes, 8);
        let mut original = Reader::new(&bytes, 8);
        assert!(read_single_push(&mut candidate, false).is_none());
        assert_eq!(candidate.get_ref().as_ptr(), bytes.as_ptr());
        let actual = candidate.read_action();
        let expected = original.read_action();
        match (actual, expected) {
            (Ok(actual), Ok(expected)) => assert_eq!(actual, expected),
            (Err(actual), Err(expected)) => assert_eq!(actual.to_string(), expected.to_string()),
            (actual, expected) => panic!("fallback result differs: {actual:?} / {expected:?}"),
        }
        assert_eq!(candidate.get_ref().as_ptr(), original.get_ref().as_ptr());
        assert_eq!(candidate.get_ref().len(), original.get_ref().len());
    }
}
