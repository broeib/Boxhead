import assert from 'node:assert/strict';
import { validateNativeProjectStats, verifyNativeProjectionPair } from './native-project-evidence.mjs';
import { rehashNativeProjection } from './native-projection-scan-evidence.mjs';

export const STAGED_PROBE_PAIRS = Object.freeze(['normal', 'personal', 'terminal', 'join']);
export const STAGED_PROBE_NEGATIVES = Object.freeze(['wrong-phase', 'abort', 'project-reentry', 'receipt-reentry']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fixtureStatics = { positionFactor: 1, nextThingID: 0, processAllocator: 3,
  navStatics: { state: 0, id: 0, time: 0, distance: 0, fullScans: 0, list: [], pending: [], session: 0, mapSession: 1 } };
const transactionTrace = kind => [...(kind === 'join' ? ['join:1'] : []),
  'masks:17:3', 'process', 'draw', 'sound', 'background', 'world-scalar', 'world-scalar'];

function validateResumedTrace(arm, kind, observed) {
  const prefix = transactionTrace(kind);
  assert(Array.isArray(observed.trace));
  assert.deepEqual(observed.trace.slice(0, prefix.length), prefix,
    'Actual compiled transaction evaluation/command order differs');
  // The native fence retains autonomous work until the receipt has returned.
  // A subsequent ordinary EI entry can drain that work before Inspect/Restore
  // executes, even when the caller did not await. Validate its actual phase
  // records rather than calling a post-drain observation a transaction-only
  // trace or discarding an arbitrary sound/background suffix.
  assert(Array.isArray(arm.ambientAfterReceipt) && arm.ambientAfterReceipt.length <= 512,
    'Bounded raw post-receipt ambient records are required');
  const counts = { frame: 0, key: 0, mouse: 0, debrief: 0 };
  for (const event of arm.ambientAfterReceipt) {
    assert(record(event));
    assert.deepEqual(Object.keys(event).sort(), ['phase', 'kind', 'tick', 'count'].sort());
    assert.equal(event.phase, 'finished', 'Ambient work resumed before the real receipt returned');
    assert.equal(event.tick, 25); assert.equal(typeof event.kind, 'string');
    assert(Object.hasOwn(counts, event.kind), 'Unknown resumed ambient event');
    assert.equal(event.count, ++counts[event.kind], 'Resumed ambient counter skipped or repeated an event');
  }
  assert(counts.frame > 0, 'Autonomous private clip must resume after receipt');
  for (const [field, event] of [['ambient', 'frame'], ['keys', 'key'], ['pointers', 'mouse'], ['debriefCalls', 'debrief']])
    assert.equal(observed[field], counts[event], 'Post-receipt observation differs from actual callbacks: ' + field);
  if (kind !== 'terminal') assert.equal(counts.debrief, 0, 'Nonterminal fixture entered debrief');
  assert.equal(observed.trace.length, prefix.length + counts.debrief * 2,
    'Post-receipt trace contains work other than the actual terminal debrief pairs');
  for (let index = prefix.length; index < observed.trace.length; index++)
    assert.equal(observed.trace[index], (index - prefix.length) % 2 === 0 ? 'sound' : 'background',
      'Resumed terminal debrief order differs');
}

export function validateStagedPhase(value, phase, token = 'private_stage_25') {
  assert(record(value));
  assert.deepEqual(Object.keys(value).sort(), ['version', 'phase', 'token', 'epoch', 'tick'].sort());
  assert.deepEqual(value, { version: 1, phase, token, epoch: 1, tick: 25 });
}

function validateSetup(value, kind, mode) {
  assert(record(value)); assert.equal(value.version, 1); assert.equal(value.privateFixture, true);
  assert.equal(value.kind, kind); assert.equal(value.mode, mode); assert.equal(value.actualFence, true);
  assert.equal(value.tick, 24); assert.equal(value.worldTick, 24);
  assert.deepEqual(value.fixtureStatics, fixtureStatics, 'Private arm did not start from its explicit isolated static inputs');
  return validateNativeProjectStats(value.nativeBefore);
}

function capturedSnapshot(arm, mode, kind) {
  assert.equal(arm.mode, mode); const before = validateSetup(arm.setup, kind, mode);
  assert.equal(arm.captures.length, 1, 'Each successful private full tick must transfer exactly one real native graph');
  const { native, metadata, result } = arm.captures[0];
  assert.deepEqual(metadata, { version: 1, token: 'private_stage_25', epoch: 1, tick: 25, scope: 'full' });
  assert(record(native)); assert.equal(native.tick, 25); assert.equal(native.scope, 'full');
  for (const key of ['positionFactor', 'nextThingID', 'processAllocator'])
    assert.equal(native[key], fixtureStatics[key], 'Private full graph lost its actual static input: ' + key);
  for (const key of ['state', 'id', 'time', 'distance', 'fullScans', 'session', 'mapSession'])
    assert.equal(native.navStatics[key], fixtureStatics.navStatics[key], 'Private full graph navigation static differs: ' + key);
  const checksum = rehashNativeProjection(native);
  assert.equal(result.digest, checksum.digest); assert.equal(result.bytes, checksum.bytes);
  assert.equal(arm.step.tick, 25); assert.equal(arm.step.worldTick, 25); assert.equal(arm.step.digest, checksum.digest);
  assert.equal(arm.step.snapshotBytes, checksum.bytes); assert.equal(arm.step.error, undefined);
  assert.equal(arm.info.tick, 25); assert.equal(arm.info.state, 'playing'); assert.equal(arm.info.snapshotReceiptVersion, 1);
  assert.equal(arm.info.stagedStepVersion, 1); assert.equal(arm.info.error, undefined);
  assert.deepEqual(Object.keys(arm.receipt).sort(), ['version', 'token', 'epoch', 'tick', 'scope', 'header'].sort());
  assert.equal(arm.receipt.version, 1); assert.equal(arm.receipt.token, metadata.token); assert.equal(arm.receipt.epoch, 1);
  assert.equal(arm.receipt.tick, 25); assert.equal(arm.receipt.scope, 'full');
  for (const key of ['tick', 'digest', 'players', 'rng', 'snapshotBytes', 'snapshotObjects', 'snapshotFields'])
    assert.deepEqual(arm.receipt.header[key], arm.step[key], 'Step/receipt differ: ' + key);
  const observed = arm.restored.observed;
  assert.equal(observed.kind, kind); assert.equal(observed.mode, mode); assert.equal(observed.tick, 25);
  assert.equal(observed.worldTick, 25); assert.equal(observed.logicCalls, 1); assert.equal(observed.drawCalls, 1);
  assert.deepEqual(observed.fixtureStatics, fixtureStatics, 'Private input static changed while its fixture was active');
  assert.equal(observed.markersClean, true); assert.equal(observed.receiptAbsent, true); assert.equal(observed.stagedAbsent, true);
  assert.equal(observed.snapshotDigest, checksum.digest); assert.equal(observed.snapshotScope, 'full');
  for (const key of ['snapshotObjects', 'snapshotFields']) assert.equal(observed[key], arm.step[key]);
  assert.equal(observed.getters, 1, 'The actual own getter must be read exactly once');
  validateResumedTrace(arm, kind, observed);
  assert.equal(arm.restored.version, 1); assert.equal(arm.restored.restored, true);
  assert.equal(arm.restored.staticsRestored, true, 'Private fixture did not restore prior static slots and identities');
  assert.equal(arm.restored.state, 'menu'); assert.equal(arm.restored.tick, 0); assert.equal(arm.restored.active, false);
  assert.equal(arm.menuAfter.state, 'menu'); assert.equal(arm.menuAfter.tick, 0); assert.equal(arm.menuAfter.error, undefined);
  const after = validateNativeProjectStats(observed.nativeAfter, before, { advanced: true });
  assert.equal(after.calls - before.calls, 1); assert.equal(after.completed - before.completed, 1);
  assert.equal(after.unsupported - before.unsupported, 0);
  assert.equal(native.entities.witness.ambient, 0); assert.equal(native.entities.witness.keys, 0);
  assert.equal(native.entities.witness.pointers, 0); assert.equal(native.entities.witness.p1, 17);
  assert.equal(native.entities.witness.p2, 3);
  assert.equal(arm.step.players.length, 2);
  assert.deepEqual(arm.step.players.map(player => player.slot), [1, 2]);
  if (kind === 'terminal') assert.equal(arm.step.complete, 'player dead');
  else assert(arm.step.complete === undefined || arm.step.complete === null, 'Unexpected terminal fixture');
  if (mode === 'staged') {
    assert.equal(arm.stages.length, 3);
    for (const [index, phase] of ['begun', 'prepared', 'projected'].entries()) validateStagedPhase(arm.stages[index], phase);
    assert.deepEqual(arm.ambientWhileFenced, [], 'Autonomous AVM1 work ran between actual native phase boundaries');
    assert.equal(arm.presents.length, 3);
    for (const [index, value] of arm.presents.entries()) {
      assert.equal(value.version, 1); assert.equal(value.enabled, true); assert.equal(value.tick, 25);
      assert.equal(value.alpha, [0.25, 0.5, 0.75][index]); assert.equal(value.error, undefined);
      if (kind === 'terminal') assert.equal(value.rendered, false);
    }
    if (kind !== 'terminal') assert.equal(arm.presents[0].rendered, true, 'Real bitmap Present must run between stages');
    assert.equal(arm.ambientInputDispatches, 3, 'Each phase wait needs actual browser input and animation-frame opportunities');
  } else { assert.deepEqual(arm.stages, []); assert.deepEqual(arm.presents, []); }
  return { ...arm.receipt.header, native, entities: native.entities };
}

export function validateStagedProbePair(pair) {
  assert(STAGED_PROBE_PAIRS.includes(pair.kind)); assert.equal(pair.arms.length, 2);
  const snapshots = pair.arms.map((arm, index) => capturedSnapshot(arm, index ? 'staged' : 'sync', pair.kind));
  const length = transactionTrace(pair.kind).length;
  assert.deepEqual(pair.arms[1].restored.observed.trace.slice(0, length), pair.arms[0].restored.observed.trace.slice(0, length),
    'Actual compiled source evaluation/command order differs');
  assert.equal(pair.arms[1].restored.observed.getters, pair.arms[0].restored.observed.getters,
    'Actual getter count differs across task boundaries');
  return verifyNativeProjectionPair(snapshots, 25, 'full');
}

export function validateStagedProbeNegative(value) {
  assert(STAGED_PROBE_NEGATIVES.includes(value.kind)); validateSetup(value.setup, value.kind, 'staged');
  validateStagedPhase(value.stages[0], 'begun');
  assert.equal(value.failure.failed, true, 'Malformed phase/abort/reentrant callback returned usable success');
  assert.equal(value.afterFailure.failed, true, 'Poisoned runtime resumed a normal callback');
  assert.deepEqual(value.ambientWhileFenced, [], 'Poisoned transaction allowed autonomous AVM1 callbacks');
  const expectedPhases = value.kind === 'wrong-phase' ? ['begun']
    : value.kind === 'project-reentry' ? ['begun', 'prepared'] : ['begun', 'prepared', 'projected'];
  assert.equal(value.stages.length, expectedPhases.length);
  for (const [index, phase] of expectedPhases.entries()) validateStagedPhase(value.stages[index], phase);
  assert.equal(value.captures.length, value.kind === 'receipt-reentry' ? 1 : 0, 'Failed phase created an early/duplicate digest');
  if (value.kind === 'project-reentry' || value.kind === 'receipt-reentry') {
    assert.equal(value.reentries.length, 1); const nested = value.reentries[0];
    assert.equal(nested.phase, value.kind === 'project-reentry' ? 'project' : 'receipt');
    assert.equal(nested.txAbsent, value.kind === 'receipt-reentry');
    assert.equal(nested.rejected, true, 'Nested callback unexpectedly succeeded');
  } else assert.deepEqual(value.reentries, []);
  if (value.kind === 'receipt-reentry') {
    assert.equal(value.step.tick, 25); assert.equal(value.info.tick, 25);
    assert.equal(value.info.state, 'playing'); assert.equal(value.info.error, undefined);
    const hash = rehashNativeProjection(value.captures[0].native);
    assert.equal(value.step.digest, hash.digest); assert.equal(value.step.snapshotBytes, hash.bytes);
  }
  return { kind: value.kind, pass: true, capturedGraphs: value.captures.length,
    phaseResponses: value.stages.length, poisonedAfterReturn: value.kind === 'receipt-reentry' };
}
