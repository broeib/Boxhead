import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import test from 'node:test';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { stripNativeProjectionScan } from './helpers/native-projection-scan-source.mjs';

const source = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
// Authenticate loading metadata separately; current models keep the raw candidate.
const historicalSource = metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(source)));
const checkpoint = readFileSync(new URL('../../tools/original-bridge/CMain.checkpoint.asinc', import.meta.url), 'utf8');
const nativeProject = readFileSync(new URL('../../tools/original-bridge/CMain.native-project.asinc', import.meta.url), 'utf8');

function body(input, name) {
  const parsed = tokens(input);
  const start = parsed.findIndex((token, index) => !token.string && token.value === 'function' && parsed[index + 1]?.value === name);
  assert(start >= 0, 'Missing actual source method ' + name);
  let opening = start + 2;
  while (parsed[opening].value !== '{') opening++;
  let depth = 1, end = opening + 1;
  for (; depth; end++) if (!parsed[end].string) {
    if (parsed[end].value === '{') depth++;
    if (parsed[end].value === '}') depth--;
  }
  return input.slice(parsed[opening].end, parsed[end - 1].start);
}

// This exercises the actual AS2 adapter's control flow in a limited JS model.
// It does not implement a second scanner or attest AVM1 projection equivalence;
// the new Rust fixtures and two-independent-VM native A/B gate do that work.
function model(global = {}, input = source) {
  const CMain = { mBHFieldCache: undefined, mBHFieldCacheCount: 0, mInput: { mKey_List_Registered: [] }, mInitBGTasks: true };
  const instance = { mBH: { active: false, state: 'menu', tick: 0, error: '', stepping: false },
    mcScreen: { idScreen: 'Screen_Main', mNormal: true }, BH_MenuBounds: () => ({}) };
  CMain._this = instance;
  function ASObject() { return new.target ? {} : Object.create(null); }
  ASObject.prototype = Object.prototype;
  let digestCalls = 0;
  const flash = { external: { ExternalInterface: { call() { digestCalls++; throw new Error('unexpected native digest in control-flow fixture'); } } } };
  const World = { Map: { CMap_Cell: {}, CMap: {} } };
  const Thing = { CThing: {}, Math: { CThing_Position: {} } };
  function ASSetPropFlags(target, key, set, clear) {
    assert.equal(key, '__bhSnapshotRef'); assert.equal(set, 1); assert.equal(clear, 0);
    Object.defineProperty(target, key, { ...Object.getOwnPropertyDescriptor(target, key), enumerable: false });
  }
  function install(target, name, parameters, text = input) {
    const fn = new Function('CMain', '_global', 'Object', 'ASSetPropFlags', 'getTimer', 'flash', 'World', 'Thing',
      ...parameters, body(text, name).replaceAll('value.mParent.mUniqueID', 'value.mParent?.mUniqueID'));
    target[name] = function (...args) { return fn.call(this, CMain, global, ASObject, ASSetPropFlags, () => 0, flash, World, Thing, ...args); };
  }
  for (const [name, args] of [['BH_Integer', ['value', 'low', 'high']], ['BH_SkipField', ['key']],
    ['BH_SkipFieldUncached', ['key']], ['BH_ProcessName', ['value', 'suppliedProcess', 'hasSuppliedProcess']],
    ['BH_Project', ['value', 'context', 'path', 'depth']], ['BH_Grid', ['map']]]) install(CMain, name, args);
  for (const [name, args] of [['BH_ReceiptPoison', ['message']], ['BH_Info', []], ['BH_Fail', ['message']],
    ['BH_State', ['refresh', 'forceFull']]]) install(instance, name, args);
  install(instance, 'BH_CheckpointAvailable', [], checkpoint);
  if (input === source) {
    install(CMain, 'BH_NativeProjectionInfo', ['kernel']);
    install(instance, 'BH_NativeProjectionInstall', []);
    install(CMain, 'BH_NativeProject', ['root', 'context'], nativeProject);
  }
  CMain.BH_PersonalEnabled = () => false;
  const project = (value, kernel) => {
    const context = { objects: [], errorPath: [], fields: 0, projectionKernel: kernel };
    try { return { value: CMain.BH_Project(value, context, 'root', 0), context }; }
    finally { for (const object of context.objects) delete object.__bhSnapshotRef; }
  };
  return { CMain, instance, global, project, digestCalls: () => digestCalls };
}

const capability = (extra = {}) => ({ version: 1, contract: 'bh-projection-scan-v1',
  calls: 0, completed: 0, unsupported: 0, keys: 0, ownReads: 0, ...extra });
const reads = () => {
  const log = [];
  const value = { get mLife() { log.push('mLife'); return 12; },
    get mcHidden() { log.push('mcHidden'); return 8; }, get mActive() { log.push('mActive'); return true; } };
  return { value, log };
};

test('absent native scan and strict false retain the original traversal with the same output/cache', () => {
  for (const unsupported of [false, true]) {
    const h = model(), reference = model({}, stripNativeProjectionScan(historicalSource));
    const actual = reads(), expected = reads();
    let calls = 0, suppliedCache;
    const kernel = unsupported ? (operation, value, output, cache, owner, upgrades) => {
      calls++; assert.equal(operation, 'run'); assert.equal(value, actual.value); assert.equal(owner, h.CMain);
      assert.equal(upgrades, false); assert.deepEqual(output, {}); suppliedCache = cache;
      assert.equal(cache, h.CMain.mBHFieldCache); return false;
    } : undefined;
    const result = h.project(actual.value, kernel), old = reference.project(expected.value);
    assert.deepEqual(result.value, old.value); assert.equal(result.context.fields, old.context.fields);
    assert.deepEqual(actual.log, expected.log); assert.equal(calls, unsupported ? 1 : 0);
    if (unsupported) assert.equal(suppliedCache, h.CMain.mBHFieldCache);
    assert(!Object.hasOwn(actual.value, '__bhSnapshotRef'));
  }
});

test('successful scan envelopes and zero scalar fields bypass fallback without extra source reads', () => {
  const h = model(), actual = reads();
  const result = h.project(actual.value, (_operation, value, output) => {
    output.mLife = value.mLife; return { version: 1, scalarFields: 1, keys: undefined };
  });
  assert.deepEqual(result.value, { mLife: 12 }); assert.equal(result.context.fields, 1);
  assert.deepEqual(actual.log, ['mLife']);
  const zero = reads();
  assert.deepEqual(h.project(zero.value, () => ({ version: 1, scalarFields: 0, keys: undefined })).value, {});
  assert.deepEqual(zero.log, []);
});

test('deferred keys continue through the original AS2 recursion and field accounting', () => {
  const h = model(), child = { mLife: 9 };
  let childReads = 0, scans = 0;
  const root = { get child() { childReads++; return child; } };
  const result = h.project(root, (_operation, value, output) => {
    scans++;
    if (value === root) { void value.child; return { version: 1, scalarFields: 0, keys: ['child'] }; }
    assert.equal(value, child); output.mLife = value.mLife;
    return { version: 1, scalarFields: 1, keys: undefined };
  });
  assert.deepEqual(result.value, { child: { mLife: 9 } });
  assert.equal(childReads, 2); assert.equal(scans, 2);
  assert.equal(result.context.fields, 2); assert.equal(result.context.objects.length, 2);
  assert(!Object.hasOwn(root, '__bhSnapshotRef') && !Object.hasOwn(child, '__bhSnapshotRef'));
});

test('partial errors and malformed scan results are fatal and never repeat a source getter', () => {
  for (const answer of [undefined, null, true, 0, '0', {}, { version: 2, scalarFields: 1, keys: undefined },
    { version: 1, scalarFields: -1, keys: undefined }, { version: 1, scalarFields: 0.5, keys: undefined },
    { version: 1, scalarFields: NaN, keys: undefined }, { version: 1, scalarFields: 1 }]) {
    const h = model(), actual = reads();
    assert.throws(() => h.project(actual.value, (_operation, value) => { void value.mLife; return answer; }), /invalid native projection result/);
    assert.deepEqual(actual.log, ['mLife']); assert(!Object.hasOwn(actual.value, '__bhSnapshotRef'));
  }
  const h = model(), actual = reads(), sentinel = new Error('native scan failed');
  assert.throws(() => h.project(actual.value, (_operation, value) => { void value.mLife; throw sentinel; }), error => error === sentinel);
  assert.deepEqual(actual.log, ['mLife']);
});

test('optional installation and Info publish fresh real capability responses outside snapshots', () => {
  const absent = model(); absent.instance.BH_NativeProjectionInstall();
  assert.equal(absent.instance.mBH.nativeProjectionScanKernel, undefined);
  assert(!Object.hasOwn(absent.instance.BH_Info(), 'nativeProjectionScan'));
  let count = 0, calls = 0;
  const kernel = operation => { assert.equal(operation, 'capability'); calls++; return capability({ calls: count, completed: count }); };
  const h = model({ boxheadNativeProjectionScanV1: kernel });
  h.instance.BH_NativeProjectionInstall(); assert.equal(h.instance.mBH.nativeProjectionScanKernel, kernel);
  const first = h.instance.BH_Info().nativeProjectionScan;
  count = 3;
  const later = h.instance.BH_Info().nativeProjectionScan;
  assert.equal(first.completed, 0); assert.equal(later.completed, 3); assert.notEqual(first, later);
  assert.equal(calls, 3); assert.equal(h.digestCalls(), 0); assert.equal(h.instance.mBH.snapshot, undefined);
});

test('advertised bad capabilities and changed identity poison pending receipt evidence', () => {
  for (const value of [null, [], true, capability({ version: 2 }), capability({ unknown: 1 }),
    capability({ contract: 'wrong' }), capability({ calls: -1 }), capability({ calls: 0.5 }),
    capability({ ownReads: 1 }), capability({ completed: 1 }), capability({ calls: Infinity })]) {
    const h = model({ boxheadNativeProjectionScanV1: () => value });
    h.instance.mBH.snapshotReceiptPending = { old: true };
    h.instance.BH_NativeProjectionInstall();
    assert.equal(h.instance.mBH.state, 'error'); assert.equal(h.instance.mBH.snapshotReceiptPoisoned, true);
    assert.equal(h.instance.mBH.nativeProjectionScanKernel, undefined); assert.equal(h.instance.mBH.snapshotReceiptPending, undefined);
  }
  const h = model({ boxheadNativeProjectionScanV1: () => capability() });
  h.instance.BH_NativeProjectionInstall();
  for (const field of ['snapshotReceiptPending', 'snapshotReceiptRequest', 'snapshotReceiptProof']) h.instance.mBH[field] = { old: true };
  h.global.boxheadNativeProjectionScanV1 = () => capability();
  assert.equal(h.instance.BH_Info().state, 'error');
  for (const field of ['snapshotReceiptPending', 'snapshotReceiptRequest', 'snapshotReceiptProof']) assert.equal(h.instance.mBH[field], undefined);
});

test('full capture rejects a changed kernel identity before scanning or publishing a digest', () => {
  let scans = 0;
  const kernel = operation => { if (operation === 'capability') return capability(); scans++; throw new Error('must not scan'); };
  const h = model({ boxheadNativeProjectionScanV1: kernel }); h.instance.BH_NativeProjectionInstall();
  Object.assign(h.instance.mBH, { active: true, state: 'playing', tick: 25, initialPlayers: 2 });
  h.instance.mcWorld = { mThing_Collection: {}, mMap: { mCells: [] } };
  h.global.boxheadNativeProjectionScanV1 = () => capability();
  const result = h.instance.BH_State(true, true);
  assert.equal(result.state, 'error'); assert.match(result.error, /native projection kernel identity changed/);
  assert.equal(scans, 0); assert.equal(h.digestCalls(), 0); assert.equal(h.instance.mBH.snapshot, undefined);
});

test('historical comparisons reject missing, duplicated or edited optional adapter regions', () => {
  const stripped = stripNativeProjectionScan(historicalSource);
  assert(!stripped.includes('BH_NativeProjection') && !stripped.includes('nativeProjectionScan'));
  for (const changed of [historicalSource.replace('if(scanned !== false)', 'if(!scanned)'),
    historicalSource.replace('      this.BH_NativeProjectionInstall();\n', ''),
    historicalSource.replace('      this.BH_NativeProjectionInstall();\n', '      this.BH_NativeProjectionInstall();\n      this.BH_NativeProjectionInstall();\n'),
    historicalSource.replace('value.contract !== "bh-projection-scan-v1"', 'value.contract !== "wrong"')]) {
    assert.throws(() => stripNativeProjectionScan(changed));
  }
});
