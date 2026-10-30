//! Actual Arena collections across the native full/compact fence boundaries.
//!
//! The additional callbacks below are native unit-fixture bodies, not the
//! compiled game. They retain real AVM1 objects, the actual native projector's
//! output/cleanup list and actual BitmapData through the bridge's ownership
//! shape. The unchanged compiled AS2 probe and whole-game A/B remain required.
//! Witness handles root only a Vec<ObjectWeak>; they cannot keep a tested
//! object alive. Every collection also has an unreachable weak sentinel.

use super::*;
use crate::avm1::{ArrayBuilder, NativeObject};
use crate::avm1::globals::boxhead_native_project;
use crate::avm1::globals::boxhead_step_fence::{self as native_fence, compact_tests, tests as full_tests};
use crate::avm1::globals::boxhead_step_fence::GcTestObjectWeak as ObjectWeak;
use crate::avm1::Error;
use crate::bitmap::bitmap_data::{BitmapData, Color as BitmapColor};
use crate::bitmap::operations as bitmap_operations;
use crate::context::ActionType;
use crate::external::{Callback, Value as HostValue};
use crate::player::PlayerBuilder;
use crate::tag_utils::SwfMovie;
use gc_arena::arena::CollectionPhase;
use gc_arena::{DynamicRoot, Gc, Rootable};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

type WeakWitnesses = DynamicRoot<Rootable![Vec<ObjectWeak<'_>>]>;
type NativeFunction = for<'gc> fn(&mut Activation<'_, 'gc>, Object<'gc>, &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FixtureProtocol { Full, Compact }

impl FixtureProtocol {
    fn tick(self) -> u32 { if self == Self::Full { 25 } else { 26 } }
    fn tx(self) -> &'static str { if self == Self::Full { "mBHStagedStep" } else { "mBHCompactStep" } }
    fn scope(self) -> &'static str { if self == Self::Full { "full" } else { "frame" } }
    fn begin_name(self) -> &'static str { if self == Self::Full { "bhStepBegin" } else { "bhFrameBegin" } }
    fn body(self, phase: &str) -> &'static str {
        match (self, phase) {
            (Self::Full, "begin") => "BH_StagedStepBegin",
            (Self::Full, "prepare") => "BH_StagedStepPrepare",
            (Self::Full, "project") => "BH_StagedStepProject",
            (Self::Full, "commit") => "BH_StagedStepCommit",
            (Self::Full, "receipt") => "BH_StagedStateReceipt",
            (Self::Full, "abort") => "BH_StagedStepAbort",
            (Self::Compact, "begin") => "BH_CompactFrameBegin",
            (Self::Compact, "commit") => "BH_CompactFrameCommit",
            (Self::Compact, "receipt") => "BH_CompactStateReceipt",
            (Self::Compact, "abort") => "BH_CompactFrameAbort",
            _ => panic!("invalid fixture phase"),
        }
    }
}

fn key<'gc>(a: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(a.gc(), text)
}
fn object<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> {
    Object::new(&a.context.strings, Some(a.prototypes().object))
}
fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    full_tests::native_function(a, callback)
}
fn define<'gc>(a: &Activation<'_, 'gc>, target: Object<'gc>, name: &str, value: Value<'gc>) {
    target.define_value(a.gc(), key(a, name), value, Attribute::empty());
}
fn stored<'gc>(a: &mut Activation<'_, 'gc>, target: Object<'gc>, name: &str) -> Value<'gc> {
    target.get_data(key(a, name), a).unwrap_or(Value::Undefined)
}
fn as_object(value: Value<'_>) -> Object<'_> {
    match value { Value::Object(value) => value, _ => panic!("expected stored object: {value:?}") }
}
fn array<'gc>(a: &mut Activation<'_, 'gc>, values: &[Value<'gc>]) -> Object<'gc> {
    ArrayBuilder::new(a).with(values.iter().copied()).into()
}
fn host(fields: &[(&str, HostValue)]) -> HostValue {
    HostValue::Object(fields.iter().map(|(name, value)| ((*name).into(), value.clone())).collect())
}
fn owner<'gc>(context: &UpdateContext<'gc>) -> Object<'gc> {
    match context.external_interface.get_callback("bhStepBegin").unwrap() {
        Callback::Avm1 { this: Value::Object(owner), .. } => owner,
        _ => panic!("fixture callback owner"),
    }
}
fn inspect<T>(player: &mut Player, read: impl for<'gc> FnOnce(&mut Activation<'_, 'gc>, Object<'gc>) -> T) -> T {
    // Test-only raw inspection. There is no EI entry, native query, action
    // drain, or collection inside this generative mutation closure.
    player.mutate_with_update_context_unchecked(|context| {
        let owner = owner(context);
        let root = context.stage.root_clip().unwrap();
        let mut a = Activation::from_nothing(context, ActivationIdentifier::root("[GC root witness]"), root);
        read(&mut a, owner)
    })
}
fn weak_paths(player: &mut Player, paths: &[&[&str]]) -> WeakWitnesses {
    inspect(player, |a, owner| {
        let mut weak = Vec::new();
        for path in paths {
            let mut target = owner;
            for name in *path { target = as_object(stored(a, target, name)); }
            weak.push(target.as_weak());
        }
        // This object has no strong root after this closure returns. Its
        // death proves that the test performed a real native collection.
        weak.push(object(a).as_weak());
        a.context.dynamic_root.stash::<Rootable![Vec<ObjectWeak<'_>>]>(a.gc(), Gc::new(a.gc(), weak))
    })
}
fn alive(player: &Player, witnesses: &WeakWitnesses) -> Vec<bool> {
    player.enter_arena(|mc, root, _| {
        root.dynamic_root.fetch(witnesses).iter().map(|value| value.upgrade(mc).is_some()).collect()
    })
}
fn collect(player: &mut Player) {
    let before_trace = full_tests::trace();
    let before_queue = player.boxhead_deferred.entries.len();
    let before_state = (player.boxhead_frozen(), player.boxhead_poisoned());
    {
        let mut arena = player.gc_arena.borrow_mut();
        // Two cycles also collect allocations that were born black during
        // an already active sweep; neither call can overlap a VM borrow.
        arena.finish_cycle();
        arena.finish_cycle();
        assert_eq!(arena.collection_phase(), CollectionPhase::Sleeping);
    }
    assert_eq!(full_tests::trace(), before_trace, "GC executed AVM work");
    assert_eq!(player.boxhead_deferred.entries.len(), before_queue, "GC drained an ambient entry");
    assert_eq!((player.boxhead_frozen(), player.boxhead_poisoned()), before_state);
}
fn collect_live(player: &mut Player, paths: &[&[&str]]) {
    let witnesses = weak_paths(player, paths);
    collect(player);
    let mut expected = vec![true; paths.len()]; expected.push(false);
    assert_eq!(alive(player, &witnesses), expected);
}
fn before_mutation(player: &mut Player) {
    collect(player);
    let mut arena = player.gc_arena.borrow_mut();
    assert!(arena.finish_marking().is_some());
    assert_eq!(arena.collection_phase(), CollectionPhase::Marked);
    // The following real phase publishes fresh children under a black owner.
    // The normal Object/GcRefLock barriers must make those children visible.
}
fn op<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, protocol: FixtureProtocol,
    operation: &str, token: Value<'gc>, epoch: Value<'gc>, tick: Value<'gc>, phase: Option<&str>) -> Result<Value<'gc>, Error<'gc>> {
    let mut args = vec![key(a, operation).into(), owner.into(), token, epoch, tick];
    if let Some(phase) = phase { args.push(key(a, phase).into()); }
    match protocol {
        FixtureProtocol::Full => native_fence::call(a, owner, &args),
        FixtureProtocol::Compact => native_fence::call_compact(a, owner, &args),
    }
}
fn with_body<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, protocol: FixtureProtocol,
    phase: &str, body: impl FnOnce(&mut Activation<'_, 'gc>) -> Result<Value<'gc>, Error<'gc>>) -> Result<Value<'gc>, Error<'gc>> {
    let previous = a.callee;
    a.callee = Some(as_object(stored(a, owner, protocol.body(phase))));
    let result = body(a); a.callee = previous; result
}
fn phase_envelope<'gc>(a: &mut Activation<'_, 'gc>, protocol: FixtureProtocol, phase: &str) -> Value<'gc> {
    host(&[("version", 1.0.into()), ("phase", phase.to_owned().into()), ("token", "gc_token".into()),
        ("epoch", 1.0.into()), ("tick", f64::from(protocol.tick()).into())]).into_avm1(a)
}
fn project_policy<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let name = args[0].coerce_to_string(a)?;
    let cache = as_object(stored(a, owner, "mBHFieldCache"));
    cache.set(name, false, a)?;
    Ok(false.into())
}
fn process_name<'gc>(a: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    Ok(key(a, "Process_GcFixture").into())
}
fn forbidden_project<'gc>(_a: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    panic!("native projector unexpectedly called its pinned fallback");
}
fn ambient<'gc>(_a: &mut Activation<'_, 'gc>, _owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    full_tests::record("gc_ambient"); Ok(Value::Undefined)
}

fn begin_body<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: FixtureProtocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(a, owner, protocol, "begin", |a| {
        op(a, owner, protocol, "begin", args[4], 1.0.into(), args[0], None)?;
        full_tests::record("gc_game");
        let world = as_object(stored(a, owner, "mcWorld"));
        let child = object(a);
        define(a, child, "back", world.into());
        define(a, child, "number", (-0.0_f64).into());
        define(a, child, "label", key(a, "GC-\u{1f642}-\u{03a9}").into());
        define(a, world, "alpha", child.into());
        define(a, world, "zeta", child.into());
        define(a, world, "tick", args[0]);
        let bridge = as_object(stored(a, owner, "mBH"));
        let tx = object(a);
        for (name, value) in [("world", world.into()), ("bridge", bridge.into()), ("tick", args[0])] {
            define(a, tx, name, value);
        }
        define(a, owner, protocol.tx(), tx.into());
        let p = object(a);
        let bitmap = BitmapData::new_with_pixels(a.gc(), 2, 2, true, vec![
            BitmapColor::rgba(13, 71, 209, 255), BitmapColor::rgba(201, 9, 17, 255),
            BitmapColor::rgba(33, 190, 7, 255), BitmapColor::rgba(255, 255, 255, 255),
        ]);
        let display = Object::new_with_native(&a.context.strings, Some(a.prototypes().bitmap_data), NativeObject::BitmapData(bitmap));
        let geometry = object(a); define(a, geometry, "tx", 12.5.into()); define(a, geometry, "ty", (-3.25).into());
        let command = object(a); define(a, command, "display", display.into()); define(a, command, "geometry", geometry.into());
        let commands = array(a, &[command.into()]); let scratch = array(a, &[display.into()]);
        define(a, p, "commands", commands.into()); define(a, p, "scratch", scratch.into()); define(a, p, "world", world.into());
        define(a, bridge, "presentation", p.into());
        let clip = a.base_clip(); let name = key(a, "ambientAction");
        a.context.action_queue.queue_action(clip, ActionType::Method { object: owner, name, args: vec![] }, false);
        op(a, owner, protocol, "leave", args[4], 1.0.into(), args[0], Some("begin"))?;
        Ok(phase_envelope(a, protocol, "begun"))
    })
}
fn full_begin<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    begin_body(a, owner, args, FixtureProtocol::Full)
}
fn compact_begin<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    begin_body(a, owner, args, FixtureProtocol::Compact)
}
fn prepare<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(a, owner, FixtureProtocol::Full, "prepare", |a| {
        op(a, owner, FixtureProtocol::Full, "enter", args[0], args[1], args[2], Some("prepare"))?;
        full_tests::record("gc_prepare");
        let tx = as_object(stored(a, owner, FixtureProtocol::Full.tx()));
        let context = object(a); let objects = array(a, &[]); let errors = array(a, &[]);
        let pinned = stored(a, owner, "BH_Project");
        for (name, value) in [("objects", objects.into()), ("errorPath", errors.into()), ("fields", 0.0.into()),
            ("projectionKernel", Value::Undefined), ("nativeProjectOwner", owner.into()), ("nativeProjectFunction", pinned)] {
            define(a, context, name, value);
        }
        let root = object(a); let world = stored(a, owner, "mcWorld"); define(a, root, "world", world);
        define(a, tx, "context", context.into()); define(a, tx, "root", root.into());
        op(a, owner, FixtureProtocol::Full, "leave", args[0], args[1], args[2], Some("prepare"))?;
        Ok(phase_envelope(a, FixtureProtocol::Full, "prepared"))
    })
}
fn project<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    with_body(a, owner, FixtureProtocol::Full, "project", |a| {
        op(a, owner, FixtureProtocol::Full, "enter", args[0], args[1], args[2], Some("project"))?;
        full_tests::record("gc_project");
        let tx = as_object(stored(a, owner, FixtureProtocol::Full.tx()));
        let root = stored(a, tx, "root"); let context = stored(a, tx, "context");
        let run = key(a, "run"); let global = a.global_object();
        let output = as_object(boxhead_native_project::call(a, global, &[run.into(), root, context, owner.into()])?);
        assert_eq!(stored(a, output, "version"), 1.0.into());
        let output = stored(a, output, "value"); define(a, tx, "nativeState", output);
        op(a, owner, FixtureProtocol::Full, "leave", args[0], args[1], args[2], Some("project"))?;
        Ok(phase_envelope(a, FixtureProtocol::Full, "projected"))
    })
}
fn commit_fields(protocol: FixtureProtocol, objects: f64, fields: f64) -> BTreeMap<String, HostValue> {
    let HostValue::Object(result) = host(&[("tick", f64::from(protocol.tick()).into()),
        ("worldTick", f64::from(protocol.tick()).into()), ("digest", "native-gc-fixture".into()),
        ("players", HostValue::List(vec![])),
        ("rng", host(&[("seed", 7.0.into()), ("state", 123_456.0.into()), ("calls", 42.0.into())])),
        ("profile", host(&[("projectMs", 0.0.into()), ("encodeMs", 0.0.into()), ("hashMs", 0.0.into())])),
        ("snapshotBytes", 1024.0.into()), ("snapshotObjects", objects.into()), ("snapshotFields", fields.into())]) else { unreachable!() };
    result
}
fn commit_body<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: FixtureProtocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(a, owner, protocol, "commit", |a| {
        op(a, owner, protocol, "enter", args[0], args[1], args[2], Some("commit"))?;
        full_tests::record("gc_commit");
        let tx = as_object(stored(a, owner, protocol.tx()));
        let bridge = as_object(stored(a, tx, "bridge"));
        let (native, objects, fields) = if protocol == FixtureProtocol::Full {
            let context = as_object(stored(a, tx, "context"));
            let objects = as_object(stored(a, context, "objects"));
            let count = objects.length(a)?;
            let Value::Number(fields) = stored(a, context, "fields") else { panic!("projected field count"); };
            assert!(count >= 3 && fields >= 6.0);
            let native = stored(a, tx, "nativeState");
            for index in 0..count {
                let source = as_object(objects.get_element(a, index));
                assert!(source.delete(a, key(a, "__bhSnapshotRef")));
            }
            for name in ["context", "root", "nativeState"] { assert!(tx.delete(a, key(a, name))); }
            (native, f64::from(count), fields)
        } else {
            let frame = object(a); let players = array(a, &[12.5.into(), (-3.25).into()]);
            define(a, frame, "tick", args[2]); define(a, frame, "positions", players.into());
            (frame.into(), 0.0, 0.0)
        };
        let committed = commit_fields(protocol, objects, fields);
        let snapshot = as_object(HostValue::Object(committed.clone()).into_avm1(a));
        for (name, value) in [("version", 1.0.into()), ("engine", key(a, "original-swf").into()),
            ("state", key(a, "playing").into()), ("scope", key(a, protocol.scope()).into()),
            ("digestSchema", key(a, "native-projection-v3").into()), ("native", native)] {
            define(a, snapshot, name, value);
        }
        define(a, bridge, "snapshot", snapshot.into()); define(a, tx, "snapshot", snapshot.into());
        let pending = object(a); define(a, pending, "snapshot", snapshot.into()); define(a, pending, "native", native);
        define(a, bridge, "snapshotReceiptPending", pending.into());
        op(a, owner, protocol, "leave", args[0], args[1], args[2], Some("commit"))?;
        Ok(HostValue::Object(committed).into_avm1(a))
    })
}
fn full_commit<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    commit_body(a, owner, args, FixtureProtocol::Full)
}
fn compact_commit<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    commit_body(a, owner, args, FixtureProtocol::Compact)
}
fn active_protocol<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>) -> FixtureProtocol {
    if matches!(stored(a, owner, FixtureProtocol::Compact.tx()), Value::Object(_)) { FixtureProtocol::Compact } else { FixtureProtocol::Full }
}
fn info<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    full_tests::record("gc_info"); Player::run_actions(a.context);
    let protocol = active_protocol(a, owner);
    Ok(host(&[("version", 1.0.into()), ("engine", "original-swf".into()), ("state", "playing".into()),
        ("tick", f64::from(protocol.tick()).into()), ("snapshotReceiptVersion", 1.0.into()),
        ("stagedStepVersion", 1.0.into()), ("compactStepVersion", 1.0.into())]).into_avm1(a))
}
fn receipt_version<'gc>(a: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    assert!(a.context.external_interface.step_fence.frozen());
    full_tests::record("gc_serialized_fenced"); Player::run_actions(a.context);
    // The AS2-shaped lease was already removed; the still-pinned owner and
    // bridge snapshot/presentation remain real GC references until conversion.
    let owner = owner(a.context); let bridge = as_object(stored(a, owner, "mBH"));
    assert!(matches!(stored(a, bridge, "snapshot"), Value::Object(_)));
    assert_eq!(stored(a, owner, FixtureProtocol::Full.tx()), Value::Undefined);
    assert_eq!(stored(a, owner, FixtureProtocol::Compact.tx()), Value::Undefined);
    Ok(1.0.into())
}
fn receipt_body<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: FixtureProtocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(a, owner, protocol, "receipt", |a| {
        full_tests::record("gc_receipt");
        let tx = as_object(stored(a, owner, protocol.tx())); let bridge = as_object(stored(a, tx, "bridge"));
        let snapshot = as_object(stored(a, tx, "snapshot")); let pending = as_object(stored(a, bridge, "snapshotReceiptPending"));
        assert_eq!(stored(a, bridge, "snapshot"), snapshot.into());
        assert_eq!(stored(a, pending, "snapshot"), snapshot.into());
        assert_eq!(stored(a, pending, "native"), stored(a, snapshot, "native"));
        let mut header = BTreeMap::new();
        for name in ["version", "engine", "state", "scope", "digestSchema", "tick", "digest", "players", "rng", "profile", "snapshotBytes", "snapshotObjects", "snapshotFields"] {
            let value = stored(a, snapshot, name);
            header.insert(name.into(), HostValue::from_avm1(a, value).unwrap());
        }
        let result = host(&[("version", 1.0.into()), ("token", "gc_token".into()), ("epoch", 1.0.into()),
            ("tick", f64::from(protocol.tick()).into()), ("scope", protocol.scope().to_owned().into()),
            ("header", HostValue::Object(header))]);
        op(a, owner, protocol, "finish", args[0], args[1], args[2], None)?;
        assert!(bridge.delete(a, key(a, "snapshotReceiptPending")));
        assert!(owner.delete(a, key(a, protocol.tx())));
        let result = as_object(result.into_avm1(a));
        result.add_property(a.gc(), key(a, "version"), function(a, receipt_version), None, Attribute::empty());
        Ok(result.into())
    })
}
fn full_receipt<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    receipt_body(a, owner, args, FixtureProtocol::Full)
}
fn compact_receipt<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    receipt_body(a, owner, args, FixtureProtocol::Compact)
}
fn receipt_dispatch<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    let protocol = active_protocol(a, owner); receipt_body(a, owner, args, protocol)
}
fn present<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    full_tests::record("gc_present"); Player::run_actions(a.context);
    let bridge = as_object(stored(a, owner, "mBH")); let p = as_object(stored(a, bridge, "presentation"));
    let commands = as_object(stored(a, p, "commands")); let command = as_object(commands.get_element(a, 0));
    let display = as_object(stored(a, command, "display"));
    let NativeObject::BitmapData(bitmap) = display.native() else { panic!("retained native bitmap"); };
    assert_eq!(bitmap_operations::get_pixel32(bitmap, a.context.renderer, 0, 0), 0xff0d47d1);
    let geometry = as_object(stored(a, command, "geometry"));
    assert_eq!(stored(a, geometry, "tx"), 12.5.into());
    let protocol = active_protocol(a, owner);
    Ok(host(&[("version", 1.0.into()), ("tick", f64::from(protocol.tick()).into()), ("rendered", true.into())]).into_avm1(a))
}
fn cleanup<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    full_tests::record("gc_cleanup");
    for name in [FixtureProtocol::Full.tx(), FixtureProtocol::Compact.tx()] { owner.delete(a, key(a, name)); }
    let bridge = as_object(stored(a, owner, "mBH")); bridge.delete(a, key(a, "snapshotReceiptPending"));
    Ok(true.into())
}
fn abort_body<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>], protocol: FixtureProtocol) -> Result<Value<'gc>, Error<'gc>> {
    with_body(a, owner, protocol, "abort", |a| {
        op(a, owner, protocol, "abort", args[0], args[1], args[2], None)?;
        Ok(host(&[("error", "GC fixture abort".into())]).into_avm1(a))
    })
}
fn full_abort<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> { abort_body(a, owner, args, FixtureProtocol::Full) }
fn compact_abort<'gc>(a: &mut Activation<'_, 'gc>, owner: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> { abort_body(a, owner, args, FixtureProtocol::Compact) }

fn graph_fixture() -> Arc<Mutex<Player>> {
    full_tests::clear_trace();
    let player = PlayerBuilder::new().with_movie(SwfMovie::empty(8, None)).with_autoplay(true).with_frame_rate(Some(25.0)).build();
    player.lock().unwrap().mutate_with_update_context(|context| {
        let clip = context.stage.root_clip().unwrap();
        let mut a = Activation::from_nothing(context, ActivationIdentifier::root("[GC fixture install]"), clip);
        let owner = object(&a); let world = object(&a); let bridge = object(&a);
        define(&a, owner, "mcWorld", world.into()); define(&a, owner, "mBH", bridge.into());
        for (name, callback) in [("BH_StagedFencePoison", cleanup as NativeFunction), ("BH_CompactFencePoison", cleanup),
            ("BH_SkipField", project_policy), ("BH_ProcessName", process_name), ("BH_Project", forbidden_project), ("ambientAction", ambient)] {
            define(&a, owner, name, function(&a, callback).into());
        }
        let cache = Object::new_without_proto(a.gc()); define(&a, owner, "mBHFieldCache", cache.into());
        let global = a.global_object(); define(&a, global, "CMain", owner.into());
        for (name, body, callback) in [
            ("bhStepBegin", Some("BH_StagedStepBegin"), full_begin as NativeFunction),
            ("bhStepPrepare", Some("BH_StagedStepPrepare"), prepare),
            ("bhStepProject", Some("BH_StagedStepProject"), project),
            ("bhStepCommit", Some("BH_StagedStepCommit"), full_commit),
            ("bhInfo", None, info), ("bhStateReceipt", None, receipt_dispatch), ("bhPresent", None, present),
            ("bhStepAbort", Some("BH_StagedStepAbort"), full_abort),
            ("bhFrameBegin", Some("BH_CompactFrameBegin"), compact_begin),
            ("bhFrameCommit", Some("BH_CompactFrameCommit"), compact_commit),
            ("bhFrameAbort", Some("BH_CompactFrameAbort"), compact_abort),
        ] {
            let method = function(&a, callback);
            if let Some(body) = body { define(&a, owner, body, method.into()); }
            a.context.external_interface.add_callback(name.into(), Callback::Avm1 { this: owner.into(), method });
        }
        define(&a, owner, "BH_StagedStateReceipt", function(&a, full_receipt).into());
        define(&a, owner, "BH_CompactStateReceipt", function(&a, compact_receipt).into());
        let args = [key(&a, "install").into(), owner.into()];
        assert_eq!(native_fence::call(&mut a, owner, &args).unwrap(), Value::Bool(true));
        assert_eq!(native_fence::call_compact(&mut a, owner, &args).unwrap(), Value::Bool(true));
    });
    player
}
fn phase(player: &mut Player, protocol: FixtureProtocol, name: &str) -> HostValue {
    let args = if name == "bhInfo" { vec![] } else { vec!["gc_token".into(), 1.0.into(), f64::from(protocol.tick()).into()] };
    let value = player.call_internal_interface(name, args);
    assert!(!full_tests::is_error(&value), "{name}: {value:?}"); value
}
fn saved_native(player: &mut Player) -> HostValue {
    inspect(player, |a, owner| {
        let bridge = as_object(stored(a, owner, "mBH")); let snapshot = as_object(stored(a, bridge, "snapshot"));
        let native = stored(a, snapshot, "native"); HostValue::from_avm1(a, native).unwrap()
    })
}
fn exercise_graph(protocol: FixtureProtocol, force: bool) -> (Vec<HostValue>, HostValue, Vec<String>) {
    let handle = graph_fixture(); let mut player = handle.lock().unwrap();
    if force { before_mutation(&mut player); }
    let begun = player.call_internal_interface(protocol.begin_name(), vec![f64::from(protocol.tick()).into(), 0.0.into(), 0.0.into(), HostValue::Undefined, "gc_token".into()]);
    assert!(!full_tests::is_error(&begun)); let mut returned = vec![begun];
    let tx = protocol.tx();
    let live_paths: &[&[&str]] = &[&[], &["mcWorld"], &[tx], &[tx, "world"], &["mcWorld", "alpha"],
        &["mBH", "presentation"], &["mBH", "presentation", "commands", "0", "display"],
        &["mBH", "presentation", "commands", "0", "geometry"]];
    if force { collect_live(&mut player, live_paths); }
    let steps: &[&str] = if protocol == FixtureProtocol::Full { &["bhStepPrepare", "bhStepProject", "bhStepCommit"] } else { &["bhFrameCommit"] };
    let mut retired = None;
    for name in steps {
        if force { before_mutation(&mut player); }
        let presented = player.call_internal_interface("bhPresent", vec![0.5.into()]);
        assert!(!full_tests::is_error(&presented)); returned.push(presented);
        if force { collect_live(&mut player, live_paths); before_mutation(&mut player); }
        returned.push(phase(&mut player, protocol, name));
        if force {
            match *name {
                "bhStepPrepare" => collect_live(&mut player, &[&[tx, "context"], &[tx, "context", "objects"], &[tx, "root"]]),
                "bhStepProject" => {
                    collect_live(&mut player, &[&[tx, "nativeState"], &[tx, "context", "objects"], &[tx, "root"]]);
                    retired = Some(weak_paths(&mut player, &[&[tx, "context"], &[tx, "root"]]));
                }
                _ => {
                    collect_live(&mut player, &[&[tx, "snapshot"], &["mBH", "snapshot"], &["mBH", "snapshotReceiptPending"], &["mBH", "snapshot", "native"]]);
                    if let Some(retired) = &retired { assert_eq!(alive(&player, retired), vec![false, false, false]); }
                }
            }
        }
    }
    let native = saved_native(&mut player);
    let HostValue::Object(native_fields) = &native else { panic!("native fixture state"); };
    if protocol == FixtureProtocol::Full {
        let HostValue::Object(world) = &native_fields["world"] else { panic!("projected world"); };
        let HostValue::Object(child) = &world["alpha"] else { panic!("projected child"); };
        assert_eq!(child["label"], HostValue::String("GC-\u{1f642}-\u{03a9}".into()));
        let HostValue::Number(zero) = child["number"] else { panic!("projected zero"); };
        assert_eq!(zero.to_bits(), (-0.0_f64).to_bits());
        assert_eq!(child["back"], host(&[("$ref", 1.0.into())]));
        assert_eq!(world["zeta"], host(&[("$ref", 2.0.into())]));
    } else {
        assert_eq!(native_fields["positions"], HostValue::List(vec![12.5.into(), (-3.25).into()]));
    }
    let receipt_roots = weak_paths(&mut player, &[&[tx], &["mBH", "snapshotReceiptPending"], &["mBH", "snapshot", "native"]]);
    if force { collect_live(&mut player, &[&[tx, "snapshot"], &["mBH", "snapshotReceiptPending"], &["mBH", "snapshot", "native"]]); }
    returned.push(phase(&mut player, protocol, "bhInfo"));
    if force { collect_live(&mut player, &[&[tx, "snapshot"], &["mBH", "snapshotReceiptPending"], &["mBH", "snapshot", "native"]]); }
    returned.push(phase(&mut player, protocol, "bhStateReceipt"));
    assert!(!player.boxhead_frozen()); assert!(!player.boxhead_poisoned());
    assert!(!full_tests::trace().iter().any(|name| name == "gc_ambient"));
    collect(&mut player);
    assert_eq!(alive(&player, &receipt_roots), vec![false, false, true, false]);
    assert_eq!(saved_native(&mut player), native);
    inspect(&mut player, |a, owner| {
        let world = as_object(stored(a, owner, "mcWorld"));
        let child = as_object(stored(a, world, "alpha"));
        assert_eq!(stored(a, world, "zeta"), child.into()); assert_eq!(stored(a, child, "back"), world.into());
        let Value::Number(zero) = stored(a, child, "number") else { panic!("number"); };
        assert_eq!(zero.to_bits(), (-0.0_f64).to_bits());
        assert_eq!(stored(a, world, "__bhSnapshotRef"), Value::Undefined);
        assert_eq!(stored(a, child, "__bhSnapshotRef"), Value::Undefined);
        let bridge = as_object(stored(a, owner, "mBH")); assert!(bridge.delete(a, key(a, "snapshot")));
    });
    collect(&mut player);
    assert_eq!(alive(&player, &receipt_roots), vec![false, false, false, false]);
    player.tick(FloatDuration::ZERO);
    assert_eq!(full_tests::trace().iter().filter(|name| name.as_str() == "gc_ambient").count(), 1);
    (returned, native, full_tests::trace())
}

#[test]
fn gc_fence_full_projected_graph_bitmap_and_receipt_survive_each_real_collection() {
    assert_eq!(exercise_graph(FixtureProtocol::Full, true), exercise_graph(FixtureProtocol::Full, false));
}

#[test]
fn gc_fence_compact_frame_bitmap_and_receipt_survive_each_real_collection() {
    assert_eq!(exercise_graph(FixtureProtocol::Compact, true), exercise_graph(FixtureProtocol::Compact, false));
}

#[test]
fn gc_fence_transaction_world_is_rooted_after_owner_replacement_until_poison_cleanup() {
    for compact in [false, true] {
        let handle = if compact { compact_tests::fixture("") } else { full_tests::fixture("") };
        let mut player = handle.lock().unwrap();
        let result = if compact { compact_tests::begin(&mut player, 26) } else { full_tests::begin(&mut player) };
        assert!(!full_tests::is_error(&result));
        let old = weak_paths(&mut player, &[&["mcWorld"]]);
        inspect(&mut player, |a, owner| define(a, owner, "mcWorld", object(a).into()));
        collect(&mut player);
        assert_eq!(alive(&player, &old), vec![true, false], "the actual Transaction.world is its last strong root");
        let result = if compact { compact_tests::phase(&mut player, "bhFrameCommit", 26, 1) } else { full_tests::phase(&mut player, "bhStepPrepare") };
        assert!(full_tests::is_error(&result)); assert!(player.boxhead_poisoned());
        collect(&mut player); assert_eq!(alive(&player, &old), vec![false, false]);
        let name = if compact { "compact_cleanup" } else { "cleanup" };
        assert_eq!(full_tests::trace().iter().filter(|value| value.as_str() == name).count(), 1);
    }
}

#[test]
fn gc_fence_installed_owner_and_pinned_callbacks_survive_removed_public_registrations() {
    let handle = full_tests::fixture(""); let mut player = handle.lock().unwrap();
    // This full fixture has no global owner root and no queued action yet.
    let witnesses = weak_paths(&mut player, &[&[], &["BH_StagedStepBegin"], &["BH_StagedFencePoison"]]);
    player.enter_arena_mut(|_, root, _| {
        for name in ["bhStepBegin", "bhStepPrepare", "bhStepProject", "bhStepCommit", "bhInfo", "bhStateReceipt", "bhPresent", "bhStepAbort"] {
            root.external_interface.remove_callback(name.into());
        }
    });
    collect(&mut player);
    assert_eq!(alive(&player, &witnesses), vec![true, true, true, false]);
    assert!(!player.boxhead_poisoned());
    assert!(full_tests::is_error(&full_tests::begin(&mut player)));
    assert!(player.boxhead_poisoned());
    collect(&mut player);
    assert_eq!(alive(&player, &witnesses), vec![true, true, true, false]);
    assert_eq!(full_tests::trace(), ["cleanup"]);
}

#[test]
fn gc_fence_collections_do_not_release_or_reorder_the_actual_deferred_fifo() {
    for compact in [false, true] {
        let handle = if compact { compact_tests::fixture("") } else { full_tests::fixture("") };
        let mut player = handle.lock().unwrap();
        let result = if compact { compact_tests::begin(&mut player, 26) } else { full_tests::begin(&mut player) };
        assert!(!full_tests::is_error(&result));
        player.set_viewport_dimensions(ViewportDimensions { width: 801, height: 601, scale_factor: 1.0 });
        player.set_is_playing(false); player.set_is_playing(true);
        player.set_viewport_dimensions(ViewportDimensions { width: 802, height: 602, scale_factor: 1.0 });
        assert_eq!(player.boxhead_deferred.entries.len(), 4);
        collect_live(&mut player, &[&[], &["mcWorld"]]);
        if !compact {
            for name in ["bhStepPrepare", "bhStepProject"] {
                assert!(!full_tests::is_error(&full_tests::phase(&mut player, name)));
                collect_live(&mut player, &[&[], &["mcWorld"]]);
            }
        }
        let phases = [if compact { "bhFrameCommit" } else { "bhStepCommit" }, "bhInfo", "bhStateReceipt"];
        for name in phases {
            let result = if compact { compact_tests::phase(&mut player, name, 26, 1) } else { full_tests::phase(&mut player, name) };
            assert!(!full_tests::is_error(&result)); collect_live(&mut player, &[&[], &["mcWorld"]]);
        }
        let queued: Vec<_> = player.boxhead_deferred.entries.iter().map(|entry| match entry {
            Entry::Viewport(dimensions) => format!("viewport:{}", dimensions.width),
            Entry::RunState(_) => "run-state".into(), _ => panic!("unexpected FIFO entry"),
        }).collect();
        assert_eq!(queued, ["viewport:801", "run-state", "run-state", "viewport:802"]);
        assert!(!full_tests::trace().iter().any(|value| value == "ambient_action"));
        player.tick(FloatDuration::ZERO);
        assert!(player.boxhead_deferred.entries.is_empty()); assert_eq!(player.viewport_dimensions().width, 802);
        assert!(player.is_playing()); assert!(!player.boxhead_poisoned());
        assert_eq!(full_tests::trace().iter().filter(|value| value.as_str() == "ambient_action").count(), 1);
    }
}

#[test]
fn gc_fence_serialization_reentry_stays_poisoned_after_real_collection() {
    for compact in [false, true] {
        let handle = if compact { compact_tests::fixture("receipt_reentry") } else { full_tests::fixture("receipt_reentry") };
        let mut player = handle.lock().unwrap();
        let begun = if compact { compact_tests::begin(&mut player, 26) } else { full_tests::begin(&mut player) };
        assert!(!full_tests::is_error(&begun)); collect_live(&mut player, &[&[], &["mcWorld"]]);
        if !compact {
            for name in ["bhStepPrepare", "bhStepProject"] {
                assert!(!full_tests::is_error(&full_tests::phase(&mut player, name))); collect(&mut player);
            }
        }
        for name in [if compact { "bhFrameCommit" } else { "bhStepCommit" }, "bhInfo"] {
            let value = if compact { compact_tests::phase(&mut player, name, 26, 1) } else { full_tests::phase(&mut player, name) };
            assert!(!full_tests::is_error(&value)); collect(&mut player);
        }
        let receipt = if compact { compact_tests::phase(&mut player, "bhStateReceipt", 26, 1) } else { full_tests::phase(&mut player, "bhStateReceipt") };
        assert!(full_tests::is_error(&receipt)); assert!(player.boxhead_poisoned());
        collect(&mut player);
        assert!(full_tests::trace().iter().any(|value| value == "caught_reentry"));
        assert!(full_tests::is_error(&player.call_internal_interface("bhInfo", vec![])));
        assert!(full_tests::is_error(&player.call_internal_interface("bhStateReceipt", if compact { compact_tests::tuple(26, 1) } else { full_tests::tuple() })));
        collect(&mut player);
        let cleanup = if compact { "compact_cleanup" } else { "cleanup" };
        assert_eq!(full_tests::trace().iter().filter(|value| value.as_str() == cleanup).count(), 1);
        assert!(!full_tests::trace().iter().any(|value| value == "ambient_action"));
    }
}

#[test]
fn gc_fence_abort_and_malformed_receipt_never_gain_a_valid_receipt_after_collection() {
    for (compact, abort) in [(false, true), (true, true), (false, false), (true, false)] {
        let fault = if abort { "" } else if compact { "receipt_wrong_header" } else { "receipt_malformed" };
        let handle = if compact { compact_tests::fixture(fault) } else { full_tests::fixture(fault) };
        let mut player = handle.lock().unwrap();
        let begun = if compact { compact_tests::begin(&mut player, 26) } else { full_tests::begin(&mut player) };
        assert!(!full_tests::is_error(&begun)); collect(&mut player);
        let failure = if abort {
            if compact { compact_tests::phase(&mut player, "bhFrameAbort", 26, 1) } else { full_tests::phase(&mut player, "bhStepAbort") }
        } else if compact { compact_tests::finish(&mut player, 26, 1) } else { full_tests::complete_to_receipt(&mut player) };
        assert!(full_tests::is_error(&failure)); collect(&mut player);
        assert!(player.boxhead_poisoned());
        player.tick(FloatDuration::ZERO); collect(&mut player);
        assert!(!full_tests::trace().iter().any(|value| value == "ambient_action"));
        let name = if compact { "compact_cleanup" } else { "cleanup" };
        assert_eq!(full_tests::trace().iter().filter(|value| value.as_str() == name).count(), 1);
    }
}
