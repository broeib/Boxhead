import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { restoreV13Source } from './fixtures/native-v14-source.mjs';
import { restoreV14aSource } from './fixtures/native-v15-source.mjs';
import { SMOOTH_RUNTIME_PINS, SMOOTH_OVERLAY_PATHS, SMOOTH_UPSTREAM_BASELINES,
  SMOOTH_DECLARED_IGNORED_SOURCES } from '../../scripts/lib/native-smooth-runtime-binding.mjs';

const root = new URL('../../', import.meta.url);
const readCurrent = path => readFileSync(new URL(path, root), 'utf8');
const v15ChangedSourcePaths = new Set([
  "tools/ruffle-native-smooth/engine/manifest.json",
  "scripts/lib/native-smooth-runtime-binding.mjs",
  "tests/scripts/native-smooth-runtime-binding.test.mjs",
  "tests/scripts/native-v13-gc-integration.test.mjs",
  "tools/ruffle-native-smooth/engine/core/src/avm1/globals/boxhead_native_graph.rs",
  "tools/ruffle-native-smooth/engine/core/src/avm1/object.rs",
  "tools/ruffle-native-smooth/engine/core/src/avm1/object/script_object.rs"
]);
const read = path => {
  const source = readCurrent(path);
  return v15ChangedSourcePaths.has(path) ? restoreV14aSource(path, source) : source;
};
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = source => ({ bytes: Buffer.byteLength(source), sha256: sha(source) });
const engineRoot = 'tools/ruffle-native-smooth/engine/';
const currentEngineText = readCurrent(engineRoot + 'manifest.json');
const engineText = read(engineRoot + 'manifest.json'), engine = JSON.parse(engineText);
const v13Text = read('tests/scripts/fixtures/native-smooth-v13-manifest.json');
assert.deepEqual(identity(v13Text), { bytes: 65954,
  sha256: '487588b8c0d594705ef43a970a875591ba74d5b010756f525b7eab6c7e9d2189' });
const v13 = JSON.parse(v13Text);
const origin = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'bytes' && key !== 'sha256'));
const packages = [
  ['tools/ruffle-native-anchor-inline/', 6979,
    'af0b81d0a8405b0480d5cff8abf5623dd67879a9496bde8f31a2f30a2d2756d1', 3],
  ['tools/ruffle-native-single-push/', 9034,
    'be6e42336a883109643ba4080854b0198869ee6cca747497f1def557253ff02c', 5],
].map(([path, bytes, sha256, count]) => {
  const source = read(path + 'source-inventory.json');
  assert.deepEqual(identity(source), { bytes, sha256 });
  return { path, count, inventory: JSON.parse(source) };
});

test('v14 binds both frozen packages and preserves every other qualified v13 overlay', () => {
  assert.equal(sha(currentEngineText), SMOOTH_RUNTIME_PINS.engineManifest);
  assert.equal(engine.files.length, 99); assert.equal(SMOOTH_OVERLAY_PATHS.length, 103);
  assert.equal(engine.files.filter(row => row.baselineAbsent).length, 80);
  const overlaid = new Set();
  for (const { path, count, inventory } of packages) {
    assert.equal(inventory.integrated, false);
    assert.equal(inventory.files.length, count);
    for (const expected of inventory.files) {
      assert(!overlaid.has(expected.path)); overlaid.add(expected.path);
      const packaged = read(path + 'engine/' + expected.path);
      const actual = read(engineRoot + expected.path);
      assert.equal(actual, packaged, expected.path);
      assert.deepEqual(identity(actual), { bytes: expected.bytes, sha256: expected.sha256 });
      const row = engine.files.find(row => row.path === expected.path);
      assert.deepEqual({ bytes: row.bytes, sha256: row.sha256 }, identity(actual));
      const old = v13.files.find(row => row.path === expected.path);
      if (old) {
        assert.deepEqual(expected.baseline, { bytes: old.bytes, sha256: old.sha256 });
        assert.deepEqual(origin(row), origin(old), 'Review predecessor must not replace the installation baseline');
        assert.deepEqual(identity(restoreV13Source(engineRoot + expected.path, actual)), expected.baseline);
      } else {
        assert.equal(expected.baselineAbsent, true); assert.equal(row.baselineAbsent, true);
        assert.equal(row.baselineSha256, undefined); assert.equal(row.baselineBytes, undefined);
      }
    }
    for (const row of inventory.supportFiles)
      assert.deepEqual(identity(read(path + row.path)), { bytes: row.bytes, sha256: row.sha256 }, row.path);
  }
  assert.equal(overlaid.size, 8);
  const retained = v13.files.filter(row => !overlaid.has(row.path));
  assert.equal(retained.length, 91);
  for (const expected of retained) {
    assert.deepEqual(engine.files.find(row => row.path === expected.path), expected);
    assert.deepEqual(identity(read(engineRoot + expected.path)), { bytes: expected.bytes, sha256: expected.sha256 });
  }
  assert.deepEqual(engine.files.filter(row => !v13.files.some(old => old.path === row.path)).map(row => row.path).sort(),
    packages.flatMap(({ inventory }) => inventory.files.filter(row => row.baselineAbsent).map(row => row.path)).sort());
});

test('all294 exact mandatory v13 fixtures remain and only six anchor plus24 Push fixtures are added', () => {
  assert.equal(engine.rustUnitGroups.length, 16); assert.equal(engine.totalRequiredRustTests, 324);
  assert.deepEqual(engine.rustUnitGroups.slice(1, 15), v13.rustUnitGroups.slice(1));
  const graph = engine.rustUnitGroups[0], oldGraph = v13.rustUnitGroups[0];
  assert.deepEqual({ ...graph, expectedExecuted: 37, expectedPassed: 37, exactNames: graph.exactNames.slice(0, 37) }, oldGraph);
  assert.equal(graph.expectedExecuted, 43); assert.equal(graph.expectedPassed, 43);
  assert.deepEqual(graph.exactNames.slice(37), packages[0].inventory.rustFixtureGroup.addedExactNames
    .map(name => 'avm1::globals::boxhead_native_graph::inline_tests::' + name));
  const push = packages[1].inventory.rustFixtureGroup;
  assert.equal(push.executedExpected, 24); assert.equal(push.ignoredExpected, 0);
  assert.deepEqual(engine.rustUnitGroups[15], { label: 'single_push', filter: 'single_push_',
    expectedExecuted: 24, expectedPassed: 24, expectedFailed: 0, expectedIgnored: 0, exactNames: push.fullNames });
  assert.equal(engine.rustUnitGroups.reduce((sum, group) => sum + group.expectedIgnored, 0), 1);
  assert.deepEqual(engine.rustUnitGroups.filter(group => group.expectedIgnored), v13.rustUnitGroups.filter(group => group.expectedIgnored));
  const names = engine.rustUnitGroups.flatMap(group => group.exactNames);
  assert.equal(names.length, 324); assert.equal(new Set(names).size, 324);
  for (const name of v13.rustUnitGroups.flatMap(group => group.exactNames)) assert(names.includes(name), name);
});

test('the complete manifest, binder and historical support layers restore their exact v13 predecessors', () => {
  assert.equal(restoreV13Source(engineRoot + 'manifest.json', engineText), v13Text);
  for (const [path, bytes, sha256] of [
    ['scripts/lib/native-smooth-runtime-binding.mjs', 66227,
      '65aa426db3376d32bb926a5606e77bb94374ca0a0b05b9006976fbf903a96adb'],
    ['tests/scripts/native-smooth-runtime-binding.test.mjs', 49492,
      '0098c3e54397a852e34eca354b81e5b1f4f63f725844ee5050f3d7832eaf4a11'],
    ['tests/scripts/native-v13-gc-integration.test.mjs', 15895,
      'dfdc8835b89700c554a67e57fa98c6c13557d89b9fbe0230874660aa3fb8b940'],
  ]) assert.deepEqual(identity(restoreV13Source(path, read(path))), { bytes, sha256 });
  for (const key of ['schema', 'engineVariant', 'sourceRevision', 'upstream', 'parentSource',
    'unchangedParentFiles', 'limits', 'qualification']) assert.deepEqual(engine[key], v13[key], key);
  const scope = { ...engine.integrationScope };
  delete scope.anchorInline; delete scope.singlePush;
  scope.activation = v13.integrationScope.activation;
  assert.deepEqual(scope, v13.integrationScope);
  assert.equal(Object.keys(SMOOTH_UPSTREAM_BASELINES).length, 12);
  const activation = engine.files.find(row => row.path === 'core/src/avm1/activation.rs');
  assert.equal(activation.baselineBytes, 125386);
  assert.equal(activation.baselineSha256, '88d48f22b33f01091d837fc097ca66bf528edee2f8b648331dc8b59c97ba789d');
  for (const row of packages[1].inventory.preservedUpstream) assert(!engine.files.some(file => file.path === row.path));
});

test('normalization rejects unreviewed candidate bytes, predecessor input, types, paths and weakened guards', () => {
  const dataText = read('tests/scripts/fixtures/native-v14-source-delta.json');
  assert.deepEqual(identity(dataText), { bytes: 53315, sha256: '5fa92f34079a9b658b47d8b3b20879ed7906f6c96de164f773645d4ca40f944c' });
  assert.deepEqual(identity(read('tests/scripts/fixtures/native-v14-source.mjs')),
    { bytes: 1538, sha256: '5834a9f2f5709b4adae41f64f6593e3dee019c1ee4d220d145dd6c29a20fa924' });
  const delta = JSON.parse(dataText);
  assert.equal(delta.files.length, 6);
  for (const record of delta.files) {
    const source = read(record.path);
    assert.deepEqual(identity(source), record.candidate);
    const old = restoreV13Source(record.path, source);
    assert.deepEqual(identity(old), record.before);
    const altered = (source[0] === '!' ? '?' : '!') + source.slice(1);
    for (const bad of [altered, source + '\n', old, Buffer.from(source), { toString: () => source }, null])
      assert.throws(() => restoreV13Source(record.path, bad));
    assert.throws(() => restoreV13Source('unreviewed/' + record.path, source));
    assert.throws(() => restoreV13Source({ toString: () => record.path }, source));
  }
  const graphPath = engineRoot + 'core/src/avm1/globals/boxhead_native_graph.rs';
  const graph = read(graphPath);
  for (const [before, after] of [
    ['if self.values.len() < MAX_ANCHORS {', 'if self.values.len() <= MAX_ANCHORS {'],
    ['activation.context.update_start.elapsed() >= activation.context.max_execution_duration', 'false'],
  ]) {
    assert.equal(graph.split(before).length, 2);
    assert.throws(() => restoreV13Source(graphPath, graph.replace(before, after)));
  }
});

test('the reviewed v13 driver, ignored lock, Cargo closure and earlier source proof files remain unchanged', () => {
  for (const [path, bytes, sha256] of [
    ['tools/ruffle-native-smooth/build.py', 16458, 'e72554fe684dbaaf4fb97838f6cc2b35ff72d72b40f537b5583a0de68f35093d'],
    ['tools/ruffle-native-smooth/apply-overlay.py', 3524, 'eb03f0165f7d6297d87ee71eb1d7a43b538efa19ab1454149cae7f73e28e25c6'],
    ['tests/scripts/native-v12-normalization.test.mjs', 6358, 'd45bc010b88a65931359f8dd8af7afa09a9bd5125a161b4ce4bec99f6fca3158'],
    ['tests/scripts/fixtures/native-v12-source.mjs', 3366, '3de8a81cee3bf3739e2cca76bd2e76ee7a5426a8a71b643767b6d0b56690dc12'],
    ['tests/scripts/fixtures/native-v12-source-delta.json', 60861, 'e1c80508c711954b9f58d6e4cdc43178e951bb6e897e3e56257e73bc4138ce92'],
    ['tests/scripts/fixtures/native-v13-source.mjs', 1499, 'e09e0b89e2acd53ee456511fbeb7d1e1cb224230e83b14e96d2cffac8b766126'],
    ['tests/scripts/fixtures/native-v13-source-delta.json', 10093, '7f0e1da58fdcdd4fc38e1559bd60beb44df2b883b6ee6f2c22053a5264d09eb4'],
    ['tools/ruffle-native-compact-fence/source-integrity.test.mjs', 5295, 'bc020dbfe0c4941d85d3a78f3985bd2de1351f4581b041e26f7651e2d87cbae6'],
    ['tools/ruffle-native-compact-fence/source-inventory.json', 7436, '57ea50cca0cdc64832a3f5d689f50c3ca3eaadb4362fe6623e0ca168bdea053c'],
  ]) assert.deepEqual(identity(read(path)), { bytes, sha256 }, path);
  assert.equal(SMOOTH_RUNTIME_PINS.buildDriver, 'e72554fe684dbaaf4fb97838f6cc2b35ff72d72b40f537b5583a0de68f35093d');
  const lock = 'third_party/boxhead-gc-arena/Cargo.lock';
  assert.deepEqual(SMOOTH_DECLARED_IGNORED_SOURCES, { [lock]: { bytes: 16008,
    sha256: 'aae89dd5e83905c9688a54585a5135270cbc9ba1a3ad3062547a030eda5403c6' } });
  assert.deepEqual(identity(read(engineRoot + lock)), SMOOTH_DECLARED_IGNORED_SOURCES[lock]);
  for (const path of ['Cargo.toml', 'Cargo.lock', ...v13.files.filter(row => row.path.startsWith('third_party/boxhead-gc-arena/')).map(row => row.path)])
    assert.deepEqual(engine.files.find(row => row.path === path), v13.files.find(row => row.path === path), path);
});
