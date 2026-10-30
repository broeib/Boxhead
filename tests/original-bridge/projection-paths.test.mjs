import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import { runInNewContext } from 'node:vm';
import { stripCompactStepBridge } from '../../scripts/lib/native-compact-step-source.mjs';

const currentBridge = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
const source = stripCompactStepBridge(metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(currentBridge))));
const nativeProject = readFileSync(new URL('../../tools/original-bridge/CMain.native-project.asinc', import.meta.url), 'utf8');
const stagedStep = readFileSync(new URL('../../tools/original-bridge/CMain.staged-step.asinc', import.meta.url), 'utf8');
const inlineBaseline = readFileSync(new URL('./fixtures/projection-inline-baseline.asinc', import.meta.url), 'utf8');
const finiteBaseline = readFileSync(new URL('./fixtures/projection-finite-baseline.asinc', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function method(name, input = source) {
  if (input === source && !input.includes('function ' + name + '('))
    input = nativeProject.includes('function ' + name + '(') ? nativeProject : stagedStep;
  const location = input.indexOf('function ' + name + '(');
  assert(location >= 0, 'Missing production method ' + name);
  const start = input.lastIndexOf('\n', location) + 1;
  const next = input.slice(location).search(/\n   (?:static )?(?:function|var) /);
  return input.slice(start, next < 0 ? undefined : location + next);
}

// The transport adapter is exercised independently of projection: a native
// snapshot is already complete before the ExternalInterface envelope is made.
function readbackHarness(snapshot, rejectRegistration = false) {
  const callbacks = new Map(), calls = [];
  const CMain = runInNewContext('(class CMain {\n' + ['BH_Install', 'BH_NativeScalarInstall',
    'BH_NativeScalarInfo', 'BH_NativeProjectionInstall', 'BH_NativeProjectionInfo',
    'BH_NativeProjectInstall', 'BH_NativeProjectInfo', 'BH_StagedInstall',
    'BH_Integer', 'BH_ReceiptGuard', 'BH_ReadState'].map(name => method(name)).join('\n')
    .replace(/function (BH_[A-Za-z_0-9]*)\(/g, '$1(') + '\n})', {
    Object, _global: {}, flash: { external: { ExternalInterface: { available: true,
      addCallback(name, receiver, callback) {
        callbacks.set(name, { receiver, callback });
        return !(rejectRegistration && name === 'bhState');
      },
    } } },
  });
  const main = new CMain();
  for (const name of ['Info', 'Prepare', 'Step', 'StateReceipt', 'MenuPoll', 'MenuUpdate', 'RenderCheck', 'Controls', 'AnimationProbe',
    'PresentationConfig', 'Present', 'PresentationInfo', 'StagedStateReceipt',
    'StagedStepBegin', 'StagedStepPrepare', 'StagedStepProject', 'StagedStepCommit', 'StagedStepAbort'])
    main['BH_' + name] = () => undefined;
  main.BH_State = (refresh, forceFull) => { calls.push({ refresh, forceFull }); return snapshot; };
  main.BH_Install();
  const registered = callbacks.get('bhState');
  return { main, callbacks, calls, read: (...args) => registered.callback.apply(registered.receiver, args) };
}

test('bhState registers the actual opt-in adapter and preserves legacy return identity and refresh arguments', () => {
  const entities = { t1: { life: 100 } };
  const snapshot = Object.freeze({ tick: 25, native: { scope: 'full', tick: 25, entities }, entities });
  const h = readbackHarness(snapshot);
  assert.equal(typeof h.callbacks.get('bhState').callback, 'function');
  assert.notEqual(h.callbacks.get('bhState').callback, h.main.BH_ReadState, 'external registration uses the reentry guard');
  assert.equal(h.callbacks.get('bhState').receiver, h.main);
  assert.equal(h.read(), snapshot);
  assert.deepEqual(h.calls.pop(), { refresh: undefined, forceFull: undefined });
  for (const third of [undefined, false, 0, 1, 'true', null, {}]) {
    assert.equal(h.read(true, false, third), snapshot);
    assert.deepEqual(h.calls.pop(), { refresh: true, forceFull: false });
  }
  h.read(false, true, true);
  assert.deepEqual(h.calls.pop(), { refresh: false, forceFull: true });
  assert.equal(h.calls.length, 0, 'adapter must delegate exactly once per read');
  const rejected = readbackHarness(snapshot, true);
  assert.equal(rejected.main.mBH.state, 'error');
  assert.equal(rejected.main.mBH.error, 'ExternalInterface callback registration failed');
});

test('single-projection readback removes only the duplicate entity envelope field without traversing or mutating native data', () => {
  for (const scope of ['frame', 'full']) {
    const entities = Object.freeze({ t1: Object.freeze({ mLife: 100, reference: { $ref: 7 }, absent: { $undefined: 1 } }) });
    const native = Object.freeze({ scope, tick: 25, entities });
    const inherited = {};
    Object.defineProperty(inherited, 'inherited', { enumerable: true, get() { throw new Error('inherited header was read'); } });
    const snapshot = Object.freeze(Object.assign(Object.create(inherited), {
      version: 1, engine: 'original-swf', state: 'playing', tick: 25, scope,
      digest: 'native-v2-0123456789abcdef', digestSchema: 'native-projection-v3',
      players: [{ slot: 1 }], rng: { seed: 1, state: 2, calls: 3 }, native, entities,
      snapshotBytes: 123, snapshotObjects: 5, snapshotFields: 18,
      profile: { projectMs: 2, encodeMs: 0, hashMs: 1 }, extraHeader: undefined,
    }));
    const h = readbackHarness(snapshot), slim = h.read(false, false, true);
    assert.notEqual(slim, snapshot);
    assert.deepEqual(Object.keys(slim).sort(), Object.keys(snapshot).filter(key => key !== 'entities').sort());
    for (const key of Object.keys(slim)) assert.equal(slim[key], snapshot[key], key + ' changed identity/value');
    assert.equal(Object.hasOwn(slim, 'entities'), false);
    assert.equal(slim.native, native); assert.equal(slim.native.entities, entities);
    assert.equal(snapshot.entities, entities, 'legacy cached alias must remain intact');
    assert.deepEqual(h.calls, [{ refresh: false, forceFull: false }]);
    assert.equal(h.read(), snapshot, 'a later legacy caller must still receive the original envelope');
  }
});

test('single-projection readback preserves menu/error results and refuses to conceal a broken entity alias', () => {
  const entities = {};
  const results = [undefined, null, { state: 'menu', tick: 0 }, { tick: 1, error: 'during frame' },
    { tick: 2, error: 'failed', native: { entities }, entities },
    { tick: 3, native: { entities }, entities: {} },
    { tick: 4, native: 'invalid', entities },
  ];
  for (const snapshot of results) {
    const h = readbackHarness(snapshot);
    assert.equal(h.read(false, false, true), snapshot);
    assert.deepEqual(h.calls, [{ refresh: false, forceFull: false }]);
  }
});

// Execute the production projector and BH_State cleanup. The only AS2 adapter
// is its undefined-parent read and the nonenumerable identity marker. Actual
// AVM1 compilation, native graph/PNG parity and timing remain CI browser gates.
function harness(reference = false) {
  const marked = [];
  let digestCalls = 0;
  let lastNative;
  const methods = ['BH_SkipField', 'BH_SkipFieldUncached', 'BH_ProcessName', 'BH_Project', 'BH_NativeProject', 'BH_Grid', 'BH_Scalars', 'BH_ThingScalars', 'BH_FrameState', 'BH_State']
    .map(name => method(name,
      reference === 'finite' && ['BH_Project', 'BH_Scalars', 'BH_FrameState'].includes(name) ? finiteBaseline
        : reference === true && ['BH_ProcessName', 'BH_FrameState'].includes(name) ? inlineBaseline : source)).join('\n');
  const CMain = runInNewContext('(class CMain {\n' + methods
    .replace(/static function ([A-Za-z_][A-Za-z_0-9]*)\(/g, 'static $1(')
    .replace(/(?<!static )function (BH_[A-Za-z_0-9]*)\(/g, '$1(')
    .replaceAll('value.mParent.mUniqueID', 'value.mParent?.mUniqueID') + '\n})', {
    Object, Array, Error, Math, String, Number, isFinite, isNaN, getTimer: () => 0,
    ASSetPropFlags(target, key, set, clear) {
      assert.equal(key, '__bhSnapshotRef'); assert.equal(set, 1); assert.equal(clear, 0);
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      assert(descriptor);
      Object.defineProperty(target, key, { ...descriptor, enumerable: false });
      marked.push(target);
    },
    flash: { external: { ExternalInterface: { call(name, native) {
      assert.equal(name, 'boxheadDigestOriginalState'); digestCalls++;
      lastNative = native;
      return { digest: 'native-v2-0123456789abcdef', bytes: JSON.stringify(native).length };
    } } } },
    World: { Map: { CMap_Cell: {}, CMap: { mCheckSessionID: 1 } } },
    Thing: { CThing: { mAllocate_ID: 8, mAllocate_ProcessID_Count: 2 }, Math: { CThing_Position: { mPFactor: 1 } } },
  });
  const main = new CMain();
  main.mcWorld = {
    mThing_Collection: { mThings: {}, mPlayerThings: {}, mDeleteThings: {}, mRespawnPlayer: {},
      mThingCounters: {}, mTimeSlice_25: 0, mTimeSlice_8: 1, mTimeSlice_4: 1 },
    mMap: { _CLASSID_: 'CMap', mSize: { x: 1, y: 1 }, mCells: [], mCollide: { mCollideFlag: false } },
    mUpgrades: {}, mHud: {},
  };
  main.mBH = { active: true, state: 'playing', tick: 25, seed: 1, rng: 2, rngCalls: 3,
    settings: {}, mode: 'Coop', map: 'fixture', characters: [0, 1], initialPlayers: 2 };
  main.BH_Players = () => [];
  main.BH_Fail = message => { main.mBH.state = 'error'; return { error: message }; };
  CMain._this = main;
  CMain.mInput = { mKey_List_Registered: [] };
  CMain.BH_Integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
  CMain.BH_PersonalEnabled = () => false;
  return { CMain, main, marked, digestCalls: () => digestCalls, lastNative: () => lastNative };
}

const context = () => ({ objects: [], errorPath: [], fields: 0 });
function chain(edges) {
  const root = {};
  let tail = root;
  for (let index = 0; index < edges; index++) tail = tail.n = {};
  return root;
}

test('diagnostic path storage preserves the exact cyclic graph, field counts and reference numbering', () => {
  const h = harness(), state = context();
  const position = { mX: 2, mY: 3, mZ: 0 };
  const entity = { mUniqueID: 7, mLife: 100, mPosition: position, mP: position, absent: undefined, nonfinite: NaN };
  entity.mParent = entity; entity.self = entity;
  const root = { zEntity: entity, aEntity: entity, list: [entity, position], empty: null };
  const result = h.CMain.BH_Project(root, state, 'root', 0);
  assert.deepEqual(plain(result), {
    empty: null,
    aEntity: { mUniqueID: 7, mLife: 100, absent: { $undefined: 1 }, nonfinite: { $number: 'NaN' },
      $parentID: 7, mP: { mX: 2, mY: 3, mZ: 0 }, mPosition: { $ref: 2 }, self: { $ref: 1 } },
    list: { $length: 2, 0: { $ref: 1 }, 1: { $ref: 2 } }, zEntity: { $ref: 1 },
  });
  assert.equal(state.objects.length, 4);
  assert.equal(state.fields, 16);
});

test('budget failures retain exact paths and thresholds after a deeper sibling has returned', () => {
  const h = harness(), state = context();
  // Root plus ten objects under a reach the old allowed boundary. The next
  // sibling must fail at its own shallow path, without the prior n suffixes.
  state.objects.length = 199990;
  assert.throws(() => h.CMain.BH_Project({ a: chain(9), 'z/:': {} }, state, 'root', 0), {
    message: 'native snapshot budget exceeded at root/3:z/:',
  });
  assert.equal(state.objects.length, 200001);
  const boundary = context(); boundary.fields = 1000000;
  assert.deepEqual(plain(h.CMain.BH_Project({}, boundary, 'root', 0)), {});
  assert.throws(() => h.CMain.BH_Project({ child: {} }, boundary, 'root', 0), {
    message: 'native snapshot budget exceeded at root/5:child',
  });
});

test('BH_State keeps the animation diagnostic path and clears every identity marker on depth failure', () => {
  const h = harness();
  const animationObject = {};
  h.main.mcWorld.mThing_Collection.mThings.t7 = {
    mUniqueID: 7,
    mXSI_Animation: { mCollection: { mItems: { stand: { mAnimationObject: animationObject } } },
      mAnimationObject: animationObject, mCurrentFrameID: 0, mFrameCount: 1, mAnimEnd: false, mPreUpdate: false,
      mCurrentFrame: { XSI_Info: { XSI_Model_GunPosition_Right: { nPosition: chain(61) } } } },
  };
  const result = h.main.BH_State(true, true);
  assert.equal(result.error, 'native snapshot exception: Error: native snapshot budget exceeded at '
    + 'root/8:entities/2:t7/animation/6:muzzle' + '/1:n'.repeat(61));
  assert.equal(h.main.mBH.state, 'error');
  assert.equal(h.digestCalls(), 0);
  assert(h.marked.length > 60);
  for (const object of h.marked) assert.equal(Object.hasOwn(object, '__bhSnapshotRef'), false);
});

test('hot scalar policy reads current own fields without invoking inherited getters or caching values', () => {
  const h = harness();
  let inheritedReads = 0;
  const prototype = {};
  Object.defineProperty(prototype, 'derived', { enumerable: true, get() {
    inheritedReads++;
    throw new Error('An inherited accessor must not enter the projection');
  } });
  const object = Object.assign(Object.create(prototype), {
    mLife: 200, mDamage: 4, active: false, label: 'alive', mcVisible: 12,
    mWorld: 42, LastSound: 5, absent: undefined, child: { n: 1 }, ignored: () => 1,
  });
  assert.deepEqual(plain(h.CMain.BH_Scalars(object)), { mLife: 200, mDamage: 4, active: false, label: 'alive' });
  object.mLife = NaN;
  delete object.mDamage;
  object.active = true;
  object.label = 'changed';
  object.added = Infinity;
  assert.deepEqual(plain(h.CMain.BH_Scalars(object)), {
    mLife: { $number: 'NaN' }, active: true, label: 'changed', added: { $number: 'Infinity' },
  });
  assert.equal(inheritedReads, 0);
});

test('hot policy refreshes its local cache after the bounded helper resets it', () => {
  const h = harness();
  h.CMain.mBHFieldCache = { 'field:mLife': false, 'field:mcHidden': true };
  h.CMain.mBHFieldCacheCount = 1024;
  const object = { mLife: 9, mcHidden: 10, added: 11, OtherSample: 12, retained: 'yes' };
  assert.deepEqual(plain(h.CMain.BH_Scalars(object)), { mLife: 9, added: 11, retained: 'yes' });
  assert(h.CMain.mBHFieldCacheCount <= 1024);
  // The same filtering must hold while a recursive full graph also fills and
  // resets the cache; entity names are not treated as persistent world state.
  h.CMain.mBHFieldCacheCount = 1024;
  const projected = h.CMain.BH_Project({ object, z: { mLife: 13, mcHidden: 14 } }, context(), 'root', 0);
  assert.deepEqual(plain(projected), {
    object: { mLife: 9, added: 11, retained: 'yes' }, z: { mLife: 13 },
  });
});

test('scalar-only records and sparse arrays retain undefined tags, metadata shadows and lexical references', () => {
  const h = harness(), state = context();
  const leaf = { value: undefined, low: -Infinity, high: Infinity, flag: false, empty: null };
  const sparse = new Array(12);
  sparse[10] = leaf;
  sparse[2] = leaf;
  sparse.$length = 99;
  const result = h.CMain.BH_Project({ a: sparse, z: leaf }, state, 'root', 0);
  assert.deepEqual(plain(result), {
    a: { $length: 99,
      10: { value: { $undefined: 1 }, low: { $number: '-Infinity' }, high: { $number: 'Infinity' }, flag: false, empty: null },
      2: { $ref: 2 } },
    z: { $ref: 2 },
  });
  assert.equal(state.objects.length, 3);
});

test('a scalar animation shadow still traverses synthetic metadata before later shared references', () => {
  const h = harness(), state = context();
  const muzzle = { mX: 1, mY: 2, mZ: 3 };
  const animationObject = {};
  const entity = { mID: 7, $animation: 'native field wins', mXSI_Animation: {
    mCollection: { mItems: { stand: { mAnimationObject: animationObject } } },
    mAnimationObject: animationObject, mCurrentFrameID: 0, mFrameCount: 1, mAnimEnd: false, mPreUpdate: false,
    mCurrentFrame: { XSI_Info: { XSI_Model_GunPosition_Right: { nPosition: muzzle } } },
  } };
  const result = h.CMain.BH_Project({ a: entity, z: muzzle }, state, 'root', 0);
  assert.deepEqual(plain(result), { a: { mID: 7, $animation: 'native field wins' }, z: { $ref: 3 } });
  assert.equal(state.objects.length, 4);
});

test('process identity cache observes transitions and retains the original first resolved alias set', () => {
  const h = harness();
  const first = () => 1, second = () => 2;
  assert.equal(h.CMain.BH_ProcessName({}), '');
  const entity = { Process: first, Process_Z: first, Process_A: first, Process_B: second };
  assert.equal(h.CMain.BH_ProcessName(entity), 'Process_A|Process_Z');
  assert.equal(h.CMain.BH_ProcessName(entity), 'Process_A|Process_Z');
  entity.Process = second;
  assert.equal(h.CMain.BH_ProcessName(entity), 'Process_B');
  entity.Process = first;
  assert.equal(h.CMain.BH_ProcessName(entity), 'Process_A|Process_Z');
  // The pre-existing function-identity cache is intentionally shared across
  // instances. Its first alias resolution, rather than a new object's names,
  // remains the exact output contract after the last-hit optimization.
  assert.equal(h.CMain.BH_ProcessName({ Process: first, Process_Other: first }), 'Process_A|Process_Z');
  assert.equal(h.CMain.BH_ProcessName({}), '');
  assert.equal(h.main.mBH.processFunctions.length, 3);
});

test('grid strings retain explicit conversion and original resident enumeration order', () => {
  const h = harness();
  const map = { mCells: [[{
    mCollide: undefined, mChildCount: NaN, nID: Infinity, nDist: -Infinity, nVD: false,
    mObjects: { second: { sUniqueID: 't2' }, first: { sUniqueID: 't1' } },
  }, {
    mCollide: 0, mChildCount: 1, nID: -0, nDist: 2, nVD: null, mObjects: {},
  }]] };
  assert.equal(h.CMain.BH_Grid(map), 'undefined;NaN;Infinity;-Infinity;false;t2,t1|0;1;0;2;null;');
});

test('compact projection reads all current coordinates and preserves every vector string slot', () => {
  const h = harness();
  const process = () => 1;
  const thing = {
    _CLASSID_: 'FixtureThing', mLife: 5, Process: process, Process_Walk: process,
    mPosition: { mX: 2, mY: NaN, mZ: 0 },
    mDelta: { mX: -Infinity, mY: Infinity, mZ: undefined },
    mTarget_Direction: { mX: -0, mY: 4, mZ: 5 },
    mReturn_Angle: { mX: 'x', mY: null, mZ: false },
    mAngle: { mAngle: 1 }, mTarget_Angle: { mAngle: 2 },
    mXSI_Animation: { mCurrentFrameID: 3 }, mParent: { mUniqueID: 9 },
  };
  h.main.mcWorld.mThing_Collection.mThings.t7 = thing;
  h.main.mBH.tick = 1;
  h.main.mBH.lastFullDigest = 'native-v2-lastfull';
  h.main.BH_FrameState();
  assert.deepEqual(plain(h.lastNative().entities.t7), {
    _CLASSID_: 'FixtureThing', mLife: 5,
    $vectors: ['2,NaN,0', '-Infinity,Infinity,undefined', '0,4,5', 'x,null,false'],
    $class: 'FixtureThing', $angle: '1', $targetAngle: '2', $frame: '3', $parent: '9', $process: 'Process_Walk',
  });
  assert.equal(h.lastNative().lastFullDigest, 'native-v2-lastfull');
  thing.mPosition.mX = 7;
  delete thing.mLife;
  h.main.mBH.tick = 2;
  h.main.BH_FrameState();
  assert.equal(h.lastNative().entities.t7.$vectors[0], '7,NaN,0');
  assert.equal(Object.hasOwn(h.lastNative().entities.t7, 'mLife'), false);
  assert.equal(h.lastNative().tick, 2);
});

function inlineThing(functions, id = 1) {
  const animation = {};
  return {
    _CLASSID_: 'FixtureThing', mUniqueID: id, mLife: 200, mDamage: 7, active: true, label: 'alive',
    ignored: { nested: 1 }, absent: undefined, mcExcluded: 12,
    Process: functions.walk, Process_Walk: functions.walk, Process_Hurt: functions.hurt,
    mPosition: { mX: 2, mY: 3, mZ: 0 }, mDelta: { mX: 0, mY: -0, mZ: 1 },
    mTarget_Direction: { mX: 1, mY: 0, mZ: 0 }, mReturn_Angle: { mX: 0, mY: 1, mZ: 0 },
    mAngle: { mAngle: 1 }, mTarget_Angle: { mAngle: 2 }, mParent: { mUniqueID: 9 },
    mXSI_Animation: { mCurrentFrameID: 0, mFrameCount: 2, mAnimEnd: false, mPreUpdate: false,
      mCollection: { mItems: { walk: { mAnimationObject: animation } } }, mAnimationObject: animation,
      mCurrentFrame: { XSI_Info: { XSI_Model_GunPosition_Right: { nPosition: { mX: 1, mY: 2, mZ: 0 } } } } },
  };
}

function inlineWorld(reference) {
  const h = harness(reference);
  const functions = { walk: () => 1, hurt: () => 2, idle: () => 3 };
  const things = h.main.mcWorld.mThing_Collection.mThings;
  things.t1 = inlineThing(functions, 1); things.t2 = inlineThing(functions, 2);
  things.t1.mWeaponList = [
    { mActive: true, mNameID: 'pistol', mThing: { mAmmo: 17, mDamage: 4, enabled: true } },
    { mActive: false, mNameID: 'uzi', mThing: { mAmmo: 0, mDamage: 2 } },
  ];
  things.t1.mWeapon_Current = things.t1.mWeaponList[0];
  h.main.mcWorld.mUpgrades = { mLevel: 1, Level: { mAmount: 3 } };
  h.main.mcWorld.mHud = { mTotalScore: 0 };
  h.main.mBH.lastFullDigest = 'native-v2-previous';
  return { h, things, functions };
}

test('inlined entity projection matches the frozen baseline whole snapshots across mutations, full checkpoints and forced full reads', () => {
  const worlds = [inlineWorld(true), inlineWorld(false)];
  const changes = [
    { tick: 1, change() {} },
    { tick: 2, change({ h, things, functions }) {
      delete things.t1.mLife;
      things.t1.mDamage = { nested: 8 }; things.t1.active = false; things.t1.label = undefined;
      things.t1.added = Infinity; things.t1.negative = -Infinity; things.t1.notNumber = NaN;
      things.t1.Process = functions.hurt; things.t1.mPosition.mX = -0;
      things.t1.mDelta.mZ = undefined; things.t1.mReturn_Angle.mY = NaN;
      things.t1.mWeaponList[0].mThing.mAmmo = 16;
      delete things.t1.mWeaponList[0].mThing.mDamage;
      things.t1.mWeaponList[1].mActive = true;
      h.CMain.mBHFieldCacheCount = 1024;
    } },
    { tick: 3, change({ things, functions }) {
      things.t1.Process = functions.walk;
      things.t1.Process_AnotherWalkAlias = functions.walk;
      delete things.t1.mWeaponList; delete things.t1.mWeapon_Current;
      things.t1.mDamage = 0; things.t1.added = 9; delete things.t1.negative;
      things.t2.Process = undefined;
    } },
    { tick: 4, change({ things, functions }) {
      delete things.t1;
      things.t3 = inlineThing(functions, 3);
      things.t3.Process = functions.idle; things.t3.Process_Idle = functions.idle;
    } },
    { tick: 24, change({ things, functions }) {
      things.t1 = inlineThing(functions, 11);
      things.t1._CLASSID_ = 'ReplacementThing'; things.t1.Process = functions.hurt;
      things.t2.Process = functions.hurt;
    } },
    { tick: 25, change({ things, h }) {
      things.t1.mLife = 125; things.t3.mXSI_Animation.mCurrentFrameID = 1;
      h.main.mcWorld.mHud.mTotalScore = 100;
    } },
    { tick: 26, change({ things, functions }) {
      things.t3.Process = functions.walk; things.t1.mLife = 124;
    } },
    { tick: 27, forceFull: true, change({ things }) { things.t2.mDamage = NaN; } },
  ];
  let prior = [];
  for (const item of changes) {
    const states = worlds.map(world => {
      item.change(world); world.h.main.mBH.tick = item.tick;
      return world.h.main.BH_State(true, item.forceFull === true);
    });
    assert.deepEqual(plain(states[1]), plain(states[0]), 'whole native snapshot differs at tick ' + item.tick);
    assert.equal(states[0].scope, item.tick % 25 === 0 || item.forceFull ? 'full' : 'frame');
    assert.equal(states[1].entities, states[1].native.entities, 'snapshot entity alias must remain exact');
    for (const saved of prior) assert.equal(JSON.stringify(saved.snapshot), saved.bytes,
      'a later projection mutated a previously returned snapshot');
    prior = states.map(snapshot => ({ snapshot, bytes: JSON.stringify(snapshot) }));
    assert.deepEqual(worlds[1].h.main.mBH.processNames, worlds[0].h.main.mBH.processNames);
  }
  // A forced diagnostic full graph on 27 must not replace cached compact 26.
  for (const world of worlds) assert.equal(world.h.main.mBH.snapshot.tick, 26);
  const compact = worlds.map(world => world.h.main.BH_State(true));
  assert.deepEqual(plain(compact[1]), plain(compact[0]));
  assert.equal(compact[0].scope, 'frame'); assert.equal(compact[0].tick, 27);
});

function getterWorld(reference, enumerableProcess) {
  const h = harness(reference), events = [];
  const functions = { walk: () => 1, hurt: () => 2 };
  let selected = functions.walk;
  const thing = inlineThing(functions);
  const inherited = {};
  Object.defineProperty(inherited, 'inheritedGetter', { enumerable: true, get() {
    throw new Error('Inherited scalar accessor was read');
  } });
  Object.setPrototypeOf(thing, inherited);
  for (const key of ['mPosition', 'mDelta', 'mTarget_Direction', 'mReturn_Angle']) {
    for (const [coordinate, value] of Object.entries(thing[key])) {
      Object.defineProperty(thing[key], coordinate, { enumerable: true,
        get() { events.push(key + '.' + coordinate); return value; } });
    }
  }
  Object.defineProperty(thing.mParent, 'mUniqueID', { enumerable: true,
    get() { events.push('parentID'); return 9; } });
  for (const [key, value] of Object.entries(thing)) {
    Object.defineProperty(thing, key, { configurable: true, enumerable: key === 'Process' ? enumerableProcess : true,
      get() { events.push(key); return key === 'Process' ? selected : value; } });
  }
  h.main.mcWorld.mThing_Collection.mThings.t1 = thing;
  h.main.mBH.lastFullDigest = 'native-v2-previous';
  return { h, events, select: name => { selected = functions[name]; } };
}

test('inlined projection preserves getter count and complete read order on process misses, immediate hits and cached transitions', () => {
  for (const enumerableProcess of [false, true]) {
    const worlds = [getterWorld(true, enumerableProcess), getterWorld(false, enumerableProcess)];
    for (const [index, selected] of ['walk', 'walk', 'hurt', 'walk'].entries()) {
      const states = worlds.map(world => {
        world.events.length = 0; world.select(selected); world.h.main.mBH.tick = index + 1;
        return world.h.main.BH_FrameState();
      });
      assert.deepEqual(plain(states[1]), plain(states[0]));
      assert.deepEqual(worlds[1].events, worlds[0].events, 'getter order changed for ' + selected);
      const events = worlds[1].events;
      assert.equal(events.filter(key => key === 'Process').length, enumerableProcess ? 2 : 1,
        'a supplied process miss must not reread the getter');
      assert.equal(events.filter(key => key === 'mLife').length, 1);
      assert.equal(events.filter(key => key === 'mcExcluded').length, 1,
        'the original scalar pass reads an own value before applying field policy');
      for (const key of ['mPosition', 'mDelta', 'mTarget_Direction', 'mReturn_Angle'])
        assert.equal(events.filter(event => event === key).length, 2);
      const vectorStart = events.lastIndexOf('mPosition');
      assert.deepEqual(events.slice(vectorStart, vectorStart + 4), ['mPosition', 'mDelta', 'mTarget_Direction', 'mReturn_Angle']);
      assert.equal(events[vectorStart + 4], 'mPosition.mX');
      assert(events.lastIndexOf('Process') > events.indexOf('parentID'),
        'Process must still be read after the original parent metadata');
    }
  }
});


// The independent reference is the exact pre-change inline source, not an
// implementation of the candidate predicate. Keep numbers out of JSON here:
// JSON would erase the signed zero that the projection must retain.
const finiteEdges = [
  ['positiveZero', 0], ['negativeZero', -0],
  ['positiveSubnormal', Number.MIN_VALUE], ['negativeSubnormal', -Number.MIN_VALUE],
  ['positiveMaxSubnormal', 2 ** -1022 - Number.MIN_VALUE],
  ['negativeMaxSubnormal', -(2 ** -1022 - Number.MIN_VALUE)],
  ['positiveMinNormal', 2 ** -1022], ['negativeMinNormal', -(2 ** -1022)],
  ['positiveMaximum', Number.MAX_VALUE], ['negativeMaximum', -Number.MAX_VALUE],
  ['positiveOne', 1], ['negativeOne', -1],
  ['positiveEpsilon', Number.EPSILON], ['negativeEpsilon', -Number.EPSILON],
  ['maxSafeInteger', Number.MAX_SAFE_INTEGER], ['nan', NaN],
  ['positiveInfinity', Infinity], ['negativeInfinity', -Infinity],
];

function exactData(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Array.from(value, exactData);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, exactData(child)]));
}

function assertProjectedNumber(actual, expected, description) {
  if (Number.isFinite(expected)) assert(Object.is(actual, expected), description + ' lost the exact finite value');
  else assert.deepEqual(exactData(actual), { $number: String(expected) }, description + ' lost the nonfinite tag');
}

// Inspect descriptors without invoking accessors. Save every reachable source
// object independently, so a mutation behind an unchanged reference is visible.
function ownGraph(root) {
  const pending = [root], seen = new Set(), records = [];
  while (pending.length) {
    const object = pending.pop();
    if (object === null || typeof object !== 'object' || seen.has(object)) continue;
    seen.add(object);
    const descriptors = Object.getOwnPropertyDescriptors(object);
    records.push({ object, prototype: Object.getPrototypeOf(object), keys: Reflect.ownKeys(object), descriptors });
    for (const descriptor of Object.values(descriptors))
      if (Object.hasOwn(descriptor, 'value')) pending.push(descriptor.value);
  }
  return records;
}

function assertOwnGraphUnchanged(records) {
  for (const { object, prototype, keys, descriptors } of records) {
    assert.equal(Object.getPrototypeOf(object), prototype, 'source prototype changed');
    assert.deepEqual(Reflect.ownKeys(object), keys, 'source keys changed or a snapshot marker remained');
    assert.deepEqual(Object.getOwnPropertyDescriptors(object), descriptors, 'source value/descriptor changed');
  }
}

test('finite projection preserves exact IEEE primitive roots and scalar records against the frozen builtin oracle', () => {
  const implementations = [harness('finite'), harness(false)];
  const record = Object.fromEntries(finiteEdges.map(([name, value]) => ['edge_' + name, value]));
  Object.assign(record, { text: 'Infinity', truth: true, falsity: false, nil: null, absent: undefined });
  const before = ownGraph(record);
  for (const h of implementations) {
    for (const [name, value] of finiteEdges)
      assertProjectedNumber(h.CMain.BH_Project(value, context(), 'root', 0), value, name + ' root');
    const scalars = h.CMain.BH_Scalars(record);
    for (const [name, value] of finiteEdges) assertProjectedNumber(scalars['edge_' + name], value, name + ' scalar');
    assert.equal(scalars.text, 'Infinity'); assert.equal(scalars.truth, true); assert.equal(scalars.falsity, false);
    assert.equal(Object.hasOwn(scalars, 'nil'), false); assert.equal(Object.hasOwn(scalars, 'absent'), false);
    assertOwnGraphUnchanged(before);
  }
  assert.deepEqual(exactData(implementations[1].CMain.BH_Scalars(record)),
    exactData(implementations[0].CMain.BH_Scalars(record)));
});

test('finite projection retains whole compact/full snapshots, single getter reads and prior snapshots over numeric mutations', () => {
  const worlds = [inlineWorld('finite'), inlineWorld(false)];
  for (const world of worlds) {
    world.reads = [];
    world.selected = -0;
    Object.defineProperty(world.things.t1, 'edgeGetter', { configurable: true, enumerable: true,
      get() { world.reads.push('edgeGetter'); return world.selected; } });
  }
  const saved = [];
  const checkpoints = [
    { tick: 1, offset: 0 }, { tick: 25, offset: 0 },
    { tick: 26, offset: 7 }, { tick: 50, offset: 7 },
    { tick: 51, offset: 12, forceFull: true },
  ];
  for (const checkpoint of checkpoints) {
    const expected = finiteEdges.map(([name], index) =>
      ['edge_' + name, finiteEdges[(index + checkpoint.offset) % finiteEdges.length][1]]);
    const states = worlds.map(world => {
      const { h, things } = world;
      for (const record of [things.t1, things.t1.mWeaponList[0].mThing, h.main.mcWorld.mHud]) {
        for (const [key, value] of expected) record[key] = value;
        if (checkpoint.offset) { delete record.edgeRemoved; record.edgeAdded = -0; }
        else record.edgeRemoved = Number.MIN_VALUE;
      }
      world.selected = finiteEdges[checkpoint.offset][1];
      world.reads.length = 0;
      h.main.mBH.tick = checkpoint.tick;
      const before = ownGraph(h.main.mcWorld);
      const state = h.main.BH_State(true, checkpoint.forceFull === true);
      assert.equal(state.error, undefined);
      assertOwnGraphUnchanged(before);
      assert.deepEqual(world.reads, ['edgeGetter'], 'numeric accessor must be read exactly once');
      assert.equal(state.entities, state.native.entities);
      assertProjectedNumber(state.native.entities.t1.edgeGetter, world.selected, 'getter');
      const weapon = state.scope === 'frame' ? state.native.entities.t1.$weapons[0].properties
        : state.native.entities.t1.mWeaponList[0].mThing;
      for (const output of [state.native.entities.t1, weapon, state.native.hud]) {
        for (const [key, value] of expected) assertProjectedNumber(output[key], value, key + ' at ' + checkpoint.tick);
        if (checkpoint.offset) {
          assert.equal(Object.hasOwn(output, 'edgeRemoved'), false);
          assertProjectedNumber(output.edgeAdded, -0, 'new field at ' + checkpoint.tick);
        } else assertProjectedNumber(output.edgeRemoved, Number.MIN_VALUE, 'old field at ' + checkpoint.tick);
      }
      for (const object of h.marked) assert.equal(Object.hasOwn(object, '__bhSnapshotRef'), false);
      return state;
    });
    assert.deepEqual(exactData(states[1]), exactData(states[0]), 'whole snapshot differs at ' + checkpoint.tick);
    assert.equal(states[0].scope, checkpoint.tick % 25 === 0 || checkpoint.forceFull ? 'full' : 'frame');
    for (const item of saved) assert.deepEqual(exactData(item.state), item.copy,
      'a later read changed a previously returned number or graph');
    saved.push(...states.map(state => ({ state, copy: exactData(state) })));
  }
  for (const world of worlds) assert.equal(world.h.main.mBH.snapshot.tick, 50,
    'forced full read must retain the preceding cached checkpoint');
});
