import { secondaryV2Predecessor } from './helpers/membership-secondary-v2-source.mjs';
import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { secondaryPredecessor } from './helpers/membership-secondary-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { methodBodyRange } from '../../scripts/lib/original-phase-profile.mjs';
import { COMPACT_STEP_BASE_BRIDGE_SHA256, COMPACT_STEP_FULL_INCLUDE_SHA256,
  COMPACT_STEP_BRIDGE_HOOKS, stripCompactStepBridge, stripCompactStepBuild,
  compactStepReferenceMethods } from '../../scripts/lib/native-compact-step-source.mjs';
import { rehashNativeProjection } from '../../scripts/lib/native-projection-scan-evidence.mjs';

const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const bridge = source('tools/original-bridge/CMain.bridge.asinc');
// Keep current lifecycle bodies while authenticating the historical comparison.
const historicalBridge = metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(bridge)));
const compact = source('tools/original-bridge/CMain.compact-step.asinc');
const staged = source('tools/original-bridge/CMain.staged-step.asinc');
const adapter = source('tools/original-bridge/CMain.native-project.asinc');
const before = stripCompactStepBridge(historicalBridge);
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
function method(input, name) {
  const range = methodBodyRange(input, name, tokens);
  const location = input.lastIndexOf('function ' + name + '(', range.start);
  return input.slice(input.lastIndexOf('\n', location) + 1, range.end + 1);
}
const names = input => [...input.matchAll(/\bfunction (BH_\w+)\(/g)].map(match => match[1]);
const withoutProfile = value => { const result = plain(value); delete result.profile; return result; };

// Actual AS2 method bodies with small deterministic collaborators. This checks
// source order/lifecycle only, not native gates, AVM1 coercion, ambient queues,
// ExternalInterface marshalling, pixels, gameplay or performance.
function fixture({ capability = true, fullCapability = true, cap, rejectRegistration,
  firstTick = 7, onePlayer = false, personal = true, terminal = false, replay = false } = {}) {
  const events = [], fence = [], captures = [], registrations = new Map();
  let wall = 1000, main, h;
  const global = {};
  const kernelFor = kind => (op, owner, token, epoch, tick, phase) => {
    fence.push({ kind, op, token, epoch, tick, phase });
    if(op === 'capability') return kind === 'compact'
      ? cap ?? Object.assign(Object.create(null), { version: 1, contract: 'bh-compact-step-fence-v1' })
      : Object.assign(Object.create(null), { version: 1, contract: 'bh-step-fence-v1' });
    if(h?.failOp === kind + ':' + op + ':' + (phase ?? '')) throw new Error('kernel ' + op);
    if(op === 'abort') {
      h.abortCalls++;
      if(!h.poisoned) { h.poisoned = true; owner[kind === 'compact' ? 'BH_CompactFencePoison' : 'BH_StagedFencePoison']('native abort'); }
    }
    if(op === 'finish') {
      assert.equal(owner.mBH.snapshotReceiptPending, undefined, 'native finish follows original receipt consumption');
      assert.equal(owner.mBH.snapshotReceiptRequest, undefined);
      assert.equal(owner.mBH.snapshotReceiptProof, undefined);
    }
    return true;
  };
  const kernel = kernelFor('compact'), fullKernel = kernelFor('full');
  if(capability) global.boxheadNativeCompactFenceV1 = kernel;
  if(fullCapability) global.boxheadNativeStepFenceV1 = fullKernel;
  const spend = (label, cost = 0) => {
    events.push(label); wall += cost;
    if(h?.failure === label) throw new Error('fixture ' + label);
  };
  const bridgeNames = ['BH_Install', 'BH_NativeScalarInstall', 'BH_NativeScalarInfo',
    'BH_NativeProjectionInstall', 'BH_NativeProjectionInfo', 'BH_ReceiptGuard', 'BH_ReceiptPoison',
    'BH_ReceiptDigest', 'BH_ReceiptPublish', 'BH_StateReceipt', 'BH_Fail', 'BH_Info', 'BH_Integer',
    'BH_ValidLink', 'BH_Step', 'BH_State', 'BH_FrameState', 'BH_Scalars', 'BH_ThingScalars', 'BH_Pump'];
  const adapterNames = ['BH_NativeProjectInstall', 'BH_NativeProjectInfo', 'BH_NativeProject'];
  const methods = bridgeNames.map(name => method(bridge, name))
    .concat(adapterNames.map(name => method(adapter, name)), names(staged).map(name => method(staged, name)),
      names(compact).map(name => method(compact, name)));
  const CMain = runInNewContext('(class CMain {\n' + methods.join('\n')
    .replace(/static function (BH_\w+)\(/g, 'static $1(')
    .replace(/(?<!static )function (BH_\w+)\(/g, '$1(') + '\n})', {
    Object, Array, Error, Math, String, Number, isNaN, isFinite, _global: global, getTimer: () => wall,
    ASSetPropFlags() {},
    flash: { external: { ExternalInterface: {
      available: true,
      addCallback(name, receiver, callback) {
        registrations.set(name, { receiver, callback });
        return name !== rejectRegistration && typeof callback === 'function';
      },
      call(name, native, metadata) {
        assert.equal(name, 'boxheadDigestOriginalState'); spend('digest', 2);
        assert.equal(main.mBH.stepping, false); assert.equal(main.mBH.snapshotReceiptBusy, true);
        const result = rehashNativeProjection(plain(native));
        captures.push({ native: plain(native), metadata: plain(metadata), result, original: native });
        h.onDigest?.(native, metadata);
        return { ...result, receipt: { ...metadata } };
      },
    } } },
    CSound: { ProcessAll: () => spend('sound') },
    World: { Map: { CMap_Cell: {}, CMap: { mCheckSessionID: 0 } } },
    Thing: { CThing: { mAllocate_ID: 1, mAllocate_ProcessID_Count: 0 }, Math: { CThing_Position: { mPFactor: 1 } } },
  });
  main = new CMain(); CMain._this = main;
  CMain.mInput = { BH_ApplyMasks: (one, two) => spend('masks:' + one + ':' + two), mKey_List_Registered: [0, 1] };
  CMain.ProcessBGTasks = () => spend('background');
  CMain.BH_PersonalEnabled = () => personal;
  CMain.BH_PersonalSnapshot = full => { spend('personal:' + full, 1); return [{ slot: 1, score: 10 }, { slot: 2, score: 20 }]; };
  CMain.BH_Grid = () => 'private-grid';
  CMain.BH_SkipField = () => false;
  CMain.BH_ProcessName = () => 'private-process';
  CMain.BH_Project = (root, context) => {
    spend('full-project', 5); context.objects.push(h.entity); h.entity.__bhSnapshotRef = 1; context.fields = 11;
    return { scope: root.scope, tick: root.tick, rng: root.rng, entities: { t7: { mLife: h.entity.mLife } },
      world: root.world, ...(root.membership ? { membership: root.membership } : {}) };
  };
  main.BH_MenuBounds = () => ({}); main.BH_CheckpointAvailable = () => false;
  main.mcScreen = { idScreen: 'Screen_Main', mNormal: true };
  for(const name of ['Prepare', 'ReadState', 'CheckpointExport', 'CheckpointImport', 'MenuPoll', 'MenuUpdate',
    'RenderCheck', 'Controls', 'AnimationProbe', 'PresentationConfig', 'PresentationInfo'])
    main['BH_' + name] = () => { throw new Error('unexpected public ' + name); };
  main.BH_Present = alpha => {
    spend('present'); assert.equal(main.mBH.stepping, false);
    assert.equal(main.mBH.snapshotReceiptRequest, undefined);
    return { version: 1, enabled: true, rendered: main.mBH.complete === undefined, tick: main.mBH.tick, alpha };
  };
  h = { main, CMain, global, kernel, fullKernel, events, fence, captures, registrations, abortCalls: 0,
    poisoned: false, advanceWall: ms => { wall += ms; } };
  main.BH_Install();
  if(main.mBH.state === 'error') return h;
  Object.assign(main.mBH, { active: true, state: firstTick === 1 ? 'ready' : 'playing', tick: firstTick - 1,
    frameMs: 40, initialPlayers: onePlayer ? 1 : 2, playerCount: onePlayer ? 1 : 2,
    seed: 1, rng: 2, rngCalls: 3, replay, settings: {}, mode: 'Coop', map: 'fixture',
    characters: onePlayer ? [0] : [0, 1], lastFullDigest: 'native-v2-0123456789abcdef' });
  const vector = () => ({ mX: 1, mY: 2, mZ: 3 });
  h.entity = { mLife: 100, mPosition: vector(), mDelta: vector(), mTarget_Direction: vector(), mReturn_Angle: vector(),
    _CLASSID_: 'Private', mAngle: { mAngle: 0 }, mTarget_Angle: { mAngle: 1 }, mXSI_Animation: { mCurrentFrameID: 4 },
    mParent: { mUniqueID: 'parent' }, Process() {}, mWeaponList: [{ mActive: true, mNameID: 'pistol', mThing: { ammo: 99 } }],
    mWeapon_Current: { mNameID: 'pistol' } };
  Object.defineProperty(h.entity, 'fixtureScalar', { enumerable: true, get() {
    spend('entity-scalar'); h.onScalar?.(); return 7;
  } });
  main.mcWorld = { mTick: firstTick - 1, mLoaded: true, mPaused: false,
    mThing_Collection: { mThings: { t7: h.entity }, mPlayerThings: {}, mDeleteThings: {}, mRespawnPlayer: {}, mThingCounters: { zombies: 2 },
      mTimeSlice_25: [], mTimeSlice_8: [], mTimeSlice_4: [] },
    mMap: {}, mUpgrades: { multiplier: 1, Level: { wave: 2 } }, mHud: { score: 10 },
    BH_InitializeRules: () => spend('rules') };
  Object.defineProperty(main.mcWorld, 'fixtureScalar', { enumerable: true, get() { spend('world-scalar'); return 9; } });
  main.State_Debrief = () => spend('debrief'); main.State_Debrief_Winner = () => spend('debrief-winner');
  main.State_RunWorld = () => {
    spend('process', 3); main.mBH.logicCalls++; main.mcWorld.mTick++;
    spend('draw', 4); main.mBH.drawCalls++;
    if(terminal) { main.mcWorld.mCompleteState = 'player dead'; main.fState = main.State_Debrief; }
  };
  main.fState = main.State_RunWorld;
  main.BH_JoinPlayer = character => {
    spend('join:' + character); assert.equal(main.mBH.stepping, true);
    main.mBH.playerCount = 2; main.mBH.characters[1] = character;
  };
  main.BH_PresentationBegin = () => spend('presentation-begin');
  main.BH_PresentationEnd = tick => { assert.equal(tick, main.mcWorld.mTick); spend('presentation-end'); };
  main.BH_Players = () => {
    spend('players'); return Array.from({ length: main.mBH.playerCount }, (_, index) => ({ slot: index + 1, life: 100 }));
  };
  h.invoke = (name, ...args) => {
    const entry = registrations.get(name); assert(entry && typeof entry.callback === 'function', name);
    return entry.callback.apply(entry.receiver, args);
  };
  return h;
}

function run(h, mode = 'compact', tick = h.main.mBH.tick + 1, join = undefined) {
  const token = 'compact_' + tick, epoch = h.main.mBH.snapshotReceiptEpoch + 1;
  const args = [tick, 17, h.main.mBH.playerCount === 1 && join === undefined ? 0 : 3, join, token];
  let step;
  if(mode === 'sync') step = h.invoke('bhStep', ...args);
  else if(tick % 25 === 0) {
    assert.equal(h.invoke('bhStepBegin', ...args).phase, 'begun');
    assert.equal(h.invoke('bhStepPrepare', token, epoch, tick).phase, 'prepared');
    assert.equal(h.invoke('bhStepProject', token, epoch, tick).phase, 'projected');
    step = h.invoke('bhStepCommit', token, epoch, tick);
  } else {
    assert.deepEqual(plain(h.invoke('bhFrameBegin', ...args)), { version: 1, phase: 'begun', token, epoch, tick });
    h.advanceWall(100); step = h.invoke('bhFrameCommit', token, epoch, tick);
  }
  assert.equal(step.error, undefined, step.error);
  h.invoke('bhInfo');
  const receipt = h.invoke('bhStateReceipt', token, epoch, tick);
  assert.equal(receipt.error, undefined, receipt.error);
  return { step, receipt };
}

test('five compact hooks and one build include restore exact previous full-stage sources', () => {
  assert.equal(sha(before), COMPACT_STEP_BASE_BRIDGE_SHA256);
  assert.equal(sha(secondaryPredecessor('tools/original-bridge/CMain.staged-step.asinc', secondaryV2Predecessor('tools/original-bridge/CMain.staged-step.asinc', staged))), COMPACT_STEP_FULL_INCLUDE_SHA256);
  // Remove exactly the later camera change before checking the historical
  // full-stage predecessor; the existing hash still protects all other bytes.
  let currentBuild = source('scripts/build-original-swf.mjs');
  // Authenticate and reverse the later DeathMatch unlock integration first.
  for (const [added, previous] of [
    ["\\n      CMain.BH_PersonalPlayerReady(this);\\n      CMain.BH_DeathmatchPlayerReady(this);", "\\n      CMain.BH_PersonalPlayerReady(this);"],
    ["'CMain.progression.asinc', 'CMain.deathmatch-unlocks.asinc', 'CMain.checkpoint.asinc'", "'CMain.progression.asinc', 'CMain.checkpoint.asinc'"],
  ]) {
    assert.equal(currentBuild.split(added).length, 2, 'Expected exactly one DeathMatch integration edit');
    currentBuild = currentBuild.replace(added, previous);
  }
  // Remove the later HUD-only switch fix and authenticate the entire prior
  // builder before applying the existing camera/compact reversal chain.
  const hudStart = currentBuild.indexOf("    out = replaceOnce(out,\n      /this\\.mcPlayerFrags\\.mcSwitchSides");
  const hudEnd = currentBuild.indexOf('    out = replaceOnce(out, /World\\.CHud\\.mcScoreTotal', hudStart);
  assert(hudStart >= 0 && hudEnd > hudStart);
  const build = currentBuild.slice(0, hudStart) + currentBuild.slice(hudEnd);
  assert.equal(sha(build), '1a055b30a64aed2bf4e77ab6165d118519fa0158e93776fefa6f6f86b46d25f5', 'Exact pre-switch builder is required');
  const cameraStart = "      (_match, rest) => 'if(World.CWorld.mGameMode == \"DeathMatch\" && !CMain.BH_Active())' + rest,";
  const cameraEnd = '    // Difficulty/weapon grants must follow Process_Init, as in original InitCleanUp.';
  const start = build.indexOf(cameraStart), end = build.indexOf(cameraEnd, start);
  assert(start >= 0 && end > start && build.indexOf(cameraStart, start + 1) < 0);
  const oldCamera = `      (_match, rest) => 'if(World.CWorld.mGameMode == "DeathMatch" && (!CMain.BH_Active() || CMain._this.mBH.playerCount == 2))' + rest,
      'solo online DeathMatch camera');
`;
  let predecessor = build.slice(0, start) + oldCamera + build.slice(end);
  const mapStart = predecessor.indexOf('    out = replaceOnce(out, /CMain\\.BH_PresentationDrawThing');
  const mapEnd = predecessor.indexOf("  if (name === 'World/CUpgrades')", mapStart);
  // Exact boundary: retain the original CMap block's closing brace.
  assert(mapStart >= 0 && mapEnd > mapStart);
  predecessor = predecessor.slice(0, mapStart) + '  }\n' + predecessor.slice(mapEnd);
  stripCompactStepBuild(predecessor);
  for(const name of ['BH_Step', 'BH_State', 'BH_FrameState', 'BH_StateReceipt', 'BH_ReceiptDigest', 'BH_ReceiptPublish'])
    assert.equal(method(historicalBridge, name), method(before, name));
  const references = compactStepReferenceMethods(historicalBridge, tokens);
  for(const [name, renamed] of [['BH_Step', 'BH_CompactOriginalStep'], ['BH_State', 'BH_CompactOriginalState']])
    assert.equal(method(references, renamed).replace('function ' + renamed + '(', 'function ' + name + '(').trim(),
      method(before, name).trim());
  for(const hook of COMPACT_STEP_BRIDGE_HOOKS) {
    assert.throws(() => stripCompactStepBridge(historicalBridge.replace(hook.after, '')));
    assert.throws(() => stripCompactStepBridge(historicalBridge.replace(hook.after, hook.after + hook.after)));
  }
  assert.throws(() => stripCompactStepBridge(historicalBridge.replace('b.clock = tick * b.frameMs;', 'b.clock = tick * 41;')), /predecessor/);
  assert(!compact.includes('function BH_State('));
  assert(method(compact, 'BH_CompactFrameCommit').includes('var state = this.BH_State(true);'));
});

test('compact absence preserves full capability and synchronous frame receipt; replay advertises neither stage route', () => {
  const old = fixture({ capability: false });
  assert.equal(old.invoke('bhInfo').compactStepVersion, undefined); assert.equal(old.invoke('bhInfo').stagedStepVersion, 1);
  assert.equal(run(old, 'sync').receipt.scope, 'frame');
  assert(!old.fence.some(row => row.kind === 'compact'));
  const historical = fixture({ replay: true });
  assert.equal(historical.invoke('bhInfo').compactStepVersion, undefined);
  assert.equal(historical.invoke('bhInfo').stagedStepVersion, undefined);
  assert(historical.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7').error);
  assert(!historical.events.includes('process'));
});

test('compact capability requires exact own fields on a null-prototype envelope and the installed full owner', () => {
  const live = fixture(); assert.equal(live.invoke('bhInfo').compactStepVersion, 1);
  assert.equal(run(live).receipt.scope, 'frame');
  for(const cap of [{ version: 2, contract: 'bh-compact-step-fence-v1' }, { version: 1, contract: 'other' },
    { version: 1, contract: 'bh-compact-step-fence-v1', extra: true }, [],
    Object.assign(Object.create({ version: 1 }), { contract: 'bh-compact-step-fence-v1' })]) {
    const h = fixture({ cap }); assert.equal(h.main.mBH.state, 'error');
    assert.equal(h.main.mBH.compactStepVersion, undefined); assert(!h.events.includes('process'));
  }
  const noFull = fixture({ fullCapability: false });
  assert.equal(noFull.main.mBH.state, 'error'); assert(!noFull.fence.some(row => row.kind === 'compact'));
  for(const rejectRegistration of ['bhFrameBegin', 'bhFrameCommit', 'bhFrameAbort']) {
    const h = fixture({ rejectRegistration }); assert.equal(h.main.mBH.state, 'error');
    assert.equal(h.fence.length, 0);
  }
});

test('Begin returns exactly five fields after one Game and retains no receipt/digest until Commit', () => {
  const h = fixture();
  const begin = h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7');
  assert.deepEqual(plain(begin), { version: 1, phase: 'begun', token: 'compact_7', epoch: 1, tick: 7 });
  assert.deepEqual(h.events, ['presentation-begin', 'masks:17:3', 'process', 'draw', 'sound', 'background', 'presentation-end']);
  assert.equal(h.captures.length, 0); assert.equal(h.main.mBH.snapshot, undefined);
  for(const key of ['snapshotReceiptRequest', 'snapshotReceiptProof', 'snapshotReceiptPending']) assert.equal(h.main.mBH[key], undefined);
  assert.equal(h.main.mBH.stepping, false); assert.equal(h.main.mBH.snapshotReceiptEpoch, 1);
  assert.equal(h.invoke('bhPresent', 0.5).tick, 7);
  const step = h.invoke('bhFrameCommit', 'compact_7', 1, 7);
  assert.equal(step.error, undefined); assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].native.scope, 'frame'); assert.equal(h.captures[0].native.lastFullDigest, 'native-v2-0123456789abcdef');
  assert.equal(step.snapshotObjects, 0); assert.equal(step.snapshotFields, 0);
  assert(h.main.mBHCompactStep); assert(h.main.mBH.snapshotReceiptPending);
  assert(!h.fence.some(row => row.op === 'finish'));
  h.invoke('bhInfo'); const receipt = h.invoke('bhStateReceipt', 'compact_7', 1, 7);
  assert.equal(receipt.scope, 'frame'); assert.equal(receipt.header.digest, step.digest);
  assert.equal(h.main.mBHCompactStep, undefined);
  assert.equal(h.fence.filter(row => row.kind === 'compact' && row.op === 'finish').length, 1);
});

for(const [name, options, join] of [
  ['first-frame rules', { firstTick: 1 }, undefined], ['ordinary', {}, undefined],
  ['personal disabled', { personal: false }, undefined], ['single player', { onePlayer: true }, undefined],
  ['membership join', { onePlayer: true }, { slot: 2, character: 3 }], ['terminal', { terminal: true }, undefined],
]) test('actual unchanged frame snapshot and receipt match synchronous source: ' + name, () => {
  const sync = fixture(options), split = fixture(options), tick = sync.main.mBH.tick + 1;
  const old = run(sync, 'sync', tick, join), next = run(split, 'compact', tick, join);
  assert.deepEqual(withoutProfile(next.step), withoutProfile(old.step));
  assert.deepEqual(withoutProfile(next.receipt.header), withoutProfile(old.receipt.header));
  assert.deepEqual(split.captures.map(({ native, metadata, result }) => ({ native, metadata, result })),
    sync.captures.map(({ native, metadata, result }) => ({ native, metadata, result })));
  assert.deepEqual(split.events, sync.events);
  if(tick === 1) assert(split.events.indexOf('rules') > split.events.indexOf('draw')
    && split.events.indexOf('rules') < split.events.indexOf('sound'));
});

test('compact24 full25 compact26 retain one epoch per step and original full digest linkage', () => {
  const sync = fixture({ firstTick: 24 }), split = fixture({ firstTick: 24 });
  for(const tick of [24, 25, 26]) {
    const old = run(sync, 'sync', tick), next = run(split, 'compact', tick);
    assert.deepEqual(withoutProfile(next.step), withoutProfile(old.step));
    assert.deepEqual(withoutProfile(next.receipt.header), withoutProfile(old.receipt.header));
    assert.equal(next.receipt.scope, tick === 25 ? 'full' : 'frame');
    assert.equal(next.receipt.epoch, tick - 23);
  }
  assert.equal(split.captures[2].native.lastFullDigest, split.captures[1].result.digest);
  assert.equal(split.fence.filter(row => row.kind === 'full' && row.op === 'begin').length, 1);
  assert.equal(split.fence.filter(row => row.kind === 'compact' && row.op === 'begin').length, 2);
});

test('strict compact ABI rejects full ticks, malformed inputs and stale epochs before Game', () => {
  for(const args of [[25, 17, 3, undefined, 'compact_25'], [0, 17, 3, undefined, 'compact_0'],
    [7, -1, 3, undefined, 'compact_7'], [7, 17, 3, undefined, 'bad token'],
    [7, 17, 3, { slot: 1, character: 0 }, 'compact_7'], [7, 17, 3]]) {
    const h = fixture({ firstTick: args[0] === 25 ? 25 : 7 });
    assert(h.invoke('bhFrameBegin', ...args).error); assert(!h.events.includes('process'));
  }
  const h = fixture(); h.main.mBH.snapshotReceiptEpoch = 2147483647;
  assert(h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7').error); assert(!h.events.includes('process'));
});

test('pending compact admits only matching Commit/Present/Abort and then exactly one Info/Receipt', () => {
  const blocked = ['bhInfo', 'bhStep', 'bhState', 'bhPrepare', 'bhCheckpointExport', 'bhCheckpointImport',
    'bhMenuPoll', 'bhAnimationProbe', 'bhPresentationConfig', 'bhPresentationInfo', 'bhFrameBegin',
    'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhStepAbort', 'bhStateReceipt'];
  for(const name of blocked) {
    const h = fixture(); h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7');
    assert.throws(() => h.invoke(name, 'compact_7', 1, 7), /outside compact/);
    assert.equal(h.captures.length, 0); assert.equal(h.events.filter(value => value === 'process').length, 1);
  }
  const h = fixture(); h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7');
  for(const args of [['other', 1, 7], ['compact_7', 2, 7], ['compact_7', 1, 8], ['compact_7', 1, 7, 0]])
    assert.throws(() => h.invoke('bhFrameCommit', ...args), /identity arguments/);
  h.invoke('bhFrameCommit', 'compact_7', 1, 7);
  assert.throws(() => h.invoke('bhPresent', 0.5), /outside compact/);
  assert.throws(() => h.invoke('bhStateReceipt', 'compact_7', 1, 7), /outside compact/);
  h.invoke('bhInfo'); assert.throws(() => h.invoke('bhInfo'), /outside compact/);
  assert.equal(h.invoke('bhStateReceipt', 'compact_7', 1, 7).scope, 'frame');
  assert(h.invoke('bhStateReceipt', 'compact_7', 1, 7).error);
});

test('world, bridge, code and completed-Game mutations fail before publishing a compact receipt', () => {
  for(const mutate of [h => { h.main.mcWorld = { ...h.main.mcWorld }; }, h => { h.main.mBH = { ...h.main.mBH }; },
    h => { h.main.mBH.logicCalls++; }, h => { h.main.mBH.drawCalls++; }, h => { h.main.mcWorld.mTick++; },
    h => { h.main.mBH.tick++; }, h => { h.main.mBH.snapshotReceiptEpoch++; },
    h => { h.main.fState = () => {}; }, h => { h.global.boxheadNativeCompactFenceV1 = () => true; },
    h => { h.global.boxheadNativeStepFenceV1 = () => true; }]) {
    const h = fixture(); h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7'); mutate(h);
    assert(h.invoke('bhFrameCommit', 'compact_7', 1, 7).error);
    assert.equal(h.main.mBH.state, 'error'); assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
    assert.equal(h.main.mBHCompactStep, undefined); assert(!h.fence.some(row => row.op === 'finish'));
  }
});

test('ordinary scalar getter failure, digest reentry and phase-native failure remain sticky errors', () => {
  for(const prepare of [h => { h.failure = 'entity-scalar'; },
    h => { h.onDigest = () => h.invoke('bhInfo'); },
    h => { h.failOp = 'compact:enter:commit'; },
    h => { h.failOp = 'compact:leave:commit'; }]) {
    const h = fixture(); h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7'); prepare(h);
    assert(h.invoke('bhFrameCommit', 'compact_7', 1, 7).error);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined); assert.equal(h.main.mBH.snapshotReceiptRequest, undefined);
    assert.equal(h.main.mBH.state, 'error'); assert.equal(h.main.mBHCompactStep, undefined);
    assert(!h.fence.some(row => row.op === 'finish'));
  }
});

test('Begin failures never retry Game and cancellation clears each pending phase', () => {
  for(const failure of ['process', 'draw', 'sound', 'background', 'presentation-end']) {
    const h = fixture(); h.failure = failure;
    assert(h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7').error);
    assert.equal(h.main.mBH.stepping, false); assert.equal(h.main.mBHCompactStep, undefined);
    assert.equal(h.captures.length, 0); assert(h.events.filter(value => value === 'process').length <= 1);
  }
  for(const committed of [false, true]) {
    const h = fixture(); h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7');
    if(committed) h.invoke('bhFrameCommit', 'compact_7', 1, 7);
    assert(h.invoke('bhFrameAbort', 'compact_7', 1, 7).error);
    assert.equal(h.abortCalls, 1); assert.equal(h.main.mBHCompactStep, undefined);
    assert.equal(h.main.mBH.compactStepVersion, undefined); assert.equal(h.main.mBH.stagedStepVersion, undefined);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
    assert(!h.fence.some(row => row.op === 'finish'));
  }
});

test('terminal compact freezes debrief through Commit and allows it only after consumed receipt', () => {
  const h = fixture({ terminal: true }); h.invoke('bhFrameBegin', 7, 17, 3, undefined, 'compact_7');
  assert.equal(h.invoke('bhPresent', 0.5).rendered, false); h.main.BH_Pump();
  assert(!h.events.includes('debrief')); h.invoke('bhFrameCommit', 'compact_7', 1, 7); h.main.BH_Pump();
  assert(!h.events.includes('debrief')); h.invoke('bhInfo'); h.invoke('bhStateReceipt', 'compact_7', 1, 7);
  h.main.BH_Pump(); assert.equal(h.events.filter(value => value === 'debrief').length, 1);
});
