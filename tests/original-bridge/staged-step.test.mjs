import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { methodBodyRange } from '../../scripts/lib/original-phase-profile.mjs';
import { stripCompactStepBridge } from '../../scripts/lib/native-compact-step-source.mjs';
import { STAGED_STEP_BASE_BRIDGE_SHA256, STAGED_STEP_BRIDGE_HOOKS, stripStagedStepBridge,
  stagedStepReferenceMethods } from '../../scripts/lib/native-staged-step-source.mjs';

const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const bridge = stripCompactStepBridge(metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(source('tools/original-bridge/CMain.bridge.asinc')))));
const staged = source('tools/original-bridge/CMain.staged-step.asinc');
const adapter = source('tools/original-bridge/CMain.native-project.asinc');
const presentation = source('tools/original-bridge/CMain.presentation.asinc');
const before = stripStagedStepBridge(bridge);
const digest = 'native-v2-0123456789abcdef';
const plain = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
function method(input, name) {
  const range = methodBodyRange(input, name, tokens);
  const location = input.lastIndexOf('function ' + name + '(', range.start);
  const start = input.lastIndexOf('\n', location) + 1;
  return input.slice(start, range.end + 1);
}
const stagedNames = [...staged.matchAll(/\bfunction (BH_\w+)\(/g)].map(match => match[1]);

// Actual AS2 bodies run as a JS lifecycle/order model. This collaborator does
// not implement AVM1, the central native callback gate, autonomous event queues,
// Value marshalling, frame timing, or gameplay. Those require engine fixtures
// and the separate compiled/native/browser differential run.
function fixture({ capability = true, cap, rejectRegistration, terminal = false, personal = true,
  onePlayer = false, firstWorldTick = 24, replay = false } = {}) {
  const events = [], fence = [], captures = [], registrations = new Map(), markerDeletes = [];
  let wall = 1000, main, h;
  const global = {};
  const kernel = (op, owner, token, epoch, tick, phase) => {
    fence.push({ op, token, epoch, tick, phase });
    if (op === 'capability') return cap ?? Object.assign(Object.create(null), { version: 1, contract: 'bh-step-fence-v1' });
    if (h?.failOp === op + ':' + (phase ?? '')) throw new Error('kernel ' + op);
    if (op === 'abort') {
      h.abortCalls++;
      if (!h.poisoned) { h.poisoned = true; owner.BH_StagedFencePoison('native abort'); }
    }
    if (op === 'finish') {
      assert.equal(owner.mBH.snapshotReceiptPending, undefined, 'finish must follow original receipt consumption');
      assert.equal(h.entity.__bhSnapshotRef, undefined, 'finish cannot precede cleanup');
    }
    return true;
  };
  if (capability) global.boxheadNativeStepFenceV1 = kernel;
  const spend = (label, cost = 0) => {
    events.push(label); wall += cost;
    if (h?.failure === label) throw new Error('fixture ' + label);
  };
  const bridgeNames = ['BH_Install', 'BH_NativeScalarInstall', 'BH_NativeScalarInfo',
    'BH_NativeProjectionInstall', 'BH_NativeProjectionInfo', 'BH_ReceiptGuard', 'BH_ReceiptPoison',
    'BH_ReceiptDigest', 'BH_ReceiptPublish', 'BH_StateReceipt', 'BH_Fail', 'BH_Info', 'BH_Integer',
    'BH_ValidLink', 'BH_Step', 'BH_State', 'BH_Pump'];
  const adapterNames = ['BH_NativeProjectInstall', 'BH_NativeProjectInfo', 'BH_NativeProject'];
  const methods = bridgeNames.map(name => method(bridge, name))
    .concat(adapterNames.map(name => method(adapter, name)), stagedNames.map(name => method(staged, name)));
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
        assert.equal(h.entity.__bhSnapshotRef, 1, 'markers survive until canonical digest completes');
        captures.push({ native, metadata });
        h.onDigest?.();
        return { digest, bytes: 321, receipt: { ...metadata } };
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
  CMain.BH_PersonalSnapshot = () => { spend('personal', 3); return [{ slot: 1, score: 10 }, { slot: 2, score: 20 }]; };
  CMain.BH_Grid = () => { spend('grid'); return 'private-grid'; };
  CMain.BH_SkipField = () => false;
  CMain.BH_Project = (root, context) => {
    events.push('project'); context.objects.push(h.entity); h.entity.__bhSnapshotRef = 1; context.fields = 11;
    wall += 5; h.onProject?.(root, context);
    if (h.failure === 'project') throw new Error('fixture project');
    return { ...root, entities: { t7: { life: h.entity.life } } };
  };
  main.BH_MenuBounds = () => ({});
  main.BH_CheckpointAvailable = () => false;
  main.mcScreen = { idScreen: 'Screen_Main', mNormal: true };
  for (const name of ['Prepare', 'ReadState', 'CheckpointExport', 'CheckpointImport', 'MenuPoll', 'MenuUpdate',
    'RenderCheck', 'Controls', 'AnimationProbe', 'PresentationConfig', 'PresentationInfo'])
    main['BH_' + name] = () => { throw new Error('unexpected public ' + name); };
  main.BH_Present = alpha => {
    spend('present'); assert.equal(main.mBH.stepping, false);
    assert.equal(main.mBH.snapshotReceiptRequest, undefined);
    return { version: 1, enabled: true, rendered: main.mBH.complete === undefined, tick: main.mBH.tick, alpha };
  };
  h = { main, CMain, global, kernel, events, fence, captures, registrations, markerDeletes,
    abortCalls: 0, poisoned: false, advanceWall: ms => { wall += ms; } };
  main.BH_Install();
  if (main.mBH.state === 'error') return h;
  Object.assign(main.mBH, { active: true, state: 'playing', tick: 24, frameMs: 40, initialPlayers: onePlayer ? 1 : 2,
    playerCount: onePlayer ? 1 : 2, seed: 1, rng: 2, rngCalls: 3, replay, settings: {}, mode: 'Coop',
    map: 'fixture', characters: onePlayer ? [0] : [0, 1] });
  const entity = h.entity = new Proxy({ life: 100 }, { deleteProperty(target, key) {
    if (key === '__bhSnapshotRef') {
      markerDeletes.push(key); spend('cleanup');
      assert(main.mBH.snapshot !== undefined || main.mBH.state === 'error' || h.failure || main.mBHStagedStep?.failure,
        'successful cleanup follows snapshot publication');
    }
    return Reflect.deleteProperty(target, key);
  } });
  main.mcWorld = { mTick: firstWorldTick, mLoaded: true, mPaused: false,
    mThing_Collection: { mThings: { t7: entity }, mPlayerThings: {}, mDeleteThings: {}, mRespawnPlayer: {}, mThingCounters: {},
      mTimeSlice_25: [], mTimeSlice_8: [], mTimeSlice_4: [] },
    mMap: {}, mUpgrades: {}, mHud: {}, BH_InitializeRules: () => spend('rules') };
  Object.defineProperty(main.mcWorld, 'fixtureScalar', { enumerable: true, get() { spend('world-scalar'); return 7; } });
  main.State_Debrief = () => spend('debrief'); main.State_Debrief_Winner = () => spend('debrief-winner');
  main.State_RunWorld = () => {
    spend('world'); main.mBH.logicCalls++; main.mBH.drawCalls++; main.mcWorld.mTick++;
    if (terminal) { main.mcWorld.mCompleteState = 'player dead'; main.fState = main.State_Debrief; }
  };
  main.fState = main.State_RunWorld;
  main.BH_JoinPlayer = character => {
    spend('join:' + character); assert.equal(main.mBH.stepping, true);
    main.mBH.playerCount = 2; main.mBH.characters[1] = character;
  };
  main.BH_PresentationBegin = () => spend('presentation-begin');
  main.BH_PresentationEnd = tick => { assert.equal(tick, 25); spend('presentation-end'); };
  main.BH_Players = () => { spend('players'); return [{ slot: 1, life: 100 }, { slot: 2, life: 100 }]; };
  h.invoke = (name, ...args) => {
    const entry = registrations.get(name); assert(entry && typeof entry.callback === 'function', name);
    return entry.callback.apply(entry.receiver, args);
  };
  h.begin = (join = undefined) => h.invoke('bhStepBegin', 25, 17, onePlayer && join === undefined ? 0 : 3, join, 'stage_25');
  h.prepare = () => h.invoke('bhStepPrepare', 'stage_25', 1, 25);
  h.project = () => h.invoke('bhStepProject', 'stage_25', 1, 25);
  h.commit = () => h.invoke('bhStepCommit', 'stage_25', 1, 25);
  h.receipt = () => h.invoke('bhStateReceipt', 'stage_25', 1, 25);
  return h;
}

function complete(h, join) {
  assert.equal(h.begin(join).phase, 'begun'); assert.equal(h.prepare().phase, 'prepared');
  assert.equal(h.project().phase, 'projected'); const step = h.commit();
  assert.equal(step.error, undefined, step.error); h.invoke('bhInfo'); const receipt = h.receipt();
  assert.equal(receipt.error, undefined, receipt.error); return { step, receipt };
}

test('six exact staged hooks restore the entire pinned V5 bridge and only declaration names change in compiled references', () => {
  assert.equal(sha(before), STAGED_STEP_BASE_BRIDGE_SHA256);
  for (const name of ['BH_Prepare', 'BH_Step', 'BH_State', 'BH_StateReceipt', 'BH_ReceiptDigest', 'BH_ReceiptPublish'])
    assert.equal(method(bridge, name), method(before, name));
  const refs = stagedStepReferenceMethods(bridge, tokens);
  for (const [name, replacement] of [['BH_Step', 'BH_StagedOriginalStep'], ['BH_State', 'BH_StagedOriginalState']])
    assert.equal(method(refs, replacement).replace('function ' + replacement + '(', 'function ' + name + '(').trim(),
      method(before, name).trim());
  for (const hook of STAGED_STEP_BRIDGE_HOOKS) {
    assert.throws(() => stripStagedStepBridge(bridge.replace(hook.after, '')));
    assert.throws(() => stripStagedStepBridge(bridge.replace(hook.after, hook.after + hook.after)));
  }
  assert.throws(() => stagedStepReferenceMethods(bridge.replace('b.clock = tick * b.frameMs;', 'b.clock = tick * 41;'), tokens), /predecessor/);
  assert(source('scripts/build-original-swf.mjs').includes("'CMain.native-project.asinc', 'CMain.staged-step.asinc'"));
});

test('native capability absence preserves synchronous receipt flow and replay never advertises staged support', () => {
  const h = fixture({ capability: false });
  assert.equal(h.invoke('bhInfo').stagedStepVersion, undefined);
  const result = h.invoke('bhStep', 25, 17, 3, undefined, 'stage_25');
  assert.equal(result.digest, digest); h.invoke('bhInfo'); assert.equal(h.receipt().scope, 'full');
  assert.equal(h.fence.length, 0);
  const historical = fixture({ replay: true });
  assert.equal(historical.invoke('bhInfo').stagedStepVersion, undefined);
  assert(historical.begin().error); assert(!historical.events.includes('world'));
  const live = fixture(); assert.equal(live.invoke('bhInfo').stagedStepVersion, 1);
});

test('native capability with no prototype retains own-field validation through the complete staged receipt', () => {
  const cap = Object.assign(Object.create(null), { version: 1, contract: 'bh-step-fence-v1' });
  assert.equal(Object.getPrototypeOf(cap), null); assert.equal(cap.hasOwnProperty, undefined);
  const h = fixture({ cap }); assert.equal(h.invoke('bhInfo').stagedStepVersion, 1);
  assert.equal(complete(h).receipt.scope, 'full');
  assert.deepEqual(Object.keys(cap).sort(), ['contract', 'version']);
  for (const inherited of [Object.assign(Object.create({ version: 1 }), { contract: 'bh-step-fence-v1' }),
    Object.assign(Object.create({ contract: 'bh-step-fence-v1' }), { version: 1 })]) {
    const bad = fixture({ cap: inherited }); assert.equal(bad.main.mBH.state, 'error');
    assert(!bad.events.includes('world')); assert(!bad.fence.some(row => row.op === 'install'));
  }
});

test('malformed capabilities and any rejected stage registration fail before world execution', () => {
  for (const cap of [{ version: 2, contract: 'bh-step-fence-v1' }, { version: 1, contract: 'other' },
    { version: 1, contract: 'bh-step-fence-v1', extra: true }, []]) {
    const h = fixture({ cap }); assert.equal(h.main.mBH.state, 'error');
    assert.equal(h.main.mBH.stagedStepVersion, undefined); assert(!h.events.includes('world'));
  }
  for (const name of ['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhStepAbort']) {
    const h = fixture({ rejectRegistration: name }); assert.equal(h.main.mBH.state, 'error');
    assert.equal(h.fence.length, 0); assert(!h.events.includes('world'));
  }
});

test('three phase responses have exactly five identity fields and no digest or receipt is produced before Commit', () => {
  const h = fixture();
  for (const [phase, call] of [['begun', h.begin], ['prepared', h.prepare], ['projected', h.project]]) {
    assert.deepEqual(plain(call()), { version: 1, phase, token: 'stage_25', epoch: 1, tick: 25 });
    assert.equal(h.main.mBH.stepping, false); assert.equal(h.main.mBH.snapshotReceiptEpoch, 1);
    assert.equal(h.main.mBH.snapshotReceiptRequest, undefined); assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
    assert.equal(h.captures.length, 0); assert.equal(h.main.mcWorld.mTick, 25);
    assert.equal(h.invoke('bhPresent', 0.5).tick, 25);
  }
  assert.equal(h.entity.__bhSnapshotRef, 1); assert.equal(h.markerDeletes.length, 0);
  const step = h.commit(); assert.equal(step.digest, digest); assert.equal(h.captures.length, 1);
  assert.equal(h.entity.__bhSnapshotRef, undefined); assert.equal(h.markerDeletes.length, 1);
  assert(h.main.mBHStagedStep); assert(h.main.mBH.snapshotReceiptPending);
  assert.equal(h.fence.some(entry => entry.op === 'finish'), false);
  h.invoke('bhInfo'); const receipt = h.receipt();
  assert.equal(receipt.header.digest, step.digest); assert.equal(receipt.header.profile, step.profile);
  assert.equal(h.main.mBHStagedStep, undefined); assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  assert.deepEqual(h.fence.map(({ op, phase }) => op + (phase ? ':' + phase : '')),
    ['capability', 'install', 'begin', 'leave:begin', 'enter:prepare', 'leave:prepare',
      'enter:project', 'leave:project', 'enter:commit', 'leave:commit', 'finish']);
});

for (const options of [{}, { terminal: true }, { personal: false }, { onePlayer: true }, { firstWorldTick: 0 }]) {
  test('staged full projection matches exact synchronous operation order, final graph and receipt: ' + JSON.stringify(options), () => {
    const previous = fixture(options), current = fixture(options);
    const join = options.onePlayer ? { slot: 2, character: 2 } : undefined;
    const expected = previous.invoke('bhStep', 25, 17, 3, join, 'stage_25');
    previous.invoke('bhInfo'); const expectedReceipt = previous.receipt();
    const actual = complete(current, join);
    assert.deepEqual(current.events, previous.events);
    assert.deepEqual(plain(current.captures), plain(previous.captures));
    assert.deepEqual(plain(actual.step), plain(expected));
    assert.deepEqual(plain(actual.receipt), plain(expectedReceipt));
    assert.equal(current.markerDeletes.length, 1); assert.equal(current.main.mBH.snapshotReceiptEpoch, 1);
    assert.equal(current.events.filter(value => value === 'world').length, 1);
  });
}

test('profile projectMs counts actual personal and projection work while excluding waits between callbacks', () => {
  const h = fixture(); h.begin(); h.advanceWall(1000); h.prepare(); h.advanceWall(2000); h.project();
  h.advanceWall(3000); const result = h.commit();
  assert.deepEqual(plain(result.profile), { projectMs: 8, encodeMs: 0, hashMs: 2 });
  assert.equal(h.main.mBH.clock, 1000); assert.equal(h.main.mBH.rngCalls, 3);
});

test('a new prepared round reuses the installed owner with a later epoch and a restarted tick sequence', () => {
  assert(!/snapshotReceiptEpoch\s*=/.test(method(bridge, 'BH_Prepare')), 'prepare must retain receipt epoch');
  const h = fixture(); complete(h);
  // A separate real preparation is qualified by the browser run. This
  // lifecycle fixture supplies its ready world without executing loaders.
  h.main.mBH.tick = 24; h.main.mcWorld.mTick = 24; delete h.main.mBH.snapshot;
  assert.deepEqual(plain(h.begin()), { version: 1, phase: 'begun', token: 'stage_25', epoch: 2, tick: 25 });
  for (const [name, phase] of [['bhStepPrepare', 'prepared'], ['bhStepProject', 'projected']])
    assert.equal(h.invoke(name, 'stage_25', 2, 25).phase, phase);
  const step = h.invoke('bhStepCommit', 'stage_25', 2, 25); h.invoke('bhInfo');
  const receipt = h.invoke('bhStateReceipt', 'stage_25', 2, 25);
  assert.equal(receipt.header.digest, step.digest); assert.equal(receipt.epoch, 2);
  assert.equal(h.captures.length, 2); assert.equal(h.main.mBH.snapshotReceiptEpoch, 2);
  assert.equal(h.fence.filter(entry => entry.op === 'install').length, 1);
});

test('full root evaluation precedes the original scan identity validation and personal snapshot', () => {
  const h = fixture(); h.begin(); h.main.mBH.nativeProjectionScanKernel = () => false;
  const result = h.prepare(); assert(result.error);
  assert(h.events.includes('world-scalar')); assert(h.events.includes('grid'));
  assert.equal(h.events.includes('personal'), false); assert.equal(h.events.includes('project'), false);
  assert.equal(h.abortCalls, 1); assert.equal(h.captures.length, 0);
});

test('only the next matching phase and Present are allowed between callbacks; ordinary exports cannot bypass the absent request', () => {
  for (const name of ['bhInfo', 'bhStep', 'bhState', 'bhStateReceipt', 'bhPrepare', 'bhCheckpointExport',
    'bhCheckpointImport', 'bhMenuPoll', 'bhMenuUpdate', 'bhRenderCheck', 'bhControls', 'bhAnimationProbe',
    'bhPresentationConfig', 'bhPresentationInfo', 'bhStepBegin', 'bhStepProject', 'bhStepCommit']) {
    const h = fixture(); h.begin();
    assert.throws(() => h.invoke(name), /staged frame phase|staged callback/, name);
    assert.equal(h.events.filter(value => value === 'world').length, 1, name);
    assert.equal(h.captures.length, 0, name);
  }
  for (const args of [['other', 1, 25], ['stage_25', 2, 25], ['stage_25', 1, 50], ['stage_25', 1, 25, true]]) {
    const h = fixture(); h.begin(); assert.throws(() => h.invoke('bhStepPrepare', ...args), /identity arguments/);
    assert.equal(h.events.includes('grid'), false);
  }
});

test('Present is rejected inside an active projection and the outer phase aborts with one cleanup', () => {
  const h = fixture(); h.begin(); h.prepare(); h.onProject = () => h.invoke('bhPresent', 0.25);
  const result = h.project(); assert(result.error); assert.match(result.error, /reentrant/);
  assert.equal(h.abortCalls, 1); assert.equal(h.markerDeletes.length, 1);
  assert.equal(h.entity.__bhSnapshotRef, undefined); assert.equal(h.main.mBHStagedStep, undefined);
  assert.equal(h.captures.length, 0); assert.equal(h.main.mBH.state, 'error');
});

for (const failure of ['masks:17:3', 'world', 'sound', 'background', 'personal', 'project', 'digest', 'players', 'cleanup']) {
  test('failure closes the transaction without a receipt and never repeats cleanup: ' + failure, () => {
    const h = fixture(); h.failure = failure;
    let result = h.begin();
    if (!result.error) result = h.prepare();
    if (!result.error) result = h.project();
    if (!result.error) result = h.commit();
    assert(result.error, failure); assert.equal(h.main.mBH.state, 'error');
    assert.equal(h.main.mBH.stepping, false); assert.equal(h.main.mBHStagedStep, undefined);
    assert.equal(h.main.mBH.snapshotReceiptRequest, undefined); assert.equal(h.main.mBH.snapshotReceiptProof, undefined);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined); assert.equal(h.abortCalls, 1);
    assert.equal(h.markerDeletes.length, ['project', 'digest', 'players', 'cleanup'].includes(failure) ? 1 : 0);
    assert.equal(h.fence.some(entry => entry.op === 'finish'), false);
  });
}

test('native leave and finish failures poison even after a valid digest, publication, or receipt consumption', () => {
  for (const failure of ['leave:begin', 'leave:prepare', 'leave:project', 'leave:commit', 'finish:']) {
    const h = fixture(); h.failOp = failure;
    let result = h.begin(); if (!result.error) result = h.prepare(); if (!result.error) result = h.project();
    if (!result.error) result = h.commit();
    if (!result.error) { h.invoke('bhInfo'); result = h.receipt(); }
    assert(result.error, failure); assert.equal(h.main.mBH.state, 'error'); assert.equal(h.main.mBHStagedStep, undefined);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined); assert.equal(h.abortCalls, 1);
    assert.equal(h.markerDeletes.length, ['leave:project', 'leave:commit', 'finish:'].includes(failure) ? 1 : 0);
  }
});

test('explicit cancellation at every task boundary cleans its retained graph once and cannot return success', () => {
  for (let stage = 0; stage < 4; stage++) {
    const h = fixture(); h.begin(); if (stage >= 1) h.prepare(); if (stage >= 2) h.project(); if (stage >= 3) h.commit();
    const result = h.invoke('bhStepAbort', 'stage_25', 1, 25);
    assert.equal(result.state, 'error'); assert.equal(result.digest, undefined); assert.equal(result.phase, undefined);
    assert.equal(h.abortCalls, 1); assert.equal(h.markerDeletes.length, stage >= 2 ? 1 : 0);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined); assert.equal(h.main.mBHStagedStep, undefined);
    assert.equal(h.main.mBH.stagedStepVersion, undefined);
  }
});

test('bridge, world, kernel, epoch, tick and executed-step identity changes fail before projection resumes', () => {
  const mutations = [h => { h.main.mBH = { ...h.main.mBH }; }, h => { h.main.mcWorld = { ...h.main.mcWorld }; },
    h => { h.global.boxheadNativeStepFenceV1 = () => true; }, h => { h.main.mBH.snapshotReceiptEpoch++; },
    h => { h.main.mBH.tick++; }, h => { h.main.mcWorld.mTick++; }, h => { h.main.mBH.logicCalls++; },
    h => { h.main.mBH.drawCalls++; }, h => { h.main.mBH.complete = 'changed'; }, h => { h.main.fState = () => {}; }];
  for (const mutate of mutations) {
    const h = fixture(); h.begin(); mutate(h); const result = h.prepare();
    assert(result.error); assert.equal(h.events.includes('grid'), false); assert.equal(h.captures.length, 0);
    assert.equal(h.main.mBH.state, 'error'); assert.equal(h.main.mBHStagedStep, undefined);
  }
});

test('Commit requires exactly one Info before the original consuming receipt and a second receipt is fatal', () => {
  const h = fixture(); h.begin(); h.prepare(); h.project(); const step = h.commit();
  assert.equal(step.digest, digest); assert.throws(() => h.receipt(), /outside staged frame phase/);
  assert.equal(h.fence.some(entry => entry.op === 'finish'), false);
  const repeated = fixture(); repeated.begin(); repeated.prepare(); repeated.project(); repeated.commit();
  repeated.invoke('bhInfo'); assert.throws(() => repeated.invoke('bhInfo'), /outside staged frame phase/);
  const valid = fixture(); const result = complete(valid);
  assert.equal(result.receipt.header.digest, result.step.digest);
  assert.equal(valid.receipt().state, 'error'); assert.equal(valid.captures.length, 1);
});

test('pending terminal Begin blocks debrief disposal while Present can report the executed tick without rendering', () => {
  const h = fixture({ terminal: true }); h.begin();
  assert.equal(h.invoke('bhPresent', 0.25).rendered, false); assert.equal(h.main.mBH.complete, 'player dead');
  for (const call of [() => {}, h.prepare, h.project, h.commit]) {
    call(); h.main.BH_Pump(); assert.equal(h.events.includes('debrief'), false);
  }
  h.invoke('bhInfo'); h.receipt(); h.main.BH_Pump(); assert.equal(h.events.filter(value => value === 'debrief').length, 1);
  const pump = method(bridge, 'BH_Pump');
  assert(pump.indexOf('if(this.mBHStagedStep !== undefined) return;') < pump.indexOf('if(b.complete != undefined'));
  assert(!presentation.includes('BH_Staged'), 'staging must preserve the original presentation module');
});

test('staged Begin rejects non-full, wrong-mask, stale, existing-receipt and invalid-membership frames before Process', () => {
  for (const args of [[24, 0, 0, undefined, 'token'], [26, 0, 0, undefined, 'token'],
    [25, -1, 0, undefined, 'token'], [25, 0, 131072, undefined, 'token'],
    [25, 0, 0, undefined, 'bad-token'], [25, 0, 0, { slot: 2, character: 1 }, 'token']]) {
    const h = fixture(); const result = h.invoke('bhStepBegin', ...args); assert(result.error);
    assert.equal(h.events.includes('world'), false); assert.equal(h.captures.length, 0);
  }
  for (const field of ['snapshotReceiptRequest', 'snapshotReceiptProof', 'snapshotReceiptPending']) {
    const h = fixture(); h.main.mBH[field] = {}; assert(h.begin().error); assert(!h.events.includes('world'));
  }
});
