import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { metadataPredecessorBridge, ANCHOR_METADATA_BRIDGE_SHA256,
  ANCHOR_METADATA_PREDECESSOR_SHA256, ANCHOR_METADATA_REVERSAL_SHA256 } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import { stripCompactStepBridge, COMPACT_STEP_BASE_BRIDGE_SHA256 } from '../../scripts/lib/native-compact-step-source.mjs';

const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const current = membershipV1Predecessor(membershipV2Predecessor(source('tools/original-bridge/CMain.bridge.asinc')));
const reversal = source('tools/ruffle-native-anchor-metadata/source-reversal.json');
const row = JSON.parse(reversal).files.find(value => value.path === 'proposal/tools/original-bridge/CMain.bridge.asinc');

test('metadata predecessor restoration authenticates the historic metadata bridge and exact reversal', () => {
  assert.equal(sha(current), ANCHOR_METADATA_BRIDGE_SHA256);
  assert.equal(sha(reversal), ANCHOR_METADATA_REVERSAL_SHA256);
  const previous = metadataPredecessorBridge(current);
  assert.equal(sha(previous), ANCHOR_METADATA_PREDECESSOR_SHA256);
  assert.equal(Buffer.byteLength(previous), row.before.bytes);
  assert.equal(sha(stripCompactStepBridge(previous)), COMPACT_STEP_BASE_BRIDGE_SHA256);
  assert(current.includes('_global.boxheadNativeAnchorMetadataV1("prewarm")'));
  assert(!previous.includes('boxheadNativeAnchorMetadataV1'));
  assert.equal(sha(membershipV1Predecessor(membershipV2Predecessor(source('tools/original-bridge/CMain.bridge.asinc')))), ANCHOR_METADATA_BRIDGE_SHA256);
});

test('metadata predecessor rejects missing, duplicated, edited and unrelated candidate bytes', () => {
  for (const hunk of row.hunks) {
    assert.throws(() => metadataPredecessorBridge(current.replace(hunk.after, hunk.before)), /Exact current metadata bridge/);
    assert.throws(() => metadataPredecessorBridge(current.replace(hunk.after, hunk.after + hunk.after)), /Exact current metadata bridge/);
    assert.throws(() => metadataPredecessorBridge(current.replace(hunk.after, hunk.after.replace(' ', '\t'))), /Exact current metadata bridge/);
  }
  const unrelated = current.replace('this.State_RunWorld(true);', 'this.State_RunWorld(false);');
  assert.notEqual(unrelated, current);
  for (const changed of [unrelated, current + '\n', metadataPredecessorBridge(current)])
    assert.throws(() => metadataPredecessorBridge(changed), /Exact current metadata bridge/);
  assert.throws(() => metadataPredecessorBridge(null), /Exact metadata bridge source/);
});

test('metadata predecessor never accepts a changed reversal map', () => {
  const changed = JSON.parse(reversal);
  changed.files.find(value => value.path === row.path).hunks[0].before += ' ';
  for (const encoded of [reversal + '\n', JSON.stringify(changed), '{}'])
    assert.throws(() => metadataPredecessorBridge(current, encoded), /Exact metadata reversal/);
});

test('all historical source guards remain byte-pinned and still reject historical gameplay mutation', () => {
  for (const [file, expected] of [
    ['native-compact-step-source.mjs', '97bb6e16e67a08e8a658c87c2dcbfac6bba1d69a3d38b3653ed0efe35c2a0245'],
    ['native-staged-step-source.mjs', '00afe934e9472896a38b791d9d109465928d3782c4544d130365cb7a1880708c'],
    ['native-scalar-routes-source.mjs', 'b65ad048b0cd3a23d2c3b24cda5c20618e70ea44b6ad789f719841ba9f49d368'],
  ]) assert.equal(sha(source('scripts/lib/' + file)), expected, file);
  const previous = metadataPredecessorBridge(current);
  assert.throws(() => stripCompactStepBridge(previous.replace('b.clock = tick * b.frameMs;', 'b.clock = tick * 41;')), /predecessor/);
});
