import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadRuntimeBundle, verifyRuntimeBundleAfter, validateRuntimeFile } from './native-runtime-bundle.mjs';
import { loadNativeScalarRuntimeInputs, verifyNativeScalarRuntimeInputsAfter } from './native-scalar-runtime-binding.mjs';

export const NATIVE_COMBINED_RUNTIME_SCHEMA = 'original-cold-native-combined-runtime-v1';
export const NATIVE_COMBINED_ENGINE_VARIANT = 'native-scalars-v2-plus-action-push-cache-v3';
export const COMBINED_RUNTIME_PINS = Object.freeze({
  engineManifest: '091b029f2581418ae71e6997d3aa43029c360b81871f73448e32dc1a5ef23a4f',
  scalarManifest: 'c3d398935a1fa237b93e9493e4815a5ad38f116440d031d21d1da0c515f6b2d7',
  scalarResult: '04508cbd002236b5ef47be539ef7ef6cace57f2401bd970963af84a68a56da9a',
  baselineManifest: '21c2359be30ae578d9525fad28eb50166b5ce065d728a1b4690ab98211f0b8a1',
});
const SHA = /^[a-f0-9]{64}$/;
const commit = 'cac5c99ce4a17e606f4ee3090389bb878f852055';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => ({ bytes: value?.bytes, sha256: value?.sha256 });
const same = (one, two) => assert.deepEqual(identity(one), identity(two));
const PATCH_PATHS = ['core/src/avm1.rs', 'core/src/avm1/activation.rs', 'core/src/avm1/runtime.rs',
  'core/src/avm1/globals.rs', 'core/src/avm1/action_push_cache.rs',
  'core/src/avm1/action_push_cache/tests.rs', 'core/src/avm1/action_push_cache/activation_tests.rs',
  'core/src/avm1/globals/boxhead_native_scalars.rs', 'core/src/avm1/globals/boxhead_native_scalars/tests.rs',
  'core/src/avm1/globals/boxhead_native_scalars/activation_tests.rs'];
const BUILD_STAGES = [['npm', 'ci', '--include=dev', '--no-audit', '--no-fund'],
  ['npm', 'run', 'build', '--workspace=ruffle-core'], ['npm', 'run', 'build', '--workspace=ruffle-selfhosted']];
const GROUPS = [['scalar', 'native_scalar', 'inheritedScalarUnitGate', 14],
  ['push', 'action_push_cache', 'unitGate', 20]];

function recordShape(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'file', 'sha256']);
  assert(typeof value.file === 'string' && path.isAbsolute(value.file));
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0 && SHA.test(value.sha256));
  return value;
}
async function fileRecord(file) {
  const actual = await realpath(file), digest = createHash('sha256'); let bytes = 0;
  const before = await stat(actual);
  assert(before.isFile() && before.size > 0 && before.size <= 512 * 1024 * 1024, 'Combined provenance needs a bounded regular file');
  for await (const chunk of createReadStream(actual)) { bytes += chunk.length; digest.update(chunk); }
  const after = await stat(actual);
  assert.equal(bytes, before.size);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'Combined input changed during hashing');
  return { file: actual, bytes, sha256: digest.digest('hex') };
}
async function exactBundleInventory(bundle) {
  const actual = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + '/');
      else { assert(entry.isFile(), 'Combined bundle contains a symlink or nonregular entry'); actual.push(name); }
    }
  }
  await visit(bundle.root, '');
  assert.deepEqual(actual.sort(), ['manifest.json', ...bundle.files.keys()].sort(), 'Combined bundle has undeclared or missing files');
}

/** Metadata checks are separate from the required byte binding in the loader.
 * Neither these declarations nor saved fixture logs reproduce the compiler. */
export function validateCombinedRuntimeDocuments({ manifest, result, plan, engine, scalar, scalarPlan, fixtures }) {
  for (const value of [manifest, result, plan]) {
    assert.equal(value.arm, 'candidate'); assert.equal(value.engineVariant, NATIVE_COMBINED_ENGINE_VARIANT);
    assert.equal(value.gameplayPassClaimed, false); assert.equal(value.performancePassClaimed, false);
  }
  assert.equal(result.schema, 'boxhead-pinned-ruffle-build-result-v1');
  assert.equal(result.compiled, true); assert.equal(result.sourceAfterVerified, true);
  assert.equal(result.scalarParentSourceAfterReverified, true);
  assert.equal(manifest.schema, 'boxhead-ruffle-web-bundle-v1');
  assert.equal(manifest.sourceCommit, commit); assert.equal(manifest.sourceAfterVerified, true);
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.imageId));
  assert.equal(manifest.imageId, scalar.imageId);
  assert.equal(manifest.engineManifest.sha256, COMBINED_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.scalarParentManifest.sha256, COMBINED_RUNTIME_PINS.scalarManifest);
  assert.equal(manifest.scalarParentBuildResult.sha256, COMBINED_RUNTIME_PINS.scalarResult);
  assert.equal(manifest.baselineManifest.sha256, COMBINED_RUNTIME_PINS.baselineManifest);
  same(result.scalarParentManifest, manifest.scalarParentManifest);
  same(manifest.scalarParentManifest, scalar.manifest); same(manifest.scalarParentBuildResult, scalar.buildResult);
  same(manifest.baselineManifest, scalar.baselineManifest);
  same(manifest.toolchainMetadata, scalar.toolchainMetadata); same(manifest.versionSeal, scalar.versionSeal);
  assert.deepEqual(manifest.wasmVariants, ['extensions', 'mvp']);
  assert.equal(manifest.files.length, 12); assert.equal(manifest.files.filter(row => row.file.endsWith('.wasm')).length, 2);
  assert(manifest.files.reduce((sum, row) => sum + row.bytes, 0) <= 1024 * 1024 * 1024);
  assert.deepEqual(result.files, manifest.files); same(result.plan, manifest.buildPlan);
  assert.equal(plan.schema, 'boxhead-pinned-ruffle-build-plan-v1');
  assert.equal(plan.sourceCommit, commit); assert.equal(plan.imageId, manifest.imageId);
  for (const key of ['engineManifest', 'scalarParentManifest', 'scalarParentBuildResult', 'baselineManifest', 'toolchainMetadata', 'versionSeal'])
    same(plan[key], manifest[key]);
  same(plan.toolchain, scalar.toolchain); same(plan.baselineResult, scalar.baselineResult);
  same(plan.baselineStatus, scalarPlan.baselineStatus);
  assert.deepEqual(plan.environment, scalarPlan.environment);
  assert.deepEqual(plan.wasmVariants, manifest.wasmVariants);
  assert.equal(plan.commands.length, BUILD_STAGES.length);
  for (const [index, stage] of BUILD_STAGES.entries())
    assert.deepEqual(plan.commands[index].slice(-stage.length - 1), [manifest.imageId, ...stage]);
  assert.equal(engine.schema, 'boxhead-ruffle-action-push-cache-engine-source-v3');
  assert.equal(engine.upstream?.commit, commit); assert.equal(engine.parent?.sha256, scalar.engineManifest.sha256);
  assert.equal(engine.files?.length, PATCH_PATHS.length);
  assert.deepEqual(engine.files.map(row => row.path).sort(), [...PATCH_PATHS].sort());
  assert.deepEqual(manifest.patchFiles, engine.files); assert.deepEqual(plan.patchFiles, engine.files);
  assert.equal(engine.witness?.global, 'boxheadActionPushCacheV1');
  assert.equal(engine.witness?.version, 1); assert.equal(engine.witness?.contract, 'action-push-cache-v1');
  assert.deepEqual(engine.witness?.fields, ['version', 'contract', 'hits', 'misses', 'insertions', 'entries',
    'descriptorBytes', 'uncacheable', 'budgetFallback', 'staleOwner']);
  assert.equal(engine.bounds?.entries, 65536); assert.equal(engine.bounds?.operandArrayBytes, 4194304);
  assert.equal(fixtures.schema, 'boxhead-native-scalar-push-rust-fixtures-v1');
  assert.equal(fixtures.engineVariant, NATIVE_COMBINED_ENGINE_VARIANT);
  assert.equal(fixtures.pass, true); assert.equal(fixtures.gameplayPassClaimed, false);
  for (const [key, expected] of [['executed', 34], ['passed', 34], ['failed', 0], ['ignored', 0]]) {
    assert.equal(fixtures[key], expected); assert.equal(plan.rustUnitGate['expected' + key[0].toUpperCase() + key.slice(1)], expected);
  }
  same(fixtures.engineManifest, manifest.engineManifest); same(result.rustFixtures, manifest.rustFixtures);
  assert.deepEqual(plan.rustUnitGate.features, []);
  assert.equal(fixtures.groups?.length, GROUPS.length); assert.equal(plan.rustUnitGate.groups?.length, GROUPS.length);
  const names = [];
  for (const [index, [label, filter, field, count]] of GROUPS.entries()) {
    const gate = engine[field], got = fixtures.groups[index], commands = plan.rustUnitGate.groups[index];
    assert(Array.isArray(gate?.exactNames) && gate.exactNames.length === count && new Set(gate.exactNames).size === count);
    assert.equal(gate.featureOverride, null);
    for (const [key, expected] of [['expectedExecuted', count], ['expectedPassed', count], ['expectedFailed', 0], ['expectedIgnored', 0]])
      assert.equal(gate[key], expected);
    const argv = ['cargo', 'test', '--locked', '-p', 'ruffle_core', '--lib', filter];
    assert.deepEqual(gate.listArgv, [...argv, '--', '--list']);
    assert.deepEqual(gate.argv, [...argv, '--', '--nocapture', '--test-threads=1']);
    assert.equal(got.label, label); assert.equal(got.filter, filter); assert.equal(got.pass, true);
    for (const [key, expected] of [['executed', count], ['passed', count], ['failed', 0], ['ignored', 0]]) assert.equal(got[key], expected);
    assert.deepEqual([...got.names].sort(), [...gate.exactNames].sort());
    assert.equal(commands.label, label); assert.equal(commands.filter, filter);
    assert.deepEqual(commands.expectedNames, gate.exactNames);
    const listTail = [...argv, '--', '--list', '--format', 'terse'];
    const runTail = [...argv, '--', '--nocapture', '--test-threads=1', '--color', 'never'];
    assert.deepEqual(commands.list.slice(-listTail.length - 1), [manifest.imageId, ...listTail]);
    assert.deepEqual(commands.run.slice(-runTail.length - 1), [manifest.imageId, ...runTail]);
    if (label === 'scalar') assert.deepEqual(gate.exactNames, scalar.rustFixtures.names);
    names.push(...gate.exactNames);
  }
  assert.equal(names.length, 34); assert.equal(new Set(names).size, 34);
  assert.deepEqual([...fixtures.names].sort(), [...names].sort());
  assert.deepEqual(plan.rustUnitGate.expectedNames, names);
  return names;
}

export function validateCombinedRustLogs(group, listText, runText) {
  const listed = [...listText.matchAll(/^(.+): test$/gm)].map(row => row[1]);
  const passed = [...runText.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(row => row[1]);
  assert.deepEqual(listed.sort(), [...group.names].sort()); assert.deepEqual(passed.sort(), [...group.names].sort());
  const summaries = [...runText.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/gm)]
    .map(row => row.slice(1));
  assert.deepEqual(summaries, [[String(group.executed), '0', '0', '0']]);
}

export async function loadNativeCombinedRuntimeInputs({ runtimeRoot, manifestSha256, buildResultFile, buildResultSha256 }) {
  assert(SHA.test(manifestSha256) && SHA.test(buildResultSha256), 'Explicit combined runtime/build SHA256 pins are required');
  const bundle = await loadRuntimeBundle({ side: 'candidate', root: runtimeRoot, expectedSha256: manifestSha256 });
  await exactBundleInventory(bundle);
  const records = new Map();
  async function bound(binding, json = true) {
    recordShape(binding);
    const actual = await fileRecord(binding.file); same(actual, binding);
    const prior = records.get(actual.file); if (prior) assert.deepEqual(actual, prior);
    records.set(actual.file, actual);
    if (!json) return actual;
    assert(actual.bytes <= 16 * 1024 * 1024, 'Combined provenance JSON exceeds bounded metadata size');
    const bytes = await readFile(actual.file);
    assert.equal(bytes.length, actual.bytes); assert.equal(hash(bytes), actual.sha256);
    return JSON.parse(bytes.toString('utf8'));
  }
  const resultRecord = await fileRecord(buildResultFile);
  assert.equal(resultRecord.sha256, buildResultSha256);
  const result = await bound(resultRecord), manifest = bundle.manifest;
  same(result.manifest, bundle.manifestRecord); assert.deepEqual(await bound(result.manifest), manifest);
  assert.equal(manifest.engineManifest?.sha256, COMBINED_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.scalarParentManifest?.sha256, COMBINED_RUNTIME_PINS.scalarManifest);
  assert.equal(manifest.scalarParentBuildResult?.sha256, COMBINED_RUNTIME_PINS.scalarResult);
  const parentManifest = await bound(manifest.scalarParentManifest);
  await bound(manifest.scalarParentBuildResult);
  const scalarInputs = await loadNativeScalarRuntimeInputs({ runtimeRoot: path.dirname(manifest.scalarParentManifest.file),
    manifestSha256: COMBINED_RUNTIME_PINS.scalarManifest, buildResultFile: manifest.scalarParentBuildResult.file,
    buildResultSha256: COMBINED_RUNTIME_PINS.scalarResult });
  assert.deepEqual(parentManifest, scalarInputs.bundle.manifest);
  for (const row of scalarInputs.records) await bound(row, false);
  const plan = await bound(manifest.buildPlan), engine = await bound(manifest.engineManifest);
  const scalarPlan = await bound(scalarInputs.summary.buildPlan), fixtures = await bound(manifest.rustFixtures);
  const names = validateCombinedRuntimeDocuments({ manifest, result, plan, engine, scalar: scalarInputs.summary, scalarPlan, fixtures });
  for (const key of ['baselineStatus', 'baselineResult', 'baselineManifest', 'toolchain', 'toolchainMetadata', 'versionSeal'])
    await bound(plan[key]);
  const engineDirectory = path.dirname((await fileRecord(manifest.engineManifest.file)).file);
  for (const row of engine.files) {
    validateRuntimeFile(row.path);
    const file = await realpath(path.resolve(engineDirectory, row.path)), relative = path.relative(engineDirectory, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  for (const group of fixtures.groups) {
    for (const key of ['listLog', 'runLog']) await bound(group[key], false);
    validateCombinedRustLogs(group, await readFile(group.listLog.file, 'utf8'), await readFile(group.runLog.file, 'utf8'));
  }
  const before = await bound(plan.sourceBefore), patched = await bound(plan.sourcePatched), after = await bound(manifest.sourceAfter);
  assert.equal(before.sourceCommit, commit);
  for (const value of [patched, after]) {
    assert.equal(value.schema, 'boxhead-pinned-ruffle-source-binding-v1'); assert.equal(value.sourceCommit, commit);
    assert.equal(value.engineVariant, NATIVE_COMBINED_ENGINE_VARIANT);
    assert(Array.isArray(value.files) && value.files.length === 2834);
    assert.equal(new Set(value.files.map(row => row.file)).size, 2834);
  }
  same(patched.engineManifest, manifest.engineManifest);
  assert.deepEqual(after.files, patched.files); assert.equal(after.patchedSourceBeforeMatchesAfter, true);
  assert.equal(after.scalarParentSourceAfterReverified, true);
  const summary = { schema: NATIVE_COMBINED_RUNTIME_SCHEMA, engineVariant: NATIVE_COMBINED_ENGINE_VARIANT,
    sourceCommit: commit, imageId: manifest.imageId, manifest: { ...bundle.manifestRecord }, buildResult: resultRecord,
    engineManifest: manifest.engineManifest, buildPlan: manifest.buildPlan, toolchain: plan.toolchain,
    toolchainMetadata: manifest.toolchainMetadata, baselineManifest: manifest.baselineManifest,
    baselineResult: plan.baselineResult, versionSeal: manifest.versionSeal,
    scalarParent: scalarInputs.summary,
    rustFixtures: { record: manifest.rustFixtures, executed: 34, passed: 34, failed: 0, ignored: 0, names,
      groups: fixtures.groups.map(row => ({ label: row.label, executed: row.executed, passed: row.passed,
        failed: row.failed, ignored: row.ignored, names: row.names, listLog: row.listLog, runLog: row.runLog })) },
    wasmVariants: manifest.wasmVariants,
    files: bundle.initialFiles.map(row => ({ file: row.file, bytes: row.bytes, sha256: row.sha256 })),
    linkedRecords: [...records.values()].sort((a, b) => a.file.localeCompare(b.file)),
    sourceAfterVerifiedByBuild: true, compilerReproducedByObserver: false, gameplayClaimInheritedFromBuild: false,
    cacheHitCoverageClaimed: false, cacheStatsNativeCalls: 0 };
  return { bundle, scalarInputs, summary, records: [...records.values()] };
}

export async function verifyNativeCombinedRuntimeInputsAfter(inputs) {
  await verifyNativeScalarRuntimeInputsAfter(inputs.scalarInputs);
  const bundle = await verifyRuntimeBundleAfter(inputs.bundle);
  await exactBundleInventory(inputs.bundle);
  for (const row of inputs.records) assert.deepEqual(await fileRecord(row.file), row, 'Linked combined provenance changed');
  return { verified: true, manifest: bundle.manifest, linkedRecords: inputs.records.length, files: bundle.files.length };
}
