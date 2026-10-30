import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, Bitmap, plain, point, movingCommand } from './fixtures/presentation-four-pose-host.mjs';

const mode = 'four-pose-v3';
const four = (f, xs = [2, 6, 10, 14], options = {}) => {
  let result;
  for (let i = 0; i < xs.length; i++) result = f.capture(i + 1, [{ x: xs[i], ...options }]);
  return result;
};

test('four-pose configuration is explicit and all three native response forms bind version3', () => {
  const f = fixture();
  assert.deepEqual(plain(f.configured), { version: 1, ok: true, enabled: true, mode, poseVersion: 3 });
  f.capture(1, [{ x: 2 }]);
  const result = f.main.BH_Present(1), info = f.main.BH_PresentationInfo(false);
  for (const value of [result, info]) { assert.equal(value.mode, mode); assert.equal(value.poseVersion, 3); }
  assert.equal(result.poseTick, 1); assert.equal(info.poseCount, 1);
  assert.equal(Object.hasOwn(info, 'pixelsEqual'), false);
  const before = f.main.mBH.presentation;
  assert.deepEqual(plain(f.main.BH_PresentationConfig(true, mode)), { version: 1, ok: false });
  assert.deepEqual(plain(f.main.BH_PresentationConfig(false, 'four-pose-unknown')), { version: 1, ok: false });
  assert.equal(f.main.mBH.presentation, before);
});

test('three adjacent intervals use latest textures and exact canonical geometry/pixels at alpha1 with one original Draw', () => {
  const f = fixture(), textures = [1, 2, 3, 4].map(color => new Bitmap(2, 2, true, color));
  let captured;
  for (let i = 0; i < 4; i++) captured = f.capture(i + 1, [{ x: 2 + i * 4, bitmap: textures[i] }]);
  const { p, things } = captured, command = movingCommand(p);
  const pixels = f.world.bmDraw.pixels.slice(), nativeCalls = f.world.bmDraw.calls.length;
  const position = plain(things[0].mPosition);
  const counters = [f.main.mBH.tick, f.main.mBH.clock, f.main.mBH.rngCalls, f.main.mBH.logicCalls, f.main.mBH.drawCalls];
  for (const [alpha, x] of [[0, 2], [1 / 6, 4], [1 / 3, 6], [0.5, 8], [2 / 3, 10], [5 / 6, 12], [1, 14]]) {
    const result = f.main.BH_Present(alpha);
    assert.equal(result.rendered, true); assert.equal(result.poseTick, 1 + 3 * alpha);
    assert.deepEqual(point(command), [x, 2]); assert.equal(command.args[0], textures[3]);
    assert.equal(f.world.bmDraw.calls.length, nativeCalls); assert.deepEqual(f.world.bmDraw.pixels, pixels);
  }
  assert.deepEqual(plain(things[0].mPosition), position);
  assert.deepEqual([f.main.mBH.tick, f.main.mBH.clock, f.main.mBH.rngCalls, f.main.mBH.logicCalls, f.main.mBH.drawCalls], counters);
  assert.equal(f.nativeDraws, 4); assert.equal(f.main.BH_PresentationInfo(true).pixelsEqual, true);
  const frames = p.frames; assert.equal(f.main.BH_Present(1).unchanged, true); assert.equal(p.frames, frames);
});

test('four immutable scalar maps rotate without keeping a fifth map or a historical command list', () => {
  const f = fixture(), maps = [];
  for (let tick = 1; tick <= 4; tick++) maps.push(f.capture(tick, [{ x: tick * 2 }]).p.anchors);
  const p = f.main.mBH.presentation, frozen = maps.map(plain), oldCommands = p.commands;
  assert.deepEqual([p.oldest, p.older, p.previous, p.anchors], maps);
  for (const alpha of [0, 0.2, 0.5, 0.9, 1]) f.main.BH_Present(alpha);
  assert.deepEqual(maps.map(plain), frozen);
  for (const map of maps) {
    assert.equal(Object.getPrototypeOf(map), null);
    for (const anchor of Object.values(map)) {
      assert.deepEqual(Object.keys(anchor).sort(), ['x', 'y']);
      assert.equal(typeof anchor.x, 'number'); assert.equal(typeof anchor.y, 'number');
    }
  }
  f.capture(5, [{ x: 10 }]);
  assert.equal(p.oldest, maps[1]); assert.equal(p.older, maps[2]); assert.equal(p.previous, maps[3]);
  assert.equal([p.oldest, p.older, p.previous, p.anchors].includes(maps[0]), false);
  assert.notEqual(p.commands, oldCommands); assert.equal(f.main.BH_PresentationInfo(false).poseCount, 4);
});

test('missing early history holds one real previous pose across both static segments without extra replay', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]);
  const { p } = f.capture(2, [{ x: 6 }]), command = movingCommand(p);
  assert.equal(f.main.BH_Present(0).rendered, true); assert.deepEqual(point(command), [2, 2]);
  const frames = p.frames;
  for (const alpha of [0.1, 1 / 3, 0.5, 2 / 3]) {
    assert.equal(f.main.BH_Present(alpha).unchanged, true); assert.equal(p.frames, frames);
  }
  f.main.BH_Present(5 / 6); assert.deepEqual(point(command), [4, 2]);
  f.main.BH_Present(1); assert.deepEqual(point(command), [6, 2]);
});

test('oldest-only movement survives two stopped intervals and does not count their identical endpoints as frames', () => {
  const f = fixture(), { p } = four(f, [2, 6, 6, 6]), command = movingCommand(p);
  assert.equal(p.oldestMoving, true); assert.equal(p.olderMoving, false); assert.equal(p.newerMoving, false);
  f.main.BH_Present(1 / 6); assert.deepEqual(point(command), [4, 2]);
  f.main.BH_Present(1 / 3); assert.deepEqual(point(command), [6, 2]);
  const frames = p.frames;
  for (const alpha of [0.5, 2 / 3, 0.9, 1]) {
    assert.equal(f.main.BH_Present(alpha).unchanged, true); assert.equal(p.frames, frames);
  }
});

test('every adjacent teleport guard remains local even when cumulative valid movement exceeds64 pixels', () => {
  const f = fixture(), command = movingCommand(four(f, [0, 50, 100, 150]).p);
  for (const [alpha, x] of [[0, 0], [1 / 3, 50], [2 / 3, 100], [1, 150]]) {
    f.main.BH_Present(alpha); assert.deepEqual(point(command), [x, 2]);
  }
  const early = fixture(), earlyCommand = movingCommand(four(early, [0, 100, 104, 108]).p);
  early.main.BH_Present(0); assert.deepEqual(point(earlyCommand), [100, 2]);
  early.main.BH_Present(0.5); assert.deepEqual(point(earlyCommand), [102, 2]);
  const middle = fixture(), middleCommand = movingCommand(four(middle, [0, 4, 100, 104]).p);
  for (const alpha of [0, 1 / 3, 2 / 3]) { middle.main.BH_Present(alpha); assert.deepEqual(point(middleCommand), [100, 2]); }
  const newest = fixture(), newestCommand = movingCommand(four(newest, [0, 4, 8, 100]).p);
  assert.equal(newestCommand.geometry, undefined);
  newest.main.BH_Present(0); assert.deepEqual(point(newestCommand), [100, 2]);
});

test('hidden invincibility poses remain scalar history while current visibility and command ownership remain native', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6, hidden: true }]);
  f.capture(3, [{ x: 10, hidden: true }]); const { p } = f.capture(4, [{ x: 14 }]);
  const command = movingCommand(p);
  for (const [alpha, x] of [[0, 2], [1 / 3, 6], [2 / 3, 10], [1, 14]]) {
    f.main.BH_Present(alpha); assert.deepEqual(point(command), [x, 2]);
  }
  assert.equal(p.commands.length, 2); assert.equal(f.nativeDraws, 4);
});

test('camera rectangles and private matrix translations follow all three intervals without changing native transforms', () => {
  const f = fixture(); let p;
  for (let i = 0; i < 4; i++) ({ p } = f.capture(i + 1, [{ x: 14, matrix: true }], { camera: i * 3 }));
  const camera = p.commands.find(command => command.camera), command = movingCommand(p);
  const original = f.world.bmDraw.calls.filter(call => call.name === 'draw').at(-1).values[1];
  assert.notEqual(command.geometry, original);
  for (const [alpha, cameraX, tx] of [[0, 0, 16], [1 / 3, 3, 13], [2 / 3, 6, 10], [1, 9, 7]]) {
    f.main.BH_Present(alpha); assert.equal(camera.args[1].x, cameraX); assert.equal(camera.args[1].width, 32);
    assert.deepEqual(point(command), [tx, 5]);
    assert.deepEqual([command.geometry.a, command.geometry.b, command.geometry.c, command.geometry.d], [2, 0.25, -0.5, 3]);
    assert.deepEqual([original.tx, original.ty], [7, 5]);
  }
});

test('all four maps retain at most4096 anchors and overflow still invokes original Draw exactly once', () => {
  const f = fixture();
  for (let tick = 1; tick <= 4; tick++) {
    Object.assign(f.main.mBH, { active: true, state: 'playing', stepping: true });
    f.main.BH_PresentationBegin();
    for (let id = 0; id < 4096; id++) f.draw({ id, x: tick, hidden: true });
    f.main.BH_PresentationEnd(tick); Object.assign(f.main.mBH, { tick, stepping: false });
  }
  const p = f.main.mBH.presentation;
  for (const map of [p.oldest, p.older, p.previous, p.anchors]) assert.equal(Object.keys(map).length, 4096);
  p.capturing = true; f.draw({ id: 4096, x: 4, hidden: true });
  assert.equal(f.nativeDraws, 4 * 4096 + 1); assert.equal(f.main.mBH.presentation, undefined);
  assert.match(f.main.mBH.presentationError, /anchor limit/);
  for (const name of ['oldest', 'older', 'previous', 'anchors']) assert.equal(p[name], undefined);
  assert.equal(f.world.bmDraw.copyPixels, Bitmap.prototype.copyPixels);
});

test('discontinuous streams clear every historical map and emit the actual current geometry', () => {
  const f = fixture(); four(f);
  const { p } = f.capture(80, [{ x: 18 }]);
  f.main.BH_Present(0); assert.deepEqual(point(movingCommand(p)), [18, 2]);
  for (const name of ['oldestTick', 'olderTick', 'previousTick']) assert.equal(p[name], undefined);
  assert.equal(f.main.BH_PresentationInfo(false).poseCount, 1); assert.equal(f.nativeDraws, 5);
});

test('disposal restores the canonical target and removes all four scalar maps and transient command ownership', () => {
  const f = fixture(), { p } = four(f); f.main.BH_Present(0.4);
  f.main.BH_PresentationDispose();
  assert.equal(f.main.mBH.presentation, undefined); assert.equal(f.attachments.at(-1)[0], f.world.bmDraw);
  assert.equal(f.world.bmDraw.copyPixels, Bitmap.prototype.copyPixels);
  assert.equal(p.records[0].display.disposed, true);
  for (const name of ['oldest', 'older', 'previous', 'anchors']) assert.equal(p[name], undefined);
  assert.equal(p.commands.length, 0); assert.equal(p.scratch.length, 0);
});

test('receipt/capture/terminal and malformed-alpha guards remain non-coercing before any new v3 work', () => {
  for (const block of [{}, { snapshotReceiptBusy: true }, { snapshotReceiptRequest: {} },
    { snapshotReceiptPending: {} }, { replay: true }, { complete: 'finished' }, { stepping: true }]) {
    const f = fixture(), { p } = four(f); Object.assign(f.main.mBH, block);
    let coerced = 0;
    const alpha = { valueOf() { coerced++; throw new Error('must not coerce alpha'); } };
    const frames = p.frames, updates = f.updates;
    for (const value of [alpha, '0.5', Infinity, NaN, -1, 2]) {
      const result = f.main.BH_Present(value);
      assert.equal(result.rendered, false); assert.equal(result.mode, mode); assert.equal(result.poseVersion, 3);
      assert.equal(Object.hasOwn(result, 'poseTick'), false);
    }
    assert.equal(coerced, 0); assert.equal(p.frames, frames); assert.equal(f.updates, updates);
    if (Object.keys(block).length) {
      const finiteCalls = f.finiteCalls;
      assert.equal(f.main.BH_Present(0.25).rendered, false);
      assert.equal(f.finiteCalls, finiteCalls, 'legacy state guards precede replaceable isFinite');
    }
  }
});

test('existing three-pose mode keeps exactly its old range, version and three-map lifetime', () => {
  const f = fixture('three-pose-v2'), { p } = four(f), command = movingCommand(p);
  assert.equal(p.oldest, undefined);
  for (const [alpha, x] of [[0, 6], [0.5, 10], [1, 14]]) {
    const value = f.main.BH_Present(alpha);
    assert.equal(value.mode, 'three-pose-v2'); assert.equal(value.poseVersion, 2);
    assert.equal(value.poseTick, 2 + 2 * alpha); assert.deepEqual(point(command), [x, 2]);
  }
  assert.equal(f.main.BH_PresentationInfo(false).poseCount, 3);
});
