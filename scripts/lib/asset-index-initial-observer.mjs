// Opt-in diagnostic. Both exports are self-contained for Playwright serialization.
// Only an already-returned bhInfo value is inspected; no Ruffle/native operation
// is initiated. The value is the bridge's loading-time snapshot, not live usage.
export function installAssetIndexInitialObserver() {
  const key = '__boxheadAssetIndexInitialObserver';
  const schema = 'boxhead-asset-index-initial-observer-v1';
  const own = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const apply = Reflect.apply;
  const get = Reflect.get;
  const safeInteger = Number.isSafeInteger;
  const finite = Number.isFinite;
  const parse = JSON.parse;
  const limits = Object.freeze({ maximumInfoCharacters: 262144, maximumInfoReturns: 16,
    maximumReasonCharacters: 80, maximumEntries: 65536, maximumDisplayEdges: 8192, maximumErrors: 4 });
  if (own(globalThis, key)) return { schema, installed: false, reason: 'already-present', extraNativeCalls: 0 };
  let player, priorDescriptor, priorRuffle, observedRuffle;
  let installed = false, active = false, restored = false, restoreAttempted = false;
  let attempts = 0, missing = 0, snapshot = null, reason = 'not-installed';
  const errors = [];
  const note = code => { if (errors.length < limits.maximumErrors && !errors.includes(code)) errors.push(code); };
  function data(object, field) {
    if (object === null || typeof object !== 'object') return undefined;
    const descriptor = own(object, field);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('accessor');
    return descriptor.value;
  }
  function restore() {
    active = false;
    if (!installed || restoreAttempted) return;
    restoreAttempted = true;
    try {
      const current = own(player, 'ruffle');
      if (current?.value !== observedRuffle) { note('ruffle-owner-changed'); return; }
      if (priorDescriptor) define(player, 'ruffle', priorDescriptor);
      else delete player.ruffle;
      // An inherited accessor was never accepted; this lookup cannot run one.
      if (get(player, 'ruffle', player) !== priorRuffle) { note('ruffle-restore-value'); return; }
      restored = true;
    } catch { note('ruffle-restore-failed'); }
  }
  function stop(code) { reason = code; restore(); }
  function fail(code) { note(code); stop('observer-error'); }
  function collect() {
    if (active) stop(snapshot ? 'captured' : 'collected-before-snapshot');
    return { schema, diagnosticOnly: true, installed, active, restored, restoreAttempted,
      captured: snapshot !== null, complete: installed && snapshot !== null && restored && errors.length === 0,
      attempts, missing, reason, errors: [...errors], limits: { ...limits },
      snapshot: snapshot === null ? null : { ...snapshot, assetIndex: { ...snapshot.assetIndex } },
      extraNativeCalls: 0, liveCacheUseClaimed: false, gameplayPassClaimed: false,
      performancePassClaimed: false,
      scope: 'First existing bhInfo.anchorMetadata.assetIndex return; bridge loading snapshot only. No live status, cache-hit count, or runtime validity query.' };
  }
  define(globalThis, key, { value: Object.freeze({ schema, collect }), enumerable: false, configurable: true });
  function observe(name, result) {
    if (!active || name !== 'bhInfo') return;
    attempts++;
    try {
      let decoded = result;
      if (typeof decoded === 'string') {
        if (decoded.length > limits.maximumInfoCharacters) { fail('info-character-limit'); return; }
        try { decoded = parse(decoded); } catch { fail('invalid-info-json'); return; }
      }
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
        fail('invalid-info-object'); return;
      }
      const metadata = data(decoded, 'anchorMetadata');
      const index = data(metadata, 'assetIndex');
      if (index === undefined) {
        missing++;
        if (attempts >= limits.maximumInfoReturns) stop('info-return-limit');
        return;
      }
      const version = data(index, 'version'), ready = data(index, 'ready'), why = data(index, 'reason');
      const entries = data(index, 'entries'), displayEdges = data(index, 'displayEdges'), tick = data(decoded, 'tick');
      if (version !== 1 || typeof ready !== 'boolean' || typeof why !== 'string'
        || why.length === 0 || why.length > limits.maximumReasonCharacters || !/^[a-z0-9-]+$/.test(why)
        || !safeInteger(entries) || entries < 0 || entries > limits.maximumEntries
        || !safeInteger(displayEdges) || displayEdges < 0 || displayEdges > limits.maximumDisplayEdges
        || !safeInteger(tick) || tick < 0) { fail('invalid-asset-index-scalars'); return; }
      const at = performance.now();
      if (!finite(at) || at < 0) { fail('invalid-observer-clock'); return; }
      snapshot = { source: 'actual-bhInfo-return', at, infoTick: tick,
        assetIndex: { version, ready, reason: why, entries, displayEdges } };
      stop('captured');
    } catch { fail('asset-index-observation-failed'); }
  }
  try {
    const observation = data(globalThis, '__perf');
    if (data(observation, 'performancePhasedNativeObserverInstalled') !== true) {
      reason = 'native-observer-not-installed'; return { schema, installed, reason, extraNativeCalls: 0 };
    }
    player = data(observation, 'startupPlayer');
    if (!player || !player.isConnected || document.querySelector('#original-ruffle-player') !== player) {
      reason = 'pinned-player-unavailable'; return { schema, installed, reason, extraNativeCalls: 0 };
    }
    priorDescriptor = own(player, 'ruffle');
    // The existing native observer installed this own data function. Do not
    // traverse a prototype/accessor or claim another wrapper's ownership.
    if (!priorDescriptor || !Object.hasOwn(priorDescriptor, 'value') || !priorDescriptor.configurable
      || typeof priorDescriptor.value !== 'function') {
      reason = 'ruffle-wrapper-unavailable'; return { schema, installed, reason, extraNativeCalls: 0 };
    }
    priorRuffle = priorDescriptor.value;
    observedRuffle = function (...args) {
      // Any original exception/primitive throw escapes unchanged. Observation
      // failures cannot replace an original return or call a method again.
      const api = apply(priorRuffle, this, args);
      if (!active) return api;
      if (api === null || (typeof api !== 'object' && typeof api !== 'function')) {
        fail('invalid-ruffle-api'); return api;
      }
      try {
        const descriptor = own(api, 'callExternalInterface');
        if (descriptor && descriptor.configurable === false && descriptor.writable === false) {
          fail('locked-native-method'); return api;
        }
      } catch { fail('api-descriptor-failed'); return api; }
      const cached = new Map();
      let proxy;
      try {
        proxy = new Proxy(api, {
          get(target, field) {
            const value = get(target, field, target);
            if (typeof value !== 'function') return value;
            let descriptor;
            try { descriptor = own(target, field); }
            catch { fail('api-descriptor-failed'); return value; }
            if (descriptor && descriptor.configurable === false && descriptor.writable === false) {
              if (field === 'callExternalInterface') fail('locked-native-method');
              return value;
            }
            const previous = cached.get(field);
            if (previous?.original === value) return previous.wrapped;
            const wrapped = new Proxy(value, {
              apply(original, receiver, parameters) {
                const result = apply(original, receiver === proxy ? target : receiver, parameters);
                if (field === 'callExternalInterface') observe(parameters[0], result);
                return result;
              },
            });
            cached.set(field, { original: value, wrapped });
            return wrapped;
          },
        });
      } catch { fail('api-wrapper-failed'); return api; }
      return proxy;
    };
    define(player, 'ruffle', { ...priorDescriptor, value: observedRuffle });
    installed = active = true; reason = 'awaiting-existing-info';
    return { schema, installed, reason, extraNativeCalls: 0 };
  } catch {
    fail('observer-install-failed');
    return { schema, installed, reason, extraNativeCalls: 0 };
  }
}

export function collectAssetIndexInitialObserver() {
  const key = '__boxheadAssetIndexInitialObserver';
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const api = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (api?.schema !== 'boxhead-asset-index-initial-observer-v1' || typeof api.collect !== 'function')
    return { schema: 'boxhead-asset-index-initial-observer-v1', diagnosticOnly: true,
      installed: false, captured: false, complete: false, restored: false, reason: 'observer-unavailable',
      extraNativeCalls: 0, liveCacheUseClaimed: false, gameplayPassClaimed: false, performancePassClaimed: false };
  return api.collect();
}
