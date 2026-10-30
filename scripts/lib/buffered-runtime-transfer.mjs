import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identityEncoding = value => value === undefined || value === '' || value.toLowerCase() === 'identity';

// Only the native gate uses this explicit mediation. One actual browser WASM
// request causes one upstream HTTP GET. The manifest-verified body is handed
// unchanged to that intercepted request; the ordinary browser completion and
// server-transfer validators still decide whether the transfer completed.
export async function fulfillPinnedRuntimeWasm(route, request, bundle, observation, timeout) {
  assert.equal(request.method, 'GET', 'Buffered WASM requires an actual browser GET');
  assert(request.file.endsWith('.wasm'), 'Only WASM may use buffered runtime transport');
  assert.equal(route.request().method(), request.method);
  assert.equal(route.request().url(), request.url);
  assert.equal(route.request().postData(), null, 'WASM GET must not have a body');
  assert.equal(route.request().redirectedFrom(), null, 'WASM browser request must not be redirected');
  assert(!observation.transfers.some(row => row.requestId === request.id || row.client === request.client),
    'Each native arm must make exactly one buffered WASM request');
  const expected = bundle.files.get(request.file);
  assert(expected, 'WASM is absent from the selected immutable manifest');
  const row = { requestId: request.id, client: request.client, file: request.file,
    browser: { url: request.url, method: request.method, resourceType: request.resourceType, redirectedFrom: null },
    upstreamRequest: { url: request.url, method: 'GET', requestIdHeader: String(request.id),
      acceptEncoding: 'identity', maxRedirects: 0, maxRetries: 0, timeout },
    expected: { bytes: expected.bytes, sha256: expected.sha256, manifestSha256: bundle.manifestRecord.sha256 },
    fetchCalls: 0, bodyReads: 0, fulfillCalls: 0, completed: false, startedAt: performance.now() };
  observation.transfers.push(row);
  let upstream;
  try {
    row.fetchCalls++;
    upstream = await route.fetch({ url: request.url, method: 'GET', timeout, maxRedirects: 0, maxRetries: 0,
      headers: { ...route.request().headers(), 'x-boxhead-runtime-request': String(request.id), 'accept-encoding': 'identity' } });
    const headers = upstream.headers();
    row.upstreamResponse = { url: upstream.url(), status: upstream.status(), receivedAt: performance.now(),
      contentType: headers['content-type'], contentLength: headers['content-length'],
      contentEncoding: headers['content-encoding'] ?? null, location: headers.location ?? null,
      assetSha256: headers['x-boxhead-runtime-sha256'], manifestSha256: headers['x-boxhead-runtime-manifest'] };
    assert.equal(upstream.url(), request.url, 'Upstream WASM URL changed');
    assert.equal(upstream.status(), 200, 'Upstream WASM response was not successful');
    assert.equal(headers['content-type'], 'application/wasm', 'Unexpected upstream WASM MIME type');
    assert(identityEncoding(headers['content-encoding']), 'Encoded upstream WASM is forbidden');
    assert.equal(headers.location, undefined, 'Upstream WASM response advertises a redirect');
    assert.equal(headers['content-length'], String(expected.bytes), 'Upstream WASM Content-Length differs');
    assert.equal(headers['x-boxhead-runtime-sha256'], expected.sha256, 'Upstream WASM hash header differs');
    assert.equal(headers['x-boxhead-runtime-manifest'], bundle.manifestRecord.sha256, 'Upstream WASM manifest header differs');
    row.bodyReads++;
    const bytes = await upstream.body();
    row.body = { bytes: bytes.length, sha256: sha(bytes), receivedAt: performance.now() };
    assert.equal(row.body.bytes, expected.bytes, 'Actual upstream WASM byte count differs');
    assert.equal(row.body.sha256, expected.sha256, 'Actual upstream WASM SHA256 differs');
    row.fulfill = { status: upstream.status(), contentType: headers['content-type'],
      contentLength: headers['content-length'], contentEncoding: headers['content-encoding'] ?? null,
      assetSha256: headers['x-boxhead-runtime-sha256'], manifestSha256: headers['x-boxhead-runtime-manifest'],
      bodyBytes: bytes.length, bodySha256: row.body.sha256, exactReadBufferPassed: true };
    row.fulfillCalls++;
    await route.fulfill({ response: upstream, body: bytes });
    row.fulfill.completedAt = performance.now(); row.completed = true;
  } catch (error) { row.error = String(error?.stack ?? error); throw error; }
  finally {
    if (upstream) {
      try { await upstream.dispose(); row.upstreamDisposed = true; }
      catch (error) { row.error ??= String(error?.stack ?? error); throw error; }
    }
  }
}

// Call only after the unchanged validateRuntimeTransfers has accepted the
// ordinary browser/server evidence. This adds the exact buffered-body link;
// it cannot turn a failed or unfinished browser request into a completed one.
export function validateBufferedRuntimeTransfers(runtime, observation) {
  assert.equal(runtime.transferProof?.complete, true, 'Ordinary runtime completion proof is required');
  assert.deepEqual(runtime.errors, []);
  assert.equal(observation.schema, 'original-native-buffered-wasm-runtime-v1');
  assert.equal(observation.transfers.length, 2, 'Both native arms need exactly one mediated WASM transfer');
  const seen = new Set();
  for (const row of observation.transfers) {
    assert(row.client === 1 || row.client === 2); assert(!seen.has(row.client)); seen.add(row.client);
    const request = runtime.requests.find(value => value.id === row.requestId);
    const actual = runtime.served.find(value => value.requestId === row.requestId);
    const bundle = runtime.bundles[row.client - 1], expected = bundle.files.find(value => value.file === row.file);
    assert(request && actual && expected, 'Mediated WASM has no ordinary request/server/manifest evidence');
    assert.equal(request.client, row.client); assert.equal(request.file, row.file);
    assert(row.file.endsWith('.wasm')); assert.equal(request.method, 'GET');
    assert.equal(request.finished, true); assert.equal(Object.hasOwn(request, 'failure'), false);
    assert.equal(request.response?.fromServiceWorker, false);
    assert.equal(row.browser.url, request.url); assert.equal(row.browser.method, 'GET');
    assert.equal(row.browser.resourceType, request.resourceType);
    assert.equal(row.browser.redirectedFrom, null);
    assert.equal(row.upstreamRequest.url, request.url); assert.equal(row.upstreamRequest.method, 'GET');
    assert.equal(row.upstreamRequest.requestIdHeader, String(row.requestId));
    assert.equal(row.upstreamRequest.maxRedirects, 0); assert.equal(row.upstreamRequest.maxRetries, 0);
    assert.equal(row.upstreamRequest.acceptEncoding, 'identity');
    assert.equal(row.fetchCalls, 1); assert.equal(row.bodyReads, 1); assert.equal(row.fulfillCalls, 1);
    assert.equal(row.completed, true); assert.equal(row.upstreamDisposed, true); assert.equal(Object.hasOwn(row, 'error'), false);
    assert.equal(row.expected.bytes, expected.bytes); assert.equal(row.expected.sha256, expected.sha256);
    assert.equal(row.expected.manifestSha256, bundle.manifest.sha256);
    assert.equal(row.upstreamResponse.url, request.url); assert.equal(row.upstreamResponse.status, 200);
    assert.equal(row.upstreamResponse.location, null);
    for (const value of [row.upstreamResponse, row.fulfill]) {
      assert.equal(value.contentType, 'application/wasm');
      assert.equal(value.contentLength, String(expected.bytes));
      assert(value.contentEncoding === null || identityEncoding(value.contentEncoding));
      assert.equal(value.assetSha256, expected.sha256); assert.equal(value.manifestSha256, bundle.manifest.sha256);
    }
    assert.equal(row.body.bytes, expected.bytes); assert.equal(row.body.sha256, expected.sha256);
    assert.equal(row.fulfill.status, 200); assert.equal(row.fulfill.bodyBytes, expected.bytes);
    assert.equal(row.fulfill.bodySha256, expected.sha256); assert.equal(row.fulfill.exactReadBufferPassed, true);
    assert.equal(actual.finished, true); assert.equal(actual.bodySent, true);
    assert.equal(actual.bytes, row.body.bytes); assert.equal(actual.sha256, row.body.sha256);
    const wasmGets = runtime.requests.filter(value => value.client === row.client && value.method === 'GET' && value.file.endsWith('.wasm'));
    assert.equal(wasmGets.length, 1); assert.equal(wasmGets[0].id, row.requestId);
  }
  return { complete: true, clients: [...seen].sort(), mediatedWasmGets: 2,
    scope: 'Two actual browser requests fulfilled from one manifest-verified upstream GET each; ordinary server and browser completion guards also passed. Native equivalence only, without natural-startup or timing claims.' };
}
