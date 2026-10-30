import assert from 'node:assert/strict';
import { validateNativeProjectStats, verifyNativeProjectionPair } from './native-project-evidence.mjs';
import { rehashNativeProjection } from './native-projection-scan-evidence.mjs';

export const COMPACT_PROBE_PAIRS = Object.freeze(['first', 'normal', 'personal', 'join', 'terminal', 'sequence']);
export const COMPACT_PROBE_NEGATIVES = Object.freeze(['wrong-phase', 'early-receipt', 'abort',
  'scalar-reentry', 'receipt-reentry', 'presentation-error']);
export const compactProbeTicks = kind => kind === 'first' ? [1] : kind === 'sequence' ? [24, 25, 26] : [7];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fixtureStatics = { positionFactor: 1, nextThingID: 0, processAllocator: 3,
  navStatics: { state: 0, id: 0, time: 0, distance: 0, fullScans: 0, list: [], pending: [], session: 0, mapSession: 1 } };
const tokenFor = tick => 'private_compact_' + tick;
const gameTrace = (kind, tick) => [...(kind === 'join' ? ['join:1'] : []), 'masks:17:3', 'process', 'draw',
  ...(tick === 1 ? ['rules'] : []), 'sound', 'background', 'world-scalar', ...(tick % 25 === 0 ? ['world-scalar'] : [])];
const expectedPixels = Array.from({ length: 64 }, (_, index) =>
  [9, 10, 17, 18].includes(index) ? 0xffaabbcc : 0xff102030);

export function validateCompactPhase(value, phase, tick, epoch) {
  assert(record(value));
  assert.deepEqual(Object.keys(value).sort(), ['version', 'phase', 'token', 'epoch', 'tick'].sort());
  assert.deepEqual(value, { version: 1, phase, token: tokenFor(tick), epoch, tick });
}

function setup(value, kind, mode) {
  assert(record(value)); assert.equal(value.version, 1); assert.equal(value.privateFixture, true);
  assert.equal(value.kind, kind); assert.equal(value.mode, mode);
  assert.equal(value.actualFence, true); assert.equal(value.actualCompactFence, true);
  const base = compactProbeTicks(kind)[0] - 1;
  assert.equal(value.tick, base); assert.equal(value.worldTick, base);
  assert.deepEqual(value.fixtureStatics, fixtureStatics);
  return validateNativeProjectStats(value.nativeBefore);
}

function pixels(observed, tick) {
  assert(Array.isArray(observed.pixels) && observed.pixels.length === expectedPixels.length,
    'Actual native BitmapData pixel array differs');
  // AVM1 may serialize getPixel32 as a signed i32 or an unsigned u32 Number.
  // Validate the complete representation before comparing its exact 32 bits;
  // coercion must not hide fractions, missing entries or wrapped overflow.
  // The original observed array remains untouched in the retained evidence.
  const actual = Array.from(observed.pixels, pixel => {
    assert(Number.isInteger(pixel) && pixel >= -0x80000000 && pixel <= 0xffffffff,
      'Actual native BitmapData pixel is not a signed/unsigned 32-bit integer');
    return pixel >>> 0;
  });
  assert.deepEqual(actual, expectedPixels, 'Actual native BitmapData pixels changed');
  const value = observed.presentation;
  assert(record(value)); assert.equal(value.version, 1); assert.equal(value.enabled, true);
  assert.equal(value.tick, tick); assert.equal(value.mode, 'three-pose-v2'); assert.equal(value.poseVersion, 2);
  assert.equal(value.pixelsEqual, true, 'Actual alpha-one replay differs from canonical native bitmap');
  assert.equal(value.error, undefined);
}

function resumed(ambient, observed, kind, tick, trace) {
  assert(Array.isArray(ambient) && ambient.length <= 512);
  const counts = { frame: 0, key: 0, mouse: 0, debrief: 0 };
  for (const event of ambient) {
    assert(record(event));
    assert.deepEqual(Object.keys(event).sort(), ['phase', 'kind', 'tick', 'count'].sort());
    assert.equal(event.phase, 'finished', 'Ambient work ran while a phase owned the VM');
    assert.equal(event.tick, tick); assert(Object.hasOwn(counts, event.kind));
    assert.equal(event.count, ++counts[event.kind], 'Actual resumed callback sequence changed');
  }
  assert(counts.frame > 0, 'Autonomous fixture must resume after real receipt');
  for (const [field, event] of [['ambient', 'frame'], ['keys', 'key'], ['pointers', 'mouse'], ['debriefCalls', 'debrief']])
    assert.equal(observed[field], counts[event], 'Observed callbacks differ: ' + field);
  if (kind !== 'terminal') assert.equal(counts.debrief, 0);
  assert.deepEqual(observed.trace.slice(0, trace.length), trace, 'Exact actual Game/snapshot order changed');
  assert.equal(observed.trace.length, trace.length + counts.debrief * 2);
  for (let index = trace.length; index < observed.trace.length; index++)
    assert.equal(observed.trace[index], (index - trace.length) % 2 === 0 ? 'sound' : 'background',
      'Only witnessed post-receipt terminal debrief pairs may follow the transaction');
}

function completed(arm, kind, mode) {
  assert.equal(arm.mode, mode);
  let previous = setup(arm.setup, kind, mode);
  const ticks = compactProbeTicks(kind), trace = [], snapshots = [];
  assert.equal(arm.steps.length, ticks.length); assert.equal(arm.captures.length, ticks.length);
  let lastFullDigest = 'native-v2-0123456789abcdef';
  for (const [index, tick] of ticks.entries()) {
    const row = arm.steps[index], scope = tick % 25 === 0 ? 'full' : 'frame', epoch = index + 1;
    const { native, metadata, result } = arm.captures[index];
    assert.deepEqual(metadata, { version: 1, token: tokenFor(tick), epoch, tick, scope });
    assert(record(native)); assert.equal(native.tick, tick); assert.equal(native.scope, scope);
    assert.deepEqual(native.rng, { seed: 1, state: 2, calls: 3 });
    assert(record(native.entities));
    for (const [key, value] of Object.entries({ ambient: 0, keys: 0, pointers: 0, p1: 17, p2: 3 }))
      assert.equal(native.entities.witness[key], value, 'Unexpected input or autonomous mutation: ' + key);
    assert.equal(native.entities.first.observed, 19, 'Real getter missing from fresh state');
    const digest = rehashNativeProjection(native);
    assert.equal(result.digest, digest.digest); assert.equal(result.bytes, digest.bytes);
    if (scope === 'frame') assert.equal(native.lastFullDigest, lastFullDigest);
    else {
      lastFullDigest = digest.digest;
      for (const name of ['positionFactor', 'nextThingID', 'processAllocator']) assert.equal(native[name], fixtureStatics[name]);
      for (const name of ['state', 'id', 'time', 'distance', 'fullScans', 'session', 'mapSession'])
        assert.equal(native.navStatics[name], fixtureStatics.navStatics[name]);
    }
    assert.equal(row.tick, tick); assert.equal(row.step.tick, tick); assert.equal(row.step.worldTick, tick);
    assert.equal(row.step.digest, digest.digest); assert.equal(row.step.snapshotBytes, digest.bytes);
    assert.equal(row.step.error, undefined); assert.deepEqual(row.step.rng, native.rng);
    assert.equal(row.step.players.length, 2); assert.deepEqual(row.step.players.map(player => player.slot), [1, 2]);
    if (kind === 'terminal') assert.equal(row.step.complete, 'player dead');
    else assert(row.step.complete === undefined || row.step.complete === null);
    if (scope === 'frame') { assert.equal(row.step.snapshotObjects, 0); assert.equal(row.step.snapshotFields, 0); }
    assert.equal(row.info.tick, tick); assert.equal(row.info.state, 'playing'); assert.equal(row.info.error, undefined);
    for (const name of ['snapshotReceiptVersion', 'stagedStepVersion', 'compactStepVersion']) assert.equal(row.info[name], 1);
    assert.deepEqual(Object.keys(row.receipt).sort(), ['version', 'token', 'epoch', 'tick', 'scope', 'header'].sort());
    for (const name of ['version', 'token', 'epoch', 'tick', 'scope']) assert.equal(row.receipt[name], metadata[name]);
    const header = row.receipt.header;
    assert.equal(header.version, 1); assert.equal(header.engine, 'original-swf'); assert.equal(header.state, 'playing');
    assert.equal(header.scope, scope); assert.equal(header.digestSchema, 'native-projection-v3');
    assert.equal(header.error, undefined); assert(!Object.hasOwn(header, 'native')); assert(!Object.hasOwn(header, 'entities'));
    for (const name of ['tick', 'digest', 'players', 'rng', 'profile', 'snapshotBytes', 'snapshotObjects', 'snapshotFields'])
      assert.deepEqual(header[name], row.step[name], 'Commit/receipt differ: ' + name);
    const observed = row.observed;
    assert.equal(observed.kind, kind); assert.equal(observed.mode, mode); assert.equal(observed.tick, tick);
    assert.equal(observed.worldTick, tick); assert.equal(observed.logicCalls, 1); assert.equal(observed.drawCalls, 1);
    assert.equal(observed.getters, index + 1, 'Each actual snapshot must read the own getter exactly once');
    for (const name of ['markersClean', 'receiptAbsent', 'stagedAbsent', 'compactAbsent']) assert.equal(observed[name], true);
    assert.deepEqual(observed.fixtureStatics, fixtureStatics);
    assert.equal(observed.snapshotDigest, digest.digest); assert.equal(observed.snapshotScope, scope);
    for (const name of ['snapshotObjects', 'snapshotFields']) assert.equal(observed[name], row.step[name]);
    const next = validateNativeProjectStats(observed.nativeAfter, previous, { advanced: scope === 'full' });
    assert.equal(next.calls - previous.calls, scope === 'full' ? 1 : 0);
    assert.equal(next.completed - previous.completed, scope === 'full' ? 1 : 0);
    if (scope === 'frame') assert.deepEqual(next, previous, 'Compact tick unexpectedly ran full projector');
    previous = next;
    trace.push(...gameTrace(kind, tick));
    resumed(row.ambientAfterReceipt, observed, kind, tick, trace);
    assert.deepEqual(row.ambientWhileFenced, [], 'Ambient work ran between actual phases');
    pixels(observed, tick);
    assert.equal(row.canonicalPresent.tick, tick); assert.equal(row.canonicalPresent.alpha, 1);
    assert.equal(row.canonicalPresent.error, undefined);
    if (mode === 'compact') {
      const phases = scope === 'full' ? ['begun', 'prepared', 'projected'] : ['begun'];
      assert.equal(row.stages.length, phases.length); assert.equal(row.presents.length, phases.length);
      assert.equal(row.ambientInputDispatches, phases.length);
      for (const [phaseIndex, phase] of phases.entries()) {
        validateCompactPhase(row.stages[phaseIndex], phase, tick, epoch);
        const present = row.presents[phaseIndex];
        assert.equal(present.version, 1); assert.equal(present.enabled, true); assert.equal(present.tick, tick);
        assert.equal(present.alpha, scope === 'full' ? [0.25, 0.5, 0.75][phaseIndex] : 0.5);
        assert.equal(present.error, undefined);
        if (kind === 'terminal') assert.equal(present.rendered, false);
      }
      if (kind !== 'terminal') assert.equal(row.presents[0].rendered, true);
    } else {
      assert.deepEqual(row.stages, []); assert.deepEqual(row.presents, []); assert.equal(row.ambientInputDispatches, 0);
    }
    snapshots.push({ ...header, native, entities: native.entities });
  }
  const restored = arm.restored, final = arm.steps.at(-1);
  assert.equal(restored.version, 1); assert.equal(restored.restored, true); assert.equal(restored.staticsRestored, true);
  assert.equal(restored.state, 'menu'); assert.equal(restored.tick, 0); assert.equal(restored.active, false);
  assert.equal(arm.menuAfter.state, 'menu'); assert.equal(arm.menuAfter.tick, 0); assert.equal(arm.menuAfter.error, undefined);
  resumed(arm.ambientAfterReceipt, restored.observed, kind, ticks.at(-1), trace);
  for (const name of ['tick', 'worldTick', 'getters', 'snapshotDigest', 'snapshotScope', 'nativeAfter', 'pixels'])
    assert.deepEqual(restored.observed[name], final.observed[name], 'Restore changed private observation: ' + name);
  assert.deepEqual(arm.ambientWhileFenced, []);
  return snapshots;
}

export function validateCompactProbePair(pair) {
  assert(COMPACT_PROBE_PAIRS.includes(pair.kind)); assert.equal(pair.arms.length, 2);
  const left = completed(pair.arms[0], pair.kind, 'sync'), right = completed(pair.arms[1], pair.kind, 'compact');
  const compared = compactProbeTicks(pair.kind).map((tick, index) =>
    verifyNativeProjectionPair([left[index], right[index]], tick, tick % 25 === 0 ? 'full' : 'frame'));
  return { kind: pair.kind, pass: true, compared, actualPixelPairs: compared.length };
}

export function validateCompactProbeNegative(value) {
  assert(COMPACT_PROBE_NEGATIVES.includes(value.kind)); setup(value.setup, value.kind, 'compact');
  assert.equal(value.stages.length, 1); validateCompactPhase(value.stages[0], 'begun', 7, 1);
  for (const name of ['failure', 'afterFailure', 'receiptAfterFailure', 'restartAfterFailure']) {
    const failure = value[name];
    assert(record(failure)); assert.equal(failure.failed, true, 'Poisoned callback succeeded: ' + name);
    if (failure.value !== undefined) {
      assert(record(failure.value)); assert.equal(failure.value.version, 1);
      assert.equal(failure.value.state, 'error');
      assert.equal(typeof failure.value.error, 'string'); assert(failure.value.error.length > 0);
      assert.equal(failure.value.digest, undefined); assert.equal(failure.value.header, undefined);
    } else {
      assert.equal(typeof failure.error, 'string'); assert(failure.error.length > 0);
    }
  }
  assert.deepEqual(value.ambientWhileFenced, [], 'Poisoned compact transaction resumed autonomous work');
  const partialDigest = value.kind === 'scalar-reentry' || value.kind === 'receipt-reentry';
  assert.equal(value.captures.length, partialDigest ? 1 : 0);
  if (value.kind === 'scalar-reentry' || value.kind === 'receipt-reentry') {
    assert.equal(value.reentries.length, 1);
    assert.equal(value.reentries[0].phase, value.kind === 'scalar-reentry' ? 'scalar' : 'receipt');
    assert.equal(value.reentries[0].txAbsent, value.kind === 'receipt-reentry');
    assert.equal(value.reentries[0].rejected, true);
  } else assert.deepEqual(value.reentries, []);
  if (partialDigest) {
    const capture = value.captures[0], digest = rehashNativeProjection(capture.native);
    assert.deepEqual(capture.metadata, { version: 1, token: tokenFor(7), epoch: 1, tick: 7, scope: 'frame' });
    assert.equal(capture.native.tick, 7); assert.equal(capture.native.scope, 'frame');
    assert.deepEqual(capture.result, { digest: digest.digest, bytes: digest.bytes });
  }
  if (value.kind === 'receipt-reentry') {
    const digest = rehashNativeProjection(value.captures[0].native);
    assert.equal(value.step.tick, 7); assert.equal(value.step.digest, digest.digest); assert.equal(value.step.snapshotBytes, digest.bytes);
    assert.equal(value.info.tick, 7); assert.equal(value.info.state, 'playing'); assert.equal(value.info.error, undefined);
  } else {
    assert.equal(value.step, undefined, 'A failed phase cannot supply a successful Commit');
    assert.equal(value.info, undefined, 'A failed phase cannot supply a successful Info');
  }
  return { kind: value.kind, pass: true, capturedGraphs: value.captures.length,
    discardedGraphs: value.captures.length, receiptAfterFailureRejected: true, restartAfterFailureRejected: true,
    poisonedAfterReturn: value.kind === 'receipt-reentry' };
}
