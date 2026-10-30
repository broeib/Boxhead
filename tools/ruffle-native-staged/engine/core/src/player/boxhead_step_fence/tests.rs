use super::*;
use crate::avm1::{ExecutionReason, Error};
use crate::avm1::globals::boxhead_step_fence::tests::{begin, clear_trace, complete_to_receipt, fixture, is_error, native_function, phase, poison_reason, record, trace};
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
fn slow_timer<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("slow_timer_start");
    // Exercise a real delayed original handler, not a substituted fence clock.
    // Neither its legitimate work nor scheduler delay is a protocol failure.
    std::thread::sleep(std::time::Duration::from_millis(12));
    record("slow_timer_end");
    Ok(Value::Undefined)
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
fn menu_select<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("menu_select"); Ok(Value::Undefined)
}

fn observe(player: &mut Player) {
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[ambient fixture]"), root);
        let listener = Object::new_without_proto(activation.gc());
        for (name, function) in [("onMouseMove", native_function(&activation, mouse)),
            ("onKeyDown", native_function(&activation, key_down)), ("onKeyUp", native_function(&activation, key_up))] {
            listener.define_value(activation.gc(), AvmString::new_utf8(activation.gc(), name), function.into(), Attribute::empty());
        }
        for name in ["Mouse", "Key"] {
            let name = AvmString::new_utf8(activation.gc(), name);
            let global = activation.global_object();
            let broadcaster = global.get(name, &mut activation).unwrap().as_object(&mut activation).unwrap();
            let method = AvmString::new_utf8(activation.gc(), "addListener");
            broadcaster.call_method(method, &[listener.into()], &mut activation, ExecutionReason::FunctionCall).unwrap();
        }
        let on_enter_frame = AvmString::new_utf8(activation.gc(), "onEnterFrame");
        root.object1().unwrap().define_value(activation.gc(), on_enter_frame, native_function(&activation, timeline).into(), Attribute::empty());
        let callback = TimerCallback::Avm1Function { func: native_function(&activation, timer), params: vec![] };
        activation.context.timers.add_timer(callback, 10, true);
        activation.context.stage.set_invalidated(true);
    });
}

fn ambient_batch(player: &mut Player, index: usize) {
    match index {
        0 => {
            player.render();
            player.handle_event(PlayerEvent::MouseMove { x: 12.0, y: 18.0 });
            player.handle_event(PlayerEvent::KeyDown { key: key() });
            player.tick(FloatDuration::from_millis(16.0));
        }
        1 => {
            player.set_mouse_in_stage(false);
            player.handle_event(PlayerEvent::MouseLeave);
            player.update_timers(FloatDuration::from_millis(16.0));
            player.set_viewport_dimensions(ViewportDimensions { width: 800, height: 600, scale_factor: 1.0 });
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
fn step_fence_player_ambient_fifo_matches_unfenced_entry_order_and_timer_time() {
    let observed = {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
        assert!(!is_error(&begin(&mut player)));
        ambient_batch(&mut player, 0);
        assert!(!is_error(&phase(&mut player, "bhStepPrepare")));
        ambient_batch(&mut player, 1);
        assert!(!is_error(&phase(&mut player, "bhStepProject")));
        ambient_batch(&mut player, 2);
        for name in ["bhStepCommit", "bhInfo", "bhStateReceipt"] { assert!(!is_error(&phase(&mut player, name))); }
        assert!(trace().iter().all(|value| !matches!(value.as_str(), "ambient_action" | "timer" | "mouse" | "key_down" | "key_up" | "timeline")));
        assert!(!player.boxhead_deferred.entries.is_empty());
        clear_trace();
        let queued = player.boxhead_deferred.entries.len();
        let drain_start = Instant::now();
        player.tick(FloatDuration::ZERO);
        let drain_elapsed = drain_start.elapsed();
        assert!(player.boxhead_deferred.entries.is_empty());
        assert!(!player.boxhead_poisoned(),
            "ambient FIFO poisoned: reason={:?}, queued={queued}, elapsed={drain_elapsed:?}, trace={:?}",
            player.enter_arena(|_, root, _| poison_reason(&root.external_interface.step_fence)), trace());
        assert_eq!(player.viewport_dimensions().width, 800);
        trace()
    };
    let reference = {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
        assert!(!is_error(&begin(&mut player)));
        assert!(!is_error(&complete_to_receipt(&mut player)));
        clear_trace();
        for index in 0..3 { ambient_batch(&mut player, index); }
        player.tick(FloatDuration::ZERO);
        trace()
    };
    assert_eq!(observed, reference);
    for required in ["timer", "key_down", "key_up", "ambient_action"] { assert!(observed.iter().any(|value| value == required), "missing {required}: {observed:?}"); }
}

#[test]
fn step_fence_player_slow_original_handler_keeps_fifo_tail_before_next_body() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); observe(&mut player);
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[slow timer fixture]"), root);
        let callback = TimerCallback::Avm1Function { func: native_function(&activation, slow_timer), params: vec![] };
        activation.context.timers.add_timer(callback, 10, true);
    });
    assert!(!is_error(&begin(&mut player)));
    player.update_timers(FloatDuration::from_millis(16.0));
    player.handle_event(PlayerEvent::KeyDown { key: key() });
    assert_eq!(player.boxhead_deferred.entries.len(), 2);
    assert!(!is_error(&complete_to_receipt(&mut player)));
    assert!(!trace().iter().any(|value| value.starts_with("slow_timer") || value == "key_down"));
    clear_trace();
    let start = Instant::now();
    assert!(!is_error(&player.call_internal_interface("bhInfo", vec![])));
    assert!(start.elapsed().as_millis() >= 12);
    assert!(!player.boxhead_poisoned());
    assert!(player.boxhead_deferred.entries.is_empty());
    let observed = trace();
    let index = |name: &str| observed.iter().position(|value| value == name).unwrap();
    assert!(index("slow_timer_start") < index("slow_timer_end"));
    assert!(index("slow_timer_end") < index("key_down"));
    assert!(index("key_down") < index("info"));
    for name in ["slow_timer_start", "slow_timer_end", "key_down", "info"] {
        assert_eq!(observed.iter().filter(|value| value.as_str() == name).count(), 1);
    }
    assert!(!observed.iter().any(|value| value == "cleanup"));
}

#[test]
fn step_fence_player_render_keeps_pure_paint_and_defers_broadcast_actions() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    player.mutate_with_update_context(|context| context.stage.set_invalidated(true));
    begin(&mut player);
    let frame = player.current_frame();
    player.render();
    player.render();
    assert_eq!(player.current_frame(), frame);
    assert!(!player.needs_render());
    assert_eq!(player.boxhead_deferred.entries.iter().filter(|entry| matches!(entry, Entry::RenderBroadcast)).count(), 1);
    assert!(!trace().iter().any(|value| value == "ambient_action"));
    assert!(!is_error(&complete_to_receipt(&mut player)));
    player.render();
    assert_eq!(trace().iter().filter(|value| value.as_str() == "ambient_action").count(), 1);
}

#[test]
fn step_fence_player_readonly_api_does_not_poison_or_dispatch_vm_work() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    let before = trace();
    let _ = (player.is_fullscreen(), player.background_color(), player.letterbox(), player.movie_width(), player.movie_height());
    let _ = (player.viewport_dimensions(), player.quality(), player.scale_mode(), player.forced_scale_mode(), player.should_prevent_scrolling());
    let _ = (player.volume(), player.is_playing(), player.mouse_in_stage(), player.mouse_cursor());
    assert_eq!(trace(), before);
    assert!(player.boxhead_frozen());
    assert!(!player.boxhead_poisoned());
    assert!(!is_error(&complete_to_receipt(&mut player)));
}

#[test]
fn step_fence_player_explicit_run_state_and_resize_wait_in_original_order() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    let dimensions = player.viewport_dimensions();
    player.set_is_playing(false);
    player.set_viewport_dimensions(ViewportDimensions { width: 900, height: 700, scale_factor: 1.0 });
    player.set_is_playing(true);
    assert!(player.is_playing());
    assert_eq!(player.viewport_dimensions().width, dimensions.width);
    assert_eq!(player.boxhead_deferred.entries.len(), 3);
    assert!(!is_error(&complete_to_receipt(&mut player)));
    player.tick(FloatDuration::ZERO);
    assert!(player.is_playing());
    assert_eq!(player.viewport_dimensions().width, 900);
    assert!(player.boxhead_deferred.entries.is_empty());
}

#[test]
fn step_fence_player_opaque_async_mutation_fails_before_executing_closure() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    let called = Cell::new(false);
    let result = catch_unwind(AssertUnwindSafe(|| player.mutate_with_update_context(|_| { called.set(true); 17 })));
    assert!(result.is_err());
    assert!(!called.get());
    assert!(player.boxhead_poisoned());
    assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
    assert!(is_error(&phase(&mut player, "bhStepPrepare")));
}

#[test]
fn step_fence_player_event_capacity_overflow_poison_cleans_and_never_drains() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    for _ in 0..=MAX_DEFERRED_ENTRIES { player.handle_event(PlayerEvent::FocusGained); }
    assert!(player.boxhead_poisoned());
    assert!(player.boxhead_deferred.entries.is_empty());
    assert_eq!(trace().iter().filter(|value| value.as_str() == "cleanup").count(), 1);
    player.tick(FloatDuration::from_millis(16.0));
    assert!(!trace().iter().any(|value| value == "ambient_action"));
    assert!(is_error(&phase(&mut player, "bhStepPrepare")));
}

#[test]
fn step_fence_fifo_limits_account_for_ime_bytes_time_and_each_exact_entry() {
    let mut deferred = Deferred::default();
    deferred.push(Entry::Input(PlayerEvent::Ime(ImeEvent::Commit("a".repeat(MAX_DEFERRED_STRING_BYTES))))).unwrap();
    assert!(deferred.push(Entry::Input(PlayerEvent::Ime(ImeEvent::Commit("b".into())))).is_err());
    assert!(matches!(deferred.pop(), Some(Entry::Input(PlayerEvent::Ime(ImeEvent::Commit(_))))));
    assert_eq!(deferred.string_bytes, 0);
    deferred.push(Entry::Tick(FloatDuration::from_millis(1_500.0))).unwrap();
    deferred.push(Entry::Timers(FloatDuration::from_millis(500.0))).unwrap();
    assert!(deferred.push(Entry::Tick(FloatDuration::from_millis(0.01))).is_err());
    assert!(matches!(deferred.pop(), Some(Entry::Tick(value)) if value.as_millis() == 1500.0));
    assert!(matches!(deferred.pop(), Some(Entry::Timers(value)) if value.as_millis() == 500.0));
    assert_eq!(deferred.millis, 0.0);
    assert!(deferred.push(Entry::Tick(FloatDuration::from_millis(f64::NAN))).is_err());
    assert!(deferred.push(Entry::Timers(FloatDuration::from_millis(-1.0))).is_err());
    assert!(deferred.entries.is_empty());
}

#[test]
fn step_fence_player_next_ei_drains_earlier_ambient_work_before_new_body() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    player.run_frame();
    assert!(!is_error(&complete_to_receipt(&mut player)));
    assert!(!trace().iter().any(|value| value == "ambient_action"));
    clear_trace();
    player.call_internal_interface("bhInfo", vec![]);
    assert_eq!(trace(), vec!["ambient_action", "info"]);
    assert!(player.boxhead_deferred.entries.is_empty());
}

#[test]
fn step_fence_player_uninstalled_local_game_keeps_ordinary_input_and_frame_order() {
    let handle = PlayerBuilder::new().with_movie(SwfMovie::empty(8, None)).with_autoplay(true).with_frame_rate(Some(25.0)).build();
    let mut player = handle.lock().unwrap(); clear_trace(); observe(&mut player);
    for index in 0..3 { ambient_batch(&mut player, index); }
    assert!(!player.boxhead_frozen());
    assert!(!player.boxhead_poisoned());
    assert!(player.boxhead_deferred.entries.is_empty());
    assert!(trace().iter().any(|value| value == "timer"));
    assert!(trace().iter().any(|value| value == "key_down"));
    assert!(trace().iter().any(|value| value == "key_up"));
}

#[test]
fn step_fence_context_menu_suppresses_transient_popup_and_runs_original_select_once() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    player.set_show_menu(true);
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[context menu fixture]"), root);
        let menu = Object::new_without_proto(activation.gc());
        menu.define_value(activation.gc(), AvmString::new_utf8(activation.gc(), "onSelect"), native_function(&activation, menu_select).into(), Attribute::empty());
        root.object1().unwrap().define_value(activation.gc(), AvmString::new_utf8(activation.gc(), "menu"), menu.into(), Attribute::empty());
    });
    // The pinned original helper resolves onSelect against the prior menu's
    // display object. Establish that ordinary state exactly as the UI does.
    player.prepare_context_menu(); clear_trace();
    assert!(!is_error(&begin(&mut player)));
    assert!(player.prepare_context_menu().is_empty());
    assert!(!trace().iter().any(|value| value == "menu_select"));
    assert!(player.boxhead_deferred.entries.iter().any(|entry| matches!(entry, Entry::PrepareContextMenu)));
    assert!(!is_error(&complete_to_receipt(&mut player)));
    player.tick(FloatDuration::ZERO);
    assert_eq!(trace().iter().filter(|value| value.as_str() == "menu_select").count(), 1);
    assert!(player.boxhead_deferred.entries.is_empty());
    player.prepare_context_menu();
    assert_eq!(trace().iter().filter(|value| value.as_str() == "menu_select").count(), 2);
    assert!(!player.boxhead_poisoned());
}

fn clipboard_setter(_backend: &mut dyn UiBackend, value: String) { record(&format!("clipboard:{value}")); }

#[test]
fn step_fence_clipboard_retains_each_payload_before_its_paste_and_counts_bytes() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    player.set_clipboard_content_buffer("first".into(), clipboard_setter);
    player.handle_event(PlayerEvent::TextControl { code: crate::events::TextControlCode::Paste });
    player.set_clipboard_content_buffer("second".into(), clipboard_setter);
    player.handle_event(PlayerEvent::TextControl { code: crate::events::TextControlCode::Paste });
    assert_eq!(player.boxhead_deferred.string_bytes, 11);
    let entries: Vec<_> = player.boxhead_deferred.entries.iter().collect();
    assert!(matches!(entries[0], Entry::Clipboard(value, _) if value == "first"));
    assert!(matches!(entries[1], Entry::Input(PlayerEvent::TextControl { code: crate::events::TextControlCode::Paste })));
    assert!(matches!(entries[2], Entry::Clipboard(value, _) if value == "second"));
    assert!(matches!(entries[3], Entry::Input(PlayerEvent::TextControl { code: crate::events::TextControlCode::Paste })));
    assert!(!trace().iter().any(|value| value.starts_with("clipboard:")));
    assert!(!is_error(&complete_to_receipt(&mut player)));
    player.tick(FloatDuration::ZERO);
    let payloads: Vec<_> = trace().into_iter().filter(|value| value.starts_with("clipboard:")).collect();
    assert_eq!(payloads, vec!["clipboard:first", "clipboard:second"]);
    assert_eq!(player.boxhead_deferred.string_bytes, 0);
    assert!(player.boxhead_deferred.entries.is_empty());
    let mut deferred = Deferred::default();
    assert!(deferred.push(Entry::Clipboard("a".repeat(MAX_DEFERRED_STRING_BYTES + 1), clipboard_setter)).is_err());
    assert!(deferred.entries.is_empty());
}
