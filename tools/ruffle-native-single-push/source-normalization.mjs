import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SINGLE_PUSH_DELTA_SHA256 = 'd29581c24b29cde6d1ec6fd505fa91cc240a398b990b6881eec0138525f545ea';
export const SINGLE_PUSH_PREDECESSOR = Object.freeze({
  path: 'core/src/avm1/activation.rs', bytes: 125491,
  sha256: '7aab0b274d5ba3a80b0e22d14ed90074c894b9ff187b4cd42a61f672741d9727',
});
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = readFileSync(new URL('./source-delta.json', import.meta.url));
assert.equal(hash(bytes), SINGLE_PUSH_DELTA_SHA256, 'Unreviewed singleton-Push delta metadata');
const delta = JSON.parse(bytes);
assert.equal(delta.schema, 'boxhead-native-single-push-source-delta-v1');
assert.equal(delta.files.length, 1);
const record = delta.files[0];
assert.equal(record.path, SINGLE_PUSH_PREDECESSOR.path);
assert.equal(record.predecessorBytes, SINGLE_PUSH_PREDECESSOR.bytes);
assert.equal(record.predecessorSha256, SINGLE_PUSH_PREDECESSOR.sha256);

export function restoreReviewedSinglePushSource(path, source) {
  assert.equal(path, SINGLE_PUSH_PREDECESSOR.path, 'Unknown singleton-Push source path');
  assert.equal(typeof source, 'string');
  assert.equal(Buffer.byteLength(source), record.candidateBytes, 'Unreviewed singleton-Push source length');
  assert.equal(hash(source), record.candidateSha256, 'Unreviewed singleton-Push source change');
  for (const { before, after } of [...record.hunks].reverse()) {
    assert.equal(source.split(after).length - 1, 1, 'Exact unique singleton-Push reverse hunk required');
    source = source.replace(after, before);
  }
  assert.equal(Buffer.byteLength(source), SINGLE_PUSH_PREDECESSOR.bytes);
  assert.equal(hash(source), SINGLE_PUSH_PREDECESSOR.sha256, 'Frozen v13 Activation changed');
  return source;
}
