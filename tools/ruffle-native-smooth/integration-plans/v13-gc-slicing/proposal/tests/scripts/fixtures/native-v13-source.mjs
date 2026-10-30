import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = readFileSync(new URL('./native-v13-source-delta.json', import.meta.url), 'utf8');
assert.equal(sha(encoded), '7f0e1da58fdcdd4fc38e1559bd60beb44df2b883b6ee6f2c22053a5264d09eb4');
const delta = JSON.parse(encoded);
assert.equal(delta.schema, 'boxhead-native-v13-support-source-delta-v1');

/** Historical proof only: require the complete reviewed candidate first,
 * then remove each exact additive region and require the complete predecessor.
 * This never accepts an arbitrary input file or a runtime-selected hash. */
export function restoreV12SupportSource(path, source) {
  assert.equal(typeof path, 'string'); assert.equal(typeof source, 'string');
  const rows = delta.files.filter(row => row.path === path);
  assert.equal(rows.length, 1, 'Unknown historical support source');
  const row = rows[0];
  assert.equal(Buffer.byteLength(source), row.candidate.bytes);
  assert.equal(sha(source), row.candidate.sha256);
  let restored = source;
  for (const hunk of [...row.hunks].reverse()) {
    assert.equal(restored.split(hunk.after).length, 2, 'Historical delta must be unique');
    restored = restored.replace(hunk.after, () => hunk.before);
  }
  assert.equal(Buffer.byteLength(restored), row.before.bytes);
  assert.equal(sha(restored), row.before.sha256);
  return restored;
}
