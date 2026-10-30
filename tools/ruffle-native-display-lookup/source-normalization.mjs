import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DISPLAY_LOOKUP_DELTA_SHA256 = '254f04c1558d23a354e22fed362e2b01bed00edd44daf06d11d1dd6c7fcefed1';
export const DISPLAY_LOOKUP_PREDECESSORS = Object.freeze({
  'core/src/avm1/object.rs': Object.freeze({
    bytes: 20276,
    sha256: '1929a336bd4b60cae4491b28542116f88027f823e36b2dd5b2936ffc4458b2bc',
  }),
  'core/src/avm1/object/script_object.rs': Object.freeze({
    bytes: 43753,
    sha256: '2189a94b6c6c789c2e702dd69ad6bfb56af244d457ce2bc3cca7f9f783f44399',
  }),
});

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = readFileSync(new URL('./source-delta.json', import.meta.url));
assert.equal(hash(bytes), DISPLAY_LOOKUP_DELTA_SHA256, 'Unreviewed display lookup source-delta metadata');
const delta = JSON.parse(bytes);
assert.equal(delta.schema, 'boxhead-native-display-lookup-source-delta-v1');
assert.deepEqual(delta.files.map(row => row.path).sort(), Object.keys(DISPLAY_LOOKUP_PREDECESSORS).sort());
for (const row of delta.files) {
  const old = DISPLAY_LOOKUP_PREDECESSORS[row.path];
  assert.equal(row.predecessorBytes, old.bytes);
  assert.equal(row.predecessorSha256, old.sha256);
}

export function restoreReviewedDisplayLookupSource(path, source) {
  const old = Object.hasOwn(DISPLAY_LOOKUP_PREDECESSORS, path)
    ? DISPLAY_LOOKUP_PREDECESSORS[path] : undefined;
  assert(old, 'Unknown display lookup source path');
  assert.equal(typeof source, 'string');
  const record = delta.files.find(row => row.path === path);
  assert.equal(Buffer.byteLength(source), record.candidateBytes, 'Unreviewed display lookup source length');
  assert.equal(hash(source), record.candidateSha256, 'Unreviewed display lookup source change');
  for (const { before, after } of [...record.hunks].reverse()) {
    assert.equal(source.split(after).length - 1, 1, 'Exact unique display lookup reverse hunk required');
    source = source.replace(after, before);
  }
  assert.equal(Buffer.byteLength(source), old.bytes);
  assert.equal(hash(source), old.sha256, 'Frozen v14 object source changed');
  return source;
}
