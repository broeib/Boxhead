import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

// Read-only inspection of a saved native BHG1 packet. This does not import a
// graph, call AVM1, resolve native anchors, or reproduce the VM's importer.
export function inspectNativeCheckpointWire(wire) {
  assert(Buffer.isBuffer(wire) && wire.length > 5 && wire.length <= 16 * 1024 * 1024);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const text = wire.toString('ascii'); assert(Buffer.from(text, 'ascii').equals(wire));
  assert(text.startsWith('BHG1:')); const hex = text.slice(5);
  assert(hex.length % 2 === 0 && /^[0-9a-f]+$/.test(hex));
  const compressed = Buffer.from(hex, 'hex');
  const inflated = inflateSync(compressed, { maxOutputLength: 128 * 1024 * 1024, info: true });
  // Node's documented info result exposes the bytes consumed by its engine;
  // keep the same complete compressed-input check as the native Rust reader.
  assert.equal(inflated.engine.bytesWritten, compressed.length, 'Trailing compressed native graph data');
  const raw = inflated.buffer;
  let at = 0;
  const take = bytes => {
    assert(Number.isSafeInteger(bytes) && bytes >= 0 && at + bytes <= raw.length, 'Truncated native graph packet');
    const part = raw.subarray(at, at + bytes); at += bytes; return part;
  };
  const u8 = () => take(1)[0], u16 = () => take(2).readUInt16LE(), u32 = () => take(4).readUInt32LE();
  const string = () => { const units = u32(); assert(units <= 1048576); return take(units * 2).toString('utf16le'); };
  assert(take(4).equals(Buffer.from([0x42, 0x48, 0x47, 1])));
  const swfVersion = u8(), count = u32(), declaredFields = u32();
  assert.equal(swfVersion, 8); assert(count > 0 && count <= 65536 && declaredFields > 0 && declaredFields <= 1000000);
  function atom() {
    const tag = u8();
    if (tag <= 3) return { tag, value: tag === 2 ? false : tag === 3 ? true : null };
    if (tag === 4) { const bytes = take(8); return { tag, bits: bytes.readBigUInt64LE().toString(16).padStart(16, '0'), value: bytes.readDoubleLE() }; }
    if (tag === 5) return { tag, value: string() };
    if (tag === 6) { const value = u32(); assert(value < count); return { tag, value }; }
    assert.equal(tag, 7, 'Unknown native graph atom'); const kind = u8(), value = string();
    assert(kind <= 34 || kind === 64); assert(value.length > 0 && value.length <= 2048 && /^[\x21-\x7e]+$/.test(value));
    return { tag, kind, value };
  }
  const root = atom(), nodes = [], bitmaps = []; let fields = 0, pixelBytes = 0;
  for (let id = 0; id < count; id++) {
    const kind = u8(); assert(kind <= 2); let bitmap;
    if (kind === 2) {
      const width = u32(), height = u32(), transparent = u8(), pixels = width * height;
      assert(Number.isSafeInteger(pixels) && pixels > 0 && pixels <= 8388608 && transparent <= 1);
      const rgba = take(pixels * 4);
      bitmap = { node: id, width, height, transparent: Boolean(transparent), pixelBytes: rgba.length,
        premultipliedRgbaSha256: hash(rgba) };
      bitmaps.push(bitmap); pixelBytes += rgba.length;
    }
    const n = u32(); fields += n; assert(fields <= declaredFields);
    const properties = new Map();
    for (let i = 0; i < n; i++) {
      const name = string(), flags = u16(), value = atom();
      assert(!properties.has(name), 'Duplicate native graph property');
      if (name === '__proto__') assert([0, 1, 7].includes(value.tag));
      properties.set(name, { flags, value });
    }
    nodes.push({ kind, bitmap, properties });
  }
  assert.equal(fields, declaredFields); assert.equal(at, raw.length, 'Trailing decoded native graph data');
  const node = value => { assert.equal(value?.tag, 6); return nodes[value.value]; };
  const field = (value, name) => { const found = node(value).properties.get(name); assert(found, 'Missing checkpoint field ' + name); return found.value; };
  const number = value => { assert.equal(value?.tag, 4); assert(Number.isFinite(value.value)); return value.value; };
  const word = value => { assert.equal(value?.tag, 5); return value.value; };
  const array = value => {
    assert.equal(node(value).kind, 1); const length = number(field(value, 'length'));
    assert(Number.isSafeInteger(length) && length >= 0 && length <= 256);
    return Array.from({ length }, (_, index) => field(value, String(index)));
  };
  const schema = word(field(root, 'schema')); assert.equal(schema, 'boxhead-world-checkpoint-v1');
  const pack = field(root, 'world'), keys = array(field(pack, 'keys')), values = array(field(pack, 'values'));
  assert.equal(keys.length, values.length);
  const world = new Map();
  for (const [index, key] of keys.entries()) { const name = word(key); assert(!world.has(name)); world.set(name, values[index]); }
  const worldSurfaces = ['bmFloor', 'bmCover', 'bmDecalMask'].map(name => {
    const reference = world.get(name), found = node(reference); assert.equal(found.kind, 2);
    return { field: name, ...found.bitmap };
  });
  assert.equal(new Set(worldSurfaces.map(bitmap => bitmap.node)).size, 3, 'World surfaces were aliased or omitted');
  const area = world.get('mArea');
  const worldArea = Object.fromEntries(['x', 'y', 'width', 'height'].map(name => [name, number(field(area, name))]));
  const settingsRef = field(root, 'settings');
  const settings = Object.fromEntries(['difficulty', 'speed', 'devils', 'collisions', 'damage', 'gameAmount']
    .map(name => [name, number(field(settingsRef, name))]));
  return { schema: 'boxhead-native-checkpoint-wire-inspection-v1', wireBytes: wire.length, wireSha256: hash(wire),
    compressedBytes: compressed.length, compressedBytesConsumed: inflated.engine.bytesWritten,
    decodedBytes: raw.length, decodedSha256: hash(raw), swfVersion,
    nodes: count, fields, bitmapNodes: bitmaps.length, bitmapPixelBytes: pixelBytes,
    exceedsOld32MiBDecodedLimit: raw.length > 32 * 1024 * 1024,
    checkpoint: { schema, tick: number(field(root, 'tick')), digest: word(field(root, 'digest')),
      mode: word(field(root, 'mode')), map: word(field(root, 'map')), seed: number(field(root, 'seed')),
      characters: array(field(root, 'characters')).map(number), settings }, worldArea, worldSurfaces, bitmaps,
    scope: 'Independent read-only parse and hash of the saved host packet, complete decoded field stream and raw bitmap pixels. Native anchor resolution and import semantics are checked by the actual VM producer, not reimplemented here. Guest re-export bytes were not saved and are not independently rehashed.' };
}
