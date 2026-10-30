import assert from 'node:assert/strict';
export { nativeProjectionCommand, rehashNativeProjection, verifyNativeProjectionPair }
  from './native-projection-scan-evidence.mjs';

const counters = ['calls', 'completed', 'unsupported', 'nodes', 'keys', 'ownReads'];

/** A fresh full projection must execute the new native traversal; a fallback
 * or the old scan-only witness cannot qualify the candidate. World equivalence
 * is independently checked by the unchanged actual-graph comparator. */
export function validateNativeProjectStats(value, previous, { zero = false, advanced = false } = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Candidate bhInfo lacks nativeProject');
  assert.deepEqual(Object.keys(value).sort(), ['version', 'contract', ...counters].sort(), 'Unexpected native project ABI');
  assert.equal(value.version, 1); assert.equal(value.contract, 'bh-native-project-v1');
  for (const key of counters) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid native project counter: ' + key);
    if (zero) assert.equal(value[key], 0, 'Native projector ran before fresh menu observation: ' + key);
    if (previous) assert(value[key] >= previous[key], 'Native project counter decreased: ' + key);
  }
  assert.equal(value.unsupported, 0, 'Actual native world projection used the legacy fallback');
  assert.equal(value.calls, value.completed, 'Native project call did not complete');
  assert(value.ownReads <= value.keys, 'Source reads exceed enumerated keys');
  if (advanced) {
    assert(previous, 'A previous execution witness is required');
    for (const key of ['calls', 'completed', 'nodes', 'keys', 'ownReads'])
      assert(value[key] > previous[key], 'Fresh full graph did not execute native traversal: ' + key);
  }
  return { ...value };
}
