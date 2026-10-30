import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Test-only historical source reconstruction. This module never changes the
// source compiled by Cargo or the bytes consumed by any browser/runtime binder.
const sha = value => createHash('sha256').update(value).digest('hex');
const deltaBytes = readFileSync(new URL('./native-v12-source-delta.json', import.meta.url));
assert.equal(deltaBytes.length, 60861);
assert.equal(sha(deltaBytes), 'e1c80508c711954b9f58d6e4cdc43178e951bb6e897e3e56257e73bc4138ce92');
const delta = JSON.parse(deltaBytes);
assert.equal(delta.schema, 'boxhead-v12-historical-normalization-review-v1');

const expected = Object.freeze({
  'core/src/avm1/globals/boxhead_native_project.rs': [33798,
    '844598c85638ba20605fda92a63056c25e9a6c2013b18a4898a6bd108f8e1778', 32804,
    '73f9240d39fd9c179963acd201cfb2dea7019ae14b1d6f7d7c2ca31098b4efb3', 20],
  'core/src/avm1/globals/boxhead_native_projection_scan.rs': [12779,
    '5163451e77e51f6f5f2d1050d506795cee26713d9cb0852c46c9894bb99b842a', 12637,
    '11451ab0d11b1617f9859164888a6077fb34173c11ec7e8cc85575ab0394bbc0', 9],
  'core/src/avm1/object/script_object.rs': [43753,
    '2189a94b6c6c789c2e702dd69ad6bfb56af244d457ce2bc3cca7f9f783f44399', 42307,
    '67cfbecc52f4db6c7321efe0015c7503aad1706b0161b0664474a42c67f6905f', 1],
  'core/src/avm1/scope.rs': [10718,
    '8e753328af9d37cf80b7c82b9bd1c6ada07018ec8db38cd80386033d5d101264', 9350,
    '85d7998c61e2f65c0c77116799ad32dc7f04f231a4f6d81a2829ee777dffbd2d', 3],
  'core/src/bitmap/operations/boxhead_blit.rs': [14725,
    '8fcfbc6d4f1997aa60a25c459d1d1d49c3bc941f0bc30d5bfab0da060b8e8e7c', 14782,
    '434b80a83c2179bf9d430f947efa1b70694574b9c32d6666140ca290ad70d7a8', 8],
});
assert.deepEqual(delta.files.map(record => record.path).sort(), Object.keys(expected).sort());
const records = new Map();
for (const record of delta.files) {
  const [bytes, hash, oldBytes, oldHash, steps] = expected[record.path];
  assert.deepEqual(record.candidate, { bytes, sha256: hash });
  assert.deepEqual(record.predecessor, { bytes: oldBytes, sha256: oldHash });
  assert.equal(record.reverseSteps.length, steps);
  records.set(record.path, record);
}

export function restoreV10NativeSource(source, path) {
  assert.equal(typeof source, 'string');
  assert.equal(typeof path, 'string');
  const record = records.get(path);
  assert(record, 'Unreviewed v12 source path');
  assert.equal(Buffer.byteLength(source), record.candidate.bytes, 'Unreviewed v12 source byte length');
  assert.equal(sha(source), record.candidate.sha256, 'Unreviewed v12 source SHA');
  let restored = source;
  for (const step of record.reverseSteps) {
    assert.equal(typeof step.current, 'string');
    assert(step.current.length > 0);
    assert.equal(typeof step.previous, 'string');
    assert.equal(restored.split(step.current).length, 2, 'Reviewed source delta must occur exactly once');
    restored = restored.replace(step.current, () => step.previous);
  }
  assert.equal(Buffer.byteLength(restored), record.predecessor.bytes);
  assert.equal(sha(restored), record.predecessor.sha256, 'Frozen v10 source identity changed');
  return restored;
}

export function restoreV10PackedHelper(source) {
  return restoreV10NativeSource(source, 'core/src/bitmap/operations/boxhead_blit.rs');
}
