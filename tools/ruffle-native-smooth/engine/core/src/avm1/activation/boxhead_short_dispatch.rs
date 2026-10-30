//! Stateless AVM1 short-action dispatch.
//!
//! Only known one-byte actions enter this path. The caller has already applied
//! the unchanged timeout and function-end guards. Cursor advancement happens
//! before the existing handler, just as it does in Reader::read_action.
//! Long actions (including Call 0x9e), unknown bytes and debug output retain
//! the existing decoder. This module owns no cache, values or GC references.

use super::{Activation, FrameControl};
use crate::avm1::error::Error;
use swf::avm1::read::Reader;

// One mapping emits both the direct calls and test-only route labels. Tests
// derive their expected labels independently from the pinned old dispatch and
// the existing Reader; there is no second candidate route table.
macro_rules! short_actions {
    ($($opcode:literal => $handler:ident),+ $(,)?) => {
        #[inline]
        pub(super) fn try_short_action<'gc>(
            activation: &mut Activation<'_, 'gc>,
            reader: &mut Reader<'_>,
            debug_output: bool,
        ) -> Option<Result<FrameControl<'gc>, Error<'gc>>> {
            if debug_output {
                return None;
            }
            let input = reader.get_ref();
            let opcode = *input.first()?;
            match opcode {
                $($opcode => {
                    *reader.get_mut() = &input[1..];
                    Some(activation.$handler())
                },)+
                _ => None,
            }
        }

        #[cfg(test)]
        pub(super) fn handler_name(opcode: u8) -> Option<&'static str> {
            match opcode {
                $($opcode => Some(stringify!($handler)),)+
                _ => None,
            }
        }
    };
}

short_actions! {
    0x00 => action_end, // End
    0x04 => action_next_frame, // NextFrame
    0x05 => action_prev_frame, // PreviousFrame
    0x06 => action_play, // Play
    0x07 => action_stop, // Stop
    0x08 => action_toggle_quality, // ToggleQuality
    0x09 => action_stop_sounds, // StopSounds
    0x0a => action_add, // Add
    0x0b => action_subtract, // Subtract
    0x0c => action_multiply, // Multiply
    0x0d => action_divide, // Divide
    0x0e => action_equals, // Equals
    0x0f => action_less, // Less
    0x10 => action_and, // And
    0x11 => action_or, // Or
    0x12 => action_not, // Not
    0x13 => action_string_equals, // StringEquals
    0x14 => action_string_length, // StringLength
    0x15 => action_string_extract, // StringExtract
    0x17 => action_pop, // Pop
    0x18 => action_to_integer, // ToInteger
    0x1c => action_get_variable, // GetVariable
    0x1d => action_set_variable, // SetVariable
    0x20 => action_set_target_2, // SetTarget2
    0x21 => action_string_add, // StringAdd
    0x22 => action_get_property, // GetProperty
    0x23 => action_set_property, // SetProperty
    0x24 => action_clone_sprite, // CloneSprite
    0x25 => action_remove_sprite, // RemoveSprite
    0x26 => action_trace, // Trace
    0x27 => action_start_drag, // StartDrag
    0x28 => action_end_drag, // EndDrag
    0x29 => action_string_less, // StringLess
    0x2a => action_throw, // Throw
    0x2b => action_cast_op, // CastOp
    0x2c => action_implements_op, // ImplementsOp
    0x30 => action_random_number, // RandomNumber
    0x31 => action_mb_string_length, // MBStringLength
    0x32 => action_char_to_ascii, // CharToAscii
    0x33 => action_ascii_to_char, // AsciiToChar
    0x34 => action_get_time, // GetTime
    0x35 => action_mb_string_extract, // MBStringExtract
    0x36 => action_mb_char_to_ascii, // MBCharToAscii
    0x37 => action_mb_ascii_to_char, // MBAsciiToChar
    0x3a => action_delete, // Delete
    0x3b => action_delete_2, // Delete2
    0x3c => action_define_local, // DefineLocal
    0x3d => action_call_function, // CallFunction
    0x3e => action_return, // Return
    0x3f => action_modulo, // Modulo
    0x40 => action_new_object, // NewObject
    0x41 => action_define_local_2, // DefineLocal2
    0x42 => action_init_array, // InitArray
    0x43 => action_init_object, // InitObject
    0x44 => action_type_of, // TypeOf
    0x45 => action_target_path, // TargetPath
    0x46 => action_enumerate, // Enumerate
    0x47 => action_add_2, // Add2
    0x48 => action_less_2, // Less2
    0x49 => action_equals_2, // Equals2
    0x4a => action_to_number, // ToNumber
    0x4b => action_to_string, // ToString
    0x4c => action_push_duplicate, // PushDuplicate
    0x4d => action_stack_swap, // StackSwap
    0x4e => action_get_member, // GetMember
    0x4f => action_set_member, // SetMember
    0x50 => action_increment, // Increment
    0x51 => action_decrement, // Decrement
    0x52 => action_call_method, // CallMethod
    0x53 => action_new_method, // NewMethod
    0x54 => action_instance_of, // InstanceOf
    0x55 => action_enumerate_2, // Enumerate2
    0x60 => action_bit_and, // BitAnd
    0x61 => action_bit_or, // BitOr
    0x62 => action_bit_xor, // BitXor
    0x63 => action_bit_lshift, // BitLShift
    0x64 => action_bit_rshift, // BitRShift
    0x65 => action_bit_urshift, // BitURShift
    0x66 => action_strict_equals, // StrictEquals
    0x67 => action_greater, // Greater
    0x68 => action_string_greater, // StringGreater
    0x69 => action_extends, // Extends
}
