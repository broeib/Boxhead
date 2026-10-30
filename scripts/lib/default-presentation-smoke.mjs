import assert from 'node:assert/strict';
import { readBoundInput, inventoryTree, captureQualifiedSources, requireExactInventory, hashBytes,
  QUALIFIED_WEB_SCHEMA } from './qualified-web-bundle.mjs';
import { validateRuntimeFile } from './native-runtime-bundle.mjs';
import { validatePerformancePhasedNativeWindow } from './network-performance-phased-native-observer.mjs';
import { summarizeBufferedNativePresentationCalls } from './native-buffered-presentation-observer.mjs';

export const DEFAULT_SMOKE_LIMITS = Object.freeze({ ticks: 50, observedTicks: 2048, callbacks: 16384,
  requests: 256, rawBytes: 16 * 1024 * 1024, totalRawBytes: 32 * 1024 * 1024, reportBytes: 2 * 1024 * 1024 });
export const DEFAULT_SMOKE_BASELINES = Object.freeze({
  'scripts/run-original-ci-gpu-phased.py': '65248812f0d3e5a5d4f924dd33b22fc6305e1d3235bcdb7bdd49d4acf188b99b',
  'scripts/original-network-performance-phased.mjs': 'ccc530064eb1bea48b034b2ed6c28da2d13bb29a3bdb0c80e028be1d10add790',
  'scripts/original-coop-campaign-phased.mjs': '148d6aa3bc80e8daf731888f6996427c1c8ed535beca7a48fe2be30afc69c1a2',
});
export const DEFAULT_SMOKE_SOURCES = Object.freeze([
  'scripts/original-default-presentation-smoke.mjs', 'scripts/lib/default-presentation-smoke.mjs',
  'scripts/run-original-ci-gpu-default-smoke.py', 'tests/scripts/original-default-presentation-smoke.test.mjs',
  'tools/default-presentation-smoke-v2/source-delta.json', 'tools/default-presentation-smoke-v2/source-normalization.mjs',
  'tools/default-presentation-smoke-v2/source-inventory.json',
  'scripts/lib/default-smoke-shutdown-receipt-adapter.mjs',
  'tests/scripts/default-presentation-smoke-v3.test.mjs',
  'tests/scripts/default-smoke-current-source.test.mjs', 'tests/scripts/fixtures/default-smoke-current-source.mjs',
  'tools/default-presentation-smoke-v3/source-delta.json', 'tools/default-presentation-smoke-v3/source-normalization.mjs',
  'tools/default-presentation-smoke-v3/source-inventory.json', 'tools/default-presentation-smoke-v3/SMOKE_V3.md',
  'tools/default-presentation-smoke-v4/source-delta.json', 'tools/default-presentation-smoke-v4/source-normalization.mjs',
  'tools/default-presentation-smoke-v4/source-inventory.json', 'tools/default-presentation-smoke-v4/SMOKE_V4.md',
  ...Object.keys(DEFAULT_SMOKE_BASELINES), 'package.json', 'package-lock.json',
  ...['phased-native-snapshot-receipt-observer', 'phased-native-receipt-adapter',
    'network-performance-phased-native-observer', 'network-performance-paint-observer-v2',
    'native-buffered-presentation-observer', 'network-performance-gpu', 'native-project-evidence', 'native-projection-scan-evidence',
    'native-smooth-runtime-binding', 'native-scalar-runtime-binding', 'native-projection-runtime-binding',
    'native-graph-runtime-binding', 'native-runtime-bundle', 'qualified-web-bundle'].map(name => 'scripts/lib/' + name + '.mjs'),
]);

export function bareDefaultSmokeURL(value) {
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.equal(value, url.origin + '/', 'Use the exact bare origin ending in /');
  return url.href;
}

export function parseDefaultSmokeArguments(args) {
  const names = ['url', 'out', 'gpu', 'expect-swf', 'native-runtime-root', 'expect-native-runtime-manifest',
    'native-engine-build-result', 'expect-native-engine-build-result', 'qualified-web-build-result', 'expect-qualified-web-build-result'];
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.slice(2), value = args[i + 1];
    assert(args[i]?.startsWith('--') && names.includes(name) && !Object.hasOwn(result, name), 'Unknown or duplicate smoke option');
    assert(typeof value === 'string' && value && !value.startsWith('--') && !value.includes('\0'), 'Missing smoke value');
    result[name] = value;
  }
  for (const name of names) assert(Object.hasOwn(result, name), 'Missing --' + name);
  for (const name of names.filter(name => name.startsWith('expect-'))) assert(/^[a-f0-9]{64}$/.test(result[name]));
  bareDefaultSmokeURL(result.url); assert.equal(result.gpu, 'hardware');
  return result;
}

export async function captureDefaultSmokeSources(root) {
  const result = await inventoryTree(root, { directories: [], files: DEFAULT_SMOKE_SOURCES, maxFiles: 128,
    maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 });
  for (const [file, expected] of Object.entries(DEFAULT_SMOKE_BASELINES))
    assert.equal(result.files.find(row => row.path === file)?.sha256, expected, 'Frozen QA source changed: ' + file);
  return result;
}

export function validateDefaultSmokeBuild(report, runtime, swf) {
  assert.equal(report.schema, QUALIFIED_WEB_SCHEMA);
  assert.equal(report.status, 'BUILT_AND_BOUND;_BROWSER_GAMEPLAY_FPS_UNTESTED');
  assert.equal(report.engineVariant, 'native-smooth-v2'); assert.equal(report.deploymentPerformed, false);
  assert.equal(report.typecheck.code, 0); assert.equal(report.typecheck.signal, null);
  assert.equal(report.vite.configuration.publicDir, false); assert.equal(report.vite.configuration.copyPublicDir, false);
  assert.equal(report.source.unchanged, true); assert.equal(report.selectedSwfs.online.sha256, swf);
  for (const key of ['manifest', 'buildResult', 'engineManifest']) assert.deepEqual(report.nativeRuntime[key], runtime[key]);
  assert.equal(report.nativeRuntime.after.verified, true);
  assert(Array.isArray(report.served.files) && report.served.files.length <= 256);
  for (const row of report.served.files) {
    validateRuntimeFile(row.path); assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 128 * 1024 * 1024);
    assert(/^[a-f0-9]{64}$/.test(row.sha256));
  }
  assert.equal(new Set(report.served.files.map(row => row.path)).size, report.served.files.length);
  assert.equal(report.served.files.find(row => row.path === 'Boxhead_2Play.online.swf')?.sha256, swf);
  for (const row of runtime.files) assert.deepEqual(report.served.files.find(file => file.path === 'ruffle/' + row.file),
    { path: 'ruffle/' + row.file, bytes: row.bytes, sha256: row.sha256 });
  assert.equal(report.served.files.filter(row => row.path.startsWith('ruffle/')).length, runtime.files.length);
  return report;
}

export async function bindDefaultSmokeWeb(file, sha256, runtime, swf) {
  const input = await readBoundInput(file, sha256, DEFAULT_SMOKE_LIMITS.reportBytes);
  const report = validateDefaultSmokeBuild(JSON.parse(input.bytes), runtime, swf), records = [input.record];
  const sources = [];
  for (const record of [report.source.before, report.source.after, report.typecheck.log, report.vite.log,
    report.selectedSwfs.original, report.selectedSwfs.online]) {
    const bound = await readBoundInput(record.file, record.sha256); assert.deepEqual(bound.record, record); records.push(record);
    if (record === report.source.before || record === report.source.after) sources.push(JSON.parse(bound.bytes));
  }
  assert.deepEqual(sources[0], sources[1], 'Qualified source-before/after differ');
  assert.equal(sources[0].schema, 'boxhead-original-web-source-v1');
  assert.equal(sources[0].sha256, report.source.sha256); assert.equal(sources[0].files.length, report.source.files);
  const binding = { report, records, sources: sources[0] };
  await verifyDefaultSmokeWeb(binding);
  return binding;
}

export async function verifyDefaultSmokeWeb(binding) {
  for (const record of binding.records) assert.deepEqual((await readBoundInput(record.file, record.sha256)).record, record);
  const current = await captureQualifiedSources(binding.sources.root);
  assert.deepEqual(current.files, binding.sources.files); assert.equal(current.sha256, binding.sources.sha256);
  const served = await inventoryTree(binding.report.webRoot, { maxFiles: 256 });
  requireExactInventory(served, binding.report.served.files); assert.deepEqual(served, binding.report.served);
  return { verified: true, sourceFiles: current.files.length, servedFiles: served.files.length, servedSha256: served.sha256 };
}

export async function verifyDefaultSmokeHTTP(binding, origin) {
  const rows = [], start = Date.now();
  for (const row of binding.report.served.files) {
    assert(Date.now() - start < 120000, 'HTTP closure time bound');
    const url = new URL(row.path === 'index.html' ? '/' : '/' + row.path, origin);
    const response = await fetch(url, { cache: 'no-store', redirect: 'error', headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); assert.equal(response.url, url.href);
    assert([null, '', 'identity'].includes(response.headers.get('content-encoding')));
    assert.equal(response.headers.get('content-length'), String(row.bytes));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, row.bytes); assert.equal(hashBytes(bytes), row.sha256);
    rows.push({ ...row, url: url.href, status: 200 });
  }
  return rows;
}

// Existing browser responses only. Hash the actual HTML/application/SWF bodies;
// runtime requests keep the existing separately bound runtime observer contract.
export function observeDefaultSmokeWeb(context, client, binding, origin, failure) {
  const rows = [], pending = new Set(), requests = new Map(), expected = new Map(binding.report.served.files.map(row => [row.path, row]));
  let failures = 0;
  const fail = error => { failures++; failure(error); };
  function fileFor(request) {
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'External browser request');
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (file.startsWith('ruffle/')) return null;
    if (!expected.has(file)) {
      assert(!['document', 'script', 'stylesheet', 'font'].includes(request.resourceType()), 'Unbound application request');
      return null;
    }
    assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.equal(request.redirectedFrom(), null);
    return file;
  }
  context.on('request', request => {
    try {
      const file = fileFor(request); if (file === null) return;
      assert(rows.length < DEFAULT_SMOKE_LIMITS.requests, 'Browser request bound');
      assert(!requests.has(request), 'Repeated request identity');
      const row = { client, file, finished: false, requestFinished: false, failed: false };
      requests.set(request, row); rows.push(row);
    } catch (error) { fail(error); }
  });
  context.on('requestfinished', request => { const row = requests.get(request); if (row) row.requestFinished = true; });
  context.on('requestfailed', request => {
    const row = requests.get(request);
    if (row) { row.failed = true; fail(new Error('Application request failed: ' + row.file)); }
  });
  context.on('response', response => {
    const work = (async () => {
      const request = response.request(), file = fileFor(request); if (file === null) return;
      assert.equal(response.url(), request.url(), 'Response/request URL mismatch');
      const row = requests.get(request); assert(row && !row.responseSeen, 'Response without unique original request');
      row.responseSeen = true;
      assert.equal(response.status(), 200); assert.equal(response.fromServiceWorker(), false);
      const wanted = expected.get(file), headers = response.headers();
      assert.equal(headers['content-length'], String(wanted.bytes));
      assert([undefined, '', 'identity'].includes(headers['content-encoding']));
      assert.equal(await response.finished(), null);
      const bytes = await response.body();
      assert.equal(bytes.length, wanted.bytes); assert.equal(hashBytes(bytes), wanted.sha256);
      Object.assign(row, { finished: true, bytes: bytes.length, sha256: wanted.sha256 });
    })().catch(fail);
    pending.add(work); void work.finally(() => pending.delete(work));
  });
  return async () => {
    await Promise.all([...pending]); assert.equal(failures, 0);
    assert(rows.every(row => row.finished && row.requestFinished && !row.failed), 'Unfinished application request');
    for (const file of ['index.html', 'Boxhead_2Play.online.swf']) assert(rows.some(row => row.file === file));
    for (const extension of ['.js', '.css']) assert(rows.some(row => row.file.startsWith('assets/') && row.file.endsWith(extension)));
    return rows;
  };
}

// Self-contained init script: observe only incoming commands and successful
// original sends. Room invitation credentials and complete prepare packets are
// never retained. Observation failure never manufactures an ACK or native call.
export function installDefaultSmokeWire(globalObject, maximum = 2048) {
  const o = globalObject.__defaultSmoke = { initialURL: globalObject.location.href, tick: 0, slot: null,
    errors: [], frames: [], acks: [], callbacks: [], digestCalls: [], configs: [], rooms: [], caughtUps: [], inputs: [], keys: [],
    sockets: [], mouse: [], menuClosed: false };
  const fail = error => { if (o.errors.length < 16) o.errors.push({ type: 'default-smoke-wire', error: String(error).slice(0, 512) }); };
  const put = (list, value, bound = maximum) => { if (list.length >= bound) fail('Observation capacity exceeded'); else list.push(value); };
  for (const type of ['keydown', 'keyup']) globalObject.addEventListener(type, event => {
    put(o.keys, { at: globalObject.performance.now(), type, code: event.code, trusted: event.isTrusted }, 128);
  }, { capture: true, passive: true });
  // Ruffle consumes pointerdown and prevents its compatibility mousedown. Observe
  // the original trusted event in capture; do not cancel or dispatch any input.
  globalObject.addEventListener('pointerdown', event => {
    put(o.mouse, { sequence: o.mouse.length + 1, at: globalObject.performance.now(), type: 'pointerdown',
      pointerType: event.pointerType, pointerId: event.pointerId, primary: event.isPrimary,
      button: event.button, buttons: event.buttons, x: event.clientX, y: event.clientY, trusted: event.isTrusted }, 128);
  }, { capture: true, passive: true });
  const Original = globalObject.WebSocket, nativeClose = Original.prototype.close, owned = [];
  const socketURL = globalObject.location.origin.replace(/^http/, 'ws') + '/original-ws';
  let cleanup, capturedGameplay;
  const cleanupState = () => ({ version: 1, phase: cleanup?.phase ?? 'gameplay', armedAt: cleanup?.armedAt,
    closeRequestedAt: cleanup?.closeRequestedAt, completedAt: cleanup?.completedAt,
    observedAt: globalObject.performance.now(), gameplayWindow: capturedGameplay ? { ...capturedGameplay } : null,
    ackCount: o.acks.length, lastAck: o.acks.length ? { ...o.acks[o.acks.length - 1] } : null,
    sockets: o.sockets.map(row => ({ ...row })), terminalMessages: cleanup?.terminalMessages.map(row => ({ ...row })) ?? [],
    observerErrors: o.errors.map(row => ({ ...row })) });
  Object.defineProperties(o, {
    sealGameplayWindow: { value: value => {
      if (cleanup || capturedGameplay || !value || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== 'capturedSha256,capturedThroughTick,firstTick,lastTick'
        || !Number.isSafeInteger(value.firstTick) || value.firstTick < 1
        || !Number.isSafeInteger(value.lastTick) || value.lastTick - value.firstTick !== 49
        || !Number.isSafeInteger(value.capturedThroughTick) || value.capturedThroughTick < value.lastTick
        || o.tick < value.capturedThroughTick || typeof value.capturedSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.capturedSha256) || o.errors.length !== 0)
        throw new Error('Invalid immutable gameplay capture boundary');
      const last = o.acks.filter(row => row.tick === value.lastTick);
      if (last.length !== 1) throw new Error('Capture boundary lacks its actual final ACK');
      capturedGameplay = Object.freeze({ ...value, capturedAt: globalObject.performance.now(),
        finalAckAt: last[0].at, finalAckDigest: last[0].digest });
      return { ...capturedGameplay };
    } },
    armSocketCleanup: { value: () => {
      if (!cleanup) cleanup = { phase: 'armed', armedAt: globalObject.performance.now(), terminalMessages: [] };
      if (owned.length !== 1 || o.sockets.length !== 1 || !o.sockets[0].owned) throw new Error('Expected one owned room socket');
      return cleanupState();
    } },
    closeOwnedSocket: { value: () => {
      if (!cleanup || owned.length !== 1 || o.sockets.length !== 1) throw new Error('Socket cleanup was not armed');
      const entry = owned[0];
      if (cleanup.closeRequestedAt === undefined) {
        cleanup.closeRequestedAt = globalObject.performance.now(); cleanup.phase = 'closing';
        if (!entry.record.closed) {
          entry.record.closeCalls++;
          Reflect.apply(nativeClose, entry.socket, [1000, 'Default smoke complete']);
        }
      }
      return entry.closed.then(() => {
        cleanup.phase = 'closed'; cleanup.completedAt ??= globalObject.performance.now(); return cleanupState();
      });
    } },
    readSocketCleanup: { value: cleanupState },
  });
  globalObject.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      const socket = { sequence: o.sockets.length + 1, owned: this.url === socketURL, closeCalls: 0, closed: false };
      if (o.sockets.length >= 4) { fail('Socket observation capacity exceeded'); return; }
      put(o.sockets, socket, 4);
      let resolveClosed;
      const closed = new Promise(resolve => { resolveClosed = resolve; });
      if (socket.owned) owned.push({ socket: this, record: socket, closed }); else fail('Unexpected non-room socket');
      if (cleanup) fail('Socket created after cleanup was armed');
      this.addEventListener('close', event => {
        Object.assign(socket, { closed: true, closedAt: globalObject.performance.now(), closePhase: cleanup ? 'cleanup' : 'gameplay',
          code: event.code, clean: event.wasClean, trusted: event.isTrusted });
        if (!cleanup) fail('Room socket closed before cleanup');
        resolveClosed();
      });
      this.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('Unexpected bounded wire payload');
          const value = JSON.parse(event.data), at = globalObject.performance.now();
          if (value.type === 'joined') { o.joined = { room: value.room, slot: value.slot, at }; o.slot = value.slot; }
          if (value.type === 'rooms') { if (!Array.isArray(value.rooms) || value.rooms.length > 128) throw new Error('Room list bound'); o.rooms = value.rooms.map(row => ({ room: row.room })); }
          if (value.type === 'prepare') o.prepare = { at, initialPlayers: value.initialPlayers, replay: value.replay,
            personalProgression: value.personalProgression, frameMs: value.frameMs, mode: value.mode };
          if (value.type === 'caught_up') put(o.caughtUps, { at, tick: value.tick }, 4);
          if (value.type === 'frame') put(o.frames, { at, tick: value.tick, p1: value.p1, p2: value.p2, ...(value.join === undefined ? {} : { join: value.join }) });
          if (value.type === 'replay_frames') {
            if (!Array.isArray(value.frames) || value.frames.length > 64) throw new Error('Replay packet bound');
            for (const frame of value.frames) put(o.frames, { at, tick: frame.tick, p1: frame.p1, p2: frame.p2,
              ...(frame.join === undefined ? {} : { join: frame.join }), packetType: 'replay_frames' });
          }
          if (['error', 'paused', 'completed'].includes(value.type)) {
            if (cleanup) put(cleanup.terminalMessages, { at, type: value.type,
              reason: typeof value.reason === 'string' ? value.reason.slice(0, 128) : null,
              code: typeof value.code === 'string' ? value.code.slice(0, 128) : null,
              tick: Number.isSafeInteger(value.tick) ? value.tick : null }, 16);
            // Closing one actual peer may notify the other before both close
            // handshakes finish. All other terminal errors remain fatal.
            if (!(cleanup && value.type === 'paused' && value.reason === 'peer_disconnected'))
              fail('Unexpected terminal wire message: ' + value.type);
          }
        } catch (error) { fail(error); }
      });
    }
    send(raw) {
      const result = super.send(raw);
      try {
        if (typeof raw !== 'string' || raw.length > 65536) return result;
        const value = JSON.parse(raw), at = globalObject.performance.now();
        if (value.type === 'ack') {
          o.tick = value.tick; put(o.acks, { at, tick: value.tick, digest: value.digest });
          if (o.defaultSmokeShutdownAbortStarted === true) fail('ACK sent after observed shutdown abort');
        }
        if (value.type === 'input') put(o.inputs, { at, tick: o.tick, mask: value.mask, seq: value.seq });
      } catch (error) { fail(error); }
      return result;
    }
  };
}

export function validateDefaultSmokeMenuClick(before, after, x, y) {
  assert(Number.isFinite(x) && Number.isFinite(y));
  assert(Number.isSafeInteger(before.count) && before.count >= 0 && before.count < 128);
  assert(Number.isFinite(before.at) && before.at >= 0 && Number.isFinite(after.at) && after.at >= before.at);
  assert.equal(after.count, before.count + 1, 'Menu click must produce exactly one new pointerdown');
  assert.equal(after.events.length, 1, 'Missing unique physical menu pointerdown');
  const row = after.events[0];
  assert.equal(row.sequence, before.count + 1); assert.equal(row.type, 'pointerdown');
  assert.equal(row.trusted, true); assert.equal(row.pointerType, 'mouse'); assert.equal(row.primary, true);
  assert(Number.isSafeInteger(row.pointerId) && row.pointerId >= 0);
  assert.equal(row.button, 0); assert.equal(row.buttons, 1);
  assert(Number.isFinite(row.at) && row.at >= before.at && row.at <= after.at);
  assert(Number.isFinite(row.x) && Number.isFinite(row.y) && Math.abs(row.x - x) <= 1 && Math.abs(row.y - y) <= 1,
    'Observed menu pointer coordinates differ from the actual physical click');
  return { ...row };
}

export function validateDefaultSmokeSocketCleanup(nativeClients, transportSockets) {
  assert.equal(nativeClients.length, 2); assert.equal(transportSockets.length, 2);
  for (let index = 0; index < 2; index++) {
    const value = nativeClients[index]; assert.equal(value.version, 1); assert.equal(value.phase, 'closed');
    assert(Number.isFinite(value.armedAt) && value.armedAt >= 0);
    assert(Number.isFinite(value.closeRequestedAt) && value.closeRequestedAt >= value.armedAt);
    assert(Number.isFinite(value.completedAt) && value.completedAt >= value.closeRequestedAt);
    assert.deepEqual(value.observerErrors, []); assert.equal(value.sockets.length, 1);
    const socket = value.sockets[0]; assert.equal(socket.sequence, 1); assert.equal(socket.owned, true);
    assert.equal(socket.closed, true); assert.equal(socket.closePhase, 'cleanup');
    assert.equal(socket.code, 1000); assert.equal(socket.clean, true); assert.equal(socket.trusted, true);
    assert([0, 1].includes(socket.closeCalls));
    assert(Number.isFinite(socket.closedAt) && socket.closedAt >= value.armedAt && socket.closedAt <= value.completedAt);
    assert(Array.isArray(value.terminalMessages) && value.terminalMessages.length <= 16);
    for (const row of value.terminalMessages) {
      assert.equal(row.type, 'paused'); assert.equal(row.reason, 'peer_disconnected'); assert.equal(row.code, null);
      assert(Number.isSafeInteger(row.tick) && row.tick >= 0);
      assert(Number.isFinite(row.at) && row.at >= value.armedAt && row.at <= value.completedAt);
    }
    const observed = transportSockets.filter(row => row.client === index + 1); assert.equal(observed.length, 1);
    assert.equal(observed[0].owned, true); assert.equal(observed[0].closed, true);
  }
  return { verified: true, nativeCloseEvents: 2, transportCloseEvents: 2 };
}

// Teardown only, after both bounded gameplay observations have been captured.
// Arm both pages first, then close concurrently while native/CDP event sources
// remain alive. Failure is retained; it never substitutes for a CloseEvent.
export async function closeDefaultSmokeSockets(pages, transportSockets, transportClosures, bounded, report) {
  const proof = report.socketCleanup = { schema: 'original-default-smoke-socket-cleanup-v1', clients: [] };
  const clients = pages.map((page, index) => ({ page, row: { client: index + 1, errors: [] } }));
  proof.clients = clients.map(({ row }) => row);
  const problem = (row, error) => { if (row.errors.length < 8) row.errors.push(String(error).slice(0, 512)); };
  await Promise.all(clients.map(async ({ page, row }) => {
    try { row.armed = await bounded(page.evaluate(() => window.__defaultSmoke.armSocketCleanup()), 2000, 'socket cleanup arm'); }
    catch (error) { problem(row, error); }
  }));
  await Promise.all(clients.map(async ({ page, row }) => {
    try { row.native = await bounded(page.evaluate(() => window.__defaultSmoke.closeOwnedSocket()), 5000, 'native socket CloseEvent'); }
    catch (error) { problem(row, error); }
  }));
  try { await bounded(Promise.all(transportClosures), 5000, 'transport socket close events'); }
  catch (error) { proof.transportError = String(error).slice(0, 512); }
  await Promise.all(clients.map(async ({ page, row }) => {
    try { row.final = await bounded(page.evaluate(() => window.__defaultSmoke.readSocketCleanup()), 2000, 'final socket cleanup evidence'); }
    catch (error) { problem(row, error); }
  }));
  assert.equal(clients.length, 2); assert(clients.every(({ row }) => row.errors.length === 0));
  assert.equal(proof.transportError, undefined);
  proof.acceptance = validateDefaultSmokeSocketCleanup(clients.map(({ row }) => row.final), transportSockets);
  return proof;
}

/** Four physical directions inside one fixed window. No state query or retry
 * changes the window, and a blocked direction never substitutes for movement. */
export function defaultSmokeMovementSchedule(firstTick, lastTick) {
  assert(Number.isSafeInteger(firstTick) && firstTick >= 1);
  assert(Number.isSafeInteger(lastTick) && lastTick - firstTick === 49);
  return [['KeyD', 8, 0, 11], ['KeyA', 4, 12, 23], ['KeyW', 1, 24, 35], ['KeyS', 2, 36, 49]]
    .map(([code, mask, from, to]) => ({ code, mask, firstTick: firstTick + from, lastTick: firstTick + to }));
}

export async function driveDefaultSmokeMovement(pages, firstTick, lastTick, until, record = {}) {
  assert.equal(pages.length, 2);
  const segments = defaultSmokeMovementSchedule(firstTick, lastTick), evidence = [];
  Object.assign(record, { firstTick, lastTick, segments: evidence, fixedWindow: true });
  const ticks = () => Promise.all(pages.map(page => page.evaluate(() => window.__defaultSmoke.tick)));
  await until(async () => (await ticks()).every(tick => tick >= firstTick - 1), 'fixed movement window start', 45000);
  for (const segment of segments) {
    const before = await ticks();
    assert(before.every(tick => tick < segment.lastTick), 'Fixed movement segment elapsed before physical input');
    const row = { ...segment, before }; evidence.push(row);
    await Promise.all(pages.map(page => page.keyboard.down(segment.code)));
    row.afterDown = await ticks();
    await until(async () => (await ticks()).every(tick => tick >= segment.lastTick), 'physical ' + segment.code + ' segment', 45000);
    await Promise.all(pages.map(page => page.keyboard.up(segment.code)));
    row.afterUp = await ticks();
  }
  return record;
}

export function validateDefaultSmokeMovement(clients, firstTick, lastTick, evidence) {
  assert.equal(clients.length, 2); assert.equal(evidence.firstTick, firstTick); assert.equal(evidence.lastTick, lastTick);
  assert.equal(evidence.fixedWindow, true);
  const schedule = defaultSmokeMovementSchedule(firstTick, lastTick);
  assert.equal(evidence.segments.length, schedule.length);
  return clients.map((o, index) => {
    const from = o.acks.find(row => row.tick === firstTick - 1)?.at, to = o.acks.find(row => row.tick === lastTick)?.at;
    assert(Number.isFinite(from) && Number.isFinite(to) && to > from);
    for (let part = 0; part < schedule.length; part++) {
      const expected = schedule[part], actual = evidence.segments[part];
      for (const key of ['code', 'mask', 'firstTick', 'lastTick']) assert.equal(actual[key], expected[key]);
      for (const key of ['before', 'afterDown', 'afterUp']) assert.equal(actual[key].length, 2);
      assert(actual.before[index] >= expected.firstTick - 1 && actual.before[index] < expected.lastTick);
      assert(actual.afterDown[index] >= actual.before[index] && actual.afterDown[index] < expected.lastTick);
      assert(actual.afterUp[index] >= expected.lastTick);
      const down = o.keys.filter(row => row.type === 'keydown' && row.code === expected.code
        && row.trusted === true && row.at >= from && row.at <= to);
      assert.equal(down.length, 1, 'Each direction requires one trusted in-window physical keydown');
      const up = o.keys.filter(row => row.type === 'keyup' && row.code === expected.code && row.trusted === true && row.at >= down[0].at);
      assert.equal(up.length, 1, 'Each direction requires one actual release');
      assert(o.inputs.some(row => row.at >= down[0].at && row.at <= up[0].at && row.mask === expected.mask),
        'Physical direction did not reach the original input transport');
      assert(o.frames.some(row => row.tick >= expected.firstTick && row.tick <= expected.lastTick
        && row[index === 0 ? 'p1' : 'p2'] === expected.mask), 'Direction absent from its fixed paired tick segment');
    }
    // The original validator separately requires a changing own position in
    // these same fifty ticks, two full receipts, forty-eight compact receipts,
    // all matching ACKs and advancing actual default-mode Present calls.
    return { client: index + 1, physicalDirections: schedule.map(row => row.code), inWindow: true };
  });
}

/** Additional v3 shutdown proof. The v2 socket proof remains unchanged. */
export async function closeDefaultSmokeSocketsV3(pages, transportSockets, transportClosures, bounded, report) {
  const proof = await closeDefaultSmokeSockets(pages, transportSockets, transportClosures, bounded, report);
  proof.shutdown = [];
  for (const page of pages) {
    const settled = await bounded(page.evaluate(() => window.__defaultSmoke.awaitDefaultSmokeShutdown()), 5000,
      'actual pending native shutdown settlement');
    proof.shutdown.push(settled);
  }
  proof.shutdownFinal = await Promise.all(pages.map(page => page.evaluate(() => ({
    native: window.__defaultSmoke.readDefaultSmokeShutdown(), socket: window.__defaultSmoke.readSocketCleanup(),
  }))));
  proof.shutdownAcceptance = validateDefaultSmokeShutdown(proof.shutdownFinal, report.acceptance, report.raw);
  return proof;
}

export function validateDefaultSmokeShutdown(clients, accepted, raw) {
  assert(accepted && accepted.pairedTicks === 50); assert.equal(clients.length, 2); assert.equal(raw.length, 2);
  for (let index = 0; index < 2; index++) {
    const { native, socket } = clients[index], captured = socket.gameplayWindow;
    assert.deepEqual(socket.observerErrors, []); assert.equal(socket.phase, 'closed');
    assert(captured && captured.firstTick === accepted.firstTick && captured.lastTick === accepted.lastTick);
    assert.equal(captured.capturedSha256, raw[index].expandedSha256);
    assert(captured.capturedThroughTick >= captured.lastTick && captured.capturedAt <= socket.armedAt);
    assert(Number.isFinite(captured.finalAckAt) && captured.finalAckAt <= captured.capturedAt);
    assert(/^native-v2-[a-f0-9]{16}$/.test(captured.finalAckDigest));
    assert.equal(native.version, 1); assert.equal(native.failed, false);
    assert(Number.isFinite(native.observedAt) && native.observedAt >= socket.completedAt);
    assert(native.aborts.length <= 1); assert.equal(native.callsAfterAbort, 0);
    if (native.aborts.length === 0) {
      assert.equal(native.pending, false, 'Pending shutdown transaction was neither completed nor actually aborted');
    } else {
      const abort = native.aborts[0]; assert.equal(abort.valid, true); assert.equal(abort.threw, false);
      assert(Number.isSafeInteger(abort.tick) && abort.tick > accepted.lastTick);
      assert.equal(abort.arity, 3); assert(typeof abort.token === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(abort.token));
      assert(Number.isSafeInteger(abort.epoch) && abort.epoch > 0);
      assert.equal(abort.begin.name, abort.family === 'full' ? 'bhStepBegin' : 'bhFrameBegin');
      assert.deepEqual(abort.begin.witness, { version: 1, phase: 'begun', token: abort.token, epoch: abort.epoch, tick: abort.tick });
      assert(Number.isFinite(abort.begin.at) && Number.isFinite(abort.begin.ms)
        && abort.begin.ms >= 0 && abort.begin.at + abort.begin.ms <= abort.at);
      assert(Number.isFinite(abort.ms) && abort.ms >= 0);
      assert(abort.at >= socket.closeRequestedAt && abort.at + abort.ms <= native.observedAt);
      assert.equal(abort.ackCount, socket.ackCount); assert.equal(socket.lastAck.tick, abort.tick - 1);
      assert.equal(native.consumed, abort.consumed); assert.equal(native.readbacks, abort.readbacks);
      assert.equal(native.playerDisconnected, true, 'Aborted native player was not disposed');
      assert.equal(abort.family, abort.tick % 25 === 0 ? 'full' : 'compact');
      assert.equal(abort.name, abort.family === 'full' ? 'bhStepAbort' : 'bhFrameAbort');
      assert.equal(abort.result.error, 'native staged tick fence: authenticated staged tick abort');
      assert.deepEqual(Object.keys(abort.result).sort(), ['engine', 'error', 'state', 'version']);
      assert.equal(abort.result.version, 1); assert.equal(abort.result.engine, 'original-swf');
      assert.equal(abort.result.state, 'error');
    }
  }
  return { verified: true, actualShutdownAborts: clients.reduce((sum, row) => sum + row.native.aborts.length, 0),
    gameplayWindowUnchanged: true, cleanupDoesNotCountAsReceipt: true };
}

// Self-contained passive wrapper. Preserve every receiver, argument, result and
// thrown value. Own data descriptors avoid executing a result getter to observe it.
export function installDefaultSmokeConfig(player, observation, now) {
  const original = player.ruffle;
  player.ruffle = function (...args) {
    const api = Reflect.apply(original, this, args);
    return new Proxy(api, { get(target, key) {
      const method = Reflect.get(target, key, target);
      if (key !== 'callExternalInterface') return typeof method === 'function' ? method.bind(target) : method;
      return function (name, ...params) {
        if (name !== 'bhPresentationConfig') return Reflect.apply(method, target, [name, ...params]);
        const at = now(); let result, thrown, threw = false;
        try { result = Reflect.apply(method, target, [name, ...params]); }
        catch (error) { thrown = error; threw = true; }
        if (name === 'bhPresentationConfig') try {
          if (observation.configs.length >= 16) throw new Error('Configuration observation bound');
          if (typeof params[0] !== 'boolean' || (params[1] !== undefined && (typeof params[1] !== 'string' || params[1].length > 128))) throw new Error('Nonprimitive or oversized config arguments');
          const row = { at, ms: now() - at, arity: params.length, enable: params[0], mode: params[1], threw };
          if (!threw) {
            if (typeof result === 'string' && result.length > 16384) throw new Error('Configuration response size bound');
            const decoded = typeof result === 'string' ? JSON.parse(result) : result;
            for (const field of ['version', 'ok', 'enabled', 'mode', 'poseVersion']) {
              const property = Object.getOwnPropertyDescriptor(decoded, field);
              if (!property || !Object.hasOwn(property, 'value')) throw new Error('Missing configuration own data');
              if (!['boolean', 'number', 'string'].includes(typeof property.value)
                || (typeof property.value === 'number' && !Number.isFinite(property.value))
                || (typeof property.value === 'string' && property.value.length > 128)) throw new Error('Nonprimitive config result');
              row['result_' + field] = property.value;
            }
          }
          observation.configs.push(row);
        } catch (error) { if (observation.errors.length < 16) observation.errors.push({ type: 'default-smoke-config', error: String(error).slice(0, 512) }); }
        if (threw) throw thrown;
        return result;
      };
    }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
  };
}

export function validateDefaultSmokeClients(clients, firstTick, lastTick, origin) {
  assert.equal(clients.length, 2); assert.equal(lastTick - firstTick + 1, DEFAULT_SMOKE_LIMITS.ticks);
  const spawns = clients.map(o => o.frames.filter(row => row.join));
  assert(spawns.every(rows => rows.length === 1)); assert.deepEqual(spawns[0][0].join, spawns[1][0].join);
  const joinTick = spawns[0][0].tick; assert.equal(joinTick, spawns[1][0].tick); assert.equal(spawns[0][0].join.slot, 2);
  assert.equal(clients[1].caughtUps.length, 1); assert.equal(clients[1].caughtUps[0].tick + 1, joinTick);
  assert(firstTick >= joinTick + 4 && firstTick <= joinTick + 250);
  const summaries = clients.map((o, index) => {
    assert.equal(o.initialURL, bareDefaultSmokeURL(origin + '/')); assert.equal(o.slot, index + 1);
    assert.equal(o.finalURL.origin, origin); assert.equal(o.finalURL.pathname, '/');
    assert.equal(o.finalURL.hasPresentationClock, false); assert.equal(o.finalURL.hasPresentation, false);
    assert.equal(o.playerUnchanged, true); assert.deepEqual(o.errors, []);
    assert(o.mouse.filter(row => row.type === 'pointerdown' && row.trusted === true && row.pointerType === 'mouse'
      && row.primary === true && row.button === 0 && row.buttons === 1).length >= 3, 'Missing physical menu pointerdowns');
    assert.equal(o.prepare.initialPlayers, 1); assert.equal(o.prepare.replay, index === 1);
    assert.equal(o.prepare.personalProgression, true); assert.equal(o.prepare.frameMs, 40); assert.equal(o.prepare.mode, 'Coop');
    assert(o.configs.length > 0 && o.configs.length <= 16);
    for (const row of o.configs) {
      assert.equal(row.arity, 2); assert.equal(row.enable, true); assert.equal(row.mode, 'four-pose-v3'); assert.equal(row.threw, false);
      assert.equal(row.result_version, 1); assert.equal(row.result_ok, true); assert.equal(row.result_enabled, true);
      assert.equal(row.result_mode, 'four-pose-v3'); assert.equal(row.result_poseVersion, 3);
    }
    const native = validatePerformancePhasedNativeWindow(o, firstTick, lastTick, { expectNativeProject: true });
    assert.equal(native.actualFullStagedCommits, 2); assert.equal(native.actualCompactStagedCommits, 48);
    const completions = o.callbacks.filter(row => ['bhStepCommit', 'bhFrameCommit'].includes(row.name)
      && row.tick >= firstTick && row.tick <= lastTick);
    for (const row of completions) assert.deepEqual(row.playerSlots, [1, 2]);
    const from = o.acks.find(row => row.tick === firstTick - 1).at, to = o.acks.find(row => row.tick === lastTick).at;
    const presentation = summarizeBufferedNativePresentationCalls(o.presentations, from, to, { requiredMode: 'four-pose-v3' });
    assert(presentation.calls >= 20 && presentation.rendered >= 2 && presentation.interpolatedCalls > 0);
    assert.equal(presentation.requestedPose.regressions, 0); assert(presentation.requestedPose.advances >= 2);
    assert.equal(presentation.renderedPose.regressions, 0); assert(presentation.renderedPose.advances > 0);
    assert(o.keys.some(row => row.trusted === true && row.type === 'keydown' && row.code === 'KeyD'));
    assert(o.inputs.some(row => row.at <= to && (row.mask & 15) !== 0));
    assert(o.frames.some(row => row.tick >= firstTick && row.tick <= lastTick && (row[index === 0 ? 'p1' : 'p2'] & 15) !== 0), 'No own movement in paired live frames');
    const positions = completions.map(row => row.players.find(player => player.slot === index + 1));
    assert(positions.every(player => Number.isFinite(player.x) && Number.isFinite(player.y)));
    assert(positions.some(player => player.x !== positions[0].x || player.y !== positions[0].y), 'Own player never moved');
    return { client: index + 1, native, presentation, configs: o.configs, initialURL: o.initialURL, finalURL: o.finalURL };
  });
  for (let tick = firstTick; tick <= lastTick; tick++) {
    assert.equal(clients[0].acks.find(row => row.tick === tick).digest, clients[1].acks.find(row => row.tick === tick).digest);
    for (const key of ['p1', 'p2']) assert.equal(clients[0].frames.find(row => row.tick === tick)[key], clients[1].frames.find(row => row.tick === tick)[key]);
  }
  return { joinTick, firstTick, lastTick, pairedTicks: DEFAULT_SMOKE_LIMITS.ticks, clients: summaries };
}
