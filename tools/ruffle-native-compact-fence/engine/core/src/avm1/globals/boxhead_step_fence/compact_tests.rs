//! Actual Player/EI argument and result marshalling for the optional compact
//! protocol. Native callbacks model AS2 body callee boundaries explicitly, as
//! in the retained full fixtures; compiled SWF qualification remains separate.

use super::*;
use crate::avm1::function::NativeFunction;
use crate::context::ActionType;
use crate::external::ExternalInterface;
use crate::player::{Player, PlayerBuilder};
use crate::tag_utils::SwfMovie;
use std::sync::{Arc, Mutex};

pub(crate) use super::tests::{clear_trace, is_error, native_function, record, trace};

fn define<'gc>(activation: &Activation<'_, 'gc>, owner: Object<'gc>, name: &str, value: Value<'gc>) {
    owner.define_value(activation.gc(), key(activation, name), value, Attribute::empty());
}

fn host(fields: &[(&str, HostValue)]) -> HostValue {
    HostValue::Object(fields.iter().map(|(name, value)| ((*name).into(), value.clone())).collect())
}

fn fault<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, expected: &str) -> bool {
    matches!(raw(activation, owner, "fault"), Some(Value::String(value)) if value.eq_with_case(expected.as_bytes(), true))
}

fn with_body<'gc>(activation: &mut Activation<'_, 'gc>, protocol: Protocol, kind: Kind,
    body: impl FnOnce(&mut Activation<'_, 'gc>) -> Result<Value<'gc>, Error<'gc>>) -> Result<Value<'gc>, Error<'gc>> {
    let previous = activation.callee;
    activation.callee = Some(activation.context.external_interface.step_fence.installed_for(protocol).unwrap()
        .bodies[protocol.body_index(kind).unwrap()]);
    let result = body(activation);
    activation.callee = previous;
    result
}

fn op<'gc>(activation: &mut Activation<'_, 'gc>, protocol: Protocol, owner: Object<'gc>, operation: &str,
    token: Value<'gc>, epoch: Value<'gc>, tick: Value<'gc>, phase: Option<&str>) -> Result<Value<'gc>, Error<'gc>> {
    let mut args = vec![key(activation, operation).into(), owner.into(), token, epoch, tick];
    if let Some(phase) = phase { args.push(key(activation, phase).into()); }
    match protocol { Protocol::FullV1 => call(activation, owner, &args), Protocol::CompactV1 => call_compact(activation, owner, &args) }
}

fn envelope<'gc>(activation: &mut Activation<'_, 'gc>, phase: &str) -> Value<'gc> {
    let transaction = activation.context.external_interface.step_fence.transaction.as_ref().unwrap();
    host(&[("version", 1.0.into()), ("phase", phase.to_owned().into()),
        ("token", transaction.token.clone().into()), ("epoch", f64::from(transaction.epoch).into()),
        ("tick", f64::from(transaction.tick).into())]).into_avm1(activation)
}

fn commit_host(tick: u32, protocol: Protocol) -> HostValue {
    host(&[("tick", f64::from(tick).into()), ("digest", "native-v2-0123456789abcdef".into()),
        ("worldTick", f64::from(tick).into()), ("players", HostValue::List(vec![])),
        ("rng", host(&[("seed", 4_294_967_295.0.into()), ("state", 3_456_789_012.0.into()), ("calls", 42.0.into())])),
        ("complete", HostValue::Undefined), ("profile", host(&[("projectMs", 2.0.into()), ("encodeMs", 0.0.into()), ("hashMs", 1.0.into())])),
        ("snapshotBytes", 1024.0.into()),
        ("snapshotObjects", if protocol == Protocol::CompactV1 { 0.0.into() } else { 31.0.into() }),
        ("snapshotFields", if protocol == Protocol::CompactV1 { 0.0.into() } else { 70.0.into() })])
}

fn begin_body<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: Protocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, protocol, Kind::Begin, |activation| {
        record(if protocol == Protocol::CompactV1 { "compact_begin" } else { "full_begin" });
        let epoch = raw(activation, owner, "epoch").unwrap();
        op(activation, protocol, owner, "begin", args[4], epoch, args[0], None)?;
        record("game");
        let world = raw(activation, owner, "mcWorld").unwrap().as_object(activation).unwrap();
        define(activation, world, "tick", args[0]);
        let clip = activation.base_clip();
        let action_name = key(activation, "ambientAction");
        activation.context.action_queue.queue_action(clip, ActionType::Method {
            object: owner, name: action_name, args: vec![],
        }, false);
        if fault(activation, owner, "causal_drain") { Player::run_actions(activation.context); }
        if fault(activation, owner, "begin_throw") { return Err(Error::ThrownValue(key(activation, "fixture").into())); }
        if fault(activation, owner, "nested_present") {
            assert!(is_error(&ExternalInterface::call_callback(activation.context, "bhPresent", vec![0.5.into()])));
        }
        if fault(activation, owner, "wrong_native_global") {
            assert!(op(activation, Protocol::FullV1, owner, "leave", args[4], epoch, args[0], Some("begin")).is_err());
        }
        if !fault(activation, owner, "missing_leave") {
            op(activation, protocol, owner, "leave", args[4], epoch, args[0], Some("begin"))?;
        }
        if fault(activation, owner, "duplicate_leave") {
            let _ = op(activation, protocol, owner, "leave", args[4], epoch, args[0], Some("begin"));
        }
        if fault(activation, owner, "null_begin") { return Ok(Value::Null); }
        let result = envelope(activation, "begun");
        if fault(activation, owner, "extra_envelope") {
            let result = result.as_object(activation).unwrap(); define(activation, result, "extra", true.into());
        }
        Ok(result)
    })
}

fn compact_begin<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    begin_body(activation, owner, args, Protocol::CompactV1)
}
fn full_begin<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    begin_body(activation, owner, args, Protocol::FullV1)
}

fn middle<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], kind: Kind, result_phase: &str) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, Protocol::FullV1, kind, |activation| {
        record(kind.phase().unwrap());
        op(activation, Protocol::FullV1, owner, "enter", args[0], args[1], args[2], kind.phase())?;
        op(activation, Protocol::FullV1, owner, "leave", args[0], args[1], args[2], kind.phase())?;
        Ok(envelope(activation, result_phase))
    })
}
fn full_prepare<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    middle(activation, owner, args, Kind::Prepare, "prepared")
}
fn full_project<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    middle(activation, owner, args, Kind::Project, "projected")
}

fn commit_body<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: Protocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, protocol, Kind::Commit, |activation| {
        record(if protocol == Protocol::CompactV1 { "compact_commit" } else { "full_commit" });
        if fault(activation, owner, "forged_callee") {
            activation.callee = Some(native_function(activation, present));
        }
        op(activation, protocol, owner, "enter", args[0], args[1], args[2], Some("commit"))?;
        if fault(activation, owner, "commit_abort") {
            op(activation, protocol, owner, "abort", args[0], args[1], args[2], None)?;
            return Ok(Value::Null);
        }
        if fault(activation, owner, "replace_world") {
            define(activation, owner, "mcWorld", Object::new_without_proto(activation.gc()).into());
        }
        if fault(activation, owner, "replace_callback") {
            let method = native_function(activation, present);
            activation.context.external_interface.add_callback("bhFrameCommit".into(), Callback::Avm1 { this: owner.into(), method });
        }
        if fault(activation, owner, "commit_throw") { return Err(Error::ThrownValue(key(activation, "fixture").into())); }
        let tick = native_integer(args[2], 1, MAX_INTEGER).unwrap();
        let mut result = commit_host(tick, protocol);
        let HostValue::Object(fields) = &mut result else { unreachable!() };
        if fault(activation, owner, "bad_rng") { fields.insert("rng".into(), 7.0.into()); }
        if fault(activation, owner, "bad_world_tick") { fields.insert("worldTick".into(), f64::from(tick + 1).into()); }
        if fault(activation, owner, "bad_compact_counts") { fields.insert("snapshotObjects".into(), 1.0.into()); }
        if fault(activation, owner, "terminal") { fields.insert("complete".into(), "gameover".into()); }
        op(activation, protocol, owner, "leave", args[0], args[1], args[2], Some("commit"))?;
        Ok(result.into_avm1(activation))
    })
}
fn compact_commit<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    commit_body(activation, owner, args, Protocol::CompactV1)
}
fn full_commit<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    commit_body(activation, owner, args, Protocol::FullV1)
}

fn info<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("info"); Player::run_actions(activation.context);
    let tick = activation.context.external_interface.step_fence.transaction.as_ref().map(|value| value.tick).unwrap_or(0);
    let mut result = host(&[("version", 1.0.into()), ("engine", "original-swf".into()), ("state", "playing".into()),
        ("tick", f64::from(tick).into()), ("snapshotReceiptVersion", 1.0.into()),
        ("stagedStepVersion", 1.0.into()), ("compactStepVersion", 1.0.into())]);
    let HostValue::Object(fields) = &mut result else { unreachable!() };
    if fault(activation, owner, "info_missing_compact") { fields.remove("compactStepVersion"); }
    if fault(activation, owner, "info_missing_full") { fields.remove("stagedStepVersion"); }
    Ok(result.into_avm1(activation))
}

fn serialize_getter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    assert!(activation.context.external_interface.step_fence.frozen());
    record("serialize_fenced"); Player::run_actions(activation.context);
    let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
    if fault(activation, owner, "receipt_reentry") {
        assert!(is_error(&ExternalInterface::call_callback(activation.context, "bhInfo", vec![])));
        record("caught_reentry");
    }
    Ok(1.0.into())
}

fn receipt_body<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: Protocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, protocol, Kind::Receipt, |activation| {
        record(if protocol == Protocol::CompactV1 { "compact_receipt" } else { "full_receipt" });
        let transaction = activation.context.external_interface.step_fence.transaction.as_ref().unwrap();
        let mut header = transaction.commit.clone().unwrap();
        header.remove("worldTick"); header.remove("complete");
        for (name, value) in [("version", 1.0.into()), ("engine", "original-swf".into()),
            ("state", "playing".into()), ("scope", protocol.scope().to_owned().into()),
            ("digestSchema", "native-projection-v3".into())] { header.insert(name.into(), value); }
        let mut result = host(&[("version", 1.0.into()), ("token", transaction.token.clone().into()),
            ("epoch", f64::from(transaction.epoch).into()), ("tick", f64::from(transaction.tick).into()),
            ("scope", protocol.scope().to_owned().into()), ("header", HostValue::Object(header))]);
        let HostValue::Object(fields) = &mut result else { unreachable!() };
        if fault(activation, owner, "receipt_wrong_scope") {
            fields.insert("scope".into(), "full".into());
            let HostValue::Object(header) = fields.get_mut("header").unwrap() else { unreachable!() };
            header.insert("scope".into(), "full".into());
        }
        if fault(activation, owner, "receipt_wrong_header") {
            let HostValue::Object(header) = fields.get_mut("header").unwrap() else { unreachable!() };
            header.insert("snapshotBytes".into(), 1025.0.into());
        }
        if !fault(activation, owner, "receipt_missing_finish") {
            let finish_protocol = if fault(activation, owner, "receipt_wrong_global") { Protocol::FullV1 } else { protocol };
            op(activation, finish_protocol, owner, "finish", args[0], args[1], args[2], None)?;
        }
        record("finish_marked");
        assert!(activation.context.external_interface.step_fence.frozen());
        let result = result.into_avm1(activation).as_object(activation).unwrap();
        result.add_property(activation.gc(), key(activation, "version"), native_function(activation, serialize_getter), None, Attribute::empty());
        Ok(result.into())
    })
}
fn compact_receipt<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    receipt_body(activation, owner, args, Protocol::CompactV1)
}
fn full_receipt<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    receipt_body(activation, owner, args, Protocol::FullV1)
}
fn receipt_dispatch<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    match activation.context.external_interface.step_fence.active_protocol() {
        Some(Protocol::CompactV1) => compact_receipt(activation, owner, args),
        _ => full_receipt(activation, owner, args),
    }
}

fn present<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("present"); Player::run_actions(activation.context);
    let tick = activation.context.external_interface.step_fence.transaction.as_ref().map(|value| value.tick).unwrap_or(0);
    let rendered = !fault(activation, owner, "terminal");
    Ok(host(&[("version", 1.0.into()), ("tick", f64::from(tick).into()), ("rendered", rendered.into())]).into_avm1(activation))
}

fn abort_body<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: Protocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(activation, protocol, Kind::Abort, |activation| {
        record("abort"); op(activation, protocol, owner, "abort", args[0], args[1], args[2], None)?;
        Ok(host(&[("error", "fixture abort".into())]).into_avm1(activation))
    })
}
fn compact_abort<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    abort_body(activation, owner, args, Protocol::CompactV1)
}
fn full_abort<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    abort_body(activation, owner, args, Protocol::FullV1)
}
fn full_cleanup<'gc>(_activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("full_cleanup"); Ok(true.into())
}
fn compact_cleanup<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("compact_cleanup");
    if fault(activation, owner, "cleanup_throw") { return Err(Error::ThrownValue(key(activation, "cleanup fixture").into())); }
    Ok(true.into())
}
fn ambient_action<'gc>(_activation: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("ambient_action"); Ok(Value::Undefined)
}

fn setup(fault_name: &str, install_full: bool, install_optional: bool) -> Arc<Mutex<Player>> {
    clear_trace();
    let handle = PlayerBuilder::new().with_movie(SwfMovie::empty(8, None))
        .with_autoplay(true).with_frame_rate(Some(25.0)).build();
    handle.lock().unwrap().mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact fixture install]"), root);
        let owner = Object::new_without_proto(activation.gc());
        define(&activation, owner, "mcWorld", Object::new_without_proto(activation.gc()).into());
        define(&activation, owner, "epoch", 1.0.into());
        define(&activation, owner, "fault", key(&activation, fault_name).into());
        define(&activation, owner, CLEANUP_NAME, native_function(&activation, full_cleanup).into());
        define(&activation, owner, COMPACT_CLEANUP_NAME, native_function(&activation, compact_cleanup).into());
        define(&activation, owner, "ambientAction", native_function(&activation, ambient_action).into());
        let full: [NativeFunction; 8] = [full_begin, full_prepare, full_project, full_commit, info, receipt_dispatch, present, full_abort];
        for (index, callback) in full.into_iter().enumerate() {
            let method = native_function(&activation, callback);
            let kind = Kind::from_name(CALLBACK_NAMES[index]).unwrap();
            if let Some(body) = kind.body_index() {
                let body_method = if kind == Kind::Receipt { native_function(&activation, full_receipt) } else { method };
                define(&activation, owner, BODY_NAMES[body], body_method.into());
            }
            activation.context.external_interface.add_callback(CALLBACK_NAMES[index].into(), Callback::Avm1 { this: owner.into(), method });
        }
        for (name, body, callback) in [
            ("bhFrameBegin", "BH_CompactFrameBegin", compact_begin as NativeFunction),
            ("bhFrameCommit", "BH_CompactFrameCommit", compact_commit as NativeFunction),
            ("bhFrameAbort", "BH_CompactFrameAbort", compact_abort as NativeFunction),
        ] {
            let method = native_function(&activation, callback);
            define(&activation, owner, body, method.into());
            activation.context.external_interface.add_callback(name.into(), Callback::Avm1 { this: owner.into(), method });
        }
        define(&activation, owner, "BH_CompactStateReceipt", native_function(&activation, compact_receipt).into());
        let args = [key(&activation, "install").into(), owner.into()];
        if install_full { assert_eq!(call(&mut activation, owner, &args).unwrap(), Value::Bool(true)); }
        if install_optional { assert_eq!(call_compact(&mut activation, owner, &args).unwrap(), Value::Bool(true)); }
        // Retain the fixture owner only in the ordinary global for the explicit
        // pre-install negative case; no production fence state is fabricated.
        let global = activation.global_object(); define(&activation, global, "fixtureOwner", owner.into());
    });
    handle
}

pub(crate) fn fixture(fault_name: &str) -> Arc<Mutex<Player>> { setup(fault_name, true, true) }
pub(crate) fn tuple(tick: u32, epoch: u32) -> Vec<HostValue> {
    vec!["compact_token".into(), f64::from(epoch).into(), f64::from(tick).into()]
}
pub(crate) fn begin(player: &mut Player, tick: u32) -> HostValue {
    player.call_internal_interface("bhFrameBegin", vec![f64::from(tick).into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "compact_token".into()])
}
pub(crate) fn phase(player: &mut Player, name: &str, tick: u32, epoch: u32) -> HostValue {
    player.call_internal_interface(name, if name == "bhInfo" { vec![] } else { tuple(tick, epoch) })
}
pub(crate) fn finish(player: &mut Player, tick: u32, epoch: u32) -> HostValue {
    for name in ["bhFrameCommit", "bhInfo"] { assert!(!is_error(&phase(player, name, tick, epoch)), "{name}"); }
    phase(player, "bhStateReceipt", tick, epoch)
}
pub(crate) fn next_epoch(player: &mut Player, epoch: u32, replace_world: bool) {
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact next fixture]"), root);
        let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
        define(&activation, owner, "epoch", f64::from(epoch).into());
        if replace_world { define(&activation, owner, "mcWorld", Object::new_without_proto(activation.gc()).into()); }
    });
}

#[test]
fn compact_fence_capability_is_exact_and_leaves_full_capability_unchanged() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact capability]"), root);
        let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
        let args = [key(&activation, "capability").into()];
        for (compact, contract) in [(false, "bh-step-fence-v1"), (true, "bh-compact-step-fence-v1")] {
            let value = if compact { call_compact(&mut activation, owner, &args) } else { call(&mut activation, owner, &args) }.unwrap();
            assert_eq!(HostValue::from_avm1(&mut activation, value).unwrap(), host(&[("version", 1.0.into()), ("contract", contract.to_owned().into())]));
        }
    });
}

#[test]
fn compact_fence_install_requires_full_owner_and_cannot_repeat() {
    for case in ["no_full", "other_owner", "repeat"] {
        let handle = setup("", case != "no_full", case == "repeat"); let mut player = handle.lock().unwrap();
        player.mutate_with_update_context(|context| {
            let root = context.stage.root_clip().unwrap();
            let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact bad install]"), root);
            let owner = if case == "other_owner" { Object::new_without_proto(activation.gc()) }
                else { let global = activation.global_object(); raw(&mut activation, global, "fixtureOwner").unwrap().as_object(&mut activation).unwrap() };
            let args = [key(&activation, "install").into(), owner.into()];
            assert!(call_compact(&mut activation, owner, &args).is_err());
            assert!(activation.context.external_interface.step_fence.poisoned());
        });
    }
}

#[test]
fn compact_fence_shared_callback_identity_cannot_be_replaced_at_install() {
    for name in ["bhInfo", "bhStateReceipt", "bhPresent"] {
        let handle = setup("", true, false); let mut player = handle.lock().unwrap();
        player.mutate_with_update_context(|context| {
            let root = context.stage.root_clip().unwrap();
            let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact shared pins]"), root);
            let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
            let method = native_function(&activation, present);
            activation.context.external_interface.add_callback(name.into(), Callback::Avm1 { this: owner.into(), method });
            let args = [key(&activation, "install").into(), owner.into()];
            assert!(call_compact(&mut activation, owner, &args).is_err());
        });
    }
}

#[test]
fn compact_fence_two_phase_chain_keeps_game_once_and_releases_after_frame_receipt_serialization() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    assert!(!is_error(&begin(&mut player, 1)));
    for alpha in [0.0, 0.5, 1.0] { assert!(!is_error(&player.call_internal_interface("bhPresent", vec![alpha.into()]))); }
    let receipt = finish(&mut player, 1, 1);
    assert!(!is_error(&receipt)); assert_eq!(map(&receipt).unwrap().get("scope"), Some(&"frame".into()));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 1);
    assert!(!trace().iter().any(|value| value == "ambient_action" || value == "prepare" || value == "project"));
    assert!(trace().ends_with(&["compact_receipt".into(), "finish_marked".into(), "serialize_fenced".into()]));
    player.update(|_| ()); assert_eq!(trace().last().map(String::as_str), Some("ambient_action"));
}

#[test]
fn compact_fence_rejects_full_tick_numbers_and_malformed_begin_before_game() {
    let valid = vec![1.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "compact_token".into()];
    let mut cases = Vec::new();
    for tick in [0.0, 25.0, 50.0, -1.0, 1.5, f64::NAN] { let mut args = valid.clone(); args[0] = tick.into(); cases.push(args); }
    let mut args = valid.clone(); args[1] = 131_072.0.into(); cases.push(args);
    let mut args = valid.clone(); args[3] = HostValue::Null; cases.push(args);
    let mut args = valid.clone(); args[4] = "invalid-token".into(); cases.push(args);
    let mut args = valid.clone(); args.push(0.0.into()); cases.push(args);
    for args in cases {
        let handle = fixture(""); let mut player = handle.lock().unwrap();
        assert!(is_error(&player.call_internal_interface("bhFrameBegin", args)));
        assert!(!trace().iter().any(|value| value == "game"));
        assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
    }
}

#[test]
fn compact_fence_accepts_exact_join_record_without_changing_the_phase_contract() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    let begin = player.call_internal_interface("bhFrameBegin", vec![24.0.into(), 131_071.0.into(), 131_071.0.into(),
        host(&[("slot", 2.0.into()), ("character", 3.0.into())]), "compact_token".into()]);
    assert_eq!(map(&begin).unwrap().len(), 5); assert!(!is_error(&begin));
    assert!(!is_error(&finish(&mut player, 24, 1)));
}

#[test]
fn compact_fence_full_and_compact_transactions_share_one_monotonic_epoch() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    assert!(!is_error(&begin(&mut player, 24))); assert!(!is_error(&finish(&mut player, 24, 1)));
    next_epoch(&mut player, 2, false);
    assert!(!is_error(&player.call_internal_interface("bhStepBegin", vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "compact_token".into()])));
    for name in ["bhStepPrepare", "bhStepProject", "bhStepCommit", "bhInfo", "bhStateReceipt"] {
        let result = phase(&mut player, name, 25, 2); assert!(!is_error(&result), "{name}: {result:?}");
        if name == "bhStateReceipt" { assert_eq!(map(&result).unwrap().get("scope"), Some(&"full".into())); }
    }
    next_epoch(&mut player, 3, false);
    assert!(!is_error(&begin(&mut player, 26))); assert!(!is_error(&finish(&mut player, 26, 3)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 3);
    assert!(is_error(&begin(&mut player, 27)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 3);
}

#[test]
fn compact_fence_new_round_can_reset_tick_only_with_a_fresh_epoch() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    assert!(!is_error(&begin(&mut player, 999))); assert!(!is_error(&finish(&mut player, 999, 1)));
    next_epoch(&mut player, 2, true);
    assert!(!is_error(&begin(&mut player, 1))); assert!(!is_error(&finish(&mut player, 1, 2)));
    assert!(is_error(&begin(&mut player, 2)));
}

#[test]
fn compact_fence_cross_family_external_callbacks_never_switch_the_open_transaction() {
    for name in ["bhStepBegin", "bhStepPrepare", "bhStepProject", "bhStepCommit", "bhStepAbort"] {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&phase(&mut player, name, 1, 1)));
        assert_eq!(trace().iter().filter(|value| value.as_str() == "game").count(), 1);
        assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
    }
    for name in ["bhFrameBegin", "bhFrameCommit", "bhFrameAbort"] {
        let handle = fixture(""); let mut player = handle.lock().unwrap();
        assert!(!is_error(&player.call_internal_interface("bhStepBegin", vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "compact_token".into()])));
        assert!(is_error(&phase(&mut player, name, 25, 1)));
        assert!(!trace().iter().any(|value| value == "compact_begin" || value == "compact_commit" || value == "compact_cleanup"));
    }
}

#[test]
fn compact_fence_info_receipt_and_present_obey_exact_phase_order() {
    for name in ["bhInfo", "bhStateReceipt"] {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&phase(&mut player, name, 1, 1)));
        assert!(!trace().iter().any(|value| value == "info" || value == "compact_receipt"));
    }
    for after_info in [false, true] {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(!is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
        if after_info { assert!(!is_error(&phase(&mut player, "bhInfo", 1, 1))); }
        assert!(is_error(&player.call_internal_interface("bhPresent", vec![0.5.into()])));
        assert!(!trace().iter().any(|value| value == "present"));
    }
    for fault_name in ["info_missing_compact", "info_missing_full"] {
        let handle = fixture(fault_name); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(!is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
        assert!(is_error(&phase(&mut player, "bhInfo", 1, 1)));
        assert!(!trace().iter().any(|value| value == "compact_receipt"));
    }
}

#[test]
fn compact_fence_stale_tuple_and_duplicate_commit_are_rejected_before_another_body() {
    for args in [vec!["wrong".into(), 1.0.into(), 1.0.into()], vec!["compact_token".into(), 2.0.into(), 1.0.into()],
        vec!["compact_token".into(), 1.0.into(), 2.0.into()]] {
        let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&player.call_internal_interface("bhFrameCommit", args)));
        assert!(!trace().iter().any(|value| value == "compact_commit"));
    }
    let handle = fixture(""); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
    assert!(!is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
    assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_commit").count(), 1);
}

#[test]
fn compact_fence_missing_duplicate_or_malformed_begin_never_releases_the_owner() {
    for fault_name in ["begin_throw", "missing_leave", "duplicate_leave", "null_begin", "extra_envelope"] {
        let handle = fixture(fault_name); let mut player = handle.lock().unwrap();
        assert!(is_error(&begin(&mut player, 1)), "{fault_name}");
        assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
        assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
    }
}

#[test]
fn compact_fence_native_callee_and_protocol_are_authenticated_independently() {
    let handle = fixture("wrong_native_global"); let mut player = handle.lock().unwrap();
    assert!(is_error(&begin(&mut player, 1)));
    drop(player); drop(handle);
    let handle = fixture("forged_callee"); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
    assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
}

#[test]
fn compact_fence_callback_world_and_raw_body_replacement_are_terminal() {
    for fault_name in ["replace_world", "replace_callback"] {
        let handle = fixture(fault_name); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
    }
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[changed compact body]"), root);
        let owner = activation.context.external_interface.step_fence.installed.as_ref().unwrap().owner;
        define(&activation, owner, "BH_CompactFrameCommit", native_function(&activation, present).into());
    });
    assert!(is_error(&begin(&mut player, 1))); assert!(!trace().iter().any(|value| value == "game"));
}

#[test]
fn compact_fence_commit_rng_and_world_tick_keep_the_original_result_contract() {
    for fault_name in ["bad_rng", "bad_world_tick", "bad_compact_counts", "commit_throw"] {
        let handle = fixture(fault_name); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&phase(&mut player, "bhFrameCommit", 1, 1)));
        assert!(is_error(&phase(&mut player, "bhInfo", 1, 1)));
    }
}

#[test]
fn compact_fence_receipt_scope_header_and_finish_must_all_match_the_commit() {
    for fault_name in ["receipt_wrong_scope", "receipt_wrong_header", "receipt_missing_finish", "receipt_wrong_global"] {
        let handle = fixture(fault_name); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&finish(&mut player, 1, 1)), "{fault_name}");
        assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
    }
}

#[test]
fn compact_fence_caught_receipt_serialization_reentry_stays_poisoned_after_finish() {
    let handle = fixture("receipt_reentry"); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
    assert!(is_error(&finish(&mut player, 1, 1)));
    assert!(trace().iter().any(|value| value == "caught_reentry"));
    assert!(is_error(&begin(&mut player, 2)));
    assert!(!trace().iter().any(|value| value == "ambient_action"));
}

#[test]
fn compact_fence_present_cannot_reenter_an_entered_phase_even_when_rejection_is_caught() {
    let handle = fixture("nested_present"); let mut player = handle.lock().unwrap();
    assert!(is_error(&begin(&mut player, 1))); assert!(!trace().iter().any(|value| value == "present"));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
}

#[test]
fn compact_fence_causal_action_drain_is_allowed_only_inside_entered_body() {
    let handle = fixture("causal_drain"); let mut player = handle.lock().unwrap();
    assert!(!is_error(&begin(&mut player, 1))); assert_eq!(trace(), vec!["compact_begin", "game", "ambient_action"]);
    assert!(!is_error(&player.call_internal_interface("bhPresent", vec![0.5.into()])));
    assert!(!is_error(&finish(&mut player, 1, 1)));
    assert_eq!(trace().iter().filter(|value| value.as_str() == "ambient_action").count(), 1);
}

#[test]
fn compact_fence_explicit_and_catch_abort_clean_both_abilities_once() {
    for fault_name in ["", "commit_abort", "cleanup_throw"] {
        let handle = fixture(fault_name); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&phase(&mut player, if fault_name == "commit_abort" { "bhFrameCommit" } else { "bhFrameAbort" }, 1, 1)));
        assert!(is_error(&begin(&mut player, 2)));
        assert!(is_error(&player.call_internal_interface("bhStepBegin", vec![25.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "compact_token".into()])));
        assert_eq!(trace().iter().filter(|value| value.as_str() == "compact_cleanup").count(), 1);
        assert!(!trace().iter().any(|value| value == "full_cleanup"));
    }
}

#[test]
fn compact_fence_terminal_begin_can_paint_nothing_and_still_return_the_verified_receipt() {
    let handle = fixture("terminal"); let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
    let presented = player.call_internal_interface("bhPresent", vec![1.0.into()]);
    assert_eq!(map(&presented).unwrap().get("rendered"), Some(&HostValue::Bool(false)));
    assert!(!is_error(&finish(&mut player, 1, 1)));
}

fn argument_setter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    record("argument_setter");
    let pins = activation.context.external_interface.step_fence.compact_installed.as_ref().unwrap().clone();
    let previous = activation.callee; activation.callee = Some(pins.bodies[0]);
    let token = key(activation, "compact_token").into();
    assert!(op(activation, Protocol::CompactV1, pins.owner, "begin", token, 1.0.into(), 1.0.into(), None).is_err());
    activation.callee = previous;
    Ok(Value::Undefined)
}
fn empty_getter<'gc>(_activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> { Ok(Value::Undefined) }

#[test]
fn compact_fence_argument_setter_cannot_begin_before_the_pinned_body_or_hide_poison() {
    let handle = fixture(""); let mut player = handle.lock().unwrap();
    player.mutate_with_update_context(|context| {
        let root = context.stage.root_clip().unwrap();
        let activation = Activation::from_nothing(context, ActivationIdentifier::root("[compact argument setter]"), root);
        activation.prototypes().object.add_property(activation.gc(), key(&activation, "slot"), native_function(&activation, empty_getter),
            Some(native_function(&activation, argument_setter)), Attribute::empty());
    });
    let result = player.call_internal_interface("bhFrameBegin", vec![1.0.into(), 0.0.into(), 0.0.into(),
        host(&[("slot", 2.0.into()), ("character", 0.0.into())]), "compact_token".into()]);
    assert!(is_error(&result)); assert_eq!(trace(), vec!["argument_setter", "compact_cleanup"]);
}

#[test]
fn compact_fence_ambient_reentry_is_rejected_before_game_and_disposal_never_drains() {
    let handle = fixture(""); {
        let mut player = handle.lock().unwrap();
        let result = player.mutate_with_update_context(|context| ExternalInterface::call_callback(context, "bhFrameBegin",
            vec![1.0.into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "compact_token".into()]));
        assert!(is_error(&result)); assert!(!trace().iter().any(|value| value == "game"));
    }
    drop(handle);
    let handle = fixture(""); {
        let mut player = handle.lock().unwrap(); assert!(!is_error(&begin(&mut player, 1)));
        assert!(is_error(&phase(&mut player, "bhFrameAbort", 1, 1))); player.flush_shared_objects();
    }
    drop(handle); assert!(!trace().iter().any(|value| value == "ambient_action"));
}
