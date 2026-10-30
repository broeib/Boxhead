import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { patchClass, tokens } from '../../scripts/build-original-profile-swf.mjs';
import { instrumentMainPhaseProfile, methodBodyRange, PROFILE_BASE_PINS, PROFILE_ORIGINAL_MAIN_SHA256 } from '../../scripts/lib/original-phase-profile.mjs';

const original = readFileSync(new URL('./fixtures/phase-profile-CMain.original.as', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('./fixtures/phase-profile-bridge-baseline.asinc', import.meta.url), 'utf8');
const builder = readFileSync(new URL('../../scripts/build-original-profile-swf.mjs', import.meta.url), 'utf8');
const baseline = patchClass('CMain', original, bridge, '').source;
const diagnostic = instrumentMainPhaseProfile(baseline, tokens);
const sha = text => createHash('sha256').update(text).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
function body(source, name) {
  const range = methodBodyRange(source, name, tokens);
  return source.slice(range.start, range.end);
}
function callable(source, name, args, globals) {
  return runInNewContext('(function(' + args + '){' + body(source, name) + '\n})', globals);
}
function maskBodies(source) {
  const ranges = ['State_RunWorld', 'BH_Step', 'BH_FrameState', 'BH_State'].map(name => ({ name, ...methodBodyRange(source, name, tokens) }));
  for (const { name, start, end } of ranges.sort((a, b) => b.start - a.start))
    source = source.slice(0, start) + '/* same method body: ' + name + ' */' + source.slice(end);
  return source;
}

function gameHarness(profiled, { failure, completion, playerCount = 1 } = {}) {
  const events = [], rawReads = [];
  let wall = 1000;
  let main;
  const work = (name, cost) => {
    events.push(name); wall += cost;
    if (failure === name) throw new Error('native ' + name);
  };
  const CMain = {
    mFPS: 100,
    BH_Integer: (value, min, max) => Number.isInteger(value) && value >= min && value <= max,
    BH_Timer() { throw new Error('diagnostic clocks entered deterministic game time'); },
    BH_Float() { throw new Error('diagnostic clocks consumed gameplay RNG'); },
    mInput: { BH_ApplyMasks(p1, p2) { work('input:' + p1 + ':' + p2, 2); } },
    ProcessBGTasks() { work('background', 7); },
  };
  const globals = { Object, Array, Error, String, CMain,
    CSound: { ProcessAll() { work('sound', 5); } },
    World: { CWorld: { mGameMode: 'Coop' } },
    Screen: { CScreen_Debrief_Winner: {} },
    getTimer() { rawReads.push(wall); return wall; },
  };
  const source = profiled ? diagnostic : baseline;
  main = {
    mBH: { active: true, state: 'ready', tick: 0, frameMs: 40, stepping: false, playerCount, replay: true, rng: 123, rngCalls: 7 },
    mReturn_SelectWorld: 'select-world',
    mcWorld: { mTick: 0, mLoaded: true, mPaused: false, mCompleteState: completion,
      Process() { work('process', 11); main.mBH.logicCalls++; this.mTick++; },
      Draw() { work('draw', 13); main.mBH.drawCalls++; },
      BH_InitializeRules() { work('rules', 3); },
    },
    SetState(state) { work('set-state:' + state, 4); },
    BH_JoinPlayer(character) { work('join:' + character, 17); this.mBH.playerCount = 2; },
    BH_Info() { return { tick: this.mBH.tick, state: this.mBH.state, error: this.mBH.error }; },
    BH_Fail(error) { this.mBH.state = 'error'; this.mBH.error = error; return { tick: this.mBH.tick, error }; },
    // This isolated step test does not simulate native projection. Separate
    // tests below execute both actual snapshot methods with the same graph.
    BH_State() { events.push('snapshot'); return { tick: this.mBH.tick, digest: 'fixture', players: [], rng: { state: this.mBH.rng }, profile: {} }; },
  };
  main.State_RunWorld = callable(source, 'State_RunWorld', 'flagDraw', globals);
  main.BH_Step = callable(source, 'BH_Step', 'tick,p1Mask,p2Mask,join', globals);
  main.fState = main.State_RunWorld;
  return { main, CMain, globals, events, rawReads, wall: () => wall };
}

test('diagnostic inputs are pinned b9 source and only four method bodies change', () => {
  assert.equal(sha(original), PROFILE_ORIGINAL_MAIN_SHA256);
  assert.equal(sha(bridge), PROFILE_BASE_PINS['CMain.bridge.asinc']);
  assert.equal(maskBodies(diagnostic), maskBodies(baseline));
  assert.equal(body(diagnostic, 'State_RunWorld').match(/this\.mcWorld\.Process\(\);/g).length, 1);
  assert.equal(body(diagnostic, 'State_RunWorld').match(/this\.mcWorld\.Draw\(\);/g).length, 1);
  const step = body(diagnostic, 'BH_Step');
  for (const call of ['this.State_RunWorld(true);', 'this.mcWorld.BH_InitializeRules();', 'CSound.ProcessAll();', 'CMain.ProcessBGTasks();'])
    assert.equal(step.split(call).length - 1, 1, call);
});

test('builder inserts raw clocks after rewrite and cannot overwrite the online SWF', () => {
  assert(builder.includes("'tmp/fidelity/phase-profile/Boxhead_2Play.profile.swf'"));
  assert(!builder.includes("'public/Boxhead_2Play.online.swf'"));
  assert(builder.indexOf('const patched = patchClass(') < builder.indexOf('patched.source = instrumentMainPhaseProfile('));
  assert(body(baseline, 'Process').includes('CMain.BH_Timer()'));
  assert.equal(body(diagnostic, 'Process'), body(baseline, 'Process'));
  assert.equal(body(baseline, 'State_RunWorld').includes('getTimer'), false);
  assert.equal(body(diagnostic, 'State_RunWorld').match(/getTimer\(\)/g).length, 4);
  assert.equal(body(diagnostic, 'State_RunWorld').includes('CMain.BH_Timer'), false);
  assert.equal(body(diagnostic, 'BH_Step').includes('CMain.BH_Timer'), false);
});

test('instrumentation fails closed for duplicate installation and changed original call sites', () => {
  assert.throws(() => instrumentMainPhaseProfile(diagnostic, tokens), /already installed/);
  assert.throws(() => instrumentMainPhaseProfile(baseline.replace('this.mcWorld.Draw();', 'this.mcWorld.NewDraw();'), tokens), /exactly one.*Draw call/);
  assert.throws(() => instrumentMainPhaseProfile(baseline.replace('this.State_RunWorld(true);', 'this.State_RunWorld(true); this.State_RunWorld(true);'), tokens), /exactly one.*State_RunWorld call/);
  assert.throws(() => methodBodyRange('class X { function F() {} function F() {} }', 'F', tokens), /got 2/);
  assert.equal(body('class X { function F() { var a = "}"; /* } */ return a; } }', 'F').trim(), 'var a = "}"; /* } */ return a;');
});

test('one commanded frame preserves input, original Process/Draw, first rules, sound and BG order', () => {
  const a = gameHarness(false), b = gameHarness(true);
  assert.deepEqual(plain(b.main.BH_Step(1, 17, 3, { slot: 2, character: 1 })), plain(a.main.BH_Step(1, 17, 3, { slot: 2, character: 1 })));
  assert.deepEqual(b.events, a.events);
  assert.deepEqual(b.events, ['join:1', 'input:17:3', 'process', 'draw', 'rules', 'sound', 'background', 'snapshot']);
  assert.deepEqual(plain(b.main.mBH.phaseProfile), { version: 1, tick: 1, replay: true, processMs: 11, drawMs: 13, runWorldMs: 24, initializeRulesMs: 3, soundMs: 5, backgroundMs: 7, gameMs: 39, processCalls: 1, drawCalls: 1, initializeRulesCalls: 1, soundCalls: 1, backgroundCalls: 1, finalized: true });
  assert.equal(b.main.mBH.clock, 40);
  assert.equal(b.main.mBH.rng, 123); assert.equal(b.main.mBH.rngCalls, 7);
  assert.equal(b.wall(), a.wall());
});

test('phase records are fresh per tick and a published previous phase is never mutated', () => {
  const h = gameHarness(true);
  h.main.BH_Step(1, 0, 0);
  const first = h.main.mBH.phaseProfile, frozen = JSON.stringify(first);
  Object.freeze(first);
  assert.equal(h.main.BH_Step(2, 0, 0).error, undefined);
  assert.notEqual(h.main.mBH.phaseProfile, first);
  assert.equal(JSON.stringify(first), frozen);
  assert.equal(h.main.mBH.phaseProfile.tick, 2);
  assert.equal(h.main.mBH.phaseProfile.initializeRulesCalls, 0);
  assert.equal(h.main.mBH.phaseProfile.initializeRulesMs, 0);
  assert.equal(h.main.mBH.phaseProfile.gameMs, 36);
});

test('mock legacy State_RunWorld without a fresh record does not create or mutate profiling evidence', () => {
  for (const previous of [undefined, Object.freeze({ tick: 1, finalized: false, sentinel: true }), Object.freeze({ tick: 0, finalized: true, sentinel: true })]) {
    const h = gameHarness(true);
    h.main.mBH.phaseProfile = previous;
    h.main.State_RunWorld = function () { this.mcWorld.Process(); this.mcWorld.Draw(); };
    h.main.fState = h.main.State_RunWorld;
    assert.equal(h.main.BH_Step(1, 0, 0).error, undefined);
    assert.equal(h.main.mBH.phaseProfile, previous);
    if (previous) assert.deepEqual(Object.keys(previous), ['tick', 'finalized', 'sentinel']);
  }
});

test('original draw flag and every completion return retain exact native behavior', () => {
  for (const flagDraw of [false, true]) for (const completion of [undefined, 'error', 'quit', 'player dead', 'player1 wins', 'player2 wins', 'unknown']) {
    const a = gameHarness(false, { completion }), b = gameHarness(true, { completion });
    a.main.mBH.stepping = b.main.mBH.stepping = true;
    assert.equal(b.main.State_RunWorld(flagDraw), a.main.State_RunWorld(flagDraw));
    assert.deepEqual(b.events, a.events);
    assert.equal(b.main.mcWorld.mPause, a.main.mcWorld.mPause);
    assert.equal(b.CMain.mFPS, a.CMain.mFPS);
    assert.deepEqual(b.globals.Screen, a.globals.Screen);
    assert.equal(b.main.mBH.phaseProfile.drawCalls, flagDraw ? 1 : 0);
    assert.equal(b.main.mBH.phaseProfile.finalized, false, 'State_RunWorld alone cannot publish a complete game phase');
  }
  const h = gameHarness(true, { completion: 'player dead' });
  h.main.BH_Step(1, 0, 0);
  assert.equal(h.main.mBH.phaseProfile.runWorldMs, 28, 'whole method includes native completion switch');
  assert.equal(h.main.mBH.phaseProfile.gameMs, 43);
});

test('throw paths skip the same remaining native calls and never finalize incomplete data', () => {
  for (const failure of ['process', 'draw', 'rules', 'sound', 'background']) {
    const a = gameHarness(false, { failure }), b = gameHarness(true, { failure });
    assert.deepEqual(plain(b.main.BH_Step(1, 0, 0)), plain(a.main.BH_Step(1, 0, 0)));
    assert.deepEqual(b.events, a.events);
    assert.equal(b.main.mBH.tick, 0);
    assert.equal(b.main.mBH.stepping, false);
    assert.equal(b.main.mBH.phaseProfile.finalized, false);
    assert(!b.events.includes('snapshot'));
  }
});

test('offline and non-commanded State_RunWorld never allocate a phase or read a profile clock', () => {
  for (const flags of [{ active: false, stepping: false }, { active: true, stepping: false }, { active: false, stepping: true }]) {
    const h = gameHarness(true);
    Object.assign(h.main.mBH, flags);
    h.main.State_RunWorld(true);
    assert.equal(h.main.mBH.phaseProfile, undefined);
    assert.equal(h.rawReads.length, 0);
    assert.deepEqual(h.events, ['process', 'draw']);
  }
});

function snapshotHarness(profiled, tick, phase) {
  const events = [], digests = [];
  let wall = 100;
  const CMain = {
    BH_Scalars: () => ({}), BH_SkipField: () => false, BH_Grid: () => [],
    BH_PersonalEnabled: () => false,
    BH_Integer: (n, low, high) => Number.isInteger(n) && n >= low && n <= high,
    BH_Project: root => root,
    mInput: { mKey_List_Registered: [] },
  };
  const globals = { Object, Array, String, Error, CMain,
    World: { Map: { CMap_Cell: {}, CMap: {} } },
    Thing: { CThing: {}, Math: { CThing_Position: {} } },
    getTimer() { events.push('timer'); return wall++; },
    flash: { external: { ExternalInterface: { call(name, native) {
      assert.equal(name, 'boxheadDigestOriginalState');
      events.push('digest'); digests.push(native);
      return { digest: 'native-v2-0123456789abcdef', bytes: 100 };
    } } } },
  };
  const main = {
    mBH: { active: true, state: 'playing', stepping: false, tick, seed: 1, rng: 2, rngCalls: 3, initialPlayers: 2, settings: {}, mode: 'Coop', map: 14, characters: [0, 1], phaseProfile: phase },
    mcWorld: { mTick: tick, mThing_Collection: { mThings: {}, mPlayerThings: [], mDeleteThings: [], mThingCounters: {} }, mUpgrades: { Level: {} }, mHud: {}, mMap: {} },
    BH_Players() { events.push('players'); return [{ slot: 1 }]; },
    BH_Fail(error) { throw new Error(error); },
  };
  const source = profiled ? diagnostic : baseline;
  main.BH_FrameState = callable(source, 'BH_FrameState', '', globals);
  main.BH_State = callable(source, 'BH_State', 'refresh,forceFull', globals);
  return { main, events, digests };
}

test('compact and full snapshots keep literal evaluation order and hash exactly the same native graph', () => {
  for (const tick of [1, 25]) {
    const phase = Object.freeze({ version: 1, tick, finalized: true, gameMs: 39 });
    const a = snapshotHarness(false, tick, phase), b = snapshotHarness(true, tick, phase);
    const before = a.main.BH_State(true), after = b.main.BH_State(true);
    assert.deepEqual(b.events, a.events, 'BH_Players and raw hash clock order must stay unchanged');
    assert.deepEqual(plain(b.digests), plain(a.digests));
    assert(!JSON.stringify(b.digests).includes('gameMs'));
    assert.equal(after.profile.phases, phase);
    assert.equal(after.native, b.digests[0]);
    const { phases, ...rest } = after.profile;
    assert.deepEqual(plain(rest), plain(before.profile));
    assert.deepEqual(plain({ ...after, profile: rest }), plain(before));
    assert.equal(b.main.BH_State(false), after, 'cached read retains original object identity');
  }
});

test('missing, stale, future and incomplete phase records are never attached to snapshots', () => {
  for (const tick of [1, 25]) for (const phase of [undefined, { tick, finalized: false }, { tick: tick - 1, finalized: true }, { tick: tick + 1, finalized: true }]) {
    const h = snapshotHarness(true, tick, phase);
    assert.equal(Object.hasOwn(h.main.BH_State(true).profile, 'phases'), false);
  }
  for (const method of ['BH_FrameState', 'BH_State']) {
    const snapshotLines = body(baseline, method).split('\n').filter(line => /^\s*(?:b\.snapshot|var snapshot) = \{version:1/.test(line));
    assert.equal(snapshotLines.length, 1);
    assert(body(diagnostic, method).includes(snapshotLines[0]), 'original snapshot literal must remain byte-exact');
  }
});
