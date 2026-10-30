import assert from 'node:assert/strict';

export const PROJECT_PROBE_CASES = Object.freeze(['graph', 'deferred-getter-change', 'getter-mutation',
  'policy-replacement', 'cache-reset', 'key-coercion-order', 'map-getter-order', 'cell-getter-order',
  'animation', 'animation-shadow', 'upgrades', 'string-opcode', 'getter-throw', 'deferred-getter-throw',
  'marker-collision', 'field-budget', 'active-scan', 'active-scan-validation', 'active-scan-integer-throw',
  'active-scan-own-throw', 'active-scan-nonfinite-throw', 'active-scan-envelope-mutation', 'active-scan-unsupported']);
const counters = ['calls', 'completed', 'unsupported', 'nodes', 'keys', 'ownReads'];
const scanCounters = ['calls', 'completed', 'unsupported', 'keys', 'ownReads'];
const restored = ['cacheIdentity', 'cacheCount', 'policyIdentity', 'processIdentity', 'projectorIdentity',
  'integerIdentity', 'scalarStringIdentity', 'ownIdentity', 'sortIdentity', 'stringIdentity',
  'bridgeIdentity', 'worldIdentity', 'snapshotIdentity', 'kernelIdentity'];
export function validateProjectStats(value, previous) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['version', 'contract', ...counters].sort());
  assert.equal(value.version, 1); assert.equal(value.contract, 'bh-native-project-v1');
  for (const key of counters) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid native project counter: ' + key);
    if (previous) assert(value[key] >= previous[key], 'Native project counter decreased: ' + key);
  }
  assert(value.completed + value.unsupported <= value.calls); assert(value.ownReads <= value.keys);
  return value;
}
export function validateFrozenScanStats(value, previous) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['version', 'contract', ...scanCounters].sort());
  assert.equal(value.version, 1); assert.equal(value.contract, 'bh-projection-scan-v1');
  for (const name of scanCounters) {
    assert(Number.isSafeInteger(value[name]) && value[name] >= 0);
    if (previous) assert(value[name] >= previous[name]);
  }
  assert(value.completed + value.unsupported <= value.calls); assert(value.ownReads <= value.keys);
  return value;
}
export function projectProbeCheckNames() {
  const names = ['menu_only', 'native_capability'];
  for (const name of PROJECT_PROBE_CASES)
    for (const prefix of ['pair_log_', 'pair_output_', 'pair_error_', 'pair_accounting_', 'pair_cache_', 'cleanup_', 'native_path_', 'pair_scan_'])
      names.push(prefix + name);
  return names;
}

export function validateNativeProjectProbe(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.schema, 'original-native-project-private-probe-v1');
  assert.equal(value.pass, true); assert.equal(value.error, undefined);
  assert.equal(value.gameplayPassClaimed, false); assert.equal(value.engineBoundaryFixturesRequired, true);
  assert.deepEqual(value.checks.map(item => item.name), projectProbeCheckNames());
  assert.equal(value.checks.length, 186); assert(value.checks.every(item => item.passed === true));
  assert.deepEqual(value.pairs.map(pair => pair.name), PROJECT_PROBE_CASES);
  const before = validateProjectStats(value.nativeBefore), after = validateProjectStats(value.nativeAfter, before);
  const scanBefore = validateFrozenScanStats(value.scanBefore), scanAfter = validateFrozenScanStats(value.scanAfter, scanBefore);
  for (const name of counters) assert.equal(before[name], 0, 'Menu-only probe requires a fresh native projector');
  for (const name of scanCounters) assert.equal(scanBefore[name], 0, 'Menu-only probe requires a fresh frozen scanner');
  const sum = Object.fromEntries(counters.map(name => [name, 0]));
  const scanSum = Object.fromEntries(scanCounters.map(name => [name, 0]));
  for (const pair of value.pairs) {
    const original = pair.original, native = pair.native;
    const activeScan = pair.name.startsWith('active-scan');
    const throwing = ['getter-throw', 'deferred-getter-throw', 'marker-collision', 'field-budget',
      'active-scan-integer-throw', 'active-scan-own-throw', 'active-scan-nonfinite-throw'].includes(pair.name);
    assert.equal(original.kind, pair.name); assert.equal(native.kind, pair.name);
    assert.equal(original.nativeRun, false); assert.equal(native.nativeRun, true);
    assert(Array.isArray(original.log) && Array.isArray(native.log));
    assert.deepEqual(native.log, original.log); assert(!native.log.some(line => /FORBIDDEN/.test(line)));
    assert.equal(typeof original.shape, 'string'); assert.equal(native.shape, original.shape);
    assert.equal(original.threw, throwing); assert.equal(native.threw, throwing);
    assert.equal(native.error, original.error);
    if (pair.name.endsWith('getter-throw') || (activeScan && throwing)) assert.equal(native.error, 'private-project-sentinel');
    else if (pair.name === 'marker-collision') assert.match(native.error, /snapshot marker collision/);
    else if (pair.name === 'field-budget') assert.match(native.error, /native snapshot budget exceeded at root/);
    else assert.equal(native.error, '');
    assert.equal(native.objects, original.objects); assert.equal(native.fields, original.fields);
    assert(Number.isSafeInteger(native.objects) && native.objects >= 0);
    if (pair.name === 'active-scan-envelope-mutation') assert.equal(native.fields, '04');
    else assert(Number.isSafeInteger(native.fields) && native.fields >= 0);
    assert.equal(original.cleanup, true); assert.equal(native.cleanup, true);
    assert.equal(native.cacheCount, original.cacheCount); assert.equal(native.cacheReplaced, original.cacheReplaced);
    assert(Number.isSafeInteger(native.cacheCount) && native.cacheCount >= 0 && native.cacheCount <= 1024);
    assert.deepEqual(original.counterDelta, Object.fromEntries(counters.map(name => [name, 0])));
    assert.deepEqual(Object.keys(native.counterDelta).sort(), [...counters].sort());
    for (const name of counters) {
      assert(Number.isSafeInteger(native.counterDelta[name]) && native.counterDelta[name] >= 0);
      sum[name] += native.counterDelta[name];
    }
    assert.equal(native.counterDelta.calls, 1); assert.equal(native.counterDelta.completed, throwing ? 0 : 1);
    assert.equal(native.counterDelta.unsupported, 0); assert.equal(native.counterDelta.nodes, native.objects);
    assert(native.counterDelta.ownReads <= native.counterDelta.keys);
    assert.deepEqual(native.scanCounterDelta, original.scanCounterDelta);
    for (const arm of [original, native]) {
      assert.deepEqual(Object.keys(arm.scanCounterDelta).sort(), [...scanCounters].sort());
      for (const name of scanCounters) {
        assert(Number.isSafeInteger(arm.scanCounterDelta[name]) && arm.scanCounterDelta[name] >= 0);
        scanSum[name] += arm.scanCounterDelta[name];
      }
    }
    if (!activeScan) assert.deepEqual(native.scanCounterDelta, Object.fromEntries(scanCounters.map(name => [name, 0])));
    else if (pair.name === 'active-scan-unsupported') {
      assert.deepEqual(native.scanCounterDelta, { calls: 1, completed: 0, unsupported: 1, keys: 0, ownReads: 0 });
      assert.equal(native.counterDelta.keys, 1); assert.equal(native.counterDelta.ownReads, 1);
      assert(!native.log.some(line => line.startsWith('integer:') || line === 'envelope-own'));
    } else {
      assert(native.scanCounterDelta.calls > 0); assert.equal(native.scanCounterDelta.unsupported, 0);
      assert.equal(native.counterDelta.keys, native.scanCounterDelta.keys);
      assert.equal(native.counterDelta.ownReads, native.scanCounterDelta.ownReads);
      if (pair.name !== 'active-scan') {
        if (pair.name !== 'active-scan-nonfinite-throw') assert(native.log.some(line => line.startsWith('integer:')));
        if (!['active-scan-integer-throw', 'active-scan-nonfinite-throw'].includes(pair.name)) assert(native.log.includes('envelope-own'));
        if (pair.name !== 'active-scan-envelope-mutation') assert(native.log.some(line => line.startsWith('nonfinite:')));
      }
    }
    if (pair.name === 'cache-reset') assert.equal(native.cacheReplaced, true);
    if (pair.name === 'policy-replacement') assert(native.log.some(line => line.startsWith('policy2:')));
    if (pair.name === 'key-coercion-order') {
      const length = native.log.indexOf('key:length'), primitive = native.log.indexOf('key:valueOf');
      const string = native.log.indexOf('key:toString'), child = native.log.lastIndexOf('get:alpha');
      assert(length >= 0 && length < primitive && primitive < string && string < child,
        'Diagnostic path coercions must precede the deferred source getter');
    }
    if (pair.name === 'animation-shadow') {
      assert(native.shape.includes('$animation=number:2:88'));
      assert(native.shape.includes('$parentID=number:2:99'));
      assert(native.shape.includes('$ref=number:1:2'));
      assert.equal(native.objects, 3);
    }
    if (pair.name === 'graph' || pair.name === 'string-opcode') {
      for (const text of ['zero:-Infinity', '$number=string:3:NaN', '$number=string:8:Infinity']) assert(native.shape.includes(text));
    }
  }
  assert.equal(sum.calls, 23); assert.equal(sum.completed, 16); assert.equal(sum.unsupported, 0);
  for (const name of counters) assert.equal(after[name], sum[name]);
  for (const name of scanCounters) assert.equal(scanAfter[name], scanSum[name]);
  assert.deepEqual(Object.keys(value.restored).sort(), [...restored].sort());
  assert(restored.every(name => value.restored[name] === true));
  assert.deepEqual(value.after, value.before);
  assert.equal(value.before.active, 'false'); assert.equal(value.before.stepping, 'false');
  assert.equal(value.before.state, 'menu'); assert.equal(value.before.tick, '0'); assert.equal(value.before.worldPresent, false);
  return { pairs: value.pairs.length, checks: value.checks.length, nativeBefore: before, nativeAfter: after,
    scanBefore, scanAfter,
    scope: 'Actual compiled AS2/native private projection semantics; no gameplay, timeout, unload or FPS claim' };
}
