import { secondaryV2Predecessor } from './helpers/membership-secondary-v2-source.mjs';
import { membershipV1Predecessor } from './helpers/membership-v1-source.mjs';
import { secondaryPredecessor } from './helpers/membership-secondary-source.mjs';
import { membershipV2Predecessor } from './helpers/membership-v2-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metadataPredecessorBridge } from '../../scripts/lib/native-anchor-metadata-source.mjs';
import { runInNewContext } from 'node:vm';
import { tokens } from '../../scripts/build-original-swf.mjs';
import { stripNativeProjectionScan } from './helpers/native-projection-scan-source.mjs';
import { stripCompactStepBridge } from '../../scripts/lib/native-compact-step-source.mjs';

const currentBridge = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
const source = stripCompactStepBridge(metadataPredecessorBridge(membershipV1Predecessor(membershipV2Predecessor(currentBridge))));
const nativeProject = readFileSync(new URL('../../tools/original-bridge/CMain.native-project.asinc', import.meta.url), 'utf8');
const stagedStep = readFileSync(new URL('../../tools/original-bridge/CMain.staged-step.asinc', import.meta.url), 'utf8');
const replay = readFileSync(new URL('../../tools/original-bridge/CMain.replay.asinc', import.meta.url), 'utf8');
const checkpoint = readFileSync(new URL('../../tools/original-bridge/CMain.checkpoint.asinc', import.meta.url), 'utf8');
const baseline = readFileSync(new URL('./fixtures/state-receipt-bridge-baseline.asinc', import.meta.url), 'utf8');
const replayBaseline = readFileSync(new URL('./fixtures/state-receipt-replay-baseline.asinc', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const DIGEST = 'native-v2-0123456789abcdef';
const names = ['bhInfo', 'bhPrepare', 'bhStep', 'bhState', 'bhStateReceipt',
  'bhCheckpointExport', 'bhCheckpointImport', 'bhMenuPoll',
  'bhMenuUpdate', 'bhRenderCheck', 'bhControls', 'bhAnimationProbe',
  'bhPresentationConfig', 'bhPresent', 'bhPresentationInfo',
  'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhStepAbort', 'bhReplayInfo', 'bhReplayEnd'];

function method(input, name) {
  if (input === source && !input.includes('function ' + name + '('))
    input = nativeProject.includes('function ' + name + '(') ? nativeProject : stagedStep;
  const location = input.indexOf('function ' + name + '(');
  assert(location >= 0, 'Missing actual method ' + name);
  const start = input.lastIndexOf('\n', location) + 1;
  // End at the actual method's closing brace. Comments introducing a newly
  // added following method are not part of this method's byte comparison.
  const parsed = tokens(input.slice(location));
  const opening = parsed.findIndex(token => !token.string && token.value === '{');
  assert(opening >= 0, 'Missing method body ' + name);
  let depth = 0;
  for (let index = opening; index < parsed.length; index++) {
    const token = parsed[index];
    if (token.string) continue;
    if (token.value === '{') depth++;
    if (token.value === '}' && --depth === 0) return input.slice(start, location + token.end);
  }
  assert.fail('Unterminated actual method ' + name);
}

// Execute actual transaction/entry-point methods with a deliberately small
// world collaborator. This models lifecycle and object identity, not AVM1,
// native gameplay parity, serialization cost, or real-browser performance.
function harness({ previousTick = 0, onDigest, rejectRegistration, terminal = false, nativeProducer = false } = {}) {
  const callbacks = new Map(), calls = [], captures = [];
  const lifecycle = ['BH_Install', 'BH_NativeScalarInstall', 'BH_NativeScalarInfo',
    'BH_NativeProjectionInstall', 'BH_NativeProjectionInfo',
    'BH_NativeProjectInstall', 'BH_NativeProjectInfo', 'BH_NativeProject',
    'BH_NativeScalarString', 'BH_ThingScalars', 'BH_ReceiptGuard', 'BH_ReceiptPoison', 'BH_ReceiptDigest',
    'BH_ReceiptPublish', 'BH_StateReceipt', 'BH_Fail', 'BH_Info', 'BH_Integer', 'BH_ValidLink',
    'BH_Step', 'BH_ReadState', 'BH_State', 'BH_FrameState',
    'BH_StagedInstall', 'BH_StagedStepBegin', 'BH_StagedStepPrepare', 'BH_StagedStepProject',
    'BH_StagedStepCommit', 'BH_StagedStepAbort', 'BH_StagedStateReceipt', 'BH_StagedFencePoison'];
  // These real entry points participate in the same receipt/reentrancy guard.
  // The graph codec is absent in this lifecycle fixture; no checkpoint world
  // implementation or capability result is fabricated here.
  const checkpointLifecycle = ['BH_CheckpointAvailable', 'BH_CPRequire', 'BH_CPAssertQuiescent',
    'BH_CheckpointExport', 'BH_CheckpointImport'];
  let main;
  const CMain = runInNewContext('(class CMain {\n' + (lifecycle.map(name => method(source, name)).join('\n')
    + '\n' + method(replay, 'BH_ReplayRegister')
    + '\n' + checkpointLifecycle.map(name => method(checkpoint, name)).join('\n'))
    .replace(/static function ([A-Za-z_][A-Za-z_0-9]*)\(/g, 'static $1(')
    .replace(/(?<!static )function (BH_[A-Za-z_0-9]*)\(/g, '$1(') + '\n})', {
    Object, Array, Error, Math, String, Number, isNaN, isFinite, _global: {}, getTimer: () => 0,
    flash: { external: { ExternalInterface: {
      available: true,
      addCallback(name, receiver, callback) {
        callbacks.set(name, { receiver, callback });
        return name !== rejectRegistration && typeof callback === 'function';
      },
      call(name, native, metadata) {
        assert.equal(name, 'boxheadDigestOriginalState');
        captures.push({ native, metadata, argumentCount: arguments.length });
        calls.push('digest');
        const result = { digest: DIGEST, bytes: 321 };
        if (metadata !== undefined) result.receipt = { ...metadata };
        return onDigest ? onDigest({ main, callbacks, captures, native, metadata, result }) : result;
      },
    } } },
    CSound: { ProcessAll: () => calls.push('sound') },
    DrawPrimitive: { XSI: { CDrawPrimitive_XSI_DI: { mRenderStack: [] } } },
    World: { Map: { CMap_Cell: {}, CMap: { mCheckSessionID: 0 } } },
    Thing: { CThing: { mAllocate_ID: 1, mAllocate_ProcessID_Count: 0 }, Math: { CThing_Position: { mPFactor: 1 } } },
  });
  main = new CMain();
  CMain._this = main;
  CMain.mInput = { BH_ApplyMasks: () => calls.push('masks'), mKey_List_Registered: {} };
  CMain.ProcessBGTasks = () => calls.push('background');
  CMain.BH_PersonalEnabled = () => false;
  CMain.BH_Grid = () => '';
  CMain.BH_Project = value => ({ ...value });
  CMain.BH_Scalars = value => value === undefined ? {} : { ...value };
  CMain.BH_SkipField = () => false;
  main.BH_MenuBounds = () => ({});
  main.mcScreen = { idScreen: 'Screen_Main', mNormal: true };
  for (const name of ['Prepare', 'MenuPoll', 'MenuUpdate', 'RenderCheck', 'Controls', 'AnimationProbe', 'ReplayInfo',
    'PresentationConfig', 'Present', 'PresentationInfo']) {
    main['BH_' + name] = function (...args) { calls.push('public:' + name); return { name, receiver: this === main, args }; };
  }
  main.BH_Install();
  main.BH_ReplayRegister();
  if (rejectRegistration) return { main, callbacks, calls, captures };
  Object.assign(main.mBH, { active: true, state: 'ready', tick: previousTick, seed: 1, rng: 2, rngCalls: 3,
    initialPlayers: 2, playerCount: 2, frameMs: 40, started: 0, settings: {}, mode: 'Coop', map: 'fixture', characters: [0, 1] });
  main.mcWorld = { mTick: previousTick, mLoaded: true, mPaused: false,
    mArea: { width: 640, height: 480 }, mInitList: [],
    Init() {}, InitDrawPlanes() {}, InitThings() {}, InitCleanUp() {}, InitFinished() {},
    mThing_Collection: { mThings: {}, mPlayerThings: {}, mDeleteThings: {}, mRespawnPlayer: {}, mThingCounters: {} },
    mMap: {}, mUpgrades: { Level: {} }, mHud: {}, BH_InitializeRules: () => calls.push('rules') };
  main.State_RunWorld = () => {
    calls.push('world'); main.mBH.logicCalls++; main.mBH.drawCalls++; main.mcWorld.mTick++;
    if (terminal) main.mcWorld.mCompleteState = 'player dead';
  };
  main.fState = main.State_RunWorld;
  main.BH_JoinPlayer = () => { throw new Error('membership is outside this lifecycle fixture'); };
  // Presentation is a separate collaborator; these no-op boundaries let this
  // receipt fixture assert the original gameplay/capture transaction order.
  main.BH_PresentationBegin = () => undefined;
  main.BH_PresentationEnd = () => undefined;
  main.BH_Players = () => [{ slot: 1, id: 7, x: 1, y: 2, z: 0, angle: 0, life: 100, ammo: 12 }];
  const actualState = main.BH_State;
  const build = () => {
    const b = main.mBH;
    const native = { scope: b.tick % 25 === 0 ? 'full' : 'frame', tick: b.tick,
      entities: { t7: { life: 100, absent: { $undefined: 1 } } }, rng: { seed: b.seed, state: b.rng, calls: b.rngCalls } };
    try {
      const fast = b.snapshotReceiptRequest === undefined
        ? CMainDigest(native) : main.BH_ReceiptDigest(native);
      b.snapshot = { version: 1, engine: 'original-swf', state: b.state, tick: b.tick, scope: native.scope,
        digest: fast.digest, digestSchema: 'native-projection-v3', native, entities: native.entities,
        players: main.BH_Players(), rng: { ...native.rng }, snapshotBytes: fast.bytes, snapshotObjects: 2,
        snapshotFields: 11, profile: { projectMs: 2, encodeMs: 0, hashMs: 1 }, futureHeader: { native: true } };
      return b.snapshot;
    } catch (error) { return main.BH_Fail('fixture snapshot: ' + String(error)); }
  };
  // The legacy fixture keeps the same observable callback shape. The native
  // producer tests below exercise the two actual source projection entry paths.
  function CMainDigest(native) {
    captures.push({ native, metadata: undefined, argumentCount: 2 }); calls.push('digest');
    return { digest: DIGEST, bytes: 321 };
  }
  if (!nativeProducer) main.BH_State = (refresh, forceFull) => {
    if (refresh === true && main.mBH.snapshotReceiptPending === undefined && main.mBH.state !== 'error') return build();
    return actualState.call(main, refresh, forceFull);
  };
  const invoke = (name, ...args) => {
    const registered = callbacks.get(name); assert(registered, 'Unknown callback ' + name);
    return registered.callback.apply(registered.receiver, args);
  };
  return { main, CMain, callbacks, calls, captures, invoke, actualState };
}

function success(h, tick, token = 'lease_1') {
  const step = h.invoke('bhStep', tick, 0, 0, undefined, token);
  assert.equal(step.error, undefined, step.error);
  assert.equal(step.tick, tick); assert.equal(step.digest, DIGEST);
  const metadata = h.captures.at(-1).metadata;
  const info = h.invoke('bhInfo');
  assert.equal(info.snapshotReceiptVersion, 1); assert.equal(info.tick, tick); assert.equal(info.state, 'playing');
  const receipt = h.invoke('bhStateReceipt', token, metadata.epoch, tick);
  assert.equal(receipt.error, undefined, receipt.error);
  return { step, metadata, receipt };
}

test('all twenty-two actual ExternalInterface registrations use the guard, including staged, presentation, checkpoint and replay entry points', () => {
  const h = harness();
  assert.deepEqual([...h.callbacks.keys()], names);
  const registrations = [...(source + '\n' + replay).matchAll(/addCallback\("([^"]+)",this,([^\n]+)\)/g)];
  assert.equal(registrations.length, 22);
  for (const [, name, expression] of registrations) assert(expression.startsWith('this.BH_ReceiptGuard("' + name + '",'), name);
  for (const name of names) assert.equal(h.callbacks.get(name).receiver, h.main);
  assert.equal(h.invoke('bhInfo').snapshotReceiptVersion, 1);
  assert.equal(Object.hasOwn(h.invoke('bhInfo'), 'checkpointVersion'), false);
  for (const name of ['bhStateReceipt', 'bhCheckpointExport', 'bhCheckpointImport',
    'bhPresentationConfig', 'bhPresent', 'bhPresentationInfo',
    'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhStepAbort', 'bhReplayEnd']) {
    const rejected = harness({ rejectRegistration: name });
    assert.equal(rejected.main.mBH.state, 'error');
    assert.match(rejected.main.mBH.error, /registration failed/);
  }
});

test('legacy snapshots and raw-key policy remain unchanged, and replay changes only its registration', () => {
  assert.equal(createHash('sha256').update(baseline).digest('hex'), 'f982177c1f65edc41df73bb79c4a024e9b4523093fc0403a3b67bb9ed8207920');
  assert.equal(createHash('sha256').update(replayBaseline).digest('hex'), '6ed660153c146be05185c0dc161f4a63907962a3f08e42687587ab37266ad1c7');
  for (const name of ['BH_ReadState', 'BH_Project', 'BH_Scalars', 'BH_SkipField', 'BH_SkipFieldUncached', 'BH_ProcessName', 'BH_Grid', 'BH_Players'])
    assert.equal(method(stripNativeProjectionScan(source), name), method(baseline, name), name + ' changed');
  assert.equal(secondaryPredecessor('tools/original-bridge/CMain.replay.asinc', secondaryV2Predecessor('tools/original-bridge/CMain.replay.asinc', replay)).replace('this.BH_ReceiptGuard("bhReplayInfo",this.BH_ReplayInfo)', 'this.BH_ReplayInfo'), replayBaseline);
  const h = harness();
  const step = h.invoke('bhStep', 1, 0, 0);
  assert.equal(step.digest, DIGEST); assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].metadata, undefined); assert.equal(h.captures[0].argumentCount, 2);
  assert.equal(h.main.mBH.snapshotReceiptEpoch, 0);
  assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  assert.equal(h.invoke('bhState'), h.main.mBH.snapshot);
  assert.equal(Object.hasOwn(h.main.mBH.snapshot, 'snapshotReceiptVersion'), false);
});

test('one actual graph capture is bound to the exact final snapshot and every actual own header', () => {
  const h = harness();
  const { step, metadata, receipt } = success(h, 1);
  const snapshot = h.main.mBH.snapshot, capture = h.captures[0];
  assert.equal(capture.native, snapshot.native); assert.equal(capture.argumentCount, 3);
  assert.deepEqual(plain(metadata), { version: 1, token: 'lease_1', epoch: 1, tick: 1, scope: 'frame' });
  assert.deepEqual(Object.keys(receipt).sort(), ['version', 'token', 'epoch', 'tick', 'scope', 'header'].sort());
  assert.deepEqual(Object.keys(receipt.header).sort(), Object.keys(snapshot).filter(key => key !== 'native' && key !== 'entities').sort());
  for (const key of Object.keys(receipt.header)) assert.equal(receipt.header[key], snapshot[key], key + ' identity/value changed');
  assert.equal(receipt.header.players, step.players); assert.equal(receipt.header.profile, step.profile);
  assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  assert.equal(h.main.mBH.snapshotReceiptRequest, undefined);
  assert.equal(h.main.mBH.snapshotReceiptProof, undefined);
  assert.equal(h.invoke('bhState'), snapshot, 'legacy read after consumption must preserve exact cached snapshot');
  assert.deepEqual(plain({ ...receipt.header, native: capture.native, entities: capture.native.entities }), plain(snapshot));
});

test('epochs increase once per requested frame while a later legacy step stays compatible', () => {
  const h = harness();
  assert.equal(success(h, 1, 'call_1').metadata.epoch, 1);
  assert.equal(success(h, 2, 'call_2').metadata.epoch, 2);
  assert.equal(h.invoke('bhStep', 3, 0, 0).tick, 3);
  assert.equal(h.main.mBH.snapshotReceiptEpoch, 2);
  assert.equal(h.captures.at(-1).metadata, undefined);
  assert.equal(success(h, 4, 'call_4').metadata.epoch, 3);
});

test('actual compact and scheduled full producers transfer their own cached native identity', () => {
  for (const tick of [1, 25]) {
    const h = harness({ previousTick: tick - 1, nativeProducer: true });
    const { receipt } = success(h, tick, 'producer_' + tick);
    const capture = h.captures[0], snapshot = h.main.mBH.snapshot;
    assert.equal(h.captures.length, 1); assert.equal(capture.native, snapshot.native);
    assert.equal(receipt.scope, tick === 25 ? 'full' : 'frame');
    assert.equal(receipt.header.scope, capture.native.scope);
    assert.equal(receipt.header.snapshotBytes, 321);
    assert.equal(h.invoke('bhState'), snapshot);
  }
});

test('a terminal frame still produces one receipt but cannot advance a second native tick', () => {
  const h = harness({ terminal: true });
  const { step, receipt } = success(h, 1);
  assert.equal(step.complete, 'player dead'); assert.equal(receipt.header.tick, 1);
  assert.equal(h.invoke('bhState'), h.main.mBH.snapshot);
  const before = h.main.mcWorld.mTick;
  assert.match(h.invoke('bhStep', 2, 0, 0, undefined, 'later').error, /post-completion/);
  assert.equal(h.main.mcWorld.mTick, before);
});

test('malformed requested tokens and exhausted epochs fail before any native world work', () => {
  for (const token of [null, false, 0, 1, NaN, {}, [], '', 'has space', 'a-b', 'x'.repeat(101), '\u{1f600}']) {
    const h = harness();
    assert(h.invoke('bhStep', 1, 0, 0, undefined, token).error, String(token));
    assert.equal(h.main.mcWorld.mTick, 0); assert.equal(h.captures.length, 0); assert.deepEqual(h.calls, []);
  }
  for (const epoch of [undefined, null, -1, 0.5, 2147483647]) {
    const h = harness(); h.main.mBH.snapshotReceiptEpoch = epoch;
    assert(h.invoke('bhStep', 1, 0, 0, undefined, 'bounded').error);
    assert.equal(h.main.mcWorld.mTick, 0); assert.equal(h.captures.length, 0);
  }
});

test('missing, inherited, malformed, or mismatched callback proofs poison the supported path without fallback', () => {
  const mutations = [
    result => { delete result.receipt; }, result => { result.receipt = null; }, result => { result.receipt = []; },
    result => { result.receipt.version = 2; }, result => { result.receipt.token = 'other'; },
    result => { result.receipt.epoch++; }, result => { result.receipt.tick++; },
    result => { result.receipt.scope = 'full'; }, result => { result.receipt.extra = true; },
    result => { result.receipt = Object.create(result.receipt); },
    result => { result.digest = 'input-log'; }, result => { result.bytes = -1; },
  ];
  for (const mutate of mutations) {
    const h = harness({ onDigest: ({ result }) => { mutate(result); return result; } });
    assert(h.invoke('bhStep', 1, 0, 0, undefined, 'requested').error);
    assert.equal(h.main.mBH.state, 'error'); assert.equal(h.main.mBH.snapshotReceiptBusy, false);
    assert.equal(h.main.mBH.snapshot, undefined, 'failed callback must not publish a snapshot');
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined); assert.equal(h.captures.length, 1);
  }
});

test('every nested registered EI callback poisons the outer transaction even when its error is suppressed', () => {
  for (const nestedName of names) {
    const h = harness({ onDigest: ({ callbacks, result }) => {
      const nested = callbacks.get(nestedName);
      const rejected = nested.callback.apply(nested.receiver, []);
      assert.equal(rejected.state, 'error');
      return result; // Deliberately ignore the nested error; the outer must fail.
    } });
    const step = h.invoke('bhStep', 1, 0, 0, undefined, 'guarded');
    assert(step.error, nestedName); assert.equal(h.main.mBH.state, 'error', nestedName);
    assert.equal(h.main.mBH.snapshotReceiptPoisoned, true, nestedName);
    assert.equal(h.main.mBH.snapshotReceiptBusy, false, nestedName);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined, nestedName);
    assert.equal(h.main.mBH.snapshot, undefined, nestedName);
    assert.equal(h.calls.filter(value => value === 'world').length, 1, nestedName);
    assert.equal(h.calls.some(value => value.startsWith('public:')), false, nestedName);
  }
});

test('a callback exception or a second capture attempt clears busy and cannot publish evidence', () => {
  for (const onDigest of [() => { throw new Error('callback failed'); }, ({ main, native, result }) => {
    try { main.BH_ReceiptDigest(native); } catch { /* suppress an invalid second capture */ }
    return result;
  }]) {
    const h = harness({ onDigest });
    assert(h.invoke('bhStep', 1, 0, 0, undefined, 'once').error);
    assert.equal(h.main.mBH.snapshotReceiptBusy, false); assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
    assert.equal(h.main.mBH.snapshot, undefined); assert.equal(h.captures.length, 1);
  }
});

test('an unconsumed receipt blocks the next step before any new logic, including a legacy request', () => {
  for (const token of [undefined, 'new_lease']) {
    const h = harness();
    assert.equal(h.invoke('bhStep', 1, 0, 0, undefined, 'pending').tick, 1);
    assert(h.main.mBH.snapshotReceiptPending);
    assert(h.invoke('bhStep', 2, 0, 0, undefined, token).error);
    assert.equal(h.main.mcWorld.mTick, 1); assert.equal(h.captures.length, 1);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  }
});

test('wrong receipt attempts consume the lease; absent and already consumed leases are fatal', () => {
  for (const args of [['other', 1, 1], ['pending', 2, 1], ['pending', 1, 2], ['pending', '1', 1], ['pending', 1, 0]]) {
    const h = harness(); h.invoke('bhStep', 1, 0, 0, undefined, 'pending');
    assert(h.invoke('bhStateReceipt', ...args).error);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
    assert(h.invoke('bhStateReceipt', 'pending', 1, 1).error);
  }
  const absent = harness(); assert(absent.invoke('bhStateReceipt', 'absent', 1, 1).error);
  const used = harness(); success(used, 1);
  assert(used.invoke('bhStateReceipt', 'lease_1', 1, 1).error);
});

test('stale epochs never read a newer pending graph even with a reused token', () => {
  const h = harness(); success(h, 1, 'same');
  h.invoke('bhStep', 2, 0, 0, undefined, 'same');
  assert(h.invoke('bhStateReceipt', 'same', 1, 1).error);
  assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  assert(h.invoke('bhStateReceipt', 'same', 2, 2).error);
});

test('snapshot, graph, alias, tick, scope, digest, and byte changes cannot be attested by a pending receipt', () => {
  const mutations = [
    b => { b.snapshot = { ...b.snapshot }; }, b => { b.snapshot.native = { ...b.snapshot.native }; },
    b => { b.snapshot.entities = {}; }, b => { b.snapshot.tick++; }, b => { b.snapshot.scope = 'full'; },
    b => { b.snapshot.digest = 'native-v2-ffffffffffffffff'; }, b => { b.snapshot.snapshotBytes++; },
    b => { b.snapshot.native.tick++; }, b => { b.snapshot.native.scope = 'full'; },
    b => { b.tick++; }, b => { b.state = 'ready'; }, b => { b.snapshotReceiptEpoch++; },
  ];
  for (const mutate of mutations) {
    const h = harness(); h.invoke('bhStep', 1, 0, 0, undefined, 'identity'); mutate(h.main.mBH);
    assert(h.invoke('bhStateReceipt', 'identity', 1, 1).error);
    assert.equal(h.main.mBH.snapshotReceiptPending, undefined);
  }
});

test('a cached legacy read preserves a pending lease while refresh and forceFull invalidate it', () => {
  const h = harness(); h.invoke('bhStep', 1, 0, 0, undefined, 'cached');
  const snapshot = h.main.mBH.snapshot, pending = h.main.mBH.snapshotReceiptPending;
  assert.equal(h.invoke('bhState'), snapshot); assert.equal(h.main.mBH.snapshotReceiptPending, pending);
  assert.equal(h.invoke('bhStateReceipt', 'cached', 1, 1).header.tick, 1);
  for (const args of [[true], [false, true], [true, true]]) {
    const replaced = harness(); replaced.invoke('bhStep', 1, 0, 0, undefined, 'refresh');
    assert(replaced.invoke('bhState', ...args).error);
    assert.equal(replaced.main.mBH.snapshotReceiptPending, undefined);
    assert(replaced.invoke('bhStateReceipt', 'refresh', 1, 1).error);
    assert.equal(replaced.captures.length, 1, 'forbidden refresh must not perform a second projection transfer');
  }
});

test('own future header fields are preserved while inherited fields never enter the receipt', () => {
  const h = harness(); h.invoke('bhStep', 1, 0, 0, undefined, 'headers');
  const snapshot = h.main.mBH.snapshot;
  Object.setPrototypeOf(snapshot, { inherited: 'not an actual own snapshot header' });
  snapshot.futureOptional = undefined;
  const receipt = h.invoke('bhStateReceipt', 'headers', 1, 1);
  assert.equal(receipt.error, undefined);
  assert.equal(Object.hasOwn(receipt.header, 'inherited'), false);
  assert.equal(Object.hasOwn(receipt.header, 'futureOptional'), true);
  assert.equal(receipt.header.futureOptional, undefined);
  assert.equal(receipt.header.futureHeader, snapshot.futureHeader);
});
