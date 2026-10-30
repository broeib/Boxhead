//! Exact v21 do_action oracle.
//! Only the method name and visibility differ from the pinned predecessor.
//! The source handoff records and reconstructs the complete original method.

use super::super::*;

macro_rules! avm_debug {
    ($avm: expr, $($arg:tt)*) => (
        if $avm.show_debug_output() {
            tracing::debug!($($arg)*)
        }
    )
}

impl<'a, 'gc> Activation<'a, 'gc> {
    pub(super) fn short_dispatch_frozen_do_action<'b>(
        &mut self,
        data: &'b SwfSlice,
        reader: &mut Reader<'b>,
    ) -> Result<FrameControl<'gc>, Error<'gc>> {
        *self.context.actions_since_timeout_check += 1;
        if *self.context.actions_since_timeout_check >= 2000 {
            *self.context.actions_since_timeout_check = 0;
            if self.context.update_start.elapsed() >= self.context.max_execution_duration {
                return Err(Error::ExecutionTimeout);
            }
        }

        if reader.get_ref().as_ptr() as usize >= data.as_ref().as_ptr_range().end as usize {
            //Executing beyond the end of a function constitutes an implicit return.
            Ok(FrameControl::Return(ReturnType::Implicit))
        } else {
            // A fully validated singleton can avoid the parser's temporary Vec.
            // Every other instruction, including all malformed forms and debug
            // output, keeps the original parser and its cursor/error behavior.
            if let Some(value) = boxhead_single_push::read_single_push(
                reader,
                self.context.avm1.show_debug_output(),
            ) {
                return self.action_push_values(std::iter::once(value));
            }
            let action = reader.read_action()?;
            avm_debug!(
                self.context.avm1,
                "({}) Action: {action:?}",
                self.id.depth(),
            );

            match action {
                Action::Add => self.action_add(),
                Action::Add2 => self.action_add_2(),
                Action::And => self.action_and(),
                Action::AsciiToChar => self.action_ascii_to_char(),
                Action::BitAnd => self.action_bit_and(),
                Action::BitLShift => self.action_bit_lshift(),
                Action::BitOr => self.action_bit_or(),
                Action::BitRShift => self.action_bit_rshift(),
                Action::BitURShift => self.action_bit_urshift(),
                Action::BitXor => self.action_bit_xor(),
                Action::Call => self.action_call(),
                Action::CallFunction => self.action_call_function(),
                Action::CallMethod => self.action_call_method(),
                Action::CastOp => self.action_cast_op(),
                Action::CharToAscii => self.action_char_to_ascii(),
                Action::CloneSprite => self.action_clone_sprite(),
                Action::ConstantPool(action) => self.action_constant_pool(action),
                Action::Decrement => self.action_decrement(),
                Action::DefineFunction(action) => self.action_define_function(action.into(), data),
                Action::DefineFunction2(action) => self.action_define_function(action, data),
                Action::DefineLocal => self.action_define_local(),
                Action::DefineLocal2 => self.action_define_local_2(),
                Action::Delete => self.action_delete(),
                Action::Delete2 => self.action_delete_2(),
                Action::Divide => self.action_divide(),
                Action::End => self.action_end(),
                Action::EndDrag => self.action_end_drag(),
                Action::Enumerate => self.action_enumerate(),
                Action::Enumerate2 => self.action_enumerate_2(),
                Action::Equals => self.action_equals(),
                Action::Equals2 => self.action_equals_2(),
                Action::Extends => self.action_extends(),
                Action::GetMember => self.action_get_member(),
                Action::GetProperty => self.action_get_property(),
                Action::GetTime => self.action_get_time(),
                Action::GetVariable => self.action_get_variable(),
                Action::GetUrl(action) => self.action_get_url(action),
                Action::GetUrl2(action) => self.action_get_url_2(action),
                Action::GotoFrame(action) => self.action_goto_frame(action),
                Action::GotoFrame2(action) => self.action_goto_frame_2(action),
                Action::Greater => self.action_greater(),
                Action::GotoLabel(action) => self.action_goto_label(action),
                Action::If(action) => self.action_if(action, reader, data),
                Action::Increment => self.action_increment(),
                Action::InitArray => self.action_init_array(),
                Action::InitObject => self.action_init_object(),
                Action::ImplementsOp => self.action_implements_op(),
                Action::InstanceOf => self.action_instance_of(),
                Action::Jump(action) => self.action_jump(action, reader, data),
                Action::Less => self.action_less(),
                Action::Less2 => self.action_less_2(),
                Action::MBAsciiToChar => self.action_mb_ascii_to_char(),
                Action::MBCharToAscii => self.action_mb_char_to_ascii(),
                Action::MBStringLength => self.action_mb_string_length(),
                Action::MBStringExtract => self.action_mb_string_extract(),
                Action::Modulo => self.action_modulo(),
                Action::Multiply => self.action_multiply(),
                Action::NextFrame => self.action_next_frame(),
                Action::NewMethod => self.action_new_method(),
                Action::NewObject => self.action_new_object(),
                Action::Not => self.action_not(),
                Action::Or => self.action_or(),
                Action::Play => self.action_play(),
                Action::Pop => self.action_pop(),
                Action::PreviousFrame => self.action_prev_frame(),
                Action::Push(action) => self.action_push(action),
                Action::PushDuplicate => self.action_push_duplicate(),
                Action::RandomNumber => self.action_random_number(),
                Action::RemoveSprite => self.action_remove_sprite(),
                Action::Return => self.action_return(),
                Action::SetMember => self.action_set_member(),
                Action::SetProperty => self.action_set_property(),
                Action::SetTarget(action) => self.action_set_target(action),
                Action::SetTarget2 => self.action_set_target_2(),
                Action::SetVariable => self.action_set_variable(),
                Action::StackSwap => self.action_stack_swap(),
                Action::StartDrag => self.action_start_drag(),
                Action::Stop => self.action_stop(),
                Action::StopSounds => self.action_stop_sounds(),
                Action::StoreRegister(action) => self.action_store_register(action),
                Action::StrictEquals => self.action_strict_equals(),
                Action::StringAdd => self.action_string_add(),
                Action::StringEquals => self.action_string_equals(),
                Action::StringExtract => self.action_string_extract(),
                Action::StringGreater => self.action_string_greater(),
                Action::StringLength => self.action_string_length(),
                Action::StringLess => self.action_string_less(),
                Action::Subtract => self.action_subtract(),
                Action::TargetPath => self.action_target_path(),
                Action::Throw => self.action_throw(),
                Action::ToggleQuality => self.action_toggle_quality(),
                Action::ToInteger => self.action_to_integer(),
                Action::ToNumber => self.action_to_number(),
                Action::ToString => self.action_to_string(),
                Action::Trace => self.action_trace(),
                Action::Try(action) => self.action_try(&action, data),
                Action::TypeOf => self.action_type_of(),
                Action::WaitForFrame(action) => self.action_wait_for_frame(action, reader),
                Action::WaitForFrame2(action) => self.action_wait_for_frame_2(action, reader),
                Action::With(action) => self.action_with(action, data),
                Action::Unknown(action) => self.action_unknown(action),
            }
        }
    }
}
