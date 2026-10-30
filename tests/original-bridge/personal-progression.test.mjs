import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchClass } from '../../scripts/build-original-swf.mjs';

// Execute the production bridge helpers themselves. CUpgrades below is a small
// collaborator fixture for ownership/routing, not a replacement native engine.
// Native unlock thresholds, rendering and replay remain browser acceptance.
const source = readFileSync(new URL('../../tools/original-bridge/CMain.progression.asinc', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
  const events = [];
  const scoreClip = {};
  class UpgradesFixture {
    constructor(view) {
      this.mWorld = view;
      this.mIDCount = 0;
      this.mTick = 0;
      this.mMultiplierIndex = 1;
      this.mMultiplierTick = this.mMultiplierTickTotal = 50;
      this.mMultipleKillsIndex = 0;
      this.mMultipleKillsTick = this.mMultipleKillsTickTotal = 50;
      this.Level = { mPlayerCount: 0, Zombie_Count: 10 };
      this.mMultipliers = [[{ mActive: false }], [{ mActive: true }]];
      this.mMultipleKills = [];
      this.CThing_Weapon_Pistol = { IDCount: 0, DoubleDamage: false, mOriginalStats: { mDamage: 5 } };
      events.push({ kind: 'construct', owners: Object.keys(view.mThing_Collection.mPlayerThings) });
      view.mHud.AddMessage_Level('constructor level');
    }
    get mMultiplier() { return this.mMultiplierIndex; }
    set mMultiplier(value) { this.mMultiplierIndex = Math.max(1, value); }
    set mMultipleKill(value) { this.mMultipleKillsIndex = Math.max(0, value); }
    SetDifficulty(difficulty) {
      events.push({ kind: 'difficulty', slot: this.mBHOwnerSlot, difficulty });
      if (difficulty > 0) {
        this.mMultiplier = 10;
        for (const player of Object.values(this.mWorld.mThing_Collection.mPlayerThings)) player.NewWeapon('fixture-grant');
      }
    }
    LogKills(count) {
      events.push({ kind: 'kills', slot: this.mBHOwnerSlot, count });
      this.mMultiplier += count;
    }
    Register_Object(thing) {
      events.push({ kind: 'object-register', slot: this.mBHOwnerSlot, thing });
      thing.mUpgradeObject = {};
    }
    Register_Weapon(thing) {
      events.push({ kind: 'weapon-register', slot: this.mBHOwnerSlot, thing });
      thing.mUpgradeObject = {};
    }
    Register_Creature_Player(thing) {
      events.push({ kind: 'player-register', slot: this.mBHOwnerSlot, thing });
      thing.mUpgradeObject = {};
    }
  }
  const CMain = runInNewContext(
    '(class CMain {' + source.replace(/static function ([A-Za-z_][A-Za-z_0-9]*)\(/g, 'static $1(') + '})',
    { World: { CUpgrades: UpgradesFixture, CHud: { mcScoreTotal: scoreClip } }, Error },
  );
  const world = {
    mBHPersonalProgress: [undefined, undefined],
    mThing_Collection: { mPlayerThings: {} },
    mHud: { AddMessage_Upgrade: (text) => events.push({ kind: 'message', text }) },
    mUpgrades: { mMultiplier: 99, Level: { Zombie_Count: 60, mZombieCount: 9 } },
  };
  CMain._this = {
    mcWorld: world,
    mBH: { active: true, personalProgression: true, mode: 'Coop', initialPlayers: 1, settings: { difficulty: 0 }, ...overrides },
  };
  CMain.BH_Integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
  CMain.BH_Scalars = (object) => Object.fromEntries(Object.entries(object ?? {})
    .filter(([, value]) => ['number', 'boolean', 'string'].includes(typeof value)));
  CMain.BH_ThingScalars = (object, kernel) => {
    assert.equal(kernel, undefined, 'This ownership fixture exercises the absent-kernel route');
    return CMain.BH_Scalars(object);
  };
  const player = (slot) => {
    const result = {
      _CLASSID_: 'CThing_Creature_Player', mPlayerIndex: slot - 1, mUniqueID: slot * 100, mWorld: world,
      weapons: ['pistol'], NewWeapon(name) { this.weapons.push(name); },
    };
    world.mThing_Collection.mPlayerThings[`p${slot}`] = result;
    return result;
  };
  return { CMain, world, events, player, scoreClip };
}

test('personal HUD labels use P1 LVL and P2 LVL with each slot\'s own level', () => {
  const { CMain, world, player, scoreClip } = harness();
  Object.assign(scoreClip, {
    tfScore: {}, tfMultiple: {}, mcPersonalProgress: {},
    mcTimer: { _totalframes: 10, gotoAndStop() {} },
  });
  const hud = { PadScore: (value) => value };
  for (const slot of [1, 2]) {
    CMain.BH_PersonalPlayerReady(player(slot));
    world.mBHPersonalProgress[slot - 1].level = slot * 3;
  }
  for (const slot of [1, 2]) {
    CMain._this.mBH.localSlot = slot;
    CMain.BH_PersonalHUD(hud);
    assert.equal(scoreClip.mcPersonalProgress.text, `P${slot} LVL ${slot * 3}`);
  }
});

test('initial owner keeps difficulty grants; late player receives an independent zero-progress pistol baseline', () => {
  const { CMain, world, events, player } = harness({ settings: { difficulty: 1 } });
  const host = player(1);
  CMain.BH_PersonalPlayerReady(host);
  const first = world.mBHPersonalProgress[0];
  assert.deepEqual(host.weapons, ['pistol', 'fixture-grant']);
  assert.equal(first.level, 9);
  first.score = 12345;
  first.kills = 30;
  first.upgrades.CThing_Weapon_Pistol.DoubleDamage = true;
  first.upgrades.mMultipliers[0][0].mActive = true;

  const guest = player(2);
  CMain.BH_PersonalPlayerReady(guest);
  const second = world.mBHPersonalProgress[1];
  assert.deepEqual(guest.weapons, ['pistol']);
  assert.equal(second.score, 0);
  assert.equal(second.kills, 0);
  assert.equal(second.level, 0);
  assert.equal(second.upgrades.mMultiplier, 1);
  assert.equal(second.upgrades.CThing_Weapon_Pistol.DoubleDamage, false);
  assert.equal(second.upgrades.mMultipliers[0][0].mActive, false);
  assert.notEqual(first.upgrades, second.upgrades);
  assert.notEqual(first.upgrades.mMultipliers, second.upgrades.mMultipliers);
  assert.equal(first.upgrades.mWorld.mThing_Collection.mPlayerThings.owner, host);
  assert.equal(second.upgrades.mWorld.mThing_Collection.mPlayerThings.owner, guest);
  assert.deepEqual(events.filter((event) => event.kind === 'construct').map((event) => event.owners), [[], []]);
  assert.deepEqual(events.filter((event) => event.kind === 'difficulty'), [{ kind: 'difficulty', slot: 1, difficulty: 1 }]);
  assert.deepEqual(world.mUpgrades.Level, { Zombie_Count: 60, mZombieCount: 9 });
  CMain.BH_PersonalPlayerReady(guest);
  assert.equal(world.mBHPersonalProgress[1], second, 'repeated initialization must not reset progression');
});

test('a replacement guest starts fresh and old attacks cannot earn its personal progression', () => {
  const { CMain, world, player } = harness({ membershipVersion: 1, guestGeneration: 1 });
  CMain.BH_PersonalPlayerReady(player(1));
  const previous = player(2);
  CMain.BH_PersonalPlayerReady(previous);
  const old = world.mBHPersonalProgress[1];
  old.score = 500; old.kills = 4; old.level = 3;
  const projectile = CMain.BH_InheritCredit(previous, { _CLASSID_: 'CThing_Shot_Bullet' });
  const pending = { _CLASSID_: 'CThing_Creature_Zombie', mLife: 0, mScore: 100 };
  CMain.BH_RecordLethalDamage({ mOwner: previous }, pending, 10);
  delete world.mThing_Collection.mPlayerThings.p2;
  world.mBHPersonalProgress[1] = undefined;
  assert.equal(CMain.BH_OwnerSlot(projectile), 0);
  CMain._this.mBH.guestGeneration = 2;
  const replacement = player(2);
  CMain.BH_PersonalPlayerReady(replacement);
  const fresh = world.mBHPersonalProgress[1];
  assert.notEqual(fresh, old);
  assert.deepEqual([fresh.score, fresh.kills, fresh.level], [0, 0, 0]);
  assert.equal(CMain.BH_OwnerSlot(previous), 0);
  assert.equal(CMain.BH_OwnerSlot(projectile), 0);
  CMain.BH_PersonalKill(world, pending);
  assert.deepEqual([fresh.score, fresh.kills, fresh.level], [0, 0, 0]);
  const current = { _CLASSID_: 'CThing_Creature_Zombie', mLife: 0, mScore: 100 };
  CMain.BH_RecordLethalDamage({ mOwner: replacement }, current, 10);
  CMain.BH_PersonalKill(world, current);
  assert.equal(fresh.kills, 1);
  assert.equal(fresh.score, 200);
});

test('v2 initial guest receives difficulty but a replacement starts at zero and cannot inherit old credit', () => {
  const { CMain, world, events, player } = harness({ membershipVersion: 2, initialPlayers: 2,
    guestGeneration: 1, settings: { difficulty: 1 } });
  const host = player(1), oldGuest = player(2);
  CMain.BH_PersonalPlayerReady(host);
  CMain.BH_PersonalPlayerReady(oldGuest);
  assert.deepEqual(oldGuest.weapons, ['pistol', 'fixture-grant']);
  const oldShot = CMain.BH_InheritCredit(oldGuest, {});
  const oldKill = { _CLASSID_: 'CThing_Creature_Zombie', mLife: 0, mScore: 100 };
  CMain.BH_RecordLethalDamage({ mOwner: oldGuest }, oldKill, 10);
  const hostRecord = world.mBHPersonalProgress[0]; hostRecord.score = 123;
  delete world.mThing_Collection.mPlayerThings.p2;
  world.mBHPersonalProgress[1] = undefined;
  CMain._this.mBH.guestGeneration = 2;
  const newGuest = player(2);
  CMain.BH_PersonalPlayerReady(newGuest);
  const fresh = world.mBHPersonalProgress[1];
  assert.deepEqual(newGuest.weapons, ['pistol']);
  assert.deepEqual([fresh.score, fresh.kills, fresh.level], [0, 0, 0]);
  assert.equal(hostRecord.score, 123);
  assert.equal(CMain.BH_OwnerSlot(oldShot), 0);
  CMain.BH_PersonalKill(world, oldKill);
  assert.equal(fresh.kills, 0);
  assert.equal(events.filter(event => event.kind === 'difficulty' && event.slot === 2).length, 1);
});

test('a surviving object is registered again when its guest owner generation changes', () => {
  const { CMain, world, events, player } = harness({ membershipVersion: 1, guestGeneration: 1 });
  const first = player(2);
  CMain.BH_PersonalPlayerReady(first);
  const object = { _CLASSID_: 'CThing_Object_Barrel', mParent: first };
  CMain.BH_UpgradeContext(world.mUpgrades, object, 'ApplyUpgrade_Object');
  delete world.mThing_Collection.mPlayerThings.p2;
  world.mBHPersonalProgress[1] = undefined;
  CMain._this.mBH.guestGeneration = 2;
  const second = player(2);
  CMain.BH_PersonalPlayerReady(second);
  object.mParent = second;
  CMain.BH_UpgradeContext(world.mUpgrades, object, 'ApplyUpgrade_Object');
  assert.equal(events.filter(event => event.kind === 'object-register').length, 2);
});

test('only the owner of the first lethal transition receives a kill, score and multiplier progress', () => {
  const { CMain, world, player } = harness();
  const host = player(1);
  const guest = player(2);
  CMain.BH_PersonalPlayerReady(host);
  CMain.BH_PersonalPlayerReady(guest);
  const enemy = { _CLASSID_: 'CThing_Creature_Zombie', mLife: 5, mScore: 100 };
  CMain.BH_RecordLethalDamage({ mOwner: host }, enemy, 10);
  assert.equal(enemy.mBHKillerSlot, undefined, 'non-lethal damage creates no credit');
  enemy.mLife = -5;
  CMain.BH_RecordLethalDamage({ mOwner: guest }, enemy, 5);
  assert.equal(enemy.mBHKillerSlot, 2);
  enemy.mLife = -10;
  CMain.BH_RecordLethalDamage({ mOwner: host }, enemy, -5);
  assert.equal(enemy.mBHKillerSlot, 2, 'later damage cannot steal an already-lethal hit');
  CMain.BH_PersonalKill(world, enemy);
  const [first, second] = world.mBHPersonalProgress;
  assert.equal(first.score, 0);
  assert.equal(first.kills, 0);
  assert.equal(first.upgrades.mMultiplier, 1);
  assert.equal(second.kills, 1);
  assert.equal(second.upgrades.mMultiplier, 2);
  assert.equal(second.level, 1);
  assert.equal(second.score, 200);
  assert.equal(CMain.BH_KillScore(world, enemy), 200);
  CMain.BH_PersonalKill(world, enemy);
  assert.equal(second.kills, 1, 'repeated death logging must not award twice');
  assert.equal(second.score, 200);
});

test('multiple independent kills route upgrade calls to their owner without transferring another player progress', () => {
  const { CMain, world, events, player } = harness();
  CMain.BH_PersonalPlayerReady(player(1));
  CMain.BH_PersonalPlayerReady(player(2));
  for (const slot of [1, 2, 1]) {
    CMain.BH_PersonalKill(world, { _CLASSID_: 'CThing_Creature_Devil', mBHKillerSlot: slot, mScore: 50 });
  }
  const [host, guest] = world.mBHPersonalProgress;
  assert.equal(host.kills, 2);
  assert.equal(host.score, 50 * 2 + 50 * 3);
  assert.equal(host.level, 2);
  assert.equal(guest.kills, 1);
  assert.equal(guest.score, 50 * 2);
  assert.equal(guest.level, 1);
  assert.deepEqual(events.filter((event) => event.kind === 'kills').map(({ slot, count }) => [slot, count]), [[1, 1], [2, 1], [1, 1]]);
  host.upgrades.mMultiplierTick = -1;
  CMain.BH_ProcessPersonal(world);
  assert.equal(host.upgrades.mMultiplier, 2);
  assert.equal(host.level, 2, 'earned peak progression survives combo decay');
  assert.equal(guest.upgrades.mMultiplier, 2);
  assert.equal(world.mUpgrades.mMultiplier, 99, 'wave/global bookkeeping is not replaced by a personal controller');
});

test('placed explosives credit their placer; unowned barrels carry trigger credit through explosion and cluster chains', () => {
  const { CMain, world, player } = harness();
  const host = player(1);
  const guest = player(2);
  CMain.BH_PersonalPlayerReady(host);
  CMain.BH_PersonalPlayerReady(guest);
  const placed = { _CLASSID_: 'CThing_Object_Barrel', mParent: host };
  CMain.BH_BarrelCredit(placed, { mOwner: guest });
  assert.equal(placed.mBHCreditSlot, 1);
  assert.equal(placed.mParent, host, 'credit must not rewrite physics/ownership parent chains');

  const mapBarrel = { _CLASSID_: 'CThing_Object_Barrel' };
  const bullet = { _CLASSID_: 'CThing_Shot_Bullet', mParent: guest };
  CMain.BH_BarrelCredit(mapBarrel, { mOwner: guest, mAffector: bullet });
  const explosion = CMain.BH_InheritCredit(mapBarrel, { _CLASSID_: 'CThing_Effect_Explosion' });
  const nextBarrel = { _CLASSID_: 'CThing_Object_Barrel' };
  CMain.BH_BarrelCredit(nextBarrel, { mAffector: explosion });
  const nextExplosion = CMain.BH_InheritCredit(nextBarrel, { _CLASSID_: 'CThing_Effect_Explosion' });
  const larger = CMain.BH_InheritCredit(nextExplosion, { _CLASSID_: 'CThing_Effect_Explosion' });
  const cluster = CMain.BH_InheritCredit(larger, { _CLASSID_: 'CThing_Shot_ClusterShell' });
  const finalExplosion = { _CLASSID_: 'CThing_Effect_Explosion', mParent: cluster };
  assert.equal(CMain.BH_OwnerSlot(finalExplosion), 2);
  for (const thing of [mapBarrel, explosion, nextBarrel, nextExplosion, larger, cluster]) assert.equal(thing.mParent, undefined);
  const enemy = { _CLASSID_: 'CThing_Creature_Zombie', mLife: -1, mScore: 100 };
  CMain.BH_RecordLethalDamage({ mAffector: finalExplosion }, enemy, 20);
  CMain.BH_PersonalKill(world, enemy);
  assert.equal(world.mBHPersonalProgress[1].kills, 1);
  assert.equal(world.mBHPersonalProgress[0].kills, 0);
});

test('environmental and enemy kills never borrow an unrelated last player owner', () => {
  const { CMain, world, player } = harness();
  CMain.BH_PersonalPlayerReady(player(1));
  CMain.BH_PersonalPlayerReady(player(2));
  const barrel = {};
  CMain.BH_BarrelCredit(barrel, { mOwner: { _CLASSID_: 'CThing_Creature_Devil' } });
  const explosion = CMain.BH_InheritCredit(barrel, {});
  const enemy = { _CLASSID_: 'CThing_Creature_Zombie', mLife: -10, mScore: 100 };
  CMain.BH_RecordLethalDamage({ mAffector: explosion }, enemy, 10);
  assert.equal(enemy.mBHKillerSlot, 0);
  CMain.BH_PersonalKill(world, enemy);
  assert.equal(CMain.BH_KillScore(world, enemy), 0);
  assert.deepEqual(world.mBHPersonalProgress.map((record) => record.kills), [0, 0]);
  const cycle = {};
  cycle.mParent = cycle;
  assert.equal(CMain.BH_OwnerSlot(cycle), 0);
});

test('upgrade contexts register a newly credited map object and keep shared enemy/wave upgrades available', () => {
  const { CMain, world, events, player } = harness();
  const host = player(1);
  CMain.BH_PersonalPlayerReady(host);
  const personal = world.mBHPersonalProgress[0].upgrades;
  const barrel = { _CLASSID_: 'CThing_Object_Barrel', mBHCreditSlot: 1, mUpgradeObject: { mIDCount: 77 } };
  assert.equal(CMain.BH_UpgradeContext(world.mUpgrades, barrel, 'ApplyUpgrade_Object'), personal);
  assert.equal(barrel.mBHUpgradeSlot, 1);
  assert.deepEqual(barrel.mUpgradeObject, {});
  assert.equal(events.filter((event) => event.kind === 'object-register').length, 1);
  assert.equal(CMain.BH_UpgradeContext(world.mUpgrades, barrel, 'ApplyUpgrade_Object'), personal);
  assert.equal(events.filter((event) => event.kind === 'object-register').length, 1, 'context checks do not repeatedly refill/reinitialize an object');
  assert.equal(CMain.BH_UpgradeContext(personal, barrel, 'Register_Object'), personal);
  for (const name of ['CThing_Creature_Player', 'CThing_Weapon_Pistol', 'CThing_Object_Barrel']) {
    assert.equal(CMain.BH_BlockSharedUpgrade(world.mUpgrades, name), true);
    assert.equal(CMain.BH_BlockSharedUpgrade(personal, name), false);
  }
  for (const name of ['Level', 'CThing_Creature_Zombie', 'CThing_Creature_Devil']) {
    assert.equal(CMain.BH_BlockSharedUpgrade(world.mUpgrades, name), false);
  }
});

test('personal native snapshots contain stable data with complete/full and compact checkpoint scopes', () => {
  const { CMain, world, player } = harness();
  CMain.BH_PersonalPlayerReady(player(1));
  CMain.BH_PersonalPlayerReady(player(2));
  const compact = plain(CMain.BH_PersonalSnapshot(false));
  const full = plain(CMain.BH_PersonalSnapshot(true));
  assert.deepEqual(compact.map(({ ownerID, ownerSlot }) => ({ ownerID, ownerSlot })),
    [{ ownerID: 100, ownerSlot: 1 }, { ownerID: 200, ownerSlot: 2 }]);
  assert.deepEqual(full.map(({ ownerID, ownerSlot }) => ({ ownerID, ownerSlot })),
    [{ ownerID: 100, ownerSlot: 1 }, { ownerID: 200, ownerSlot: 2 }]);
  assert.equal(compact[0].score, 0);
  assert.equal(compact[0].scalars.mMultiplierTick, 50);
  assert.equal(compact[0].classes.CThing_Weapon_Pistol.DoubleDamage, false);
  assert.equal(compact[0].classes.CThing_Weapon_Pistol.original, undefined);
  assert.equal(compact[0].activated, undefined);
  assert.deepEqual(full[0].classes.CThing_Weapon_Pistol.original, { mDamage: 5 });
  assert.deepEqual(full[0].activated, [[0, 0, false], [1, 0, true]]);
  assert.deepEqual(full[0].multipleKillEntries, {});
  assert.equal(JSON.stringify(full).includes('mThing_Collection'), false);
  assert.equal(JSON.stringify(full).includes('mWorld'), false);
  world.mBHPersonalProgress[1].score = 321;
  world.mBHPersonalProgress[1].upgrades.mMultiplierTick -= 1;
  const next = plain(CMain.BH_PersonalSnapshot(false));
  assert.deepEqual(next[0], compact[0]);
  assert.equal(next[1].score, 321);
  assert.equal(next[1].scalars.mMultiplierTick, 49);
});

test('personal snapshots reject missing, duplicate or wrong-slot grant recipients and capture replacement identity', () => {
  const { CMain, world, player } = harness();
  const host = player(1), guest = player(2);
  CMain.BH_PersonalPlayerReady(host);
  CMain.BH_PersonalPlayerReady(guest);
  const owners = world.mBHPersonalProgress[0].upgrades.mWorld.mThing_Collection.mPlayerThings;
  for (const full of [false, true]) {
    delete owners.owner;
    assert.throws(() => CMain.BH_PersonalSnapshot(full), /invalid personal progression owner mapping/);
    owners.owner = guest;
    assert.throws(() => CMain.BH_PersonalSnapshot(full), /invalid personal progression owner mapping/);
    owners.owner = host;
    owners.duplicate = host;
    assert.throws(() => CMain.BH_PersonalSnapshot(full), /invalid personal progression owner mapping/);
    delete owners.duplicate;
  }
  const replacement = { ...host, mUniqueID: 300 };
  CMain.BH_EnsurePersonalPlayer(replacement);
  assert.equal(CMain.BH_PersonalSnapshot(false)[0].ownerID, 300);
  assert.equal(CMain.BH_PersonalSnapshot(true)[0].ownerID, 300);
});

test('offline, legacy shared progression and DeathMatch do not change through personal helpers', () => {
  for (const overrides of [{ active: false }, { personalProgression: false }, { mode: 'DeathMatch' }]) {
    const { CMain, world, player } = harness(overrides);
    const host = player(1);
    const enemy = { _CLASSID_: 'CThing_Creature_Zombie', mLife: -1, mScore: 100 };
    const original = { ...enemy };
    assert.equal(CMain.BH_PersonalEnabled(), false);
    assert.equal(CMain.BH_EnsurePersonalPlayer(host), undefined);
    CMain.BH_PersonalPlayerReady(host);
    CMain.BH_RecordLethalDamage({ mOwner: host }, enemy, 1);
    CMain.BH_PersonalKill(world, enemy);
    CMain.BH_ProcessPersonal(world);
    assert.deepEqual(enemy, original);
    assert.deepEqual(world.mBHPersonalProgress, [undefined, undefined]);
    assert.equal(CMain.BH_KillScore(world, enemy), 9900);
    assert.equal(CMain.BH_UpgradeContext(world.mUpgrades, enemy, 'ApplyUpgrade_Object'), world.mUpgrades);
    assert.equal(CMain.BH_BlockSharedUpgrade(world.mUpgrades, 'CThing_Weapon_Pistol'), false);
    assert.deepEqual(CMain.BH_InheritCredit(host, {}), {});
  }
});

test('patched damage methods retain their damage/return values and record credit only after actual lethal damage', () => {
  const { CMain, player } = harness();
  const host = player(1);
  const guest = player(2);
  CMain.BH_PersonalPlayerReady(host);
  CMain.BH_PersonalPlayerReady(guest);
  for (const name of ['CThing_Affect', 'CThing_Affect_Bullet', 'CThing_Affect_Explosion',
    'CThing_Affect_FireBall', 'CThing_Affect_DevilAttack', 'CThing_Affect_ZombieAttack']) {
    const fixture = `class Thing.Affect.${name} {
      function AffectThing(tThing) {
        if(tThing.inRange) { tThing.mLife -= this.mDamage; return this.mDamage; }
        return 0;
      }
    }`;
    const patched = patchClass(`Thing/Affect/${name}`, fixture, '', '').source;
    const instance = runInNewContext('(new (' + patched.replace(`class Thing.Affect.${name}`, 'class Affect')
      .replace(/function ([A-Za-z_][A-Za-z_0-9]*)\(/g, '$1(') + ')())', { CMain });
    instance.mDamage = 10;
    instance.mOwner = host;
    const enemy = { mLife: 5, inRange: false };
    assert.equal(instance.AffectThing(enemy), 0);
    assert.equal(enemy.mLife, 5);
    assert.equal(enemy.mBHKillerSlot, undefined);
    enemy.inRange = true;
    assert.equal(instance.AffectThing(enemy), 10);
    assert.equal(enemy.mLife, -5);
    assert.equal(enemy.mBHKillerSlot, 1);
    instance.mOwner = guest;
    assert.equal(instance.AffectThing(enemy), 10);
    assert.equal(enemy.mLife, -15);
    assert.equal(enemy.mBHKillerSlot, 1);
  }
});
