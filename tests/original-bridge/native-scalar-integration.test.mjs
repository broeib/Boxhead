import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import test from 'node:test';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { stripNativeProjectionScan } from './helpers/native-projection-scan-source.mjs';
import { stripPresentationIntegration } from './helpers/presentation-integration-source.mjs';

const baseline = readFileSync(new URL('./fixtures/native-scalar-bridge-baseline.asinc', import.meta.url), 'utf8');
const candidate = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
// Authenticate loading metadata separately; current models keep the raw candidate.
const historicalCandidate = metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(candidate)));
const checkpointSource = readFileSync(new URL('../../tools/original-bridge/CMain.checkpoint.asinc', import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
function methods(source) {
  const parsed = tokens(source), found = new Map();
  for (let index = 0; index < parsed.length; index++) {
    if (parsed[index].string || parsed[index].value !== 'function') continue;
    const name = parsed[index + 1]?.value;
    if (!name?.startsWith('BH_')) continue;
    let start = index + 2;
    while (parsed[start].value !== '{') start++;
    let end = start + 1, depth = 1;
    for (; depth; end++) if (!parsed[end].string) {
      if (parsed[end].value === '{') depth++;
      if (parsed[end].value === '}') depth--;
    }
    assert(!found.has(name));
    found.set(name, source.slice(parsed[start].end, parsed[end - 1].start));
    index = end - 1;
  }
  return found;
}
const old = methods(baseline), changed = methods(candidate);
const scalarOnly = methods(stripPresentationIntegration(stripNativeProjectionScan(historicalCandidate)));
const checkpoint = methods(checkpointSource);
// This is a control-flow/source model, not proof of AVM1/Rust semantics.
// The actual compiled private-object probe and engine fixtures are separate.
function model(source = changed, global = {}) {
  const CMain = { mBHFieldCache: undefined, mBHFieldCacheCount: 0, mInput: {}, mInitBGTasks: true };
  function ASObject() { return new.target ? {} : Object.create(null); }
  ASObject.prototype = Object.prototype;
  const install = (owner, name, parameters, methodSource = source) => {
    const body = methodSource.get(name); assert.equal(typeof body, 'string');
    const fn = new Function('CMain', '_global', 'Object', ...parameters, body);
    owner[name] = function (...args) { return fn.call(this, CMain, global, ASObject, ...args); };
  };
  for (const [name, args] of [
    ['BH_Integer', ['value', 'low', 'high']], ['BH_SkipField', ['key']], ['BH_SkipFieldUncached', ['key']],
    ['BH_Scalars', ['object']],
  ]) install(CMain, name, args);
  const instance = { mBH: { active: false, state: 'menu', tick: 0, error: '', stepping: false },
    mcScreen: { idScreen: 'Screen_Main', mNormal: true }, BH_MenuBounds: () => ({}) };
  CMain._this = instance;
  install(instance, 'BH_ReceiptPoison', ['message']);
  install(instance, 'BH_Info', []);
  if (source === changed) {
    // BH_Info now consults the actual checkpoint capability method. Include
    // that source collaborator; a constant stub would hide capability bugs.
    install(instance, 'BH_CheckpointAvailable', [], checkpoint);
    install(CMain, 'BH_NativeScalarInfo', ['kernel']);
    install(CMain, 'BH_NativeScalarString', ['value']);
    install(CMain, 'BH_ThingScalars', ['object', 'kernel']);
    install(instance, 'BH_NativeScalarInstall', []);
  }
  return { CMain, instance, global };
}
const capability = (extra = {}) => ({ version: 1, contract: 'bh-scalars-thing-v1',
  calls: 0, completed: 0, unsupported: 0, keys: 0, ownReads: 0, ...extra });
const sourceWithReads = () => {
  const log = [], value = { get mLife() { log.push('mLife'); return 12; },
    get mcHidden() { log.push('mcHidden'); return true; },
    get mProbe() { log.push('mProbe'); return false; } };
  return { value, log };
};

test('exact57c baseline and all nonintegration methods remain byte-identical', () => {
  assert.equal(sha(baseline), '57c3b5da941bca71009c5b30bb265053eb39a309dc1f75850933cd6cc5aad94a');
  const permitted = new Set(['BH_Install', 'BH_Info', 'BH_FrameState']);
  for (const [name, body] of old) if (!permitted.has(name)) assert.equal(scalarOnly.get(name), body, name);
  assert.deepEqual([...scalarOnly.keys()].filter(name => !old.has(name)),
    ['BH_NativeScalarInstall', 'BH_NativeScalarInfo', 'BH_NativeScalarString', 'BH_ThingScalars']);
  assert(changed.get('BH_Install').includes('this.BH_NativeScalarInstall();'));
  assert.equal((changed.get('BH_FrameState').match(/BH_ThingScalars\(weapon\.mThing,kernel\)/g) ?? []).length, 1);
  assert.equal((changed.get('BH_FrameState').match(/kernel\("run",thing,scalars,fieldCache,CMain\)/g) ?? []).length, 1);
  for (const [name, body] of changed) if (name !== 'BH_FrameState' && name !== 'BH_ThingScalars')
    assert(!body.includes('kernel("run"'), 'Unexpected accelerated caller: ' + name);
});

test('historical comparison removes only exact additive presentation hooks in their original transaction positions', () => {
  const source = stripNativeProjectionScan(historicalCandidate);
  for (const changedSource of [
    source.replace('         this.BH_PresentationBegin();\n', ''),
    source.replace('         this.BH_PresentationBegin();\n', '         this.BH_PresentationBegin();\n         this.BH_PresentationBegin();\n'),
    source.replace('         this.BH_PresentationBegin();\n         CMain.mInput.BH_ApplyMasks(p1Mask,p2Mask);',
      '         CMain.mInput.BH_ApplyMasks(p1Mask,p2Mask);\n         this.BH_PresentationBegin();'),
    source.replace('         this.BH_PresentationEnd(tick);', '         this.BH_PresentationEnd(tick + 1);'),
  ]) assert.throws(() => stripPresentationIntegration(changedSource), /presentation integration/);
  const alteredOriginalStep = source.replace('         this.State_RunWorld(true);', '         this.State_RunWorld(false);');
  assert.notEqual(methods(stripPresentationIntegration(alteredOriginalStep)).get('BH_Step'), old.get('BH_Step'),
    'An original gameplay change must survive normalization and fail the historical byte comparison');
});

test('absent capability preserves legacy output/read order and has no Info witness', () => {
  const { CMain, instance } = model();
  instance.BH_NativeScalarInstall();
  assert.equal(instance.mBH.nativeScalarKernel, undefined);
  assert.equal(Object.hasOwn(instance.BH_Info(), 'nativeScalarKernel'), false);
  const actual = sourceWithReads(), expected = sourceWithReads();
  assert.deepEqual(CMain.BH_ThingScalars(actual.value, undefined), model(old).CMain.BH_Scalars(expected.value));
  assert.deepEqual(actual.log, expected.log);
});

test('valid capability installs once and Info observes fresh native counters', () => {
  let capCalls = 0, reads = 0;
  const kernel = operation => { assert.equal(operation, 'capability'); capCalls++; return capability({ calls: reads, completed: reads }); };
  const { instance } = model(changed, { boxheadNativeScalarsV1: kernel });
  instance.BH_NativeScalarInstall();
  assert.equal(instance.mBH.nativeScalarKernel, kernel); assert.equal(capCalls, 1);
  const zero = instance.BH_Info().nativeScalarKernel;
  reads = 3;
  const later = instance.BH_Info().nativeScalarKernel;
  assert.equal(zero.completed, 0); assert.equal(later.completed, 3); assert.equal(capCalls, 3);
  assert.notEqual(zero, later);
});

test('advertised malformed capability poisons before a source traversal', () => {
  for (const value of [null, [], true, capability({ version: 2 }), capability({ unknown: 0 }),
    capability({ calls: NaN }), capability({ calls: -1 }), capability({ calls: 1.5 }),
    capability({ completed: 1 }), capability({ ownReads: 1 }), capability({ contract: 'wrong' })]) {
    const { instance } = model(changed, { boxheadNativeScalarsV1: () => value });
    instance.BH_NativeScalarInstall();
    assert.equal(instance.mBH.state, 'error'); assert.equal(instance.mBH.snapshotReceiptPoisoned, true);
    assert.equal(instance.mBH.nativeScalarKernel, undefined);
  }
  const { instance } = model(changed, { boxheadNativeScalarsV1: 1 });
  instance.BH_NativeScalarInstall(); assert.equal(instance.mBH.state, 'error');
});

test('changed identity or malformed later witness clears pending receipt evidence', () => {
  let response = capability();
  const global = { boxheadNativeScalarsV1: () => response };
  const { instance } = model(changed, global);
  instance.BH_NativeScalarInstall();
  instance.mBH.snapshotReceiptPending = { stale: true };
  response = capability({ ownReads: 2, keys: 1 });
  assert.equal(instance.BH_Info().state, 'error');
  assert.equal(instance.mBH.snapshotReceiptPending, undefined);
  const other = model(changed, { boxheadNativeScalarsV1: () => capability() });
  other.instance.BH_NativeScalarInstall(); other.global.boxheadNativeScalarsV1 = () => capability();
  assert.equal(other.instance.BH_Info().state, 'error');
});

test('supported run receives original owner/cache/output and never enters fallback', () => {
  const { CMain } = model(), { value, log } = sourceWithReads();
  let calls = 0;
  const result = CMain.BH_ThingScalars(value, (operation, source, output, cache, owner) => {
    calls++; assert.equal(operation, 'run'); assert.equal(source, value); assert.equal(owner, CMain);
    assert.equal(cache, CMain.mBHFieldCache); assert.equal(Object.getPrototypeOf(cache), null);
    assert.equal(CMain.mBHFieldCacheCount, 0); assert.deepEqual(output, {});
    output.mLife = source.mLife; return 1;
  });
  assert.deepEqual(result, { mLife: 12 }); assert.equal(calls, 1); assert.deepEqual(log, ['mLife']);
  let touched = 0;
  const zero = CMain.BH_ThingScalars({ get mLife() { touched++; return 4; } }, () => 0);
  assert.deepEqual(zero, {}); assert.equal(touched, 0, 'Numeric zero is completed, never unsupported');
});

test('strict false alone uses the old loop once with the already-created cache', () => {
  const { CMain } = model(), actual = sourceWithReads(), expected = sourceWithReads();
  let suppliedCache, calls = 0;
  const result = CMain.BH_ThingScalars(actual.value, (_op, _source, output, cache) => {
    calls++; suppliedCache = cache; assert.deepEqual(output, {}); return false;
  });
  assert.deepEqual(result, model(old).CMain.BH_Scalars(expected.value));
  assert.deepEqual(actual.log, expected.log); assert.equal(calls, 1);
  assert.equal(suppliedCache, CMain.mBHFieldCache);
});

test('malformed results and native throws after a read cannot retry the source', () => {
  for (const answer of [undefined, null, true, -1, 0.5, NaN, Infinity, '0', {}]) {
    const { CMain } = model(), actual = sourceWithReads();
    assert.throws(() => CMain.BH_ThingScalars(actual.value, (_op, source) => {
      void source.mLife; return answer;
    }), /invalid native scalar result/);
    assert.deepEqual(actual.log, ['mLife']);
  }
  const { CMain } = model(), actual = sourceWithReads(), sentinel = new Error('native callback failed');
  assert.throws(() => CMain.BH_ThingScalars(actual.value, (_op, source) => {
    void source.mLife; throw sentinel;
  }), error => error === sentinel);
  assert.deepEqual(actual.log, ['mLife']);
});

test('legacy fallback refreshes a real1024-entry policy cache reset identically', () => {
  for (const nativeAnswer of [undefined, () => false]) {
    const actual = model(), expected = model(old);
    for (let index = 0; index < 1023; index++) {
      actual.CMain.BH_SkipField('prime' + index); expected.CMain.BH_SkipField('prime' + index);
    }
    const prior = actual.CMain.mBHFieldCache, value = { resetA: 1, resetB: 2, resetC: 3 };
    assert.deepEqual(actual.CMain.BH_ThingScalars(value, nativeAnswer), expected.CMain.BH_Scalars(value));
    assert.notEqual(actual.CMain.mBHFieldCache, prior);
    assert.equal(actual.CMain.mBHFieldCacheCount, 2);
    assert.equal(actual.CMain.mBHFieldCacheCount, expected.CMain.mBHFieldCacheCount);
  }
});

test('fallback accessor failures preserve the original stop point', () => {
  const observe = (CMain, invoke) => {
    const calls = [], sentinel = new Error('getter failed');
    const object = { get a() { calls.push('a'); return 1; }, get b() { calls.push('b'); throw sentinel; },
      get c() { calls.push('c'); return 3; } };
    assert.throws(() => invoke(CMain, object), error => error === sentinel);
    return calls;
  };
  assert.deepEqual(observe(model().CMain, (CMain, object) => CMain.BH_ThingScalars(object, () => false)),
    observe(model(old).CMain, (CMain, object) => CMain.BH_Scalars(object)));
});
