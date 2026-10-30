import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ANCHOR_METADATA_BRIDGE_SHA256 = '87bd63670a303cddc56a52de951b04560eea38d5fd5e1f7bc19b7817151fddec';
export const ANCHOR_METADATA_PREDECESSOR_SHA256 = '27e4749c382c25c6c48bf33ed29017d81bf4d0be72d36f649ca4aae487adadde';
export const ANCHOR_METADATA_REVERSAL_SHA256 = '1aa0df5eb7258ad4d1455953d6edadf4bf36cf338e6c3dab0c9ffb9d861b77e4';
const sha = value => createHash('sha256').update(value).digest('hex');

// Source-only reference preparation. The live candidate and native observations
// are never rewritten. Historical layer guards retain their original hashes.
// No approximate matching, unknown source revision, or already-stripped input
// is accepted; callers apply historical mutation fixtures only after this step.
export function metadataPredecessorBridge(source, reversalSource = readFileSync(
  new URL('../../tools/ruffle-native-anchor-metadata/source-reversal.json', import.meta.url), 'utf8')) {
  assert.equal(typeof source, 'string', 'Exact metadata bridge source is required');
  assert.equal(sha(source), ANCHOR_METADATA_BRIDGE_SHA256, 'Exact current metadata bridge is required');
  assert.equal(typeof reversalSource, 'string', 'Exact metadata reversal source is required');
  assert.equal(sha(reversalSource), ANCHOR_METADATA_REVERSAL_SHA256, 'Exact metadata reversal is required');
  const rows = JSON.parse(reversalSource).files.filter(row => row.path === 'proposal/tools/original-bridge/CMain.bridge.asinc');
  assert.equal(rows.length, 1, 'Exactly one metadata bridge reversal is required');
  const row = rows[0];
  assert.equal(row.after.sha256, ANCHOR_METADATA_BRIDGE_SHA256);
  assert.equal(row.before.sha256, ANCHOR_METADATA_PREDECESSOR_SHA256);
  assert.equal(Buffer.byteLength(source), row.after.bytes);
  let previous = source;
  for (const hunk of [...row.hunks].reverse()) {
    assert.equal(previous.split(hunk.after).length - 1, 1, 'Exact metadata bridge hook must occur once');
    previous = previous.replace(hunk.after, () => hunk.before);
  }
  assert.equal(Buffer.byteLength(previous), row.before.bytes);
  assert.equal(sha(previous), ANCHOR_METADATA_PREDECESSOR_SHA256, 'Exact pre-metadata bridge is required');
  return previous;
}
