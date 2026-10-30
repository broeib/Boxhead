import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchClass } from '../../scripts/build-original-swf.mjs';

// Runs the actual AS2 helper as JavaScript. The native/browser test remains
// necessary to establish actual weapon objects, pickup and peer agreement.
const source = readFileSync(new URL('../../tools/original-bridge/CMain.deathmatch-unlocks.asinc', import.meta.url), 'utf8');
const CMain = runInNewContext('(class CMain {' + source.replace(/static function ([A-Za-z_][A-Za-z_0-9]*)\(/g, 'static $1(') + '})');

function scenario(options = {}) {
  const events = [];
  const unlocks = [
    { mActive: true, mClassID: 'CThing_Creature_Player', mValue: 'uzi' },
    { mActive: true, mClassID: 'CThing_Weapon_UZI', mValue: true },
    { mActive: true, mClassID: 'CThing_Creature_Player', mValue: 'shotgun' },
    { mActive: false, mClassID: 'CThing_Creature_Player', mValue: 'rocket' },
  ];
  const player = { mPlayerIndex: options.slot ?? 1, mWeapons: { uzi: {}, shotgun: {}, rocket: {} },
    mWorld: { mUpgrades: { mMultiplierList: unlocks } },
    NewWeapon: name => events.push(name), ResetWeapons: () => events.push('reset') };
  CMain._this = { mBH: { active: true, mode: 'DeathMatch', tick: 60,
    initialPlayers: 1, guestGeneration: 1, ...options } };
  return { player, events, unlocks };
}

test('late and replacement DeathMatch guests receive active original unlocks and the initial ammo reset', () => {
  for (const options of [{}, { initialPlayers: 2, guestGeneration: 2 }]) {
    const { player, events, unlocks } = scenario(options);
    const before = JSON.stringify(unlocks);
    CMain.BH_DeathmatchPlayerReady(player);
    assert.deepEqual(events, ['uzi', 'shotgun', 'reset']);
    assert.equal(JSON.stringify(unlocks), before, 'shared upgrade state must not change');
  }
});

test('initial roster, tick-one joining player, offline and Coop retain original initialization', () => {
  for (const options of [{ slot: 0 }, { tick: 0 }, { initialPlayers: 2 },
    { active: false }, { mode: 'Coop' }]) {
    const { player, events } = scenario(options);
    CMain.BH_DeathmatchPlayerReady(player);
    assert.deepEqual(events, []);
  }
});

test('invalid active weapon fails closed instead of silently skipping an unlock', () => {
  const { player, unlocks } = scenario();
  unlocks[0].mValue = 'unknown';
  assert.throws(() => CMain.BH_DeathmatchPlayerReady(player), /invalid DeathMatch weapon unlock/);
});

test('SWF builder installs the helper and calls it after the original inventory initialization', () => {
  const original = readFileSync(new URL('../../decompiled_clean/scripts/__Packages/Thing/Creature/CThing_Creature_Player.as', import.meta.url), 'utf8');
  const patched = patchClass('Thing/Creature/CThing_Creature_Player', original, '', '').source;
  assert.match(patched, /this\.mInvincible = 200;\s+CMain\.BH_PersonalPlayerReady\(this\);\s+CMain\.BH_DeathmatchPlayerReady\(this\);/);
  const builder = readFileSync(new URL('../../scripts/build-original-swf.mjs', import.meta.url), 'utf8');
  assert.match(builder, /'CMain\.deathmatch-unlocks\.asinc'/);
});
