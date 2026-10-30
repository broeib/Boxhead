/** Isolated, passive startup diagnostics. This module is not installed by the
 * production application or any sealed evidence producer. It observes actual
 * calls only; DOM player IDs identify elements, not independent VM allocations.
 * Error messages, URLs, load bytes, callback arguments and receipt tokens are
 * never retained. A missing/overflowing observation cannot qualify a run. */
export function installOriginalStartupLifecycleObserver(globalObject, options = {}) {
  const g = globalObject;
  if (!g?.Element?.prototype || !g.document || !g.performance?.now || !g.Promise?.prototype?.then)
    throw new Error('Startup lifecycle observer requires browser DOM/Promise APIs');
  if (g.__originalStartupLifecycle !== undefined) throw new Error('Startup lifecycle observer already installed');
  const defaults = { players: 4, apiSamples: 32, events: 256, errors: 16, nativeCalls: 2000000, jsonCharacters: 8192 };
  const maximum = { players: 16, apiSamples: 128, events: 2048, errors: 64, nativeCalls: 8000000, jsonCharacters: 32768 };
  const limits = {};
  for (const key of Object.keys(defaults)) {
    const value = options[key] ?? defaults[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum[key]) throw new Error('Invalid lifecycle limit: ' + key);
    limits[key] = value;
  }
  const callbackNames = new Set(['bhInfo', 'bhRenderCheck', 'bhPrepare', 'bhCheckpointImport', 'bhStep', 'bhStateReceipt']);
  const state = { schema: 'original-startup-lifecycle-observation-v2', active: true, complete: true,
    extraNativeCalls: 0, nativeCalls: 0, apiObjects: 0, limits, players: [], events: [], errors: [],
    dropped: { players: 0, events: 0, errors: 0, nativeCalls: 0 },
    apiRetention: 'Weak API identities; per DOM player retain the first apiSamples and latest primitive API metadata only. All observed native callback counters and first/last results are independent of API metadata sampling. API wrappers have no strong restoration history and become inactive forwarding delegates on close.',
    scope: 'Actual DOM insertion/load/callback observations; DOM/API IDs do not independently prove VM identity. No game arguments, native graphs, URLs, receipt tokens or error-message text are retained.' };
  const players = new WeakMap(), apis = new WeakMap(), playersToScan = [], restorations = [];
  let serial = 0;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clock = () => {
    try { const value = Reflect.apply(g.performance.now, g.performance, []); if (finite(value) && value >= 0) return value; }
    catch { /* A diagnostic clock failure must not replace a native result. */ }
    state.complete = false; state.clockFailed = true; return null;
  };
  const copy = value => Array.isArray(value) ? value.map(copy)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
  function own(value, name) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  function descriptor(object, name) {
    for (let current = object, depth = 0; current && depth < 16; current = Object.getPrototypeOf(current), depth++) {
      const found = Object.getOwnPropertyDescriptor(current, name);
      if (found) return found;
    }
    return undefined;
  }
  function data(object, name) {
    const found = descriptor(object, name);
    return found && Object.hasOwn(found, 'value') ? found.value : undefined;
  }
  function errorSummary(error) {
    const name = data(error, 'name'), raw = own(error, 'message');
    const message = typeof raw === 'string' ? raw.slice(0, 1024) : '';
    const code = /abort|отмен/iu.test(message) ? 'aborted'
      : /timed?\s*out|timeout|истекло|не завершил загрузку/iu.test(message) ? 'timeout'
      : /webgpu|webgl|wgpu|renderer|GPUAdapter|requestAdapter/iu.test(message) ? 'renderer-mentioned'
      : /соответствует контракту|invalid.*(?:state|callback)|callback.*(?:missing|unavailable)/iu.test(message) ? 'contract-mentioned'
      : /memory|allocation|памят/iu.test(message) ? 'memory-mentioned' : 'unclassified';
    return { name: ['Error', 'TypeError', 'RangeError', 'AbortError', 'RuntimeError', 'ClientError'].includes(name) ? name : 'other',
      code, messageCharacters: typeof raw === 'string' ? Math.min(raw.length, 1024) : 0,
      messageTruncated: typeof raw === 'string' && raw.length > 1024 };
  }
  function dropped(kind) { state.complete = false; state.dropped[kind]++; }
  function problem(code, error) {
    state.complete = false;
    if (state.errors.length >= limits.errors) { dropped('errors'); return; }
    state.errors.push({ code, at: clock(), ...(error === undefined ? {} : { error: errorSummary(error) }) });
  }
  function observe(operation) {
    if (!state.active) return;
    try { operation(); } catch (error) {
      try { problem('observation-failed', error); } catch { state.complete = false; }
    }
  }
  function event(kind, player, detail = {}) {
    if (state.events.length >= limits.events) { dropped('events'); return; }
    state.events.push({ sequence: ++serial, kind, player, at: clock(), ...detail });
  }
  function patch(object, name, wrap, retainRestoration = true) {
    const previousOwn = Object.getOwnPropertyDescriptor(object, name), found = descriptor(object, name);
    if (!found || typeof found.value !== 'function') throw new Error('Unsupported lifecycle method descriptor');
    const wrapped = wrap(found.value);
    Object.defineProperty(object, name, { ...(previousOwn ?? { configurable: true, enumerable: false, writable: true }), value: wrapped });
    if (retainRestoration) restorations.push(() => {
      if (own(object, name) !== wrapped) return;
      if (previousOwn) Object.defineProperty(object, name, previousOwn); else delete object[name];
    });
  }
  function selected(name, raw) {
    let value = raw, kind = raw === null ? 'null' : typeof raw;
    if (typeof raw === 'string') {
      if (raw.length > limits.jsonCharacters) return { kind: 'string-over-limit' };
      try { value = JSON.parse(raw); kind = 'json'; } catch { return { kind: raw === '' ? 'empty-string' : 'non-json-string' }; }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: Array.isArray(value) ? 'array' : kind };
    const out = { kind, values: {} }, fields = out.values;
    for (const key of ['version', 'tick', 'worldTick', 'epoch', 'pixel', 'expected']) {
      const item = own(value, key); if (finite(item)) fields[key] = item;
    }
    for (const key of ['canPrepare', 'menuReady', 'supported']) {
      const item = own(value, key); if (typeof item === 'boolean') fields[key] = item;
    }
    for (const [key, allowed] of [['engine', ['original-swf']], ['state', ['menu', 'loading', 'ready', 'playing', 'error']],
      ['scope', ['frame', 'full']]]) {
      const item = own(value, key); if (allowed.includes(item)) fields[key] = item;
    }
    const menuVersion = own(value, 'menuVersion'); if (finite(menuVersion)) fields.menuVersion = menuVersion;
    fields.errorPresent = own(value, 'error') !== undefined;
    if (name === 'bhStateReceipt') {
      const header = own(value, 'header');
      const tick = own(header, 'tick'); if (finite(tick)) fields.headerTick = tick;
      const status = own(header, 'state'); if (['ready', 'playing', 'error'].includes(status)) fields.headerState = status;
    }
    if (name === 'bhInfo') {
      const canPrepare = own(value, 'canPrepare');
      const fieldsRead = ['version', 'engine', 'state', 'tick', 'canPrepare', 'menuVersion',
        'snapshotReceiptVersion', 'stagedStepVersion', 'checkpointVersion', 'error'];
      const onlyData = fieldsRead.every(key => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return !field || Object.hasOwn(field, 'value');
      });
      const error = own(value, 'error');
      out.readinessShapeValid = fields.version === 1 && fields.engine === 'original-swf'
        && ['menu', 'loading', 'ready', 'playing', 'error'].includes(fields.state)
        && Number.isInteger(fields.tick) && fields.tick >= 0 && fields.tick <= 0x7fffffff && onlyData
        && (canPrepare === undefined || typeof canPrepare === 'boolean')
        && (menuVersion === undefined || menuVersion === 1)
        && ['snapshotReceiptVersion', 'stagedStepVersion', 'checkpointVersion'].every(key => {
          const version = own(value, key); return version === undefined || version === 1;
        })
        && (error === undefined || (typeof error === 'string' && error.length <= 1024));
    }
    return out;
  }
  function recordCallback(row, apiId, name, at, raw, error, thrown) {
    if (state.nativeCalls >= limits.nativeCalls) { dropped('nativeCalls'); return; }
    state.nativeCalls++;
    const result = thrown ? { error: errorSummary(error) } : selected(name, raw);
    const sample = { at, completedAt: clock(), api: apiId, load: row.loads.length, thrown, ...result };
    let count = row.callbacks[name];
    if (!count) count = row.callbacks[name] = { count: 0, returns: 0, throws: 0, first: copy(sample), last: null };
    count.count++; count[thrown ? 'throws' : 'returns']++; count.last = sample;
    if (!thrown && name === 'bhInfo' && result.readinessShapeValid) {
      row.firstValidInfoAt ??= sample.completedAt;
      if (result.values.canPrepare === true) row.firstCanPrepareAt ??= sample.completedAt;
      if (result.values.menuReady === true) row.firstMenuReadyAt ??= sample.completedAt;
    }
    if (thrown || name === 'bhRenderCheck' || name === 'bhPrepare' || name === 'bhCheckpointImport'
      || ((name === 'bhStep' || name === 'bhStateReceipt') && count.count === 1))
      event(thrown ? 'callback-threw' : 'callback-returned', row.id, { name, sample: copy(sample) });
  }
  function hookApi(api, row) {
    if (api === null || (typeof api !== 'object' && typeof api !== 'function')) { problem('non-object-ruffle-api'); return; }
    if (apis.has(api)) {
      if (apis.get(api).row !== row) problem('api-shared-by-dom-players');
      return;
    }
    // Ruffle may return a fresh facade on every ruffle() call. Count distinct
    // identities without retaining the objects or stopping callback recording
    // after the bounded primitive metadata prefix has filled.
    if (state.apiObjects >= Number.MAX_SAFE_INTEGER) { problem('api-identity-counter-overflow'); return; }
    const id = ++state.apiObjects;
    apis.set(api, { id, row }); row.apiObjects++;
    patch(api, 'callExternalInterface', original => function (name, ...args) {
      if (!state.active || !callbackNames.has(name)) return Reflect.apply(original, this, [name, ...args]);
      const at = clock();
      let raw, thrown = false, error;
      try { raw = Reflect.apply(original, this, [name, ...args]); }
      catch (caught) { thrown = true; error = caught; }
      observe(() => {
        if (this !== api) problem('native-api-receiver-changed');
        recordCallback(row, id, name, at, raw, error, thrown);
      });
      if (thrown) throw error;
      return raw;
    }, false);
    const sample = { api: id, at: clock() };
    if (row.apiSamples.first.length < limits.apiSamples) row.apiSamples.first.push(copy(sample));
    row.apiSamples.last = sample;
    row.apiSamples.omitted = Math.max(0, row.apiObjects - row.apiSamples.first.length - 1);
    // Per-facade lifecycle events would exhaust the actual load/DOM event
    // budget during ordinary readiness polling and gameplay.
    if (row.apiObjects === 1) event('api-observed', row.id, { api: id });
  }
  const getAttribute = g.Element.prototype.getAttribute, promiseThen = g.Promise.prototype.then;
  function attribute(element, name) { return Reflect.apply(getAttribute, element, [name]); }
  function hookPlayer(player) {
    if (!(player instanceof g.Element) || attribute(player, 'id') !== 'original-ruffle-player' || players.has(player)) return;
    if (state.players.length >= limits.players) { dropped('players'); return; }
    const row = { id: state.players.length + 1, observedAt: clock(), connected: false, apiObjects: 0,
      apiSamples: { first: [], last: null, omitted: 0 },
      loads: [], callbacks: {}, firstValidInfoAt: null, firstCanPrepareAt: null, firstMenuReadyAt: null };
    players.set(player, row); playersToScan.push(player); state.players.push(row);
    event('player-observed', row.id);
    patch(player, 'load', original => function (...args) {
      if (!state.active) return Reflect.apply(original, this, args);
      let attempt;
      observe(() => {
        if (this !== player) problem('load-receiver-changed');
        if (row.loads.length >= 4) { dropped('events'); return; }
        const settings = args[0], renderer = own(settings, 'preferredRenderer');
        attempt = { sequence: row.loads.length + 1, at: clock(), status: 'pending',
          renderer: ['wgpu-webgl', 'webgpu'].includes(renderer) ? renderer : 'other',
          source: own(settings, 'data') !== undefined ? 'bytes' : own(settings, 'url') !== undefined ? 'url' : 'other' };
        row.loads.push(attempt); event('load-called', row.id, { load: attempt.sequence, renderer: attempt.renderer, source: attempt.source });
      });
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) {
        observe(() => {
          if (attempt) { attempt.status = 'threw'; attempt.completedAt = clock(); attempt.error = errorSummary(error); }
          event('load-threw', row.id, { load: attempt?.sequence, error: errorSummary(error) });
        });
        throw error;
      }
      observe(() => {
        if (!(result instanceof g.Promise)) {
          if (attempt) { attempt.status = 'unobserved-non-promise'; attempt.completedAt = clock(); }
          problem('load-returned-non-promise'); return;
        }
        // Observe settlement through a separate native Promise branch. Return
        // the original Promise object to the caller unchanged.
        Reflect.apply(promiseThen, result, [
          () => observe(() => { if (attempt) { attempt.status = 'resolved'; attempt.completedAt = clock(); }
            event('load-resolved', row.id, { load: attempt?.sequence }); }),
          error => observe(() => { if (attempt) { attempt.status = 'rejected'; attempt.completedAt = clock(); attempt.error = errorSummary(error); }
            event('load-rejected', row.id, { load: attempt?.sequence, error: errorSummary(error) }); }),
        ]);
      });
      return result;
    });
    patch(player, 'ruffle', original => function (...args) {
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { observe(() => event('ruffle-api-threw', row.id, { error: errorSummary(error) })); throw error; }
      observe(() => { if (this !== player) problem('ruffle-receiver-changed'); else hookApi(result, row); });
      return result;
    });
  }
  function scanConnections() {
    for (const player of playersToScan) {
      const row = players.get(player), connected = player.isConnected === true;
      if (row.connected === connected) continue;
      row.connected = connected;
      const at = clock();
      if (connected) { row.firstInsertedAt ??= at; row.lastInsertedAt = at; }
      else row.lastRemovedAt = at;
      event(connected ? 'inserted' : 'removed', row.id);
    }
  }
  for (const name of ['append', 'replaceChildren', 'remove']) {
    patch(g.Element.prototype, name, original => function (...args) {
      observe(() => { for (const arg of args) hookPlayer(arg); });
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { observe(scanConnections); throw error; }
      observe(scanConnections); return result;
    });
  }
  observe(() => {
    const existing = g.document.getElementById('original-ruffle-player');
    if (existing) { problem('installed-after-player-insertion'); hookPlayer(existing); }
    scanConnections();
  });
  const controller = {
    snapshot() {
      observe(scanConnections);
      const stage = g.document.getElementById('stage'), renderer = stage ? attribute(stage, 'data-renderer-preference') : null;
      return { ...copy(state), selectedRendererPreference: ['wgpu-webgl', 'webgpu'].includes(renderer) ? renderer : null };
    },
    close() {
      if (!state.active) return;
      observe(scanConnections); state.active = false;
      for (const restore of restorations.reverse()) { try { restore(); } catch { state.complete = false; } }
    },
  };
  g.__originalStartupLifecycle = controller;
  return controller;
}
