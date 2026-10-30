import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchClass } from '../../scripts/build-original-swf.mjs';

// Execute the actual helper source with a deliberately small bitmap collaborator.
// This proves method scope/argument/restore behavior, not AVM1 shadowing support,
// native determinism, rendering speed or the real browser acceptance result.
const source = readFileSync(new URL('../../tools/original-bridge/CMain.replay.asinc', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../../tools/original-bridge/CMain.bridge.asinc', import.meta.url), 'utf8');
const receiptGuards = ['BH_ReceiptGuard', 'BH_ReceiptPoison', 'BH_Info'].map(name => {
  const location = bridge.indexOf('function ' + name + '(');
  assert(location >= 0, 'Missing receipt callback guard ' + name);
  const start = bridge.lastIndexOf('\n', location) + 1;
  const next = bridge.slice(location).search(/\n   (?:static )?(?:function|var) /);
  return bridge.slice(start, next < 0 ? undefined : location + next);
}).join('\n');
const methods = ['copyPixels', 'draw', 'fillRect', 'applyFilter'];

class BitmapFixture {
  constructor(label) { this.label = label; this.width = 640; this.height = 480; this.calls = []; }
  record(method, values) { this.calls.push({ receiver: this, method, values: [...values] }); return `${this.label}:${method}:${values.length}`; }
  copyPixels(...values) { return this.record('copyPixels', values); }
  draw(...values) { return this.record('draw', values); }
  fillRect(...values) { return this.record('fillRect', values); }
  applyFilter(...values) { return this.record('applyFilter', values); }
  hitTest(...values) { this.record('hitTest', values); return this.hitResult ?? true; }
}

class PointFixture {
  constructor(x, y) { this.x = x; this.y = y; }
}

class RectangleFixture {
  constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
}

function fixture(overrides = {}, split = true) {
  const callbacks = {};
  const focus = { current: null };
  const CMain = runInNewContext('(class CMain {' + (source + '\n' + receiptGuards)
    .replace(/static function ([A-Za-z_][A-Za-z_0-9]*)\(/g, 'static $1(')
    .replace(/function ([A-Za-z_][A-Za-z_0-9]*)\(/g, '$1(') + '})', {
    flash: { display: { BitmapData: BitmapFixture }, geom: { Point: PointFixture, Rectangle: RectangleFixture }, external: { ExternalInterface: {
      available: true, addCallback(name, receiver, method) { callbacks[name] = () => method.call(receiver); return true; },
    } } }, Selection: { getFocus: () => focus.current }, Error,
  });
  const main = new CMain();
  CMain._this = main;
  main.mBH = { active: true, state: 'loading', tick: 0, stepping: false, cache: false,
    initialPlayers: 1, playerCount: 1, localSlot: 2, personalProgression: true,
    replay: true, replayInstalled: false, replayRestored: false, replaySkipped: 0, replayTargets: [], ...overrides };
  main.mcWorld = { _visible: true, bmDraw: new BitmapFixture('world'), bmFloor: new BitmapFixture('floor'),
    bmCover: new BitmapFixture('cover'), bmDecalMask: new BitmapFixture('mask') };
  if (split) main.mcWorld.mSplitScreen = { bmDraw: new BitmapFixture('split') };
  main.BH_Fail = (message) => { main.mBH.state = 'error'; main.mBH.error = message; return { error: message }; };
  return { CMain, main, world: main.mcWorld, callbacks, focus };
}

test('history hides only the actual world and restores its exact boolean before removing wrappers', () => {
  for (const saved of [true, false]) {
    const { main, world, callbacks } = fixture();
    world._visible = saved;
    let draw = BitmapFixture.prototype.draw;
    const restoredVisibility = [];
    Object.defineProperty(world.bmDraw, 'draw', { configurable: true,
      get: () => draw, set: value => {
        if (value === BitmapFixture.prototype.draw) restoredVisibility.push(world._visible);
        draw = value;
      } });
    main.BH_ReplayRegister(); main.BH_ReplayInstall(world);
    assert.equal(world._visible, false);
    const info = callbacks.bhReplayInfo();
    assert.deepEqual({ ...info.worldVisibility }, { saved, current: false, worldMatches: true,
      installed: true, restored: false, focusUnchanged: true });
    assert.equal(JSON.stringify(callbacks.bhReplayInfo()), JSON.stringify(info), 'diagnostic must remain read-only');
    main.mBH.stepping = true; main.BH_ReplayFinish();
    assert.deepEqual(restoredVisibility, [saved], 'visibility must be restored before any wrapper removal');
    assert.equal(world._visible, saved);
    assert.deepEqual({ ...callbacks.bhReplayInfo().worldVisibility }, { saved, current: saved, worldMatches: true,
      installed: false, restored: true, focusUnchanged: true });
    main.BH_ReplayFinish();
    assert.deepEqual(restoredVisibility, [saved], 'live calls must not repeat the restoration');
  }
});

test('membership replay remains installed through historical joins until the explicit solo boundary', () => {
  const { main, world } = fixture({ membershipVersion: 1 });
  main.BH_ReplayInstall(world);
  main.mBH.stagedStepVersion = 1; main.mBH.compactStepVersion = 1;
  let restoredWithReplay;
  const restore = main.BH_ReplayRestore;
  main.BH_ReplayRestore = function(...args) {
    const result = restore.apply(this, args);
    restoredWithReplay = this.mBH.replay;
    return result;
  };
  main.mcScreen = { idScreen: 'Screen_Main', mNormal: true };
  main.BH_MenuBounds = () => ({});
  main.BH_CheckpointAvailable = () => false;
  main.mBH.error = ''; main.mBH.state = 'playing'; main.mBH.tick = 9;
  assert.equal(main.BH_Info().stagedStepVersion, undefined);
  assert.equal(main.BH_Info().compactStepVersion, undefined);
  main.mBH.state = 'playing';
  main.mBH.tick = 9;
  main.mBH.playerCount = 2;
  assert.deepEqual({ ...main.BH_ReplayEnd(9) }, { error: 'invalid historical boundary' });
  assert.equal(world._visible, false);
  main.mBH.state = 'playing';
  main.mBH.playerCount = 1;
  const info = main.BH_ReplayEnd(9);
  assert.equal(info.tick, 9); assert.equal(info.state, 'playing');
  assert.equal(info.stagedStepVersion, 1); assert.equal(info.compactStepVersion, 1);
  assert.equal(restoredWithReplay, true, 'boundary restores first and only then clears replay');
  assert.equal(world._visible, true);
  assert.equal(main.mBH.replay, false);
});

test('v2 replay covers the initial two-player world until its verified solo boundary', () => {
  const { main, world } = fixture({ membershipVersion: 2, initialPlayers: 2, playerCount: 2 });
  main.BH_ReplayInstall(world);
  main.mBH.state = 'playing'; main.mBH.tick = 12;
  assert.equal(world._visible, false);
  assert.match(main.BH_ReplayEnd(12).error, /invalid historical boundary/);
  assert.equal(world._visible, false);
  main.mBH.state = 'playing'; main.mBH.playerCount = 1;
  main.mcScreen = { idScreen: 'Screen_Main', mNormal: true };
  main.BH_MenuBounds = () => ({}); main.BH_CheckpointAvailable = () => false;
  assert.equal(main.BH_ReplayEnd(12).tick, 12);
  assert.equal(world._visible, true);
  assert.equal(main.mBH.replay, false);
});

test('a failed boundary restoration keeps replay active and fails closed', () => {
  const { main, world } = fixture({ membershipVersion: 1 });
  main.BH_ReplayInstall(world); main.mBH.state = 'playing'; main.mBH.tick = 4;
  world.bmDraw.draw = () => {};
  assert.match(main.BH_ReplayEnd(4).error, /historical boundary restoration/);
  assert.equal(main.mBH.replay, true);
  assert.equal(main.mBH.state, 'error');
});

test('membership replay boundary requires the exact tick and no outstanding receipt', () => {
  for (const change of [main => { main.mBH.tick = 2; }, main => { main.mBH.snapshotReceiptPending = {}; },
    main => { main.mBH.stepping = true; }]) {
    const { main, world } = fixture({ membershipVersion: 1 });
    main.BH_ReplayInstall(world);
    main.mBH.state = 'playing'; main.mBH.tick = 1;
    change(main);
    assert.match(main.BH_ReplayEnd(1).error, /invalid historical boundary/);
    assert.equal(world._visible, false);
  }
});

test('unknown visibility and existing native focus reject hiding before any scene mutation', () => {
  for (const initial of [undefined, 1, 'true']) {
    const { main, world } = fixture();
    world._visible = initial;
    assert.throws(() => main.BH_ReplayInstall(world), /world visibility is unavailable/);
    assert.equal(world._visible, initial); assert.equal(main.mBH.state, 'error');
    for (const method of methods) assert.equal(Object.hasOwn(world.bmDraw, method), false);
  }
  const { main, world, focus } = fixture();
  focus.current = '_level0._World';
  let writes = 0;
  Object.defineProperty(world, '_visible', { get: () => true, set: () => { writes++; } });
  assert.throws(() => main.BH_ReplayInstall(world), /requires no native focus/);
  assert.equal(writes, 0); assert.equal(focus.current, '_level0._World');
  assert.equal(main.mBH.state, 'error');
  for (const method of methods) assert.equal(Object.hasOwn(world.bmDraw, method), false);
});

test('a rejected visibility setter cleans up installed wrappers and never enables replay', () => {
  const { main, world } = fixture();
  Object.defineProperty(world, '_visible', { get: () => true, set: () => {} });
  assert.throws(() => main.BH_ReplayInstall(world), /visibility installation failed/);
  assert.equal(world._visible, true); assert.equal(main.mBH.state, 'error');
  assert.equal(main.mBH.replay, false); assert.equal(main.mBH.replayInstalled, false);
  for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
    for (const method of methods) {
      assert.equal(target[method], BitmapFixture.prototype[method]);
      assert.equal(Object.hasOwn(target, method), false);
    }
  }
});

test('a visibility setter that unexpectedly changes focus fails closed and restores visibility and wrappers', () => {
  const { main, world, focus } = fixture();
  let visible = true;
  Object.defineProperty(world, '_visible', { get: () => visible, set: value => {
    visible = value;
    if (value === false) focus.current = '_unexpected';
  } });
  assert.throws(() => main.BH_ReplayInstall(world), /visibility installation failed/);
  assert.equal(world._visible, true); assert.equal(main.mBH.state, 'error');
  assert.equal(main.mBH.replay, false); assert.equal(main.mBH.replayInstalled, false);
  assert.equal(main.BH_ReplayInfo().worldVisibility.focusUnchanged, false);
  assert.equal(focus.current, '_unexpected', 'cleanup must not invent an original focus restoration');
  for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
    for (const method of methods) assert.equal(target[method], BitmapFixture.prototype[method]);
  }
});

test('changed world identity, visibility and a rejected restore stop before wrapper removal', () => {
  for (const change of ['world', 'visibility', 'restore']) {
    const { main, world } = fixture();
    main.BH_ReplayInstall(world); main.mBH.stepping = true;
    if (change === 'world') main.mcWorld = { ...world };
    if (change === 'visibility') world._visible = true;
    if (change === 'restore') Object.defineProperty(world, '_visible', { get: () => false, set: () => {} });
    assert.throws(() => main.BH_ReplayFinish(), /world (identity|visibility).*restoration/);
    assert.equal(main.mBH.replay, false);
    for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
      for (const method of methods) assert.equal(Object.hasOwn(target, method), true,
        'failed visibility restoration must stop before wrapper removal and spawn');
    }
  }
});

test('historical wrappers forward draw and sprite copies exactly once while only canonical background copies and transient fills/filters skip', () => {
  const { main, world } = fixture();
  main.BH_ReplayInstall(world);
  main.mBH.state = 'ready'; main.mBH.stepping = true;
  const evaluated = [];
  const sprite = new BitmapFixture('sprite');
  const argument = (index) => { evaluated.push(index); return index === 1 ? sprite : index === 2 ? undefined : { index }; };
  for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
    for (const method of methods) {
      const before = target.calls.length;
      const values = [argument(1), argument(2), argument(3)];
      if (method === 'copyPixels') values.push(undefined, undefined, true);
      const result = target[method](...values);
      const forwarded = method === 'draw' || method === 'copyPixels';
      assert.equal(result, forwarded ? `${target.label}:${method}:${values.length}` : undefined);
      assert.equal(target.calls.length, before + (forwarded ? 1 : 0));
      if (forwarded) {
        const call = target.calls[before];
        assert.equal(call.receiver, target);
        assert.equal(call.method, method);
        assert.equal(call.values.length, values.length);
        for (let index = 0; index < values.length; index++) assert.equal(call.values[index], values[index]);
      }
    }
    for (const background of [world.bmFloor, world.bmCover]) {
      const before = target.calls.length;
      assert.equal(target.copyPixels(background, { width: 640 }, { x: 0, y: 0 }, undefined, undefined, background === world.bmCover), undefined);
      assert.equal(target.calls.length, before, 'only the two background presentation copies are suppressed');
    }
  }
  assert.deepEqual(evaluated, Array.from({ length: 8 }, () => [1, 2, 3]).flat());
  const info = main.BH_ReplayInfo();
  assert.equal(info.skipped, 8);
  for (const target of info.targets) {
    for (const method of methods) {
      const forwarded = method === 'draw' || method === 'copyPixels';
      assert.equal(target.methods[method].skipped, method === 'draw' ? 0 : method === 'copyPixels' ? 2 : 1);
      assert.equal(target.methods[method].forwarded, forwarded ? 1 : 0);
    }
  }
  for (const target of [world.bmFloor, world.bmCover, world.bmDecalMask]) {
    for (const method of methods) {
      assert.equal(target[method], BitmapFixture.prototype[method]);
      assert.equal(target.hasOwnProperty(method), false);
      assert.equal(target[method]('persistent'), `${target.label}:${method}:1`);
    }
  }
});

test('background copies with a mask, another merge mode or omitted arguments keep their native source reads', () => {
  const { main, world } = fixture({}, false);
  main.BH_ReplayInstall(world); main.mBH.stepping = true;
  const rectangle = { width: 640 }, point = { x: 0, y: 0 };
  const calls = [
    [world.bmFloor, rectangle, point, undefined, undefined, true],
    [world.bmCover, rectangle, point, undefined, undefined, false],
    [world.bmFloor, rectangle, point, world.bmDecalMask, point, false],
    [world.bmCover, rectangle, point],
    [world.bmDecalMask, rectangle, point, undefined, undefined, true],
  ];
  for (const values of calls) {
    const before = world.bmDraw.calls.length;
    assert.equal(world.bmDraw.copyPixels(...values), `world:copyPixels:${values.length}`);
    assert.equal(world.bmDraw.calls.length, before + 1);
    const call = world.bmDraw.calls[before];
    assert.equal(call.receiver, world.bmDraw);
    assert.equal(call.values.length, values.length);
    for (let index = 0; index < values.length; index++) assert.equal(call.values[index], values[index]);
  }
  assert.equal(main.BH_ReplayInfo().skipped, 0);
});

test('non-commanded, cache and obsolete-target calls retain exact native receiver, arguments and return value', () => {
  const { main, world } = fixture({}, false);
  main.BH_ReplayInstall(world);
  const target = world.bmDraw;
  const reference = world.bmFloor;
  assert.equal(target.copyPixels(reference, undefined, 7, undefined, undefined, false), 'world:copyPixels:6');
  assert.equal(target.calls[0].receiver, target);
  assert.deepEqual(target.calls[0].values, [reference, undefined, 7, undefined, undefined, false]);
  main.mBH.stepping = true; main.mBH.cache = true;
  assert.equal(target.draw(), 'world:draw:0');
  assert.equal(target.copyPixels(world.bmCover, {}, {}, undefined, undefined, true), 'world:copyPixels:6');
  main.mBH.cache = false;
  world.bmDraw = new BitmapFixture('replacement');
  assert.equal(target.fillRect(null, 0), 'world:fillRect:2');
  assert.equal(main.BH_ReplayInfo().skipped, 0);
});

test('the real spawn boundary restores original instance/prototype methods before subsequent drawing', () => {
  const { main, world } = fixture();
  const ownDraw = function (...values) { return this.record('ownDraw', values); };
  world.bmDraw.draw = ownDraw;
  main.BH_ReplayInstall(world);
  main.mBH.state = 'playing'; main.mBH.stepping = true;
  assert.equal(world.bmDraw.copyPixels(world.bmFloor, {}, {}, undefined, undefined, false), undefined);
  assert.equal(world.bmDraw.draw('historical'), 'world:ownDraw:1');
  assert.equal(world.bmDraw.calls.length, 1);
  assert.deepEqual(world.bmDraw.calls[0].values, ['historical']);
  main.BH_ReplayFinish();
  const info = main.BH_ReplayInfo();
  assert.equal(info.enabled, false); assert.equal(info.installed, false); assert.equal(info.restored, true);
  for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
    for (const method of methods) {
      const own = target === world.bmDraw && method === 'draw';
      assert.equal(target[method], own ? ownDraw : BitmapFixture.prototype[method]);
      assert.equal(target.hasOwnProperty(method), own);
    }
  }
  assert.equal(world.bmDraw.draw('spawn'), 'world:ownDraw:1');
  assert.equal(world.bmDraw.calls.length, 2);
  assert.deepEqual(world.bmDraw.calls[1].values, ['spawn']);
  assert.equal(main.BH_ReplayInfo().skipped, 1, 'live rendering must not pass through suppression');
});

test('host/offline paths never install per-write wrappers', () => {
  for (const overrides of [{ replay: false, localSlot: 1 }, { replay: false, active: false }]) {
    const { main, world } = fixture(overrides);
    main.BH_ReplayInstall(world); main.BH_ReplayFinish();
    for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
      for (const method of methods) {
        assert.equal(target[method], BitmapFixture.prototype[method]);
        assert.equal(target.hasOwnProperty(method), false);
      }
    }
    assert.equal(main.BH_ReplayInfo().targets.length, 0);
  }
});

test('wrong membership, persistent aliases and a changed wrapper fail closed', () => {
  for (const overrides of [{ localSlot: 1 }, { initialPlayers: 2 }, { personalProgression: false }, { stepping: true }]) {
    const { main, world } = fixture(overrides);
    assert.throws(() => main.BH_ReplayInstall(world), /invalid historical/);
    assert.equal(world.bmDraw.copyPixels, BitmapFixture.prototype.copyPixels);
  }
  const alias = fixture(); alias.world.bmDraw = alias.world.bmFloor;
  assert.throws(() => alias.main.BH_ReplayInstall(alias.world), /isolated transient/);
  const changed = fixture(); changed.main.BH_ReplayInstall(changed.world);
  changed.main.mBH.stepping = true;
  changed.world.bmDraw.draw = () => {};
  assert.throws(() => changed.main.BH_ReplayFinish(), /changed before restoration/);
  assert.equal(changed.main.mBH.replay, false);
});

test('unsupported method shadowing refuses the feature and restores any earlier installed methods', () => {
  const { main, world } = fixture();
  Object.defineProperty(world.mSplitScreen.bmDraw, 'draw', { value: BitmapFixture.prototype.draw, writable: false });
  assert.throws(() => main.BH_ReplayInstall(world));
  for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
    for (const method of methods) assert.equal(target[method], BitmapFixture.prototype[method]);
  }
  assert.equal(main.mBH.replay, false); assert.equal(main.mBH.replayInstalled, false);
  assert.equal(main.mBH.state, 'error'); assert.match(main.mBH.error, /historical presentation installation/);
});

test('an assigned wrapper is restored even when the native own-slot proof rejects it', () => {
  const { main, world } = fixture({}, false);
  // Model a native property surface that resolves the assigned method but
  // cannot confirm an own slot. This must reject the feature without leaving
  // the failed assignment behind; it is not a supported-shadowing fixture.
  world.bmDraw.hasOwnProperty = () => false;
  assert.throws(() => main.BH_ReplayInstall(world), /shadowing unavailable/);
  for (const method of methods) {
    assert.equal(world.bmDraw[method], BitmapFixture.prototype[method]);
    assert.equal(Object.hasOwn(world.bmDraw, method), false);
  }
  assert.equal(main.mBH.replay, false); assert.equal(main.mBH.replayInstalled, false);
  assert.equal(main.mBH.state, 'error');
});

test('an asynchronous installation failure stays native-error even if cleanup itself rejects an unknown method', () => {
  const { main, world } = fixture({}, false);
  let actual = BitmapFixture.prototype.draw;
  const unexpected = function () {};
  Object.defineProperty(world.bmDraw, 'draw', { configurable: true,
    get: () => actual, set: () => { actual = unexpected; } });
  assert.throws(() => main.BH_ReplayInstall(world), /changed before restoration/);
  assert.equal(actual, unexpected, 'cleanup must not overwrite an unknown method');
  assert.equal(main.mBH.state, 'error');
  assert.match(main.mBH.error, /historical presentation installation/);
  assert.equal(main.mBH.replay, false);
});

test('the additive diagnostic callback is read-only and exposes actual wrapper identity', () => {
  const { main, world, callbacks } = fixture();
  main.BH_ReplayRegister(); main.BH_ReplayInstall(world);
  const before = JSON.stringify(main.BH_ReplayInfo());
  assert.equal(JSON.stringify(callbacks.bhReplayInfo()), before);
  assert.equal(JSON.stringify(callbacks.bhReplayInfo()), before);
  for (const target of callbacks.bhReplayInfo().targets) {
    for (const method of Object.values(target.methods)) {
      assert.equal(method.installed, true); assert.equal(method.wrapped, true); assert.equal(method.original, false);
    }
  }
});

test('builder installs the guest-only wrappers after native cache preparation without replacing Draw bodies', () => {
  const original = `class World.CWorld {
 function CWorld() { if(failed) { this.onEnterFrame = this.InitFinished; } }
 function InitDrawPlanes() { this.attachBitmap(this.bmDraw,this.getNextHighestDepth(),"always",false); }
 function Dispose() { this.bmDraw.dispose(); }
 function Draw_PlayerPlane(tIndex, t_bmDraw) { var _loc3_ = this.Process_Tracking(tIndex); }
 function Seed() { scidd.Math.CRandom.SetSeed(0); }
 function ProcessAmbience() {}
 function InitThings() { if(World.CWorld.mGameMode != "Single") { this.Spawn_Player_Other(1); } }
 function InitCleanUp() {
      this.Process();
      this.Draw();
      this.mUpgrades.SetDifficulty(CMain.mSaveData.mDifficulty);
      if(World.CWorld.mGameMode == "DeathMatch") {
         for(var _loc2_ in this.mThing_Collection.mPlayerThings) {
            this.mThing_Collection.mPlayerThings[_loc2_].ResetWeapons();
         }
      }
      this.onEnterFrame = this.InitFinished;
 }
 function Process() { this.mUpgrades.Process(); }
 function LogKill(tThing) { return tThing.mScore * this.mUpgrades.mMultiplier; }
 function Draw() {
   var _loc5_;
   if(World.CWorld.mGameMode == "DeathMatch") { _loc5_ = this.mSplitScreen.mMatrix; }
   this.Draw_PlayerPlane(undefined,this.bmDraw);
   this.mHud.Draw(this.bmDraw);
   this.bmDraw.copyPixels(source(), rectangle(), point());
 }
}`;
  const patched = patchClass('World/CWorld', original, '', '').source;
  assert.match(patched, /if\(CMain\.BH_Active\(\) && CMain\._this\.mBH\.replay == true\) CMain\._this\.BH_ReplayInstall\(this\);\s+this\.onEnterFrame = this\.InitFinished;/);
  assert.ok(patched.includes('this.bmDraw.copyPixels(source(), rectangle(), point());'), 'original argument evaluation must remain untouched');
  assert.ok(patched.includes('function CWorld() { if(failed) { this.onEnterFrame = this.InitFinished; } }'), 'constructor failure handling must remain untouched');
  assert.ok(patched.includes('if(!CMain.BH_EnterWorld("draw")) { return; }'));
});

test('canonical sprite copies preserve a native source read on every call and leave Draw unchanged', () => {
  const { main, world } = fixture();
  main.BH_ReplayInstall(world); main.mBH.stepping = true;
  const sprite = new BitmapFixture('sprite');
  sprite.width = 59; sprite.height = 30;
  const rectangle = new RectangleFixture(0, 0, sprite.width, sprite.height);
  const points = [new PointFixture(20, 30), new PointFixture(-12.5, 470.75), new PointFixture(700, 600)];
  const evaluated = [];
  const argument = (value, index) => { evaluated.push(index); return value; };
  for (const target of [world.bmDraw, world.mSplitScreen.bmDraw]) {
    for (let index = 0; index < points.length; index++) {
      sprite.hitResult = index < 2;
      const before = sprite.calls.length;
      assert.equal(target.copyPixels(argument(sprite, 0), argument(rectangle, 1), argument(points[index], 2),
        argument(undefined, 3), argument(undefined, 4), argument(true, 5)), undefined);
      assert.equal(target.calls.length, 0, 'only the transient pixel write is omitted');
      assert.equal(sprite.calls.length, before + 1, 'readback must not be cached by source identity');
      const read = sprite.calls[before];
      assert.equal(read.method, 'hitTest'); assert.equal(read.receiver, sprite);
      assert.equal(read.values.length, 3); assert.equal(read.values[0], points[index]); assert.equal(read.values[1], 0);
      assert.deepEqual({ ...read.values[2] }, { x: 0, y: 0, width: target.width, height: target.height });
    }
    const matrix = { a: 1, d: 1 }, transform = { alphaMultiplier: 0.4 };
    assert.equal(target.draw(sprite, matrix, transform), `${target.label}:draw:3`);
    assert.equal(target.calls.length, 1);
    assert.deepEqual(target.calls[0].values, [sprite, matrix, transform]);
  }
  assert.deepEqual(evaluated, Array.from({ length: 6 }, () => [0, 1, 2, 3, 4, 5]).flat());
  const info = main.BH_ReplayInfo();
  assert.equal(info.skipped, 6);
  for (const target of info.targets) {
    assert.equal(target.sourceReads, 3); assert.equal(target.methods.copyPixels.skipped, 3);
    assert.equal(target.methods.copyPixels.forwarded, 0); assert.equal(target.methods.draw.forwarded, 1);
  }
  main.BH_ReplayFinish();
  assert.equal(world.bmDraw.copyPixels(sprite, rectangle, points[0], undefined, undefined, true), 'world:copyPixels:6');
  assert.equal(sprite.calls.length, 6, 'live copies must not pass through the replay source read');
});

test('partial, masked, aliased, non-native and unsafe-coordinate sprite copies retain exact native calls', () => {
  const { main, world } = fixture({}, false);
  main.BH_ReplayInstall(world); main.mBH.stepping = true;
  const sprite = new BitmapFixture('sprite'), custom = new BitmapFixture('custom');
  custom.hitTest = () => { throw new Error('custom hitTest must never execute'); };
  const rect = new RectangleFixture(0, 0, sprite.width, sprite.height), point = new PointFixture(4, 5);
  const inherited = Object.create(PointFixture.prototype);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(PointFixture.prototype), { x: 4, y: 5 }));
  const calls = [
    [sprite, new RectangleFixture(1, 0, sprite.width - 1, sprite.height), point, undefined, undefined, true],
    [sprite, rect, point, world.bmDecalMask, point, true],
    [sprite, rect, point, undefined, undefined, false],
    [sprite, rect, point],
    [world.bmDraw, rect, point, undefined, undefined, true],
    [world.bmDecalMask, rect, point, undefined, undefined, true],
    [world.bmFloor, rect, point, undefined, undefined, true],
    [custom, rect, point, undefined, undefined, true],
    [sprite, { ...rect }, point, undefined, undefined, true],
    [sprite, rect, { ...point }, undefined, undefined, true],
    [sprite, rect, inherited, undefined, undefined, true],
    ...[NaN, Infinity, -Infinity, 1073741824, -1073741824].map(x =>
      [sprite, rect, new PointFixture(x, 0), undefined, undefined, true]),
  ];
  for (const values of calls) {
    const before = world.bmDraw.calls.length;
    assert.equal(world.bmDraw.copyPixels(...values), `world:copyPixels:${values.length}`);
    assert.equal(world.bmDraw.calls.length, before + 1);
    const call = world.bmDraw.calls[before];
    assert.equal(call.receiver, world.bmDraw); assert.deepEqual(call.values, values);
  }
  assert.equal(sprite.calls.length, 0); assert.equal(custom.calls.length, 0);
  assert.equal(main.BH_ReplayInfo().targets[0].sourceReads, 0);
});

test('sprite source readback stays scoped to active history and rejects non-boolean native results', () => {
  const { main, world } = fixture({}, false);
  main.BH_ReplayInstall(world);
  const sprite = new BitmapFixture('sprite'), rect = new RectangleFixture(0, 0, sprite.width, sprite.height);
  const values = [sprite, rect, new PointFixture(0, 0), undefined, undefined, true];
  assert.equal(world.bmDraw.copyPixels(...values), 'world:copyPixels:6');
  main.mBH.stepping = true; main.mBH.cache = true;
  assert.equal(world.bmDraw.copyPixels(...values), 'world:copyPixels:6');
  assert.equal(sprite.calls.length, 0);
  main.mBH.cache = false; sprite.hitResult = -1;
  assert.throws(() => world.bmDraw.copyPixels(...values), /sprite source readback failed/);
  assert.equal(world.bmDraw.calls.length, 2, 'failure cannot be accepted as a suppressed native call');
  assert.equal(main.BH_ReplayInfo().skipped, 0);
  assert.equal(main.BH_ReplayInfo().targets[0].sourceReads, 0);
});
