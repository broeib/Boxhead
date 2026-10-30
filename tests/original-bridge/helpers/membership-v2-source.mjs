import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MEMBERSHIP_V1_BRIDGE_SHA256 } from './membership-v1-source.mjs';

// This is a source-only reversal, not runtime validation. It accepts exactly
// the reviewed guest-membership v2 bytes and the pinned reversal manifest,
// then hands the byte-exact older source to the unchanged historical guards.
export const MEMBERSHIP_V2_BRIDGE_SHA256 = '3350ecdcad4da28b4fade9bc4d735367ee1baaf27970ec3eb1ecb8209ec9a6c9';
export const MEMBERSHIP_V2_REVERSAL_SHA256 = 'd50b0266b8e8efdf9f683edae8805065a39a13d096ca89efaed6e92213490105';
const sha = value => createHash('sha256').update(value).digest('hex');
export function membershipV2Predecessor(source, manifest = readFileSync(
  new URL('../fixtures/membership-source-reversal-v2.json', import.meta.url), 'utf8')) {
  assert.equal(typeof source, 'string', 'Exact membership bridge source is required');
  assert.equal(sha(source), MEMBERSHIP_V2_BRIDGE_SHA256, 'Exact current membership-v2 bridge is required');
  assert.equal(typeof manifest, 'string', 'Exact membership reversal is required');
  assert.equal(sha(manifest), MEMBERSHIP_V2_REVERSAL_SHA256, 'Exact membership reversal is required');
  const value = JSON.parse(manifest);
  assert.equal(value.version, 1);
  assert.equal(value.after.sha256, MEMBERSHIP_V2_BRIDGE_SHA256);
  assert.equal(value.before.sha256, MEMBERSHIP_V1_BRIDGE_SHA256);
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
  assert.equal(sha(previous), MEMBERSHIP_V1_BRIDGE_SHA256, 'Exact historical membership-v1 bridge is required');
  return previous;
}
