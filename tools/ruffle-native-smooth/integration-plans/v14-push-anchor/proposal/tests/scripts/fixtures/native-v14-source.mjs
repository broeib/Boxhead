import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = readFileSync(new URL('./native-v14-source-delta.json', import.meta.url), 'utf8');
assert.equal(sha(encoded), '5fa92f34079a9b658b47d8b3b20879ed7906f6c96de164f773645d4ca40f944c');
const delta = JSON.parse(encoded);
assert.equal(delta.schema, 'boxhead-native-v14-source-delta-v1');

/** Historical source proof only. Both complete endpoints and every unique
 * intermediate replacement are fixed independently of runtime metadata. */
export function restoreV13Source(path, source) {
  assert.equal(typeof path, 'string'); assert.equal(typeof source, 'string');
  const rows = delta.files.filter(row => row.path === path);
  assert.equal(rows.length, 1, 'Unknown reviewed v14 source');
  const row = rows[0];
  assert.equal(Buffer.byteLength(source), row.candidate.bytes, 'Unreviewed v14 source size');
  assert.equal(sha(source), row.candidate.sha256, 'Unreviewed v14 source bytes');
  let restored = source;
  for (const hunk of [...row.hunks].reverse()) {
    assert.equal(restored.split(hunk.after).length, 2, 'Exact unique v14 source boundary required');
    restored = restored.replace(hunk.after, () => hunk.before);
  }
  assert.equal(Buffer.byteLength(restored), row.before.bytes, 'Frozen v13 source size changed');
  assert.equal(sha(restored), row.before.sha256, 'Frozen v13 source bytes changed');
  return restored;
}
