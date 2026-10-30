import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreReviewedGcSource } from '../../tools/ruffle-native-gc-slicing/source-normalization.mjs';
import { NATIVE_SMOOTH_ENGINE_VARIANT as VARIANT, NATIVE_SMOOTH_RUNTIME_SCHEMA, SMOOTH_RUNTIME_PINS as PINS,
  SMOOTH_OVERLAY_PATHS, SMOOTH_UPSTREAM_BASELINES, SMOOTH_DECLARED_IGNORED_SOURCES, SMOOTH_RESOURCE_SCOPE, SMOOTH_RESOURCE_WRAPPER,
  validateSmoothEngine, expectedSmoothSourceFiles,
  validateSmoothSourceProof, validateSmoothRustLogs, validateSmoothBuildDocuments,
  loadNativeGraphRuntimeInputs } from '../../scripts/lib/native-smooth-runtime-binding.mjs';

// Synthetic metadata and temporary-byte rejection fixtures only. They do not
// claim that the compiler, game or a real qualification bundle ran here.
const sha = value => createHash('sha256').update(value).digest('hex');
const engineBytes = readFileSync(new URL('../../tools/ruffle-native-smooth/engine/manifest.json', import.meta.url));
const engine = JSON.parse(engineBytes);
const v10Bytes = readFileSync(new URL('./fixtures/native-v10-engine-manifest.json', import.meta.url));
assert.equal(v10Bytes.length, 44549);
assert.equal(sha(v10Bytes), '93a9b0b9d8556514e106b8e0a948f8768fe33b3d3d956477c2475bc3994044b6');
const v10 = JSON.parse(v10Bytes);
const v12Bytes = readFileSync(new URL('./fixtures/native-smooth-v12-manifest.json', import.meta.url));
assert.equal(v12Bytes.length, 51220);
assert.equal(sha(v12Bytes), '836f160125fc12c7004fea1c02e4ff27b7fedad795d470d7f03ccedbb3502e72');
const v12 = JSON.parse(v12Bytes);
const gcInventoryBytes = readFileSync(new URL('../../tools/ruffle-native-gc-slicing/source-inventory.json', import.meta.url));
assert.equal(sha(gcInventoryBytes), '731114e3bbcab3b29fb37ef0ac5638cf8818bea814298521df18fdb1a4d32d0c');
const gcInventory = JSON.parse(gcInventoryBytes);
const gcChangedPaths = Object.freeze(['core/src/player.rs', 'core/src/player/boxhead_step_fence.rs',
  'core/src/avm1/globals/boxhead_step_fence.rs']);
function gcHistoricalBytes(name, bytes) {
  return gcChangedPaths.includes(name) ? Buffer.from(restoreReviewedGcSource(name, bytes.toString('utf8'))) : bytes;
}
function gcHistoricalRow(value) {
  assert(value);
  if (!gcChangedPaths.includes(value.path)) return value;
  const reviewed = gcInventory.files.find(row => row.path === value.path);
  assert.equal(value.bytes, reviewed.bytes); assert.equal(value.sha256, reviewed.sha256);
  const before = v12.files.find(row => row.path === value.path);
  return { ...value, bytes: before.bytes, sha256: before.sha256 };
}
const parent = JSON.parse(readFileSync(new URL('../../tools/ruffle-native-projector/engine/manifest.json', import.meta.url)));
const graphParent = JSON.parse(readFileSync(new URL('../../tools/ruffle-native-graph/engine/manifest.json', import.meta.url)));
const rec = (name, digest = sha(name), bytes = 123) => ({ file: '/synthetic/' + name, bytes, sha256: digest });
const time = seconds => new Date(Date.UTC(2026, 9, 28, 0, 0, seconds)).toISOString();
const row = value => ({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
const ignored = group => group.exactIgnoredNames ?? [];
const EXPECTED_TESTS = 294;
const EXPECTED_GROUPS = 15;
const EXPECTED_STAGE_LABELS = ['graph', 'scalar', 'projection', 'project', 'bitmap', 'hash', 'property', 'fence',
  'equality', 'overwrite', 'compact', 'lookup', 'packed', 'gc_slice', 'gc_fence', 'wasm', 'selfhosted'];

function documents() {
  const bindings = { engineManifest: rec('engine.json', PINS.engineManifest),
    parentRuntimeManifest: rec('parent-manifest.json', PINS.parentRuntimeManifest),
    parentBuildResult: rec('parent-result.json', PINS.parentBuildResult), buildPlan: rec('plan.json'),
    buildCapture: rec('capture.json'), sourceBefore: rec('before.json'), sourceAfter: rec('after.json'),
    rustFixtures: rec('fixtures.json'), versionSeal: rec('seal.json') };
  const files = Array.from({ length: 12 }, (_, index) => ({ file: index < 2 ? 'core-' + index + '.wasm'
    : index === 2 ? 'ruffle.js' : 'asset-' + index + '.js', bytes: 10, sha256: sha('new-file-' + index) }));
  const environment = { CARGO_HOME: '/cache/cargo', CARGO_NET_OFFLINE: 'true', npm_config_cache: '/cache/npm',
    CARGO_BUILD_JOBS: '2', CARGO_FEATURES: 'jpegxr', NODE_ENV: 'production', ENABLE_VERSION_SEAL: 'true',
    CFG_RELEASE_CHANNEL: 'boxhead-experiment', VERSION4: '0.6.0.0', BUILD_WASM_MVP: 'true' };
  const labels = [...engine.rustUnitGroups.map(group => group.label), 'wasm', 'selfhosted'];
  const stages = labels.map((label, index) => {
    const tail = index < EXPECTED_GROUPS ? ['python3', '-c', SMOOTH_RESOURCE_WRAPPER, 'cargo', 'test', '--offline', '--locked',
      '-p', 'ruffle_core', '--lib', engine.rustUnitGroups[index].filter, '--', '--test-threads=1']
      : ['npm', 'run', 'build', '--workspace=' + (index === EXPECTED_GROUPS ? 'ruffle-core' : 'ruffle-selfhosted')];
    return { label, cwd: '/synthetic/output', timeoutSeconds: 60,
      command: ['docker', 'run', '--rm', '--network', 'none', '--cpus', '2', '--memory', '6g',
        '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', 'type=bind,source=/synthetic/source,target=/work',
        '--mount', 'type=bind,source=/synthetic/cache,target=/cache',
        '--mount', 'type=bind,source=/synthetic/target,target=/work/target',
        '--workdir', index < EXPECTED_GROUPS ? '/work' : '/work/web', '--name', 'boxhead-smooth-123-' + label,
        ...Object.entries(environment).flatMap(([key, value]) => ['--env', key + '=' + value]), PINS.imageId, ...tail] };
  });
  const plan = { schema: 'boxhead-native-smooth-build-plan-v2', engineVariant: VARIANT,
    sourceCommit: PINS.sourceCommit, sourceRoot: '/synthetic/source', imageId: PINS.imageId,
    environment, resources: { cpus: 2, memory: '6g' }, engineManifest: bindings.engineManifest,
    parentRuntimeManifest: bindings.parentRuntimeManifest, parentBuildResult: bindings.parentBuildResult,
    sourceBefore: bindings.sourceBefore, versionSeal: bindings.versionSeal, driver: rec('build.py', PINS.buildDriver, 16458), stages };
  const capture = { schema: 'boxhead-native-smooth-build-capture-v2', engineVariant: VARIANT,
    pass: true, startedAt: time(1), finishedAt: time(labels.length * 2 + 1), buildPlan: bindings.buildPlan,
    sourceBefore: bindings.sourceBefore, sourceAfter: bindings.sourceAfter, rustFixtures: bindings.rustFixtures,
    stages: stages.map((stage, index) => ({ label: stage.label, command: [...stage.command], cwd: stage.cwd,
      startedAt: time(index * 2 + 1), finishedAt: time(index * 2 + 2), state: 'complete', returncode: 0,
      log: rec(stage.label + '.log') })) };
  const fixtures = { schema: 'boxhead-native-smooth-rust-fixtures-v2', engineVariant: VARIANT,
    engineManifest: bindings.engineManifest, totalExecuted: EXPECTED_TESTS, inheritedPasses: false,
    groups: engine.rustUnitGroups.map((group, index) => ({ label: group.label, filter: group.filter,
      executed: group.expectedExecuted, passed: group.expectedPassed, failed: 0, ignored: group.expectedIgnored,
      exactNames: [...group.exactNames], exactIgnoredNames: [...ignored(group)], log: capture.stages[index].log,
      resources: { maxRssKiB: 123456, scope: SMOOTH_RESOURCE_SCOPE } })) };
  const manifest = { schema: 'boxhead-ruffle-web-bundle-v1', engineVariant: VARIANT, arm: 'candidate',
    sourceCommit: PINS.sourceCommit, sourceAfterVerified: true, gameplayPassClaimed: false,
    performancePassClaimed: false, ...bindings, imageId: PINS.imageId, patchFiles: engine.files,
    wasmVariants: ['extensions', 'mvp'], files };
  const result = { schema: 'boxhead-native-smooth-build-result-v2', engineVariant: VARIANT, arm: 'candidate',
    compiled: true, sourceAfterVerified: true, gameplayPassClaimed: false, performancePassClaimed: false,
    captureRebuiltCompiler: true, preBuildCompleteSourceInventoryClaimed: true, manifest: rec('runtime/manifest.json'),
    engineManifest: bindings.engineManifest, buildPlan: bindings.buildPlan, buildCapture: bindings.buildCapture,
    sourceBefore: bindings.sourceBefore, sourceAfter: bindings.sourceAfter, rustFixtures: bindings.rustFixtures,
    files: structuredClone(files) };
  const parentManifest = { imageId: PINS.imageId, files: files.map((file, index) => ({ ...file, sha256: sha('parent-file-' + index) })) };
  return { manifest, result, plan, capture, fixtures, engine: structuredClone(engine), parentManifest };
}

function changeCommand(value, index, mutate) {
  const command = [...value.plan.stages[index].command]; mutate(command);
  value.plan.stages[index].command = command; value.capture.stages[index].command = [...command];
}

test('smooth engine has an explicit GC candidate pin, 93 overlay paths and all reviewed fixture groups', () => {
  assert.equal(sha(engineBytes), PINS.engineManifest);
  assert.equal(NATIVE_SMOOTH_RUNTIME_SCHEMA, 'boxhead-native-smooth-runtime-v2');
  assert.equal(SMOOTH_OVERLAY_PATHS.length, 93);
  assert.equal(engine.files.length, 93);
  assert.equal(validateSmoothEngine(engine, parent, graphParent).length, EXPECTED_TESTS);
  assert.deepEqual(engine.rustUnitGroups.slice(0, 11), v10.rustUnitGroups,
    'All original 237 exact fixture names/counts and the ignored diagnostic remain unchanged');
  assert.deepEqual(engine.rustUnitGroups.slice(0, 13), v12.rustUnitGroups,
    'All270 v12 names/counts remain exact; GC adds two separate groups');
  for (const mutate of [
    value => { value.engineVariant = parent.engineVariant; }, value => { value.sourceRevision = 1; },
    value => { value.parentSource.sha256 = '0'.repeat(64); }, value => { value.files.pop(); },
    value => { value.files[0].baselineSha256 = '0'.repeat(64); },
    value => { value.files.find(file => file.path === 'core/src/bitmap/operations.rs').baselineBytes--; },
    value => { value.files.find(file => file.baselineAbsent).baselineAbsent = false; },
    value => { value.unchangedParentFiles[0].sha256 = '0'.repeat(64); }, value => { value.limits.fields--; },
    value => { value.rustUnitGroups[0].exactNames[0] = value.rustUnitGroups[0].exactNames[1]; },
    value => { value.rustUnitGroups[0].expectedExecuted = value.rustUnitGroups[0].expectedPassed = 21;
      value.rustUnitGroups[0].exactNames = value.rustUnitGroups[0].exactNames.slice(0, 21); value.totalRequiredRustTests = 127; },
    value => { value.rustUnitGroups[1].exactNames.reverse(); },
    value => { value.rustUnitGroups[2].expectedExecuted--; },
    value => { value.rustUnitGroups[3].exactNames[0] = 'avm1::unreviewed::replacement'; },
    value => { const group = value.rustUnitGroups[3]; group.expectedExecuted = group.expectedPassed = 22;
      group.exactNames = group.exactNames.slice(0, 22); value.totalRequiredRustTests = 93; },
    value => { value.rustUnitGroups[4].expectedIgnored = 0; },
    value => { value.rustUnitGroups[4].exactIgnoredNames[0] = value.rustUnitGroups[4].exactNames[0]; },
    value => { value.rustUnitGroups[4].exactNames[0] = value.rustUnitGroups[4].exactNames[1]; },
    value => { value.rustUnitGroups[5].exactNames[0] = 'avm1::property_map::boxhead_hash_tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[6].exactNames[0] = 'avm1::object::boxhead_property_tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[7].exactNames[0] = 'player::boxhead_step_fence::tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[7].expectedPassed = value.rustUnitGroups[7].expectedExecuted = 33; value.rustUnitGroups[7].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups[8].exactNames[0] = 'avm1::property_map::boxhead_equality_tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[9].exactNames[0] = 'bitmap::operations::boxhead_overwrite_tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[10].exactNames[0] = 'avm1::globals::boxhead_step_fence::compact_tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[8].exactNames.reverse(); },
    value => { value.rustUnitGroups[9].exactNames.reverse(); },
    value => { value.rustUnitGroups[10].exactNames.reverse(); },
    value => { value.rustUnitGroups[8].expectedPassed = value.rustUnitGroups[8].expectedExecuted = 7;
      value.rustUnitGroups[8].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups[9].expectedPassed = value.rustUnitGroups[9].expectedExecuted = 14;
      value.rustUnitGroups[9].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups[10].expectedPassed = value.rustUnitGroups[10].expectedExecuted = 27;
      value.rustUnitGroups[10].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups[5].expectedPassed = value.rustUnitGroups[5].expectedExecuted = 8;
      value.rustUnitGroups[5].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups[6].expectedPassed = value.rustUnitGroups[6].expectedExecuted = 19;
      value.rustUnitGroups[6].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups = value.rustUnitGroups.slice(0, 5); value.totalRequiredRustTests = 98; },
    value => { value.rustUnitGroups = value.rustUnitGroups.slice(0, 8); value.totalRequiredRustTests = 186; },
    value => { value.rustUnitGroups = value.rustUnitGroups.slice(0, 10); value.totalRequiredRustTests = 209; },
    value => { value.rustUnitGroups[3].exactNames[0] = 'avm1::globals::boxhead_native_project::tests::unreviewed_replacement'; },
    value => { value.rustUnitGroups[4].exactNames[0] = 'bitmap::operations::boxhead_blit::tests::bitmap_blit_unreviewed_replacement'; },
    value => { value.rustUnitGroups[11].exactNames[0] = 'avm1::scope::boxhead_lookup_v2_tests::lookup_v2_unreviewed_replacement'; },
    value => { value.rustUnitGroups[12].exactNames[0] = 'bitmap::operations::boxhead_blit::packed_tests::bitmap_packed_unreviewed_replacement'; },
    value => { value.rustUnitGroups[11].exactNames.reverse(); },
    value => { value.rustUnitGroups[12].exactNames.reverse(); },
    value => { value.rustUnitGroups[11].expectedPassed = value.rustUnitGroups[11].expectedExecuted = 22;
      value.rustUnitGroups[11].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups[12].expectedPassed = value.rustUnitGroups[12].expectedExecuted = 9;
      value.rustUnitGroups[12].exactNames.pop(); value.totalRequiredRustTests--; },
    value => { value.rustUnitGroups = value.rustUnitGroups.slice(0, 11); value.totalRequiredRustTests = 237; },
    value => { value.rustUnitGroups = value.rustUnitGroups.slice(0, 12); value.totalRequiredRustTests = 260; },
    value => { value.totalRequiredRustTests = 237; },
    value => { value.totalRequiredRustTests = 260; },
    value => { value.totalRequiredRustTests = 186; },
    value => { value.totalRequiredRustTests = 209; },
    value => { value.totalRequiredRustTests = 98; },
    value => { value.totalRequiredRustTests = 99; }, value => { value.qualification.inheritedParentPassesAccepted = true; },
  ]) { const value = structuredClone(engine); mutate(value); assert.throws(() => validateSmoothEngine(value, parent, graphParent)); }
});

test('complete synthetic metadata binds all seventeen stages without claiming a compiler or gameplay run', () => {
  const value = documents(); validateSmoothBuildDocuments(value);
  assert.deepEqual(value.plan.stages.map(stage => stage.label), EXPECTED_STAGE_LABELS);
  assert.equal(value.fixtures.groups.reduce((total, group) => total + group.passed, 0), EXPECTED_TESTS);
  assert.equal(value.fixtures.groups.reduce((total, group) => total + group.ignored, 0), 1);
});

test('GC fixture families remain mandatory and cannot be replaced by old or self-consistent counts', () => {
  for (const index of [13, 14]) {
    for (const mutate of [
      group => { group.exactNames[0] = 'unreviewed::gc_replacement'; },
      group => { group.exactNames.reverse(); },
      group => { group.exactNames[0] = group.exactNames[1]; },
      group => { group.expectedPassed--; group.expectedExecuted--; group.exactNames.pop(); },
      group => { group.expectedIgnored = 1; group.exactIgnoredNames = ['unreviewed::ignored']; },
      group => { group.filter = 'gc_'; },
    ]) {
      const value = structuredClone(engine); mutate(value.rustUnitGroups[index]);
      value.totalRequiredRustTests = value.rustUnitGroups.reduce((sum, group) => sum + group.expectedPassed, 0);
      assert.throws(() => validateSmoothEngine(value, parent, graphParent));
    }
    for (const mutate of [
      group => { group.log = rec('old-gc.log'); },
      group => { group.exactNames.pop(); },
      group => { group.exactNames[0] = group.exactNames[1]; },
      group => { group.executed--; group.passed--; },
      group => { group.failed = 1; },
      group => { group.ignored = 1; },
      group => { group.exactIgnoredNames = ['unreviewed::ignored']; },
      group => { group.resources.maxRssKiB = 0; },
    ]) {
      const value = documents(); mutate(value.fixtures.groups[index]);
      value.fixtures.totalExecuted = value.fixtures.groups.reduce((sum, group) => sum + group.executed, 0);
      assert.throws(() => validateSmoothBuildDocuments(value));
    }
  }
  const former = structuredClone(engine);
  former.rustUnitGroups = former.rustUnitGroups.slice(0, 13); former.totalRequiredRustTests = 270;
  assert.throws(() => validateSmoothEngine(former, parent, graphParent));
  const reports = documents(); reports.fixtures.groups = reports.fixtures.groups.slice(0, 13);
  reports.fixtures.totalExecuted = 270;
  assert.throws(() => validateSmoothBuildDocuments(reports));
});

test('the six integrated equality and bitmap sources exactly match both reviewed frozen packages', () => {
  const packages = [
    ['ruffle-native-property-equality', 'b6ae1deb326366019e7412f4a5feb62fee52c2906871b6e5b313445d54137428', 8],
    ['ruffle-native-bitmap-overwrite', 'ab0ca489efe3dc3d281b307f421c4af98ac134ff19cb1c9500893af78e19eeb5', 9],
  ];
  const integratedPaths = new Set();
  for (const [packageName, inventorySha, groupIndex] of packages) {
    const packageRoot = new URL('../../tools/' + packageName + '/', import.meta.url);
    const inventoryBytes = readFileSync(new URL('source-inventory.json', packageRoot));
    assert.equal(sha(inventoryBytes), inventorySha);
    const inventory = JSON.parse(inventoryBytes);
    assert.equal(inventory.files.length, 3);
    assert.equal(engine.rustUnitGroups[groupIndex].expectedPassed, inventory.rustFixtureGroup.executedExpected);
    assert.equal(engine.rustUnitGroups[groupIndex].filter, inventory.rustFixtureGroup.filter);
    assert.deepEqual(engine.rustUnitGroups[groupIndex].exactNames.map(name => name.split('::').at(-1)),
      inventory.rustFixtureGroup.exactNames);
    for (const expected of inventory.files) {
      assert(!integratedPaths.has(expected.path)); integratedPaths.add(expected.path);
      const packaged = readFileSync(new URL('engine/' + expected.path, packageRoot));
      const integrated = readFileSync(new URL('../../tools/ruffle-native-smooth/engine/' + expected.path, import.meta.url));
      const actual = engine.files.find(file => file.path === expected.path);
      assert.deepEqual(integrated, packaged, expected.path);
      assert.equal(integrated.length, expected.bytes); assert.equal(sha(integrated), expected.sha256);
      assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256);
      if (expected.baselineAbsent) assert.equal(actual.baselineAbsent, true);
      else {
        const upstream = SMOOTH_UPSTREAM_BASELINES[expected.path];
        assert.equal(actual.baselineBytes, upstream.bytes); assert.equal(actual.baselineSha256, upstream.sha256);
        assert.notEqual(actual.baselineSha256, expected.baseline.sha256,
          'Review-delta v8 baseline must not replace the original upstream installation baseline');
      }
    }
  }
  assert.equal(integratedPaths.size, 6);
});

test('the eleven lookup and packed overlay bytes match both fixed packages and preserve installation baselines', () => {
  const packages = [
    ['ruffle-native-lookup-v2', 'e3eea3caed2bf2fe9ce479ef39a62d571dd5d04418595c56d98c316554c64021',
      11, 'avm1::scope::boxhead_lookup_v2_tests::', 7],
    ['ruffle-native-packed-blit', '91f76118bf140ed8c5ea60bb8b1b17b88a26002e7bf3498c43e5d713286273ee',
      12, 'bitmap::operations::boxhead_blit::packed_tests::', 4],
  ];
  const integratedPaths = new Set();
  for (const [packageName, inventorySha, groupIndex, prefix, count] of packages) {
    const packageRoot = new URL('../../tools/' + packageName + '/', import.meta.url);
    const inventoryBytes = readFileSync(new URL('source-inventory.json', packageRoot));
    assert.equal(sha(inventoryBytes), inventorySha);
    const inventory = JSON.parse(inventoryBytes);
    assert.equal(inventory.files.length, count);
    assert.deepEqual(inventory.baselineEngineManifest ?? inventory.baseEngineManifest,
      { path: 'tools/ruffle-native-smooth/engine/manifest.json', bytes: v10Bytes.length, sha256: sha(v10Bytes) });
    const group = engine.rustUnitGroups[groupIndex];
    assert.equal(group.expectedPassed, inventory.rustFixtureGroup.executedExpected);
    assert.equal(group.expectedIgnored, 0);
    assert.equal(group.filter, inventory.rustFixtureGroup.filter);
    assert.deepEqual(group.exactNames, inventory.rustFixtureGroup.exactNames.map(name => prefix + name));
    for (const expected of inventory.files) {
      assert(!integratedPaths.has(expected.path)); integratedPaths.add(expected.path);
      const packaged = readFileSync(new URL('engine/' + expected.path, packageRoot));
      const integrated = readFileSync(new URL('../../tools/ruffle-native-smooth/engine/' + expected.path, import.meta.url));
      const actual = engine.files.find(file => file.path === expected.path);
      assert(actual, expected.path);
      assert.deepEqual(integrated, packaged, expected.path);
      assert.equal(integrated.length, expected.bytes); assert.equal(sha(integrated), expected.sha256);
      assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256);
      const old = v10.files.find(file => file.path === expected.path);
      if (old) {
        assert.deepEqual(expected.baseline, { bytes: old.bytes, sha256: old.sha256 });
        const origin = value => Object.fromEntries(Object.entries(value)
          .filter(([key]) => key !== 'bytes' && key !== 'sha256'));
        assert.deepEqual(origin(actual), origin(old),
          'A review-delta v10 baseline must not replace the original installation baseline');
      } else if (expected.path === 'core/src/avm1/scope.rs') {
        assert.deepEqual(expected.baseline, SMOOTH_UPSTREAM_BASELINES[expected.path]);
        assert.equal(actual.baselineBytes, 9350);
        assert.equal(actual.baselineSha256, '85d7998c61e2f65c0c77116799ad32dc7f04f231a4f6d81a2829ee777dffbd2d');
        assert.equal(actual.baselineAbsent, undefined);
      } else {
        assert.equal(expected.baselineAbsent, true); assert.equal(actual.baselineAbsent, true);
        assert.equal(actual.baselineSha256, undefined); assert.equal(actual.baselineBytes, undefined);
      }
    }
  }
  assert.equal(integratedPaths.size, 11);
  for (const old of v10.files) {
    if (!integratedPaths.has(old.path)) assert.deepEqual(gcHistoricalRow(engine.files.find(file => file.path === old.path)), old);
  }
  assert.deepEqual(engine.unchangedParentFiles, v10.unchangedParentFiles);
  assert.deepEqual(engine.limits, v10.limits);
  assert.deepEqual(engine.parentSource, v10.parentSource);
  assert.deepEqual(engine.qualification, v10.qualification);
});

test('the five compact overlays match the pinned optional protocol package and retain all full fixtures', () => {
  const packageRoot = new URL('../../tools/ruffle-native-compact-fence/', import.meta.url);
  const inventoryBytes = readFileSync(new URL('source-inventory.json', packageRoot));
  assert.equal(sha(inventoryBytes), '57ea50cca0cdc64832a3f5d689f50c3ca3eaadb4362fe6623e0ca168bdea053c');
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.files.length, 5);
  assert.equal(inventory.retainedFunctionalTests, 209);
  assert.equal(inventory.retainedFullFenceFixtures, 35);
  assert.equal(engine.rustUnitGroups[10].filter, 'compact_fence_');
  assert.equal(engine.rustUnitGroups[10].expectedPassed, 28);
  assert.deepEqual(engine.rustUnitGroups[10].exactNames, inventory.rustFixtureGroup.exactNames);
  for (const expected of inventory.files) {
    const packaged = readFileSync(new URL('engine/' + expected.path, packageRoot));
    const integrated = readFileSync(new URL('../../tools/ruffle-native-smooth/engine/' + expected.path, import.meta.url));
    const current = engine.files.find(file => file.path === expected.path);
    assert.equal(integrated.length, current.bytes); assert.equal(sha(integrated), current.sha256);
    const historical = gcHistoricalBytes(expected.path, integrated), actual = gcHistoricalRow(current);
    assert.deepEqual(historical, packaged, expected.path);
    assert.equal(historical.length, expected.bytes); assert.equal(sha(historical), expected.sha256);
    assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256);
    if (expected.baselineAbsent) assert.equal(actual.baselineAbsent, true);
  }
  for (const expected of inventory.retainedSource) {
    const bytes = gcHistoricalBytes(expected.path, readFileSync(new URL('../../tools/ruffle-native-smooth/engine/' + expected.path, import.meta.url)));
    assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256);
  }
});

test('upstream replacement baselines are explicit and inherited scanner/object files are overlaid', () => {
  assert.equal(Object.keys(SMOOTH_UPSTREAM_BASELINES).length, 12);
  assert.deepEqual(SMOOTH_UPSTREAM_BASELINES['core/src/avm1/scope.rs'], { bytes: 9350,
    sha256: '85d7998c61e2f65c0c77116799ad32dc7f04f231a4f6d81a2829ee777dffbd2d' });
  assert.deepEqual(SMOOTH_UPSTREAM_BASELINES['core/src/avm1/object.rs'], { bytes: 17992,
    sha256: 'b672d142ad23793f6ef95b4a505735458ca33b75b5b92488ddefbc5451eaa3a7' });
  const inherited = [...parent.files, ...parent.unchangedParentFiles];
  for (const [name, baseline] of Object.entries(SMOOTH_UPSTREAM_BASELINES)) {
    assert(!inherited.some(file => file.path === name), 'fixture must exercise an upstream file outside the parent overlay');
    const replacement = engine.files.find(file => file.path === name);
    assert.equal(replacement.baselineBytes, baseline.bytes); assert.equal(replacement.baselineSha256, baseline.sha256);
    for (const mutate of [
      file => { file.baselineBytes++; }, file => { file.baselineSha256 = sha('unreviewed baseline ' + name); },
      file => { delete file.baselineBytes; delete file.baselineSha256; file.baselineAbsent = true; },
    ]) {
      const value = structuredClone(engine); mutate(value.files.find(file => file.path === name));
      assert.throws(() => validateSmoothEngine(value, parent, graphParent));
    }
  }
  for (const name of ['core/src/avm1/globals/boxhead_native_projection_scan.rs', 'core/src/avm1/object/script_object.rs']) {
    assert(engine.files.some(file => file.path === name));
    assert(!engine.unchangedParentFiles.some(file => file.path === name));
    const value = structuredClone(engine);
    value.unchangedParentFiles.push(row(inherited.find(file => file.path === name)));
    assert.throws(() => validateSmoothEngine(value, parent, graphParent));
  }
});

test('old provenance, inherited passes, relabeled parent WASM and changed runtime inventories fail closed', () => {
  for (const mutate of [
    value => { value.manifest.engineVariant = parent.engineVariant; },
    value => { value.manifest.engineManifest.sha256 = sha(v12Bytes); },
    value => { value.plan.driver.sha256 = '7214fc10be4bd3a586c63b005b0157d52df2843ebc5321d23ca2df6acf9de6c0'; },
    value => { value.plan.driver.sha256 = sha('runtime selected driver'); },
    value => { value.result.schema = 'boxhead-native-projector-build-result-v1'; },
    value => { value.manifest.engineManifest.sha256 = PINS.parentEngineManifest; },
    value => { value.manifest.parentRuntimeManifest.sha256 = '0'.repeat(64); },
    value => { value.manifest.parentBuildResult.sha256 = '0'.repeat(64); },
    value => { value.manifest.files[0].sha256 = value.parentManifest.files[0].sha256;
      value.result.files[0].sha256 = value.parentManifest.files[0].sha256; },
    value => { value.manifest.files[1].file = value.manifest.files[0].file; },
    value => { value.manifest.wasmVariants = ['extensions']; },
    value => { value.result.captureRebuiltCompiler = false; },
    value => { value.result.preBuildCompleteSourceInventoryClaimed = false; },
    value => { value.fixtures.inheritedPasses = true; }, value => { value.manifest.performancePassClaimed = true; },
    value => { value.result.gameplayPassClaimed = true; },
  ]) { const value = documents(); mutate(value); assert.throws(() => validateSmoothBuildDocuments(value)); }
});

test('each fresh fixture group, ignored name, measured resource and source binding is mandatory', () => {
  for (const mutate of [
    value => { value.result.sourceAfter = rec('different-after.json'); },
    value => { value.plan.sourceBefore = rec('different-before.json'); },
    value => { value.capture.rustFixtures = rec('different-fixtures.json'); },
    value => { value.fixtures.groups[3].log = rec('old-project.log'); },
    value => { value.fixtures.groups[3].executed--; }, value => { value.fixtures.groups[3].failed++; },
    value => { value.fixtures.groups[4].exactNames.pop(); }, value => { value.fixtures.totalExecuted = 99; },
    value => { value.fixtures.totalExecuted = 93; }, value => { value.fixtures.totalExecuted = 98; },
    value => { value.fixtures.totalExecuted = 127; },
    value => { value.fixtures.totalExecuted = 237; },
    value => { value.fixtures.totalExecuted = 260; },
    value => { value.fixtures.groups[11].log = rec('old-lookup.log'); },
    value => { value.fixtures.groups[12].log = rec('old-packed.log'); },
    value => { value.fixtures.groups[11].exactNames[0] = value.fixtures.groups[11].exactNames[1]; },
    value => { value.fixtures.groups[12].exactNames.pop(); },
    value => { value.fixtures.groups[11].executed = value.fixtures.groups[11].passed = 22; },
    value => { value.fixtures.groups[12].executed = value.fixtures.groups[12].passed = 9; },
    value => { value.fixtures.groups[11].ignored = 1; },
    value => { value.fixtures.groups[12].exactIgnoredNames = ['unapproved::ignored']; },
    value => { value.fixtures.groups = value.fixtures.groups.slice(0, 11); value.fixtures.totalExecuted = 237; },
    value => { value.fixtures.groups = value.fixtures.groups.slice(0, 12); value.fixtures.totalExecuted = 260; },
    value => { value.fixtures.totalExecuted = 186; },
    value => { value.fixtures.totalExecuted = 209; },
    value => { value.fixtures.groups[0].executed = value.fixtures.groups[0].passed = 21; },
    value => { value.fixtures.groups[5].executed = value.fixtures.groups[5].passed = 8; },
    value => { value.fixtures.groups[6].executed = value.fixtures.groups[6].passed = 19; },
    value => { value.fixtures.groups[5].exactNames[0] = value.fixtures.groups[5].exactNames[1]; },
    value => { value.fixtures.groups[6].exactNames.pop(); },
    value => { value.fixtures.groups[5].log = rec('old-hash.log'); },
    value => { value.fixtures.groups[6].log = rec('old-property.log'); },
    value => { value.fixtures.groups[8].log = rec('old-equality.log'); },
    value => { value.fixtures.groups[9].log = rec('old-overwrite.log'); },
    value => { value.fixtures.groups[10].log = rec('old-compact.log'); },
    value => { value.fixtures.groups[8].exactNames[0] = value.fixtures.groups[8].exactNames[1]; },
    value => { value.fixtures.groups[9].exactNames.pop(); },
    value => { value.fixtures.groups[10].exactNames.pop(); },
    value => { value.fixtures.groups[8].executed = value.fixtures.groups[8].passed = 7; },
    value => { value.fixtures.groups[9].executed = value.fixtures.groups[9].passed = 14; },
    value => { value.fixtures.groups[10].executed = value.fixtures.groups[10].passed = 27; },
    value => { value.fixtures.groups[4].exactIgnoredNames = []; },
    value => { value.fixtures.groups[4].exactIgnoredNames[0] = value.fixtures.groups[4].exactNames[0]; },
    value => { value.fixtures.groups[1].ignored = 1; }, value => { value.fixtures.groups.pop(); },
    value => { value.fixtures.groups[5].ignored = 1; },
    value => { value.fixtures.groups[6].exactIgnoredNames = ['unapproved::ignored']; },
    value => { value.fixtures.groups[8].ignored = 1; },
    value => { value.fixtures.groups[9].exactIgnoredNames = ['unapproved::ignored']; },
    value => { value.fixtures.groups[10].ignored = 1; },
    value => { value.fixtures.groups[10].exactIgnoredNames = ['unapproved::ignored']; },
    value => { value.fixtures.groups = value.fixtures.groups.slice(0, 5); value.fixtures.totalExecuted = 98; },
    value => { value.fixtures.groups = value.fixtures.groups.slice(0, 8); value.fixtures.totalExecuted = 186; },
    value => { value.fixtures.groups = value.fixtures.groups.slice(0, 10); value.fixtures.totalExecuted = 209; },
    value => { value.fixtures.groups[0].resources.maxRssKiB = 0; },
    value => { value.fixtures.groups[0].resources.scope = 'export only'; },
    value => { value.capture.stages[0].log.bytes = 0; },
  ]) { const value = documents(); mutate(value); assert.throws(() => validateSmoothBuildDocuments(value)); }
});

test('fresh build commands must match the bounded offline plan and complete sequentially', () => {
  for (const mutate of [
    value => { value.capture.stages[3].returncode = 1; }, value => { value.capture.stages.pop(); },
    value => { value.plan.stages.splice(5, 2); value.capture.stages.splice(5, 2); },
    value => { value.plan.stages.splice(8, 2); value.capture.stages.splice(8, 2); },
    value => { value.plan.stages.splice(10, 1); value.capture.stages.splice(10, 1); },
    value => { value.plan.stages.splice(11, 1); value.capture.stages.splice(11, 1); },
    value => { value.plan.stages.splice(12, 1); value.capture.stages.splice(12, 1); },
    value => { value.capture.stages[1].startedAt = time(0); },
    value => { value.capture.stages[0].finishedAt = time(90); },
    value => { value.capture.finishedAt = time(2); }, value => { value.capture.error = 'failed but relabeled'; },
    value => { value.plan.resources.memory = 'unbounded'; }, value => { value.plan.resources.cpus = 8; },
    value => { value.plan.environment.BUILD_WASM_MVP = 'false'; },
    value => changeCommand(value, 0, argv => { argv[argv.indexOf('--network') + 1] = 'host'; }),
    value => changeCommand(value, 0, argv => { argv[argv.indexOf('--cap-drop') + 1] = 'NET_RAW'; }),
    value => changeCommand(value, 0, argv => { argv[argv.indexOf('--mount') + 1] = 'type=bind,source=/other/source,target=/work'; }),
    value => changeCommand(value, 0, argv => { argv.splice(argv.indexOf(PINS.imageId), 0, '--privileged', 'true'); }),
    value => changeCommand(value, 1, argv => { argv.splice(argv.indexOf(PINS.imageId), 0, '--env', 'CARGO_BUILD_JOBS=2'); }),
    value => changeCommand(value, 2, argv => { argv.splice(argv.indexOf('--offline'), 1); }),
    value => changeCommand(value, 3, argv => { argv[argv.indexOf('boxhead_native_project::')] = 'native_projection_scan'; }),
    value => changeCommand(value, 4, argv => { argv.push('--ignored'); }),
    value => changeCommand(value, 0, argv => { argv.splice(argv.indexOf(PINS.imageId) + 1, 3); }),
    value => changeCommand(value, 5, argv => { argv[argv.indexOf('avm1::property_map::boxhead_hash_tests')] = 'property_hash_cache'; }),
    value => changeCommand(value, 6, argv => { argv[argv.indexOf('avm1::object::boxhead_property_tests')] = 'property'; }),
    value => changeCommand(value, 8, argv => { argv[argv.indexOf('property_equality_')] = 'property_hash_'; }),
    value => changeCommand(value, 9, argv => { argv[argv.indexOf('bitmap_overwrite_')] = 'bitmap_blit_'; }),
    value => changeCommand(value, 10, argv => { argv[argv.indexOf('compact_fence_')] = 'step_fence_'; }),
    value => changeCommand(value, 11, argv => { argv[argv.indexOf('lookup_v2_')] = 'boxhead_native_project::'; }),
    value => changeCommand(value, 12, argv => { argv[argv.indexOf('bitmap_packed_')] = 'bitmap_blit_'; }),
    value => changeCommand(value, EXPECTED_GROUPS, argv => { argv[argv.length - 1] = '--workspace=ruffle-selfhosted'; }),
  ]) { const value = documents(); mutate(value); assert.throws(() => validateSmoothBuildDocuments(value)); }
});

function sourceDocuments() {
  const inherited = [...parent.files, ...parent.unchangedParentFiles];
  const files = Array.from({ length: 2001 }, (_, index) => ({ path: 'synthetic-source/file-' + index + '.rs', bytes: index,
    sha256: sha('old source ' + index) }));
  files.push(...inherited.map(row));
  files.push(...Object.entries(SMOOTH_UPSTREAM_BASELINES).map(([path, baseline]) => ({ path, ...baseline })));
  const oldSeal = { bytes: 296, sha256: sha('parent version seal') };
  files.push({ path: 'web/version_seal.json', ...oldSeal });
  const nativeFiles = inherited.filter(file => file.path.includes('/globals/boxhead_native_')).map(file => file.path);
  const parentSource = { schema: 'boxhead-native-projector-full-source-v1', sourceCommit: PINS.sourceCommit,
    engineVariant: parent.engineVariant, files, gitHead: PINS.sourceCommit, gitIndexClean: true, versionSeal: oldSeal,
    gitDiffNames: inherited.filter(file => !nativeFiles.includes(file.path)).map(file => file.path).sort(),
    gitUntracked: [...nativeFiles, 'web/version_seal.json'].sort() };
  const seal = rec('version-seal.json');
  const before = { schema: 'boxhead-native-smooth-full-source-v2', sourceRoot: '/synthetic/source', sourceCommit: PINS.sourceCommit,
    engineVariant: VARIANT, recordedAt: time(0), files: expectedSmoothSourceFiles(parentSource, engine, seal),
    gitHead: PINS.sourceCommit, gitIndexClean: true,
    gitDiffNames: [...new Set([...parentSource.gitDiffNames, ...engine.files
      .filter(file => !file.baselineAbsent && !parentSource.gitUntracked.includes(file.path)).map(file => file.path)])].sort(),
    gitUntracked: [...new Set([...parentSource.gitUntracked, ...engine.files
      .filter(file => file.baselineAbsent && !Object.hasOwn(SMOOTH_DECLARED_IGNORED_SOURCES, file.path)).map(file => file.path)])].sort(),
    gitIgnoredSources: Object.keys(SMOOTH_DECLARED_IGNORED_SOURCES).sort(),
    versionSeal: { bytes: seal.bytes, sha256: seal.sha256 } };
  const after = { ...structuredClone(before), recordedAt: time((EXPECTED_GROUPS + 2) * 2 + 2) };
  return { before, after, parentSource, seal, stages: documents().capture.stages };
}

function sourceProof(value) {
  return validateSmoothSourceProof(value.before, value.after, value.parentSource, engine, value.seal, value.stages, '/synthetic/source');
}

test('complete trees retain inherited files and add exactly74 reviewed sources with one declared ignored lock', () => {
  const value = sourceDocuments(); const proof = sourceProof(value);
  assert.equal(engine.files.filter(file => file.baselineAbsent).length, 74);
  assert.equal(proof.length, value.parentSource.files.length + 74);
  const graphFile = 'core/src/avm1/globals/boxhead_native_graph.rs';
  assert(value.before.gitUntracked.includes(graphFile)); assert(!value.before.gitDiffNames.includes(graphFile));
  assert(value.before.gitDiffNames.includes('core/src/bitmap/operations.rs'));
  for (const name of Object.keys(SMOOTH_UPSTREAM_BASELINES)) {
    assert(value.before.gitDiffNames.includes(name)); assert(!value.before.gitUntracked.includes(name));
  }
  assert(value.before.gitUntracked.includes('core/src/avm1/globals/boxhead_native_projection_scan.rs'));
  assert(value.before.gitDiffNames.includes('core/src/avm1/object/script_object.rs'));
  assert.equal(proof.find(file => file.path === 'web/version_seal.json').sha256, value.seal.sha256);
  const lock = 'third_party/boxhead-gc-arena/Cargo.lock';
  assert.deepEqual(value.before.gitIgnoredSources, [lock]); assert.deepEqual(value.after.gitIgnoredSources, [lock]);
  assert(!value.before.gitUntracked.includes(lock)); assert(!value.before.gitDiffNames.includes(lock));
  assert.deepEqual(row(proof.find(file => file.path === lock)), { path: lock, ...SMOOTH_DECLARED_IGNORED_SOURCES[lock] });
});

test('only the fixed ignored vendor lock is separately captured and hashed before and after compilation', () => {
  const lock = 'third_party/boxhead-gc-arena/Cargo.lock';
  assert.deepEqual(SMOOTH_DECLARED_IGNORED_SOURCES, { [lock]: { bytes: 16008,
    sha256: 'aae89dd5e83905c9688a54585a5135270cbc9ba1a3ad3062547a030eda5403c6' } });
  for (const side of ['before', 'after']) {
    for (const mutate of [
      snapshot => { delete snapshot.gitIgnoredSources; },
      snapshot => { snapshot.gitIgnoredSources = []; },
      snapshot => { snapshot.gitIgnoredSources.push(lock); },
      snapshot => { snapshot.gitIgnoredSources.push('third_party/boxhead-gc-arena/.envrc'); },
      snapshot => { snapshot.gitIgnoredSources = ['unreviewed/Cargo.lock']; },
      snapshot => { snapshot.gitUntracked.push(lock); snapshot.gitUntracked.sort(); },
      snapshot => { snapshot.gitDiffNames.push(lock); snapshot.gitDiffNames.sort(); },
      snapshot => { snapshot.files = snapshot.files.filter(row => row.path !== lock); },
      snapshot => { snapshot.files.find(row => row.path === lock).sha256 = sha('different vendor lock'); },
      snapshot => { snapshot.ignoredSourceAllowlist = [lock, 'unreviewed.rs']; },
    ]) {
      const value = sourceDocuments(); mutate(value[side]);
      assert.throws(() => sourceProof(value));
    }
  }
  for (const mutate of [
    file => { file.bytes++; }, file => { file.sha256 = sha('forged but consistent lock'); },
    file => { delete file.baselineAbsent; file.baselineBytes = 1; file.baselineSha256 = sha('invented baseline'); },
  ]) {
    const supplied = structuredClone(engine); mutate(supplied.files.find(file => file.path === lock));
    assert.throws(() => validateSmoothEngine(supplied, parent, graphParent));
    const value = sourceDocuments();
    assert.throws(() => expectedSmoothSourceFiles(value.parentSource, supplied, value.seal));
  }
});

test('complete parent capture cannot omit or redefine any newly overlaid upstream file', () => {
  for (const name of Object.keys(SMOOTH_UPSTREAM_BASELINES)) {
    for (const mutate of [
      value => { value.parentSource.files = value.parentSource.files.filter(file => file.path !== name); },
      value => { value.parentSource.files.find(file => file.path === name).bytes++; },
      value => { value.parentSource.files.find(file => file.path === name).sha256 = sha('changed parent source ' + name); },
    ]) { const value = sourceDocuments(); mutate(value); assert.throws(() => sourceProof(value)); }

    // Self-consistent untrusted metadata cannot select a different upstream
    // baseline, even when this lower-level source helper is called directly.
    const value = sourceDocuments(), forgedEngine = structuredClone(engine);
    const invented = sha('forged but mutually agreeing baseline ' + name);
    value.parentSource.files.find(file => file.path === name).sha256 = invented;
    forgedEngine.files.find(file => file.path === name).baselineSha256 = invented;
    assert.throws(() => expectedSmoothSourceFiles(value.parentSource, forgedEngine, value.seal));
  }
});

test('source proof rejects omissions, extra files, baseline replacement, tracked/untracked confusion and late captures', () => {
  for (const mutate of [
    value => { value.before.files[0].sha256 = '0'.repeat(64); }, value => { value.after.files.pop(); },
    value => { value.before.files.push({ path: 'unreviewed.rs', bytes: 1, sha256: sha('extra') }); },
    value => { value.after.files[0].extra = 'unbound'; },
    value => { value.parentSource.schema = 'boxhead-native-graph-postbuild-source-inventory-v1'; },
    value => { value.parentSource.files.find(file => file.path === 'core/src/bitmap/operations.rs').sha256 = '0'.repeat(64); },
    value => { value.parentSource.files.push(row(engine.files.find(file => file.baselineAbsent))); },
    value => { value.parentSource.files.push({ ...value.parentSource.files[0] }); },
    value => { value.parentSource.files = value.parentSource.files.filter(file => file.path !== 'web/version_seal.json');
      delete value.parentSource.versionSeal; },
    value => { value.parentSource.gitUntracked.push(value.parentSource.gitUntracked[0]); },
    value => { value.before.gitIndexClean = false; }, value => { value.after.gitUntracked.push('unreviewed.rs'); },
    value => { value.before.gitDiffNames.push('core/src/avm1/globals/boxhead_native_graph.rs'); value.before.gitDiffNames.sort(); },
    value => { value.after.gitUntracked = value.after.gitUntracked.filter(name => !name.endsWith('/boxhead_native_graph.rs')); },
    value => { value.before.recordedAt = time(5); }, value => { value.after.recordedAt = time(1); },
    value => { value.before.gitHead = '0'.repeat(40); }, value => { value.after.versionSeal.sha256 = '0'.repeat(64); },
  ]) { const value = sourceDocuments(); mutate(value); assert.throws(() => sourceProof(value)); }
});

function rustLog(group, resources) {
  return group.exactNames.map(name => 'test ' + name + ' ... ok').join('\n') + '\n'
    + ignored(group).map(name => 'test ' + name + ' ... ignored, diagnostic only').join('\n') + '\n'
    + 'test result: ok. ' + group.expectedPassed + ' passed; 0 failed; ' + group.expectedIgnored
    + ' ignored; 0 measured; 0 filtered out; finished in 1.00s\n'
    + 'BOXHEAD_NATIVE_SMOOTH_RESOURCE ' + JSON.stringify(resources) + '\n';
}

test('actual logs require every reviewed fixture and only the explicitly ignored bitmap benchmark', () => {
  const resources = { maxRssKiB: 12345, scope: SMOOTH_RESOURCE_SCOPE };
  for (const group of engine.rustUnitGroups)
    assert.equal(validateSmoothRustLogs(group, rustLog(group, resources), resources).length, group.expectedPassed);
  const group = engine.rustUnitGroups[4], log = rustLog(group, resources), optional = ignored(group)[0];
  for (const broken of [
    log.replace(group.exactNames[0], 'old::unrelated'), log.replace('6 passed', '5 passed'),
    log.replace('1 ignored', '0 ignored'), log + log, log.replace('BOXHEAD_NATIVE_SMOOTH_RESOURCE', 'BOXHEAD_NATIVE_PROJECTOR_RESOURCE'),
    log.replace(optional, group.exactNames[0]), log.replace('ignored, diagnostic only', 'ok'),
    log.replace('ignored, diagnostic only', 'FAILED'), log + 'test unrelated::fixture ... FAILED\n',
    log.replace(optional, 'bitmap::operations::boxhead_blit::tests::unapproved_ignored_test'),
  ]) assert.throws(() => validateSmoothRustLogs(group, broken, resources));
  assert.throws(() => validateSmoothRustLogs(group, log, { ...resources, maxRssKiB: 1 }));
  const graph = engine.rustUnitGroups[0];
  assert.throws(() => validateSmoothRustLogs(graph, rustLog(graph, resources) + 'test ' + optional + ' ... ignored\n', resources));
  for (const added of engine.rustUnitGroups.slice(5)) {
    const current = rustLog(added, resources);
    assert.throws(() => validateSmoothRustLogs(added,
      current.replace('test ' + added.exactNames[0] + ' ... ok\n', ''), resources));
    assert.throws(() => validateSmoothRustLogs(added, current + 'test ' + optional + ' ... ignored\n', resources));
  }
});

test('actual temporary bundle bytes cannot select an old family or an unpinned smooth source manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'boxhead-smooth-binding-'));
  try {
    const runtime = path.join(root, 'runtime'); await mkdir(runtime);
    const fixture = documents();
    for (const file of fixture.manifest.files) {
      const bytes = Buffer.from('temporary-fixture:' + file.file);
      await writeFile(path.join(runtime, file.file), bytes); file.bytes = bytes.length; file.sha256 = sha(bytes);
    }
    for (const oldFamily of [true, false]) {
      const manifest = structuredClone(fixture.manifest);
      if (oldFamily) manifest.engineVariant = parent.engineVariant;
      else manifest.engineManifest.sha256 = '0'.repeat(64);
      const manifestFile = path.join(runtime, 'manifest.json'), manifestBytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(manifestFile, manifestBytes);
      const result = { ...fixture.result, engineVariant: manifest.engineVariant,
        manifest: { file: manifestFile, bytes: manifestBytes.length, sha256: sha(manifestBytes) } };
      const resultFile = path.join(root, 'result.json'), resultBytes = Buffer.from(JSON.stringify(result));
      await writeFile(resultFile, resultBytes);
      await assert.rejects(() => loadNativeGraphRuntimeInputs({ runtimeRoot: runtime, manifestSha256: sha(manifestBytes),
        buildResultFile: resultFile, buildResultSha256: sha(resultBytes) }), { code: 'ERR_ASSERTION' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
