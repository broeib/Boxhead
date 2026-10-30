import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../tools/original-bridge/CMain.presentation.asinc', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const mode = 'four-pose-v3';

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


export { fixture, Bitmap, Point, Rectangle, Matrix, plain, point, movingCommand };
