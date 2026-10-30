//! Private VM fence for one authenticated Boxhead full or compact tick.
//!
//! This is neither Player::pause nor a second simulation clock. Player keeps
//! rendering, while its ambient VM entries are retained in arrival order.
//! Only the pinned bridge callbacks below may enter until the real receipt has
//! returned through ExternalInterface's complete AVM1-to-host serialization.
//! A poisoned transaction is never resumed; its Player must be destroyed.

use crate::avm1::{Activation, ActivationIdentifier, Attribute, Error, Object, Value};
use crate::context::UpdateContext;
use crate::display_object::TDisplayObject;
use crate::external::{Callback, Value as HostValue};
use crate::string::AvmString;
use gc_arena::Collect;
use std::collections::BTreeMap;

const MAX_INTEGER: u32 = 2_147_483_647;
const CALLBACK_NAMES: [&str; 8] = [
    "bhStepBegin", "bhStepPrepare", "bhStepProject", "bhStepCommit",
    "bhInfo", "bhStateReceipt", "bhPresent", "bhStepAbort",
];
// These are materialized as own stored properties by the reviewed bridge at
// install. Checking Activation.callee distinguishes a phase body from a getter
// or a prototype setter running inside the same ExternalInterface invocation.
const BODY_NAMES: [&str; 6] = [
    "BH_StagedStepBegin", "BH_StagedStepPrepare", "BH_StagedStepProject", "BH_StagedStepCommit",
    "BH_StagedStateReceipt", "BH_StagedStepAbort",
];
const CLEANUP_NAME: &str = "BH_StagedFencePoison";
const COMPACT_CALLBACK_NAMES: [&str; 6] = [
    "bhFrameBegin", "bhFrameCommit", "bhInfo", "bhStateReceipt", "bhPresent", "bhFrameAbort",
];
const COMPACT_BODY_NAMES: [&str; 4] = [
    "BH_CompactFrameBegin", "BH_CompactFrameCommit", "BH_CompactStateReceipt", "BH_CompactFrameAbort",
];
const COMPACT_CLEANUP_NAME: &str = "BH_CompactFencePoison";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protocol { FullV1, CompactV1 }

impl Protocol {
    fn callback_names(self) -> &'static [&'static str] {
        match self { Self::FullV1 => &CALLBACK_NAMES, Self::CompactV1 => &COMPACT_CALLBACK_NAMES }
    }

    fn body_names(self) -> &'static [&'static str] {
        match self { Self::FullV1 => &BODY_NAMES, Self::CompactV1 => &COMPACT_BODY_NAMES }
    }

    fn cleanup_name(self) -> &'static str {
        match self { Self::FullV1 => CLEANUP_NAME, Self::CompactV1 => COMPACT_CLEANUP_NAME }
    }

    fn kind(self, name: &str) -> Option<Kind> {
        match self {
            Self::FullV1 => Kind::from_name(name),
            Self::CompactV1 => Some(match name {
                "bhFrameBegin" => Kind::Begin, "bhFrameCommit" => Kind::Commit,
                "bhInfo" => Kind::Info, "bhStateReceipt" => Kind::Receipt,
                "bhPresent" => Kind::Present, "bhFrameAbort" => Kind::Abort,
                _ => return None,
            }),
        }
    }

    fn callback_index(self, kind: Kind) -> Option<usize> {
        match self {
            Self::FullV1 => Some(kind.index()),
            Self::CompactV1 => Some(match kind {
                Kind::Begin => 0, Kind::Commit => 1, Kind::Info => 2,
                Kind::Receipt => 3, Kind::Present => 4, Kind::Abort => 5,
                _ => return None,
            }),
        }
    }

    fn body_index(self, kind: Kind) -> Option<usize> {
        match self {
            Self::FullV1 => kind.body_index(),
            Self::CompactV1 => Some(match kind {
                Kind::Begin => 0, Kind::Commit => 1, Kind::Receipt => 2, Kind::Abort => 3,
                _ => return None,
            }),
        }
    }

    fn next(self, kind: Kind) -> Option<Kind> {
        match self {
            Self::FullV1 => kind.next(),
            Self::CompactV1 => match kind {
                Kind::Begin => Some(Kind::Commit), Kind::Commit => Some(Kind::Info),
                Kind::Info => Some(Kind::Receipt), _ => None,
            },
        }
    }

    fn scope(self) -> &'static str {
        match self { Self::FullV1 => "full", Self::CompactV1 => "frame" }
    }

    fn accepts_tick(self, tick: u32) -> bool {
        // The existing full ABI is unchanged; its reviewed AS2 body enforces
        // full-tick cadence. Compact cannot impersonate a full checkpoint.
        self == Self::FullV1 || tick % 25 != 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { Begin, Prepare, Project, Commit, Info, Receipt, Present, Abort }

impl Kind {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "bhStepBegin" => Self::Begin,
            "bhStepPrepare" => Self::Prepare,
            "bhStepProject" => Self::Project,
            "bhStepCommit" => Self::Commit,
            "bhInfo" => Self::Info,
            "bhStateReceipt" => Self::Receipt,
            "bhPresent" => Self::Present,
            "bhStepAbort" => Self::Abort,
            _ => return None,
        })
    }

    fn index(self) -> usize {
        match self {
            Self::Begin => 0, Self::Prepare => 1, Self::Project => 2, Self::Commit => 3,
            Self::Info => 4, Self::Receipt => 5, Self::Present => 6, Self::Abort => 7,
        }
    }

    fn body_index(self) -> Option<usize> {
        Some(match self {
            Self::Begin => 0, Self::Prepare => 1, Self::Project => 2,
            Self::Commit => 3, Self::Receipt => 4, Self::Abort => 5,
            _ => return None,
        })
    }

    fn phase(self) -> Option<&'static str> {
        match self {
            Self::Begin => Some("begin"), Self::Prepare => Some("prepare"),
            Self::Project => Some("project"), Self::Commit => Some("commit"),
            _ => None,
        }
    }

    fn next(self) -> Option<Self> {
        match self {
            Self::Begin => Some(Self::Prepare), Self::Prepare => Some(Self::Project),
            Self::Project => Some(Self::Commit), Self::Commit => Some(Self::Info),
            Self::Info => Some(Self::Receipt), _ => None,
        }
    }
}

#[derive(Collect, Clone)]
#[collect(no_drop)]
struct Installed<'gc> {
    #[collect(require_static)]
    protocol: Protocol,
    owner: Object<'gc>,
    callbacks: Vec<Callback<'gc>>,
    bodies: Vec<Object<'gc>>,
    cleanup: Object<'gc>,
}

#[derive(Collect)]
#[collect(no_drop)]
struct Transaction<'gc> {
    #[collect(require_static)]
    protocol: Protocol,
    world: Object<'gc>,
    #[collect(require_static)]
    token: String,
    epoch: u32,
    tick: u32,
    #[collect(require_static)]
    expected: Kind,
    #[collect(require_static)]
    commit: Option<BTreeMap<String, HostValue>>,
}

#[derive(Debug)]
struct Invocation {
    protocol: Protocol,
    kind: Kind,
    args: Vec<HostValue>,
    body_started: bool,
    body_returned: bool,
    entered: bool,
    left: bool,
    finished: bool,
}

#[derive(Collect, Default)]
#[collect(no_drop)]
pub(crate) struct StepFence<'gc> {
    installed: Option<Installed<'gc>>,
    compact_installed: Option<Installed<'gc>>,
    transaction: Option<Transaction<'gc>>,
    #[collect(require_static)]
    invocation: Option<Invocation>,
    external_depth: u32,
    ambient_depth: u32,
    last_epoch: u32,
    poisoned: bool,
    #[collect(require_static)]
    reason: Option<&'static str>,
    // Retain only the active protocol tag through an invalid Begin result.
    // Its cleanup still runs if no transaction was successfully established.
    #[collect(require_static)]
    cleanup_protocol: Option<Protocol>,
    cleanup_started: bool,
    cleanup_running: bool,
}

impl<'gc> StepFence<'gc> {
    fn installed_for(&self, protocol: Protocol) -> Option<&Installed<'gc>> {
        match protocol { Protocol::FullV1 => self.installed.as_ref(), Protocol::CompactV1 => self.compact_installed.as_ref() }
    }

    fn active_protocol(&self) -> Option<Protocol> {
        self.transaction.as_ref().map(|transaction| transaction.protocol)
            .or_else(|| self.invocation.as_ref().map(|invocation| invocation.protocol))
    }

    pub(crate) fn frozen(&self) -> bool {
        self.poisoned || self.transaction.is_some() || self.invocation.is_some()
    }

    pub(crate) fn poisoned(&self) -> bool { self.poisoned }

    /// The private installed owner roots all between-phase VM state. This
    /// read-only opt-in does not admit a callback or change the fence protocol.
    pub(crate) fn collection_enabled(&self) -> bool {
        self.installed.is_some() && !self.poisoned
    }

    pub(crate) fn needs_gate(&self, name: &str) -> bool {
        self.frozen() || (self.installed.is_some() && matches!(Kind::from_name(name),
            Some(Kind::Begin | Kind::Prepare | Kind::Project | Kind::Commit | Kind::Abort)))
            || (self.compact_installed.is_some() && matches!(Protocol::CompactV1.kind(name),
                Some(Kind::Begin | Kind::Commit | Kind::Abort)))
    }

    pub(crate) fn enter_plain(&mut self) {
        self.external_depth = self.external_depth.saturating_add(1);
    }

    pub(crate) fn leave_plain(&mut self) {
        self.external_depth = self.external_depth.saturating_sub(1);
    }

    pub(crate) fn enter_ambient(&mut self) { self.ambient_depth = self.ambient_depth.saturating_add(1); }
    pub(crate) fn leave_ambient(&mut self) { self.ambient_depth = self.ambient_depth.saturating_sub(1); }

    pub(crate) fn mark_body_started(&mut self) {
        if self.external_depth == 1 && let Some(invocation) = &mut self.invocation {
            invocation.body_started = true;
        }
    }

    pub(crate) fn mark_body_returned(&mut self) {
        if self.external_depth == 1 && let Some(invocation) = &mut self.invocation {
            invocation.body_returned = true;
        }
    }

    pub(crate) fn blocks_actions(&self) -> bool {
        if !self.frozen() { return false; }
        self.poisoned || self.cleanup_running || self.external_depth != 1
            || !self.invocation.as_ref().is_some_and(|invocation|
                matches!(invocation.kind, Kind::Begin | Kind::Prepare | Kind::Project | Kind::Commit)
                    && invocation.body_started && !invocation.body_returned
                    && invocation.entered && !invocation.left)
    }

    pub(crate) fn poison(&mut self, reason: &'static str) {
        self.poisoned = true;
        if self.reason.is_none() { self.reason = Some(reason); }
    }

    pub(crate) fn registration_changed(&mut self) {
        if self.frozen() { self.poison("callback registration changed while a tick was fenced"); }
    }
}

fn key<'gc>(activation: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), text)
}

fn raw<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: &str) -> Option<Value<'gc>> {
    let name = key(activation, name);
    if object.has_own_virtual(activation, name) { None } else { object.get_data(name, activation) }
}

fn object<'gc>(activation: &mut Activation<'_, 'gc>, value: Value<'gc>) -> Option<Object<'gc>> {
    let object = value.as_object(activation)?;
    if object.as_display_object_no_super().is_some_and(|display| display.avm1_removed() || display.avm1_pending_removal()) {
        None
    } else {
        Some(object)
    }
}

fn function<'gc>(activation: &mut Activation<'_, 'gc>, owner: Object<'gc>, name: &str) -> Option<Object<'gc>> {
    match raw(activation, owner, name)? {
        Value::Object(method) if method.as_function().is_some() => Some(method),
        _ => None,
    }
}

fn integer(value: &HostValue, min: u32, max: u32) -> Option<u32> {
    match value {
        HostValue::Number(value) if value.is_finite() && value.fract() == 0.0
            && *value >= f64::from(min) && *value <= f64::from(max) => Some(*value as u32),
        _ => None,
    }
}

fn native_integer(value: Value<'_>, min: u32, max: u32) -> Option<u32> {
    match value {
        Value::Number(value) => integer(&HostValue::Number(value), min, max),
        _ => None,
    }
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn token(value: &HostValue) -> Option<&str> {
    match value { HostValue::String(value) if valid_token(value) => Some(value), _ => None }
}

fn host_tuple(args: &[HostValue]) -> Option<(&str, u32, u32)> {
    if args.len() != 3 { return None; }
    Some((token(&args[0])?, integer(&args[1], 1, MAX_INTEGER)?, integer(&args[2], 1, MAX_INTEGER)?))
}

fn tuple_matches(transaction: &Transaction<'_>, args: &[HostValue]) -> bool {
    host_tuple(args).is_some_and(|(token, epoch, tick)|
        token == transaction.token && epoch == transaction.epoch && tick == transaction.tick)
}

fn begin_args(args: &[HostValue]) -> bool {
    if args.len() != 5 || integer(&args[0], 1, MAX_INTEGER).is_none()
        || integer(&args[1], 0, 131_071).is_none() || integer(&args[2], 0, 131_071).is_none()
        || token(&args[4]).is_none() { return false; }
    match &args[3] {
        HostValue::Undefined => true,
        HostValue::Object(join) => join.len() == 2
            && join.get("slot") == Some(&HostValue::Number(2.0))
            && join.get("character").and_then(|value| integer(value, 0, 3)).is_some(),
        _ => false,
    }
}

fn same_callback<'gc>(activation: &mut Activation<'_, 'gc>, actual: &Callback<'gc>, expected: &Callback<'gc>, owner: Object<'gc>) -> bool {
    match (actual, expected) {
        (Callback::Avm1 { this: actual_this, method: actual }, Callback::Avm1 { this: expected_this, method: expected }) =>
            Object::ptr_eq(*actual, *expected)
                && object(activation, *actual_this).is_some_and(|value| Object::ptr_eq(value, owner))
                && object(activation, *expected_this).is_some_and(|value| Object::ptr_eq(value, owner)),
        _ => false,
    }
}

fn pins_valid<'gc>(activation: &mut Activation<'_, 'gc>, pins: &Installed<'gc>) -> bool {
    for (index, name) in pins.protocol.callback_names().iter().copied().enumerate() {
        let Some(current) = activation.context.external_interface.get_callback(name) else { return false; };
        if !same_callback(activation, &current, &pins.callbacks[index], pins.owner) { return false; }
    }
    for (index, name) in pins.protocol.body_names().iter().copied().enumerate() {
        if function(activation, pins.owner, name).is_none_or(|current| !Object::ptr_eq(current, pins.bodies[index])) { return false; }
    }
    if !function(activation, pins.owner, pins.protocol.cleanup_name())
        .is_some_and(|current| Object::ptr_eq(current, pins.cleanup)) { return false; }
    if pins.protocol == Protocol::CompactV1 {
        let Some(full) = activation.context.external_interface.step_fence.installed.clone() else { return false; };
        Object::ptr_eq(full.owner, pins.owner) && pins_valid(activation, &full)
    } else { true }
}

fn world_valid<'gc>(activation: &mut Activation<'_, 'gc>, pins: &Installed<'gc>) -> bool {
    let Some(expected) = activation.context.external_interface.step_fence.transaction.as_ref().map(|transaction| transaction.world) else { return true; };
    raw(activation, pins.owner, "mcWorld").and_then(|value| object(activation, value))
        .is_some_and(|current| Object::ptr_eq(current, expected))
}

/// Called before argument conversion, on both normal and CURRENT_CONTEXT paths.
pub(crate) fn admit<'gc>(context: &mut UpdateContext<'gc>, callback: &Callback<'gc>, name: &str, args: Vec<HostValue>) -> bool {
    // An active protocol always wins over an incoming callback name. Mixing
    // families poisons the current owner; it never switches its transaction.
    let protocol = context.external_interface.step_fence.active_protocol().unwrap_or_else(|| {
        if matches!(Protocol::CompactV1.kind(name), Some(Kind::Begin | Kind::Commit | Kind::Abort)) {
            Protocol::CompactV1
        } else { Protocol::FullV1 }
    });
    let result = (|| {
        let fence = &context.external_interface.step_fence;
        if fence.poisoned || fence.external_depth != 0 || fence.ambient_depth != 0
            || fence.invocation.is_some() || fence.cleanup_running { return false; }
        let Some(kind) = protocol.kind(name) else { return false; };
        let Some(pins) = fence.installed_for(protocol).cloned() else { return false; };
        let Some(callback_index) = protocol.callback_index(kind) else { return false; };
        let Some(root) = context.stage.root_clip() else { return false; };
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[Boxhead fence gate]"), root);
        if !pins_valid(&mut activation, &pins) || !world_valid(&mut activation, &pins)
            || !same_callback(&mut activation, callback, &pins.callbacks[callback_index], pins.owner) { return false; }
        let fence = &mut activation.context.external_interface.step_fence;
        let valid = if let Some(transaction) = &fence.transaction {
            match kind {
                Kind::Present => (if protocol == Protocol::CompactV1 { transaction.expected == Kind::Commit }
                    else { matches!(transaction.expected, Kind::Prepare | Kind::Project | Kind::Commit) })
                    && args.len() == 1 && matches!(&args[0], HostValue::Number(alpha) if alpha.is_finite() && *alpha >= 0.0 && *alpha <= 1.0),
                Kind::Abort => tuple_matches(transaction, &args),
                Kind::Info => transaction.expected == kind && args.is_empty(),
                Kind::Begin => false,
                _ => transaction.expected == kind && tuple_matches(transaction, &args),
            }
        } else { kind == Kind::Begin && begin_args(&args)
            && args.first().and_then(|value| integer(value, 1, MAX_INTEGER)).is_some_and(|tick| protocol.accepts_tick(tick)) };
        if !valid { return false; }
        fence.external_depth = 1;
        fence.cleanup_protocol = Some(protocol);
        fence.invocation = Some(Invocation { protocol, kind, args, body_started: false, body_returned: false, entered: false, left: false, finished: false });
        true
    })();
    if !result {
        let fence = &mut context.external_interface.step_fence;
        if fence.active_protocol().is_none() && !fence.poisoned && fence.installed_for(protocol).is_some() {
            fence.cleanup_protocol = Some(protocol);
        }
        poison(context, "unauthorized, nested, stale, or reordered external callback");
    }
    result
}

fn map(value: &HostValue) -> Option<&BTreeMap<String, HostValue>> {
    match value { HostValue::Object(value) => Some(value), _ => None }
}

fn clean_result(value: &BTreeMap<String, HostValue>) -> bool {
    !value.contains_key("error") && value.get("state") != Some(&HostValue::String("error".into()))
}

fn rng_result(value: Option<&HostValue>) -> bool {
    let Some(value) = value.and_then(map) else { return false; };
    value.len() == 3
        && ["seed", "state"].iter().all(|name|
            value.get(*name).and_then(|value| integer(value, 0, u32::MAX)).is_some())
        && matches!(value.get("calls"), Some(HostValue::Number(calls))
            if calls.is_finite() && calls.fract() == 0.0 && *calls >= 0.0 && *calls <= 9_007_199_254_740_991.0)
}

fn result_valid(invocation: &Invocation, transaction: &Transaction<'_>, result: &HostValue) -> bool {
    if invocation.protocol != transaction.protocol { return false; }
    let Some(result) = map(result) else { return false; };
    if !clean_result(result) { return false; }
    let tick = HostValue::Number(f64::from(transaction.tick));
    match invocation.kind {
        Kind::Begin | Kind::Prepare | Kind::Project => {
            let phase = match invocation.kind { Kind::Begin => "begun", Kind::Prepare => "prepared", _ => "projected" };
            invocation.entered && invocation.left && result.len() == 5
                && result.get("version") == Some(&HostValue::Number(1.0))
                && result.get("phase") == Some(&HostValue::String(phase.into()))
                && result.get("token") == Some(&HostValue::String(transaction.token.clone()))
                && result.get("epoch") == Some(&HostValue::Number(f64::from(transaction.epoch)))
                && result.get("tick") == Some(&tick)
        }
        Kind::Commit => invocation.entered && invocation.left && result.get("tick") == Some(&tick)
            && matches!(result.get("digest"), Some(HostValue::String(value)) if !value.is_empty())
            && result.get("worldTick") == Some(&tick)
            && rng_result(result.get("rng"))
            && ["snapshotBytes", "snapshotObjects", "snapshotFields"].iter().all(|name|
                result.get(*name).and_then(|value| integer(value, 0, MAX_INTEGER)).is_some())
            && (transaction.protocol == Protocol::FullV1
                || ["snapshotObjects", "snapshotFields"].iter().all(|name| result.get(*name) == Some(&HostValue::Number(0.0)))),
        Kind::Info => result.get("version") == Some(&HostValue::Number(1.0))
            && result.get("engine") == Some(&HostValue::String("original-swf".into()))
            && result.get("state") == Some(&HostValue::String("playing".into()))
            && result.get("snapshotReceiptVersion") == Some(&HostValue::Number(1.0))
            && result.get("tick") == Some(&tick)
            && (transaction.protocol == Protocol::FullV1
                || ["stagedStepVersion", "compactStepVersion"].iter().all(|name| result.get(*name) == Some(&HostValue::Number(1.0)))),
        Kind::Receipt => {
            let Some(header) = result.get("header").and_then(map) else { return false; };
            let Some(commit) = &transaction.commit else { return false; };
            invocation.finished && result.len() == 6
                && result.get("version") == Some(&HostValue::Number(1.0))
                && result.get("token") == Some(&HostValue::String(transaction.token.clone()))
                && result.get("epoch") == Some(&HostValue::Number(f64::from(transaction.epoch)))
                && result.get("tick") == Some(&tick)
                && result.get("scope") == Some(&HostValue::String(transaction.protocol.scope().into()))
                && clean_result(header) && !header.contains_key("native") && !header.contains_key("entities")
                && header.get("version") == Some(&HostValue::Number(1.0))
                && header.get("engine") == Some(&HostValue::String("original-swf".into()))
                && header.get("state") == Some(&HostValue::String("playing".into()))
                && header.get("scope") == Some(&HostValue::String(transaction.protocol.scope().into()))
                && header.get("digestSchema") == Some(&HostValue::String("native-projection-v3".into()))
                && header.get("tick") == Some(&tick)
                && ["digest", "players", "rng", "profile", "snapshotBytes", "snapshotObjects", "snapshotFields"]
                    .iter().all(|name| header.get(*name) == commit.get(*name))
        }
        Kind::Present => result.get("tick") == Some(&tick) && matches!(result.get("rendered"), Some(HostValue::Bool(_))),
        Kind::Abort => false,
    }
}

/// Finish only after Value::from_avm1 has completely returned. Its getters can
/// attempt re-entry; caught rejection remains sticky and forbids this release.
pub(crate) fn complete<'gc>(context: &mut UpdateContext<'gc>, result: &HostValue) -> bool {
    let valid = (|| {
        let fence = &context.external_interface.step_fence;
        let Some(protocol) = fence.invocation.as_ref().map(|invocation| invocation.protocol) else { return false; };
        let Some(pins) = fence.installed_for(protocol).cloned() else { return false; };
        let Some(root) = context.stage.root_clip() else { return false; };
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[Boxhead fence return]"), root);
        if !pins_valid(&mut activation, &pins) || !world_valid(&mut activation, &pins) { return false; }
        let fence = &activation.context.external_interface.step_fence;
        !fence.poisoned && fence.external_depth == 1
            && fence.invocation.as_ref().zip(fence.transaction.as_ref())
                .is_some_and(|(invocation, transaction)| result_valid(invocation, transaction, result))
    })();
    let fence = &mut context.external_interface.step_fence;
    let invocation = fence.invocation.take();
    fence.external_depth = fence.external_depth.saturating_sub(1);
    if valid {
        let invocation = invocation.unwrap();
        let kind = invocation.kind;
        if kind == Kind::Receipt {
            // No run_actions, timer update, input dispatch or queue drain here.
            // JavaScript consumes this receipt and sends its ACK in this task.
            let transaction = fence.transaction.take().unwrap();
            fence.last_epoch = transaction.epoch;
            fence.cleanup_protocol = None;
        } else if kind != Kind::Present {
            let transaction = fence.transaction.as_mut().unwrap();
            transaction.expected = invocation.protocol.next(kind).unwrap();
            if kind == Kind::Commit { transaction.commit = map(result).cloned(); }
        }
        true
    } else {
        poison(context, "phase returned an error, malformed result, or changed identity");
        false
    }
}

pub(crate) fn failure(context: &UpdateContext<'_>) -> HostValue {
    let reason = context.external_interface.step_fence.reason.unwrap_or("staged tick fence failed");
    HostValue::Object(BTreeMap::from([
        ("version".into(), HostValue::Number(1.0)),
        ("engine".into(), HostValue::String("original-swf".into())),
        ("state".into(), HostValue::String("error".into())),
        ("error".into(), HostValue::String(format!("native staged tick fence: {reason}"))),
    ]))
}

pub(crate) fn poison(context: &mut UpdateContext<'_>, reason: &'static str) {
    context.external_interface.step_fence.poison(reason);
    if context.external_interface.step_fence.invocation.is_none() { cleanup(context); }
}

/// Pinned cleanup is the sole code admitted after poison. It has no route back
/// to a playing state and cannot dispatch another ExternalInterface callback.
fn cleanup(context: &mut UpdateContext<'_>) {
    let fence = &mut context.external_interface.step_fence;
    if fence.cleanup_started { return; }
    fence.cleanup_started = true;
    let protocol = fence.active_protocol().or(fence.cleanup_protocol).unwrap_or_else(|| {
        // An overlong argument iterator can fail before admit records a tag.
        // The optional compact cleanup closes both advertised abilities, so
        // an idle owner cannot retain a second usable entry after rejection.
        if fence.compact_installed.is_some() { Protocol::CompactV1 } else { Protocol::FullV1 }
    });
    let Some(pins) = fence.installed_for(protocol).or(fence.installed.as_ref()).cloned() else { return; };
    let reason = fence.reason.unwrap_or("staged tick aborted");
    fence.cleanup_running = true;
    if let Some(root) = context.stage.root_clip() {
        let mut activation = Activation::from_nothing(context, ActivationIdentifier::root("[Boxhead fence cleanup]"), root);
        let message = key(&activation, reason);
        let name = key(&activation, pins.protocol.cleanup_name());
        let result = pins.cleanup.call(name, &mut activation, pins.owner.into(), &[message.into()]);
        if !matches!(result, Ok(Value::Bool(true))) {
            tracing::error!("Boxhead staged tick cleanup failed; Player remains permanently poisoned");
        }
    }
    context.external_interface.step_fence.cleanup_running = false;
    // The callback cleans marker slots; the engine drops its retained world and
    // committed-header references even if the helper failed. No queue resumes.
    context.external_interface.step_fence.transaction = None;
}

fn rejected<'gc>(activation: &Activation<'_, 'gc>, reason: &str) -> Error<'gc> {
    Error::ThrownValue(key(activation, reason).into())
}

fn install<'gc>(activation: &mut Activation<'_, 'gc>, owner: Value<'gc>) -> Result<(), &'static str> {
    let fence = &activation.context.external_interface.step_fence;
    if fence.installed.is_some() || fence.external_depth != 0 || fence.frozen() { return Err("invalid or repeated fence install"); }
    let owner = object(activation, owner).ok_or("fence owner is not a live object")?;
    let cleanup = function(activation, owner, CLEANUP_NAME).ok_or("missing own cleanup function")?;
    let mut bodies = Vec::with_capacity(BODY_NAMES.len());
    for name in BODY_NAMES { bodies.push(function(activation, owner, name).ok_or("missing own phase function")?); }
    let mut callbacks = Vec::with_capacity(CALLBACK_NAMES.len());
    for name in CALLBACK_NAMES {
        let callback = activation.context.external_interface.get_callback(name).ok_or("missing pinned external callback")?;
        let Callback::Avm1 { this, method } = &callback else { return Err("fence callback is not AVM1"); };
        if method.as_function().is_none() || object(activation, *this).is_none_or(|this| !Object::ptr_eq(this, owner)) {
            return Err("fence callback receiver differs from owner");
        }
        callbacks.push(callback);
    }
    activation.context.external_interface.step_fence.installed = Some(Installed { protocol: Protocol::FullV1, owner, callbacks, bodies, cleanup });
    Ok(())
}

fn install_compact<'gc>(activation: &mut Activation<'_, 'gc>, owner: Value<'gc>) -> Result<(), &'static str> {
    let fence = &activation.context.external_interface.step_fence;
    if fence.compact_installed.is_some() || fence.external_depth != 0 || fence.frozen() {
        return Err("invalid or repeated compact fence install");
    }
    let full = fence.installed.clone().ok_or("compact fence requires the original full fence")?;
    let owner = object(activation, owner).ok_or("compact fence owner is not a live object")?;
    if !Object::ptr_eq(owner, full.owner) || !pins_valid(activation, &full) {
        return Err("compact fence must share the unchanged full fence owner");
    }
    let cleanup = function(activation, owner, COMPACT_CLEANUP_NAME).ok_or("missing own compact cleanup function")?;
    let mut bodies = Vec::with_capacity(COMPACT_BODY_NAMES.len());
    for name in COMPACT_BODY_NAMES {
        bodies.push(function(activation, owner, name).ok_or("missing own compact phase function")?);
    }
    let mut callbacks = Vec::with_capacity(COMPACT_CALLBACK_NAMES.len());
    for name in COMPACT_CALLBACK_NAMES {
        let callback = activation.context.external_interface.get_callback(name).ok_or("missing pinned compact external callback")?;
        let Callback::Avm1 { this, method } = &callback else { return Err("compact fence callback is not AVM1"); };
        if method.as_function().is_none() || object(activation, *this).is_none_or(|this| !Object::ptr_eq(this, owner)) {
            return Err("compact fence callback receiver differs from owner");
        }
        // These three public registrations remain the original full wrappers.
        // The receipt guard dispatches to the separately pinned compact body.
        if let Some(kind) = Kind::from_name(name) {
            if !same_callback(activation, &callback, &full.callbacks[kind.index()], owner) {
                return Err("compact fence replaced a shared full callback");
            }
        }
        callbacks.push(callback);
    }
    activation.context.external_interface.step_fence.compact_installed = Some(Installed {
        protocol: Protocol::CompactV1, owner, callbacks, bodies, cleanup,
    });
    Ok(())
}

fn operation<'gc>(activation: &mut Activation<'_, 'gc>, protocol: Protocol, operation: &str, args: &[Value<'gc>]) -> Result<(), &'static str> {
    if operation == "install" {
        if args.len() != 2 { return Err("invalid install argument count"); }
        return match protocol { Protocol::FullV1 => install(activation, args[1]), Protocol::CompactV1 => install_compact(activation, args[1]) };
    }
    let expected_len = if operation == "enter" || operation == "leave" { 6 } else { 5 };
    if args.len() != expected_len || !matches!(operation, "begin" | "enter" | "leave" | "finish" | "abort") {
        return Err("invalid native fence operation or arguments");
    }
    let Some(pins) = activation.context.external_interface.step_fence.installed_for(protocol).cloned() else { return Err("fence is not installed"); };
    let supplied_owner = object(activation, args[1]).ok_or("invalid fence owner")?;
    if !Object::ptr_eq(supplied_owner, pins.owner)
        || (operation != "abort" && (!pins_valid(activation, &pins) || !world_valid(activation, &pins))) {
        return Err("native fence owner, callback, or world identity changed");
    }
    let Value::String(supplied_token) = args[2] else { return Err("invalid fence token"); };
    let supplied_token = supplied_token.to_string();
    if !valid_token(&supplied_token) { return Err("invalid fence token"); }
    let epoch = native_integer(args[3], 1, MAX_INTEGER).ok_or("invalid fence epoch")?;
    let tick = native_integer(args[4], 1, MAX_INTEGER).ok_or("invalid fence tick")?;
    let phase = if args.len() == 6 {
        match args[5] { Value::String(value) => Some(value.to_string()), _ => return Err("invalid fence phase") }
    } else { None };
    let fence = &activation.context.external_interface.step_fence;
    let invocation = fence.invocation.as_ref().ok_or("native fence call outside authenticated callback")?;
    if invocation.protocol != protocol { return Err("native fence protocol differs from the authenticated callback"); }
    if fence.external_depth != 1 || !invocation.body_started || invocation.body_returned || fence.cleanup_running {
        return Err("native fence call during argument marshalling or reentry");
    }
    let body = protocol.body_index(invocation.kind).ok_or("callback cannot mutate the fence")?;
    if activation.callee.is_none_or(|callee| !Object::ptr_eq(callee, pins.bodies[body])) {
        return Err("native fence call was not made by the pinned phase body");
    }
    if fence.poisoned && operation != "abort" { return Err("native fence is permanently poisoned"); }
    if operation == "begin" {
        if invocation.kind != Kind::Begin || invocation.entered || fence.transaction.is_some()
            || invocation.args.get(4).and_then(token) != Some(supplied_token.as_str())
            || invocation.args.first().and_then(|value| integer(value, 1, MAX_INTEGER)) != Some(tick)
            || epoch <= fence.last_epoch || !protocol.accepts_tick(tick) {
            return Err("duplicate or mismatched native fence begin");
        }
        let world_value = raw(activation, pins.owner, "mcWorld").ok_or("missing own world identity")?;
        let world = object(activation, world_value).ok_or("world is not a live object")?;
        let fence = &mut activation.context.external_interface.step_fence;
        fence.transaction = Some(Transaction { protocol, world, token: supplied_token, epoch, tick, expected: Kind::Begin, commit: None });
        fence.invocation.as_mut().unwrap().entered = true;
        return Ok(());
    }
    let transaction = fence.transaction.as_ref().ok_or("native fence transaction is absent")?;
    if protocol != transaction.protocol || supplied_token != transaction.token || epoch != transaction.epoch || tick != transaction.tick {
        return Err("native fence token, epoch, or tick mismatch");
    }
    let fence = &mut activation.context.external_interface.step_fence;
    let invocation = fence.invocation.as_mut().unwrap();
    match operation {
        "enter" if matches!(invocation.kind, Kind::Prepare | Kind::Project | Kind::Commit)
            && phase.as_deref() == invocation.kind.phase() && !invocation.entered && !invocation.left => {
            invocation.entered = true;
        }
        "leave" if phase.as_deref() == invocation.kind.phase() && invocation.entered && !invocation.left => {
            invocation.left = true;
        }
        "finish" if invocation.kind == Kind::Receipt && !invocation.finished => {
            invocation.finished = true;
        }
        "abort" if matches!(invocation.kind, Kind::Begin | Kind::Prepare | Kind::Project | Kind::Commit | Kind::Receipt | Kind::Abort) => {
            fence.poison("authenticated staged tick abort");
            cleanup(activation.context);
        }
        _ => return Err("native fence phase transition is invalid"),
    }
    Ok(())
}

pub fn call<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    if let [Value::String(operation)] = args && operation.eq_with_case(b"capability", true) {
        let value = Object::new_without_proto(activation.gc());
        value.define_value(activation.gc(), key(activation, "version"), 1.0.into(), Attribute::empty());
        value.define_value(activation.gc(), key(activation, "contract"), key(activation, "bh-step-fence-v1").into(), Attribute::empty());
        return Ok(value.into());
    }
    let result = match args.first() {
        Some(Value::String(name)) => operation(activation, Protocol::FullV1, &name.to_string(), args),
        _ => Err("native fence operation must be a string"),
    };
    match result {
        Ok(()) => Ok(true.into()),
        Err(reason) => {
            poison(activation.context, reason);
            Err(rejected(activation, reason))
        }
    }
}

/// Optional compact ABI. A legacy full-only bridge never calls or installs it.
/// It shares the same owner, world fence, epoch and ambient FIFO; there is no
/// second transaction that could advance the world while a full tick is open.
pub fn call_compact<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    if let [Value::String(operation)] = args && operation.eq_with_case(b"capability", true) {
        let value = Object::new_without_proto(activation.gc());
        value.define_value(activation.gc(), key(activation, "version"), 1.0.into(), Attribute::empty());
        value.define_value(activation.gc(), key(activation, "contract"), key(activation, "bh-compact-step-fence-v1").into(), Attribute::empty());
        return Ok(value.into());
    }
    let result = match args.first() {
        Some(Value::String(name)) => operation(activation, Protocol::CompactV1, &name.to_string(), args),
        _ => Err("native compact fence operation must be a string"),
    };
    match result {
        Ok(()) => Ok(true.into()),
        Err(reason) => {
            poison(activation.context, reason);
            Err(rejected(activation, reason))
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
pub(crate) mod compact_tests;

// Weak-only collection witnesses from the Player test module. The original
// avm1 object module remains private and the release API is unchanged.
#[cfg(test)]
pub(crate) use crate::avm1::object::ObjectWeak as GcTestObjectWeak;
