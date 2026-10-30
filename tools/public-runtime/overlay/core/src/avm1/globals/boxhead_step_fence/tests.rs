//! Real Player / ExternalInterface / AVM1 property-marshalling fixtures.
//! Native fixture functions explicitly set the caller's callee slot to model
//! the real bytecode function boundary (NativeFunction itself creates no AVM
//! activation). Browser qualification separately executes the actual AS2 bodies.

use super::*;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::context::ActionType;
use crate::external::ExternalInterface;
use crate::player::{Player, PlayerBuilder};
use crate::tag_utils::SwfMovie;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};

thread_local! {
    static TRACE: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn trace() -> Vec<String> { TRACE.with(|trace| trace.borrow().clone()) }
pub(crate) fn record(value: &str) { TRACE.with(|trace| trace.borrow_mut().push(value.into())); }
pub(crate) fn clear_trace() { TRACE.with(|trace| trace.borrow_mut().clear()); }

/// Test-only access to the first terminal cause; production keeps it private.
pub(crate) fn poison_reason(fence: &StepFence<'_>) -> Option<&'static str> { fence.reason }

fn define<'gc>(activation: &Activation<'_, 'gc>, object: Object<'gc>, name: &str, value: Value<'gc>) {
    object.define_value(activation.gc(), key(activation, name), value, Attribute::empty());
}

pub(crate) fn native_function<'gc>(activation: &Activation<'_, 'gc>, function: NativeFunction) -> Object<'gc> {
    FunctionObject::native(function).build(&activation.context.strings, None, None)
}

fn host(fields: &[(&str, HostValue)]) -> HostValue {
    HostValue::Object(fields.iter().map(|(name, value)| ((*name).into(), value.clone())).collect())
}

fn fault<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, expected: &str) -> bool {
    matches!(raw(activation, owner, "fault"), Some(Value::String(value)) if value.eq_with_case(expected.as_bytes(), true))
}

fn with_body<'gc>(activation: &mut Activation<'_, 'gc>, kind: Kind,
    body: impl FnOnce(&mut Activation<'_, 'gc>) -> Result<Value<'gc>, Error<'gc>>) -> Result<Value<'gc>, Error<'gc>> {
    let previous = activation.callee;
    activation.callee = Some(activation.context.external_interface.step_fence.installed.as_ref().unwrap().bodies[kind.body_index().unwrap()]);
    let result = body(activation);
    activation.callee = previous;
    result
}

fn op<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, name: &str,
    token: Value<'gc>, epoch: Value<'gc>, tick: Value<'gc>, phase: Option<&str>) -> Result<Value<'gc>, Error<'gc>> {
    let mut args = vec![key(activation, name).into(), owner.into(), token, epoch, tick];
    if let Some(phase) = phase { args.push(key(activation, phase).into()); }
    call(activation, owner, &args)
}

fn envelope<'gc>(activation: &mut Activation<'_, 'gc>, phase: &str) -> Value<'gc> {
    let transaction = activation.context.external_interface.step_fence.transaction.as_ref().unwrap();
    let result = host(&[("version", 1.0.into()), ("phase", phase.to_owned().into()),
        ("token", transaction.token.clone().into()), ("epoch", f64::from(transaction.epoch).into()),
        ("tick", f64::from(transaction.tick).into())]);
    result.into_avm1(activation)
}

fn commit_host(tick: u32) -> HostValue {
    host(&[("tick", f64::from(tick).into()), ("digest", "native-v2-0123456789abcdef".into()),
        ("worldTick", f64::from(tick).into()), ("players", HostValue::List(vec![])),
        ("rng", host(&[("seed", 4_294_967_295.0.into()), ("state", 2_147_483_646.0.into()), ("calls", 42.0.into())])),
        ("complete", HostValue::Undefined), ("profile", host(&[("projectMs", 3.0.into()), ("encodeMs", 0.0.into()), ("hashMs", 1.0.into())])),
        ("snapshotBytes", 4096.0.into()), ("snapshotObjects", 31.0.into()), ("snapshotFields", 70.0.into())])
}

fn callback_begin<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Kind::Begin, |activation| {
        record("begin");
        let epoch = raw(activation, owner, "epoch").unwrap();
        op(activation, owner, "begin", args[4], epoch, args[0], None)?;
        record("game");
        let world = raw(activation, owner, "mcWorld").unwrap().as_object(activation).unwrap();
        define(activation, world, "tick", args[0]);
        let name = key(activation, "ambientAction");
        let clip = activation.base_clip();
        activation.context.action_queue.queue_action(clip, ActionType::Method {
            object: owner, name, args: vec![],
        }, false);
        if fault(activation, owner, "causal_drain") {
            // This is the exact explicit drain used by the original native
            // focus-reset path; returning the phase never invokes it.
            Player::run_actions(activation.context);
        }
        if fault(activation, owner, "begin_throw") { return Err(Error::ThrownValue(key(activation, "fixture").into())); }
        if !fault(activation, owner, "missing_leave") {
            op(activation, owner, "leave", args[4], epoch, args[0], Some("begin"))?;
        }
        if fault(activation, owner, "duplicate_leave") {
            let _ = op(activation, owner, "leave", args[4], epoch, args[0], Some("begin"));
        }
        if fault(activation, owner, "null_begin") { return Ok(Value::Null); }
        let result = envelope(activation, "begun");
        if fault(activation, owner, "extra_envelope_field") {
            let object = result.as_object(activation).unwrap();
            define(activation, object, "extra", true.into());
        }
        Ok(result)
    })
}

fn callback_prepare<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Kind::Prepare, |activation| {
        record("prepare");
        op(activation, owner, "enter", args[0], args[1], args[2], Some("prepare"))?;
        if fault(activation, owner, "nested_present") {
            let result = ExternalInterface::call_callback(activation.context, "bhPresent", vec![0.5.into()]);
            assert!(is_error(&result));
        }
        if fault(activation, owner, "replace_callback") {
            let replacement = native_function(activation, callback_present);
            activation.context.external_interface.add_callback("bhStepProject".into(), Callback::Avm1 { this: owner.into(), method: replacement });
        }
        if fault(activation, owner, "replace_world") {
            let replacement = Object::new_without_proto(activation.gc());
            define(activation, owner, "mcWorld", replacement.into());
        }
        if fault(activation, owner, "forged_caller") {
            let previous = activation.callee;
            activation.callee = Some(native_function(activation, callback_present));
            let result = op(activation, owner, "leave", args[0], args[1], args[2], Some("prepare"));
            activation.callee = previous;
            assert!(result.is_err());
        }
        if fault(activation, owner, "phase_abort") {
            op(activation, owner, "abort", args[0], args[1], args[2], None)?;
            return Ok(Value::Null);
        }
        op(activation, owner, "leave", args[0], args[1], args[2], Some("prepare"))?;
        Ok(envelope(activation, "prepared"))
    })
}

fn callback_project<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Kind::Project, |activation| {
        record("project");
        op(activation, owner, "enter", args[0], args[1], args[2], Some("project"))?;
        if fault(activation, owner, "project_throw") { return Err(Error::ThrownValue(key(activation, "fixture").into())); }
        op(activation, owner, "leave", args[0], args[1], args[2], Some("project"))?;
        Ok(envelope(activation, "projected"))
    })
}

fn callback_commit<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Kind::Commit, |activation| {
        record("commit");
        op(activation, owner, "enter", args[0], args[1], args[2], Some("commit"))?;
        let tick = native_integer(args[2], 1, MAX_INTEGER).unwrap();
        let mut result = commit_host(tick);
        if fault(activation, owner, "bad_rng") {
            let HostValue::Object(result) = &mut result else { unreachable!() };
            result.insert("rng".into(), 7.0.into());
        }
        op(activation, owner, "leave", args[0], args[1], args[2], Some("commit"))?;
        Ok(result.into_avm1(activation))
    })
}

fn callback_info<'gc>(activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("info");
    Player::run_actions(activation.context);
    let tick = activation.context.external_interface.step_fence.transaction.as_ref().map(|value| value.tick).unwrap_or(0);
    Ok(host(&[("version", 1.0.into()), ("engine", "original-swf".into()), ("state", "playing".into()),
        ("tick", f64::from(tick).into()), ("snapshotReceiptVersion", 1.0.into()), ("stagedStepVersion", 1.0.into())]).into_avm1(activation))
}

fn return_getter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    assert!(activation.context.external_interface.step_fence.frozen());
    record("serialize_fenced");
    Player::run_actions(activation.context);
    let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
    if fault(activation, owner, "receipt_reentry") {
        let result = ExternalInterface::call_callback(activation.context, "bhInfo", vec![]);
        assert!(is_error(&result));
        record("caught_reentry");
    }
    Ok(1.0.into())
}

fn callback_receipt<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Kind::Receipt, |activation| {
        record("receipt");
        let transaction = activation.context.external_interface.step_fence.transaction.as_ref().unwrap();
        let mut header = transaction.commit.clone().unwrap();
        header.remove("worldTick");
        header.remove("complete");
        for (name, value) in [("version", 1.0.into()), ("engine", "original-swf".into()),
            ("state", "playing".into()), ("scope", "full".into()), ("digestSchema", "native-projection-v3".into())] {
            header.insert(name.into(), value);
        }
        let result = host(&[("version", 1.0.into()), ("token", transaction.token.clone().into()),
            ("epoch", f64::from(transaction.epoch).into()), ("tick", f64::from(transaction.tick).into()),
            ("scope", "full".into()), ("header", HostValue::Object(header))]);
        op(activation, owner, "finish", args[0], args[1], args[2], None)?;
        record("finish_marked");
        assert!(activation.context.external_interface.step_fence.frozen());
        let result = result.into_avm1(activation).as_object(activation).unwrap();
        let getter = native_function(activation, return_getter);
        result.add_property(activation.gc(), key(activation, "version"), getter, None, Attribute::empty());
        if fault(activation, owner, "receipt_malformed") { define(activation, result, "epoch", 2.0.into()); }
        Ok(result.into())
    })
}

fn callback_present<'gc>(activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("present");
    Player::run_actions(activation.context);
    let tick = activation.context.external_interface.step_fence.transaction.as_ref().map(|value| value.tick).unwrap_or(0);
    Ok(host(&[("version", 1.0.into()), ("tick", f64::from(tick).into()), ("rendered", true.into())]).into_avm1(activation))
}

fn callback_abort<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Kind::Abort, |activation| {
        record("abort");
        op(activation, owner, "abort", args[0], args[1], args[2], None)?;
        Ok(host(&[("error", "fixture abort".into())]).into_avm1(activation))
    })
}

fn callback_cleanup<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("cleanup");
    if fault(activation, owner, "cleanup_throw") { return Err(Error::ThrownValue(key(activation, "cleanup fixture").into())); }
    Ok(true.into())
}

fn ambient_action<'gc>(_activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("ambient_action");
    Ok(Value::Undefined)
}

pub(crate) fn fixture(fault_name: &str) -> Arc<Mutex<Player>> {
    clear_trace();
    let player = PlayerBuilder::new().with_movie(SwfMovie::empty(8, None))
        .with_autoplay(true).with_frame_rate(Some(25.0)).build();
    player.lock().unwrap().mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[fence fixture install]"), root);
        let owner = Object::new_without_proto(activation.gc());
        let world = Object::new_without_proto(activation.gc());
        define(&activation, owner, "mcWorld", world.into());
        define(&activation, owner, "epoch", 1.0.into());
        define(&activation, owner, "fault", key(&activation, fault_name).into());
        define(&activation, owner, CLEANUP_NAME, native_function(&activation, callback_cleanup).into());
        define(&activation, owner, "ambientAction", native_function(&activation, ambient_action).into());
        let callbacks: [NativeFunction; 8] = [callback_begin, callback_prepare, callback_project, callback_commit,
            callback_info, callback_receipt, callback_present, callback_abort];
        for (index, callback) in callbacks.into_iter().enumerate() {
            let method = native_function(&activation, callback);
            if let Some(body) = Kind::from_name(CALLBACK_NAMES[index]).unwrap().body_index() {
                define(&activation, owner, BODY_NAMES[body], method.into());
            }
            activation.context.external_interface.add_callback(CALLBACK_NAMES[index].into(), Callback::Avm1 { this: owner.into(), method });
        }
        let args = [key(&activation, "install").into(), owner.into()];
        assert_eq!(call(&mut activation, owner, &args).unwrap(), Value::Bool(true));
    });
    player
}

pub(crate) fn tuple() -> Vec<HostValue> { vec!["fence_token".into(), 1.0.into(), 25.0.into()] }
pub(crate) fn begin(player: &mut Player) -> HostValue {
    player.call_internal_interface("bhStepBegin", vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "fence_token".into()])
}
pub(crate) fn phase(player: &mut Player, name: &str) -> HostValue {
    player.call_internal_interface(name, if name == "bhInfo" { vec![] } else { tuple() })
}
pub(crate) fn is_error(value: &HostValue) -> bool { map(value).is_some_and(|value| value.contains_key("error")) }
pub(crate) fn complete_to_receipt(player: &mut Player) -> HostValue {
    for name in ["bhStepPrepare", "bhStepProject", "bhStepCommit", "bhInfo"] {
        let result = phase(player, name);
        assert!(!is_error(&result), "{name}: {result:?}");
    }
    phase(player, "bhStateReceipt")
}

#[test]
fn step_fence_capability_has_only_the_two_declared_fields() {
    let player = fixture("");
    player.lock().unwrap().mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[capability fixture]"), root);
        let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
        let args = [key(&activation, "capability").into()];
        let value = call(&mut activation, owner, &args).unwrap();
        assert_eq!(HostValue::from_avm1(&mut activation, value).unwrap(), host(&[("version", 1.0.into()), ("contract", "bh-step-fence-v1".into())]));
    });
}

#[test]
fn step_fence_full_chain_keeps_game_once_and_releases_only_after_serialized_receipt() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    assert!(!is_error(&begin(&mut player)));
    for name in ["bhStepPrepare", "bhStepProject", "bhStepCommit"] {
        assert!(!is_error(&player.call_internal_interface("bhPresent", vec![0.5.into()])));
        assert!(!is_error(&phase(&mut player, name)));
    }
    assert!(!is_error(&phase(&mut player, "bhInfo")));
    let receipt = phase(&mut player, "bhStateReceipt");
    assert!(!is_error(&receipt));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 1);
    assert!(!trace().iter().any(|value| value == "ambient_action"));
    assert!(trace().ends_with(&["receipt".into(), "finish_marked".into(), "serialize_fenced".into()]));
    player.update(|_| ());
    assert_eq!(trace().last().map(String::as_str), Some("ambient_action"));
}

#[test]
fn step_fence_explicit_causal_action_drain_remains_inside_entered_original_phase() {
    let handle = fixture("causal_drain"); let mut player = handle.lock().unwrap();
    assert!(!is_error(&begin(&mut player)));
    assert_eq!(trace(), vec!["begin", "game", "ambient_action"]);
    assert!(!is_error(&complete_to_receipt(&mut player)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "ambient_action").count(), 1);
}

#[test]
fn step_fence_stage_calls_cannot_skip_prepare() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&phase(&mut player, "bhStepProject")));
    assert!(!trace().iter().any(|value| value == "project"));
    assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
}

#[test]
fn step_fence_stale_token_epoch_and_tick_are_rejected_before_body() {
    for args in [vec!["wrong".into(), 1.0.into(), 25.0.into()], vec!["fence_token".into(), 2.0.into(), 25.0.into()],
        vec!["fence_token".into(), 1.0.into(), 26.0.into()]] {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
        assert!(is_error(&player.call_internal_interface("bhStepPrepare", args)));
        assert!(!trace().iter().any(|value| value == "prepare"));
    }
}

#[test]
fn step_fence_invalid_begin_arguments_never_execute_original_game() {
    for args in [vec![25.0.into(), 131_072.0.into(), 0.0.into(), HostValue::Undefined, "fence_token".into()],
        vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Null, "fence_token".into()],
        vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "invalid-token".into()]] {
        let handle = fixture(""); let mut player = handle.lock().unwrap();
        assert!(is_error(&player.call_internal_interface("bhStepBegin", args)));
        assert_eq!(trace(), vec!["cleanup"]);
    }
}

#[test]
fn step_fence_missing_duplicate_and_malformed_phase_returns_poison() {
    for fault in ["missing_leave", "duplicate_leave", "null_begin", "extra_envelope_field", "begin_throw"] {
        let handle = fixture(fault); let mut player = handle.lock().unwrap();
        assert!(is_error(&begin(&mut player)), "{fault}");
        assert_eq!(trace().iter().filter(|value| value.as_str() == "cleanup").count(), 1);
        assert!(is_error(&phase(&mut player, "bhStepPrepare")));
    }
}

#[test]
fn step_fence_nested_present_is_rejected_even_if_caught_by_phase_body() {
    let handle = fixture("nested_present"); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&phase(&mut player, "bhStepPrepare")));
    assert!(!trace().iter().any(|value| value == "present"));
    assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
}

#[test]
fn step_fence_pinned_registration_and_world_replacement_are_terminal() {
    for fault in ["replace_callback", "replace_world"] {
        let handle = fixture(fault); let mut player = handle.lock().unwrap(); begin(&mut player);
        assert!(is_error(&phase(&mut player, "bhStepPrepare")));
        assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
    }
}

#[test]
fn step_fence_native_transition_requires_exact_phase_body_callee() {
    let handle = fixture("forged_caller"); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&phase(&mut player, "bhStepPrepare")));
    assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
}

#[test]
fn step_fence_unknown_callback_is_rejected_and_cleanup_runs_once() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&player.call_internal_interface("bhUnknown", vec![])));
    assert!(is_error(&player.call_internal_interface("bhUnknown", vec![])));
    assert!(is_error(&phase(&mut player, "bhStepPrepare")));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "cleanup").count(), 1);
}

#[test]
fn step_fence_info_and_receipt_cannot_precede_complete_commit() {
    for name in ["bhInfo", "bhStateReceipt"] {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
        assert!(is_error(&phase(&mut player, name)));
        assert!(!trace().iter().any(|value| value == "info" || value == "receipt"));
    }
}

#[test]
fn step_fence_present_is_not_admitted_after_commit_before_info_or_receipt() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    for name in ["bhStepPrepare", "bhStepProject", "bhStepCommit"] { assert!(!is_error(&phase(&mut player, name))); }
    assert!(is_error(&player.call_internal_interface("bhPresent", vec![1.0.into()])));
    assert!(!trace().iter().any(|value| value == "present"));
}

#[test]
fn step_fence_committed_rng_is_the_original_record_not_a_scalar() {
    let handle = fixture("bad_rng"); let mut player = handle.lock().unwrap(); begin(&mut player);
    phase(&mut player, "bhStepPrepare"); phase(&mut player, "bhStepProject");
    assert!(is_error(&phase(&mut player, "bhStepCommit")));
}

#[test]
fn step_fence_receipt_serialization_caught_reentry_prevents_release() {
    let handle = fixture("receipt_reentry"); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&complete_to_receipt(&mut player)));
    assert!(trace().iter().any(|value| value == "caught_reentry"));
    assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
    assert!(is_error(&begin(&mut player)));
}

#[test]
fn step_fence_malformed_receipt_after_finish_stays_poisoned() {
    let handle = fixture("receipt_malformed"); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&complete_to_receipt(&mut player)));
    assert_eq!(trace().last().map(String::as_str), Some("cleanup"));
}

#[test]
fn step_fence_explicit_abort_and_phase_catch_abort_never_resume() {
    for fault in ["", "phase_abort"] {
        let handle = fixture(fault); let mut player = handle.lock().unwrap(); begin(&mut player);
        assert!(is_error(&phase(&mut player, if fault.is_empty() { "bhStepAbort" } else { "bhStepPrepare" })));
        assert!(is_error(&begin(&mut player)));
        assert_eq!(trace().iter().filter(|value| value.as_str() == "cleanup").count(), 1);
    }
}

#[test]
fn step_fence_cleanup_failure_keeps_terminal_native_poison() {
    let handle = fixture("cleanup_throw"); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(is_error(&player.call_internal_interface("unknown", vec![])));
    assert!(is_error(&phase(&mut player, "bhStepPrepare")));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "cleanup").count(), 1);
}

#[test]
fn step_fence_begin_reentry_from_an_ambient_player_update_is_rejected() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    let result = player.mutate_with_update_context(|context| ExternalInterface::call_callback(context, "bhStepBegin",
        vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "fence_token".into()]));
    assert!(is_error(&result));
    assert_eq!(trace(), vec!["cleanup"]);
}

fn argument_setter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("argument_setter");
    let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
    let token = key(activation, "fence_token").into();
    let previous = activation.callee;
    activation.callee = Some(activation.context.external_interface.step_fence.installed.as_ref().unwrap().bodies[0]);
    let result = op(activation, owner, "begin", token, 1.0.into(), 25.0.into(), None);
    activation.callee = previous;
    assert!(result.is_err());
    Ok(Value::Undefined)
}

fn empty_getter<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    Ok(Value::Undefined)
}

#[test]
fn step_fence_argument_marshalling_cannot_begin_or_execute_game_after_poison() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[argument setter fixture]"), root);
        activation.prototypes().object.add_property(activation.gc(), key(&activation, "slot"),
            native_function(&activation, empty_getter), Some(native_function(&activation, argument_setter)), Attribute::empty());
    });
    let result = player.call_internal_interface("bhStepBegin", vec![25.0.into(), 0.0.into(), 0.0.into(),
        host(&[("slot", 2.0.into()), ("character", 0.0.into())]), "fence_token".into()]);
    assert!(is_error(&result));
    assert_eq!(trace(), vec!["argument_setter", "cleanup"]);
}

#[test]
fn step_fence_successful_receipt_does_not_reuse_prior_epoch() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(!is_error(&complete_to_receipt(&mut player)));
    assert!(is_error(&begin(&mut player)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 1);
}

#[test]
fn step_fence_new_round_same_owner_accepts_reset_tick_with_fresh_epoch_and_world() {
    let handle = fixture(""); let mut player = handle.lock().unwrap(); begin(&mut player);
    assert!(!is_error(&complete_to_receipt(&mut player)));
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[new round fixture]"), root);
        let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
        define(&activation, owner, "epoch", 2.0.into());
        define(&activation, owner, "mcWorld", Object::new_without_proto(activation.gc()).into());
    });
    assert!(!is_error(&begin(&mut player)));
    for name in ["bhStepPrepare", "bhStepProject", "bhStepCommit", "bhInfo", "bhStateReceipt"] {
        let args = if name == "bhInfo" { vec![] } else { vec!["fence_token".into(), 2.0.into(), 25.0.into()] };
        assert!(!is_error(&player.call_internal_interface(name, args)), "{name}");
    }
    assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 2);
}

#[test]
fn step_fence_poisoned_player_disposal_does_not_flush_or_execute_queued_actions() {
    let handle = fixture(""); {
        let mut player = handle.lock().unwrap(); begin(&mut player);
        assert!(is_error(&phase(&mut player, "bhStepAbort")));
        player.flush_shared_objects();
    }
    drop(handle);
    assert!(!trace().iter().any(|value| value == "ambient_action"));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "cleanup").count(), 1);
}
