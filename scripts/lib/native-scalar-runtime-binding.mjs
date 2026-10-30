import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadRuntimeBundle, verifyRuntimeBundleAfter, validateRuntimeFile } from './native-runtime-bundle.mjs';

export const NATIVE_SCALAR_RUNTIME_SCHEMA = 'original-cold-native-scalar-runtime-v1';
const SHA = /^[a-f0-9]{64}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const commit = 'cac5c99ce4a17e606f4ee3090389bb878f852055';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => ({ bytes: value.bytes, sha256: value.sha256 });
const same = (one, two) => assert.deepEqual(identity(one), identity(two));
const shape = value => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'file', 'sha256']);
  assert(typeof value.file === 'string' && path.isAbsolute(value.file));
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0 && SHA.test(value.sha256));
  return value;
};
async function fileRecord(file) {
  const actual = await realpath(file), digest = createHash('sha256'); let bytes = 0;
  const before = await stat(actual);
  assert(before.isFile() && before.size > 0 && before.size <= 512 * 1024 * 1024, 'Runtime provenance needs a bounded regular file');
  for await (const chunk of createReadStream(actual)) { bytes += chunk.length; digest.update(chunk); }
  const after = await stat(actual);
  assert.equal(bytes, before.size);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'Runtime input changed during hashing');
  return { file: actual, bytes, sha256: digest.digest('hex') };
}
async function exactBundleInventory(bundle) {
  const actual = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + '/');
      else { assert(entry.isFile(), 'Runtime bundle contains a symlink or nonregular entry'); actual.push(name); }
    }
  }
  await visit(bundle.root, '');
  assert.deepEqual(actual.sort(), ['manifest.json', ...bundle.files.keys()].sort(), 'Runtime bundle has undeclared or missing files');
}

/** Binds actual immutable inputs; it does not reproduce the compiler or claim
 * that a saved build report alone establishes gameplay equivalence. */
export async function loadNativeScalarRuntimeInputs({ runtimeRoot, manifestSha256, buildResultFile, buildResultSha256 }) {
  assert(SHA.test(manifestSha256) && SHA.test(buildResultSha256), 'Explicit runtime/build SHA256 pins are required');
  const bundle = await loadRuntimeBundle({ side: 'candidate', root: runtimeRoot, expectedSha256: manifestSha256 });
  await exactBundleInventory(bundle);
  const records = new Map();
  async function bound(binding, json = true) {
    shape(binding);
    const actual = await fileRecord(binding.file); same(actual, binding);
    const prior = records.get(actual.file); if (prior) assert.deepEqual(actual, prior);
    records.set(actual.file, actual);
    if (!json) return actual;
    assert(actual.bytes <= 16 * 1024 * 1024, 'Runtime provenance JSON exceeds bounded metadata size');
    const bytes = await readFile(actual.file);
    assert.equal(bytes.length, actual.bytes); assert.equal(hash(bytes), actual.sha256);
    return JSON.parse(bytes.toString('utf8'));
  }
  const resultRecord = await fileRecord(buildResultFile);
  assert.equal(resultRecord.sha256, buildResultSha256);
  const result = await bound(resultRecord), manifest = bundle.manifest;
  assert.equal(result.schema, 'boxhead-pinned-ruffle-build-result-v1');
  assert.equal(result.arm, 'candidate'); assert.equal(result.compiled, true);
  assert.equal(result.sourceAfterVerified, true);
  assert.equal(result.gameplayPassClaimed, false); assert.equal(result.performancePassClaimed, false);
  same(result.manifest, bundle.manifestRecord);
  const buildManifest = await bound(result.manifest);
  assert.deepEqual(buildManifest, manifest); assert.deepEqual(result.files, manifest.files);
  assert.equal(manifest.arm, 'candidate'); assert.equal(manifest.sourceCommit, commit);
  assert(imagePattern.test(manifest.imageId)); assert.equal(manifest.sourceAfterVerified, true);
  assert.equal(manifest.gameplayPassClaimed, false); assert.equal(manifest.performancePassClaimed, false);
  assert.deepEqual(manifest.wasmVariants, ['extensions', 'mvp']);
  assert.equal(manifest.files.filter(row => row.file.endsWith('.wasm')).length, 2);
  assert(manifest.files.reduce((sum, row) => sum + row.bytes, 0) <= 1024 * 1024 * 1024, 'Runtime bundle exceeds bounded inventory size');
  same(result.plan, manifest.buildPlan);
  const plan = await bound(result.plan);
  assert.equal(plan.schema, 'boxhead-pinned-ruffle-build-plan-v1'); assert.equal(plan.arm, 'candidate');
  assert.equal(plan.sourceCommit, commit); assert.equal(plan.imageId, manifest.imageId);
  assert.deepEqual(plan.wasmVariants, manifest.wasmVariants);
  same(plan.engineManifest, manifest.engineManifest); same(plan.toolchainMetadata, manifest.toolchainMetadata);
  same(plan.versionSeal, manifest.versionSeal); same(plan.baselineManifest, manifest.baselineManifest);
  const engine = await bound(manifest.engineManifest);
  assert.equal(engine.upstream?.commit, commit); assert(Array.isArray(engine.files) && engine.files.length === 6);
  assert.deepEqual(engine.files.map(row => row.path).sort(), ['core/src/avm1/globals.rs', 'core/src/avm1/runtime.rs',
    'core/src/avm1/activation.rs', 'core/src/avm1/globals/boxhead_native_scalars.rs',
    'core/src/avm1/globals/boxhead_native_scalars/tests.rs', 'core/src/avm1/globals/boxhead_native_scalars/activation_tests.rs'].sort());
  assert.deepEqual(plan.patchFiles, engine.files); assert.deepEqual(manifest.patchFiles, engine.files);
  assert.equal(engine.abi?.global, 'boxheadNativeScalarsV1'); assert.equal(engine.abi?.version, 1);
  assert.equal(engine.abi?.contract, 'bh-scalars-thing-v1');
  const engineDirectory = path.dirname((await fileRecord(manifest.engineManifest.file)).file);
  for (const row of engine.files) {
    validateRuntimeFile(row.path);
    const file = await realpath(path.resolve(engineDirectory, row.path));
    assert(!path.relative(engineDirectory, file).startsWith('..') && path.relative(engineDirectory, file) !== '');
    await bound({ file, bytes: row.bytes, sha256: row.sha256 }, false);
  }
  const fixtures = await bound(manifest.rustFixtures); same(result.rustFixtures, manifest.rustFixtures);
  assert.equal(fixtures.schema, 'boxhead-native-scalar-rust-fixtures-v1'); assert.equal(fixtures.pass, true);
  assert.equal(fixtures.executed, 14); assert.equal(fixtures.passed, 14);
  assert.equal(fixtures.failed, 0); assert.equal(fixtures.ignored, 0); same(fixtures.engineManifest, manifest.engineManifest);
  const names = engine.unitGate?.exactNames;
  assert(Array.isArray(names) && names.length === 14 && new Set(names).size === 14);
  assert.deepEqual([...fixtures.names].sort(), [...names].sort());
  assert.deepEqual([...plan.rustUnitGate.expectedNames].sort(), [...names].sort());
  for (const binding of [fixtures.listLog, fixtures.runLog]) await bound(binding, false);
  const listed = [...(await readFile(fixtures.listLog.file, 'utf8')).matchAll(/^(.+): test$/gm)].map(row => row[1]);
  const run = await readFile(fixtures.runLog.file, 'utf8');
  const passed = [...run.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(row => row[1]);
  assert.deepEqual(listed.sort(), [...names].sort()); assert.deepEqual(passed.sort(), [...names].sort());
  assert.equal([...run.matchAll(/^test result: ok\. 14 passed; 0 failed; 0 ignored; 0 measured;/gm)].length, 1);
  const toolchain = await bound(plan.toolchain); const metadata = await bound(plan.toolchainMetadata);
  assert.equal(toolchain.toolchainReady, true); assert.equal(toolchain.imageId, manifest.imageId);
  same(toolchain.metadata, plan.toolchainMetadata);
  assert(metadata && typeof metadata === 'object');
  const seal = await bound(plan.versionSeal); assert.equal(seal.commitHash, commit);
  const baselineResult = await bound(plan.baselineResult), baselineStatus = await bound(plan.baselineStatus);
  assert.equal(baselineStatus.state, 'complete'); assert.equal(baselineStatus.returncode, 0);
  assert.equal(baselineResult.schema, 'boxhead-pinned-ruffle-build-result-v1');
  assert.equal(baselineResult.arm, 'baseline'); assert.equal(baselineResult.compiled, true);
  assert.equal(baselineResult.sourceAfterVerified, true); same(baselineResult.manifest, manifest.baselineManifest);
  const baselineManifest = await bound(manifest.baselineManifest), baselinePlan = await bound(baselineResult.plan);
  assert.equal(baselineManifest.schema, 'boxhead-ruffle-web-bundle-v1'); assert.equal(baselineManifest.arm, 'baseline');
  assert.equal(baselineManifest.sourceCommit, commit); assert.equal(baselineManifest.imageId, manifest.imageId);
  assert.equal(baselineManifest.sourceAfterVerified, true); assert.deepEqual(baselineManifest.patchFiles, []);
  assert.deepEqual(baselineResult.files, baselineManifest.files); assert.deepEqual(baselineManifest.wasmVariants, manifest.wasmVariants);
  same(baselineManifest.buildPlan, baselineResult.plan); same(baselineManifest.toolchainMetadata, manifest.toolchainMetadata);
  same(baselineManifest.versionSeal, manifest.versionSeal); same(baselinePlan.versionSeal, plan.versionSeal);
  await bound(baselineManifest.versionSeal);
  assert.equal(baselinePlan.imageId, plan.imageId); assert.equal(baselinePlan.sourceCommit, commit);
  assert.deepEqual(baselinePlan.environment, plan.environment); assert.deepEqual(baselinePlan.wasmVariants, plan.wasmVariants);
  same(baselinePlan.toolchain, plan.toolchain); same(baselinePlan.toolchainMetadata, plan.toolchainMetadata);
  assert.deepEqual(baselinePlan.patchFiles, []);
  const stages = [['npm', 'ci', '--include=dev', '--no-audit', '--no-fund'],
    ['npm', 'run', 'build', '--workspace=ruffle-core'], ['npm', 'run', 'build', '--workspace=ruffle-selfhosted']];
  assert.equal(plan.commands.length, stages.length); assert.equal(baselinePlan.commands.length, stages.length);
  for (const [index, stage] of stages.entries()) for (const command of [plan.commands[index], baselinePlan.commands[index]])
    assert.deepEqual(command.slice(-stage.length - 1), [manifest.imageId, ...stage]);
  for (const binding of [plan.sourceBefore, plan.sourcePatched, manifest.sourceAfter]) await bound(binding, false);
  const summary = { schema: NATIVE_SCALAR_RUNTIME_SCHEMA, sourceCommit: commit, imageId: manifest.imageId,
    manifest: { ...bundle.manifestRecord }, buildResult: resultRecord, engineManifest: manifest.engineManifest,
    buildPlan: manifest.buildPlan, toolchain: plan.toolchain, toolchainMetadata: manifest.toolchainMetadata,
    baselineManifest: manifest.baselineManifest, baselineResult: plan.baselineResult, versionSeal: manifest.versionSeal,
    rustFixtures: { record: manifest.rustFixtures, executed: 14, passed: 14, failed: 0, ignored: 0, names: [...names] },
    wasmVariants: manifest.wasmVariants, files: bundle.initialFiles.map(row => ({ file: row.file, bytes: row.bytes, sha256: row.sha256 })),
    linkedRecords: [...records.values()].sort((a, b) => a.file.localeCompare(b.file)),
    sourceAfterVerifiedByBuild: true, compilerReproducedByObserver: false, gameplayClaimInheritedFromBuild: false };
  return { bundle, summary, records: [...records.values()] };
}

export async function verifyNativeScalarRuntimeInputsAfter(inputs) {
  const bundle = await verifyRuntimeBundleAfter(inputs.bundle);
  await exactBundleInventory(inputs.bundle);
  for (const record of inputs.records) assert.deepEqual(await fileRecord(record.file), record, 'Linked runtime build provenance changed');
  return { verified: true, manifest: bundle.manifest, linkedRecords: inputs.records.length, files: bundle.files.length };
}

/** Extra HTTP reads occur only before browser creation and after browser
 * cleanup. Actual in-match responses are observed passively, not re-fetched. */
export async function verifyNativeScalarRuntimeHTTP(inputs, origin) {
  const start = Date.now(), rows = [];
  for (const expected of inputs.summary.files) {
    assert(Date.now() - start < 120000, 'Runtime HTTP binding exceeded its separate bounded setup/closure budget');
    const url = new URL('/ruffle/' + expected.file, origin);
    const response = await fetch(url, { cache: 'no-store', redirect: 'error',
      headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); assert.equal(response.url, url.href);
    assert([null, '', 'identity'].includes(response.headers.get('content-encoding')));
    assert.equal(response.headers.get('content-length'), String(expected.bytes));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256);
    rows.push({ file: expected.file, url: url.href, status: 200, bytes: bytes.length, sha256: expected.sha256 });
  }
  return rows;
}

export function createNativeScalarRuntimeObservation(inputs, origin, now, onFailure) {
  const rows = [], errors = [], pending = new Set(), byRequest = new WeakMap();
  let nextId = 0;
  const fail = error => { errors.push(String(error)); onFailure(error); };
  function observe(context, client) {
    context.on('request', request => {
      try {
        const url = new URL(request.url());
        if (!['http:', 'https:'].includes(url.protocol)) return;
        assert.equal(url.origin, origin, 'External request in explicit runtime experiment');
        if (!url.pathname.startsWith('/ruffle/')) return;
        assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.equal(request.redirectedFrom(), null);
        const file = decodeURIComponent(url.pathname.slice('/ruffle/'.length)); validateRuntimeFile(file);
        assert(inputs.bundle.files.has(file)); assert(['GET', 'HEAD'].includes(request.method()));
        assert(nextId < 4096, 'Runtime request observation capacity exceeded');
        const row = { id: ++nextId, client, file, url: url.href, method: request.method(), at: now(), finished: false };
        rows.push(row); byRequest.set(request, row);
      } catch (error) { fail(error); }
    });
    context.on('requestfailed', request => {
      const row = byRequest.get(request); if (!row) return;
      row.failure = request.failure()?.errorText ?? 'Runtime request failed'; fail(new Error(row.failure));
    });
    context.on('response', response => {
      const row = byRequest.get(response.request()); if (!row) return;
      const work = (async () => {
        try {
          const headers = response.headers(), expected = inputs.bundle.files.get(row.file);
          assert.equal(response.url(), row.url); assert.equal(response.status(), 200);
          assert.equal(response.fromServiceWorker(), false); assert.equal(headers['content-length'], String(expected.bytes));
          assert([undefined, '', 'identity'].includes(headers['content-encoding']));
          row.response = { status: 200, fromServiceWorker: false, contentLength: headers['content-length'], at: now() };
          assert.equal(await response.finished(), null); row.finished = true; row.finishedAt = now();
        } catch (error) { row.failure = String(error); fail(error); }
      })();
      pending.add(work); void work.finally(() => pending.delete(work));
    });
  }
  async function finish() {
    await Promise.all([...pending]);
    assert.deepEqual(errors, []);
    assert(rows.every(row => row.finished && !row.failure));
    for (const client of [1, 2]) {
      assert(rows.some(row => row.client === client && row.file === 'ruffle.js' && row.method === 'GET'));
      assert(rows.some(row => row.client === client && row.file.endsWith('.wasm') && row.method === 'GET'));
    }
    return { schema: 'original-cold-runtime-passive-loads-v1', requests: rows, errors,
      allCompleted: true, perResponseBodyHashClaimed: false,
      scope: 'Actual existing browser request/response completion plus separately verified same-origin frozen files/HTTP bytes; no per-browser-response body hash' };
  }
  return { observe, finish };
}
