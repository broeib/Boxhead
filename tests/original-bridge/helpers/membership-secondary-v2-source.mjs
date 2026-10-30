import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const manifestSha = 'b6a658b136c5a2dfbbfcf3641982380de768de785be6d00b3216eb87ffee22fe';
const sha = x => createHash('sha256').update(x).digest('hex');
const hudLabelSha = '9e568b9b635f67bf2d29154a7dc8ddbd2544ed931ce6c0b1f7abd57f9e939ecb';
const historicalHUDLabelSha = 'e3c9c5dd0b16afe3d86a6354869fb6731f287ec63df35ad190db4c2dff0630fd';

// Authenticate the complete source before reversing only the HUD label edit.
// The reviewed V2/V1 manifests and their historical hashes remain unchanged.
export function personalHUDLabelPredecessor(source) {
  assert.equal(typeof source, 'string', 'Exact HUD label source is required');
  assert.equal(sha(source), hudLabelSha, 'Exact current HUD label source is required');
  const current = '      clip.mcPersonalProgress.text = "P" + slot + " LVL " + (record != undefined ? record.level : 0);';
  const historical = '      clip.mcPersonalProgress.text = "P" + slot + " PERSONAL LVL " + (record != undefined ? record.level : 0);';
  const out = source.replace(current, historical);
  assert.equal(sha(out), historicalHUDLabelSha, 'Exact historical HUD label source is required');
  return out;
}

export function secondaryV2Predecessor(path, source) {
  const manifest = readFileSync(new URL('../fixtures/membership-secondary-reversal-v2.json', import.meta.url), 'utf8');
  assert.equal(sha(manifest), manifestSha, 'Exact reviewed secondary reversal is required');
  const entry = JSON.parse(manifest).entries[path];
  assert(entry, 'Unknown secondary source');
  assert.equal(Buffer.byteLength(source), source.length, 'Reviewed offsets require ASCII');
  if (path === 'tools/original-bridge/CMain.progression.asinc' && sha(source) === hudLabelSha)
    source = personalHUDLabelPredecessor(source);
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
