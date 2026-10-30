import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const candidate = readFileSync(new URL('./proposal/tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
const reversal = JSON.parse(readFileSync(new URL('./source-reversal.json', import.meta.url), 'utf8'));
const bridge = reversal.files.find(row => row.path === 'proposal/tools/original-bridge/CMain.bridge.asinc');
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(candidate), bridge.after.sha256);
let predecessor = candidate;
for (const hunk of [...bridge.hunks].reverse()) {
  assert.equal(predecessor.split(hunk.after).length - 1, 1);
  predecessor = predecessor.replace(hunk.after, hunk.before);
}
assert.equal(sha(predecessor), bridge.before.sha256);

function body(source, name) {
  const start = source.indexOf(`   function ${name}(`);
  assert(start >= 0);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n   (?:static )?function /);
  const method = next < 0 ? rest : rest.slice(0, next + 1);
  return method.slice(method.indexOf('{') + 1, method.lastIndexOf('}'));
}
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(source = candidate, options = {}) {
  const events = [];
  const CMain = { mInput: {}, mInitBGTasks: true, ProcessBGTasks() { events.push('background'); } };
  const native = options.native;
  const globals = { CMain, _global: native === undefined ? {} : { boxheadNativeAnchorMetadataV1: native },
    CSound: { ProcessAll() { events.push('sound'); } }, String,
    getTimer: () => options.now ?? 100,
    DrawPrimitive: { XSI: { CDrawPrimitive_XSI_DI: {
      mRenderStack: [], RenderStack_Finished: () => options.renderReady !== false,
    } } },
  };
  const main = { mBH: { active: true, state: 'loading', tick: 0, clock: 0, started: 0, error: '',
      stepping: false, seed: 17, rng: 17, rngCalls: 0, ...options.bridge },
    mcWorld: { mLoaded: true, mTick: 0, mPaused: false, mArea: { width: 640, height: 480 }, mInitList: [], ...options.world },
    mcScreen: { idScreen: 'Game', mNormal: true },
    State_RunWorld() { throw new Error('loading preparation called original Game/Draw'); },
    BH_MenuBounds: () => ({ x: 1 }), BH_CheckpointAvailable: () => true,
    BH_State(refresh) { assert.equal(refresh, true); events.push('snapshot'); return { tick: this.mBH.tick }; },
    BH_Fail(message) { events.push('error:' + message); this.mBH.state = 'error'; this.mBH.error = message; return this.BH_Info(); },
  };
  main.fState = main.State_RunWorld;
  main.BH_Pump = runInNewContext('(function(){' + body(source, 'BH_Pump') + '\n})', globals);
  main.BH_Info = runInNewContext('(function(){' + body(source, 'BH_Info') + '\n})', globals);
  return { main, events, globals };
}

test('metadata loading absent-native fallback preserves the original ready and snapshot path', () => {
  const before = fixture(predecessor), after = fixture();
  before.main.BH_Pump(); after.main.BH_Pump();
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(plain(after.main.mBH), plain(before.main.mBH));
  assert.deepEqual(plain(after.main.BH_Info()), plain(before.main.BH_Info()));
  assert.deepEqual(after.events, ['snapshot']);
});

test('metadata loading incomplete slices stay at tick zero and copy one completed status', () => {
  const calls = [], stats = Object.freeze({ version: 1, calls: 3, objects: 23, properties: 120,
    cached: 23, skipped: 0, bytes: 1800, workBytes: 48, completed: true, capped: false });
  let warm = 0;
  const f = fixture(candidate, { native(operation) {
    calls.push(operation);
    if (operation === 'prewarm') return ++warm >= 3;
    assert.equal(operation, 'status'); return stats;
  } });
  const unchanged = plain(f.main.mcWorld);
  for (let index = 0; index < 2; index++) {
    f.main.BH_Pump(); assert.equal(f.main.mBH.state, 'loading');
    assert.equal(f.main.mBH.tick, 0); assert.equal(f.main.mBH.rngCalls, 0);
    assert.deepEqual(f.events, []);
    assert.equal(f.main.BH_Info().anchorMetadata, undefined);
  }
  f.main.BH_Pump(); assert.equal(f.main.mBH.state, 'ready');
  assert.equal(f.main.mBH.anchorMetadataStats, stats);
  for (let index = 0; index < 25; index++) {
    assert.equal(f.main.BH_Info().anchorMetadata, stats);
    f.main.BH_Pump();
  }
  assert.deepEqual(calls, ['prewarm', 'prewarm', 'prewarm', 'status']);
  assert.deepEqual(f.events, ['snapshot']);
  assert.deepEqual(plain(f.main.mcWorld), unchanged);
  assert.equal(f.main.mBH.tick, 0); assert.equal(f.main.mBH.rng, 17);
});

test('metadata loading preserves original guards before any preparation or status call', () => {
  for (const options of [
    { world: { mLoaded: false } }, { renderReady: false },
    { world: { mTick: 1 } }, { world: { mPaused: true } },
    { world: { mCompleteState: 'error' } }, { now: 180001 },
    { bridge: { state: 'playing' } },
  ]) {
    const old = fixture(predecessor, options);
    const current = fixture(candidate, { ...options, native() { throw new Error('crossed original loading guard'); } });
    old.main.BH_Pump(); current.main.BH_Pump();
    assert.deepEqual(current.events, old.events);
    assert.deepEqual(plain(current.main.mBH), plain(old.main.mBH));
  }
  for (const transaction of ['mBHStagedStep', 'mBHCompactStep']) {
    const f = fixture(candidate, { native() { throw new Error('prewarm inside pending transaction'); } });
    f.main[transaction] = {};
    f.main.BH_Pump(); assert.deepEqual(f.events, []); assert.equal(f.main.mBH.state, 'loading');
  }
});

test('metadata loading capped or unavailable coverage reaches ready with original fresh-checkpoint fallback', () => {
  for (const stats of [
    { version: 1, calls: 64, objects: 900, properties: 7000, cached: 899, skipped: 1, bytes: 6100000, workBytes: 48, completed: false, capped: true },
    { version: 1, calls: 0, objects: 0, properties: 0, cached: 0, skipped: 0, bytes: 0, workBytes: 0, completed: false, capped: false },
  ]) {
    const calls = [];
    const f = fixture(candidate, { native(operation) { calls.push(operation); return operation === 'prewarm' ? true : stats; } });
    f.main.BH_Pump();
    assert.equal(f.main.mBH.state, 'ready'); assert.deepEqual(f.events, ['snapshot']);
    assert.equal(f.main.BH_Info().anchorMetadata, stats);
    assert.deepEqual(calls, ['prewarm', 'status']);
    assert.equal(f.main.mBH.tick, 0); assert.equal(f.main.mBH.rngCalls, 0);
  }
});
