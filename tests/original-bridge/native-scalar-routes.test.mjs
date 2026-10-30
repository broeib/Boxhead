import { secondaryV2Predecessor } from './helpers/membership-secondary-v2-source.mjs';
import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { secondaryPredecessor } from './helpers/membership-secondary-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import test from 'node:test';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { stripCompactStepBridge } from '../../scripts/lib/native-compact-step-source.mjs';
import { SCALAR_ROUTES_BASE_PINS, stripScalarRoutesBridge, stripScalarRoutesBridgeBeforeCompact, stripScalarRoutesProgression,
  scalarRoutesReferenceMethods } from '../../scripts/lib/native-scalar-routes-source.mjs';

const bridge = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
// Authenticate loading metadata separately; current models keep the raw candidate.
const historicalBridge = metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(bridge)));
const progression = readFileSync(new URL('../../tools/original-bridge/CMain.progression.asinc', import.meta.url), 'utf8');
const oldBridge = stripScalarRoutesBridge(historicalBridge), oldProgression = stripScalarRoutesProgression(secondaryPredecessor('tools/original-bridge/CMain.progression.asinc', secondaryV2Predecessor('tools/original-bridge/CMain.progression.asinc', progression)));
const sha = source => createHash('sha256').update(source).digest('hex');
function body(source, name) {
  const parsed = tokens(source);
  const start = parsed.findIndex((item, index) => !item.string && item.value === 'function' && parsed[index + 1]?.value === name);
  assert(start >= 0, name);
  let opening = start + 2;
  while (parsed[opening].value !== '{') opening++;
  let end = opening + 1, depth = 1;
  for (; depth; end++) if (!parsed[end].string) {
    if (parsed[end].value === '{') depth++; if (parsed[end].value === '}') depth--;
  }
  return source.slice(parsed[opening].end, parsed[end - 1].start);
}

// Execute the actual AS2 function bodies as a control-flow model. Native VM
// semantics are independently checked by the compiled scalar-routes callback.
function harness({ previous = false, kernel } = {}) {
  const CMain = { mInput: { mKey_List_Registered: [] } };
  const global = kernel === undefined ? {} : { boxheadNativeScalarsV1: kernel };
  function ASObject() { return new.target ? {} : Object.create(null); }
  ASObject.prototype = Object.prototype;
  let digests = 0;
  const flash = { external: { ExternalInterface: { call() { throw new Error('Unexpected external digest'); } } } };
  const World = { Map: { CMap_Cell: {}, CMap: {} } }, Thing = { CThing: {}, Math: { CThing_Position: {} } };
  function install(owner, name, args, source) {
    const fn = new Function('CMain', '_global', 'Object', 'Array', 'getTimer', 'flash', 'World', 'Thing', ...args, body(source, name));
    owner[name] = function (...values) { return fn.call(this, CMain, global, ASObject, Array, () => 0, flash, World, Thing, ...values); };
  }
  for (const [name, args] of [['BH_Integer', ['value', 'low', 'high']], ['BH_SkipField', ['key']],
    ['BH_SkipFieldUncached', ['key']], ['BH_Scalars', ['object']], ['BH_ThingScalars', ['object', 'kernel']]])
    install(CMain, name, args, bridge);
  install(CMain, 'BH_PersonalSnapshot', ['full', 'scalarKernel'], previous ? oldProgression : progression);
  CMain.BH_PersonalEnabled = () => true;
  CMain.BH_Grid = () => 'private-grid'; CMain.BH_NativeProject = root => root;
  const main = { mBH: { active: true, state: 'playing', tick: 25, initialPlayers: 2, nativeScalarKernel: kernel,
    seed: 1, rng: 2, rngCalls: 3, lastFullDigest: 'previous', snapshotReceiptRequest: {} },
    BH_Players: () => [], BH_Fail: error => ({ state: 'error', error }),
    BH_ReceiptDigest() { digests++; return { digest: 'native-v2-0123456789abcdef', bytes: 1 }; } };
  CMain._this = main;
  for (const name of ['BH_FrameState', 'BH_State']) install(main, name,
    name === 'BH_State' ? ['refresh', 'forceFull'] : [], previous ? oldBridge : bridge);
  return { CMain, main, global, digests: () => digests };
}

function fixture(log, h) {
  const objects = new Map();
  const scalar = (name, fields) => {
    const proto = {};
    Object.defineProperty(proto, 'inherited', { enumerable: true, get() { throw new Error('Inherited getter'); } });
    const object = Object.create(proto); objects.set(name, object);
    Object.defineProperty(object, 'hasOwnProperty', { value(key) {
      log.push('own:' + name + ':' + key); return Object.prototype.hasOwnProperty.call(this, key);
    } });
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(object, key, { enumerable: true, configurable: true,
      get() { log.push('get:' + name + ':' + key); return value; } });
    return object;
  };
  const records = [];
  for (let slot = 1; slot <= 2; slot++) {
    const original = scalar('original' + slot, { damage: 5, zero: -0 });
    const stats = scalar('class' + slot, { damage: 10, nan: NaN, mOriginalStats: original });
    const level = scalar('personalLevel' + slot, { Zombie_Count: 7 });
    const combo = scalar('combo' + slot, { score: 30 });
    const owner = { _CLASSID_: 'CThing_Creature_Player', mPlayerIndex: slot - 1, mUniqueID: slot * 100 };
    const upgrades = scalar('personalUpgrades' + slot, { mBHOwnerSlot: slot, CThing_Weapon_Pistol: stats,
      mWorld: { mThing_Collection: { mPlayerThings: { owner } } }, Level: level,
      mMultipliers: [[{ mActive: false }, { mActive: true }]], mMultipleKills: { double: [combo] }, tick: 4 });
    records.push({ slot, score: slot * 20, kills: slot, level: 2, initialized: true, upgrades });
  }
  const level = scalar('level', { Zombie_Count: 11 });
  const upgrades = scalar('upgrades', { Level: level, mLevelIndex: 3 });
  const hud = scalar('hud', { score: 99 });
  const counters = scalar('counters', { CThing_Creature_Zombie: 2 });
  h.main.mcWorld = { mTick: 25, mUpgrades: upgrades, mHud: hud, mBHPersonalProgress: records, mMap: {},
    mThing_Collection: { mThings: {}, mThingCounters: counters, mPlayerThings: {} } };
  return objects;
}

test('exact scalar-callsite normalization restores both complete predecessor files and unchanged scalar/world logic', () => {
  assert.equal(sha(oldBridge), SCALAR_ROUTES_BASE_PINS.bridge);
  assert.equal(sha(oldProgression), SCALAR_ROUTES_BASE_PINS.progression);
  for (const name of ['BH_Scalars', 'BH_ThingScalars', 'BH_Project', 'BH_Grid'])
    assert.equal(body(bridge, name), body(oldBridge, name), name);
  const fullWorld = source => body(source, 'BH_State').split('      var world = new Object();')[1].split('      var rng =')[0];
  assert.equal(fullWorld(bridge), fullWorld(oldBridge));
  const references = scalarRoutesReferenceMethods(historicalBridge, secondaryPredecessor('tools/original-bridge/CMain.progression.asinc', secondaryV2Predecessor('tools/original-bridge/CMain.progression.asinc', progression)), tokens);
  assert.equal(body(references, 'BH_ScalarRoutesOriginalFrame'), body(oldBridge, 'BH_FrameState'));
  assert.equal(body(references, 'BH_ScalarRoutesOriginalPersonal'), body(oldProgression, 'BH_PersonalSnapshot'));
});

test('missing, duplicated and changed scalar routes fail normalization while unrelated changes remain visible', () => {
  const predecessor = stripCompactStepBridge(historicalBridge);
  for (const changed of [
    predecessor.replace('CMain.BH_ThingScalars(w.mHud,kernel)', 'CMain.BH_Scalars(w.mHud)'),
    predecessor.replace('CMain.BH_ThingScalars(w.mHud,kernel)', 'CMain.BH_ThingScalars(w.mHud,undefined)'),
    predecessor.replace('CMain.BH_ThingScalars(w.mHud,kernel)', 'CMain.BH_ThingScalars(w.mHud,kernel),CMain.BH_ThingScalars(w.mHud,kernel)'),
    predecessor.replace('_global.boxheadNativeScalarsV1 !== personalScalarKernel', '_global.boxheadNativeScalarsV1 != personalScalarKernel'),
  ]) assert.throws(() => stripScalarRoutesBridgeBeforeCompact(changed), /Exact scalar route/);
  for (const changed of [progression.replace('BH_PersonalSnapshot(full, scalarKernel)', 'BH_PersonalSnapshot(full)'),
    progression.replace('CMain.BH_ThingScalars(upgrades[key],scalarKernel)', 'CMain.BH_Scalars(upgrades[key])')])
    assert.throws(() => stripScalarRoutesProgression(changed), /Exact scalar route/);
  const wrongOwner = progression.replace('ownerCount != 1', 'ownerCount < 1');
  assert.notEqual(sha(stripScalarRoutesProgression(wrongOwner)), SCALAR_ROUTES_BASE_PINS.progression);
  assert.throws(() => scalarRoutesReferenceMethods(historicalBridge, wrongOwner, tokens), /predecessor changed/);
});

test('absent and strict-false kernels preserve personal/full and compact values, cache behavior and source read order', () => {
  for (const kind of ['frame', 'personal-compact', 'personal-full']) for (const enabled of [false, true]) {
    let calls = 0;
    const kernel = enabled ? () => { calls++; return false; } : undefined;
    const before = harness({ previous: true, kernel }), after = harness({ kernel });
    const left = [], right = []; fixture(left, before); fixture(right, after);
    const run = h => kind === 'frame' ? h.main.BH_FrameState().native : h.CMain.BH_PersonalSnapshot(kind === 'personal-full', kernel);
    assert.deepEqual(run(after), run(before)); assert.deepEqual(right, left);
    assert.equal(after.CMain.mBHFieldCacheCount, before.CMain.mBHFieldCacheCount);
    assert.equal(calls, enabled ? kind === 'frame' ? 8 : kind === 'personal-full' ? 10 : 4 : 0);
  }
});

test('new compact and personal routes receive the exact selected objects and retain all full-only data', () => {
  for (const kind of ['frame', 'personal-full']) {
    let h; const seen = [];
    const kernel = (operation, object, output, cache, owner) => {
      assert.equal(operation, 'run'); assert.equal(owner, h.CMain); assert.equal(cache, h.CMain.mBHFieldCache);
      seen.push(object); Object.assign(output, h.CMain.BH_Scalars(object)); return 0;
    };
    h = harness({ kernel }); const objects = fixture([], h);
    const result = kind === 'frame' ? h.main.BH_FrameState().native.personal : h.CMain.BH_PersonalSnapshot(true, kernel);
    const names = [...objects].filter(([, object]) => seen.includes(object)).map(([name]) => name).sort();
    assert.deepEqual(names, kind === 'frame'
      ? ['class1', 'class2', 'counters', 'hud', 'level', 'personalUpgrades1', 'personalUpgrades2', 'upgrades']
      : ['class1', 'class2', 'combo1', 'combo2', 'original1', 'original2', 'personalLevel1', 'personalLevel2', 'personalUpgrades1', 'personalUpgrades2']);
    assert.equal(seen.length, names.length, 'Each selected snapshot traverses once');
    for (const row of result) {
      assert.equal(row.ownerID, row.slot * 100); assert.equal(row.ownerSlot, row.slot);
      if (kind === 'personal-full') {
        assert.deepEqual(row.activated, [[0, 0, false], [0, 1, true]]);
        assert.equal(row.classes.CThing_Weapon_Pistol.original.damage, 5);
        assert.equal(row.multipleKillEntries.double[0].score, 30); assert.equal(row.levelState.Zombie_Count, 7);
      } else assert.equal(Object.hasOwn(row, 'activated'), false);
    }
  }
});

test('selected scalar failures never retry a partially read source or publish a full snapshot digest', () => {
  for (const invalid of [undefined, null, 0.5, -1, '0']) {
    let calls = 0;
    const kernel = (_operation, object) => { calls++; void object.damage; return invalid; };
    const h = harness({ kernel }), log = []; fixture(log, h);
    assert.throws(() => h.CMain.BH_PersonalSnapshot(false, kernel), /invalid native scalar result/);
    assert.equal(calls, 1); assert.equal(log.filter(line => line === 'get:class1:damage').length, 1);
  }
  let calls = 0;
  const sentinel = new Error('partial selected scalar failure');
  const h = harness({ kernel: () => { calls++; throw sentinel; } }); fixture([], h);
  const result = h.main.BH_State(true, true);
  assert.equal(result.state, 'error'); assert.match(result.error, /partial selected scalar failure/);
  assert.equal(calls, 1); assert.equal(h.digests(), 0); assert.equal(h.main.mBH.snapshot, undefined);
});

test('both compact and full callers reject a replaced scalar identity before selected source traversal', () => {
  for (const full of [false, true]) {
    let calls = 0;
    const h = harness({ kernel: () => { calls++; return false; } }); fixture([], h);
    h.global.boxheadNativeScalarsV1 = () => false;
    h.CMain.BH_PersonalSnapshot = () => { throw new Error('Personal traversal reached'); };
    if (full) assert.match(h.main.BH_State(true, true).error, /native scalar kernel identity changed/);
    else assert.throws(() => h.main.BH_FrameState(), /native scalar kernel identity changed/);
    assert.equal(calls, 0); assert.equal(h.digests(), 0);
  }
});
