import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = readFileSync(new URL('./native-v15-source-delta.json', import.meta.url), 'utf8');
assert.equal(sha(encoded), '6a837b6a0a2eeb517bfb9e019650d54be39b1db2816e9345017dfdc830ad17de');
const delta = JSON.parse(encoded);
assert.equal(delta.schema, 'boxhead-native-v15-source-delta-v1');

/** Historical proof only. Both complete file identities and every unique
 * reverse hunk are fixed; this function is never used on runtime evidence. */
export function restoreV14aSource(path, source) {
  assert.equal(typeof path, 'string'); assert.equal(typeof source, 'string');
  const rows = delta.files.filter(row => row.path === path);
  assert.equal(rows.length, 1, 'Unknown reviewed v15 source');
  const row = rows[0];
  assert.equal(Buffer.byteLength(source), row.candidate.bytes, 'Unreviewed v15 source size');
  assert.equal(sha(source), row.candidate.sha256, 'Unreviewed v15 source bytes');
  let restored = source;
  for (const hunk of [...row.hunks].reverse()) {
    assert.equal(restored.split(hunk.after).length, 2, 'Exact unique v15 source boundary required');
    restored = restored.replace(hunk.after, () => hunk.before);
  }
  assert.equal(Buffer.byteLength(restored), row.before.bytes, 'Frozen v14a source size changed');
  assert.equal(sha(restored), row.before.sha256, 'Frozen v14a source bytes changed');
  return restored;
}
