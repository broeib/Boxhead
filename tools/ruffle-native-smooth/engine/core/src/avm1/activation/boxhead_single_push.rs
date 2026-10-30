//! A narrow allocation-free decoder for one fixed-width ActionPush value.
//!
//! Failure is strictly a read-only probe: the complete original Reader handles
//! strings, multiple values, invalid tags, mismatched lengths and truncation.
//! In particular, the original parser may read past an incorrectly declared
//! action length and then resynchronize. This helper never tries to repair or
//! reject that input. Debug mode also keeps the original Action debug output.

use swf::avm1::read::Reader;
use swf::avm1::types::Value;

#[cfg(test)]
#[path = "boxhead_single_push_decode_tests.rs"]
mod tests;

#[inline]
pub(super) fn read_single_push<'a>(reader: &mut Reader<'a>, debug_output: bool) -> Option<Value<'a>> {
    if debug_output {
        return None;
    }
    let input = reader.get_ref();
    let [0x96, length_low, length_high, tag, ..] = input else {
        return None;
    };
    let tag = *tag;
    let length = u16::from_le_bytes([*length_low, *length_high]) as usize;
    let expected = match tag {
        2 | 3 => 1,
        4 | 5 | 8 => 2,
        9 => 3,
        1 | 7 => 5,
        6 => 9,
        _ => return None,
    };
    if length != expected {
        return None;
    }
    let end = 3 + expected;
    let payload = input.get(4..end)?;
    let value = match tag {
        1 => Value::Float(f32::from_le_bytes([
            payload[0], payload[1], payload[2], payload[3],
        ])),
        2 => Value::Null,
        3 => Value::Undefined,
        4 => Value::Register(payload[0]),
        5 => Value::Bool(payload[0] != 0),
        6 => Value::Double(f64::from_bits(
            u64::from_le_bytes([
                payload[0], payload[1], payload[2], payload[3],
                payload[4], payload[5], payload[6], payload[7],
            ])
            .rotate_left(32),
        )),
        7 => Value::Int(i32::from_le_bytes([
            payload[0], payload[1], payload[2], payload[3],
        ])),
        8 => Value::ConstantPool(u16::from(payload[0])),
        9 => Value::ConstantPool(u16::from_le_bytes([payload[0], payload[1]])),
        _ => unreachable!("fixed-width Push tag was validated above"),
    };
    // Commit only after the entire exact-width value has been decoded. The
    // input remains the Reader's movie tail, not a newly bounded function slice.
    *reader.get_mut() = &input[end..];
    Some(value)
}
