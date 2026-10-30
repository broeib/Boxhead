import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = readFileSync(new URL('./source-delta.json', import.meta.url), 'utf8');
assert.equal(sha(encoded), '991931a76afbf23dacc0645d5b8c382955aacc5d609687a208b8d7e39325923a');
const delta = JSON.parse(encoded);
assert.equal(delta.schema, 'boxhead-native-gc-slicing-source-delta-v1');

// This is a byte-identity proof, not an arbitrary patcher or an acceptance of
// equivalent-looking source. Both ends and every exact intervening hunk are
// pinned. Historical source proofs can use the returned original bytes.
export function restoreReviewedGcSource(path, source) {
  const records = delta.files.filter(record => record.path === path);
  assert.equal(records.length, 1, `Unknown or duplicate GC source path: ${path}`);
  const record = records[0];
  assert.equal(Buffer.byteLength(source), record.candidate.bytes, path);
  assert.equal(sha(source), record.candidate.sha256, path);
  let restored = source;
  for (const hunk of [...record.hunks].reverse()) {
    assert.equal(restored.split(hunk.after).length, 2, `Non-unique reviewed GC delta: ${path}`);
    restored = restored.replace(hunk.after, hunk.before);
  }
  assert.equal(Buffer.byteLength(restored), record.baseline.bytes, path);
  assert.equal(sha(restored), record.baseline.sha256, path);
  return restored;
}
