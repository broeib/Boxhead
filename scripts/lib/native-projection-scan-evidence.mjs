import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const COUNTERS = ['calls', 'completed', 'unsupported', 'keys', 'ownReads'];

/** Counters are an actual native execution witness, never world state. */
export function validateProjectionScanStats(value, previous, { zero = false, advanced = false } = {}) {
  assert(record(value), 'Candidate bhInfo lacks nativeProjectionScan');
  assert.deepEqual(Object.keys(value).sort(), ['version', 'contract', ...COUNTERS].sort(), 'Unexpected scanner ABI');
  assert.equal(value.version, 1); assert.equal(value.contract, 'bh-projection-scan-v1');
  for (const key of COUNTERS) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid scanner counter: ' + key);
    if (zero) assert.equal(value[key], 0, 'Scanner was used before the fresh menu observation: ' + key);
    if (previous) assert(value[key] >= previous[key], 'Scanner counter decreased: ' + key);
  }
  assert.equal(value.calls, value.completed + value.unsupported, 'A native scan did not finish or explicitly decline before reading');
  assert(value.ownReads <= value.keys, 'Scanner reads exceed enumerated keys');
  if (advanced) {
    assert(previous, 'A previous native witness is required');
    for (const key of ['calls', 'completed', 'keys', 'ownReads'])
      assert(value[key] > previous[key], 'Fresh full projection did not execute native scanner: ' + key);
  }
  return { ...value };
}

/** Independent implementation over actual exported VM graphs. */
export function rehashNativeProjection(value) {
  const parts = [], active = new Set();
  let characters = 0;
  function append(part) {
    characters += part.length;
    assert(characters <= 8 * 1024 * 1024, 'Actual graph exceeds native encoding budget');
    parts.push(part);
  }
  function encode(item, depth) {
    assert(depth <= 256, 'Actual graph exceeds native depth budget');
    if (item === null) { append('z'); return; }
    if (item === undefined) { append('u'); return; }
    if (typeof item === 'boolean') { append(item ? 't' : 'f'); return; }
    if (typeof item === 'number') {
      assert(Number.isFinite(item), 'Native nonfinite number was not tagged');
      append('n' + String(item) + ';'); return;
    }
    if (typeof item === 'string') { append('s' + item.length + ':' + item); return; }
    assert(typeof item === 'object' && !active.has(item), 'Invalid native graph leaf or untagged cycle');
    active.add(item);
    const keys = Object.keys(item).sort(); append('o' + keys.length + ':');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      assert(descriptor && Object.hasOwn(descriptor, 'value'), 'Native graph contains an accessor');
      encode(key, depth + 1); encode(descriptor.value, depth + 1);
    }
    active.delete(item);
  }
  encode(value, 0);
  const encoded = parts.join('');
  let forward = 2166136261, reverse = 2166136261;
  for (let index = 0; index < encoded.length; index++) {
    forward = Math.imul(forward ^ encoded.charCodeAt(index), 16777619);
    reverse = Math.imul(reverse ^ encoded.charCodeAt(encoded.length - 1 - index), 16777619);
  }
  return { digest: 'native-v2-' + [forward, reverse].map(v => (v >>> 0).toString(16).padStart(8, '0')).join(''),
    bytes: characters, canonicalSha256: sha(encoded) };
}

function compareOrdered(left, right, path = 'native', counts = { objects: 0, fields: 0, references: 0, animations: 0 }) {
  if (left === null || typeof left !== 'object') {
    assert(Object.is(left, right), 'Native leaf differs at ' + path); return counts;
  }
  assert(right !== null && typeof right === 'object', 'Native object differs at ' + path);
  assert.equal(Array.isArray(right), Array.isArray(left), 'Native container kind differs at ' + path);
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  assert.deepEqual(rightKeys, leftKeys, 'Native returned field order differs at ' + path);
  counts.objects++; counts.fields += leftKeys.length;
  if (leftKeys.length === 1 && leftKeys[0] === '$ref') {
    assert(Number.isSafeInteger(left.$ref) && left.$ref >= 0, 'Invalid native reference at ' + path);
    counts.references++;
  }
  if (Object.hasOwn(left, '$animation')) counts.animations++;
  for (const key of leftKeys) compareOrdered(left[key], right[key], path + '/' + key, counts);
  return counts;
}

export function verifyNativeProjectionPair(states, tick, expectedScope) {
  assert(Array.isArray(states) && states.length === 2, 'Both independent VM snapshots are required');
  const hashes = states.map((state, index) => {
    assert(record(state) && !state.error, 'Native snapshot error in arm ' + index);
    assert.equal(state.version, 1); assert.equal(state.engine, 'original-swf');
    assert.equal(state.digestSchema, 'native-projection-v3');
    assert.equal(state.tick, tick); assert.equal(state.scope, expectedScope);
    assert(record(state.native), 'Actual exported native graph is missing');
    assert.equal(state.native.tick, tick); assert.equal(state.native.scope, expectedScope);
    assert.deepEqual(state.rng, state.native.rng, 'Header RNG differs from actual graph');
    assert(Array.isArray(state.players) && state.players.length > 0 && state.players.length <= 2);
    const result = rehashNativeProjection(state.native);
    assert.equal(result.digest, state.digest, 'Independent actual graph checksum differs in arm ' + index);
    assert.equal(result.bytes, state.snapshotBytes, 'Native graph byte count differs in arm ' + index);
    for (const key of ['snapshotObjects', 'snapshotFields'])
      assert(Number.isSafeInteger(state[key]) && state[key] >= 0, 'Missing native projection count: ' + key);
    return result;
  });
  for (const key of ['tick', 'scope', 'state', 'digest', 'rng', 'players', 'snapshotBytes', 'snapshotObjects', 'snapshotFields'])
    assert.deepEqual(states[1][key], states[0][key], 'Native A/B envelope differs: ' + key + ' at tick ' + tick);
  assert.deepEqual(states[1].native, states[0].native, 'Native A/B actual fields/reference IDs differ at tick ' + tick);
  const compared = compareOrdered(states[0].native, states[1].native);
  assert.equal(hashes[1].canonicalSha256, hashes[0].canonicalSha256);
  return { tick, scope: expectedScope, digest: states[0].digest, canonicalSha256: hashes[0].canonicalSha256,
    returnedOrderSha256: sha(JSON.stringify(states[0].native)), snapshotBytes: states[0].snapshotBytes,
    snapshotObjects: states[0].snapshotObjects, snapshotFields: states[0].snapshotFields,
    compared, rng: states[0].rng, players: states[0].players };
}

export function nativeProjectionCommand(tick, joinTick) {
  assert(Number.isSafeInteger(tick) && tick > 0);
  assert(Number.isSafeInteger(joinTick) && joinTick >= 0);
  const directions = [[8, 4], [2, 1], [4, 8], [1, 2]][Math.floor((tick - 1) / 20) % 4];
  const fire = tick % 10 < 8 ? 16 : 0;
  const command = { tick, p1: directions[0] | fire, p2: joinTick && tick < joinTick ? 0 : directions[1] | fire };
  if (tick === joinTick) command.join = { slot: 2, character: 3 };
  return command;
}
