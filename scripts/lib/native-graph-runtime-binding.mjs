import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadRuntimeBundle, verifyRuntimeBundleAfter, validateRuntimeFile } from './native-runtime-bundle.mjs';
import { loadNativeScalarRuntimeInputs, verifyNativeScalarRuntimeInputsAfter } from './native-scalar-runtime-binding.mjs';

export const NATIVE_GRAPH_RUNTIME_SCHEMA = 'original-native-graph-runtime-v1';
export const NATIVE_GRAPH_ENGINE_VARIANT = 'native-scalars-v2-plus-native-graph-v1';
export const GRAPH_RUNTIME_PINS = Object.freeze({
  sourceCommit: 'cac5c99ce4a17e606f4ee3090389bb878f852055',
  engineManifest: 'f2b8f6fd6de2fe5eb7754aae091cefcfaa49d25833b32daf0c4fe5c642acd34d',
  previousEngineManifest: '23fc776489cb81a4eb567226dd73ea6b1e5c10df4aa42436851df2f8654bba93',
  scalarSource: 'bdb740ade0c05141254b3f224703fdc320240dac7b6c532895dda3b6eab35a7e',
  graphOverlaySource: 'a001b3cef4dffa58e5fcc80428f8b70087b52e1afeeb03fc46e1c0e7eb1df999',
  scalarManifest: 'c3d398935a1fa237b93e9493e4815a5ad38f116440d031d21d1da0c515f6b2d7',
  scalarResult: '04508cbd002236b5ef47be539ef7ef6cace57f2401bd970963af84a68a56da9a',
  baselineManifest: '21c2359be30ae578d9525fad28eb50166b5ce065d728a1b4690ab98211f0b8a1',
  versionSeal: 'fbe20b4ccd9093971204a2459498e29054f20b5ccede873cb136cffe65d229f0',
  imageId: 'sha256:612f92fa418bc2af18dca2501464dbffa6393ad895a7c7f906216f71e896c8cf',
});
const SHA = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => ({ bytes: value?.bytes, sha256: value?.sha256 });
const same = (one, two) => assert.deepEqual(identity(one), identity(two));
const PATCH_PATHS = ['core/src/avm1/activation.rs', 'core/src/avm1/globals.rs',
  'core/src/avm1/globals/boxhead_native_graph.rs', 'core/src/avm1/globals/boxhead_native_graph/tests.rs',
  'core/src/avm1/globals/boxhead_native_scalars.rs', 'core/src/avm1/globals/boxhead_native_scalars/activation_tests.rs',
  'core/src/avm1/globals/boxhead_native_scalars/tests.rs', 'core/src/avm1/object/script_object.rs',
  'core/src/avm1/runtime.rs'];
const REVISION_PATHS = ['core/src/avm1/globals/boxhead_native_graph.rs',
  'core/src/avm1/globals/boxhead_native_graph/tests.rs'];
export const GRAPH_SOURCE_LIMITS = Object.freeze({ decodedGraphBytes: 128 * 1024 * 1024,
  nativeWireCharacters: 2 * 32 * 1024 * 1024 + 1024, nodes: 65_536, fields: 1_000_000,
  anchors: 250_000, stringUnits: 1_048_576, pixelsPerBitmap: 8_388_608 });
const ENVIRONMENT = Object.freeze({ CARGO_HOME: '/cache/cargo', npm_config_cache: '/cache/npm',
  CARGO_BUILD_JOBS: '4', CARGO_FEATURES: 'jpegxr', NODE_ENV: 'production', ENABLE_VERSION_SEAL: 'true',
  CFG_RELEASE_CHANNEL: 'boxhead-experiment', VERSION4: '0.6.0.0', BUILD_WASM_MVP: 'true' });
export const GRAPH_RESOURCE_SCOPE = 'Cargo and all descendant build/test processes; not export-only memory';
export const GRAPH_RESOURCE_WRAPPER = "import json,resource,subprocess,sys\n"
  + "p=subprocess.run(sys.argv[1:])\n"
  + "print('BOXHEAD_NATIVE_GRAPH_RESOURCE '+json.dumps({'maxRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,'scope':'Cargo and all descendant build/test processes; not export-only memory'}),flush=True)\n"
  + "sys.exit(p.returncode)";
export const GRAPH_BUILD_GROUPS = Object.freeze([
  { label: 'graph', filter: 'native_graph', count: 18, cwd: '/work',
    tail: ['python3', '-c', GRAPH_RESOURCE_WRAPPER, 'cargo', 'test', '--offline', '--locked',
      '-p', 'ruffle_core', '--lib', 'native_graph', '--', '--test-threads=1'] },
  { label: 'scalar', filter: 'native_scalar', count: 14, cwd: '/work',
    tail: ['cargo', 'test', '--offline', '--locked', '-p', 'ruffle_core', '--lib', 'native_scalar'] },
  { label: 'wasm', cwd: '/work/web', tail: ['npm', 'run', 'build', '--workspace=ruffle-core'] },
  { label: 'selfhosted', cwd: '/work/web', tail: ['npm', 'run', 'build', '--workspace=ruffle-selfhosted'] },
]);

export function graphRecordShape(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'file', 'sha256']);
  assert(typeof value.file === 'string' && path.isAbsolute(value.file));
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0 && SHA.test(value.sha256));
  return value;
}

export async function recordGraphInput(file) {
  const actual = await realpath(file), digest = createHash('sha256'); let bytes = 0;
  const before = await stat(actual);
  assert(before.isFile() && before.size > 0 && before.size <= 512 * 1024 * 1024, 'Graph provenance needs a bounded regular file');
  for await (const chunk of createReadStream(actual)) { bytes += chunk.length; digest.update(chunk); }
  const after = await stat(actual);
  assert.equal(bytes, before.size);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'])
    assert.equal(after[key], before[key], 'Graph provenance input changed while hashing');
  return { file: actual, bytes, sha256: digest.digest('hex') };
}

export async function exactGraphBundleInventory(bundle) {
  const actual = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + '/');
      else { assert(entry.isFile(), 'Graph runtime bundle contains a symlink or nonregular entry'); actual.push(name); }
    }
  }
  await visit(bundle.root, '');
  assert.deepEqual(actual.sort(), ['manifest.json', ...bundle.files.keys()].sort(), 'Graph runtime contains undeclared or missing assets');
}

export function validateGraphEngine(engine) {
  assert.equal(engine.schema, 'boxhead-ruffle-native-graph-engine-source-v1');
  assert.equal(engine.engineVariant, NATIVE_GRAPH_ENGINE_VARIANT); assert.equal(engine.sourceRevision, 5);
  assert.equal(engine.upstream?.commit, GRAPH_RUNTIME_PINS.sourceCommit);
  assert.equal(engine.scalarSource?.sha256, GRAPH_RUNTIME_PINS.scalarSource);
  assert.equal(engine.graphOverlaySource?.sha256, GRAPH_RUNTIME_PINS.graphOverlaySource);
  assert.equal(engine.previousEngineSource?.sha256, GRAPH_RUNTIME_PINS.previousEngineManifest);
  assert.equal(engine.previousEngineSource?.file, 'previous-engine-source-v4.json');
  assert.equal(engine.previousEngineSource?.bytes, 9290);
  assert.deepEqual(engine.revisionChangedPaths, REVISION_PATHS);
  assert.deepEqual(engine.limits, GRAPH_SOURCE_LIMITS);
  assert.equal(engine.files?.length, PATCH_PATHS.length);
  assert.deepEqual(engine.files.map(row => row.path).sort(), PATCH_PATHS);
  for (const row of engine.files) {
    validateRuntimeFile(row.path); assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && SHA.test(row.sha256));
  }
  assert.equal(engine.abi?.scalar?.global, 'boxheadNativeScalarsV1');
  assert.equal(engine.abi?.scalar?.contract, 'bh-scalars-thing-v1'); assert.equal(engine.abi?.scalar?.version, 1);
  assert.equal(engine.abi?.graph?.global, 'boxheadNativeGraphV1');
  assert.equal(engine.abi?.graph?.contract, 'bh-avm1-graph-v1'); assert.equal(engine.abi?.graph?.version, 1);
  assert.deepEqual(engine.abi.graph.operations, ['capability', 'export', 'import', 'inspect', 'bitmapCopy']);
  assert.equal(engine.rustUnitGroups?.length, 2); assert.equal(engine.totalRequiredRustTests, 32);
  const names = [];
  for (const [index, expected] of GRAPH_BUILD_GROUPS.slice(0, 2).entries()) {
    const group = engine.rustUnitGroups[index];
    assert.equal(group.label, expected.label); assert.equal(group.filter, expected.filter);
    for (const [key, value] of [['expectedExecuted', expected.count], ['expectedPassed', expected.count], ['expectedFailed', 0], ['expectedIgnored', 0]])
      assert.equal(group[key], value);
    assert(Array.isArray(group.exactNames) && group.exactNames.length === expected.count);
    assert.equal(new Set(group.exactNames).size, expected.count); names.push(...group.exactNames);
  }
  assert.equal(new Set(names).size, 32); return names;
}

/** Bind this source revision to the actual sealed v4 source inventory without
 * rerunning, relabeling, or inheriting gameplay acceptance from that runtime. */
export function validateGraphRevisionDelta(previous, engine) {
  assert.equal(previous.schema, engine.schema); assert.equal(previous.sourceRevision, 4);
  assert.equal(engine.sourceRevision, 5); assert.equal(previous.engineVariant, engine.engineVariant);
  assert.deepEqual(previous.upstream, engine.upstream);
  assert.deepEqual(previous.scalarSource, engine.scalarSource);
  assert.deepEqual(previous.abi, engine.abi);
  assert.deepEqual(previous.files.map(row => row.path), engine.files.map(row => row.path));
  const changed = [];
  for (const [index, row] of engine.files.entries()) {
    const old = previous.files[index];
    if (row.sha256 !== old.sha256 || row.bytes !== old.bytes) {
      changed.push(row.path);
      const metadata = ({ bytes, sha256, ...rest }) => rest;
      assert.deepEqual(metadata(row), metadata(old));
    } else assert.deepEqual(row, old);
  }
  assert.deepEqual(changed, REVISION_PATHS, 'Only the graph adapter and its tests may change from sealed v4');
  assert.deepEqual(engine.revisionChangedPaths, changed);
  assert.deepEqual(engine.rustUnitGroups[1], previous.rustUnitGroups[1]);
  assert.deepEqual(previous.limits, { ...GRAPH_SOURCE_LIMITS, decodedGraphBytes: 64 * 1024 * 1024 });
  const priorNames = previous.rustUnitGroups[0].exactNames;
  assert.equal(priorNames.length, 16);
  const prefix = 'avm1::globals::boxhead_native_graph::tests::';
  const boundFixtures = [
    prefix + 'native_graph_accepts_exact_64mib_decoded_packet_and_rejects_next_byte',
    prefix + 'native_graph_export_rejects_sum_above_64mib_without_mutating_source',
    prefix + 'native_graph_rejects_oversized_bitmap_and_count_headers_before_allocation',
  ];
  assert.deepEqual(priorNames.slice(13), boundFixtures);
  // Thirteen prior bodies are preserved. These two renamed boundary fixtures
  // and the capability expectation are declared changes, not inherited passes.
  assert.deepEqual(engine.rustUnitGroups[0].exactNames, [
    ...priorNames.slice(0, 13),
    ...boundFixtures.map(name => name.replace('_64mib_', '_128mib_')),
    prefix + 'native_graph_roundtrips_map18_geometry_envelope_above_64mib',
    prefix + 'native_graph_bulk_packet_matches_v4_bytes_and_keeps_wire_limit',
  ]);
}

export function validateGraphRustLogs(group, text) {
  const passed = [...text.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(row => row[1]);
  assert.deepEqual(passed.sort(), [...group.exactNames].sort(), 'Actual graph/scalar fixture names differ');
  const summaries = [...text.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/gm)]
    .map(row => row.slice(1));
  assert.deepEqual(summaries, [[String(group.expectedExecuted), '0', '0', '0']]);
  if (group.label === 'graph') {
    const resources = [...text.matchAll(/^BOXHEAD_NATIVE_GRAPH_RESOURCE (.+)$/gm)].map(row => JSON.parse(row[1]));
    assert.equal(resources.length, 1, 'Graph stage must retain one actual resource measurement');
    assert.deepEqual(Object.keys(resources[0]).sort(), ['maxRssKiB', 'scope']);
    assert(Number.isSafeInteger(resources[0].maxRssKiB) && resources[0].maxRssKiB > 0);
    assert.equal(resources[0].scope, GRAPH_RESOURCE_SCOPE);
  }
  return passed;
}

export function validateGraphBuildStages(stages, sourceRoot) {
  assert.equal(stages.length, GRAPH_BUILD_GROUPS.length);
  let priorFinish = -Infinity;
  for (const [index, expected] of GRAPH_BUILD_GROUPS.entries()) {
    const status = stages[index];
    assert.equal(status.state, 'complete'); assert.equal(status.returncode, 0); assert(!status.error);
    const started = Date.parse(status.startedAt), finished = Date.parse(status.finishedAt);
    assert(Number.isFinite(started) && Number.isFinite(finished) && started <= finished && started >= priorFinish);
    priorFinish = finished;
    const argv = status.command;
    assert(Array.isArray(argv) && argv.every(value => typeof value === 'string'));
    assert.deepEqual(argv.slice(-expected.tail.length - 1), [GRAPH_RUNTIME_PINS.imageId, ...expected.tail]);
    assert.deepEqual(argv.slice(0, 3), ['docker', 'run', '--rm']);
    const option = name => { const at = argv.indexOf(name); assert(at >= 0 && at < argv.length - 1); return argv[at + 1]; };
    assert.equal(option('--network'), 'none'); assert.equal(option('--cpus'), '4');
    assert.equal(option('--workdir'), expected.cwd); assert.equal(option('--cap-drop'), 'ALL');
    assert.equal(option('--security-opt'), 'no-new-privileges'); assert(/^\d+:\d+$/.test(option('--user')));
    const environments = argv.flatMap((value, i) => value === '--env' ? [argv[i + 1]] : []);
    assert.equal(new Set(environments.map(row => row.split('=')[0])).size, environments.length);
    assert.deepEqual(Object.fromEntries(environments.map(row => { const at = row.indexOf('='); assert(at > 0); return [row.slice(0, at), row.slice(at + 1)]; })), ENVIRONMENT);
    const mounts = argv.flatMap((value, i) => value === '--mount' ? [argv[i + 1]] : []);
    assert.equal(mounts.length, 3);
    assert(mounts.includes('type=bind,source=' + sourceRoot + ',target=/work'));
    assert(mounts.some(value => value.startsWith('type=bind,source=') && value.endsWith(',target=/cache')));
    assert(mounts.some(value => value.startsWith('type=bind,source=') && value.endsWith(',target=/work/target')));
    graphRecordShape({ file: status.log.path, bytes: status.log.bytes, sha256: status.log.sha256 });
  }
}

export function validateGraphSourceProof(before, after, beforeRecord, engine, versionSeal, stages) {
  assert.equal(before.schema, 'boxhead-native-graph-build-source-binding-v1');
  assert.equal(before.sourceCommit, GRAPH_RUNTIME_PINS.sourceCommit);
  const files = engine.files.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 }));
  assert.deepEqual(before.files, files); same(before.versionSeal, versionSeal);
  assert.deepEqual(before.gitDiffNames, engine.files.filter(row => !row.baselineAbsent).map(row => row.path).sort());
  assert.deepEqual(before.gitUntracked, [...engine.files.filter(row => row.baselineAbsent).map(row => row.path), 'web/version_seal.json'].sort());
  assert.equal(after.schema, before.schema); assert.deepEqual(after.files, files); assert.equal(after.sourceUnchanged, true);
  assert.deepEqual({ file: after.before.path, bytes: after.before.bytes, sha256: after.before.sha256 }, beforeRecord);
  assert(Date.parse(before.recordedAt) <= Date.parse(stages[0].startedAt));
  assert(Date.parse(after.finishedAt) >= Date.parse(stages.at(-1).finishedAt));
}

export function expectedGraphSourceFiles(scalarSourceAfter, engine) {
  assert.equal(scalarSourceAfter.schema, 'boxhead-pinned-ruffle-source-binding-v1');
  assert.equal(scalarSourceAfter.sourceCommit, GRAPH_RUNTIME_PINS.sourceCommit);
  assert.equal(scalarSourceAfter.patchedSourceBeforeMatchesAfter, true);
  assert(Array.isArray(scalarSourceAfter.files) && scalarSourceAfter.files.length > 2000 && scalarSourceAfter.files.length < 10000);
  const expected = new Map();
  for (const row of scalarSourceAfter.files) {
    validateRuntimeFile(row.file); assert(!expected.has(row.file));
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256)); expected.set(row.file, row);
  }
  for (const row of engine.files) expected.set(row.path, { file: row.path, bytes: row.bytes, sha256: row.sha256 });
  return [...expected.values()].sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

/** The generic runtime manifest stays compatible with the existing HTTP/load
 * observers. The graph provenance contract is additional and never pretends to
 * be the six-file scalar build or the ActionPush-cache experiment. */
export async function loadNativeGraphRuntimeInputs({ runtimeRoot, manifestSha256, buildResultFile, buildResultSha256 }) {
  assert(SHA.test(manifestSha256) && SHA.test(buildResultSha256), 'Explicit graph runtime/build SHA256 pins are required');
  const bundle = await loadRuntimeBundle({ side: 'candidate', root: runtimeRoot, expectedSha256: manifestSha256 });
  await exactGraphBundleInventory(bundle);
  const records = new Map();
  async function bound(binding, json = true) {
    graphRecordShape(binding); const actual = await recordGraphInput(binding.file); same(actual, binding);
    const previous = records.get(actual.file); if (previous) assert.deepEqual(actual, previous);
    records.set(actual.file, actual);
    if (!json) return actual;
    assert(actual.bytes <= 16 * 1024 * 1024, 'Graph provenance JSON exceeds its metadata bound');
    const bytes = await readFile(actual.file); assert.equal(bytes.length, actual.bytes); assert.equal(hash(bytes), actual.sha256);
    return JSON.parse(bytes.toString('utf8'));
  }
  const resultRecord = await recordGraphInput(buildResultFile); assert.equal(resultRecord.sha256, buildResultSha256);
  const result = await bound(resultRecord), manifest = bundle.manifest;
  same(result.manifest, bundle.manifestRecord); assert.deepEqual(await bound(result.manifest), manifest);
  for (const value of [manifest, result]) {
    assert.equal(value.engineVariant, NATIVE_GRAPH_ENGINE_VARIANT); assert.equal(value.arm, 'candidate');
    assert.equal(value.gameplayPassClaimed, false); assert.equal(value.performancePassClaimed, false);
    assert.equal(value.sourceAfterVerified, true);
  }
  assert.equal(result.schema, 'boxhead-native-graph-build-capture-result-v1'); assert.equal(result.compiled, true);
  assert.equal(result.captureRebuiltCompiler, false); assert.equal(result.preBuildCompleteSourceInventoryClaimed, false);
  assert.equal(manifest.engineManifest.sha256, GRAPH_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.scalarParentManifest.sha256, GRAPH_RUNTIME_PINS.scalarManifest);
  assert.equal(manifest.scalarParentBuildResult.sha256, GRAPH_RUNTIME_PINS.scalarResult);
  assert.equal(manifest.baselineManifest.sha256, GRAPH_RUNTIME_PINS.baselineManifest);
  assert.equal(manifest.versionSeal.sha256, GRAPH_RUNTIME_PINS.versionSeal);
  assert.equal(manifest.imageId, GRAPH_RUNTIME_PINS.imageId);
  assert.deepEqual(manifest.wasmVariants, ['extensions', 'mvp']);
  assert.equal(manifest.files.length, 12); assert.equal(manifest.files.filter(row => row.file.endsWith('.wasm')).length, 2);
  assert.deepEqual(result.files, manifest.files);
  const scalarInputs = await loadNativeScalarRuntimeInputs({ runtimeRoot: path.dirname(manifest.scalarParentManifest.file),
    manifestSha256: GRAPH_RUNTIME_PINS.scalarManifest, buildResultFile: manifest.scalarParentBuildResult.file,
    buildResultSha256: GRAPH_RUNTIME_PINS.scalarResult });
  same(manifest.scalarParentManifest, scalarInputs.summary.manifest); same(manifest.scalarParentBuildResult, scalarInputs.summary.buildResult);
  for (const key of ['baselineManifest', 'toolchainMetadata', 'versionSeal']) same(manifest[key], scalarInputs.summary[key]);
  assert.equal(manifest.imageId, scalarInputs.summary.imageId);
  for (const record of scalarInputs.records) await bound(record, false);
  const engine = await bound(manifest.engineManifest); const names = validateGraphEngine(engine);
  assert.deepEqual(manifest.patchFiles, engine.files);
  const engineDirectory = path.dirname(manifest.engineManifest.file);
  for (const row of engine.files) {
    const file = await realpath(path.resolve(engineDirectory, row.path)), relative = path.relative(engineDirectory, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  for (const key of ['scalarSource', 'graphOverlaySource', 'previousEngineSource']) {
    validateRuntimeFile(engine[key].file);
    const source = await bound({ ...engine[key], file: path.resolve(engineDirectory, engine[key].file) });
    if (key === 'previousEngineSource') validateGraphRevisionDelta(source, engine);
  }
  const capture = await bound(manifest.buildCapture); same(result.buildCapture, manifest.buildCapture);
  assert.equal(capture.schema, 'boxhead-native-graph-build-capture-v1');
  assert.equal(capture.engineVariant, NATIVE_GRAPH_ENGINE_VARIANT); same(capture.engineManifest, manifest.engineManifest);
  assert.equal(capture.captureRebuiltCompiler, false); assert.equal(capture.preBuildCompleteSourceInventoryClaimed, false);
  assert.equal(capture.sourceRoot, await realpath(capture.sourceRoot));
  await bound(capture.config); await bound(capture.captureTool, false);
  await bound(capture.driver, false); const buildStatus = await bound(capture.buildStatus);
  assert.equal(buildStatus.pass, true); assert(!buildStatus.error);
  const stages = [];
  assert.equal(capture.stages?.length, GRAPH_BUILD_GROUPS.length);
  for (const [index, row] of capture.stages.entries()) {
    assert.equal(row.label, GRAPH_BUILD_GROUPS[index].label);
    const status = await bound(row.status); stages.push(status);
    assert.deepEqual(row.log, { file: status.log.path, bytes: status.log.bytes, sha256: status.log.sha256 });
    await bound(row.log, false);
    if (index < 2) validateGraphRustLogs(engine.rustUnitGroups[index], await readFile(row.log.file, 'utf8'));
  }
  validateGraphBuildStages(stages, capture.sourceRoot);
  const before = await bound(capture.sourceBefore), after = await bound(capture.sourceAfter);
  validateGraphSourceProof(before, after, capture.sourceBefore, engine, manifest.versionSeal, stages);
  assert(Date.parse(buildStatus.finishedAt) >= Date.parse(after.finishedAt));
  const seal = await bound(manifest.versionSeal); assert.equal(seal.commitHash, GRAPH_RUNTIME_PINS.sourceCommit);
  const scalarSourceAfter = await bound(scalarInputs.bundle.manifest.sourceAfter);
  const sourceCapture = await bound(capture.fullSourceCapture);
  assert.equal(sourceCapture.schema, 'boxhead-native-graph-postbuild-source-inventory-v1');
  assert.equal(sourceCapture.sourceRoot, capture.sourceRoot); assert.equal(sourceCapture.sourceCommit, GRAPH_RUNTIME_PINS.sourceCommit);
  assert.equal(sourceCapture.engineVariant, NATIVE_GRAPH_ENGINE_VARIANT); same(sourceCapture.engineManifest, manifest.engineManifest);
  same(sourceCapture.parentSourceAfter, scalarInputs.bundle.manifest.sourceAfter);
  assert.deepEqual(sourceCapture.files, expectedGraphSourceFiles(scalarSourceAfter, engine));
  assert.deepEqual(sourceCapture.gitDiffNames, before.gitDiffNames); assert.deepEqual(sourceCapture.gitUntracked, before.gitUntracked);
  assert.equal(sourceCapture.gitHead, GRAPH_RUNTIME_PINS.sourceCommit); assert.equal(sourceCapture.gitIndexClean, true);
  for (const row of sourceCapture.files) {
    const file = await realpath(path.resolve(capture.sourceRoot, row.file)), relative = path.relative(capture.sourceRoot, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    // Empty tracked source files are legitimate; recordGraphInput deliberately
    // rejects empty evidence JSON, so verify these exact empty source entries.
    if (row.bytes === 0) { assert.equal((await stat(file)).size, 0); assert.equal(hash(await readFile(file)), row.sha256); }
    else await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  const mechanism = await bound(capture.mechanismManifest);
  same(capture.mechanismOriginal, capture.mechanismManifest); await bound(capture.mechanismOriginal);
  assert.equal(mechanism.schema, 'boxhead-ruffle-native-graph-bundle-v1'); assert.equal(mechanism.sourceCommit, GRAPH_RUNTIME_PINS.sourceCommit);
  assert.deepEqual(mechanism.files, manifest.files); assert.equal(mechanism.imageId, manifest.imageId); same(mechanism.versionSeal, manifest.versionSeal);
  assert.equal(capture.producedRoot, path.join(capture.sourceRoot, 'web/packages/selfhosted/dist'));
  assert.equal(capture.producedAssets?.length, manifest.files.length);
  for (const [index, produced] of capture.producedAssets.entries()) {
    const expected = manifest.files[index]; assert.equal(produced.file, path.join(capture.producedRoot, expected.file));
    same(produced, expected); await bound(produced, false);
  }
  for (const row of manifest.files.filter(row => row.file.endsWith('.wasm'))) {
    const bytes = await readFile(path.join(bundle.root, row.file));
    assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), 'Invalid WASM header');
    for (const marker of ['boxheadNativeGraphV1', 'bh-avm1-graph-v1', 'boxheadNativeScalarsV1', 'bh-scalars-thing-v1'])
      assert(bytes.includes(Buffer.from(marker)), 'Expected native contract absent from an actual WASM variant: ' + marker);
    assert(!bytes.includes(Buffer.from('boxheadActionPushCacheV1')), 'Unselected ActionPush engine found in graph bundle');
    assert(!scalarInputs.summary.files.some(old => old.file.endsWith('.wasm') && old.sha256 === row.sha256), 'A scalar-only WASM survived in graph bundle');
  }
  const summary = { schema: NATIVE_GRAPH_RUNTIME_SCHEMA, engineVariant: NATIVE_GRAPH_ENGINE_VARIANT,
    sourceCommit: GRAPH_RUNTIME_PINS.sourceCommit, imageId: manifest.imageId, manifest: { ...bundle.manifestRecord }, buildResult: resultRecord,
    engineManifest: manifest.engineManifest, buildCapture: manifest.buildCapture, versionSeal: manifest.versionSeal,
    toolchain: scalarInputs.summary.toolchain, toolchainMetadata: manifest.toolchainMetadata,
    baselineManifest: manifest.baselineManifest, scalarParent: scalarInputs.summary,
    rustFixtures: { executed: names.length, passed: names.length, failed: 0, ignored: 0, names,
      groups: engine.rustUnitGroups.map(group => ({ label: group.label, executed: group.expectedExecuted,
        passed: group.expectedPassed, failed: 0, ignored: 0, names: group.exactNames })) },
    wasmVariants: manifest.wasmVariants,
    files: bundle.initialFiles.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
    linkedRecords: [...records.values()].sort((a, b) => a.file.localeCompare(b.file)),
    sourceFilesVerified: sourceCapture.files.length, sourceAfterVerifiedByBuild: true,
    preBuildCompleteSourceInventoryClaimed: false, exactOverlayBeforeAndAfterVerified: true,
    compilerReproducedByObserver: false, gameplayClaimInheritedFromBuild: false, graphRuntimeCoverageClaimed: false };
  return { bundle, scalarInputs, summary, records: [...records.values()], emptySourceFiles: sourceCapture.files.filter(row => row.bytes === 0)
    .map(row => ({ ...row, file: path.resolve(capture.sourceRoot, row.file) })) };
}

export async function verifyNativeGraphRuntimeInputsAfter(inputs) {
  await verifyNativeScalarRuntimeInputsAfter(inputs.scalarInputs);
  const bundle = await verifyRuntimeBundleAfter(inputs.bundle); await exactGraphBundleInventory(inputs.bundle);
  for (const row of inputs.records) assert.deepEqual(await recordGraphInput(row.file), row, 'Linked graph provenance changed');
  for (const row of inputs.emptySourceFiles) {
    const bytes = await readFile(row.file); assert.equal(bytes.length, 0); assert.equal(hash(bytes), row.sha256);
  }
  return { verified: true, manifest: bundle.manifest, linkedRecords: inputs.records.length, files: bundle.files.length };
}
