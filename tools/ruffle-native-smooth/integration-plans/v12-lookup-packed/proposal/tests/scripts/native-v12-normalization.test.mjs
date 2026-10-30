import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { restoreV10NativeSource, restoreV10PackedHelper } from './fixtures/native-v12-source.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const lookup = 'tools/ruffle-native-lookup-v2/engine/';
const packed = 'tools/ruffle-native-packed-blit/engine/';
const helper = 'core/src/bitmap/operations/boxhead_blit.rs';
const predecessors = [
  ['core/src/avm1/globals/boxhead_native_project.rs', 32804,
    '73f9240d39fd9c179963acd201cfb2dea7019ae14b1d6f7d7c2ca31098b4efb3'],
  ['core/src/avm1/globals/boxhead_native_projection_scan.rs', 12637,
    '11451ab0d11b1617f9859164888a6077fb34173c11ec7e8cc85575ab0394bbc0'],
  ['core/src/avm1/object/script_object.rs', 42307,
    '67cfbecc52f4db6c7321efe0015c7503aad1706b0161b0664474a42c67f6905f'],
  ['core/src/avm1/scope.rs', 9350,
    '85d7998c61e2f65c0c77116799ad32dc7f04f231a4f6d81a2829ee777dffbd2d'],
];

test('historical normalization logic and complete exact-delta data are independently pinned', () => {
  for (const [path, bytes, digest] of [
    ['tests/scripts/fixtures/native-v12-source.mjs', 3366,
      '3de8a81cee3bf3739e2cca76bd2e76ee7a5426a8a71b643767b6d0b56690dc12'],
    ['tests/scripts/fixtures/native-v12-source-delta.json', 60861,
      'e1c80508c711954b9f58d6e4cdc43178e951bb6e897e3e56257e73bc4138ce92'],
  ]) {
    const source = read(path);
    assert.equal(Buffer.byteLength(source), bytes); assert.equal(sha(source), digest);
  }
});

test('the four current lookup files restore their complete prior source rather than dropping guards', () => {
  for (const [path, bytes, digest] of predecessors) {
    const candidate = read(lookup + path);
    assert.equal(read('tools/ruffle-native-smooth/engine/' + path), candidate);
    const restored = restoreV10NativeSource(candidate, path);
    assert.equal(Buffer.byteLength(restored), bytes); assert.equal(sha(restored), digest);
    if (path.endsWith('/scope.rs')) {
      assert.equal(restored, read(lookup + 'core/src/avm1/scope/frozen_v10.rs'));
    } else if (path.endsWith('/script_object.rs')) {
      assert.equal(restored, read('tools/ruffle-native-anchor-hotpath/engine/' + path));
    }
  }
});

test('the integrated packed helper restores the complete old kernel and every old functional fixture', () => {
  const candidate = read(packed + helper);
  assert.equal(read('tools/ruffle-native-smooth/engine/' + helper), candidate);
  const restored = restoreV10PackedHelper(candidate);
  assert.equal(Buffer.byteLength(restored), 14782);
  assert.equal(sha(restored), '434b80a83c2179bf9d430f947efa1b70694574b9c32d6666140ca290ad70d7a8');
  const tests = '#[cfg(test)]\nmod tests {';
  const before = restored.indexOf(tests), after = candidate.indexOf(tests);
  assert(before > 0 && after > 0);
  assert.equal(restored.slice(0, before), read(packed + 'core/src/bitmap/operations/boxhead_blit/frozen_v10.rs'));
  const benchmark = '\n    #[test]\n    #[ignore = "CI-only release-mode diagnostic; not an FPS acceptance test"]';
  const oldEnd = restored.indexOf(benchmark), newEnd = candidate.indexOf(benchmark);
  assert(oldEnd > before && newEnd > after);
  const oldFunctional = restored.slice(before, oldEnd);
  assert.equal(candidate.slice(after, newEnd), oldFunctional);
  assert.equal((oldFunctional.match(/#\[test\]/g) ?? []).length, 6);
  assert.equal((candidate.match(/#\[ignore/g) ?? []).length, 1);
});

test('same-length changes, added text, prior files, type confusion and unknown paths cannot normalize', () => {
  const rows = [...predecessors.map(([path]) => [path, lookup]), [helper, packed]];
  for (const [path, packageRoot] of rows) {
    const candidate = read(packageRoot + path);
    const altered = (candidate[0] === '!' ? '?' : '!') + candidate.slice(1);
    assert.equal(Buffer.byteLength(altered), Buffer.byteLength(candidate));
    for (const bad of [altered, candidate + '\n', restoreV10NativeSource(candidate, path),
      Buffer.from(candidate), { toString: () => candidate }, null]) {
      assert.throws(() => restoreV10NativeSource(bad, path));
    }
    assert.throws(() => restoreV10NativeSource(candidate, 'unreviewed/' + path));
    assert.throws(() => restoreV10NativeSource(candidate, { toString: () => path }));
  }
});

test('overwrite source proof changes only two exact hooks and one support-file identity', () => {
  const path = 'tools/ruffle-native-bitmap-overwrite/source-integrity.test.mjs';
  let source = read(path);
  assert.equal(Buffer.byteLength(source), 4303);
  assert.equal(sha(source), '9352a1580ae778145af9be1ff2f9517e6f61f2f67078f2e98181b9b11cae4379');
  const importLine = "import { restoreV10PackedHelper } from '../../tests/scripts/fixtures/native-v12-source.mjs';\n";
  const current = "  const kernel = restoreV10PackedHelper(read('../ruffle-native-smooth/engine/core/src/bitmap/operations/boxhead_blit.rs'));";
  const previous = "  const kernel = read('../ruffle-native-smooth/engine/core/src/bitmap/operations/boxhead_blit.rs');";
  for (const [from, to] of [[importLine, ''], [current, previous]]) {
    assert.equal(source.split(from).length, 2);
    source = source.replace(from, () => to);
  }
  assert.equal(Buffer.byteLength(source), 4186);
  assert.equal(sha(source), '09b50a66bf5d21468c50db90f3cf2d7c6e30b2e05813e31e82258cc8d730d1c9');
  assert.equal((source.match(/^test\(/gm) ?? []).length, 3);
  const inventoryBytes = read('tools/ruffle-native-bitmap-overwrite/source-inventory.json');
  assert.equal(Buffer.byteLength(inventoryBytes), 4298);
  assert.equal(sha(inventoryBytes), 'ab0ca489efe3dc3d281b307f421c4af98ac134ff19cb1c9500893af78e19eeb5');
  const inventory = JSON.parse(inventoryBytes);
  const support = inventory.supportFiles.filter(row => row.path === 'source-integrity.test.mjs');
  assert.equal(support.length, 1);
  support[0].bytes = 4186;
  support[0].sha256 = '09b50a66bf5d21468c50db90f3cf2d7c6e30b2e05813e31e82258cc8d730d1c9';
  const original = JSON.stringify(inventory, null, 2) + '\n';
  assert.equal(Buffer.byteLength(original), 4298);
  assert.equal(sha(original), '0997f7816892f6872353630a2c04453836fb9a89e9a8aaad44c18706d3d0a3bd');
});
