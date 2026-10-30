import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { restoreReviewedGcSource } from '../ruffle-native-gc-slicing/source-normalization.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const fence = read('./engine/core/src/avm1/globals/boxhead_step_fence.rs');
const inventory = JSON.parse(read('./source-inventory.json'));
function once(text, before, after) {
  assert.equal(text.split(before).length, 2);
  return text.replace(before, after);
}
function block(text, marker) {
  const start = text.indexOf(marker);
  assert(start >= 0 && text.indexOf(marker, start + marker.length) === -1);
  const end = text.indexOf('\n}\n', start);
  assert(end >= 0);
  return text.slice(start, end + 3);
}

test('the optional registration and Player test include are the only edits in those baseline files', () => {
  const globals = once(read('./engine/core/src/avm1/globals.rs'),
    '        "boxheadNativeCompactFenceV1" => method(boxhead_step_fence::call_compact; DONT_ENUM | DONT_DELETE | READ_ONLY);\n', '');
  assert.equal(Buffer.byteLength(globals), 33490);
  assert.equal(sha(globals), 'd3b8596082ad35bd4ded2407609e6f5d548e17d14bb304bbb02186350da0c0e9');
  const player = once(read('./engine/core/src/player/boxhead_step_fence.rs'), '\n#[cfg(test)]\nmod compact_tests;\n', '');
  assert.equal(Buffer.byteLength(player), 7626);
  assert.equal(sha(player), 'e1e8ed7da173b2ce42ccf02451f9ef8a709ac0609c0dac7b68ccb0d377355d04');
});

test('the original full phase enum, install and public capability preserve their exact old bodies', () => {
  const kind = block(fence, 'impl Kind {');
  assert.equal(Buffer.byteLength(kind), 1540);
  assert.equal(sha(kind), '86a1ce1f4968ffdebec3dae3588f6d49b76cce837b6fac0956f25f1320a892cd');
  const install = once(block(fence, 'fn install<'), 'Installed { protocol: Protocol::FullV1, owner,', 'Installed { owner,');
  assert.equal(Buffer.byteLength(install), 1369);
  assert.equal(sha(install), '65426b8c91b18abfaac471a1a675b3f9a3c5e8ee067fd1229f3e57ac7ecc3ab5');
  const call = once(block(fence, 'pub fn call<'),
    'operation(activation, Protocol::FullV1, &name.to_string(), args)', 'operation(activation, &name.to_string(), args)');
  assert.equal(Buffer.byteLength(call), 954);
  assert.equal(sha(call), '8b8506ce1b7c54566ec7165c3e9263745ef30590eb27763627428bdd1410dbeb');
});

test('both full fixture bodies and the actual Player, external and web integration remain byte-exact', () => {
  const expected = [
    ['core/src/avm1/globals/boxhead_step_fence/tests.rs', 28047, '7f90d591450012e5592851d12502e7063543163477955d8d8bc4ae9827f07303'],
    ['core/src/player/boxhead_step_fence/tests.rs', 18019, 'df683c88bfd1f7f89e4ffebce662fb20d4934405c815d94449eb0bb28d56c6b9'],
    ['core/src/external.rs', 17190, '32426b1162c95983b458f7d2761f1d72b0ebb0c72da56c9c18c685e6f7d55d9c'],
    ['core/src/player.rs', 131004, '229f015ff0549af7f27d4fed1e8e70a1e537616f910f58a09f04350bdf134d80'],
    ['web/src/lib.rs', 54683, 'c56a400feccbdd7977f1fb006e7b8e21e9155fd7fed750649984bb7acccacb6f'],
  ];
  let oldTests = 0;
  for (const [path, bytes, hash] of expected) {
    const current = read('../ruffle-native-smooth/engine/' + path);
    const source = path === 'core/src/player.rs' ? restoreReviewedGcSource(path, current) : current;
    assert.equal(Buffer.byteLength(source), bytes, path); assert.equal(sha(source), hash, path);
    if (path.endsWith('/tests.rs')) oldTests += (source.match(/#\[test\]/g) ?? []).length;
  }
  assert.equal(oldTests, 35);
});

test('the exact source inventory contains five overlays and all twenty-eight new mandatory fixtures', () => {
  assert.equal(inventory.schema, 'boxhead-native-compact-fence-source-review-v1');
  assert.equal(inventory.baselineManifest.sha256, 'fb85f0134a82aad0652b725672c015d0a206483b3d9e05f5d15274a08dc2b86f');
  assert.equal(inventory.files.length, 5);
  for (const row of inventory.files) {
    assert(!row.path.split('/').includes('..'));
    const source = read('./engine/' + row.path);
    assert.equal(Buffer.byteLength(source), row.bytes, row.path); assert.equal(sha(source), row.sha256, row.path);
  }
  const names = [];
  for (const [path, prefix, count] of [
    ['core/src/avm1/globals/boxhead_step_fence/compact_tests.rs', 'avm1::globals::boxhead_step_fence::compact_tests::', 23],
    ['core/src/player/boxhead_step_fence/compact_tests.rs', 'player::boxhead_step_fence::compact_tests::', 5],
  ]) {
    const source = read('./engine/' + path);
    const found = [...source.matchAll(/^fn (compact_fence_[a-z0-9_]+)\(/gm)].map(match => prefix + match[1]);
    assert.equal(found.length, count); assert.equal((source.match(/#\[test\]/g) ?? []).length, count);
    assert.equal(source.includes('#[ignore'), false); names.push(...found);
  }
  assert.equal(names.length, 28); assert.equal(new Set(names).size, 28);
  assert.equal(inventory.rustFixtureGroup.filter, 'compact_fence_');
  assert.equal(inventory.rustFixtureGroup.executedExpected, 28);
  assert.equal(inventory.rustFixtureGroup.ignoredExpected, 0);
  assert.deepEqual(names.sort(), inventory.rustFixtureGroup.exactNames);
});
