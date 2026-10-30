import assert from 'node:assert/strict';

export const SCALAR_PROBE_CASES = ['scalars', 'nonfinite-and-negative-zero', 'special-and-case-keys', 'getter-mutation',
  'hasOwn-mutation', 'hasOwn-accessor', 'hasOwn-replacement', 'policy-replacement', 'cache-hit', 'cache-reset',
  'getter-throw', 'hasOwn-throw', 'setter-throw', 'policy-throw'];
export const SCALAR_PROBE_BAD_ARGS = ['arity', 'source-output-alias', 'cache-output-alias', 'null-owner',
  'array-output', 'undefined-cache', 'operation'];
export const SCALAR_PROBE_RESTORED = ['cacheIdentity', 'cacheCount', 'policyIdentity', 'stringHelperIdentity',
  'bridgeIdentity', 'worldIdentity', 'snapshotIdentity', 'kernelIdentity'];
const counters = ['calls', 'completed', 'unsupported', 'keys', 'ownReads'];
export function validateScalarStats(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['version', 'contract', ...counters].sort());
  assert.equal(value.version, 1); assert.equal(value.contract, 'bh-scalars-thing-v1');
  for (const key of counters) assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid counter: ' + key);
  assert(value.completed + value.unsupported <= value.calls); assert(value.ownReads <= value.keys);
  return value;
}
export function scalarProbeCheckNames() {
  const names = ['menu_only', 'native_capability'];
  for (const name of SCALAR_PROBE_CASES) {
    for (const prefix of ['pair_log_', 'pair_output_', 'pair_reads_', 'pair_cache_', 'pair_error_', 'native_path_']) names.push(prefix + name);
    if (name === 'cache-reset') names.push('actual_cache_reset');
    if (name === 'nonfinite-and-negative-zero') names.push('nonfinite_tags_and_signed_zero');
  }
  for (let index = 0; index < 4; index++) names.push('unsupported_before_read_' + index);
  for (const name of SCALAR_PROBE_BAD_ARGS) names.push('malformed_before_read_' + name);
  names.push('conversion_throw_before_tag_write');
  for (let index = 0; index < 9; index++) names.push('invalid_result_no_retry_' + index);
  return [...names, 'unsupported_fallback_once', 'absent_hook_legacy_once', 'actual_native_completed'];
}
export function validateNativeScalarProbe(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.schema, 'original-native-scalar-private-probe-v1');
  assert.equal(value.pass, true); assert.equal(value.error, undefined);
  assert.equal(value.engineBoundaryFixturesRequired, true);
  assert.equal(value.timeoutProvenHere, false); assert.equal(value.baseClipRemovalProvenHere, false);
  assert.deepEqual(value.checks.map(check => check.name), scalarProbeCheckNames());
  assert.equal(value.checks.length, 112); assert(value.checks.every(check => check.passed === true));
  assert.deepEqual(value.pairs.map(pair => pair.name), SCALAR_PROBE_CASES);
  const before = validateScalarStats(value.nativeBefore), after = validateScalarStats(value.nativeAfter);
  for (const key of counters) assert.equal(before[key], 0, 'Expected a fresh native kernel before the menu-only probe');
  let successful = 0, keys = 0, reads = 0;
  for (const pair of value.pairs) {
    const a = pair.original, b = pair.native, throwing = pair.name.endsWith('-throw');
    assert.equal(a.kind, pair.name); assert.equal(b.kind, pair.name);
    assert.equal(a.nativeRun, false); assert.equal(b.nativeRun, true);
    assert(Array.isArray(a.log) && a.log.length > 0 && Array.isArray(a.shape));
    assert.deepEqual(b.log, a.log); assert.deepEqual(b.shape, a.shape);
    assert(!b.log.includes('INHERITED_GETTER_MUST_NOT_RUN'));
    assert.equal(b.reads, a.reads); assert(Number.isSafeInteger(b.reads) && b.reads >= 0);
    assert.equal(b.returnedReads, a.returnedReads);
    assert.equal(a.threw, throwing); assert.equal(b.threw, throwing);
    assert.equal(a.sentinel, throwing); assert.equal(b.sentinel, throwing);
    assert.equal(a.error, throwing ? 'private-scalar-sentinel' : ''); assert.equal(b.error, a.error);
    assert.equal(b.returnedReads, throwing ? 'undefined' : String(b.reads));
    assert.equal(b.cacheCount, a.cacheCount); assert.equal(b.cacheReplaced, a.cacheReplaced);
    assert(Number.isInteger(b.cacheCount) && b.cacheCount >= 0 && b.cacheCount <= 1024);
    assert.deepEqual(a.counterDelta, { calls: 0, completed: 0, unsupported: 0, keys: 0, ownReads: 0 });
    assert.equal(b.counterDelta.calls, 1); assert.equal(b.counterDelta.completed, throwing ? 0 : 1);
    assert.equal(b.counterDelta.unsupported, 0); assert.equal(b.counterDelta.ownReads, b.reads);
    assert(Number.isSafeInteger(b.counterDelta.keys) && b.counterDelta.keys >= b.reads);
    if (!throwing) successful++;
    keys += b.counterDelta.keys; reads += b.reads;
    if (pair.name === 'cache-reset') { assert.equal(b.cacheCount, 2); assert.equal(b.cacheReplaced, true); }
    if (pair.name === 'hasOwn-accessor') assert(b.log.includes('method:get'));
    if (pair.name === 'hasOwn-replacement') assert(b.log.some(line => line.startsWith('own2:')));
    if (pair.name === 'policy-replacement') assert(b.log.some(line => line.startsWith('policy2:')));
    if (pair.name === 'nonfinite-and-negative-zero') {
      const shape = b.shape.join('\n');
      for (const token of ['$number:NaN', '$number:Infinity', '$number:-Infinity',
        'mProbeNegativeZero:number:0:reciprocal=-Infinity', 'mProbeZero:number:0:reciprocal=Infinity']) assert(shape.includes(token));
    }
  }
  assert.equal(value.unsupported.length, 4);
  for (const [index, row] of value.unsupported.entries()) {
    assert.equal(row.index, index); assert.equal(row.returnedFalse, true);
    assert.equal(row.touched, 0); assert.equal(row.outputFields, 0);
    assert.deepEqual(row.counterDelta, { calls: 1, completed: 0, unsupported: 1, keys: 0, ownReads: 0 });
  }
  assert.deepEqual(value.invalidArguments.map(row => row.name), SCALAR_PROBE_BAD_ARGS);
  for (const row of value.invalidArguments) {
    assert.equal(row.rejected, true); assert.equal(row.touched, 0);
    assert.equal(row.keysDelta, 0); assert.equal(row.ownReadsDelta, 0);
  }
  assert.equal(value.invalidResults.length, 9);
  for (const [index, row] of value.invalidResults.entries()) {
    assert.equal(row.index, index); assert.equal(row.rejected, true); assert.equal(row.sourceReads, 1);
  }
  assert.equal(after.calls, SCALAR_PROBE_CASES.length + 4 + 1);
  assert.equal(after.completed, successful); assert.equal(after.unsupported, 4);
  assert.equal(after.keys, keys + 1); assert.equal(after.ownReads, reads + 1);
  assert.deepEqual(Object.keys(value.restored).sort(), [...SCALAR_PROBE_RESTORED].sort());
  assert(SCALAR_PROBE_RESTORED.every(key => value.restored[key] === true));
  assert.deepEqual(value.after, value.before);
  assert.equal(value.before.active, 'false'); assert.equal(value.before.stepping, 'false');
  assert.equal(value.before.state, 'menu'); assert.equal(value.before.tick, '0'); assert.equal(value.before.worldPresent, false);
  return { pairs: value.pairs.length, checks: value.checks.length, unsupported: 4, malformedArguments: 7,
    invalidResults: 9, nativeBefore: before, nativeAfter: after,
    scope: 'Actual private AVM1 scalar semantics; no gameplay, native snapshot equivalence, timeout, unload or speed claim' };
}
