import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export const ACTION_PUSH_CALLBACK = 'bhActionPushCacheStats';
export const ACTION_PUSH_CONTRACT = 'action-push-cache-v1';
export const ACTION_PUSH_COUNTERS = Object.freeze(['hits', 'misses', 'insertions', 'uncacheable', 'budgetFallback', 'staleOwner']);
export const ACTION_PUSH_BUILD_PINS = Object.freeze({
  parentManifest: 'e5de16339c9f9f9ed3ab2cc6283fd6753b1aba790ca77cfe39c6f19e24630690',
  parentSwf: 'e437cb29823dd1b57df838715892bfb14f743126613ce9cf5ad6ae8304f871fc',
  parentBridge: 'b56a3d7fa86af4fe82311ef618031a2c0b6f39fbfba523fcd3e07e4757c265dd',
  callbackSource: '383f570bf5a56e1889b17280d4805c38b64a27af85ca5622eb9b00a8d3ba19da',
  buildHelper: 'ba31e6c55d8e24f5062c36622fe77e15794656aee58e198d23f63eba15154a0b',
  engineManifest: '091b029f2581418ae71e6997d3aa43029c360b81871f73448e32dc1a5ef23a4f',
});
const BASELINE_BUNDLES = new Set([
  '21c2359be30ae578d9525fad28eb50166b5ce065d728a1b4690ab98211f0b8a1', // Pinned upstream, same toolchain.
  'c3d398935a1fa237b93e9493e4815a5ad38f116440d031d21d1da0c515f6b2d7', // Scalar-only engine v2.
]);
const FIELDS = ['version', 'contract', ...ACTION_PUSH_COUNTERS, 'entries', 'descriptorBytes'].sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SHA = /^[a-f0-9]{64}$/;

export function actionPushSelection(options, selectedRuntimes) {
  const enabled = options['expect-action-push-cache'];
  assert(enabled === 0 || enabled === 1, 'Invalid --expect-action-push-cache');
  const path = options['action-push-cache-build'], expected = options['expect-action-push-cache-build'];
  if (!enabled) {
    assert(!path && !expected, 'ActionPush build bindings require explicit coverage mode');
    return null;
  }
  assert(selectedRuntimes?.length === 2, 'ActionPush coverage requires both explicit runtime bundles');
  assert(typeof path === 'string' && path.length > 0 && typeof expected === 'string' && SHA.test(expected),
    'ActionPush coverage requires an exact diagnostic build manifest path and SHA256');
  assert(options['candidate-swf'] && SHA.test(options['expect-swf']), 'ActionPush coverage requires the explicit diagnostic SWF and SHA256');
  return { path, expectedSha256: expected };
}

export function validateActionPushStats(value, previous) {
  assert(object(value), 'ActionPush stats must be an object');
  const keys = Reflect.ownKeys(value);
  assert(keys.every(key => typeof key === 'string'), 'ActionPush stats has a symbol field');
  assert.deepEqual(keys.sort(), FIELDS, 'ActionPush stats must have exactly ten own data fields');
  const result = {};
  for (const key of FIELDS) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    assert(property && Object.hasOwn(property, 'value') && property.enumerable === true,
      'ActionPush stats contains an accessor or hidden field: ' + key);
    result[key] = property.value;
  }
  assert.equal(result.version, 1); assert.equal(result.contract, ACTION_PUSH_CONTRACT);
  for (const key of [...ACTION_PUSH_COUNTERS, 'entries', 'descriptorBytes'])
    assert(Number.isSafeInteger(result[key]) && result[key] >= 0, 'Invalid ActionPush count: ' + key);
  assert(result.entries <= 65536 && result.descriptorBytes <= 4 * 1024 * 1024, 'ActionPush occupancy exceeds its native limits');
  assert(result.entries <= result.insertions, 'Retained entries exceed lifetime insertions');
  if (previous) for (const key of ACTION_PUSH_COUNTERS)
    assert(result[key] >= previous[key], 'ActionPush cumulative counter went backwards: ' + key);
  return result;
}

// Serialized by Playwright into the candidate page. This executes exactly one
// actual callback, with no Step/Info/State/receipt/prepare calls or world writes.
export function queryActionPushCacheInPage() {
  const at = performance.now();
  const raw = window.nativeChecks.call('bhActionPushCacheStats');
  const end = performance.now();
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { at, ms: end - at, rawEncoding: typeof raw === 'string' ? 'json-string' : 'object', value };
}

export function validateActionPushCoverage(observations, finalTick) {
  assert(Number.isSafeInteger(finalTick) && finalTick >= 50 && finalTick <= 11000);
  assert(Array.isArray(observations) && observations.length === 2, 'Exactly two ActionPush observations are required');
  let previous;
  for (const [index, row] of observations.entries()) {
    assert(object(row) && row.client === 2 && row.source === 'actual-bhActionPushCacheStats');
    assert.equal(row.phase, index === 0 ? 'before-first-step' : 'after-last-step');
    assert.equal(row.lastVerifiedTick, index === 0 ? 0 : finalTick);
    assert(Number.isFinite(row.at) && row.at >= 0 && Number.isFinite(row.ms) && row.ms >= 0);
    assert(['object', 'json-string'].includes(row.rawEncoding));
    previous = validateActionPushStats(row.value, previous);
  }
  const [before, after] = observations;
  assert(after.at >= before.at + before.ms, 'ActionPush observations overlap or go backwards');
  const delta = Object.fromEntries(ACTION_PUSH_COUNTERS.map(key => [key, after.value[key] - before.value[key]]));
  // A conservative coverage floor, not a measured query-only control or an
  // estimate of world commands. The fixed callback/guard have no loops; the
  // native dispatcher fixtures independently prove actual hit semantics.
  const minimumHits = Math.max(65536, finalTick * 64);
  assert(delta.hits >= minimumHits, 'ActionPush hit delta is too small to claim broad run coverage');
  return { observations: 2, commandedSteps: finalTick, minimumHits, delta,
    initialOccupancy: { entries: before.value.entries, descriptorBytes: before.value.descriptorBytes },
    finalOccupancy: { entries: after.value.entries, descriptorBytes: after.value.descriptorBytes },
    callbacksOutsideTimedSteps: true, measuredQueryOnlyControl: false,
    scope: 'Actual whole-VM cache activity between two diagnostic queries, including query/passive Flash bytecode. No per-command, per-site or fraction-of-world-operations attribution.' };
}

async function boundFile(record) {
  assert(object(record) && typeof (record.path ?? record.file) === 'string' && SHA.test(record.sha256)
    && Number.isSafeInteger(record.bytes) && record.bytes > 0, 'Missing exact file binding');
  const path = await realpath(resolve(record.path ?? record.file)), bytes = await readFile(path);
  assert.equal(bytes.length, record.bytes, 'Bound file size changed: ' + path);
  assert.equal(sha(bytes), record.sha256, 'Bound file SHA changed: ' + path);
  return { record: { path, bytes: bytes.length, sha256: record.sha256 }, bytes };
}

export function validateActionPushBuild(manifest, candidateSha256, candidateBytes) {
  assert(object(manifest) && manifest.schema === 'original-action-push-cache-stats-build-v1');
  assert.equal(manifest.pass, true); assert.equal(manifest.diagnostic, true);
  assert.equal(manifest.callback, ACTION_PUSH_CALLBACK);
  assert.equal(manifest.classification, 'DIAGNOSTIC_CMAIN_ONLY_ACTION_PUSH_CACHE_STATS');
  assert.equal(manifest.browserTested, false); assert.equal(manifest.gameplayPassClaimed, false);
  assert.equal(manifest.productionFilesWritten, false);
  assert.equal(manifest.nonCodeTagsPreserved, true); assert.equal(manifest.otherCodeTagsPreserved, true);
  assert.equal(manifest.codeIntegrity?.changedClasses?.length, 1);
  assert.equal(manifest.swfSha256, candidateSha256); assert.equal(manifest.swfBytes, candidateBytes);
  for (const name of ['parentManifest', 'parentSwf', 'parentBridge', 'callbackSource', 'buildHelper'])
    assert.equal(manifest.inputs?.[name]?.sha256, ACTION_PUSH_BUILD_PINS[name], 'Diagnostic parent/source pin differs: ' + name);
  assert.equal(manifest.compiler?.status, 0);
  assert.equal(manifest.querySource?.loops, false);
  assert.equal(manifest.querySource?.nativeCalls, 1);
  assert(Number.isInteger(manifest.querySource?.callbackTokens) && manifest.querySource.callbackTokens > 0
    && manifest.querySource.callbackTokens <= 512);
  return manifest;
}

export function validateActionPushRuntimePair(runtimeBundles, engine) {
  assert(Array.isArray(runtimeBundles) && runtimeBundles.length === 2);
  const [baseline, candidate] = runtimeBundles;
  assert(BASELINE_BUNDLES.has(baseline.manifestRecord.sha256), 'Baseline runtime is not one of the exact cache-absent engines');
  assert.equal(candidate.manifest.engineVariant, 'native-scalars-v2-plus-action-push-cache-v3');
  assert.equal(candidate.manifest.engineManifest?.sha256, ACTION_PUSH_BUILD_PINS.engineManifest);
  assert.equal(engine.schema, 'boxhead-ruffle-action-push-cache-engine-source-v3');
  assert.deepEqual(candidate.manifest.patchFiles, engine.files, 'Bundle engine overlay differs from the exact approved source');
  assert.equal(candidate.manifest.sourceAfterVerified, true);
  assert.match(candidate.manifest.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(candidate.manifest.imageId, baseline.manifest.imageId, 'Runtime image differs between arms');
  for (const key of ['toolchainMetadata', 'versionSeal']) {
    assert(SHA.test(candidate.manifest[key]?.sha256) && Number.isSafeInteger(candidate.manifest[key]?.bytes)
      && candidate.manifest[key].bytes > 0, 'Missing exact runtime provenance: ' + key);
    assert.equal(candidate.manifest[key].sha256, baseline.manifest[key]?.sha256, 'Runtime provenance differs: ' + key);
    assert.equal(candidate.manifest[key].bytes, baseline.manifest[key]?.bytes, 'Runtime provenance size differs: ' + key);
  }
}

export async function loadActionPushBindings(selection, candidatePath, candidateBytes, runtimeBundles) {
  const path = await realpath(resolve(selection.path)), raw = await readFile(path);
  assert.equal(sha(raw), selection.expectedSha256, 'Diagnostic build manifest SHA differs');
  const build = validateActionPushBuild(JSON.parse(raw), sha(candidateBytes), candidateBytes.length);
  assert.equal(await realpath(build.output), candidatePath, 'Diagnostic build output is not the actual candidate SWF');
  const bindings = [{ path, bytes: raw.length, sha256: sha(raw) },
    { path: candidatePath, bytes: candidateBytes.length, sha256: sha(candidateBytes) }];
  for (const input of [...Object.values(build.inputs), build.changedSource]) bindings.push((await boundFile(input)).record);
  const [baseline, candidate] = runtimeBundles;
  assert.equal(candidate.manifest.engineManifest?.sha256, ACTION_PUSH_BUILD_PINS.engineManifest);
  const engineRaw = await boundFile(candidate.manifest.engineManifest), engine = JSON.parse(engineRaw.bytes);
  bindings.push(engineRaw.record);
  validateActionPushRuntimePair(runtimeBundles, engine);
  for (const key of ['toolchainMetadata', 'versionSeal']) {
    for (const bundle of runtimeBundles) bindings.push((await boundFile(bundle.manifest[key])).record);
  }
  return { bindings, evidence: { buildManifest: bindings[0], candidateSwf: bindings[1],
    callbackSource: build.inputs.callbackSource, parentSwf: build.inputs.parentSwf,
    engineManifest: engineRaw.record, baselineRuntimeManifest: baseline.manifestRecord,
    candidateRuntimeManifest: candidate.manifestRecord,
    nativeDispatcherFixtures: 'Separate ROOT build gate; this harness does not reexecute the 14 inherited plus 20 ActionPush Rust fixtures.',
    buildScope: 'Exact supplied source/build/bundle bindings and CMain-only diagnostic fidelity; gameplay is checked independently by the unchanged native A/B gates.' } };
}

export async function verifyActionPushBindingsAfter(binding) {
  for (const record of binding.bindings) assert.deepEqual((await boundFile(record)).record, record);
  return { verified: true, files: binding.bindings.length };
}
