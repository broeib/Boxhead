import { validateNativeProjectStats } from './native-project-evidence.mjs';

/** Passive measurement of the actual production Step/Info/readback path.
 * No native callback is added, and every original result/exception is retained.
 * The receipt adapter validates the real digest argument and native receipt;
 * this observer retains only timings and binding metadata, never a graph copy.
 * Self-contained for injection into an independent browser process.
 */
export function installNetworkPerformanceNativeObserver({ globalObject, player, observation,
  installReceiptAdapter, createReceiptObserver, expectReceipt, maxObservations = 120000, now }) {
  const o = observation;
  if (o.performanceNativeObserverInstalled) throw new Error('Performance observer already installed');
  o.performanceNativeObserverInstalled = true;
  o.readbacks = [];
  o.presentations = [];
  o.expectedReadbackSource = expectReceipt ? 'actual-bhStateReceipt' : 'actual-bhState';
  const fail = cause => {
    if (o.errors.length < 16) o.errors.push({ type: 'performance_native_observation', error: String(cause) });
  };
  installReceiptAdapter({ globalObject, player, observation: o, createReceiptObserver,
    expectReceipt, maxObservations, now,
    recordState(state, metadata) {
      if (state.tick <= 0) return;
      if (o.readbacks.length >= maxObservations) throw new Error('Performance readback evidence bound exceeded');
      const receipt = metadata.receipt;
      o.readbacks.push({ tick: state.tick, digest: state.digest, scope: state.scope, source: metadata.source,
        playerSlots: state.players.map(player => player.slot),
        ...(receipt ? { receiptBinding: {
          version: receipt.metadata.version, tick: receipt.metadata.tick, epoch: receipt.metadata.epoch,
          scope: receipt.metadata.scope, receiptToken: receipt.metadata.receiptToken,
          actualDigestArgument: receipt.actualDigestArgument, actualNativeReceipt: receipt.actualNativeReceipt,
          noTransferredGraphInReceipt: receipt.noTransferredGraphInReceipt,
          captureCount: receipt.captureCount, replyCount: receipt.replyCount,
          nativeArgumentIdentity: receipt.nativeArgumentIdentity, cloneBeforeProducer: receipt.cloneBeforeProducer,
          capturedGraphFrozen: receipt.capturedGraphFrozen,
        } } : {}),
      });
    },
  });
  const ruffle = player.ruffle;
  player.ruffle = function (...args) {
    const api = Reflect.apply(ruffle, this, args);
    return new Proxy(api, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== 'callExternalInterface') return typeof value === 'function' ? value.bind(target) : value;
        return function (name, ...params) {
          const at = now();
          // Do not catch or retry an original callback exception.
          const result = Reflect.apply(value, target, [name, ...params]);
          const ms = now() - at;
          try {
            let decoded = result;
            if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded); } catch {} }
            if (name === 'bhPresent') {
              if (o.presentations.length >= maxObservations * 8) throw new Error('Presentation evidence bound exceeded');
              o.presentations.push({ at, ms, version: decoded?.version, enabled: decoded?.enabled,
                rendered: decoded?.rendered, tick: decoded?.tick, alpha: decoded?.alpha,
                commands: decoded?.commands, interpolated: decoded?.interpolated,
                totalFrames: decoded?.totalFrames, ...(decoded?.error ? { error: decoded.error } : {}) });
            }
            if (['bhStep', 'bhState', 'bhStateReceipt', 'bhInfo'].includes(name)
              && (o.tick > 0 || name === 'bhStep')) {
              if (o.callbacks.length >= maxObservations * 4) throw new Error('Performance callback evidence bound exceeded');
              const header = name === 'bhStateReceipt' ? decoded?.header : decoded;
              o.callbacks.push({ name, at, ms, tick: decoded?.tick, digest: header?.digest,
                profile: header?.profile, snapshotBytes: header?.snapshotBytes,
                snapshotObjects: header?.snapshotObjects, snapshotFields: header?.snapshotFields,
                // Retain an already-returned native capability/counter witness.
                // This adds no query and is outside the hashed game graph.
                ...(header?.nativeProjectionScan ? { nativeProjectionScan: { ...header.nativeProjectionScan } } : {}),
                ...(header?.nativeProject ? { nativeProject: { ...header.nativeProject } } : {}),
                ...(Array.isArray(header?.players) ? { playerSlots: header.players.map(player => player.slot),
                  ...(name === 'bhStep' ? { players: header.players.map(player => ({ ...player })) } : {}) } : {}),
              });
            }
          } catch (cause) { fail(cause); }
          return result;
        };
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
  };
  const digest = globalObject.boxheadDigestOriginalState;
  globalObject.boxheadDigestOriginalState = function (...args) {
    const at = now();
    const result = Reflect.apply(digest, this, args);
    try {
      if (o.tick > 0) {
        if (o.digestCalls.length >= maxObservations) throw new Error('Performance digest evidence bound exceeded');
        o.digestCalls.push({ at, ms: now() - at, bytes: result.bytes,
          tick: Number.isSafeInteger(args[0]?.tick) ? args[0].tick : o.tick + 1 });
      }
    } catch (cause) { fail(cause); }
    return result;
  };
}

/** Validate the measured readbacks independently of the production bridge.
 * All counted states must be real observed native callbacks for the exact ACK.
 */
export function validatePerformanceNativeWindow(observation, firstTick, lastTick, { expectNativeProject = false } = {}) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  require(Number.isSafeInteger(firstTick) && Number.isSafeInteger(lastTick)
    && firstTick >= 1 && lastTick >= firstTick, 'Invalid native measurement bounds');
  const within = row => row.tick >= firstTick && row.tick <= lastTick;
  const steps = observation.callbacks.filter(row => row.name === 'bhStep' && within(row));
  const readbacks = observation.readbacks.filter(within);
  const acknowledgements = observation.acks.filter(within);
  const count = lastTick - firstTick + 1;
  require(steps.length === count && readbacks.length === count && acknowledgements.length === count,
    'Native Step/readback/ACK coverage is incomplete or duplicated');
  const receipt = observation.expectedReadbackSource === 'actual-bhStateReceipt';
  require(receipt || observation.expectedReadbackSource === 'actual-bhState', 'Unknown native readback contract');
  let lastEpoch = 0;
  const tokens = new Set();
  for (let index = 0; index < count; index++) {
    const tick = firstTick + index, step = steps[index], state = readbacks[index], ack = acknowledgements[index];
    require(step.tick === tick && state.tick === tick && ack.tick === tick, 'Native measurement ticks are not contiguous');
    require(state.source === observation.expectedReadbackSource, 'Native readback mode changed during measurement');
    require(typeof state.digest === 'string' && /^native-v2-[a-f0-9]{16}$/.test(state.digest)
      && step.digest === state.digest && ack.digest === state.digest, 'Observed native Step/readback/ACK digests differ');
    require(state.scope === (tick % 25 === 0 ? 'full' : 'frame'), 'Native readback checkpoint cadence differs');
    if (!receipt) { require(!state.receiptBinding, 'Legacy readback unexpectedly contains a receipt'); continue; }
    const binding = state.receiptBinding;
    require(binding && binding.version === 1 && binding.tick === tick && binding.scope === state.scope
      && Number.isSafeInteger(binding.epoch) && binding.epoch > lastEpoch,
    'Native receipt tick/epoch/scope binding differs');
    require(typeof binding.receiptToken === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(binding.receiptToken)
      && !tokens.has(binding.receiptToken), 'Native receipt token is missing or repeated');
    for (const key of ['actualDigestArgument', 'actualNativeReceipt', 'noTransferredGraphInReceipt',
      'nativeArgumentIdentity', 'capturedGraphFrozen']) require(binding[key] === true, 'Unproven native receipt field: ' + key);
    require(binding.captureCount === 1 && binding.replyCount === 1 && binding.cloneBeforeProducer === false,
      'Native receipt observation has duplicate work or a graph clone');
    tokens.add(binding.receiptToken); lastEpoch = binding.epoch;
  }
  return { observedSteps: count, observedReadbacks: count, observedAcks: count,
    source: observation.expectedReadbackSource, receiptBindings: receipt ? count : 0,
    extraNativeCalls: 0, graphClones: 0,
    ...(expectNativeProject ? { nativeProject: validatePerformanceNativeProjectWindow(observation, firstTick, lastTick) } : {}) };
}

/** No additional VM query: bind the capability already returned by each live
 * Info read to the unchanged full-check cadence. Warmup supplies the preceding
 * witness, so even a full graph on the first measured tick must advance. */
export function validatePerformanceNativeProjectWindow(observation, firstTick, lastTick) {
  const infos = observation.callbacks.filter(row => row.name === 'bhInfo');
  let previous = infos.filter(row => row.tick < firstTick && row.nativeProject).at(-1)?.nativeProject;
  if (!previous) throw new Error('Missing native project witness before measurement');
  validateNativeProjectStats(previous);
  const first = { ...previous }, measured = infos.filter(row => row.tick >= firstTick && row.tick <= lastTick);
  if (measured.length !== lastTick - firstTick + 1) throw new Error('Missing or duplicate live native project Info witness');
  let fullCaptures = 0;
  for (const [index, row] of measured.entries()) {
    const tick = firstTick + index, full = tick % 25 === 0;
    if (row.tick !== tick) throw new Error('Native project Info ticks are not contiguous');
    const current = validateNativeProjectStats(row.nativeProject, previous, { advanced: full });
    if (current.calls !== previous.calls + (full ? 1 : 0))
      throw new Error('Native full projection cadence changed inside measurement');
    if (full) fullCaptures++;
    previous = current;
  }
  return { samples: measured.length, fullCaptures, first, last: previous, unsupported: 0, extraNativeCalls: 0 };
}
