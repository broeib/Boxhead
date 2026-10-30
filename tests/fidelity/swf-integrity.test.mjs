import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { inspectSwf, ORIGINAL_SWF_SHA256, sha256, requireSameArtwork, requireOnlyClassCodeChanges } from '../../tools/fidelity/swf-inventory.mjs';
const original = await readFile(new URL('../../Boxhead_2Play.swf', import.meta.url));
const served = await readFile(new URL('../../public/Boxhead_2Play.swf', import.meta.url));
test('source and local-play SWF remain exactly the supplied original', () => {
  assert.equal(sha256(original), ORIGINAL_SWF_SHA256);
  assert.deepEqual(served, original);
});
test('inventory validates original dimensions, real artwork and sound tags', () => {
  const info = inspectSwf(original);
  assert.equal(info.width, 640); assert.equal(info.height, 480);
  assert.ok(info.nonCodeTags > 100); assert.ok(info.counts[14] > 0);
  assert.equal(requireSameArtwork(original, served).pass, true);
  const code = requireOnlyClassCodeChanges(original, served, ['/__Packages/CMain', '/__Packages/CInput']);
  assert.equal(code.pass, true);
  assert.equal(code.codeTags, code.preservedCodeTags);
  assert.deepEqual(code.changedClasses, []);
});
test('rejects corrupt compression, invalid signatures and truncated files', () => {
  assert.throws(() => inspectSwf(Buffer.from('not a movie')));
  assert.throws(() => inspectSwf(original.subarray(0, 30)));
  const corrupt = Buffer.from(original); corrupt[0] = 0;
  assert.throws(() => inspectSwf(corrupt));
});
