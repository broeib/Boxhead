import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import { secondaryV2Predecessor } from './helpers/membership-secondary-v2-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { membershipV1Predecessor, MEMBERSHIP_V1_BRIDGE_SHA256, MEMBERSHIP_V1_REVERSAL_SHA256 } from './helpers/membership-v1-source.mjs';
import { ANCHOR_METADATA_BRIDGE_SHA256, metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';

const current = membershipV2Predecessor(readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8'));
const manifest = readFileSync(new URL('./fixtures/membership-source-reversal-v1.json', import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');

test('membership-v1 reversal binds the exact live source, manifest and historical chain', () => {
  assert.equal(sha(current), MEMBERSHIP_V1_BRIDGE_SHA256);
  assert.equal(sha(manifest), MEMBERSHIP_V1_REVERSAL_SHA256);
  const historical = membershipV1Predecessor(current, manifest);
  assert.equal(sha(historical), ANCHOR_METADATA_BRIDGE_SHA256);
  assert.doesNotThrow(() => metadataPredecessorBridge(historical));
  assert(current.includes('function BH_LeavePlayer()'));
  assert(!historical.includes('function BH_LeavePlayer()'));
});

test('membership-v1 reversal refuses any unrelated, gameplay or manifest mutation', () => {
  const edited = current.replace('this.State_RunWorld(true);', 'this.State_RunWorld(false);');
  assert.notEqual(edited, current);
  for (const bad of [edited, current + '\n', membershipV1Predecessor(current), null])
    assert.throws(() => membershipV1Predecessor(bad));
  assert.throws(() => membershipV1Predecessor(current, manifest + '\n'), /Exact membership reversal/);
  const changed = JSON.parse(manifest); changed.hunks[0].before += ' ';
  assert.throws(() => membershipV1Predecessor(current, JSON.stringify(changed)), /Exact membership reversal/);
});

test('secondary historical sources require exact current bytes before reversal', async () => {
  const { secondaryPredecessor } = await import('./helpers/membership-secondary-source.mjs');
  for (const name of ['CMain.staged-step.asinc', 'CMain.progression.asinc', 'CMain.replay.asinc']) {
    const path = 'tools/original-bridge/' + name;
    const value = secondaryV2Predecessor(path, readFileSync(new URL('../../' + path, import.meta.url), 'utf8'));
    assert.notEqual(secondaryPredecessor(path, value), value);
    assert.throws(() => secondaryPredecessor(path, value + '\n'), /Exact current secondary source/);
    assert.throws(() => secondaryPredecessor(path, secondaryPredecessor(path, value)), /Exact current secondary source/);
  }
  assert.throws(() => secondaryPredecessor('unreviewed', current), /Unknown secondary source/);
});
