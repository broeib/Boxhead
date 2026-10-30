import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export const RUNTIME_BUNDLE_SCHEMA = 'boxhead-ruffle-web-bundle-v1';
export const RUNTIME_SOURCE_COMMIT = 'cac5c99ce4a17e606f4ee3090389bb878f852055';
export const RUNTIME_FLAGS = ['baseline-runtime-root', 'baseline-runtime-manifest-sha',
  'candidate-runtime-root', 'candidate-runtime-manifest-sha'];
const SHA = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function runtimeSelection(options) {
  const present = RUNTIME_FLAGS.filter(name => options[name] !== undefined && options[name] !== '');
  if (present.length === 0) return null; // Exact legacy public/ruffle selection remains in the caller.
  assert.equal(present.length, RUNTIME_FLAGS.length, 'Both runtime roots and both manifest SHA256 values are required together');
  for (const name of RUNTIME_FLAGS) assert.equal(typeof options[name], 'string', 'Runtime option must be a string: ' + name);
  return ['baseline', 'candidate'].map(side => {
    const expectedSha256 = options[side + '-runtime-manifest-sha'];
    assert(SHA.test(expectedSha256), 'Runtime manifest SHA256 must be exact lowercase hex: ' + side);
    assert(options[side + '-runtime-root'].length > 0, 'Runtime root must not be empty');
    return { side, root: options[side + '-runtime-root'], expectedSha256 };
  });
}

export function validateRuntimeFile(file) {
  assert(typeof file === 'string' && file.length > 0 && file.length <= 1024,
    'Runtime file must be a bounded relative POSIX path');
  assert(!/[\\\u0000-\u0020\u007f?#%:]/.test(file) && !file.startsWith('/'), 'Unsafe runtime file path');
  assert(file.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Runtime path traversal or empty segment');
  assert.notEqual(file, 'manifest.json', 'The runtime manifest is an input binding, not an executable asset');
  return file;
}

export function validateRuntimeManifest(manifest) {
  assert(record(manifest) && manifest.schema === RUNTIME_BUNDLE_SCHEMA, 'Unexpected runtime manifest schema');
  assert.equal(manifest.sourceCommit, RUNTIME_SOURCE_COMMIT, 'Runtime source commit differs from the agreed pinned revision');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096,
    'Runtime manifest needs a bounded explicit file inventory');
  const files = new Map();
  for (const item of manifest.files) {
    assert(record(item) && Object.keys(item).sort().join(',') === 'bytes,file,sha256', 'Unexpected runtime file record shape');
    validateRuntimeFile(item.file);
    assert(!files.has(item.file), 'Duplicate runtime file');
    assert(Number.isSafeInteger(item.bytes) && item.bytes > 0, 'Invalid runtime file byte count');
    assert(typeof item.sha256 === 'string' && SHA.test(item.sha256), 'Invalid runtime file SHA256');
    files.set(item.file, Object.freeze({ ...item }));
  }
  assert(files.has('ruffle.js'), 'Runtime bundle must contain the actual ruffle.js loader');
  assert([...files.keys()].some(file => file.endsWith('.wasm')), 'Runtime bundle must contain WebAssembly');
  for (const file of files.keys()) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index++)
      assert(!files.has(parts.slice(0, index).join('/')), 'Runtime file/directory inventory collision');
  }
  return files;
}

function contained(root, file) {
  const local = relative(root, file);
  assert(local && local !== '..' && !local.startsWith('..' + sep) && !local.startsWith(sep),
    'Runtime asset escapes its immutable bundle root');
}

async function readContained(root, file) {
  const path = await realpath(resolve(root, file));
  contained(root, path);
  assert((await stat(path)).isFile(), 'Runtime asset is not a regular file');
  return { path, bytes: await readFile(path) };
}

export async function loadRuntimeBundle(selection) {
  const root = await realpath(resolve(selection.root));
  assert((await stat(root)).isDirectory(), 'Runtime root is not a directory');
  const raw = await readContained(root, 'manifest.json');
  assert.equal(digest(raw.bytes), selection.expectedSha256, 'Actual runtime manifest SHA256 differs');
  const manifest = JSON.parse(raw.bytes.toString('utf8'));
  const files = validateRuntimeManifest(manifest);
  const bundle = { root, side: selection.side, manifest, files, manifestBytes: raw.bytes,
    manifestRecord: { file: raw.path, bytes: raw.bytes.length, sha256: selection.expectedSha256 } };
  const initialFiles = [];
  for (const file of files.keys()) initialFiles.push((await readRuntimeAsset(bundle, file)).record);
  bundle.initialFiles = initialFiles;
  return bundle;
}

export async function readRuntimeAsset(bundle, file) {
  validateRuntimeFile(file);
  assert(bundle.files.has(file), 'Requested runtime asset is absent from its manifest: ' + file);
  const expected = bundle.files.get(file), actual = await readContained(bundle.root, file);
  assert.equal(actual.bytes.length, expected.bytes, 'Runtime asset byte count changed: ' + file);
  assert.equal(digest(actual.bytes), expected.sha256, 'Runtime asset SHA256 changed: ' + file);
  return { bytes: actual.bytes, record: { file, path: actual.path, bytes: actual.bytes.length, sha256: expected.sha256 } };
}

export async function verifyRuntimeBundleAfter(bundle) {
  assert.equal(await realpath(bundle.root), bundle.root, 'Runtime bundle root identity changed');
  const raw = await readContained(bundle.root, 'manifest.json');
  assert.equal(raw.path, bundle.manifestRecord.file, 'Runtime manifest resolved path changed');
  assert.equal(raw.bytes.length, bundle.manifestRecord.bytes, 'Runtime manifest byte count changed');
  assert.equal(digest(raw.bytes), bundle.manifestRecord.sha256, 'Runtime manifest changed after observation');
  const files = [];
  for (const file of bundle.files.keys()) {
    const actual = (await readRuntimeAsset(bundle, file)).record;
    assert.deepEqual(actual, bundle.initialFiles.find(initial => initial.file === file), 'Runtime asset path/bytes changed after observation');
    files.push(actual);
  }
  return { manifest: { ...bundle.manifestRecord }, files, verified: true };
}

export function runtimePublicPath(client) {
  assert(client === 0 || client === 1, 'Runtime client index must be zero or one');
  return '/__ruffle/' + client + '/';
}

export function runtimeAssetRequest(pathname, expectedClient) {
  assert(typeof pathname === 'string', 'Runtime request pathname must be a string');
  if (pathname === '/ruffle' || pathname.startsWith('/ruffle/'))
    throw new Error('Legacy runtime route is forbidden when explicit bundles are selected');
  if (!pathname.startsWith('/__ruffle')) return null;
  const matched = /^\/__ruffle\/([01])\/(.+)$/.exec(pathname);
  assert(matched, 'Malformed explicit runtime route');
  const client = Number(matched[1]);
  if (expectedClient !== undefined) assert.equal(client, expectedClient, 'A client requested the other runtime bundle');
  const file = decodeURIComponent(matched[2]);
  validateRuntimeFile(file);
  return { client, file, publicPath: runtimePublicPath(client) };
}

/** Closed saved request/response evidence only; this does not attest which
 * machine instructions the engine executed or claim native scalar coverage. */
export function validateRuntimeTransfers(observation) {
  assert(record(observation) && observation.schema === 'original-dual-runtime-observation-v1', 'Missing runtime observation');
  assert.deepEqual(observation.errors, [], 'Runtime request/response observation has failures');
  assert(Array.isArray(observation.bundles) && observation.bundles.length === 2, 'Missing both runtime bindings');
  assert(Array.isArray(observation.requests) && Array.isArray(observation.served), 'Missing runtime wire evidence');
  const served = new Map();
  for (const row of observation.served) {
    assert(Number.isSafeInteger(row.requestId) && row.requestId > 0 && !served.has(row.requestId), 'Duplicate or invalid runtime server request');
    served.set(row.requestId, row);
  }
  const seen = new Set(), byClient = [[], []];
  for (const request of observation.requests) {
    assert(Number.isSafeInteger(request.id) && request.id > 0 && !seen.has(request.id), 'Duplicate runtime browser request');
    seen.add(request.id);
    assert(request.client === 1 || request.client === 2, 'Invalid runtime browser owner');
    const index = request.client - 1, bundle = observation.bundles[index];
    assert.equal(bundle.client, request.client);
    const parsed = runtimeAssetRequest(new URL(request.url).pathname, index);
    assert(parsed && parsed.file === request.file, 'Runtime URL/file binding differs');
    const expected = bundle.files.find(file => file.file === request.file);
    assert(expected, 'Browser runtime file is absent from the declared bundle');
    const actual = served.get(request.id);
    assert(actual, 'Browser runtime request has no matching verified server transfer');
    assert.equal(actual.client, request.client); assert.equal(actual.file, request.file);
    assert.equal(actual.method, request.method); assert.equal(actual.bytes, expected.bytes);
    assert.equal(actual.sha256, expected.sha256); assert.equal(actual.manifestSha256, bundle.manifest.sha256);
    assert.equal(actual.status, 200); assert.equal(actual.finished, true, 'Runtime server response did not finish');
    assert(['GET', 'HEAD'].includes(request.method));
    assert.equal(actual.bodySent, request.method === 'GET');
    assert.equal(request.response?.url, request.url); assert.equal(request.response?.status, 200);
    assert.equal(request.response?.contentLength, String(expected.bytes));
    assert.equal(request.response?.assetSha256, expected.sha256);
    assert.equal(request.response?.manifestSha256, bundle.manifest.sha256);
    assert.equal(request.response?.fromServiceWorker, false);
    assert.equal(request.finished, true, 'Browser runtime response did not finish');
    assert(!own(request, 'failure'), 'Browser runtime request failed');
    byClient[index].push(request);
  }
  assert.equal(seen.size, served.size, 'Unmatched runtime server transfer');
  const clients = byClient.map((rows, index) => {
    const completedGets = rows.filter(row => row.method === 'GET');
    assert(completedGets.some(row => row.file === 'ruffle.js'), 'Actual loader GET was not observed for client ' + (index + 1));
    assert(completedGets.some(row => row.file.endsWith('.wasm')), 'Actual WASM GET was not observed for client ' + (index + 1));
    return { client: index + 1, completedRequests: rows.length,
      javascript: [...new Set(completedGets.filter(row => row.file.endsWith('.js')).map(row => row.file))],
      webassembly: [...new Set(completedGets.filter(row => row.file.endsWith('.wasm')).map(row => row.file))] };
  });
  return { complete: true, clients, observedRequests: seen.size,
    scope: 'Actual browser requests and completed responses paired to manifest-verified server bytes; not a scalar-accelerator coverage witness' };
}
