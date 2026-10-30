import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import { secondaryPredecessor } from './helpers/membership-secondary-source.mjs';
import { personalHUDLabelPredecessor, secondaryV2Predecessor } from './helpers/membership-secondary-v2-source.mjs';
const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
test('exact V2 bridge reverses to authenticated V1 and then historical metadata', () => {
  const now = source('tools/original-bridge/CMain.bridge.asinc');
  const v1 = membershipV2Predecessor(now);
  assert.doesNotThrow(() => metadataPredecessorBridge(membershipV1Predecessor(v1)));
  for (const bad of [now + '\n', now.replace('this.State_RunWorld(true);', 'this.State_RunWorld(false);'), v1, null])
    assert.throws(() => membershipV2Predecessor(bad));
});
test('each exact V2 secondary source passes unchanged V1 and historical guards', () => {
  for (const name of ['CMain.staged-step.asinc', 'CMain.progression.asinc', 'CMain.replay.asinc']) {
    const path = 'tools/original-bridge/' + name, now = source(path);
    const v1 = secondaryV2Predecessor(path, now);
    assert.doesNotThrow(() => secondaryPredecessor(path, v1));
    assert.throws(() => secondaryV2Predecessor(path, now + '\n'));
  }
});

test('HUD label reversal restores the byte-exact historical source before unchanged V2/V1 guards', () => {
  const path = 'tools/original-bridge/CMain.progression.asinc', now = source(path);
  const historical = personalHUDLabelPredecessor(now);
  assert.equal(createHash('sha256').update(historical).digest('hex'),
    'e3c9c5dd0b16afe3d86a6354869fb6731f287ec63df35ad190db4c2dff0630fd');
  assert.equal(historical, now.replace('" LVL "', '" PERSONAL LVL "'));
  const v1 = secondaryV2Predecessor(path, now);
  assert.equal(v1, secondaryV2Predecessor(path, historical));
  const original = secondaryPredecessor(path, v1);
  assert(original.includes('" PERSONAL LVL "'));
  assert.throws(() => personalHUDLabelPredecessor(historical));
});

test('HUD label reversal rejects unrelated edits, changed labels and newline changes', () => {
  const path = 'tools/original-bridge/CMain.progression.asinc', now = source(path);
  const historical = personalHUDLabelPredecessor(now);
  for (const bad of [
    now + '\n', now.replaceAll('\n', '\r\n'),
    now.replace('ownerCount != 1', 'ownerCount < 1'),
    now.replace('" LVL "', '" LEVEL "'),
    historical + '\n', historical.replace('ownerCount != 1', 'ownerCount < 1'),
  ]) {
    assert.notEqual(bad, now);
    assert.throws(() => personalHUDLabelPredecessor(bad));
    assert.throws(() => secondaryV2Predecessor(path, bad));
  }
});
