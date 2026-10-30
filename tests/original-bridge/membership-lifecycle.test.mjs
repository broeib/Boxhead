import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { methodBodyRange } from '../../scripts/lib/original-phase-profile.mjs';

const source = path => readFileSync(new URL('../../tools/original-bridge/' + path, import.meta.url), 'utf8');
const bridge = source('CMain.bridge.asinc');
function method(input, name) {
  const range = methodBodyRange(input, name, tokens);
  const start = input.lastIndexOf('function ' + name + '(', range.start);
  return input.slice(start, range.end + 1).replace(/^function /, '');
}

// Actual AS2 lifecycle helpers with collaborators modeling the original
// collection's queued disposal. This is not an AVM1 or real-game test.
function fixture() {
  const worldClass = { m2Player: true };
  const CMain = runInNewContext('(class CMain {' + ['BH_ValidLeave', 'BH_LeavePlayer', 'BH_JoinPlayer']
    .map(name => method(bridge, name)).join('\n') + '})', {
    Error, World: { CWorld: worldClass, Map: { CMap_Cell: { mCollide_Player: 64 } } }, Thing: { CThing: { mFlag_DEAD: 32 } },
  });
  CMain.BH_Integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  CMain.mSaveData = {};
  const main = new CMain(), events = [];
  CMain.mInput = { BH_ResetGuestKeys() { events.push('reset-keys'); } };
  main.mBH = { stepping: true, membershipVersion: 1, initialPlayers: 1, personalProgression: true,
    mode: 'Coop', playerCount: 2, guestGeneration: 1, characters: [0, 1], replay: true };
  const states = { State_PlayerControl() {}, State_Dying() {}, State_Dead() {}, State_Respawn() {} };
  const host = { ...states, mStateID: 'State_PlayerControl', _CLASSID_: 'CThing_Creature_Player', mPlayerIndex: 0, sUniqueID: 't1', mFlags: 0, mLife: 100 };
  const guest = { ...states, mStateID: 'State_PlayerControl', _CLASSID_: 'CThing_Creature_Player', mPlayerIndex: 1, sUniqueID: 't2', mFlags: 0, mLife: 100, Process() {}, ClearCollideCell() { this.mNewCell.mCollide &= ~this.mNewCell_Flags; delete this.mNewCell; } };
  const c = { mThings: { t1: host, t2: guest }, mPlayerThings: { t1: host, t2: guest }, mDeleteThings: {},
    mThingCounters: { CThing_Creature_Player: 2 },
    DeleteThing(player) { events.push('queue'); this.mThingCounters[player._CLASSID_]--; this.mDeleteThings[player.sUniqueID] = player; },
    GetClosestPlayer() { return host; } };
  const hostRecord = { score: 99 };
  const record = { upgrades: { mWorld: { mThing_Collection: { mPlayerThings: { owner: guest } } } } };
  main.mcWorld = { mThing_Collection: c, mUpgrades: { mPlayerCount: 2, mTotalPlayerCount: 2 },
    mBHPersonalProgress: [hostRecord, record], Spawn_Player_Other(index) { events.push('spawn:' + index); return true; } };
  main.BH_ReplayFinish = () => events.push('replay-finish');
  return { main, c, host, guest, hostRecord, worldClass, events };
}

test('prepare negotiates only the implemented v1 and v2 configurations', () => {
  const CMain = runInNewContext('(class CMain {' + method(bridge, 'BH_Prepare') + '})', { Error });
  CMain.BH_Integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  CMain.BH_ValidLink = () => true;
  CMain.mInput = {}; CMain.mInitBGTasks = true; CMain.mSaveData = {};
  const main = new CMain(); main.mBH = { active: false, state: 'menu', tick: 0 };
  main.BH_MenuRemove = () => { throw new Error('accepted'); };
  const prepare = (mode, network) => main.BH_Prepare(1, mode, 'map', 0, 1, undefined, network);
  for (const [mode, initialPlayers, membershipVersion] of [['Coop', 1, 1], ['Coop', 2, 2], ['DeathMatch', 1, 2], ['DeathMatch', 2, 2]]) {
    assert.throws(() => prepare(mode, { initialPlayers, personalProgression: true, localSlot: 1, membershipVersion }), /accepted/);
  }
  for (const [mode, initialPlayers, membershipVersion] of [['Coop', 2, 1], ['Coop', 1, 2], ['DeathMatch', 1, 1]]) {
    assert.match(prepare(mode, { initialPlayers, personalProgression: true, localSlot: 1, membershipVersion }).error, /membership/);
  }
});

test('leave queues exactly one original disposal and preserves host progression before a replacement spawn', () => {
  const f = fixture(), { main, c, guest } = f;
  assert.equal(main.BH_ValidLeave({ slot: 2 }, undefined, 0), true);
  main.BH_LeavePlayer();
  assert.equal(c.mPlayerThings.t2, undefined);
  assert.equal(c.mDeleteThings.t2, guest);
  assert.equal(guest.Process, undefined);
  assert.equal(main.mcWorld.mBHPersonalProgress[1], undefined);
  assert.equal(main.mcWorld.mBHPersonalProgress[0], f.hostRecord);
  assert.deepEqual(main.mcWorld.mUpgrades, { mPlayerCount: 1, mTotalPlayerCount: 1 });
  assert.equal(f.worldClass.m2Player, false);
  // Original Process drains the queued object and its Dispose before the next frame.
  delete c.mThings.t2; delete c.mDeleteThings.t2;
  main.BH_JoinPlayer(3);
  assert.equal(main.mBH.guestGeneration, 2);
  assert.equal(main.mBH.playerCount, 2);
  assert.equal(main.mBH.characters[1], 3);
  assert.deepEqual(f.events, ['reset-keys', 'queue', 'spawn:1']);
});

test('v2 initially two-player Cooperative leaves and rejoins without resetting host progress', () => {
  const f = fixture();
  Object.assign(f.main.mBH, { membershipVersion: 2, initialPlayers: 2, guestGeneration: 1 });
  assert.equal(f.main.BH_ValidLeave({ slot: 2 }, undefined, 0), true);
  f.main.BH_LeavePlayer();
  delete f.c.mThings.t2; delete f.c.mDeleteThings.t2;
  f.main.BH_JoinPlayer(2);
  assert.equal(f.main.mBH.guestGeneration, 2);
  assert.equal(f.main.mcWorld.mBHPersonalProgress[0], f.hostRecord);
  assert.equal(f.main.mcWorld.mBHPersonalProgress[1], undefined);
  assert.equal(f.worldClass.m2Player, true);
});

test('DeathMatch departure preserves host, match score and remaining world across guest lifecycle states', () => {
  for (const initialPlayers of [1, 2]) for (const state of ['State_PlayerControl', 'State_Dying', 'State_Dead', 'State_Respawn']) {
    const f = fixture();
    Object.assign(f.main.mBH, { mode: 'DeathMatch', membershipVersion: 2, initialPlayers });
    f.main.mcWorld.mBHPersonalProgress = undefined;
    f.main.mcWorld.mHud = { mPlayer1_Deaths: 4, mPlayer2_Deaths: 7 };
    const worldObject = { _CLASSID_: 'CThing_Object_Barrel', mParent: f.guest };
    f.c.mThings.barrel = worldObject;
    f.guest.mStateID = state;
    f.main.mcWorld.mUpgrades.mPlayerCount = state === 'State_PlayerControl' ? 2 : 1;
    assert.equal(f.main.BH_ValidLeave({ slot: 2 }, undefined, 0), true);
    f.main.BH_LeavePlayer();
    assert.equal(f.c.mThings.t1, f.host);
    assert.equal(f.c.mThings.barrel, worldObject);
    assert.equal(worldObject.mParent, f.guest);
    assert.deepEqual(f.main.mcWorld.mHud, { mPlayer1_Deaths: 4, mPlayer2_Deaths: 7 });
    assert.equal(f.main.mcWorld.mUpgrades.mPlayerCount, 1);
    delete f.c.mThings.t2; delete f.c.mDeleteThings.t2;
    f.main.BH_JoinPlayer(3);
    assert.equal(f.main.mBH.playerCount, 2);
    assert.equal(f.main.mBH.guestGeneration, 2);
    assert.equal(worldObject.mParent, f.guest, "the departed object remains its original owner");
    assert.deepEqual(f.main.mcWorld.mHud, { mPlayer1_Deaths: 4, mPlayer2_Deaths: 7 });
  }
});

test('malformed, simultaneous, non-neutral, unnegotiated and duplicate leaves fail closed', () => {
  const f = fixture();
  for (const leave of [null, [], {}, { slot: 1 }, { slot: 2, extra: 1 }])
    assert.equal(f.main.BH_ValidLeave(leave, undefined, 0), false);
  assert.equal(f.main.BH_ValidLeave({ slot: 2 }, { slot: 2, character: 1 }, 0), false);
  assert.equal(f.main.BH_ValidLeave({ slot: 2 }, undefined, 1), false);
  f.main.mBH.membershipVersion = 0;
  assert.equal(f.main.BH_ValidLeave({ slot: 2 }, undefined, 0), false);
  f.main.mBH.membershipVersion = 1;
  f.main.BH_LeavePlayer();
  assert.equal(f.main.BH_ValidLeave({ slot: 2 }, undefined, 0), false);
});

test('already queued, ambiguous or inconsistent guests fail before mutation', () => {
  for (const change of [f => { f.c.mDeleteThings.t2 = f.guest; }, f => { f.c.mPlayerThings.extra = f.guest; },
    f => { f.guest.mNewCell = { mCollide: 64 }; },
    f => { f.guest.mNewCell = { mCollide: 64 }; f.guest.mNewCell_Flags = 32; },
    f => { f.guest.mStateID = 'invalid'; }, f => { f.guest.mLife = NaN; },
    f => { f.main.mcWorld.mUpgrades.mPlayerCount = 1; }]) {
    const f = fixture(); change(f);
    assert.throws(() => f.main.BH_LeavePlayer());
    assert.equal(f.c.mPlayerThings.t2, f.guest);
    assert.equal(f.main.mBH.playerCount, 2);
    assert.deepEqual(f.events, []);
  }
});


test('leave handles lethal hit, dying, dead and respawn with original counter timing and collision clearing', () => {
  for (const [state, counted] of [['State_PlayerControl', true], ['State_Dying', false],
    ['State_Dead', false], ['State_Respawn', false]]) {
    const f = fixture();
    f.guest.mStateID = state;
    f.guest.mLife = 0; f.guest.mFlags = 32;
    f.main.mcWorld.mUpgrades.mPlayerCount = counted ? 2 : 1;
    const shared = { mCollide: 64 | 128 };
    f.host.mNewCell = shared;
    f.guest.mNewCell = shared; f.guest.mNewCell_Flags = 64;
    f.main.BH_LeavePlayer();
    assert.equal(shared.mCollide, 128, state + ': original bit clear is not reference counted');
    assert.equal(f.guest.mNewCell, undefined);
    assert.equal(f.main.mcWorld.mUpgrades.mPlayerCount, 1);
    assert.equal(f.main.mcWorld.mUpgrades.mTotalPlayerCount, 1);
    assert.equal(f.c.mThingCounters.CThing_Creature_Player, 1);
  }
});

test('leave accounts for a dead host without treating the guest as an extra death', () => {
  const f = fixture();
  f.host.mStateID = 'State_Respawn'; f.host.mFlags = 32; f.host.mLife = 0;
  f.main.mcWorld.mUpgrades.mPlayerCount = 1;
  f.main.BH_LeavePlayer();
  assert.equal(f.main.mcWorld.mUpgrades.mPlayerCount, 0);
  assert.equal(f.main.mcWorld.mUpgrades.mTotalPlayerCount, 1);
});

test('all three frame implementations validate and apply leave before the original process', () => {
  for (const [file, name] of [['CMain.bridge.asinc', 'BH_Step'],
    ['CMain.staged-step.asinc', 'BH_StagedStepBegin'], ['CMain.compact-step.asinc', 'BH_CompactFrameBegin']]) {
    const body = method(source(file), name);
    assert.match(body, /BH_ValidLeave\(leave,join,p2Mask\)/);
    assert(body.indexOf('BH_ValidLeave') < body.indexOf('BH_LeavePlayer'));
    assert(body.indexOf('BH_LeavePlayer') < body.indexOf('BH_ApplyMasks'));
    assert(body.indexOf('BH_ApplyMasks') < body.indexOf('State_RunWorld(true)'));
  }
});

function stepFixture(mode, tick) {
  const f = fixture();
  const file = mode === 'sync' ? 'CMain.bridge.asinc' : mode === 'staged' ? 'CMain.staged-step.asinc' : 'CMain.compact-step.asinc';
  const name = mode === 'sync' ? 'BH_Step' : mode === 'staged' ? 'BH_StagedStepBegin' : 'BH_CompactFrameBegin';
  const trace = [], kernel = (...args) => { trace.push('fence:' + args[0]); return true; };
  const scope = { Error, _global: { boxheadNativeCompactFenceV1: kernel, boxheadNativeStepFenceV1: kernel },
    CSound: { ProcessAll() { trace.push('sound'); } } };
  const original = f.main;
  const CMain = runInNewContext('(class CMain {' + method(source(file), name) + '})', scope);
  CMain.BH_Integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  CMain.BH_ValidLink = () => true;
  CMain.mInput = { BH_ApplyMasks() { trace.push('input'); } };
  CMain.ProcessBGTasks = () => trace.push('background');
  const main = new CMain();
  main.mBH = { ...original.mBH, active: true, stepping: false, state: 'playing', tick: tick - 1, frameMs: 40,
    replay: false, compactStepVersion: 1, stagedStepVersion: 1, compactFenceKernel: kernel,
    stagedFenceKernel: kernel, snapshotReceiptEpoch: 0 };
  main.mcWorld = original.mcWorld;
  Object.assign(main.mcWorld, { mTick: tick - 1, mLoaded: true, mPaused: false });
  main.BH_ValidLeave = original.BH_ValidLeave;
  main.BH_LeavePlayer = function() { trace.push('leave'); return original.BH_LeavePlayer.call(this); };
  main.BH_PresentationBegin = () => trace.push('presentation');
  main.BH_PresentationEnd = () => trace.push('presentation-end');
  main.State_RunWorld = function() {
    trace.push('process');
    assert.equal(this.mBH.playerCount, 1);
    assert.equal(this.mcWorld.mThing_Collection.mPlayerThings.t2, undefined);
    this.mBH.logicCalls++; this.mBH.drawCalls++; this.mcWorld.mTick++;
  };
  main.fState = main.State_RunWorld;
  main.BH_State = () => ({ digest: 'native-fixture', players: [{ slot: 1 }] });
  main.BH_Fail = message => { main.mBH.state = 'error'; return { error: message }; };
  main.BH_StagedCheck = main.BH_CompactCheck = () => {};
  main.BH_StagedFencePoison = main.BH_CompactFencePoison = message => { main.mBH.state = 'error'; trace.push('poison:' + message); };
  main.BH_StagedError = main.BH_CompactError = message => ({ error: message });
  return { ...f, main, trace };
}

test('synchronous, staged and compact native frame beginnings execute one leave before inputs and world processing', () => {
  for (const [mode, tick] of [['sync', 24], ['staged', 25], ['compact', 26]]) {
    const { main, trace, guest } = stepFixture(mode, tick);
    const result = mode === 'sync' ? main.BH_Step(tick, 17, 0, undefined, undefined, { slot: 2 })
      : mode === 'staged' ? main.BH_StagedStepBegin(tick, 17, 0, undefined, 'token', { slot: 2 })
        : main.BH_CompactFrameBegin(tick, 17, 0, undefined, 'token', { slot: 2 });
    assert.equal(result.error, undefined, mode + ': ' + result.error);
    assert.equal(main.mBH.tick, tick);
    assert.equal(main.mBH.playerCount, 1);
    assert.equal(main.mcWorld.mThing_Collection.mDeleteThings.t2, guest);
    assert(trace.indexOf('leave') < trace.indexOf('input'));
    assert(trace.indexOf('input') < trace.indexOf('process'));
    assert.equal(trace.filter(item => item === 'process').length, 1);
  }
});

test('each frame route rejects invalid leave before any gameplay or fence begins', () => {
  for (const [mode, tick] of [['sync', 24], ['staged', 25], ['compact', 26]]) {
    const { main, trace } = stepFixture(mode, tick);
    const result = mode === 'sync' ? main.BH_Step(tick, 0, 0, undefined, undefined, null)
      : mode === 'staged' ? main.BH_StagedStepBegin(tick, 0, 0, undefined, 'token', null)
        : main.BH_CompactFrameBegin(tick, 0, 0, undefined, 'token', null);
    assert.match(result.error, /invalid player leave/);
    assert.equal(main.mBH.tick, tick - 1);
    assert(!trace.includes('process'));
    assert(!trace.includes('leave'));
    assert(!trace.includes('fence:begin'));
  }
});

test('leave resets all old guest key edges and durations without modifying host keys', () => {
  const CInput = runInNewContext('(class CInput {' + method(source('CInput.bridge.asinc'), 'BH_ResetGuestKeys') + '})', { Error });
  const input = new CInput();
  input.mKey_List_Registered = Array.from({ length: 34 }, () => ({
    mNetworkDown: true, mDown: true, mPressed: true, mReleased: true,
    mTimePressed: 11, mTimeDown: 12, mTimeReleased: 13,
  }));
  input.BH_ResetGuestKeys();
  assert.deepEqual(input.mKey_List_Registered[0], { mNetworkDown: true, mDown: true, mPressed: true,
    mReleased: true, mTimePressed: 11, mTimeDown: 12, mTimeReleased: 13 });
  for (const key of input.mKey_List_Registered.slice(17)) assert.deepEqual(key, { mNetworkDown: false,
    mDown: false, mPressed: false, mReleased: false, mTimePressed: 0, mTimeDown: 0, mTimeReleased: 0 });
  input.mKey_List_Registered[33] = undefined;
  input.mKey_List_Registered[17].mDown = true;
  assert.throws(() => input.BH_ResetGuestKeys(), /guest input keys unavailable/);
  assert.equal(input.mKey_List_Registered[17].mDown, true);
});

test('membership mode disables checkpoint v1 and includes the guest generation in both native projections', () => {
  const capability = () => ({ version: 1, contract: 'bh-avm1-graph-v1' });
  const CMain = runInNewContext('(class CMain {' + method(source('CMain.checkpoint.asinc'), 'BH_CheckpointAvailable') + '})',
    { _global: { boxheadNativeGraphV1: capability } });
  const main = new CMain();
  main.mBH = { membershipVersion: 1 };
  assert.equal(main.BH_CheckpointAvailable(), false);
  main.mBH.membershipVersion = 0;
  assert.equal(main.BH_CheckpointAvailable(), true);
  main.mBH.membershipVersion = 2;
  assert.equal(main.BH_CheckpointAvailable(), false);
  assert.match(method(bridge, 'BH_FrameState'), /native\.membership\.generation = b\.guestGeneration/);
  assert.match(method(bridge, 'BH_State'), /root\.membership\.generation = b\.guestGeneration/);
  assert.match(method(source('CMain.staged-step.asinc'), 'BH_StagedStepPrepare'), /root\.membership\.generation = b\.guestGeneration/);
});
