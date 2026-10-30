import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { stripCompactStepBridge } from '../../scripts/lib/native-compact-step-source.mjs';
import { stripNativeProject, stripNativeProjectBeforeCompact } from './helpers/native-project-source.mjs';

const bridge = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
// Authenticate loading metadata separately; current models keep the raw candidate.
const historicalBridge = metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(bridge)));
const adapter = readFileSync(new URL('../../tools/original-bridge/CMain.native-project.asinc', import.meta.url), 'utf8');
const checkpoint = readFileSync(new URL('../../tools/original-bridge/CMain.checkpoint.asinc', import.meta.url), 'utf8');
function body(source, name) {
  const list = tokens(source);
  const first = list.findIndex((item, index) => !item.string && item.value === 'function' && list[index + 1]?.value === name);
  assert(first >= 0, 'Missing actual method ' + name);
  let opening = first + 2;
  while (list[opening].value !== '{') opening++;
  let depth = 1, end = opening + 1;
  for (; depth; end++) if (!list[end].string) {
    if (list[end].value === '{') depth++;
    if (list[end].value === '}') depth--;
  }
  return source.slice(list[opening].end, list[end - 1].start);
}
const capability = (change = {}) => ({ version: 1, contract: 'bh-native-project-v1',
  calls: 0, completed: 0, unsupported: 0, nodes: 0, keys: 0, ownReads: 0, ...change });

// Actual adapter and transaction code with small world collaborators. This is
// a control-flow regression; Rust and compiled-private-probe gates establish
// AVM1 equivalence, and separate browser measurements establish performance.
function model(kernel) {
  const global = kernel === undefined ? {} : { boxheadNativeProjectV1: kernel };
  const CMain = { mInput: { mKey_List_Registered: [] }, mInitBGTasks: true };
  const main = { mBH: { active: false, state: 'menu', tick: 0, error: '', stepping: false },
    mcScreen: { idScreen: 'Screen_Main', mNormal: true }, BH_MenuBounds: () => ({}) };
  CMain._this = main; global.CMain = CMain;
  function ASObject() { return new.target ? {} : Object.create(null); }
  ASObject.prototype = Object.prototype;
  function flags(target, names, set, clear) {
    assert.equal(clear, 0);
    for (const name of names.split(',')) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name); assert(descriptor);
      Object.defineProperty(target, name, { ...descriptor, enumerable: !(set & 1), configurable: !(set & 2), writable: !(set & 4) });
    }
  }
  let digests = 0;
  const flash = { external: { ExternalInterface: { call(_name, native) {
    digests++; return { digest: 'native-v2-0123456789abcdef', bytes: JSON.stringify(native).length };
  } } } };
  const World = { Map: { CMap_Cell: {}, CMap: {} } };
  const Thing = { CThing: {}, Math: { CThing_Position: {} } };
  function install(owner, name, args, source = bridge) {
    const fn = new Function('CMain', '_global', 'Object', 'ASSetPropFlags', 'getTimer', 'flash', 'World', 'Thing',
      ...args, body(source, name).replaceAll('value.mParent.mUniqueID', 'value.mParent?.mUniqueID'));
    owner[name] = function (...values) { return fn.call(this, CMain, global, ASObject, flags, () => 0, flash, World, Thing, ...values); };
  }
  for (const [name, args] of [['BH_Integer', ['value', 'low', 'high']], ['BH_SkipField', ['key']],
    ['BH_SkipFieldUncached', ['key']], ['BH_ProcessName', ['value', 'suppliedProcess', 'hasSuppliedProcess']],
    ['BH_Project', ['value', 'context', 'path', 'depth']], ['BH_Grid', ['map']]]) install(CMain, name, args);
  for (const [name, args] of [['BH_ReceiptPoison', ['message']], ['BH_Info', []], ['BH_Fail', ['message']],
    ['BH_State', ['refresh', 'forceFull']]]) install(main, name, args);
  install(main, 'BH_CheckpointAvailable', [], checkpoint);
  install(CMain, 'BH_NativeProjectInfo', ['kernel'], adapter);
  install(CMain, 'BH_NativeProject', ['root', 'context'], adapter);
  install(main, 'BH_NativeProjectInstall', [], adapter);
  CMain.BH_PersonalEnabled = () => false; main.BH_Players = () => [];
  return { CMain, main, global, digests: () => digests };
}
function playing(h, entity) {
  Object.assign(h.main.mBH, { active: true, state: 'playing', tick: 25, initialPlayers: 2 });
  h.main.mcWorld = { mThing_Collection: { mThings: { entity }, mPlayerThings: {}, mDeleteThings: {},
    mRespawnPlayer: {}, mThingCounters: {} },
    mMap: { _CLASSID_: 'CMap', mSize: { x: 1, y: 1 }, mCells: [], mCollide: { mCollideFlag: false } } };
}

test('normalization removes only the three exact bulk-projector hooks', () => {
  const predecessor = stripCompactStepBridge(historicalBridge);
  const normalized = stripNativeProject(historicalBridge);
  assert.equal(createHash('sha256').update(normalized).digest('hex'),
    'fdbfc2cfe07ca6f47a3ae0fbb325d3a322f01592b3c99db48a6d6887b436c1d3');
  assert.equal(body(normalized, 'BH_Project'), body(bridge, 'BH_Project'));
  for (const changed of [predecessor.replace('this.BH_NativeProjectInstall();', ''),
    predecessor.replace('this.BH_NativeProjectInstall();', 'this.BH_NativeProjectInstall();\n      this.BH_NativeProjectInstall();'),
    predecessor.replace('CMain.BH_NativeProject(root,context);', 'CMain.BH_NativeProject(root,context,0);'),
    predecessor.replace('result.nativeProject =', 'result.nativeProjectChanged =')]) assert.throws(() => stripNativeProjectBeforeCompact(changed));
  const changedGameplay = predecessor.replace('this.State_RunWorld(true);', 'this.State_RunWorld(false);');
  assert.notEqual(body(stripNativeProjectBeforeCompact(changedGameplay), 'BH_Step'), body(normalized, 'BH_Step'));
});

test('authenticated predecessor normalization rejects unrelated gameplay mutation before historical hook tests', () => {
  const mutated = historicalBridge.replace('this.State_RunWorld(true);', 'this.State_RunWorld(false);');
  assert.throws(() => stripNativeProject(mutated), /Exact full-stage bridge predecessor/);
  const authenticated = stripCompactStepBridge(historicalBridge);
  const historical = authenticated.replace('this.State_RunWorld(true);', 'this.State_RunWorld(false);');
  assert.notEqual(body(stripNativeProjectBeforeCompact(historical), 'BH_Step'),
    body(stripNativeProject(historicalBridge), 'BH_Step'));
});

test('absence and strict false retain exactly one fresh legacy projection and finally cleanup', () => {
  for (const enabled of [false, true]) {
    let runs = 0, reads = 0;
    const kernel = operation => { if (operation === 'capability') return capability(); runs++; return false; };
    const h = model(enabled ? kernel : undefined); h.main.BH_NativeProjectInstall();
    const entity = { get n() { reads++; return 9; } }; playing(h, entity);
    const result = h.main.BH_State(true, true);
    assert.equal(result.scope, 'full'); assert.equal(result.native.entities.entity.n, 9);
    assert.equal(reads, 1); assert.equal(runs, enabled ? 1 : 0); assert.equal(h.digests(), 1);
    assert(!Object.hasOwn(entity, '__bhSnapshotRef'));
    assert.equal(Object.hasOwn(h.main.BH_Info(), 'nativeProject'), enabled);
  }
});

test('successful native envelopes return their exact value without reading or retrying the source', () => {
  const value = { exact: true }; let runs = 0;
  let h;
  const kernel = (operation, root, context, owner) => {
    if (operation === 'capability') return capability();
    runs++; assert.equal(owner, h.CMain); assert.equal(context.nativeProjectOwner, owner);
    assert.equal(context.nativeProjectFunction, owner.BH_Project);
    return { version: 1, value };
  };
  h = model(kernel); h.main.BH_NativeProjectInstall();
  const root = { get forbidden() { throw new Error('source touched by wrapper'); } };
  assert.equal(h.CMain.BH_NativeProject(root, {}), value); assert.equal(runs, 1);
  const owner = h.main.mBH.nativeProjectOwner, original = h.main.mBH.nativeProjectFunction;
  assert.equal(Reflect.set(h.main.mBH, 'nativeProjectOwner', {}), false);
  assert.equal(Reflect.set(h.main.mBH, 'nativeProjectFunction', () => {}), false);
  assert.equal(h.main.mBH.nativeProjectOwner, owner); assert.equal(h.main.mBH.nativeProjectFunction, original);
});

test('partial throws and malformed results remain fatal with actual BH_State marker cleanup and no digest', () => {
  for (const answer of [undefined, null, true, 0, '', [], {}, { version: 2, value: {} }, { version: 1 }]) {
    let reads = 0, runs = 0;
    const kernel = (operation, root, context) => {
      if (operation === 'capability') return capability();
      runs++; const entity = root.entities.entity;
      entity.__bhSnapshotRef = 0; context.objects.push(entity); void entity.n;
      return answer;
    };
    const h = model(kernel); h.main.BH_NativeProjectInstall();
    const entity = { get n() { reads++; return 7; } }; playing(h, entity);
    const result = h.main.BH_State(true, true);
    assert.equal(result.state, 'error'); assert.match(result.error, /invalid native project result/);
    assert.equal(runs, 1); assert.equal(reads, 1); assert.equal(h.digests(), 0);
    assert(!Object.hasOwn(entity, '__bhSnapshotRef'));
  }
  let calls = 0;
  const sentinel = new Error('partial native failure');
  const h = model(operation => { if (operation === 'capability') return capability(); calls++; throw sentinel; });
  h.main.BH_NativeProjectInstall();
  assert.throws(() => h.CMain.BH_NativeProject({}, {}), error => error === sentinel);
  assert.equal(calls, 1);
});

test('invalid capabilities and changed registered identity poison pending native receipt evidence', () => {
  for (const response of [null, [], true, capability({ version: 2 }), capability({ extra: 1 }),
    capability({ contract: 'wrong' }), capability({ calls: -1 }), capability({ nodes: 0.5 }),
    capability({ ownReads: 1 }), capability({ completed: 1 })]) {
    const h = model(() => response);
    h.main.mBH.snapshotReceiptPending = {};
    h.main.BH_NativeProjectInstall();
    assert.equal(h.main.mBH.state, 'error'); assert.equal(h.main.mBH.snapshotReceiptPoisoned, true);
    assert.equal(h.main.mBH.nativeProjectKernel, undefined); assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  }
  const h = model(() => capability()); h.main.BH_NativeProjectInstall();
  for (const name of ['snapshotReceiptPending', 'snapshotReceiptProof', 'snapshotReceiptRequest']) h.main.mBH[name] = {};
  h.global.boxheadNativeProjectV1 = () => capability();
  assert.equal(h.main.BH_Info().state, 'error');
  for (const name of ['snapshotReceiptPending', 'snapshotReceiptProof', 'snapshotReceiptRequest']) assert.equal(h.main.mBH[name], undefined);
});
