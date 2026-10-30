import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ANCHOR_METADATA_BRIDGE_SHA256 } from '../../../scripts/lib/native-anchor-metadata-source.mjs';

// This is a source-only reversal, not runtime validation. It accepts exactly
// the reviewed guest-membership v1 bytes and the pinned reversal manifest,
// then hands the byte-exact older source to the unchanged historical guards.
export const MEMBERSHIP_V1_BRIDGE_SHA256 = '9084a4431291bf124f9a46bf8ba77f294b17206453606f851dfccdecb099ffdc';
export const MEMBERSHIP_V1_REVERSAL_SHA256 = '3355e3b74a25186a5973f5e56da482bb52625de40dbe2c82845087fbb2987e35';
const sha = value => createHash('sha256').update(value).digest('hex');
export function membershipV1Predecessor(source, manifest = readFileSync(
  new URL('../fixtures/membership-source-reversal-v1.json', import.meta.url), 'utf8')) {
  assert.equal(typeof source, 'string', 'Exact membership bridge source is required');
  assert.equal(sha(source), MEMBERSHIP_V1_BRIDGE_SHA256, 'Exact current membership-v1 bridge is required');
  assert.equal(typeof manifest, 'string', 'Exact membership reversal is required');
  assert.equal(sha(manifest), MEMBERSHIP_V1_REVERSAL_SHA256, 'Exact membership reversal is required');
  const value = JSON.parse(manifest);
  assert.equal(value.version, 1);
  assert.equal(value.after.sha256, MEMBERSHIP_V1_BRIDGE_SHA256);
  assert.equal(value.before.sha256, ANCHOR_METADATA_BRIDGE_SHA256);
  assert.equal(Buffer.byteLength(source), value.after.bytes);
  assert.equal(Buffer.byteLength(source), source.length, 'Offsets require the reviewed ASCII source');
  let previous = source, boundary = source.length;
  for (const hunk of [...value.hunks].reverse()) {
    assert(Number.isSafeInteger(hunk.offset) && hunk.offset >= 0 && hunk.offset + hunk.after.length <= boundary);
    assert.equal(previous.slice(hunk.offset, hunk.offset + hunk.after.length), hunk.after, 'Exact membership hunk is required');
    previous = previous.slice(0, hunk.offset) + hunk.before + previous.slice(hunk.offset + hunk.after.length);
    boundary = hunk.offset;
  }
  assert.equal(Buffer.byteLength(previous), value.before.bytes);
  assert.equal(sha(previous), ANCHOR_METADATA_BRIDGE_SHA256, 'Exact historical metadata bridge is required');
  return previous;
}
