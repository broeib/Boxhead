import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../tools/original-bridge/CMain.presentation.asinc', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const mode = 'three-pose-v2';

class Point {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
}
class Rectangle {
  constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height }); }
}
class Matrix {
  constructor(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) { Object.assign(this, { a, b, c, d, tx, ty }); }
}
class ColorTransform {
  constructor(redMultiplier = 1, greenMultiplier = 1, blueMultiplier = 1, alphaMultiplier = 1,
    redOffset = 0, greenOffset = 0, blueOffset = 0, alphaOffset = 0) {
    Object.assign(this, { redMultiplier, greenMultiplier, blueMultiplier, alphaMultiplier,
      redOffset, greenOffset, blueOffset, alphaOffset });
  }
}

// Small copy/fill collaborator, not an AVM1 renderer, blend/filter emulator or
// browser pixel qualification. Actual source bodies run without transforming
// their geometry, capture order, state guards or lifecycle decisions. Arrays
// are passed directly to BH_PresentationWrite, matching AVM1 arguments arrays.
class Bitmap {
  constructor(width = 32, height = 16, transparent = true, color = 0) {
    Object.assign(this, { width, height, transparent, calls: [], disposed: false });
    this.pixels = new Array(width * height).fill(color);
  }
  get rectangle() { return new Rectangle(0, 0, this.width, this.height); }
  record(name, values) {
    this.calls.push({ name, receiver: this, values: [...values], geometry: values.map(value =>
      value instanceof Point || value instanceof Rectangle || value instanceof Matrix ? { ...value } : value) });
  }
  copyPixels(source, rectangle, point, ...rest) {
    this.record('copyPixels', [source, rectangle, point, ...rest]);
    const pixels = source.pixels.slice();
    for (let y = 0; y < rectangle.height; y++) for (let x = 0; x < rectangle.width; x++) {
      const sx = Math.trunc(rectangle.x + x), sy = Math.trunc(rectangle.y + y);
      const dx = Math.trunc(point.x + x), dy = Math.trunc(point.y + y);
      if (sx >= 0 && sx < source.width && sy >= 0 && sy < source.height
        && dx >= 0 && dx < this.width && dy >= 0 && dy < this.height) {
        this.pixels[dy * this.width + dx] = pixels[sy * source.width + sx];
      }
    }
  }
  fillRect(rectangle, color) {
    this.record('fillRect', [rectangle, color]);
    for (let y = Math.max(0, rectangle.y); y < Math.min(this.height, rectangle.y + rectangle.height); y++) {
      for (let x = Math.max(0, rectangle.x); x < Math.min(this.width, rectangle.x + rectangle.width); x++) {
        this.pixels[y * this.width + x] = color;
      }
    }
  }
  draw(source, matrix, ...rest) { this.record('draw', [source, matrix, ...rest]); }
  applyFilter(...values) { this.record('applyFilter', values); }
  compare(other) { return this.pixels.every((pixel, index) => pixel === other.pixels[index]) ? 0 : 1; }
  dispose() { this.disposed = true; }
}

function fixture(requestedMode = mode) {
  let updates = 0, nativeDraws = 0, finiteCalls = 0;
  // Object() is a bare dictionary in the pinned AVM1 implementation. In
  // particular, a history map must not assume a hasOwnProperty method exists.
  function AS2Object() { return Object.create(null); }
  const CMain = runInNewContext('(class CMain {\n' + source
    .replace(/static function (BH_\w+)\(/g, 'static $1(')
    .replace(/(?<!static )function (BH_\w+)\(/g, '$1(') + '\n})', {
    Object: AS2Object, Array, Error, Math, String, Number,
    isFinite(value) { finiteCalls++; return Number.isFinite(value); },
    flash: { display: { BitmapData: Bitmap }, geom: { Point, Rectangle, Matrix, ColorTransform } },
    updateAfterEvent() { updates++; },
    World: { CWorld: { zPoint: new Point() }, Map: { CMap_Cell: { mSize: { x: 1, y: 1 } } } },
    Thing: { Math: { CThing_Position: { mPFactor: 1 } } },
  });
  const main = new CMain(); CMain._this = main;
  CMain.BH_Active = () => main.mBH.active === true;
  const attachments = [];
  const world = { bmDraw: new Bitmap(), bmFloor: new Bitmap(64, 16, false, 7), bmCover: new Bitmap(64, 16),
    mDrawPosition: { x: 0, y: 0 }, attachBitmap(...args) { attachments.push(args); } };
  main.mcWorld = world;
  main.mBH = { active: false, state: 'menu', tick: 0, clock: 0, rngCalls: 0, logicCalls: 0, drawCalls: 0,
    presentationTarget: { world, depth: 4 } };
  const configured = requestedMode === undefined ? main.BH_PresentationConfig(true)
    : main.BH_PresentationConfig(true, requestedMode);
  const write = (name, values) => main.BH_PresentationWrite(world.bmDraw, name, values);
  const draw = (item) => {
    const { id = 1, x, y = 2, hidden = false, bitmap = new Bitmap(2, 2, true, 9), matrix = false } = item;
    const thing = { mUniqueID: id, mPosition: { mX: x, mY: y, mZ: 0 }, mWorld: world,
      Draw() {
        nativeDraws++;
        if (hidden) return;
        const screenX = x - world.mDrawPosition.x;
        if (matrix) write('draw', [bitmap, new Matrix(2, 0.25, -0.5, 3, screenX + 2, y + 3), new ColorTransform()]);
        else write('copyPixels', [bitmap, bitmap.rectangle, new Point(screenX, y), undefined, undefined, true]);
      } };
    CMain.BH_PresentationDrawThing(thing);
    return thing;
  };
  return { main, CMain, world, configured, attachments, draw, write,
    get nativeDraws() { return nativeDraws; }, get updates() { return updates; },
    get finiteCalls() { return finiteCalls; },
    capture(tick, items, { camera } = {}) {
      Object.assign(main.mBH, { active: true, state: 'playing', stepping: true });
      world.mDrawPosition.x = camera ?? 0;
      main.BH_PresentationBegin();
      write('fillRect', [world.bmDraw.rectangle, 0]);
      if (camera !== undefined) write('copyPixels', [world.bmFloor,
        new Rectangle(camera, 0, 32, 16), new Point(), undefined, undefined, false]);
      const things = items.map(draw);
      main.BH_PresentationEnd(tick);
      Object.assign(main.mBH, { tick, clock: tick * 40, stepping: false });
      return { p: main.mBH.presentation, things };
    },
  };
}

const movingCommand = p => p.commands.find(command => command.key?.includes('/thing/'));
const point = command => command.matrix ? [command.geometry?.tx, command.geometry?.ty]
  : [command.geometry?.x ?? command.args[2]?.x, command.geometry?.y ?? command.args[2]?.y];

test('three-pose mode requires explicit configuration and reports its version in Config, Present and Info', () => {
  const f = fixture();
  assert.deepEqual(plain(f.configured), { version: 1, ok: true, enabled: true, mode, poseVersion: 2 });
  f.capture(1, [{ x: 2 }]);
  const result = f.main.BH_Present(1), info = f.main.BH_PresentationInfo(false);
  for (const value of [result, info]) { assert.equal(value.mode, mode); assert.equal(value.poseVersion, 2); }
  assert.equal(result.poseTick, 1); assert.equal(info.poseCount, 1); assert.equal(info.anchorCount, 1);
  assert.equal(Object.hasOwn(info, 'pixelsEqual'), false, 'ordinary Info must not synchronize bitmap pixels');
  assert.deepEqual(plain(f.main.BH_PresentationConfig(true, mode)), { version: 1, ok: false });
  const before = f.main.mBH.presentation;
  assert.deepEqual(plain(f.main.BH_PresentationConfig(false, 'unknown')), { version: 1, ok: false });
  assert.equal(f.main.mBH.presentation, before);
});

test('two historical scalar intervals use the latest commands, with exact canonical coordinates and copy pixels at alpha one', () => {
  const f = fixture();
  const textures = [1, 2, 3].map(color => new Bitmap(2, 2, true, color));
  f.capture(1, [{ x: 2, bitmap: textures[0] }]);
  f.capture(2, [{ x: 6, bitmap: textures[1] }]);
  const { p, things } = f.capture(3, [{ x: 10, bitmap: textures[2] }]);
  const command = movingCommand(p), nativeCalls = f.world.bmDraw.calls.length;
  const canonical = f.world.bmDraw.pixels.slice(), worldState = plain(things[0].mPosition);
  const counters = [f.main.mBH.tick, f.main.mBH.clock, f.main.mBH.rngCalls, f.main.mBH.logicCalls, f.main.mBH.drawCalls];
  for (const [alpha, x] of [[0, 2], [0.25, 4], [0.5, 6], [0.75, 8], [1, 10]]) {
    const result = f.main.BH_Present(alpha);
    assert.equal(result.rendered, true); assert.equal(result.poseTick, 1 + 2 * alpha);
    assert.deepEqual(point(command), [x, 2]);
    assert.equal(command.args[0], textures[2], 'history is scalar positions, not historical textures');
    assert.equal(f.world.bmDraw.calls.length, nativeCalls);
    assert.deepEqual(f.world.bmDraw.pixels, canonical);
  }
  assert.deepEqual(plain(things[0].mPosition), worldState);
  assert.deepEqual([f.main.mBH.tick, f.main.mBH.clock, f.main.mBH.rngCalls, f.main.mBH.logicCalls, f.main.mBH.drawCalls], counters);
  assert.equal(f.nativeDraws, 3); assert.equal(f.main.BH_PresentationInfo(true).pixelsEqual, true);
  const frames = p.frames;
  assert.equal(f.main.BH_Present(1).unchanged, true); assert.equal(p.frames, frames);
});

test('retained pose maps contain only immutable scalar anchors and rotate at exactly three captures', () => {
  const f = fixture();
  const one = f.capture(1, [{ x: 2 }]).p.anchors;
  const two = f.capture(2, [{ x: 6 }]).p.anchors;
  const p = f.capture(3, [{ x: 10 }]).p;
  const three = p.anchors;
  assert.equal(p.older, one); assert.equal(p.previous, two);
  assert.equal(Object.getPrototypeOf(one), null);
  const frozen = [plain(one), plain(two), plain(three)];
  f.main.BH_Present(0.1); f.main.BH_Present(0.9);
  assert.deepEqual([plain(one), plain(two), plain(three)], frozen);
  for (const anchors of [one, two, three]) for (const anchor of Object.values(anchors)) {
    assert.deepEqual(Object.keys(anchor).sort(), ['x', 'y']);
    assert.equal(typeof anchor.x, 'number'); assert.equal(typeof anchor.y, 'number');
  }
  const oldCommands = p.commands;
  f.capture(4, [{ x: 14 }]);
  assert.equal(p.older, two); assert.equal(p.previous, three);
  assert.notEqual(p.commands, oldCommands);
  assert.equal([p.older, p.previous, p.anchors].includes(one), false);
  assert.equal(f.main.BH_PresentationInfo(false).poseCount, 3);
});

test('an initially missing oldest pose holds the known previous position, then interpolates the newest interval', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]);
  const { p } = f.capture(2, [{ x: 6 }]);
  const command = movingCommand(p);
  f.main.BH_Present(0); assert.deepEqual(point(command), [2, 2]);
  const frames = p.frames;
  assert.equal(f.main.BH_Present(0.25).unchanged, true); assert.equal(p.frames, frames);
  f.main.BH_Present(0.75); assert.deepEqual(point(command), [4, 2]);
  f.main.BH_Present(1); assert.deepEqual(point(command), [6, 2]);
});

test('motion in the older interval survives a stopped newest interval, whose repeated static geometry is not a new frame', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6 }]);
  const { p } = f.capture(3, [{ x: 6 }]);
  const command = movingCommand(p);
  assert.equal(p.olderMoving, true); assert.equal(p.newerMoving, false);
  const mid = f.main.BH_Present(0.25);
  assert.deepEqual(point(command), [4, 2]); assert.equal(mid.interpolated, 1);
  f.main.BH_Present(0.5); assert.deepEqual(point(command), [6, 2]);
  const frames = p.frames;
  assert.equal(f.main.BH_Present(0.75).unchanged, true);
  assert.equal(f.main.BH_Present(1).unchanged, true); assert.equal(p.frames, frames);
});

test('an invincibility-hidden tick retains its pose without retaining its old command list or invoking an extra Draw', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6, hidden: true }]);
  const { p } = f.capture(3, [{ x: 10 }]);
  const command = movingCommand(p);
  f.main.BH_Present(0); assert.deepEqual(point(command), [2, 2]);
  f.main.BH_Present(0.5); assert.deepEqual(point(command), [6, 2]);
  f.main.BH_Present(1); assert.deepEqual(point(command), [10, 2]);
  assert.equal(f.nativeDraws, 3); assert.equal(p.commands.length, 2);
});

test('new identities snap to their current native position instead of borrowing another Thing history', () => {
  const f = fixture(); f.capture(1, [{ id: 1, x: 2 }]); f.capture(2, [{ id: 1, x: 6 }]);
  const { p } = f.capture(3, [{ id: 2, x: 10 }]);
  const command = movingCommand(p);
  assert.equal(command.geometry, undefined);
  for (const alpha of [0, 0.25, 0.5, 1]) {
    f.main.BH_Present(alpha); assert.deepEqual(point(command), [10, 2]);
  }
});

test('discontinuity guards apply to each adjacent pair, including valid cumulative movement above 64 pixels', () => {
  const f = fixture(); f.capture(1, [{ x: 0 }]); f.capture(2, [{ x: 50 }]);
  const { p } = f.capture(3, [{ x: 100 }]);
  const command = movingCommand(p);
  f.main.BH_Present(0); assert.deepEqual(point(command), [0, 2]);
  f.main.BH_Present(0.5); assert.deepEqual(point(command), [50, 2]);
  f.main.BH_Present(1); assert.deepEqual(point(command), [100, 2]);
  const oldJump = fixture(); oldJump.capture(1, [{ x: 0 }]); oldJump.capture(2, [{ x: 100 }]);
  const old = movingCommand(oldJump.capture(3, [{ x: 104 }]).p);
  oldJump.main.BH_Present(0); assert.deepEqual(point(old), [100, 2]);
  oldJump.main.BH_Present(0.75); assert.deepEqual(point(old), [102, 2]);
  const newJump = fixture(); newJump.capture(1, [{ x: 0 }]); newJump.capture(2, [{ x: 4 }]);
  const newest = movingCommand(newJump.capture(3, [{ x: 100 }]).p);
  newJump.main.BH_Present(0); assert.deepEqual(point(newest), [100, 2]);
  assert.equal(newest.geometry, undefined);
});

test('camera source rectangles and Thing screen anchors share the same two-interval phase', () => {
  const f = fixture(); f.capture(1, [{ x: 8 }], { camera: 0 }); f.capture(2, [{ x: 8 }], { camera: 3 });
  const { p } = f.capture(3, [{ x: 8 }], { camera: 6 });
  const camera = p.commands.find(command => command.camera), thing = movingCommand(p);
  for (const [alpha, cameraX, screenX] of [[0, 0, 8], [0.5, 3, 5], [1, 6, 2]]) {
    f.main.BH_Present(alpha);
    assert.equal(camera.args[1].x, cameraX); assert.equal(camera.args[1].width, 32);
    assert.deepEqual(point(thing), [screenX, 2]);
  }
  assert.equal(f.main.BH_PresentationInfo(true).pixelsEqual, true);
});

test('matrix geometry is private, keeps the original transform and restores exact canonical translation at alpha one', () => {
  const f = fixture(); f.capture(1, [{ x: 2, matrix: true }]); f.capture(2, [{ x: 6, matrix: true }]);
  const { p } = f.capture(3, [{ x: 10, matrix: true }]);
  const command = movingCommand(p);
  const original = f.world.bmDraw.calls.filter(call => call.name === 'draw').at(-1).values[1];
  assert.notEqual(command.geometry, original);
  for (const [alpha, tx] of [[0, 4], [0.5, 8], [1, 12]]) {
    f.main.BH_Present(alpha); assert.deepEqual(point(command), [tx, 5]);
    assert.deepEqual([command.geometry.a, command.geometry.b, command.geometry.c, command.geometry.d], [2, 0.25, -0.5, 3]);
    assert.deepEqual([original.tx, original.ty], [12, 5]);
  }
});

test('all hidden anchors count toward the explicit map bound and an overflow still invokes original Draw exactly once', () => {
  const f = fixture(); Object.assign(f.main.mBH, { active: true, state: 'playing', stepping: true });
  f.main.BH_PresentationBegin();
  for (let id = 0; id < 4096; id++) f.draw({ id, x: 0, hidden: true });
  const p = f.main.mBH.presentation;
  assert.equal(p.anchorCount, 4096); assert.equal(p.commands.length, 0);
  f.draw({ id: 4096, x: 0, hidden: true });
  assert.equal(f.nativeDraws, 4097); assert.equal(f.main.mBH.presentation, undefined);
  assert.match(f.main.mBH.presentationError, /anchor limit/);
  assert.equal(f.world.bmDraw.copyPixels, Bitmap.prototype.copyPixels);
  assert.equal(p.records[0].display.disposed, true);
});

test('anchor key and finite-coordinate bounds disable only capture and preserve the original native Draw', () => {
  for (const item of [{ id: 'x'.repeat(260), x: 1 }, { id: 1, x: Infinity }, { id: 1, x: NaN }]) {
    const f = fixture(); Object.assign(f.main.mBH, { active: true, state: 'playing', stepping: true });
    f.main.BH_PresentationBegin(); f.draw({ ...item, hidden: true });
    assert.equal(f.nativeDraws, 1); assert.equal(f.main.mBH.presentation, undefined);
    assert.match(f.main.mBH.presentationError, /anchor limit or coordinates/);
  }
});

test('a discontinuous native tick discards old interpolation maps before publishing the new pose', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6 }]);
  const { p } = f.capture(30, [{ x: 10 }]);
  f.main.BH_Present(0); assert.deepEqual(point(movingCommand(p)), [10, 2]);
  assert.equal(p.previousTick, undefined); assert.equal(p.olderTick, undefined);
  assert.equal(f.main.BH_PresentationInfo(false).poseCount, 1);
  assert.equal(f.nativeDraws, 3);
});

test('disposal restores the original attachment and methods and releases every retained visual map', () => {
  const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6 }]);
  const { p } = f.capture(3, [{ x: 10 }]);
  f.main.BH_Present(0.25); const display = p.records[0].display;
  f.main.BH_PresentationDispose();
  assert.equal(f.main.mBH.presentation, undefined);
  assert.equal(f.attachments.at(-1)[0], f.world.bmDraw); assert.equal(f.attachments.at(-1)[1], 4);
  assert.equal(f.world.bmDraw.copyPixels, Bitmap.prototype.copyPixels);
  assert.equal(display.disposed, true);
  assert.equal(p.older, undefined); assert.equal(p.previous, undefined); assert.equal(p.anchors, undefined);
  assert.equal(p.commands.length, 0); assert.equal(p.scratch.length, 0);
});

test('receipt, replay, capture and terminal guards remain effective in the explicit pose mode', () => {
  for (const block of [{ snapshotReceiptBusy: true }, { snapshotReceiptRequest: {} },
    { snapshotReceiptPending: {} }, { replay: true }, { complete: 'finished' }, { stepping: true }]) {
    const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6 }]);
    const { p } = f.capture(3, [{ x: 10 }]); Object.assign(f.main.mBH, block);
    const frames = p.frames, updates = f.updates, finiteCalls = f.finiteCalls;
    const result = f.main.BH_Present(0.25);
    assert.equal(result.mode, mode); assert.equal(result.poseVersion, 2);
    assert.equal(result.rendered, false); assert.equal(p.frames, frames); assert.equal(f.updates, updates);
    assert.equal(f.finiteCalls, finiteCalls, 'state guards must still precede the original replaceable global isFinite');
  }
});

test('malformed alpha keeps the original non-coercing rejection before any visual or receipt work', () => {
  for (const block of [{}, { snapshotReceiptPending: {} }, { snapshotReceiptRequest: {} },
    { stepping: true }, { replay: true }, { complete: 'finished' }]) {
    const f = fixture(); f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6 }]);
    const { p } = f.capture(3, [{ x: 10 }]); Object.assign(f.main.mBH, block);
    let coercions = 0;
    const alpha = { valueOf() { coercions++; throw new Error('alpha coercion must not run'); } };
    const frames = p.frames, updates = f.updates;
    for (const input of [alpha, '0.5', NaN, Infinity, -1, 2]) {
      const result = f.main.BH_Present(input);
      assert.equal(result.rendered, false); assert.equal(result.mode, mode);
      assert.equal(Object.hasOwn(result, 'poseTick'), false);
      assert.equal(p.frames, frames); assert.equal(f.updates, updates);
    }
    assert.equal(coercions, 0);
  }
});

test('one-argument legacy mode preserves its result shape and single-interval interpolation', () => {
  // Passing no mode to the actual config, not an alias for the new mode.
  const f = fixture(); f.main.BH_PresentationConfig(false);
  const configured = f.main.BH_PresentationConfig(true);
  assert.deepEqual(plain(configured), { version: 1, ok: true, enabled: true });
  f.capture(1, [{ x: 2 }]); f.capture(2, [{ x: 6 }]);
  const { p } = f.capture(3, [{ x: 10 }]);
  for (const [alpha, x] of [[0, 6], [0.5, 8], [1, 10]]) {
    const result = f.main.BH_Present(alpha);
    assert.deepEqual(point(movingCommand(p)), [x, 2]);
    for (const key of ['mode', 'poseVersion', 'poseTick']) assert.equal(Object.hasOwn(result, key), false);
  }
  const info = f.main.BH_PresentationInfo(false);
  for (const key of ['mode', 'poseVersion', 'poseCount', 'anchorCount']) assert.equal(Object.hasOwn(info, key), false);
  assert.equal(f.main.BH_PresentationInfo(true).pixelsEqual, true);
});
