import assert from 'node:assert/strict';

export const NATIVE_SCALAR_CONTRACT = 'bh-scalars-thing-v1';
export const NATIVE_SCALAR_COUNTERS = ['calls', 'completed', 'unsupported', 'keys', 'ownReads'];

/** Pure validation of the already returned bhInfo field. No native callback,
 * projection, game state or expected value is created here. */
export function validateNativeScalarStats(value, tick, previous) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Missing actual nativeScalarKernel witness');
  assert.deepEqual(Object.keys(value).sort(), ['version', 'contract', ...NATIVE_SCALAR_COUNTERS].sort(),
    'Unexpected native scalar witness shape');
  assert.equal(value.version, 1); assert.equal(value.contract, NATIVE_SCALAR_CONTRACT);
  for (const key of NATIVE_SCALAR_COUNTERS) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid native scalar counter: ' + key);
    if (tick === 0) assert.equal(value[key], 0, 'Fresh tick-zero VM already ran the scalar kernel: ' + key);
    if (previous) assert(value[key] >= previous[key], 'Native scalar counter decreased: ' + key);
  }
  assert(value.ownReads <= value.keys, 'Native scalar ownReads exceeds visited keys');
  assert(value.completed + value.unsupported <= value.calls, 'Native scalar completion/fallback accounting exceeds calls');
  if (tick > 0 && tick % 25 !== 0) assert(value.completed > 0, 'No completed actual scalar kernel call by the first compact frame');
  return { ...value };
}
