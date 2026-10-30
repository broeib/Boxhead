import assert from 'node:assert/strict';

export const NATIVE_SCALAR_COLD_SCHEMA = 'original-cold-native-scalar-observation-v1';

/** Injected by source. Observes one existing bhInfo return; never invokes EI,
 * resets counters, reads world objects, or supplies an ACK. */
export function createNativeScalarInfoObserver() {
  const fields = ['version', 'contract', 'calls', 'completed', 'unsupported', 'keys', 'ownReads'];
  const counters = fields.slice(2);
  let instance = null, previous = null, previousTick = -1, initial = null;
  function require(condition, message) { if (!condition) throw new Error(message); }
  function data(object, key) {
    require(object && typeof object === 'object' && !Array.isArray(object), 'Native scalar observation needs an object');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    require(descriptor && Object.hasOwn(descriptor, 'value'), 'Native scalar observation requires own data field: ' + key);
    return descriptor.value;
  }
  function observe(info, context) {
    require(Number.isSafeInteger(context.instance) && context.instance > 0
      && Number.isFinite(context.at) && context.at >= 0 && Number.isFinite(context.ms) && context.ms >= 0,
    'Invalid native scalar callback context');
    // OriginalBridge legitimately polls an unregistered callback before menu
    // readiness. The caller permits only raw undefined/null/empty-string polls
    // before any prepare or pending receipt; a first actual object is strict.
    if (initial === null && context.allowStartupEmpty === true
      && (info === undefined || info === null || info === '')) return null;
    const tick = data(info, 'tick');
    require(Number.isSafeInteger(tick) && tick >= 0 && tick <= 0x7fffffff
      && data(info, 'version') === 1 && data(info, 'engine') === 'original-swf'
      && data(info, 'digestSchema') === 'native-projection-v3' && data(info, 'snapshotReceiptVersion') === 1,
    'Native scalar witness has an invalid actual Info header');
    const state = data(info, 'state');
    require(['menu', 'loading', 'ready', 'playing'].includes(state), 'Native scalar Info is not healthy');
    const raw = data(info, 'nativeScalarKernel');
    require(raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.getOwnPropertySymbols(raw).length === 0
      && Object.getOwnPropertyNames(raw).sort().join(',') === [...fields].sort().join(','), 'Native scalar witness must have exactly seven fields');
    const value = {};
    for (const key of fields) value[key] = data(raw, key);
    require(value.version === 1 && value.contract === 'bh-scalars-thing-v1', 'Native scalar ABI mismatch');
    for (const key of counters) require(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid native scalar counter: ' + key);
    require(value.ownReads <= value.keys && value.completed + value.unsupported <= value.calls,
      'Native scalar counter accounting differs');
    if (initial === null) {
      require(tick === 0 && counters.every(key => value[key] === 0), 'Fresh native VM must first expose tick-zero counters');
      instance = context.instance;
      initial = Object.freeze({ source: 'actual-bhInfo', instance, at: context.at, ms: context.ms,
        value: Object.freeze({ version: 1, engine: 'original-swf', state, tick,
          digestSchema: 'native-projection-v3', snapshotReceiptVersion: 1,
          nativeScalarKernel: Object.freeze({ ...value }) }) });
    } else {
      require(context.instance === instance && tick >= previousTick, 'Native scalar VM or tick changed without a permitted cold epoch');
      for (const key of counters) require(value[key] >= previous[key], 'Native scalar counter decreased: ' + key);
    }
    if (tick > 0 && tick % 25 !== 0) require(value.completed > 0, 'No completed native scalar call by compact tick');
    previous = value; previousTick = tick;
    return { initial, value: { ...value } };
  }
  return { observe };
}

/** Producer-side saved-prefix check. The independent auditor has its own
 * implementation, rather than importing this assertion path. */
export function validateNativeScalarColdPrefix(observation, through) {
  const initial = observation.nativeScalarInitialInfo;
  assert(initial && initial.source === 'actual-bhInfo');
  assert.equal(observation.nativePlayers.length, 1); assert.equal(observation.nativePrepares.length, 1);
  assert.equal(initial.instance, observation.nativePlayers[0].instance);
  assert.equal(initial.instance, observation.nativePrepares[0].instance);
  const verifier = createNativeScalarInfoObserver();
  verifier.observe(initial.value, initial);
  const rows = observation.snapshotReceipts.filter(row => row.tick <= through);
  assert.equal(rows.length, through);
  let last, compact = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], tick = index + 1, info = row.info;
    assert.equal(row.tick, tick); assert.equal(row.instance, initial.instance);
    assert.equal(info?.source, 'actual-bhInfo'); assert.equal(info.instance, row.instance);
    assert.equal(info.value.tick, tick);
    assert(initial.at + initial.ms <= info.at, 'Tick-zero native scalar Info follows replay work');
    last = verifier.observe(info.value, info).value;
    if (tick % 25 !== 0) compact++;
  }
  return { expected: true, schema: NATIVE_SCALAR_COLD_SCHEMA, through, instance: initial.instance,
    actualInfoWitnesses: rows.length, compactWitnesses: compact,
    initial: initial.value.nativeScalarKernel, last, extraNativeCalls: 0,
    countersResetByPrepare: false, unsupportedCountsAsCoverage: false };
}
