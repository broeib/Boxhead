import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const manifestSha = '6ec8770a302a0ab05e255b1b2cf9d2350c8eb900b33e483c072397395e821d11';
const sha = x => createHash('sha256').update(x).digest('hex');
export function secondaryPredecessor(path, source) {
  const manifest = readFileSync(new URL('../fixtures/membership-secondary-reversal-v1.json', import.meta.url), 'utf8');
  assert.equal(sha(manifest), manifestSha, 'Exact reviewed secondary reversal is required');
  const entry = JSON.parse(manifest).entries[path];
  assert(entry, 'Unknown secondary source');
  assert.equal(Buffer.byteLength(source), source.length, 'Reviewed offsets require ASCII');
  assert.equal(sha(source), entry.after, 'Exact current secondary source is required');
  let out = source, boundary = out.length;
  for (const hunk of [...entry.hunks].reverse()) {
    assert(Number.isSafeInteger(hunk.offset) && hunk.offset >= 0 && hunk.offset + hunk.after.length <= boundary);
    assert.equal(out.slice(hunk.offset, hunk.offset + hunk.after.length), hunk.after);
    out = out.slice(0, hunk.offset) + hunk.before + out.slice(hunk.offset + hunk.after.length);
    boundary = hunk.offset;
  }
  assert.equal(sha(out), entry.before, 'Exact historical secondary source is required');
  return out;
}
