#!/usr/bin/env node
// CI-only evidence capture. This does not rebuild, amend source, relabel a
// historical bundle, run gameplay, or synthesize absent pre-build records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadNativeScalarRuntimeInputs, verifyNativeScalarRuntimeInputsAfter } from '../../scripts/lib/native-scalar-runtime-binding.mjs';
import { validateRuntimeManifest } from '../../scripts/lib/native-runtime-bundle.mjs';
import { GRAPH_RUNTIME_PINS, GRAPH_BUILD_GROUPS, NATIVE_GRAPH_ENGINE_VARIANT,
  recordGraphInput, validateGraphEngine, validateGraphRevisionDelta, validateGraphRustLogs, validateGraphBuildStages,
  validateGraphSourceProof, expectedGraphSourceFiles, loadNativeGraphRuntimeInputs,
  verifyNativeGraphRuntimeInputsAfter } from '../../scripts/lib/native-graph-runtime-binding.mjs';

const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (one, two) => assert.deepEqual({ bytes: one.bytes, sha256: one.sha256 }, { bytes: two.bytes, sha256: two.sha256 });
const stamp = () => new Date().toISOString();
async function json(file) { const bytes = await readFile(file); assert(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024); return JSON.parse(bytes.toString('utf8')); }
async function save(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return recordGraphInput(file); }
async function filesIn(directory, prefix = '') {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) rows.push(...await filesIn(path.join(directory, entry.name), prefix + entry.name + '/'));
    else { assert(entry.isFile(), 'Runtime/build inventory contains a nonregular file'); rows.push(prefix + entry.name); }
  }
  return rows.sort();
}
async function git(root, args) { const value = await run('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }); return value.stdout; }

async function main() {
  assert(process.argv.length === 4 && process.argv[2] === '--config', 'Usage: node tools/ruffle-native-graph/capture.mjs --config CAPTURE_REQUEST.json');
  const configRecord = await recordGraphInput(process.argv[3]), config = await json(configRecord.file);
  assert.equal(config.schema, 'boxhead-native-graph-capture-request-v1');
  assert.deepEqual(Object.keys(config).sort(), ['schema', 'sourceRoot', 'mechanismBundleRoot', 'scalarRuntimeRoot',
    'scalarBuildResultFile', 'buildDriverFile', 'buildStatusFile', 'sourceBeforeFile', 'sourceAfterFile', 'stages', 'outputRoot'].sort());
  assert.deepEqual(Object.keys(config.stages).sort(), ['graph', 'scalar', 'wasm', 'selfhosted'].sort());
  const sourceRoot = await realpath(config.sourceRoot), mechanismRoot = await realpath(config.mechanismBundleRoot);
  const outputRoot = path.resolve(config.outputRoot);
  assert(outputRoot !== sourceRoot && outputRoot !== mechanismRoot);
  const engineRoot = fileURLToPath(new URL('./engine/', import.meta.url));
  const packageManifest = await recordGraphInput(path.join(engineRoot, 'manifest.json'));
  assert.equal(packageManifest.sha256, GRAPH_RUNTIME_PINS.engineManifest);
  const engine = await json(packageManifest.file); validateGraphEngine(engine);
  for (const row of engine.files) same(await recordGraphInput(path.join(engineRoot, row.path)), row);
  for (const key of ['scalarSource', 'graphOverlaySource', 'previousEngineSource']) same(await recordGraphInput(path.join(engineRoot, engine[key].file)), engine[key]);
  validateGraphRevisionDelta(await json(path.join(engineRoot, engine.previousEngineSource.file)), engine);
  const scalarInputs = await loadNativeScalarRuntimeInputs({ runtimeRoot: config.scalarRuntimeRoot,
    manifestSha256: GRAPH_RUNTIME_PINS.scalarManifest, buildResultFile: config.scalarBuildResultFile,
    buildResultSha256: GRAPH_RUNTIME_PINS.scalarResult });
  const scalarSourceAfter = await json(scalarInputs.bundle.manifest.sourceAfter.file);
  const fullFiles = expectedGraphSourceFiles(scalarSourceAfter, engine);
  for (const row of fullFiles) {
    const file = path.resolve(sourceRoot, row.file), resolved = await realpath(file), relative = path.relative(sourceRoot, resolved);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    const bytes = await readFile(resolved); assert.equal(bytes.length, row.bytes, 'Current source size differs: ' + row.file);
    assert.equal(digest(bytes), row.sha256, 'Current source is outside the pinned scalar plus graph overlay: ' + row.file);
  }
  const [head, changes, staged, untracked, tracked] = await Promise.all([
    git(sourceRoot, ['rev-parse', 'HEAD']), git(sourceRoot, ['diff', '--name-only']),
    git(sourceRoot, ['diff', '--cached', '--name-only']), git(sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(sourceRoot, ['ls-files', '-z']),
  ]);
  assert.equal(head.trim(), GRAPH_RUNTIME_PINS.sourceCommit); assert.equal(staged, '');
  const beforeRecord = await recordGraphInput(config.sourceBeforeFile), afterRecord = await recordGraphInput(config.sourceAfterFile);
  const before = await json(beforeRecord.file), after = await json(afterRecord.file);
  assert.deepEqual(changes.trim().split('\n').filter(Boolean).sort(), before.gitDiffNames);
  assert.deepEqual(untracked.split('\0').filter(Boolean).sort(), before.gitUntracked);
  // Every materialized tracked file has to be in the pinned parent inventory;
  // the parent's omitted fixture tree remains outside this build capture.
  const expectedNames = new Set(fullFiles.map(row => row.file));
  for (const name of tracked.split('\0').filter(Boolean)) if (!expectedNames.has(name)) {
    assert(name.startsWith('tests/tests/'), 'Unexpected tracked source outside parent inventory: ' + name);
    try { await realpath(path.join(sourceRoot, name)); assert.fail('Previously absent fixture source appeared: ' + name); }
    catch (error) { assert.equal(error.code, 'ENOENT'); }
  }
  const versionSeal = await recordGraphInput(path.join(sourceRoot, 'web/version_seal.json'));
  same(versionSeal, scalarInputs.summary.versionSeal); assert.equal(versionSeal.sha256, GRAPH_RUNTIME_PINS.versionSeal);
  const stages = [], stageBindings = [];
  for (const [index, group] of GRAPH_BUILD_GROUPS.entries()) {
    const statusRecord = await recordGraphInput(config.stages[group.label]), status = await json(statusRecord.file);
    stages.push(status);
    const log = await recordGraphInput(status.log.path); same(log, status.log);
    stageBindings.push({ label: group.label, status: statusRecord, log });
    if (index < 2) validateGraphRustLogs(engine.rustUnitGroups[index], await readFile(log.file, 'utf8'));
  }
  validateGraphBuildStages(stages, sourceRoot);
  validateGraphSourceProof(before, after, beforeRecord, engine, versionSeal, stages);
  const buildStatus = await recordGraphInput(config.buildStatusFile), buildValue = await json(buildStatus.file);
  assert.equal(buildValue.pass, true); assert(!buildValue.error); assert(Date.parse(buildValue.finishedAt) >= Date.parse(after.finishedAt));
  const driver = await recordGraphInput(config.buildDriverFile);
  const mechanismRecord = await recordGraphInput(path.join(mechanismRoot, 'manifest.json'));
  const mechanismBytes = await readFile(mechanismRecord.file), mechanism = JSON.parse(mechanismBytes.toString('utf8'));
  assert.equal(mechanism.schema, 'boxhead-ruffle-native-graph-bundle-v1'); assert.equal(mechanism.sourceCommit, GRAPH_RUNTIME_PINS.sourceCommit);
  assert.equal(mechanism.imageId, GRAPH_RUNTIME_PINS.imageId); same(mechanism.versionSeal, versionSeal);
  assert.equal(mechanism.gameplayPassClaimed, false); assert.equal(mechanism.performancePassClaimed, false);
  const fileMap = validateRuntimeManifest({ ...mechanism, schema: 'boxhead-ruffle-web-bundle-v1' });
  assert.equal(fileMap.size, 12); assert.equal(mechanism.files.filter(row => row.file.endsWith('.wasm')).length, 2);
  assert.deepEqual(await filesIn(mechanismRoot), ['manifest.json', ...fileMap.keys()].sort());
  const producedRoot = path.join(sourceRoot, 'web/packages/selfhosted/dist');
  assert.deepEqual(await filesIn(producedRoot), [...fileMap.keys()].sort(), 'Current webpack output and mechanism bundle inventories differ');
  const producedAssets = [];
  for (const row of mechanism.files) {
    same(await recordGraphInput(path.join(mechanismRoot, row.file)), row);
    const produced = await recordGraphInput(path.join(producedRoot, row.file)); same(produced, row); producedAssets.push(produced);
  }
  // All retained input records have been checked before creating a new seal.
  // Existing outputs are never overwritten or rebound to new content.
  await mkdir(path.dirname(outputRoot), { recursive: true }); await mkdir(outputRoot, { recursive: false });
  const outputEngine = path.join(outputRoot, 'engine'), runtimeRoot = path.join(outputRoot, 'runtime');
  await mkdir(outputEngine); await mkdir(runtimeRoot);
  for (const file of ['manifest.json', engine.scalarSource.file, engine.graphOverlaySource.file, engine.previousEngineSource.file,
    ...engine.files.map(row => row.path)]) {
    const destination = path.join(outputEngine, file); await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(engineRoot, file), destination);
  }
  const engineManifest = await recordGraphInput(path.join(outputEngine, 'manifest.json'));
  for (const row of mechanism.files) await copyFile(path.join(mechanismRoot, row.file), path.join(runtimeRoot, row.file));
  const copiedMechanism = path.join(outputRoot, 'mechanism-manifest.json'); await writeFile(copiedMechanism, mechanismBytes, { flag: 'wx' });
  const mechanismManifest = await recordGraphInput(copiedMechanism); same(mechanismManifest, mechanismRecord);
  const fullSourceCapture = await save(path.join(outputRoot, 'source-inventory.json'), {
    schema: 'boxhead-native-graph-postbuild-source-inventory-v1', capturedAt: stamp(),
    sourceCommit: GRAPH_RUNTIME_PINS.sourceCommit, engineVariant: NATIVE_GRAPH_ENGINE_VARIANT, sourceRoot,
    engineManifest, parentSourceAfter: scalarInputs.bundle.manifest.sourceAfter, files: fullFiles,
    gitHead: head.trim(), gitDiffNames: before.gitDiffNames, gitUntracked: before.gitUntracked, gitIndexClean: true,
  });
  const buildCapture = await save(path.join(outputRoot, 'build-capture.json'), {
    schema: 'boxhead-native-graph-build-capture-v1', capturedAt: stamp(), engineVariant: NATIVE_GRAPH_ENGINE_VARIANT,
    sourceRoot, engineManifest, config: configRecord, captureTool: await recordGraphInput(fileURLToPath(import.meta.url)),
    driver, buildStatus, stages: stageBindings, sourceBefore: beforeRecord, sourceAfter: afterRecord,
    fullSourceCapture, mechanismManifest, mechanismOriginal: mechanismRecord, producedRoot, producedAssets,
    captureRebuiltCompiler: false, preBuildCompleteSourceInventoryClaimed: false,
    scope: 'Retained exact nine-file overlay before/after and real command logs; full post-build source inventory checked against the pinned scalar parent plus the declared graph overlay.',
  });
  const manifest = { schema: 'boxhead-ruffle-web-bundle-v1', sourceCommit: GRAPH_RUNTIME_PINS.sourceCommit,
    arm: 'candidate', engineVariant: NATIVE_GRAPH_ENGINE_VARIANT, createdAt: stamp(), imageId: GRAPH_RUNTIME_PINS.imageId,
    files: mechanism.files, engineManifest, buildCapture, scalarParentManifest: scalarInputs.summary.manifest,
    scalarParentBuildResult: scalarInputs.summary.buildResult, baselineManifest: scalarInputs.summary.baselineManifest,
    toolchainMetadata: scalarInputs.summary.toolchainMetadata, versionSeal, wasmVariants: ['extensions', 'mvp'],
    patchFiles: engine.files, sourceAfterVerified: true, gameplayPassClaimed: false, performancePassClaimed: false };
  const manifestRecord = await save(path.join(runtimeRoot, 'manifest.json'), manifest);
  const resultRecord = await save(path.join(outputRoot, 'result.json'), {
    schema: 'boxhead-native-graph-build-capture-result-v1', engineVariant: NATIVE_GRAPH_ENGINE_VARIANT,
    arm: 'candidate', compiled: true, sourceAfterVerified: true, manifest: manifestRecord, buildCapture,
    files: mechanism.files, captureRebuiltCompiler: false, preBuildCompleteSourceInventoryClaimed: false,
    gameplayPassClaimed: false, performancePassClaimed: false,
  });
  const verified = await loadNativeGraphRuntimeInputs({ runtimeRoot, manifestSha256: manifestRecord.sha256,
    buildResultFile: resultRecord.file, buildResultSha256: resultRecord.sha256 });
  await verifyNativeGraphRuntimeInputsAfter(verified); await verifyNativeScalarRuntimeInputsAfter(scalarInputs);
  const verification = await save(path.join(outputRoot, 'verification.json'), { pass: true, finishedAt: stamp(),
    sourceFiles: verified.summary.sourceFilesVerified, rustFixtures: verified.summary.rustFixtures,
    manifest: manifestRecord, result: resultRecord, linkedRecords: verified.summary.linkedRecords.length,
    compilerReproducedByCapture: false, gameplayPassClaimed: false, performancePassClaimed: false });
  process.stdout.write(JSON.stringify({ pass: true, runtimeRoot, manifest: manifestRecord, result: resultRecord, verification }) + '\n');
}

main().catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
