import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadRuntimeBundle, verifyRuntimeBundleAfter, validateRuntimeFile } from './native-runtime-bundle.mjs';
import { GRAPH_RUNTIME_PINS, graphRecordShape, recordGraphInput,
  exactGraphBundleInventory, validateGraphEngine,
  loadNativeGraphRuntimeInputs as loadParentGraphRuntimeInputs,
  verifyNativeGraphRuntimeInputsAfter as verifyParentGraphRuntimeInputsAfter } from './native-graph-runtime-binding.mjs';

export const NATIVE_PROJECTION_ENGINE_VARIANT = 'native-scalars-v2-plus-native-graph-v1-plus-projection-scan-v1';
export const NATIVE_PROJECTION_RUNTIME_SCHEMA = 'original-native-projection-runtime-v1';
export const PROJECTION_RUNTIME_PINS = Object.freeze({
  sourceCommit: GRAPH_RUNTIME_PINS.sourceCommit,
  engineManifest: '47d7f4e40bdf3b348d8dd21ad2c8b8cfbbe613b026a68772d72977794691b430',
  parentRuntimeManifest: '07bbf5ba931f64afa1a00ad8236d911814d1f0754a5d8871443ca78f3c9460fb',
  parentBuildResult: '925184ba06df9b94325c34f71d1a855b58492a387a5ff25400261229535b4cab',
  parentEngineManifest: GRAPH_RUNTIME_PINS.engineManifest,
  imageId: GRAPH_RUNTIME_PINS.imageId,
});
export const PROJECTION_OVERLAY_PATHS = Object.freeze([
  'core/src/avm1/activation.rs', 'core/src/avm1/globals.rs', 'core/src/avm1/runtime.rs',
  'core/src/avm1/globals/boxhead_native_projection_scan.rs',
  'core/src/avm1/globals/boxhead_native_projection_scan/tests.rs',
  'core/src/avm1/globals/boxhead_native_projection_scan/activation_tests.rs',
]);
const SHA = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => ({ bytes: value?.bytes, sha256: value?.sha256 });
const same = (one, two, label) => assert.deepEqual(identity(one), identity(two), label);
const sourceRow = row => ({ path: row.path ?? row.file, bytes: row.bytes, sha256: row.sha256 });
const sorted = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'));
const BUILD_LABELS = ['graph', 'scalar', 'projection', 'wasm', 'selfhosted'];
export const PROJECTION_RESOURCE_SCOPE = 'Cargo and all descendant build/test processes; not export-only memory';
export const PROJECTION_RESOURCE_WRAPPER = "import json,resource,subprocess,sys\n"
  + "p=subprocess.run(sys.argv[1:])\n"
  + "print('BOXHEAD_NATIVE_PROJECTOR_RESOURCE '+json.dumps({'maxRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,"
  + "'scope':'Cargo and all descendant build/test processes; not export-only memory'}),flush=True)\n"
  + "sys.exit(p.returncode)";

export function validateProjectionEngine(engine, parent) {
  validateGraphEngine(parent);
  assert.equal(engine.schema, 'boxhead-ruffle-native-projector-engine-source-v1');
  assert.equal(engine.engineVariant, NATIVE_PROJECTION_ENGINE_VARIANT); assert.equal(engine.sourceRevision, 1);
  assert.deepEqual(engine.upstream, parent.upstream);
  assert.equal(engine.parentSource.file, 'tools/ruffle-native-graph/engine/manifest.json');
  assert.equal(engine.parentSource.sha256, PROJECTION_RUNTIME_PINS.parentEngineManifest);
  assert.equal(engine.parentSource.bytes, 9526);
  assert.deepEqual(engine.files.map(row => row.path).sort(), [...PROJECTION_OVERLAY_PATHS].sort());
  const old = new Map(parent.files.map(row => [row.path, row]));
  for (const row of engine.files) {
    validateRuntimeFile(row.path); assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && SHA.test(row.sha256));
    if (old.has(row.path)) {
      assert.equal(row.baselineAbsent, undefined); assert.equal(row.baselineBytes, old.get(row.path).bytes);
      assert.equal(row.baselineSha256, old.get(row.path).sha256);
      assert.notEqual(row.sha256, row.baselineSha256, 'Declared integration file did not change');
    } else assert.equal(row.baselineAbsent, true);
  }
  assert.deepEqual(sorted(engine.unchangedParentFiles), sorted(parent.files.filter(row => !PROJECTION_OVERLAY_PATHS.includes(row.path)).map(sourceRow)),
    'Original graph/scalar source, tests and object implementation must stay byte identical');
  const abi = engine.abi.scan;
  assert.equal(abi.global, 'boxheadNativeProjectionScanV1'); assert.equal(abi.version, 1);
  assert.equal(abi.contract, 'bh-projection-scan-v1'); assert.deepEqual(abi.operations, ['capability', 'run']);
  assert.deepEqual(abi.capabilityOwnFields, ['version', 'contract', 'calls', 'completed', 'unsupported', 'keys', 'ownReads']);
  assert.deepEqual(abi.runArguments, ['run', 'source', 'as2CreatedOutput', 'initialFieldCache', 'CMain', 'upgradesBoolean']);
  assert.deepEqual(abi.successOwnFields, ['version', 'scalarFields', 'keys']);
  assert.deepEqual(engine.limits, parent.limits, 'Native checkpoint bounds changed');
  assert.deepEqual(engine.rustUnitGroups.slice(0, 2), parent.rustUnitGroups, 'Original graph/scalar exact test sets changed');
  assert.equal(engine.rustUnitGroups.length, 3); assert.equal(engine.totalRequiredRustTests, 62);
  const projection = engine.rustUnitGroups[2];
  assert.equal(projection.label, 'projection'); assert.equal(projection.filter, 'native_projection_scan');
  assert.equal(projection.expectedExecuted, 30); assert.equal(projection.expectedPassed, 30);
  assert.equal(projection.expectedFailed, 0); assert.equal(projection.expectedIgnored, 0);
  assert.equal(projection.exactNames.length, 30); assert.equal(new Set(projection.exactNames).size, 30);
  assert(projection.exactNames.every(name => /^avm1::(?:globals::boxhead_native_projection_scan::tests|activation::native_projection_scan_boundary_tests)::[a-z0-9_]+$/.test(name)));
  const names = engine.rustUnitGroups.flatMap(group => group.exactNames);
  assert.equal(new Set(names).size, 62);
  assert.deepEqual(engine.qualification, { compilerReproducedHere: false, gameplayPassClaimed: false,
    performancePassClaimed: false, inheritedParentPassesAccepted: false });
  return names;
}

/** Exact final input tree derived from the already verified v5 source tree. */
export function expectedProjectionSourceFiles(parentSource, engine, versionSeal) {
  assert.equal(parentSource.schema, 'boxhead-native-graph-postbuild-source-inventory-v1');
  assert.equal(parentSource.sourceCommit, PROJECTION_RUNTIME_PINS.sourceCommit);
  assert(Array.isArray(parentSource.files) && parentSource.files.length > 2000 && parentSource.files.length < 10000);
  const files = new Map();
  for (const item of parentSource.files) {
    const row = sourceRow(item); validateRuntimeFile(row.path);
    assert(!files.has(row.path)); assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256));
    files.set(row.path, row);
  }
  for (const item of engine.files) files.set(item.path, sourceRow(item));
  assert(Number.isSafeInteger(versionSeal.bytes) && versionSeal.bytes > 0 && SHA.test(versionSeal.sha256));
  files.set('web/version_seal.json', { path: 'web/version_seal.json', ...identity(versionSeal) });
  return sorted([...files.values()]);
}

export function validateProjectionSourceProof(before, after, parentSource, engine, versionSeal, stages, sourceRoot) {
  const expected = expectedProjectionSourceFiles(parentSource, engine, versionSeal);
  const diff = [...new Set([...parentSource.gitDiffNames, ...engine.files.filter(row => !row.baselineAbsent).map(row => row.path)])].sort();
  const untracked = [...new Set([...parentSource.gitUntracked, ...engine.files.filter(row => row.baselineAbsent).map(row => row.path), 'web/version_seal.json'])].sort();
  for (const snapshot of [before, after]) {
    assert.equal(snapshot.schema, 'boxhead-native-projector-full-source-v1');
    assert.equal(snapshot.sourceCommit, PROJECTION_RUNTIME_PINS.sourceCommit);
    assert.equal(snapshot.engineVariant, NATIVE_PROJECTION_ENGINE_VARIANT);
    assert.equal(snapshot.sourceRoot, sourceRoot); assert.equal(snapshot.gitHead, PROJECTION_RUNTIME_PINS.sourceCommit);
    assert.equal(snapshot.gitIndexClean, true);
    assert.deepEqual(snapshot.gitDiffNames, diff); assert.deepEqual(snapshot.gitUntracked, untracked);
    assert(snapshot.files.every(row => Object.keys(row).sort().join(',') === 'bytes,path,sha256'));
    assert.deepEqual(sorted(snapshot.files), expected, 'Complete source inventory differs from exact v5-plus-scan tree');
    same(snapshot.versionSeal, versionSeal);
    assert(Number.isFinite(Date.parse(snapshot.recordedAt)), 'Source inventory requires its actual capture timestamp');
  }
  assert.deepEqual(after.files, before.files, 'Pre/post source inventory changed during build');
  assert(Date.parse(before.recordedAt) <= Date.parse(stages[0].startedAt), 'Source-before was captured after compilation began');
  assert(Date.parse(after.recordedAt) >= Date.parse(stages.at(-1).finishedAt), 'Source-after precedes build completion');
  return expected;
}

export function validateProjectionRustLogs(group, text, expectedResources) {
  const names = [...text.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(row => row[1]);
  assert.deepEqual(names.sort(), [...group.exactNames].sort(), 'Actual new-build Rust fixture names differ');
  const summaries = [...text.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;/gm)].map(row => row.slice(1));
  assert.deepEqual(summaries, [[String(group.expectedExecuted), '0', '0', '0']], 'Rust fixture result is not a complete fresh pass');
  const resources = [...text.matchAll(/^BOXHEAD_NATIVE_PROJECTOR_RESOURCE (.+)$/gm)].map(row => JSON.parse(row[1]));
  assert.equal(resources.length, 1, 'Missing actual new-build resource measurement');
  assert.deepEqual(Object.keys(resources[0]).sort(), ['maxRssKiB', 'scope']);
  assert(Number.isSafeInteger(resources[0].maxRssKiB) && resources[0].maxRssKiB > 0);
  assert.equal(resources[0].scope, PROJECTION_RESOURCE_SCOPE);
  if (expectedResources) assert.deepEqual(resources[0], expectedResources);
  return names;
}

export function validateProjectionBuildStages(plan, capture, engine) {
  assert.deepEqual(plan.stages.map(row => row.label), BUILD_LABELS);
  assert.deepEqual(capture.stages.map(row => row.label), BUILD_LABELS);
  assert.deepEqual(plan.resources, { cpus: 2, memory: '6g' });
  assert.equal(plan.imageId, PROJECTION_RUNTIME_PINS.imageId);
  assert.equal(plan.environment.CARGO_BUILD_JOBS, '2');
  let finished = Date.parse(capture.startedAt); assert(Number.isFinite(finished));
  for (let index = 0; index < BUILD_LABELS.length; index++) {
    const intended = plan.stages[index], actual = capture.stages[index];
    assert.equal(actual.state, 'complete'); assert.equal(actual.returncode, 0); assert(!actual.error);
    assert.deepEqual(actual.command, intended.command); assert.equal(actual.cwd, intended.cwd);
    assert(path.isAbsolute(actual.cwd), 'Build driver working directory must be absolute');
    assert(Number.isSafeInteger(intended.timeoutSeconds) && intended.timeoutSeconds > 0 && intended.timeoutSeconds <= 7200);
    const start = Date.parse(actual.startedAt), end = Date.parse(actual.finishedAt);
    assert(Number.isFinite(start) && Number.isFinite(end) && start >= finished && end >= start);
    assert(end - start <= intended.timeoutSeconds * 1000 + 5000, 'Build stage exceeded its declared timeout'); finished = end;
    const argv = actual.command; assert(Array.isArray(argv) && argv.every(value => typeof value === 'string'));
    assert.deepEqual(argv.slice(0, 3), ['docker', 'run', '--rm']);
    const imageIndex = argv.indexOf(plan.imageId); assert(imageIndex > 2 && argv.lastIndexOf(plan.imageId) === imageIndex);
    const option = key => { const at = argv.indexOf(key); assert(at >= 3 && at < imageIndex); assert.equal(argv.lastIndexOf(key), at); return argv[at + 1]; };
    assert.equal(option('--cpus'), '2'); assert.equal(option('--memory'), '6g');
    assert.equal(option('--workdir'), index < 3 ? '/work' : '/work/web');
    const mounts = argv.flatMap((value, at) => value === '--mount' ? [argv[at + 1]] : []);
    assert(mounts.includes('type=bind,source=' + plan.sourceRoot + ',target=/work'));
    const environment = argv.flatMap((value, at) => value === '--env' ? [argv[at + 1]] : []);
    for (const [key, value] of Object.entries(plan.environment)) assert(environment.includes(key + '=' + value));
    let command = argv.slice(imageIndex + 1);
    if (command[0] === 'python3') {
      assert.equal(command[1], '-c'); assert.equal(command[2], PROJECTION_RESOURCE_WRAPPER);
      command = command.slice(3);
    }
    if (index < 3) {
      const filter = engine.rustUnitGroups[index].filter;
      const wanted = ['cargo', 'test', '--locked', '-p', 'ruffle_core', '--lib', filter];
      command = command.filter(value => value !== '--offline');
      assert.deepEqual(command.slice(0, wanted.length), wanted);
      const rest = command.slice(wanted.length); assert.equal(rest[0], '--');
      assert(rest.includes('--test-threads=1'), 'Rust fixtures must run serially on this bounded host');
      assert(rest.slice(1).every(value => ['--nocapture', '--test-threads=1', '--color', 'never'].includes(value)));
    } else assert.deepEqual(command, ['npm', 'run', 'build', '--workspace=' + (index === 3 ? 'ruffle-core' : 'ruffle-selfhosted')]);
    graphRecordShape(actual.log);
  }
  assert(Date.parse(capture.finishedAt) >= finished); assert.equal(capture.pass, true);
}

/** Metadata closure is followed by independent actual file/log verification. */
export function validateProjectionBuildDocuments({ manifest, result, plan, capture, fixtures, engine, parentManifest }) {
  for (const value of [manifest, result, plan, capture, fixtures]) assert.equal(value.engineVariant, NATIVE_PROJECTION_ENGINE_VARIANT);
  for (const value of [manifest, result]) {
    assert.equal(value.arm, 'candidate'); assert.equal(value.sourceAfterVerified, true);
    assert.equal(value.gameplayPassClaimed, false); assert.equal(value.performancePassClaimed, false);
  }
  assert.equal(manifest.schema, 'boxhead-ruffle-web-bundle-v1');
  assert.equal(manifest.sourceCommit, PROJECTION_RUNTIME_PINS.sourceCommit);
  assert.equal(result.schema, 'boxhead-native-projector-build-result-v1'); assert.equal(result.compiled, true);
  assert.equal(result.captureRebuiltCompiler, true); assert.equal(result.preBuildCompleteSourceInventoryClaimed, true);
  assert.equal(plan.schema, 'boxhead-native-projector-build-plan-v1');
  assert.equal(plan.sourceCommit, PROJECTION_RUNTIME_PINS.sourceCommit);
  assert.equal(capture.schema, 'boxhead-native-projector-build-capture-v1');
  assert.equal(manifest.engineManifest.sha256, PROJECTION_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.parentRuntimeManifest.sha256, PROJECTION_RUNTIME_PINS.parentRuntimeManifest);
  assert.equal(manifest.parentBuildResult.sha256, PROJECTION_RUNTIME_PINS.parentBuildResult);
  for (const key of ['engineManifest', 'buildPlan', 'buildCapture', 'sourceBefore', 'sourceAfter', 'rustFixtures']) assert.deepEqual(result[key], manifest[key], 'Result/manifest binding: ' + key);
  for (const key of ['engineManifest', 'parentRuntimeManifest', 'parentBuildResult', 'sourceBefore', 'versionSeal']) assert.deepEqual(plan[key], manifest[key], 'Plan/manifest binding: ' + key);
  for (const key of ['buildPlan', 'sourceBefore', 'sourceAfter', 'rustFixtures']) assert.deepEqual(capture[key], manifest[key], 'Capture/manifest binding: ' + key);
  assert.equal(manifest.imageId, plan.imageId); assert.equal(manifest.imageId, parentManifest.imageId);
  assert.deepEqual(manifest.patchFiles, engine.files);
  assert.deepEqual(manifest.wasmVariants, ['extensions', 'mvp']);
  assert.equal(manifest.files.length, 12); assert.equal(manifest.files.filter(row => row.file.endsWith('.wasm')).length, 2);
  assert.deepEqual(result.files, manifest.files);
  const oldWasm = new Set(parentManifest.files.filter(row => row.file.endsWith('.wasm')).map(row => row.sha256));
  for (const row of manifest.files.filter(row => row.file.endsWith('.wasm')))
    assert(!oldWasm.has(row.sha256), 'Old v5 WASM was relabeled as the new scanner');
  assert.equal(fixtures.schema, 'boxhead-native-projector-rust-fixtures-v1');
  assert.deepEqual(fixtures.engineManifest, manifest.engineManifest);
  assert.equal(fixtures.groups.length, 3);
  assert.equal(fixtures.totalExecuted, 62); assert.equal(fixtures.inheritedPasses, false);
  for (let index = 0; index < 3; index++) {
    const expected = engine.rustUnitGroups[index], actual = fixtures.groups[index];
    assert.equal(actual.label, expected.label); assert.equal(actual.filter, expected.filter);
    for (const [key, value] of [['executed', expected.expectedExecuted], ['passed', expected.expectedPassed], ['failed', 0], ['ignored', 0]]) assert.equal(actual[key], value);
    assert.deepEqual([...actual.exactNames].sort(), [...expected.exactNames].sort());
    assert.deepEqual(actual.log, capture.stages[index].log);
    assert.deepEqual(Object.keys(actual.resources).sort(), ['maxRssKiB', 'scope']);
    assert(Number.isSafeInteger(actual.resources.maxRssKiB) && actual.resources.maxRssKiB > 0);
    assert.equal(actual.resources.scope, PROJECTION_RESOURCE_SCOPE);
  }
  validateProjectionBuildStages(plan, capture, engine);
}

// Function names retain the existing campaign observer interface only. The
// new variant/schema and every provenance check remain explicit and separate.
export async function loadNativeGraphRuntimeInputs({ runtimeRoot, manifestSha256, buildResultFile, buildResultSha256 }) {
  assert(SHA.test(manifestSha256) && SHA.test(buildResultSha256));
  const bundle = await loadRuntimeBundle({ side: 'candidate', root: runtimeRoot, expectedSha256: manifestSha256 });
  await exactGraphBundleInventory(bundle);
  const records = new Map(), emptySourceFiles = [];
  async function bound(binding, json = true) {
    graphRecordShape(binding); const actual = await recordGraphInput(binding.file); same(actual, binding);
    const previous = records.get(actual.file); if (previous) assert.deepEqual(actual, previous);
    records.set(actual.file, actual);
    if (!json) return actual;
    assert(actual.bytes <= 16 * 1024 * 1024); const bytes = await readFile(actual.file);
    assert.equal(bytes.length, actual.bytes); assert.equal(hash(bytes), actual.sha256);
    return JSON.parse(bytes.toString('utf8'));
  }
  const resultRecord = await recordGraphInput(buildResultFile); assert.equal(resultRecord.sha256, buildResultSha256);
  const result = await bound(resultRecord), manifest = bundle.manifest;
  same(result.manifest, bundle.manifestRecord); assert.deepEqual(await bound(result.manifest), manifest);
  // Reject old-family provenance before loading any claimed parent chain.
  assert.equal(manifest.engineVariant, NATIVE_PROJECTION_ENGINE_VARIANT);
  assert.equal(result.engineVariant, NATIVE_PROJECTION_ENGINE_VARIANT);
  assert.equal(manifest.engineManifest.sha256, PROJECTION_RUNTIME_PINS.engineManifest);
  assert.equal(manifest.parentRuntimeManifest.sha256, PROJECTION_RUNTIME_PINS.parentRuntimeManifest);
  assert.equal(manifest.parentBuildResult.sha256, PROJECTION_RUNTIME_PINS.parentBuildResult);
  const parentInputs = await loadParentGraphRuntimeInputs({ runtimeRoot: path.dirname(manifest.parentRuntimeManifest.file),
    manifestSha256: PROJECTION_RUNTIME_PINS.parentRuntimeManifest, buildResultFile: manifest.parentBuildResult.file,
    buildResultSha256: PROJECTION_RUNTIME_PINS.parentBuildResult });
  same(manifest.parentRuntimeManifest, parentInputs.summary.manifest); same(manifest.parentBuildResult, parentInputs.summary.buildResult);
  const engine = await bound(manifest.engineManifest), parentEngine = await bound(parentInputs.summary.engineManifest);
  const names = validateProjectionEngine(engine, parentEngine);
  const engineDirectory = path.dirname(manifest.engineManifest.file);
  for (const row of engine.files) {
    const file = await realpath(path.resolve(engineDirectory, row.path)), relative = path.relative(engineDirectory, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  const plan = await bound(manifest.buildPlan), capture = await bound(manifest.buildCapture), fixtures = await bound(manifest.rustFixtures);
  validateProjectionBuildDocuments({ manifest, result, plan, capture, fixtures, engine, parentManifest: parentInputs.bundle.manifest });
  await bound(plan.driver, false);
  assert.equal(await realpath(plan.sourceRoot), plan.sourceRoot);
  for (let index = 0; index < capture.stages.length; index++) {
    await bound(capture.stages[index].log, false);
    if (index < 3) validateProjectionRustLogs(engine.rustUnitGroups[index], await readFile(capture.stages[index].log.file, 'utf8'), fixtures.groups[index].resources);
  }
  const parentCapture = await bound(parentInputs.summary.buildCapture), parentSource = await bound(parentCapture.fullSourceCapture);
  const before = await bound(manifest.sourceBefore), after = await bound(manifest.sourceAfter);
  const seal = await bound(manifest.versionSeal); assert.equal(seal.commitHash, PROJECTION_RUNTIME_PINS.sourceCommit);
  const sourceFiles = validateProjectionSourceProof(before, after, parentSource, engine, manifest.versionSeal, capture.stages, plan.sourceRoot);
  for (const row of sourceFiles) {
    const file = await realpath(path.resolve(plan.sourceRoot, row.path)), relative = path.relative(plan.sourceRoot, file);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    if (row.bytes === 0) {
      assert.equal((await stat(file)).size, 0); assert.equal(hash(await readFile(file)), row.sha256);
      emptySourceFiles.push({ file, bytes: 0, sha256: row.sha256 });
    } else await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  for (const row of manifest.files) {
    const produced = path.resolve(plan.sourceRoot, 'web/packages/selfhosted/dist', row.file);
    await bound({ file: produced, bytes: row.bytes, sha256: row.sha256 }, false);
    if (row.file.endsWith('.wasm')) {
      const bytes = await readFile(path.resolve(bundle.root, row.file));
      assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
      for (const marker of ['boxheadNativeGraphV1', 'bh-avm1-graph-v1', 'boxheadNativeScalarsV1', 'bh-scalars-thing-v1',
        'boxheadNativeProjectionScanV1', 'bh-projection-scan-v1']) assert(bytes.includes(Buffer.from(marker)), 'Compiled ABI marker absent: ' + marker);
      assert(!bytes.includes(Buffer.from('boxheadActionPushCacheV1')), 'Unselected ActionPush cache was compiled');
    }
  }
  const summary = { schema: NATIVE_PROJECTION_RUNTIME_SCHEMA, engineVariant: NATIVE_PROJECTION_ENGINE_VARIANT,
    sourceCommit: PROJECTION_RUNTIME_PINS.sourceCommit, imageId: manifest.imageId,
    manifest: bundle.manifestRecord, buildResult: resultRecord, engineManifest: manifest.engineManifest,
    buildPlan: manifest.buildPlan, buildCapture: manifest.buildCapture, sourceBefore: manifest.sourceBefore,
    sourceAfter: manifest.sourceAfter, versionSeal: manifest.versionSeal,
    parentRuntimeManifest: manifest.parentRuntimeManifest, parentBuildResult: manifest.parentBuildResult,
    rustFixtures: { record: manifest.rustFixtures, executed: 62, passed: 62, failed: 0, ignored: 0, names },
    wasmVariants: manifest.wasmVariants, files: bundle.initialFiles.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
    sourceFilesVerified: sourceFiles.length, completeSourceBeforeAndAfterVerified: true,
    sourceAfterVerifiedByBuild: true, compilerReproducedByObserver: false,
    gameplayClaimInheritedFromBuild: false, parentTestPassesInherited: false,
    linkedRecords: [...records.values()].sort((a, b) => a.file.localeCompare(b.file)) };
  return { bundle, parentInputs, summary, records: [...records.values()], emptySourceFiles };
}

export async function verifyNativeGraphRuntimeInputsAfter(inputs) {
  await verifyParentGraphRuntimeInputsAfter(inputs.parentInputs);
  const bundle = await verifyRuntimeBundleAfter(inputs.bundle); await exactGraphBundleInventory(inputs.bundle);
  for (const row of inputs.records) assert.deepEqual(await recordGraphInput(row.file), row, 'New runtime source/build evidence changed');
  for (const row of inputs.emptySourceFiles) {
    const bytes = await readFile(row.file); assert.equal(bytes.length, 0); assert.equal(hash(bytes), row.sha256);
  }
  return { verified: true, manifest: bundle.manifest, linkedRecords: inputs.records.length, files: bundle.files.length,
    engineVariant: NATIVE_PROJECTION_ENGINE_VARIANT };
}
