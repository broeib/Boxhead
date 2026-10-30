import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import { runInNewContext } from 'node:vm';
import { stripNativeProjectionScan } from './helpers/native-projection-scan-source.mjs';

const candidate = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
// Authenticate loading metadata separately; current models keep the raw candidate.
const historicalCandidate = metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(candidate)));
const nativeProject = readFileSync(new URL('../../tools/original-bridge/CMain.native-project.asinc', import.meta.url), 'utf8');
const baseline = readFileSync(new URL('./fixtures/field-policy-cache-baseline.asinc', import.meta.url), 'utf8');
const receiptBaseline = readFileSync(new URL('./fixtures/state-receipt-bridge-baseline.asinc', import.meta.url), 'utf8');
const failedV1 = readFileSync(new URL('./fixtures/field-policy-cache-failed-v1.asinc', import.meta.url), 'utf8');
const probe = readFileSync(new URL('./fixtures/field-cache-native-probe.asinc', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');

function method(input, name) {
  const location = input.indexOf('function ' + name + '(');
  assert(location >= 0, 'Missing actual source method ' + name);
  const start = input.lastIndexOf('\n', location) + 1;
  const next = input.slice(location).search(/\n   (?:static )?(?:function|var) /);
  return input.slice(start, next < 0 ? undefined : location + next);
}

// Receipt support intentionally adds only a pending-read guard and an opt-in
// digest dispatch to BH_State. Remove those exact, single source fragments
// before checking the entire method against both frozen complete bridges.
// Any extra projection edit, missing guard, or duplicate fragment still fails.
function withoutReceiptStateAdapter(input) {
  let state = method(stripNativeProjectionScan(input), 'BH_State');
  const changes = [
    ['      if(b.snapshotReceiptBusy === true) return this.BH_ReceiptPoison("reentrant native snapshot projection");\n'
      + '      if(b.snapshotReceiptPending !== undefined && (refresh == true || forceFull == true))\n'
      + '         return this.BH_Fail("cannot replace a native snapshot before receipt readback");\n', ''],
    ['         var fast = b.snapshotReceiptRequest === undefined\n'
      + '            ? flash.external.ExternalInterface.call("boxheadDigestOriginalState",nativeState)\n'
      + '            : this.BH_ReceiptDigest(nativeState);',
    '         var fast = flash.external.ExternalInterface.call("boxheadDigestOriginalState",nativeState);'],
  ];
  for (const [before, after] of changes) {
    assert.equal(state.split(before).length - 1, 1, 'Receipt BH_State adapter must occur exactly once');
    state = state.replace(before, after);
  }
  return state;
}

// An explicit, limited AS2 dictionary model, not proof of native Ruffle.
// Pinned Ruffle: Object() is bare; new Object() has own hidden __proto__ and
// __constructor__; primitive __proto__ ends lookup; empty-name set is ignored.
// JavaScript object == undefined skips coercion, unlike pinned AVM1 Equals2.
// The separate cache-comparison adapter below therefore also models AVM1's
// missing valueOf -> undefined behavior. Neither adapter is native proof.
// ASCII case folding is used only by the legacy
// collision regression; no claim is made about modeling Flash Unicode folding.
function objectModel({ caseSensitive = true, polluted = false, bareAsUndefined = false } = {}) {
  const prototype = Object.create(Object.prototype);
  if (polluted) Object.assign(prototype, { mLife: true, mcHidden: false, _x: false, LastSound: false, ordinary: true });
  function create(constructed) {
    const data = Object.create(null);
    if (constructed) {
      Object.defineProperty(data, '__proto__', { value: prototype, writable: true });
      Object.defineProperty(data, '__constructor__', { value: AS2Object, writable: true, configurable: true });
    }
    const existing = key => {
      if (caseSensitive || typeof key !== 'string') return key;
      return Object.getOwnPropertyNames(data).find(name => name.toLowerCase() === key.toLowerCase()) ?? key;
    };
    const inherited = () => {
      const value = data[existing('__proto__')];
      return value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null;
    };
    return new Proxy(data, {
      get(target, key, receiver) {
        const own = existing(key);
        if (Object.hasOwn(target, own)) return Reflect.get(target, own, receiver);
        const parent = inherited();
        return parent === null ? undefined : Reflect.get(parent, key, receiver);
      },
      set(target, key, value) {
        if (key === '') return true;
        return Reflect.set(target, existing(key), value, target);
      },
      getPrototypeOf: inherited,
      getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, existing(key)),
      deleteProperty: (target, key) => Reflect.deleteProperty(target, existing(key)),
    });
  }
  function AS2Object() {
    if (new.target === undefined && bareAsUndefined) return undefined;
    return create(new.target !== undefined);
  }
  AS2Object.prototype = prototype;
  return AS2Object;
}

// Only the object/undefined comparisons relevant to cache presence and the
// diagnostic causal control are adapted. This follows pinned value.rs
// abstract_eq/to_primitive_num, rather than assuming JavaScript == semantics.
function as2LooseEqual(left, right) {
  const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true;
  if (object(left) && object(right)) return left === right;
  if (object(left)) {
    const valueOf = left.valueOf;
    const primitive = typeof valueOf === 'function' ? valueOf.call(left) : undefined;
    return !object(primitive) && as2LooseEqual(primitive, right);
  }
  if (object(right)) return as2LooseEqual(right, left);
  return left === right;
}

function adaptCacheEquality(source) {
  return source
    .replace(/\b(cache|fieldCache|bare|priorCache|savedCache)\s*==\s*undefined/g, 'as2LooseEqual($1, undefined)')
    .replace(/\b(cache|fieldCache|bare|priorCache|savedCache)\s*!=\s*undefined/g, '!as2LooseEqual($1, undefined)');
}

function harness(reference = false, options = {}) {
  const AS2Object = objectModel(options), marked = [];
  let digestCalls = 0, lastNative;
  const names = ['BH_SkipField', 'BH_SkipFieldUncached', 'BH_ProcessName', 'BH_Project', 'BH_Grid',
    'BH_Scalars', 'BH_FrameState', 'BH_State'];
  const input = reference === 'failed-v1' ? failedV1 : reference === true ? baseline : candidate;
  // The selected bridge delegates weapon scalars to its actual optional-kernel
  // adapter. These dictionary fixtures exercise that adapter's absent-kernel path.
  if (input === candidate) names.push('BH_ThingScalars', 'BH_NativeProject');
  const methods = names.map(name => method(name === 'BH_NativeProject' ? nativeProject : input, name)).join('\n') + '\n' + probe;
  const CMain = runInNewContext('(class CMain {\n' + adaptCacheEquality(methods)
    .replace(/static function ([A-Za-z_][A-Za-z_0-9]*)\(/g, 'static $1(')
    .replace(/(?<!static )function (BH_[A-Za-z_0-9]*)\(/g, '$1(')
    .replaceAll('value.mParent.mUniqueID', 'value.mParent?.mUniqueID') + '\n})', {
    Object: AS2Object, Array, Error, Math, String, Number, isFinite, isNaN, as2LooseEqual, getTimer: () => 0,
    ASSetPropFlags(target, key, set, clear) {
      assert.equal(key, '__bhSnapshotRef'); assert.equal(set, 1); assert.equal(clear, 0);
      const descriptor = Object.getOwnPropertyDescriptor(target, key); assert(descriptor);
      Object.defineProperty(target, key, { ...descriptor, enumerable: false }); marked.push(target);
    },
    flash: { external: { ExternalInterface: { call(name, native) {
      assert.equal(name, 'boxheadDigestOriginalState'); digestCalls++; lastNative = native;
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
  main.mBH = { active: true, state: 'playing', tick: 1, seed: 1, rng: 2, rngCalls: 3,
    settings: {}, mode: 'Coop', map: 'fixture', characters: [0, 1], initialPlayers: 2,
    lastFullDigest: 'native-v2-previous' };
  main.BH_Players = () => [];
  main.BH_Fail = message => { main.mBH.state = 'error'; return { error: message }; };
  CMain._this = main; CMain.mBHFieldCacheCount = 0;
  CMain.mInput = { mKey_List_Registered: [] };
  CMain.BH_Integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
  CMain.BH_PersonalEnabled = () => false;
  return { CMain, main, marked, AS2Object, digestCalls: () => digestCalls, lastNative: () => lastNative };
}

function project(h, value) {
  const context = { objects: [], errorPath: [], fields: 0 };
  try { return h.CMain.BH_Project(value, context, 'root', 0); }
  finally { for (const object of context.objects) delete object.__bhSnapshotRef; }
}

const specialKeys = ['mLife', 'mcHidden', 'mMap_Cells', 'mmap_cells', 'MLife', 'mLIFE', 'mDamage',
  '__proto__', '__PROTO__', 'constructor', 'Constructor', '__constructor__', '__CONSTRUCTOR__',
  'prototype', '__resolve', 'hasOwnProperty', 'isPrototypeOf', 'isPropertyEnumerable', 'toString',
  'toLocaleString', 'valueOf', 'watch', 'unwatch', 'addProperty', 'length', '0', '1', '01', '-1',
  '1.25', 'NaN', 'Infinity', '', 'field:mLife', 'field:__proto__', '_x', '_X', 'mcVisible',
  'McVisible', 'bmFrame', 'BmFrame', 'mXSI_Data', 'mxsi_data', 'LastSound', 'lastsound', 'SomeSample',
  'somesample', '$ref', '$length', '\u0000', '\u03a9', '\ud83d\udc7e'];

test('the independent policy oracle is the complete frozen 3256 bridge and the predicate is unchanged', () => {
  assert.equal(hash(baseline), '3256ea6338b76eaf71b204439cd14270d5045059cfdddbdd700676b310f37055');
  assert.equal(hash(failedV1), 'd8d14c3f6e4ea3aa908596314a2e3b9e1505ea9d3d3f1fedb0987ca5778b6e8a');
  assert.equal(hash(receiptBaseline), 'f982177c1f65edc41df73bb79c4a024e9b4523093fc0403a3b67bb9ed8207920');
  assert.equal(method(candidate, 'BH_SkipFieldUncached'), method(baseline, 'BH_SkipFieldUncached'));
  for (const name of ['BH_Grid', 'BH_ProcessName'])
    assert.equal(method(candidate, name), method(baseline, name), name + ' changed outside cache scope');
  assert.equal(method(receiptBaseline, 'BH_State'), method(baseline, 'BH_State'), 'Frozen f982 BH_State must equal frozen 3256');
  assert.equal(withoutReceiptStateAdapter(historicalCandidate), method(receiptBaseline, 'BH_State'), 'BH_State changed beyond the exact receipt adapter');
});

test('the AVM1 equality adapter reproduces failed native v1 count1 and strict presence preserves cached entries', () => {
  const failed = harness('failed-v1'), fixed = harness();
  const bare = failed.AS2Object(), constructed = new failed.AS2Object();
  assert.equal(typeof bare, 'object'); assert.notEqual(bare, undefined);
  assert.equal(as2LooseEqual(bare, undefined), true);
  assert.equal(as2LooseEqual(constructed, undefined), false);
  for (const h of [failed, fixed]) {
    assert.equal(h.CMain.BH_SkipField('__proto__'), true);
    const first = h.CMain.mBHFieldCache;
    assert.equal(h.CMain.BH_SkipField('mLife'), false);
    if (h === failed) {
      assert.notEqual(h.CMain.mBHFieldCache, first);
      assert.equal(h.CMain.mBHFieldCacheCount, 1);
      assert.equal(h.CMain.mBHFieldCache.__proto__, undefined);
    } else {
      assert.equal(h.CMain.mBHFieldCache, first);
      assert.equal(h.CMain.mBHFieldCacheCount, 2);
      assert.equal(h.CMain.mBHFieldCache.__proto__, true);
      assert.equal(h.CMain.mBHFieldCache.mLife, false);
    }
  }
});

test('raw special names match both frozen cached policy and unchanged uncached policy in either insertion order', () => {
  for (const keys of [specialKeys, [...specialKeys].reverse(), [...specialKeys.slice(6), ...specialKeys.slice(0, 6)]]) {
    const a = harness(true), b = harness();
    for (const key of [...keys, ...keys, ...keys]) {
      const expected = a.CMain.BH_SkipFieldUncached(key);
      assert.equal(a.CMain.BH_SkipField(key), expected, 'baseline ' + JSON.stringify(key));
      assert.equal(b.CMain.BH_SkipField(key), expected, 'candidate ' + JSON.stringify(key));
    }
    assert.equal(b.CMain.mBHFieldCache.__proto__, true);
    assert.equal(Object.getPrototypeOf(b.CMain.mBHFieldCache), null);
    assert.equal(b.CMain.mBHFieldCache.__constructor__, false);
    assert.equal(b.CMain.mBHFieldCache.hasOwnProperty, false);
    assert.equal(b.CMain.mBHFieldCache.__resolve, false);
  }
});

test('bare creation avoids own constructor false hits and inherited Boolean pollution', () => {
  const a = harness(true, { polluted: true }), b = harness(false, { polluted: true });
  const constructed = new b.AS2Object();
  assert.equal(Object.hasOwn(constructed, '__constructor__'), true);
  assert.equal(typeof constructed.__constructor__, 'function');
  assert.equal(constructed.mLife, true); assert.equal(constructed.mcHidden, false);
  assert.equal(b.CMain.BH_SkipField('mLife'), false);
  const cache = b.CMain.mBHFieldCache;
  assert.equal(Object.hasOwn(cache, '__proto__'), false);
  assert.equal(Object.hasOwn(cache, '__constructor__'), false);
  for (const key of ['mLife', 'mcHidden', '_x', 'LastSound', 'ordinary', '__constructor__'])
    assert.equal(b.CMain.BH_SkipField(key), a.CMain.BH_SkipField(key), key);
  assert.deepEqual(plain(b.CMain.BH_Scalars({ mLife: 9, mcHidden: 12, ordinary: 3, _x: 4, LastSound: 7 })),
    { mLife: 9, ordinary: 3 });
});

test('false cache hits retain their Boolean result without another policy evaluation or count increase', () => {
  const h = harness(), original = h.CMain.BH_SkipFieldUncached; let calls = 0;
  h.CMain.BH_SkipFieldUncached = key => { calls++; return original(key); };
  for (const key of ['mLife', '__constructor__', 'toString', '__resolve', '0']) {
    assert.equal(h.CMain.BH_SkipField(key), false);
    const count = h.CMain.mBHFieldCacheCount, before = calls;
    for (let n = 0; n < 12; n++) assert.equal(h.CMain.BH_SkipField(key), false);
    assert.equal(calls, before); assert.equal(h.CMain.mBHFieldCacheCount, count);
  }
});

test('the empty property name never creates a fictitious entry or churns the 1024-entry budget', () => {
  const h = harness();
  for (let n = 0; n < 20; n++) assert.equal(h.CMain.BH_SkipField(''), false);
  assert.equal(h.CMain.mBHFieldCache, undefined); assert.equal(h.CMain.mBHFieldCacheCount, 0);
  h.CMain.BH_SkipField('mLife'); const cache = h.CMain.mBHFieldCache, count = h.CMain.mBHFieldCacheCount;
  for (let n = 0; n < 1100; n++) assert.equal(h.CMain.BH_SkipField(''), false);
  assert.equal(h.CMain.mBHFieldCache, cache); assert.equal(h.CMain.mBHFieldCacheCount, count);
  assert.equal(Object.hasOwn(cache, ''), false);
});

test('distinct policy entries remain bounded and a reset preserves exact results for every key', () => {
  const a = harness(true), b = harness(); let previous, resets = 0;
  for (let n = 0; n < 2060; n++) {
    const key = n % 5 ? 'dynamic_' + n : 'mcDynamic_' + n;
    assert.equal(b.CMain.BH_SkipField(key), a.CMain.BH_SkipField(key));
    const current = b.CMain.mBHFieldCache;
    if (previous && previous !== current) resets++;
    previous = current;
    assert(b.CMain.mBHFieldCacheCount <= 1024);
    assert.equal(Object.keys(current).length, b.CMain.mBHFieldCacheCount);
  }
  assert.equal(resets, 2); assert.equal(b.CMain.mBHFieldCacheCount, 12);
});

test('scalar and recursive hot paths refresh their local reference after a helper reset', () => {
  for (const projection of ['scalar', 'recursive']) {
    const results = [true, false].map(reference => {
      const h = harness(reference);
      h.CMain.BH_SkipField('mLife'); h.CMain.BH_SkipField('mcHidden');
      h.CMain.mBHFieldCacheCount = 1024;
      const previous = h.CMain.mBHFieldCache;
      const object = { mLife: 9, mcHidden: 10, added: 11, OtherSample: 12, retained: 'yes' };
      const result = projection === 'scalar' ? h.CMain.BH_Scalars(object) : project(h, { object, z: { mLife: 13, mcHidden: 14 } });
      assert.notEqual(h.CMain.mBHFieldCache, previous); assert(h.CMain.mBHFieldCacheCount <= 1024);
      return plain(result);
    });
    assert.deepEqual(results[1], results[0], projection);
  }
});

test('own getter order, inherited rejection, current values and nonfinite tags match the frozen projector', () => {
  const runs = [true, false].map(reference => {
    const h = harness(reference), reads = [], prototype = {};
    Object.defineProperty(prototype, 'inherited', { enumerable: true, get() { throw new Error('inherited getter'); } });
    const object = Object.create(prototype), values = { mLife: 200, mcHidden: 7, ordinary: false, label: 'old', _x: 3, high: Infinity };
    for (const key of Object.keys(values)) Object.defineProperty(object, key, { configurable: true, enumerable: true,
      get() { reads.push(key); return values[key]; } });
    const first = plain(h.CMain.BH_Scalars(object));
    values.mLife = NaN; values.ordinary = true; values.label = 'new'; values.high = -Infinity;
    delete object._x; object.added = -0;
    const secondRaw = h.CMain.BH_Scalars(object), second = plain(secondRaw);
    assert(Object.is(secondRaw.added, -0));
    return { first, second, reads };
  });
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[1].reads, ['mLife', 'mcHidden', 'ordinary', 'label', '_x', 'high',
    'mLife', 'mcHidden', 'ordinary', 'label', 'high']);
  assert.equal(runs[1].second.label, 'new'); assert.deepEqual(runs[1].second.mLife, { $number: 'NaN' });
});

test('recursive cycles, lexical reference IDs, numeric names and undefined shadows remain identical', () => {
  const snapshots = [true, false].map(reference => {
    const h = harness(reference), shared = { mLife: 4, absent: undefined, n: -Infinity };
    const value = { '10': shared, '2': shared, '01': 7, '-1': -0, a: shared, mcHidden: shared,
      constructor: 123, __constructor__: 456, toString: 'native string', __resolve: false };
    Object.defineProperty(value, '__proto__', { value: shared, enumerable: true, configurable: true });
    shared.back = value;
    const result = project(h, value);
    assert.equal(result.__constructor__, 456);
    for (const object of [value, shared]) assert.equal(Object.hasOwn(object, '__bhSnapshotRef'), false);
    return plain(result);
  });
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[1]['10'].absent, { $undefined: 1 });
  assert.deepEqual(snapshots[1]['2'], { $ref: 1 });
});

function world(reference) {
  const h = harness(reference), functions = { walk() {}, hurt() {} }, animation = {};
  const thing = { _CLASSID_: 'FixtureThing', mUniqueID: 1, mLife: 200, active: true, label: 'alive', mcHidden: 7,
    Process: functions.walk, Process_Walk: functions.walk, Process_Hurt: functions.hurt,
    mPosition: { mX: 2, mY: 3, mZ: 0 }, mDelta: { mX: 0, mY: -0, mZ: 1 },
    mTarget_Direction: { mX: 1, mY: 0, mZ: 0 }, mReturn_Angle: { mX: 0, mY: 1, mZ: 0 },
    mAngle: { mAngle: 1 }, mTarget_Angle: { mAngle: 2 }, mParent: { mUniqueID: 9 },
    mXSI_Animation: { mCurrentFrameID: 0, mFrameCount: 2, mAnimEnd: false, mPreUpdate: false,
      mCollection: { mItems: { walk: { mAnimationObject: animation } } }, mAnimationObject: animation,
      mCurrentFrame: { XSI_Info: { XSI_Model_GunPosition_Right: { nPosition: { mX: 1, mY: 2, mZ: 0 } } } } },
    mWeaponList: [{ mActive: true, mNameID: 'pistol', mThing: { mAmmo: 17, mDamage: 4 } }],
  };
  thing.mWeapon_Current = thing.mWeaponList[0];
  h.main.mcWorld.mThing_Collection.mThings.t1 = thing;
  h.main.mcWorld.mUpgrades = { mLevel: 1, Level: { mAmount: 3 } };
  h.main.mcWorld.mHud = { mTotalScore: 0 };
  return { h, thing, functions };
}

test('whole compact/full/forced snapshots and per-entity resets preserve current world state and prior snapshots', () => {
  const worlds = [world(true), world(false)], saved = [];
  for (const tick of [1, 2, 24, 25, 26, 27]) {
    const snapshots = worlds.map(({ h, thing, functions }) => {
      h.main.mBH.tick = tick;
      if (tick === 2) {
        thing.mLife = NaN; thing.label = 'changed'; thing.mPosition.mX = -0;
        thing.Process = functions.hurt; thing.mWeaponList[0].mThing.mAmmo--;
        h.CMain.mBHFieldCacheCount = 1024;
      }
      if (tick === 24) { delete thing.mLife; thing.added = Infinity; }
      if (tick === 25) { thing.mXSI_Animation.mCurrentFrameID = 1; h.main.mcWorld.mHud.mTotalScore = 100; }
      if (tick === 26) { thing.mLife = 125; delete thing.added; thing.Process = functions.walk; }
      const result = h.main.BH_State(true, tick === 27);
      assert.equal(result.error, undefined);
      assert.equal(result.scope, tick === 25 || tick === 27 ? 'full' : 'frame');
      assert.equal(result.entities, result.native.entities);
      for (const object of h.marked) assert.equal(Object.hasOwn(object, '__bhSnapshotRef'), false);
      return result;
    });
    assert.deepEqual(plain(snapshots[1]), plain(snapshots[0]), 'tick ' + tick);
    for (const previous of saved) assert.equal(JSON.stringify(previous.value), previous.text);
    saved.push(...snapshots.map(value => ({ value, text: JSON.stringify(value) })));
  }
  for (const { h } of worlds) assert.equal(h.main.mBH.snapshot.tick, 26);
  const compact = worlds.map(({ h }) => h.main.BH_State(true));
  assert.deepEqual(plain(compact[1]), plain(compact[0])); assert.equal(compact[1].scope, 'frame');
  assert.equal(worlds[1].h.digestCalls(), worlds[0].h.digestCalls());
});

test('ASCII case-insensitive key collisions retain the old map result without introducing prototype lookup', () => {
  for (const keys of [['mLife', 'MLIFE', 'mcHidden', 'MCHIDDEN', '__PROTO__', '__proto__'],
    ['__proto__', '__PROTO__', 'MCHIDDEN', 'mcHidden', 'MLIFE', 'mLife']]) {
    const a = harness(true, { caseSensitive: false }), b = harness(false, { caseSensitive: false });
    for (const key of [...keys, ...keys]) assert.equal(b.CMain.BH_SkipField(key), a.CMain.BH_SkipField(key));
    assert.equal(Object.getPrototypeOf(b.CMain.mBHFieldCache), null);
  }
});

function menu(h) {
  h.main.mcWorld = undefined;
  h.main.mBH = { active: false, stepping: false, state: 'menu', tick: 0,
    seed: 17, rng: 23, rngCalls: 0, snapshot: { untouched: true } };
  h.CMain.BH_SkipField('savedField');
  return { bridge: h.main.mBH, snapshot: h.main.mBH.snapshot, cache: h.CMain.mBHFieldCache,
    count: h.CMain.mBHFieldCacheCount, cacheText: JSON.stringify(h.CMain.mBHFieldCache) };
}

test('the diagnostic probe checks native-shape controls and restores private cache and all witnesses on success', () => {
  const h = harness(), before = menu(h), result = h.main.BH_FieldCacheProbe();
  assert.equal(result.schema, 'original-field-policy-cache-native-probe-v2');
  assert.equal(result.pass, true); assert.equal(result.error, undefined);
  assert.equal(result.checks.length, 330); assert.equal(result.policyComparisons, 1338);
  assert.equal(result.maxCacheCount, 1024); assert.equal(result.capResets, 1);
  assert.deepEqual(plain(result.objectSemantics), { bareType: 'object', bareLooseUndefined: true,
    bareStrictUndefined: false, constructedType: 'object' });
  assert(result.checks.every(check => check.passed === true));
  assert(Object.values(result.restored).every(value => value === true)); assert.deepEqual(plain(result.after), plain(result.before));
  assert.equal(h.CMain.mBHFieldCache, before.cache); assert.equal(h.CMain.mBHFieldCacheCount, before.count);
  assert.equal(JSON.stringify(before.cache), before.cacheText);
  assert.equal(h.main.mBH, before.bridge); assert.equal(h.main.mBH.snapshot, before.snapshot);
});

test('the strengthened diagnostic rejects an undefined factory result before property-only controls can accept it', () => {
  const h = harness(false, { bareAsUndefined: true });
  h.main.mcWorld = undefined;
  h.main.mBH = { active: false, stepping: false, state: 'menu', tick: 0 };
  const saved = new h.AS2Object(); saved.savedField = false;
  h.CMain.mBHFieldCache = saved; h.CMain.mBHFieldCacheCount = 1;
  const result = h.main.BH_FieldCacheProbe();
  assert.equal(result.pass, false); assert.match(result.error, /bare_value_is_object/);
  assert.equal(result.policyComparisons, 0);
  assert(Object.values(result.restored).every(value => value === true));
  assert.equal(h.CMain.mBHFieldCache, saved); assert.equal(h.CMain.mBHFieldCacheCount, 1);
});

test('the diagnostic probe restores saved state after a policy failure and rejects an active world before cache work', () => {
  const h = harness(), before = menu(h), original = h.CMain.BH_SkipFieldUncached;
  h.CMain.BH_SkipFieldUncached = key => { if (key === '__proto__') throw new Error('injected policy failure'); return original(key); };
  const failed = h.main.BH_FieldCacheProbe();
  assert.equal(failed.pass, false); assert.match(failed.error, /injected policy failure/);
  assert(Object.values(failed.restored).every(value => value === true));
  assert.equal(h.CMain.mBHFieldCache, before.cache); assert.equal(JSON.stringify(before.cache), before.cacheText);
  h.CMain.BH_SkipFieldUncached = original; h.main.mBH.active = true; h.main.mcWorld = { untouched: true };
  const guarded = h.main.BH_FieldCacheProbe();
  assert.equal(guarded.pass, false); assert.equal(guarded.policyComparisons, 0); assert.match(guarded.error, /menu_only/);
  assert(Object.values(guarded.restored).every(value => value === true));
  assert.equal(h.CMain.mBHFieldCache, before.cache); assert.equal(h.CMain.mBHFieldCacheCount, before.count);
});
