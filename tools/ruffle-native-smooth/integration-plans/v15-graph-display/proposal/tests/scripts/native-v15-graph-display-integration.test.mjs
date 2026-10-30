import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { restoreV14aSource } from './fixtures/native-v15-source.mjs';
import { SMOOTH_RUNTIME_PINS, SMOOTH_OVERLAY_PATHS, SMOOTH_UPSTREAM_BASELINES,
  SMOOTH_DECLARED_IGNORED_SOURCES } from '../../scripts/lib/native-smooth-runtime-binding.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = source => ({ bytes: Buffer.byteLength(source), sha256: sha(source) });
const engineRoot = 'tools/ruffle-native-smooth/engine/';
const engineText = read(engineRoot + 'manifest.json'), engine = JSON.parse(engineText);
const v14aText = read('tests/scripts/fixtures/native-smooth-v14a-manifest.json');
assert.deepEqual(identity(v14aText), { bytes: 71812,
  sha256: 'df8c7e72e90a3c5d1c8bb6a701bd86aff85fe1872f909aa19a200ff85bf22e76' });
const v14a = JSON.parse(v14aText);
const origin = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'bytes' && key !== 'sha256'));
const packagePins = [
  {
    "path": "tools/ruffle-native-graph-paths/",
    "bytes": 7743,
    "sha256": "3c2a6ed8096dd98c2085ba70ca1f5a46b3143cec00e6b9da388c9cd7028a9f90",
    "files": 3
  },
  {
    "path": "tools/ruffle-native-display-lookup/",
    "bytes": 10665,
    "sha256": "4ae081cac296f89c039189b6fc90e4b75fb5150154943f1e51cf6ae26831d6f7",
    "files": 4
  }
];
const packages = packagePins.map(({ path, bytes, sha256, files }) => {
  const source = read(path + 'source-inventory.json');
  assert.deepEqual(identity(source), { bytes, sha256 });
  return { path, count: files, inventory: JSON.parse(source) };
});

test('v15 binds both exact packages and all96 unaffected v14a overlay files without changing installation baselines', () => {
  assert.equal(sha(engineText), SMOOTH_RUNTIME_PINS.engineManifest);
  assert.equal(engine.files.length, 103); assert.equal(SMOOTH_OVERLAY_PATHS.length, 103);
  assert.equal(engine.files.filter(row => row.baselineAbsent).length, 84);
  const overlaid = new Set();
  for (const { path, count, inventory } of packages) {
    assert.equal(inventory.integrated, false); assert.equal(inventory.files.length, count);
    for (const expected of inventory.files) {
      assert(!overlaid.has(expected.path)); overlaid.add(expected.path);
      const actual = read(engineRoot + expected.path);
      assert.equal(actual, read(path + 'engine/' + expected.path), expected.path);
      assert.deepEqual(identity(actual), { bytes: expected.bytes, sha256: expected.sha256 });
      const row = engine.files.find(row => row.path === expected.path);
      assert.deepEqual({ bytes: row.bytes, sha256: row.sha256 }, identity(actual));
      const old = v14a.files.find(row => row.path === expected.path);
      if (old) {
        assert.deepEqual(expected.baseline, { bytes: old.bytes, sha256: old.sha256 });
        assert.deepEqual(origin(row), origin(old), 'Review predecessor must not replace the parent installation baseline');
        assert.deepEqual(identity(restoreV14aSource(engineRoot + expected.path, actual)), expected.baseline);
      } else {
        assert.equal(expected.baselineAbsent, true); assert.equal(row.baselineAbsent, true);
        assert.equal(row.baselineBytes, undefined); assert.equal(row.baselineSha256, undefined);
      }
    }
    for (const row of inventory.supportFiles)
      assert.deepEqual(identity(read(path + row.path)), { bytes: row.bytes, sha256: row.sha256 }, row.path);
  }
  assert.equal(overlaid.size, 7);
  const retained = v14a.files.filter(row => !overlaid.has(row.path));
  assert.equal(retained.length, 96);
  for (const expected of retained) {
    assert.deepEqual(engine.files.find(row => row.path === expected.path), expected);
    assert.deepEqual(identity(read(engineRoot + expected.path)), { bytes: expected.bytes, sha256: expected.sha256 });
  }
  assert.deepEqual(engine.files.filter(row => !v14a.files.some(old => old.path === row.path)).map(row => row.path).sort(),
    packages.flatMap(({ inventory }) => inventory.files.filter(row => row.baselineAbsent).map(row => row.path)).sort());
});

test('all324 exact mandatory v14a fixtures and the sole ignored diagnostic remain with only4 graph and explicit display additions', () => {
  assert.equal(engine.rustUnitGroups.length, 17); assert.equal(engine.totalRequiredRustTests, 345);
  assert.deepEqual(engine.rustUnitGroups.slice(1, 16), v14a.rustUnitGroups.slice(1));
  const graph = engine.rustUnitGroups[0], oldGraph = v14a.rustUnitGroups[0];
  assert.deepEqual({ ...graph, expectedExecuted: 43, expectedPassed: 43, exactNames: graph.exactNames.slice(0, 43) }, oldGraph);
  assert.equal(graph.expectedExecuted, 47); assert.equal(graph.expectedPassed, 47);
  assert.deepEqual(graph.exactNames.slice(43), packages[0].inventory.rustFixtureGroup.addedExactNames
    .map(name => 'avm1::globals::boxhead_native_graph::path_tests::' + name));
  const display = packages[1].inventory.rustFixtureGroup;
  assert.equal(display.executedExpected, 17); assert.equal(display.ignoredExpected, 0);
  assert.deepEqual(engine.rustUnitGroups[16], { label: 'display_lookup', filter: 'display_lookup_',
    expectedExecuted: 17, expectedPassed: 17, expectedFailed: 0, expectedIgnored: 0,
    exactNames: display.fullNames });
  assert.equal(engine.rustUnitGroups.reduce((sum, group) => sum + group.expectedIgnored, 0), 1);
  assert.deepEqual(engine.rustUnitGroups.filter(group => group.expectedIgnored), v14a.rustUnitGroups.filter(group => group.expectedIgnored));
  const names = engine.rustUnitGroups.flatMap(group => group.exactNames);
  assert.equal(names.length, 345); assert.equal(new Set(names).size, 345);
  for (const name of v14a.rustUnitGroups.flatMap(group => group.exactNames)) assert(names.includes(name), name);
});

test('all eight changed existing sources restore their complete v14a endpoints and preserve the parent/runtime family', () => {
  assert.equal(restoreV14aSource(engineRoot + 'manifest.json', engineText), v14aText);
  for (const record of [
  {
    "path": "scripts/lib/native-smooth-runtime-binding.mjs",
    "before": {
      "bytes": 70373,
      "sha256": "384d0d4ccdb34e7317ff41ceabd29a5203154ba7f266ce0cd0daeff5f4235af4"
    }
  },
  {
    "path": "tests/scripts/native-smooth-runtime-binding.test.mjs",
    "before": {
      "bytes": 54577,
      "sha256": "5345839bed7e3b3d7c1d868fac376e139f0693112ae7159068616875009c4fc7"
    }
  },
  {
    "path": "tests/scripts/native-v13-gc-integration.test.mjs",
    "before": {
      "bytes": 16165,
      "sha256": "903c104e93d48b9cfba27cfc456204f46dee59aa9cfeddc06dc64a1fbc93dabb"
    }
  },
  {
    "path": "tests/scripts/native-v14-push-anchor-integration.test.mjs",
    "before": {
      "bytes": 11175,
      "sha256": "204fa49b7a80f239aeb38b073d9a72f4ac80419a72aca0c2bca883de48aa327c"
    }
  },
  {
    "path": "tools/ruffle-native-smooth/engine/core/src/avm1/globals/boxhead_native_graph.rs",
    "before": {
      "bytes": 45856,
      "sha256": "25bcdd5010eb7edc02b588a0ba80b2a970fa0f28bb400e12da4205e67bea61da"
    }
  },
  {
    "path": "tools/ruffle-native-smooth/engine/core/src/avm1/object.rs",
    "before": {
      "bytes": 20276,
      "sha256": "1929a336bd4b60cae4491b28542116f88027f823e36b2dd5b2936ffc4458b2bc"
    }
  },
  {
    "path": "tools/ruffle-native-smooth/engine/core/src/avm1/object/script_object.rs",
    "before": {
      "bytes": 43753,
      "sha256": "2189a94b6c6c789c2e702dd69ad6bfb56af244d457ce2bc3cca7f9f783f44399"
    }
  },
  {
    "path": "tools/ruffle-native-smooth/engine/manifest.json",
    "before": {
      "bytes": 71812,
      "sha256": "df8c7e72e90a3c5d1c8bb6a701bd86aff85fe1872f909aa19a200ff85bf22e76"
    }
  }
]) {
    const actual = read(record.path), previous = restoreV14aSource(record.path, actual);
    assert.deepEqual(identity(previous), record.before, record.path);
  }
  for (const key of ['schema', 'engineVariant', 'sourceRevision', 'upstream', 'parentSource',
    'unchangedParentFiles', 'limits', 'qualification']) assert.deepEqual(engine[key], v14a[key], key);
  const scope = { ...engine.integrationScope };
  delete scope.graphPaths; delete scope.displayLookup;
  assert.deepEqual(scope, v14a.integrationScope);
  assert.equal(Object.keys(SMOOTH_UPSTREAM_BASELINES).length, 12);
  for (const path of ['core/src/avm1/object.rs', 'core/src/avm1/object/script_object.rs',
    'core/src/avm1/globals/boxhead_native_graph.rs'])
    assert.deepEqual(origin(engine.files.find(row => row.path === path)), origin(v14a.files.find(row => row.path === path)));
});

test('source normalization rejects mutations, predecessor input, type confusion, unknown paths and weakened graph/lookup guards', () => {
  const text = read('tests/scripts/fixtures/native-v15-source-delta.json');
  assert.deepEqual(identity(text), {
  "bytes": 76365,
  "sha256": "6a837b6a0a2eeb517bfb9e019650d54be39b1db2816e9345017dfdc830ad17de"
});
  assert.deepEqual(identity(read('tests/scripts/fixtures/native-v15-source.mjs')), {
  "bytes": 1543,
  "sha256": "cabac47a80d48c86e46b1aac25cb2e42755dc06e9eed3544ee28112312662311"
});
  const data = JSON.parse(text); assert.equal(data.files.length, 10);
  for (const record of data.files) {
    const source = read(record.path);
    assert.deepEqual(identity(source), record.candidate);
    const old = restoreV14aSource(record.path, source);
    assert.deepEqual(identity(old), record.before);
    const altered = (source[0] === '!' ? '?' : '!') + source.slice(1);
    for (const bad of [altered, source + '\n', old, Buffer.from(source), { toString: () => source }, null])
      assert.throws(() => restoreV14aSource(record.path, bad));
    assert.throws(() => restoreV14aSource('unreviewed/' + record.path, source));
    assert.throws(() => restoreV14aSource({ toString: () => record.path }, source));
  }
  const path = engineRoot + 'core/src/avm1/globals/boxhead_native_graph.rs', graph = read(path);
  for (const [before, after] of [
    ['if self.values.len() < MAX_ANCHORS {', 'if self.values.len() <= MAX_ANCHORS {'],
    ['activation.context.update_start.elapsed() >= activation.context.max_execution_duration', 'false'],
  ]) {
    assert.equal(graph.split(before).length, 2);
    assert.throws(() => restoreV14aSource(path, graph.replace(before, after)));
  }
});

test('new historical successor suites restore every old body while the original anchor package and v12 suite remain unchanged', () => {
  for (const row of [
  {
    "path": "tests/scripts/native-v15-anchor-dependency.test.mjs",
    "before": {
      "bytes": 9417,
      "sha256": "e1fb1767a402a0ffdd58bcc846fa7a21143de5010f9c3eef39bc5d08b5ec43c1"
    },
    "beforePath": "tools/ruffle-native-anchor-inline/source-integrity.test.mjs"
  },
  {
    "path": "tests/scripts/native-v15-v12-normalization.test.mjs",
    "before": {
      "bytes": 6358,
      "sha256": "d45bc010b88a65931359f8dd8af7afa09a9bd5125a161b4ce4bec99f6fca3158"
    },
    "beforePath": "tests/scripts/native-v12-normalization.test.mjs"
  }
]) {
    const original = read(row.beforePath), successor = read(row.path);
    assert.deepEqual(identity(original), row.before);
    assert.equal(restoreV14aSource(row.path, successor), original);
    assert.equal((successor.match(/^test\(/gm) ?? []).length, 5);
    assert.equal((original.match(/^test\(/gm) ?? []).length, 5);
  }
  for (const row of [
  {
    "path": "tests/scripts/fixtures/native-v12-source.mjs",
    "bytes": 3366,
    "sha256": "3de8a81cee3bf3739e2cca76bd2e76ee7a5426a8a71b643767b6d0b56690dc12"
  },
  {
    "path": "tests/scripts/fixtures/native-v12-source-delta.json",
    "bytes": 60861,
    "sha256": "e1c80508c711954b9f58d6e4cdc43178e951bb6e897e3e56257e73bc4138ce92"
  },
  {
    "path": "tests/scripts/fixtures/native-v13-source.mjs",
    "bytes": 1499,
    "sha256": "e09e0b89e2acd53ee456511fbeb7d1e1cb224230e83b14e96d2cffac8b766126"
  },
  {
    "path": "tests/scripts/fixtures/native-v13-source-delta.json",
    "bytes": 10093,
    "sha256": "7f0e1da58fdcdd4fc38e1559bd60beb44df2b883b6ee6f2c22053a5264d09eb4"
  },
  {
    "path": "tests/scripts/fixtures/native-v14-source.mjs",
    "bytes": 1538,
    "sha256": "5834a9f2f5709b4adae41f64f6593e3dee019c1ee4d220d145dd6c29a20fa924"
  },
  {
    "path": "tests/scripts/fixtures/native-v14-source-delta.json",
    "bytes": 53315,
    "sha256": "5fa92f34079a9b658b47d8b3b20879ed7906f6c96de164f773645d4ca40f944c"
  },
  {
    "path": "tools/ruffle-native-anchor-inline/source-inventory.json",
    "bytes": 6979,
    "sha256": "af0b81d0a8405b0480d5cff8abf5623dd67879a9496bde8f31a2f30a2d2756d1"
  },
  {
    "path": "tools/ruffle-native-anchor-inline/source-integrity.test.mjs",
    "bytes": 9417,
    "sha256": "e1fb1767a402a0ffdd58bcc846fa7a21143de5010f9c3eef39bc5d08b5ec43c1"
  },
  {
    "path": "tests/scripts/native-v12-normalization.test.mjs",
    "bytes": 6358,
    "sha256": "d45bc010b88a65931359f8dd8af7afa09a9bd5125a161b4ce4bec99f6fca3158"
  }
])
    assert.deepEqual(identity(read(row.path)), { bytes: row.bytes, sha256: row.sha256 }, row.path);
});

test('driver, complete vendor/Cargo closure, parser and exact ignored-source exception remain unchanged', () => {
  for (const row of [
  {
    "path": "tools/ruffle-native-smooth/build.py",
    "bytes": 16458,
    "sha256": "e72554fe684dbaaf4fb97838f6cc2b35ff72d72b40f537b5583a0de68f35093d"
  },
  {
    "path": "tools/ruffle-native-smooth/apply-overlay.py",
    "bytes": 3524,
    "sha256": "eb03f0165f7d6297d87ee71eb1d7a43b538efa19ab1454149cae7f73e28e25c6"
  },
  {
    "path": "tools/ruffle-native-compact-fence/source-integrity.test.mjs",
    "bytes": 5295,
    "sha256": "bc020dbfe0c4941d85d3a78f3985bd2de1351f4581b041e26f7651e2d87cbae6"
  },
  {
    "path": "tools/ruffle-native-compact-fence/source-inventory.json",
    "bytes": 7436,
    "sha256": "57ea50cca0cdc64832a3f5d689f50c3ca3eaadb4362fe6623e0ca168bdea053c"
  },
  {
    "path": "tests/scripts/checkpoint-browser-url.test.mjs",
    "bytes": 6526,
    "sha256": "1e47dadbfc41f42cf90cca7313e36a2aa8ce663d1f1b480c7cd485760822f4f0"
  },
  {
    "path": "tests/scripts/checkpoint-server-pacer-binding.test.mjs",
    "bytes": 5018,
    "sha256": "41378181895d5acdfa5429d370443bf0a4abea5adbd160148a85b04d3a65240f"
  },
  {
    "path": "tests/scripts/original-checkpoint-profile-phased.test.mjs",
    "bytes": 44775,
    "sha256": "7877b5e09abe476f3679304bb19bfe90ebc70f6f3a17cfdb8d727b52edc04f87"
  },
  {
    "path": "tests/scripts/four-pose-source.test.mjs",
    "bytes": 5490,
    "sha256": "5214fca64137544d8a2f803349939a0a6ac5a2a7fc11dce6cee026c9986a2d77"
  }
])
    assert.deepEqual(identity(read(row.path)), { bytes: row.bytes, sha256: row.sha256 }, row.path);
  assert.equal(SMOOTH_RUNTIME_PINS.buildDriver, 'e72554fe684dbaaf4fb97838f6cc2b35ff72d72b40f537b5583a0de68f35093d');
  const lock = 'third_party/boxhead-gc-arena/Cargo.lock';
  assert.deepEqual(SMOOTH_DECLARED_IGNORED_SOURCES, { [lock]: { bytes: 16008,
    sha256: 'aae89dd5e83905c9688a54585a5135270cbc9ba1a3ad3062547a030eda5403c6' } });
  assert.deepEqual(identity(read(engineRoot + lock)), SMOOTH_DECLARED_IGNORED_SOURCES[lock]);
  const vendor = v14a.files.filter(row => row.path.startsWith('third_party/boxhead-gc-arena/'));
  assert.equal(vendor.length, 47);
  for (const path of ['Cargo.toml', 'Cargo.lock', ...vendor.map(row => row.path)])
    assert.deepEqual(engine.files.find(row => row.path === path), v14a.files.find(row => row.path === path), path);
  for (const path of [
  "swf/src/avm1/read.rs",
  "swf/src/avm1/types.rs",
  "swf/src/avm1/opcode.rs",
  "swf/src/extensions.rs",
  "core/common/src/tag_utils.rs"
]) assert(!engine.files.some(row => row.path === path), path);
});
