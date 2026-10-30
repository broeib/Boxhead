//! Native execution of the complete CMain.BH_Project traversal.
//!
//! No game object, property value, enumeration or projected shape survives a
//! call. Source reads, ordinary writes, own-property calls, Array operations,
//! loose comparisons, String conversions and metadata retain their AS2 order.
//! The caller still owns the synchronous snapshot transaction, full-check
//! cadence, canonical graph digest, receipt publication and finally cleanup.

use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::ExecutionReason;
use crate::avm1::object::{BoxheadOwnProperty, NativeObject};
use crate::avm1::property::Attribute;
use crate::avm1::{Object, Value};
use crate::display_object::TDisplayObject;
use crate::string::AvmString;
pub(crate) mod lookup_names;
use lookup_names::{FixedName, FixedNames};

const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

/// Per-VM counters, containing no GC pointers or mutable world data.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct NativeProjectStats {
    calls: u64,
    completed: u64,
    unsupported: u64,
    nodes: u64,
    keys: u64,
    own_reads: u64,
}

fn bump(value: &mut u64) -> bool {
    if *value == MAX_COUNTER { false } else { *value += 1; true }
}

fn add_counter(value: &mut u64, delta: u64) -> bool {
    if delta > MAX_COUNTER - *value { false } else { *value += delta; true }
}

fn rejected<'gc>(activation: &Activation<'_, 'gc>, text: &str) -> Error<'gc> {
    Error::ThrownValue(AvmString::new_utf8(activation.gc(), text).into())
}

fn data<'gc>(activation: &Activation<'_, 'gc>, fields: &[(&str, Value<'gc>)]) -> Object<'gc> {
    let object = Object::new(&activation.context.strings, Some(activation.prototypes().object));
    for &(key, value) in fields {
        object.define_value(activation.gc(), AvmString::new_utf8(activation.gc(), key), value, Attribute::empty());
    }
    object
}

fn capability<'gc>(activation: &Activation<'_, 'gc>) -> Object<'gc> {
    let stats = activation.context.avm1.native_project_stats;
    data(activation, &[
        ("version", 1.0.into()),
        ("contract", AvmString::new_utf8(activation.gc(), "bh-native-project-v1").into()),
        ("calls", (stats.calls as f64).into()),
        ("completed", (stats.completed as f64).into()),
        ("unsupported", (stats.unsupported as f64).into()),
        ("nodes", (stats.nodes as f64).into()),
        ("keys", (stats.keys as f64).into()),
        ("ownReads", (stats.own_reads as f64).into()),
    ])
}

enum Stop<'gc> {
    Avm(Error<'gc>),
    Removed,
}

impl<'gc> From<Error<'gc>> for Stop<'gc> {
    fn from(value: Error<'gc>) -> Self { Self::Avm(value) }
}

type ResultAt<'gc, T> = Result<T, Stop<'gc>>;

/// Read an identity slot without invoking a getter, resolver, native property
/// or prototype lookup. A virtual property can retain a data value internally,
/// so rejecting it explicitly is required before get_local_stored.
fn own_identity<'gc>(activation: &mut Activation<'_, 'gc>, object: Object<'gc>, name: AvmString<'gc>) -> Option<Value<'gc>> {
    match object.boxhead_own_property(name, activation) {
        BoxheadOwnProperty::Stored(value) => Some(value),
        BoxheadOwnProperty::Missing => None,
        // Retain the old identity contract for every nonordinary/native or
        // virtual case. The descriptor observation above has no side effect.
        BoxheadOwnProperty::Special => {
            if object.has_own_virtual(activation, name) { None } else { object.get_local_stored(name, activation) }
        }
    }
}

fn unsupported<'gc>(activation: &mut Activation<'_, 'gc>) -> Result<Value<'gc>, Error<'gc>> {
    if !bump(&mut activation.context.avm1.native_project_stats.unsupported) {
        return Err(rejected(activation, "Native project witness overflow"));
    }
    Ok(Value::Bool(false))
}

pub fn call<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let Some(Value::String(operation)) = args.first() else {
        return Err(rejected(activation, "Native project operation must be a string"));
    };
    if operation.eq_with_case(b"capability", true) && args.len() == 1 {
        return Ok(capability(activation).into());
    }
    if !operation.eq_with_case(b"run", true) || args.len() != 4 {
        return Err(rejected(activation, "Invalid native project operation or argument count"));
    }
    if !bump(&mut activation.context.avm1.native_project_stats.calls) {
        return Err(rejected(activation, "Native project witness overflow"));
    }
    // Structural preflight only. In particular no accessor, enumeration,
    // valueOf, prototype resolution or script call can precede strict false.
    let supported = matches!(args[1], Value::Object(object)
        if matches!(object.native(), NativeObject::None | NativeObject::Array(_)))
        && matches!(args[2], Value::Object(object) if matches!(object.native(), NativeObject::None))
        && matches!(args[3], Value::Object(_));
    if !supported || args[1] == args[2] || args[2] == args[3] {
        return unsupported(activation);
    }

    let Value::Object(context) = args[2] else { unreachable!() };
    let scan_key = AvmString::new_utf8(activation.gc(), "projectionKernel");
    let scan_global_key = AvmString::new_utf8(activation.gc(), "boxheadNativeProjectionScanV1");
    let scan = own_identity(activation, context, scan_key);
    let global = activation.global_object();
    let registered_scan = own_identity(activation, global, scan_global_key);
    if scan != Some(Value::Undefined)
        && !(matches!(scan, Some(Value::Object(function)) if function.as_function().is_some()) && scan == registered_scan) {
        // Only the frozen scan-only implementation or its absence is covered
        // by this ABI. Custom scan callbacks, virtual slots and inherited
        // slots use the legacy path before any source reads.
        return unsupported(activation);
    }
    let owner_key = AvmString::new_utf8(activation.gc(), "nativeProjectOwner");
    let function_key = AvmString::new_utf8(activation.gc(), "nativeProjectFunction");
    let expected_owner = own_identity(activation, context, owner_key);
    let expected_function = own_identity(activation, context, function_key);
    if expected_owner != Some(args[3])
        || !matches!(expected_function, Some(Value::Object(function)) if function.as_function().is_some()) {
        return Err(rejected(activation, "Native project pinned-code contract is missing"));
    }
    let mut projector = Projector { activation, owner: args[3], context: args[2],
        expected_function: expected_function.unwrap(), expected_scan: scan.unwrap(), names: FixedNames::new() };
    projector.check_code()?;
    let root_path = projector.name(FixedName::Root);
    let projected = match projector.project(args[1], root_path.into(), 0) {
        Ok(value) => value,
        Err(Stop::Removed) => return Ok(Value::Undefined),
        Err(Stop::Avm(error)) => return Err(error),
    };
    if projector.activation.base_clip().avm1_removed() { return Ok(Value::Undefined); }
    projector.check_code()?;
    if !bump(&mut projector.activation.context.avm1.native_project_stats.completed) {
        return Err(rejected(projector.activation, "Native project witness overflow"));
    }
    Ok(data(projector.activation, &[("version", 1.0.into()), ("value", projected)]).into())
}

struct Projector<'a, 'context, 'gc> {
    activation: &'a mut Activation<'context, 'gc>,
    owner: Value<'gc>,
    context: Value<'gc>,
    expected_function: Value<'gc>,
    expected_scan: Value<'gc>,
    // A bounded lazy table of immutable fixed identifiers, indexed by enum.
    // Never source names, mutable values, shapes or lookup outcomes.
    names: FixedNames<'gc>,
}

impl<'gc> Projector<'_, '_, 'gc> {
    fn name(&mut self, name: FixedName) -> AvmString<'gc> {
        self.names.get(name, self.activation)
    }

    fn timeout(&self) -> ResultAt<'gc, ()> {
        if self.activation.context.update_start.elapsed() >= self.activation.context.max_execution_duration {
            Err(Error::ExecutionTimeout.into())
        } else { Ok(()) }
    }

    fn check_code(&mut self) -> Result<(), Error<'gc>> {
        let Value::Object(owner) = self.owner else { unreachable!() };
        let project_name = self.name(FixedName::BHProject);
        let class_name = self.name(FixedName::CMain);
        let scan_key = self.name(FixedName::ProjectionKernel);
        let scan_global_key = self.name(FixedName::BoxheadNativeProjectionScanV1);
        let Value::Object(context) = self.context else { unreachable!() };
        let global = self.activation.global_object();
        if own_identity(self.activation, owner, project_name) != Some(self.expected_function)
            || own_identity(self.activation, global, class_name) != Some(self.owner)
            || own_identity(self.activation, context, scan_key) != Some(self.expected_scan)
            || (self.expected_scan != Value::Undefined
                && own_identity(self.activation, global, scan_global_key) != Some(self.expected_scan)) {
            return Err(rejected(self.activation, "Native project pinned code changed during snapshot"));
        }
        Ok(())
    }

    fn after_call(&mut self) -> ResultAt<'gc, ()> {
        if self.activation.base_clip().avm1_removed() { return Err(Stop::Removed); }
        self.check_code()?;
        Ok(())
    }

    fn member(&mut self, value: Value<'gc>, key: Value<'gc>) -> ResultAt<'gc, Value<'gc>> {
        let key = key.coerce_to_string(self.activation)?;
        Ok(value.coerce_to_object_or_bare(self.activation)?.get(key, self.activation)?)
    }

    fn get(&mut self, value: Value<'gc>, name: FixedName) -> ResultAt<'gc, Value<'gc>> {
        if value == self.owner { self.check_code()?; }
        let name = self.name(name);
        self.member(value, name.into())
    }

    fn set_member(&mut self, value: Value<'gc>, key: Value<'gc>, field: Value<'gc>) -> ResultAt<'gc, ()> {
        let key = key.coerce_to_string(self.activation)?;
        value.coerce_to_object_or_bare(self.activation)?.set(key, field, self.activation)?;
        Ok(())
    }

    fn set(&mut self, value: Value<'gc>, name: FixedName, field: Value<'gc>) -> ResultAt<'gc, ()> {
        if value == self.owner { self.check_code()?; }
        let name = self.name(name);
        self.set_member(value, name.into(), field)
    }

    fn method(&mut self, receiver: Value<'gc>, name: FixedName, args: &[Value<'gc>]) -> ResultAt<'gc, Value<'gc>> {
        if receiver == self.owner { self.check_code()?; }
        // The null/undefined ActionCallMethod branch does not check removal.
        if matches!(receiver, Value::Null | Value::Undefined) { return Ok(Value::Undefined); }
        let name = self.name(name);
        let result = receiver.coerce_to_object_or_bare(self.activation)?.call_method(
            name, args, self.activation, ExecutionReason::FunctionCall,
        )?;
        self.after_call()?;
        Ok(result)
    }

    fn function(&mut self, name: FixedName, args: &[Value<'gc>]) -> ResultAt<'gc, Value<'gc>> {
        let name = self.name(name);
        let variable = self.activation.get_variable(name)?;
        let result = variable.call_with_default_this(
            self.activation.target_clip_or_root().object1_or_undef(), name, self.activation, args,
        )?;
        self.after_call()?;
        Ok(result)
    }

    fn construct(&mut self, name: FixedName) -> ResultAt<'gc, Value<'gc>> {
        let name = self.name(name);
        let constructor_value: Value<'gc> = self.activation.resolve(name)?.into();
        let result = constructor_value.coerce_to_object_or_bare(self.activation)?.construct(self.activation, &[])?;
        self.after_call()?;
        Ok(result)
    }

    fn string(&mut self, value: Value<'gc>) -> ResultAt<'gc, Value<'gc>> {
        // The pinned FFDec output lowers String(value) to ActionToString.
        // This does not look up global.String and has no call completion check.
        Ok(value.coerce_to_string(self.activation)?.into())
    }

    fn recurse(&mut self, value: Value<'gc>, path: Value<'gc>, depth: u32) -> ResultAt<'gc, Value<'gc>> {
        let projected = self.project(value, path, depth)?;
        // A recursive CMain.BH_Project call has a real ActionCallMethod
        // completion boundary even when its only side effect was a getter.
        self.after_call()?;
        Ok(projected)
    }

    fn literal(&mut self, fields: &[(FixedName, Value<'gc>)]) -> ResultAt<'gc, Value<'gc>> {
        // ActionInitObject resolves Object.prototype after evaluating all
        // property values, then pops name/value pairs in reverse source order.
        let object_name = self.name(FixedName::Object);
        let prototype = self.activation.resolve_prototype([object_name]);
        let output = Object::new(&self.activation.context.strings, prototype);
        for &(name, value) in fields.iter().rev() {
            let name = self.name(name);
            output.set(name, value, self.activation)?;
        }
        Ok(output.into())
    }

    fn tag(&mut self, name: FixedName, value: Value<'gc>) -> ResultAt<'gc, Value<'gc>> {
        self.literal(&[(name, value)])
    }

    fn loose(&mut self, left: Value<'gc>, right: Value<'gc>) -> ResultAt<'gc, bool> {
        Ok(left.abstract_eq(right, self.activation)?)
    }

    fn less(&mut self, left: Value<'gc>, right: Value<'gc>) -> ResultAt<'gc, bool> {
        Ok(left.abstract_lt(right, self.activation)?.as_bool(self.activation.swf_version()))
    }

    fn add(&mut self, left: Value<'gc>, right: Value<'gc>) -> ResultAt<'gc, Value<'gc>> {
        // ActionAdd2 converts the popped RHS to primitive before the LHS.
        let right = right.to_primitive(self.activation)?;
        let left = left.to_primitive(self.activation)?;
        Ok(match (right, left) {
            (Value::String(right), Value::String(left)) => AvmString::concat(self.activation.gc(), left, right).into(),
            (Value::String(right), left) => {
                let left = left.coerce_to_string(self.activation)?;
                AvmString::concat(self.activation.gc(), left, right).into()
            }
            (right, Value::String(left)) => {
                let right = right.coerce_to_string(self.activation)?;
                AvmString::concat(self.activation.gc(), left, right).into()
            }
            (right, left) => (left.coerce_to_f64(self.activation)? + right.coerce_to_f64(self.activation)?).into(),
        })
    }

    fn owns(&mut self, object: Value<'gc>, name: FixedName) -> ResultAt<'gc, bool> {
        let name = self.name(name);
        let result = self.method(object, FixedName::HasOwnProperty, &[name.into()])?;
        Ok(result.as_bool(self.activation.swf_version()))
    }

    fn fail<T>(&mut self, message: Value<'gc>) -> ResultAt<'gc, T> {
        let error_name = self.name(FixedName::Error);
        let constructor_value: Value<'gc> = self.activation.resolve(error_name)?.into();
        let error = constructor_value.coerce_to_object_or_bare(self.activation)?.construct(self.activation, &[message])?;
        self.after_call()?;
        Err(Error::ThrownValue(error).into())
    }

    fn defer(&mut self, keys: &mut Value<'gc>, key: Value<'gc>) -> ResultAt<'gc, ()> {
        if self.loose(*keys, Value::Undefined)? { *keys = self.construct(FixedName::Array)?; }
        self.method(*keys, FixedName::Push, &[key])?;
        Ok(())
    }

    fn frozen_scan_counters(&self) -> (u64, u64) {
        // A copied pair of numeric witnesses: no GC allocation, script lookup,
        // source access, callback, extra scan run, or counter mutation.
        self.activation.context.avm1.native_projection_scan_stats.work_counts()
    }

    fn invoke_frozen_scan(&mut self, value: Value<'gc>, output: Value<'gc>, cache: Value<'gc>, upgrades: bool) -> ResultAt<'gc, Value<'gc>> {
        let before = self.frozen_scan_counters();
        let operation = self.name(FixedName::Run);
        let Value::Object(kernel) = self.expected_scan else { unreachable!() };
        // Exactly the anonymous ActionCallMethod form generated for the local
        // projectionKernel variable, including its undefined `this` value.
        let result = kernel.call("[Anonymous]", self.activation, Value::Undefined,
            &[operation.into(), value, output, cache, self.owner, upgrades.into()]);
        let after = self.frozen_scan_counters();
        let (Some(keys), Some(reads)) = (after.0.checked_sub(before.0), after.1.checked_sub(before.1)) else {
            return Err(rejected(self.activation, "Frozen scan witness decreased").into());
        };
        // Inclusive delegated work, also on errors. Source callbacks may run
        // further frozen scans, so these witness counters are not graph size.
        let stats = &mut self.activation.context.avm1.native_project_stats;
        if !add_counter(&mut stats.keys, keys) || !add_counter(&mut stats.own_reads, reads) {
            return Err(rejected(self.activation, "Native project witness overflow").into());
        }
        let result = result?;
        self.after_call()?;
        Ok(result)
    }

    fn scan(&mut self, value: Value<'gc>, output: Value<'gc>, upgrades: bool) -> ResultAt<'gc, (Value<'gc>, Value<'gc>)> {
        let mut cache = self.get(self.owner, FixedName::MBHFieldCache)?;
        if matches!(cache, Value::Undefined) {
            cache = self.function(FixedName::Object, &[])?;
            self.set(self.owner, FixedName::MBHFieldCache, cache)?;
            self.set(self.owner, FixedName::MBHFieldCacheCount, 0.0.into())?;
        }
        // The production context enables the frozen v1 scanner. Its helper
        // calls, result validation and call-completion boundary are observable
        // AVM1 behavior and must not be replaced by the AS2 fallback loop.
        let scan_kernel = self.get(self.context, FixedName::ProjectionKernel)?;
        self.check_code()?;
        let (keys, scalar_fields) = if scan_kernel != Value::Undefined {
            let scanned = self.invoke_frozen_scan(value, output, cache, upgrades)?;
            if scanned != Value::Bool(false) {
                let kind = scanned.type_of(self.activation);
                let valid = if !kind.eq_with_case(b"object", true) || scanned == Value::Null { false }
                    else if self.get(scanned, FixedName::Version)? != 1.0.into() { false }
                    else {
                        let fields = self.get(scanned, FixedName::ScalarFields)?;
                        let valid = self.method(self.owner, FixedName::BHInteger, &[fields, 0.0.into(), (MAX_COUNTER as f64).into()])?;
                        valid.as_bool(self.activation.swf_version()) && self.owns(scanned, FixedName::Keys)?
                    };
                if !valid {
                    let message: Value<'gc> = self.name(FixedName::InvalidProjectionResult).into();
                    return self.fail(message);
                }
                // A replacement hasOwnProperty can mutate this envelope.
                // Re-read both fields at the original positions and retain
                // scalarFields as a Value for the later ActionAdd2.
                let fields = self.get(scanned, FixedName::ScalarFields)?;
                let keys = self.get(scanned, FixedName::Keys)?;
                (keys, fields)
            } else {
                self.inline_scan(value, output, cache, upgrades)?
            }
        } else {
            self.inline_scan(value, output, cache, upgrades)?
        };
        if !self.loose(keys, Value::Undefined)? {
            let length = self.get(keys, FixedName::Length)?;
            if self.less(1.0.into(), length)? { self.method(keys, FixedName::Sort, &[])?; }
        }
        Ok((keys, scalar_fields))
    }

    fn inline_scan(&mut self, value: Value<'gc>, output: Value<'gc>, mut cache: Value<'gc>, upgrades: bool) -> ResultAt<'gc, (Value<'gc>, Value<'gc>)> {
        let captured = value.as_object(self.activation)
            .map(|source| source.get_keys(self.activation, false)).unwrap_or_default();
        let mut keys = Value::Undefined;
        let mut scalar_fields = 0.0;
        for (index, key) in captured.into_iter().enumerate() {
            if index % 32 == 0 { self.timeout()?; }
            if !bump(&mut self.activation.context.avm1.native_project_stats.keys) {
                return Err(rejected(self.activation, "Native project witness overflow").into());
            }
            let owns = self.method(value, FixedName::HasOwnProperty, &[key.into()])?;
            if !owns.as_bool(self.activation.swf_version()) { continue; }
            let leaf = self.member(value, key.into())?;
            if !bump(&mut self.activation.context.avm1.native_project_stats.own_reads) {
                return Err(rejected(self.activation, "Native project witness overflow").into());
            }
            let kind = leaf.type_of(self.activation);
            if kind.eq_with_case(b"function", true) { continue; }
            let mut skip = self.member(cache, key.into())?;
            if self.loose(skip, Value::Undefined)? {
                skip = self.method(self.owner, FixedName::BHSkipField, &[key.into()])?;
                cache = self.get(self.owner, FixedName::MBHFieldCache)?;
            }
            if skip.as_bool(self.activation.swf_version()) { continue; }
            if upgrades && key.eq_with_case(b"mLevels", true) { continue; }
            if upgrades && key.eq_with_case(b"mMultipliers", true) {
                self.defer(&mut keys, key.into())?;
                continue;
            }
            let projected = if matches!(leaf, Value::Undefined) {
                self.tag(FixedName::TagUndefined, 1.0.into())?
            } else if self.loose(leaf, Value::Null)? || matches!(leaf, Value::String(_) | Value::Bool(_)) {
                leaf
            } else if let Value::Number(number) = leaf {
                if number.is_finite() { leaf } else {
                    let converted = self.string(leaf)?;
                    self.tag(FixedName::TagNumber, converted)?
                }
            } else {
                self.defer(&mut keys, key.into())?;
                continue;
            };
            self.set_member(output, key.into(), projected)?;
            scalar_fields += 1.0;
        }
        Ok((keys, scalar_fields.into()))
    }

    fn animation(&mut self, value: Value<'gc>, output: Value<'gc>, depth: u32) -> ResultAt<'gc, ()> {
        let first = self.get(value, FixedName::MXSIAnimation)?;
        if self.loose(first, Value::Undefined)? { return Ok(()); }
        let animation = self.get(value, FixedName::MXSIAnimation)?;
        let collection = self.get(animation, FixedName::MCollection)?;
        let items = self.get(collection, FixedName::MItems)?;
        let animation_object = self.get(animation, FixedName::MAnimationObject)?;
        let mut animation_name: Value<'gc> = self.name(FixedName::Empty).into();
        let keys = items.as_object(self.activation)
            .map(|source| source.get_keys(self.activation, false)).unwrap_or_default();
        for (index, candidate) in keys.into_iter().enumerate() {
            if index % 32 == 0 { self.timeout()?; }
            let item = self.member(items, candidate.into())?;
            let target = self.get(item, FixedName::MAnimationObject)?;
            if target == animation_object { animation_name = candidate.into(); }
        }
        let frame = self.get(animation, FixedName::MCurrentFrameID)?;
        let count = self.get(animation, FixedName::MFrameCount)?;
        let ended = self.get(animation, FixedName::MAnimEnd)?;
        let pre_update = self.get(animation, FixedName::MPreUpdate)?;
        let current = self.get(animation, FixedName::MCurrentFrame)?;
        let info = self.get(current, FixedName::XSIInfo)?;
        let model = self.get(info, FixedName::XSIModelGunPositionRight)?;
        let muzzle = self.get(model, FixedName::NPosition)?;
        let state = self.literal(&[(FixedName::Name, animation_name), (FixedName::Frame, frame), (FixedName::Count, count),
            (FixedName::Ended, ended), (FixedName::PreUpdate, pre_update), (FixedName::Muzzle, muzzle)])?;
        let path = self.name(FixedName::AnimationPath);
        let projected = self.recurse(state, path.into(), depth + 1)?;
        if !self.owns(output, FixedName::TagAnimation)? { self.set(output, FixedName::TagAnimation, projected)?; }
        Ok(())
    }

    fn active_upgrades(&mut self, value: Value<'gc>) -> ResultAt<'gc, Value<'gc>> {
        let active = self.construct(FixedName::Array)?;
        let mut level = 0.0;
        loop {
            self.timeout()?;
            let multipliers = self.get(value, FixedName::MMultipliers)?;
            let length = self.get(multipliers, FixedName::Length)?;
            if !self.less(level.into(), length)? { break; }
            let multipliers = self.get(value, FixedName::MMultipliers)?;
            let definitions = self.member(multipliers, level.into())?;
            let mut upgrade = 0.0;
            loop {
                let length = self.get(definitions, FixedName::Length)?;
                if !self.less(upgrade.into(), length)? { break; }
                let definition = self.member(definitions, upgrade.into())?;
                let enabled = self.get(definition, FixedName::MActive)?;
                if self.loose(enabled, Value::Bool(true))? {
                    let colon: Value<'gc> = self.name(FixedName::Colon).into();
                    let text = self.add(level.into(), colon)?;
                    let text = self.add(text, upgrade.into())?;
                    self.method(active, FixedName::Push, &[text])?;
                }
                upgrade += 1.0;
                self.timeout()?;
            }
            level += 1.0;
        }
        Ok(active)
    }

    fn project(&mut self, value: Value<'gc>, path: Value<'gc>, depth: u32) -> ResultAt<'gc, Value<'gc>> {
        self.timeout()?;
        self.check_code()?;
        let kind = value.type_of(self.activation);
        if let Value::Number(number) = value {
            if !number.is_finite() {
                let text = self.string(value)?;
                return self.tag(FixedName::TagNumber, text);
            }
        }
        if matches!(value, Value::Undefined) { return self.tag(FixedName::TagUndefined, 1.0.into()); }
        if self.loose(value, Value::Null)? || matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
            return Ok(value);
        }
        if kind.eq_with_case(b"function", true) { return Ok(Value::Undefined); }
        let class_name = self.get(value, FixedName::CLASSID)?;
        let cell_name: Value<'gc> = self.name(FixedName::CMapCell).into();
        if self.loose(class_name, cell_name)? {
            let position = self.get(value, FixedName::MPosition)?;
            let x = self.get(position, FixedName::X)?;
            let x = self.string(x)?;
            let comma: Value<'gc> = self.name(FixedName::Comma).into();
            let text = self.add(x, comma)?;
            let position = self.get(value, FixedName::MPosition)?;
            let y = self.get(position, FixedName::Y)?;
            let y = self.string(y)?;
            let text = self.add(text, y)?;
            return self.tag(FixedName::TagCell, text);
        }
        let map_name: Value<'gc> = self.name(FixedName::CMap).into();
        if self.loose(class_name, map_name)? {
            let size = self.get(value, FixedName::MSize)?;
            let width = self.get(size, FixedName::X)?;
            let size = self.get(value, FixedName::MSize)?;
            let height = self.get(size, FixedName::Y)?;
            let first = self.get(value, FixedName::MFirstTime)?;
            let collide = self.get(value, FixedName::MCollide)?;
            let flag = self.get(collide, FixedName::MCollideFlag)?;
            let flag = if self.loose(flag, Value::Undefined)? {
                self.tag(FixedName::TagUndefined, 1.0.into())?
            } else {
                let collide = self.get(value, FixedName::MCollide)?;
                self.get(collide, FixedName::MCollideFlag)?
            };
            return self.literal(&[(FixedName::Width, width), (FixedName::Height, height), (FixedName::First, first), (FixedName::CollideFlag, flag)]);
        }

        let objects = self.get(self.context, FixedName::Objects)?;
        let error_path = self.get(self.context, FixedName::ErrorPath)?;
        self.set_member(error_path, (depth as f64).into(), path)?;
        let over_budget = if depth > 64 { true } else {
            let length = self.get(objects, FixedName::Length)?;
            if self.less(200000.0.into(), length)? { true } else {
                let fields = self.get(self.context, FixedName::Fields)?;
                self.less(1000000.0.into(), fields)?
            }
        };
        if over_budget {
            let error_path = self.get(self.context, FixedName::ErrorPath)?;
            let sliced = self.method(error_path, FixedName::Slice, &[0.0.into(), ((depth + 1) as f64).into()])?;
            let empty: Value<'gc> = self.name(FixedName::Empty).into();
            let joined = self.method(sliced, FixedName::Join, &[empty])?;
            let prefix: Value<'gc> = self.name(FixedName::BudgetExceededPrefix).into();
            let message = self.add(prefix, joined)?;
            return self.fail(message);
        }
        let marked = self.get(value, FixedName::BhSnapshotRef)?;
        if !self.loose(marked, Value::Undefined)? {
            if self.member(objects, marked)? != value {
                let message: Value<'gc> = self.name(FixedName::MarkerCollision).into();
                return self.fail(message);
            }
            return self.tag(FixedName::TagRef, marked);
        }
        let length = self.get(objects, FixedName::Length)?;
        self.set(value, FixedName::BhSnapshotRef, length)?;
        let marker: Value<'gc> = self.name(FixedName::BhSnapshotRef).into();
        self.function(FixedName::ASSetPropFlags, &[value, marker, 1.0.into(), 0.0.into()])?;
        self.method(objects, FixedName::Push, &[value])?;
        if !bump(&mut self.activation.context.avm1.native_project_stats.nodes) {
            return Err(rejected(self.activation, "Native project witness overflow").into());
        }
        let output = self.construct(FixedName::Object)?;
        let upgrades_name: Value<'gc> = self.name(FixedName::CUpgrades).into();
        let upgrades = self.loose(class_name, upgrades_name)?;
        let (keys, scalar_fields) = self.scan(value, output, upgrades)?;
        let fields = self.get(self.context, FixedName::Fields)?;
        let fields = self.add(fields, scalar_fields)?;
        self.set(self.context, FixedName::Fields, fields)?;

        let array_name = self.name(FixedName::Array);
        let constructor: Value<'gc> = self.activation.resolve(array_name)?.into();
        if value.instance_of(constructor, self.activation)? && !self.owns(output, FixedName::TagLength)? {
            let length = self.get(value, FixedName::Length)?;
            self.set(output, FixedName::TagLength, length)?;
        }
        let parent = self.get(value, FixedName::MParent)?;
        let parent_id = self.get(parent, FixedName::MUniqueID)?;
        if !self.loose(parent_id, Value::Undefined)? && !self.owns(output, FixedName::TagParentID)? {
            self.set(output, FixedName::TagParentID, parent_id)?;
        }
        let process = self.get(value, FixedName::Process)?;
        if process.type_of(self.activation).eq_with_case(b"function", true) {
            let process_name = self.method(self.owner, FixedName::BHProcessName, &[value])?;
            if !self.owns(output, FixedName::TagProcess)? { self.set(output, FixedName::TagProcess, process_name)?; }
        }
        self.animation(value, output, depth)?;

        let mut index = 0.0;
        while !self.loose(keys, Value::Undefined)? {
            self.timeout()?;
            let length = self.get(keys, FixedName::Length)?;
            if !self.less(index.into(), length)? { break; }
            let key = self.member(keys, index.into())?;
            let multipliers: Value<'gc> = self.name(FixedName::MMultipliers).into();
            if upgrades && self.loose(key, multipliers)? {
                let active = self.active_upgrades(value)?;
                self.set_member(output, key, active)?;
                index += 1.0;
                continue;
            }
            let fields = self.get(self.context, FixedName::Fields)?;
            let fields = fields.coerce_to_f64(self.activation)? + 1.0;
            self.set(self.context, FixedName::Fields, fields.into())?;
            // FFDec emits call arguments right-to-left: depth, diagnostic
            // path, context, then value[key]. Path coercions must precede the
            // deferred getter, including keys supplied by an Array override.
            let slash: Value<'gc> = self.name(FixedName::Slash).into();
            let key_length = self.get(key, FixedName::Length)?;
            let child_path = self.add(slash, key_length)?;
            let colon: Value<'gc> = self.name(FixedName::Colon).into();
            let child_path = self.add(child_path, colon)?;
            let child_path = self.add(child_path, key)?;
            let child = self.member(value, key)?;
            let projected = self.recurse(child, child_path, depth + 1)?;
            self.set_member(output, key, projected)?;
            index += 1.0;
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests;
