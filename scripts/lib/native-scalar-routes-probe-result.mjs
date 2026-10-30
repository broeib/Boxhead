import assert from 'node:assert/strict';
import { validateScalarStats } from './native-scalar-probe-result.mjs';

export const SCALAR_ROUTES_PROBE_CASES = Object.freeze(['frame', 'frame-personal', 'frame-unsupported',
  'personal-compact', 'personal-full', 'personal-cache-reset', 'personal-getter-throw', 'personal-invalid-owner']);
const counters = ['calls', 'completed', 'unsupported', 'keys', 'ownReads'];
const restored = ['cacheIdentity', 'cacheCount', 'policyIdentity', 'personalIdentity', 'scalarIdentity',
  'mainIdentity', 'bridgeIdentity', 'worldIdentity', 'snapshotIdentity', 'kernelIdentity'];
const successfulCalls = { frame: 4, 'frame-personal': 10, 'frame-unsupported': 4,
  'personal-compact': 6, 'personal-full': 16, 'personal-cache-reset': 16 };

export function scalarRoutesProbeCheckNames() {
  const result = ['menu_only', 'native_capability'];
  for (const name of SCALAR_ROUTES_PROBE_CASES)
    for (const prefix of ['pair_output_', 'pair_log_', 'pair_error_', 'pair_cache_', 'native_path_', 'pair_digest_'])
      result.push(prefix + name);
  return result;
}

export function validateScalarRoutesProbe(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.schema, 'original-native-scalar-routes-private-probe-v1');
  assert.equal(value.pass, true); assert.equal(value.error, undefined);
  assert.equal(value.gameplayPassClaimed, false); assert.equal(value.engineBoundaryFixturesRequired, true);
  assert.deepEqual(value.checks.map(item => item.name), scalarRoutesProbeCheckNames());
  assert.equal(value.checks.length, 50); assert(value.checks.every(item => item.passed === true));
  assert.deepEqual(value.pairs.map(pair => pair.name), SCALAR_ROUTES_PROBE_CASES);
  const before = validateScalarStats(value.nativeBefore), after = validateScalarStats(value.nativeAfter);
  const sum = Object.fromEntries(counters.map(name => [name, 0]));
  for (const pair of value.pairs) {
    const a = pair.original, b = pair.native;
    const throwing = pair.name === 'personal-getter-throw' || pair.name === 'personal-invalid-owner';
    assert.equal(a.kind, pair.name); assert.equal(b.kind, pair.name);
    assert.equal(a.nativeRun, false); assert.equal(b.nativeRun, true);
    assert(Array.isArray(a.log) && a.log.length > 0); assert.deepEqual(b.log, a.log);
    assert(!b.log.some(line => /FORBIDDEN/.test(line)));
    assert.equal(typeof a.shape, 'string'); assert.equal(b.shape, a.shape);
    assert.equal(a.threw, throwing); assert.equal(b.threw, throwing); assert.equal(a.error, b.error);
    if (pair.name === 'personal-getter-throw') assert.equal(b.error, 'private-scalar-route-sentinel');
    else if (pair.name === 'personal-invalid-owner') assert.match(b.error, /invalid personal progression owner mapping/);
    else assert.equal(b.error, '');
    assert.equal(b.cacheCount, a.cacheCount); assert.equal(b.cacheReplaced, a.cacheReplaced);
    assert(Number.isSafeInteger(b.cacheCount) && b.cacheCount >= 0 && b.cacheCount <= 1024);
    assert.equal(typeof b.cacheReplaced, 'boolean');
    assert.equal(b.digests, a.digests); assert.equal(b.digests, pair.name.startsWith('frame') ? 1 : 0);
    assert.deepEqual(a.counterDelta, Object.fromEntries(counters.map(name => [name, 0])));
    assert.deepEqual(Object.keys(b.counterDelta).sort(), [...counters].sort());
    for (const name of counters) {
      assert(Number.isSafeInteger(b.counterDelta[name]) && b.counterDelta[name] >= 0); sum[name] += b.counterDelta[name];
    }
    assert(b.counterDelta.ownReads <= b.counterDelta.keys);
    const unsupported = pair.name === 'frame-unsupported' ? 1 : 0;
    assert.equal(b.counterDelta.unsupported, unsupported);
    if (pair.name === 'personal-invalid-owner') {
      assert.deepEqual(b.counterDelta, Object.fromEntries(counters.map(name => [name, 0])));
      assert(!b.log.includes('get:p1:classA:power'));
    } else {
      assert(b.counterDelta.calls > 0);
      if (pair.name === 'personal-getter-throw') assert.equal(b.counterDelta.completed + 1, b.counterDelta.calls);
      else {
        assert(b.counterDelta.ownReads > 0);
        assert.equal(b.counterDelta.calls, successfulCalls[pair.name]);
        assert.equal(b.counterDelta.completed, b.counterDelta.calls - unsupported);
      }
    }
    if (pair.name.startsWith('frame')) {
      for (const name of ['get:level:Zombie_Count', 'get:counters:CThing_Creature_Zombie',
        pair.name === 'frame-unsupported' ? 'get:arrayHud:mTotalScore' : 'get:hud:mTotalScore'])
        assert(b.log.includes(name), 'Missing actual selected source read: ' + name);
    }
    if (['personal-full', 'personal-cache-reset'].includes(pair.name)) {
      for (const name of ['original', 'activated', 'multipleKillEntries', 'levelState']) assert(b.shape.includes(':' + name + '='));
      assert(b.log.includes('get:p1:originalA:power')); assert(b.log.includes('get:p2:comboB:score'));
    }
    if (pair.name === 'personal-compact' || pair.name === 'frame-personal') {
      for (const name of ['original', 'activated', 'multipleKillEntries', 'levelState']) assert(!b.shape.includes(':' + name + '='));
      assert(!b.log.includes('get:p1:originalA:power')); assert(!b.log.includes('get:p2:comboB:score'));
    }
    if (pair.name === 'personal-full' || pair.name === 'personal-compact')
      for (const token of ['zero:-Infinity', '$number=string:3:NaN', '$number=string:8:Infinity']) assert(b.shape.includes(token));
    if (pair.name === 'personal-cache-reset') assert.equal(b.cacheReplaced, true);
  }
  for (const name of counters) assert.equal(after[name] - before[name], sum[name], 'Unaccounted native scalar work: ' + name);
  assert.deepEqual(Object.keys(value.restored).sort(), [...restored].sort());
  assert(restored.every(name => value.restored[name] === true));
  assert.deepEqual(value.after, value.before);
  assert.deepEqual(value.before, { active: 'false', stepping: 'false', state: 'menu', tick: '0', worldPresent: false });
  return { pairs: 8, checks: 50, nativeBefore: before, nativeAfter: after,
    scope: 'Actual compiled preceding/current scalar snapshot values and callback order on private objects; no gameplay, receipt, unload, timeout or FPS claim' };
}
