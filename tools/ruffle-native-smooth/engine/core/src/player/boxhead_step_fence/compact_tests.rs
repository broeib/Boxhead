//! The existing Player FIFO is shared without a new timer or simulation clock.
//! Exercise its actual entry paths while the optional compact protocol owns it.

use super::*;
use crate::avm1::{ExecutionReason, Error};
use crate::avm1::globals::boxhead_step_fence::compact_tests::{
    begin, clear_trace, finish, fixture, is_error, native_function, phase, record, trace,
};
use crate::events::{KeyDescriptor, KeyLocation, LogicalKey, PhysicalKey};
use crate::timer::TimerCallback;
use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};

fn key() -> KeyDescriptor {
    KeyDescriptor { physical_key: PhysicalKey::KeyA, logical_key: LogicalKey::Character('a'), key_location: KeyLocation::Standard }
}
fn timer<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("timer"); Ok(Value::Undefined)
}
fn mouse<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("mouse"); Ok(Value::Undefined)
}
fn key_down<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("key_down"); Ok(Value::Undefined)
}
fn key_up<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("key_up"); Ok(Value::Undefined)
}
fn timeline<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("timeline"); Ok(Value::Undefined)
}
fn clipboard(_ui: &mut dyn UiBackend, text: String) {
    record(&format!("clipboard:{text}"));
}

fn observe(player: &mut Player) {
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact ambient fixture]"), root);
        let listener = Object::new_without_proto(activation.gc());
        for (name, callback) in [("onMouseMove", native_function(&activation, mouse)),
            ("onKeyDown", native_function(&activation, key_down)), ("onKeyUp", native_function(&activation, key_up))] {
            listener.define_value(activation.gc(), AvmString::new_utf8(activation.gc(), name), callback.into(), Attribute::empty());
        }
        for name in ["Mouse", "Key"] {
            let global = activation.global_object();
            let name = AvmString::new_utf8(activation.gc(), name);
            let broadcaster = global.get(name, &mut activation).unwrap().as_object(&mut activation).unwrap();
            let method = AvmString::new_utf8(activation.gc(), "addListener");
            broadcaster.call_method(method, &[listener.into()], &mut activation, ExecutionReason::FunctionCall).unwrap();
        }
        root.object1().unwrap().define_value(activation.gc(), AvmString::new_utf8(activation.gc(), "onEnterFrame"),
            native_function(&activation, timeline).into(), Attribute::empty());
        let callback = TimerCallback::Avm1Function { func: native_function(&activation, timer), params: vec![] };
        activation.context.timers.add_timer(callback, 10, true);
        activation.context.stage.set_invalidated(true);
    });
}

fn batch(player: &mut Player, index: usize) {
    match index {
        0 => {
            player.render();
            player.handle_event(PlayerEvent::MouseMove { x: 12.0, y: 18.0 });
            player.handle_event(PlayerEvent::KeyDown { key: key() });
            player.tick(FloatDuration::from_millis(16.0));
        }
        1 => {
            player.update_timers(FloatDuration::from_millis(16.0));
            player.set_viewport_dimensions(ViewportDimensions { width: 800, height: 600, scale_factor: 1.0 });
            player.set_clipboard_content_buffer("compact".into(), clipboard);
            player.handle_event(PlayerEvent::TextControl { code: crate::events::TextControlCode::Paste });
        }
        2 => {
            player.handle_event(PlayerEvent::KeyUp { key: key() });
            player.handle_event(PlayerEvent::GamepadButtonDown { button: GamepadButton::South });
            player.handle_event(PlayerEvent::GamepadButtonUp { button: GamepadButton::South });
            player.run_frame();
        }
        _ => unreachable!(),
    }
}

#[test]
fn compact_fence_player_fifo_matches_unfenced_input_timer_clipboard_and_frame_order() {
    let observed = {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
        assert!(!is_error(&begin(&mut player, 1))); batch(&mut player, 0);
        assert!(!is_error(&phase(&mut player, "bhFrameCommit", 1, 1))); batch(&mut player, 1);
        assert!(!is_error(&phase(&mut player, "bhInfo", 1, 1))); batch(&mut player, 2);
        assert!(!is_error(&phase(&mut player, "bhStateReceipt", 1, 1)));
        assert!(trace().iter().all(|value| !matches!(value.as_str(), "ambient_action" | "timer" | "mouse" | "key_down" | "key_up" | "timeline" | "clipboard:compact")));
        assert!(!player.boxhead_deferred.entries.is_empty()); clear_trace();
        player.tick(FloatDuration::ZERO);
        assert!(player.boxhead_deferred.entries.is_empty()); assert!(!player.boxhead_poisoned());
        assert_eq!(player.viewport_dimensions().width, 800);
        trace()
    };
    let reference = {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
        assert!(!is_error(&begin(&mut player, 1))); assert!(!is_error(&finish(&mut player, 1, 1)));
        clear_trace(); for index in 0..3 { batch(&mut player, index); }
        player.tick(FloatDuration::ZERO); trace()
    };
    assert_eq!(observed, reference);
    for required in ["timer", "key_down", "key_up", "clipboard:compact", "ambient_action"] {
        assert!(observed.iter().any(|value| value == required), "missing {required}: {observed:?}");
    }
}

#[test]
fn compact_fence_player_paints_without_timeline_or_render_broadcast_during_the_split() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
    assert!(!is_error(&begin(&mut player, 1))); let frame = player.current_frame();
    player.render(); player.render();
    assert_eq!(player.current_frame(), frame); assert!(!player.needs_render());
    assert_eq!(player.boxhead_deferred.entries.iter().filter(|entry| matches!(entry, Entry::RenderBroadcast)).count(), 1);
    let _ = (player.is_playing(), player.volume(), player.viewport_dimensions(), player.quality());
    assert!(!trace().iter().any(|value| value == "ambient_action" || value == "timeline"));
    assert!(!is_error(&player.call_internal_interface("bhPresent", vec![0.5.into()])));
    assert!(!is_error(&finish(&mut player, 1, 1)));
    assert!(!trace().iter().any(|value| value == "ambient_action"));
    player.render(); assert_eq!(trace().iter().filter(|value| value.as_str() == "ambient_action").count(), 1);
}

#[test]
fn compact_fence_player_receipt_never_drains_and_next_external_entry_cannot_overtake_fifo() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
    assert!(!is_error(&begin(&mut player, 1)));
    player.update_timers(FloatDuration::from_millis(16.0));
    player.handle_event(PlayerEvent::KeyDown { key: key() });
    player.set_clipboard_content_buffer("first".into(), clipboard);
    player.set_clipboard_content_buffer("second".into(), clipboard);
    assert!(!is_error(&finish(&mut player, 1, 1)));
    assert!(!trace().iter().any(|value| value == "timer" || value == "key_down" || value.starts_with("clipboard:")));
    clear_trace(); assert!(!is_error(&player.call_internal_interface("bhInfo", vec![])));
    let observed = trace(); let position = |name: &str| observed.iter().position(|value| value == name).unwrap();
    assert!(position("timer") < position("key_down"));
    assert!(position("key_down") < position("clipboard:first"));
    assert!(position("clipboard:first") < position("clipboard:second"));
    assert!(position("clipboard:second") < position("info"));
    assert!(player.boxhead_deferred.entries.is_empty()); assert!(!player.boxhead_poisoned());
}

#[test]
fn compact_fence_player_queue_overload_cleans_once_and_never_resumes_partial_game() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
    for _ in 0..=MAX_DEFERRED_ENTRIES { player.handle_event(PlayerEvent::FocusGained); }
    assert!(player.boxhead_poisoned()); assert!(player.boxhead_deferred.entries.is_empty());
    player.tick(FloatDuration::from_millis(16.0));
    assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
    assert!(!trace().iter().any(|value| value == "ambient_action" || value == "compact_commit"));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
}

#[test]
fn compact_fence_player_opaque_loader_mutation_fails_before_its_closure() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
    let called = Cell::new(false);
    let result = catch_unwind(AssertUnwindSafe(|| player.mutate_with_update_context(|_| { called.set(true); 17 })));
    assert!(result.is_err()); assert!(!called.get()); assert!(player.boxhead_poisoned());
    assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
    assert!(!trace().iter().any(|value| value == "ambient_action"));
}
