/** Smoke-only successor of the frozen passive v3 receipt adapter.
 * One exact pending cancellation may be observed after this harness has sealed
 * its immutable gameplay proof and requested closure of its owned room socket.
 * This never creates an Abort, receipt, native fallback or ACK. The frozen
 * receipt witness and every ordinary phase continue to use their old checks.
 *
 * Passive v3 adapter for actual Step, full four-phase or compact two-phase calls.
 * The original callback is forwarded exactly once with its receiver/arguments;
 * its result and exception are returned unchanged. Instrumentation never calls
 * a native fallback, creates an ACK, or manufactures a bhStep observation.
 * Self-contained for injection with its independently versioned observer.
 */
export function installPhasedNativeReceiptAdapter({ globalObject, player, observation, recordState,
  createReceiptObserver, expectReceipt, maxObservations, now }) {
  const o = observation, original = player.ruffle, instance = 1;
  const receiptWitness = createReceiptObserver({ cloneCapture: false, maxObservations });
  const receiptInfoFields = ['version', 'engine', 'state', 'tick', 'digestSchema', 'snapshotReceiptVersion',
    'stagedStepVersion', 'compactStepVersion', 'error', 'complete'];
  let activeReceiptCall = null, activeNativeCall = null, wrappedDigest = null;
  let receiptStepRequest = null, receiptInfoEvidence = null;
  let begunLease = null, shutdownAbort = null, callsAfterAbort = 0;
  const shutdownWaiters = [];
  if (o.phasedNativeReceiptAdapterInstalled || o.stagedNativeReceiptAdapterInstalled)
    throw new Error('Phased native observer was installed twice or on the frozen v2 adapter');
  o.phasedNativeReceiptAdapterInstalled = true;
  o.nativeReceiptPending = false; o.stagedPending = false; o.stagedStatus = null;

  function evidence(action) {
    if (o.receiptObservationFailed) return undefined;
    try { return action(); }
    catch (cause) {
      if (!o.receiptObservationFailed) {
        o.receiptObservationFailed = true;
        if (o.errors.length < 16) o.errors.push({ type: 'phased_native_receipt_observation', error: String(cause) });
      }
      return undefined;
    }
  }
  function status() {
    o.nativeReceiptPending = receiptWitness.pending();
    o.stagedPending = receiptWitness.pendingStaged();
    o.stagedStatus = receiptWitness.status();
    if (!receiptWitness.pending() || shutdownAbort?.valid || o.receiptObservationFailed) {
      for (const resolve of shutdownWaiters.splice(0)) resolve(readShutdown());
    }
  }
  function readShutdown() {
    const counts = receiptWitness.counts();
    return { version: 1, observedAt: now(), pending: counts.pending, failed: o.receiptObservationFailed === true || counts.failed,
      consumed: counts.consumed, readbacks: o.readbacks?.length ?? 0, callsAfterAbort,
      playerDisconnected: player.isConnected === false,
      aborts: shutdownAbort ? [{ ...shutdownAbort, begin: { ...shutdownAbort.begin,
        witness: { ...shutdownAbort.begin.witness } }, result: shutdownAbort.result ? { ...shutdownAbort.result } : null }] : [] };
  }
  Object.defineProperties(o, {
    readDefaultSmokeShutdown: { value: readShutdown },
    awaitDefaultSmokeShutdown: { value: () => {
      if (!receiptWitness.pending() || shutdownAbort?.valid || o.receiptObservationFailed) return Promise.resolve(readShutdown());
      if (shutdownWaiters.length >= 2) throw new Error('Shutdown observer waiter bound');
      return new Promise(resolve => shutdownWaiters.push(resolve));
    } },
  });
  function admitShutdownAbort(name, params, at) {
    if (activeNativeCall !== null || activeReceiptCall !== null || shutdownAbort || o.receiptObservationFailed)
      throw new Error('Nested, duplicate or failed shutdown abort observation');
    const pending = receiptWitness.status(), closed = o.readSocketCleanup?.(), capture = closed?.gameplayWindow;
    const compact = name === 'bhFrameAbort', family = compact ? 'compact' : 'full';
    if (!pending?.staged || pending.execution !== (compact ? 'staged-frame' : 'staged-full')
      || !(compact ? ['bhFrameCommit'] : ['bhStepPrepare', 'bhStepProject', 'bhStepCommit']).includes(pending.phase)
      || !begunLease || begunLease.family !== family || begunLease.tick !== pending.tick
      || params.length !== 3 || params[0] !== begunLease.token || params[1] !== begunLease.epoch || params[2] !== begunLease.tick)
      throw new Error('Shutdown abort does not match the still-pending validated Begin');
    if (!capture || capture.lastTick >= pending.tick || !Number.isFinite(capture.capturedAt)
      || !Number.isFinite(closed.armedAt) || capture.capturedAt > closed.armedAt
      || !Number.isFinite(closed.closeRequestedAt) || closed.closeRequestedAt < closed.armedAt || at < closed.closeRequestedAt
      || !['closing', 'closed'].includes(closed.phase) || closed.observerErrors.length !== 0
      || closed.sockets.length !== 1 || closed.sockets[0].owned !== true || closed.sockets[0].closeCalls !== 1
      || closed.lastAck?.tick !== pending.tick - 1)
      throw new Error('Shutdown abort lacks immutable gameplay and an actual owned close request');
    const counts = receiptWitness.counts();
    shutdownAbort = { name, family, token: begunLease.token, epoch: begunLease.epoch, tick: begunLease.tick,
      at, ms: null, arity: params.length, begin: { ...begunLease.begin }, ackCount: closed.ackCount,
      consumed: counts.consumed, readbacks: o.readbacks?.length ?? 0, valid: false, threw: false, result: null };
    o.defaultSmokeShutdownAbortStarted = true;
    return shutdownAbort;
  }
  function finishShutdownAbort(row, result, ms) {
    row.ms = ms;
    if (typeof result === 'string' && result.length > 16384) throw new Error('Shutdown result size bound');
    const decoded = typeof result === 'string' ? JSON.parse(result) : result;
    // Callback::complete rejects the poisoned transaction and returns native
    // failure(context), replacing the unobservable AS2 six-field reply.
    const names = ['engine', 'error', 'state', 'version'];
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || Object.getOwnPropertySymbols(decoded).length || Object.getOwnPropertyNames(decoded).sort().join(',') !== names.join(','))
      throw new Error('Shutdown abort lacks its exact original error envelope');
    const saved = {};
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(decoded, name);
      if (!property || !Object.hasOwn(property, 'value') || !['string', 'number'].includes(typeof property.value))
        throw new Error('Shutdown abort envelope must contain only primitive own data');
      saved[name] = property.value;
    }
    row.result = saved;
    if (saved.version !== 1 || saved.engine !== 'original-swf' || saved.state !== 'error'
      || saved.error !== 'native staged tick fence: authenticated staged tick abort')
      throw new Error('Shutdown abort returned a failure or a rebound error envelope');
    if (receiptWitness.counts().consumed !== row.consumed || (o.readbacks?.length ?? 0) !== row.readbacks)
      throw new Error('Shutdown cancellation was incorrectly counted as a receipt');
    row.valid = true;
  }
  function ensureDigestObservation() {
    if (globalObject.boxheadDigestOriginalState === wrappedDigest && wrappedDigest !== null) return;
    const producer = globalObject.boxheadDigestOriginalState;
    if (typeof producer !== 'function') throw new Error('Actual native digest producer is unavailable');
    wrappedDigest = function (...args) {
      const owner = activeReceiptCall;
      if (owner) evidence(() => owner.beforeDigest(args[0], args[1]));
      else if (args[1] !== undefined) evidence(() => { throw new Error('Receipt digest is outside actual Step or Commit'); });
      const result = Reflect.apply(producer, this, args);
      if (owner) evidence(() => owner.afterDigest(result));
      return result;
    };
    globalObject.boxheadDigestOriginalState = wrappedDigest;
  }
  function command(name, params) {
    const rawJoin = params[3];
    const joinArgument = rawJoin === undefined ? 'undefined' : rawJoin === null ? 'null' : 'player';
    const result = { source: 'actual-' + name, arity: params.length, tick: params[0], p1: params[1], p2: params[2],
      joinArgument, receiptToken: params[4] };
    if (joinArgument === 'player') {
      if (!rawJoin || typeof rawJoin !== 'object' || Array.isArray(rawJoin)) throw new Error('Actual join is not native command data');
      result.join = {};
      for (const key of Object.getOwnPropertyNames(rawJoin)) {
        const property = Object.getOwnPropertyDescriptor(rawJoin, key);
        if (!Object.hasOwn(property, 'value')) throw new Error('Actual join contains an accessor');
        Object.defineProperty(result.join, key, { enumerable: true, value: property.value });
      }
      if (Object.getOwnPropertySymbols(rawJoin).length) throw new Error('Actual join contains symbol fields');
    }
    return result;
  }
  function request(name, params) {
    if (name === 'bhStep' || name === 'bhStepBegin' || name === 'bhFrameBegin') {
      const { source, ...value } = command(name, params);
      return value;
    }
    return { arity: params.length, receiptToken: params[0], epoch: params[1], tick: params[2] };
  }
  function encodeMetadata(value) {
    // Native leases are not room credentials. Preserve their actual value
    // through the unchanged campaign secret redactor's token-key rule.
    const { token, ...rest } = value;
    return { ...rest, receiptToken: token };
  }
  function encodeReceipt(wire, at, ms, params, argument) {
    return { ...wire, schema: 'original-phased-native-receipt-observation-v3',
      tokenEncoding: 'native-token-key-to-receiptToken-v1',
      metadata: encodeMetadata(wire.metadata),
      digestReply: { ...wire.digestReply, receipt: encodeMetadata(wire.digestReply.receipt) },
      receipt: encodeMetadata(wire.receipt), tick: wire.metadata.tick, instance, at, ms,
      stepRequest: receiptStepRequest, info: receiptInfoEvidence,
      receiptRequest: { receiptToken: params[0], epoch: params[1], tick: params[2] },
      capturedGraphFrozen: Object.isFrozen(argument) };
  }

  player.ruffle = function (...args) {
    const api = Reflect.apply(original, this, args);
    return new Proxy(api, {
      get(target, key) {
        const method = Reflect.get(target, key, target);
        if (key !== 'callExternalInterface') return typeof method === 'function' ? method.bind(target) : method;
        return function (name, ...params) {
          const priorReceiptCall = activeReceiptCall, priorNativeCall = activeNativeCall;
          if (shutdownAbort) {
            callsAfterAbort++;
            evidence(() => { throw new Error('Native call after observed shutdown abort: ' + name); });
          }
          if (activeNativeCall !== null) evidence(() => { throw new Error('Nested observed native callback: ' + name); });
          const abortAt = name === 'bhFrameAbort' || name === 'bhStepAbort' ? now() : null;
          const observedAbort = abortAt === null ? null : evidence(() => admitShutdownAbort(name, params, abortAt));
          if (name === 'bhStep' || name === 'bhStepBegin' || name === 'bhFrameBegin') {
            if (params.length === 5 && typeof params[4] === 'string') {
              receiptStepRequest = { tick: params[0], receiptToken: params[4] };
              receiptInfoEvidence = null;
              evidence(() => {
                ensureDigestObservation();
                receiptWitness.begin(command(name, params));
              });
            } else if (expectReceipt) evidence(() => { throw new Error('Expected native command did not request a snapshot receipt'); });
          }
          if (receiptWitness.pending() && !observedAbort) evidence(() => receiptWitness.expectCall(name));
          else if (['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhFrameBegin', 'bhFrameCommit'].includes(name))
            evidence(() => { throw new Error('Actual phase has no matching begun native receipt transaction'); });
          if (name === 'bhStep' || name === 'bhStepCommit' || name === 'bhFrameCommit') {
            if (receiptWitness.pending()) activeReceiptCall = receiptWitness;
          }
          status();
          activeNativeCall = name;
          const at = now();
          let result;
          try { result = Reflect.apply(method, target, [name, ...params]); }
          catch (exception) {
            if (observedAbort) {
              observedAbort.threw = true; observedAbort.ms = now() - abortAt;
              evidence(() => { throw new Error('Original shutdown abort threw'); });
              status();
            }
            throw exception;
          }
          finally { activeReceiptCall = priorReceiptCall; activeNativeCall = priorNativeCall; }
          const ms = now() - at;
          if (observedAbort) {
            evidence(() => finishShutdownAbort(observedAbort, result, now() - abortAt));
            status();
            return result;
          }
          let decoded = result;
          if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded); } catch {} }
          if (receiptWitness.pending()) {
            if (['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhFrameBegin'].includes(name))
              evidence(() => {
                receiptWitness.phase(name, request(name, params), decoded, at, ms);
                if (name === 'bhStepBegin' || name === 'bhFrameBegin') begunLease = {
                  family: name === 'bhFrameBegin' ? 'compact' : 'full', token: decoded.token, epoch: decoded.epoch, tick: decoded.tick,
                  begin: { name, at, ms, witness: { version: decoded.version, phase: decoded.phase,
                    token: decoded.token, epoch: decoded.epoch, tick: decoded.tick } },
                };
              });
            else if (name === 'bhStep' || name === 'bhStepCommit' || name === 'bhFrameCommit')
              evidence(() => receiptWitness.completeStep('actual-' + name, decoded, request(name, params), at, ms));
            else if (name === 'bhInfo') evidence(() => {
              const selected = {};
              for (const field of receiptInfoFields) {
                const property = Object.getOwnPropertyDescriptor(decoded, field);
                if (property) {
                  if (!Object.hasOwn(property, 'value')) throw new Error('Actual Info contains an accessor');
                  selected[field] = property.value;
                }
              }
              receiptInfoEvidence = { source: 'actual-bhInfo', instance, at, ms, value: selected };
              receiptWitness.info(decoded, at, ms);
            });
          }
          let actualState = name === 'bhState' ? decoded : null, receiptEvidence = null;
          if (name === 'bhStateReceipt') {
            const actualReceipt = evidence(() => {
              if (params.length !== 3) throw new Error('Actual native receipt request has an unexpected argument count');
              const observed = receiptWitness.consume(decoded, at, ms), metadata = observed.wire.metadata;
              if (params[0] !== metadata.token || params[1] !== metadata.epoch || params[2] !== metadata.tick)
                throw new Error('Actual native receipt request differs from its export');
              if (!Object.isFrozen(observed.argument)) throw new Error('Actual captured native graph is not frozen');
              return observed;
            });
            if (actualReceipt) {
              actualState = actualReceipt.snapshot;
              receiptEvidence = encodeReceipt(actualReceipt.wire, at, ms, params, actualReceipt.argument);
              receiptStepRequest = null; receiptInfoEvidence = null;
              begunLease = null;
            }
          }
          try {
            if ((name === 'bhStep' || name === 'bhStepCommit' || name === 'bhFrameCommit') && decoded?.digest)
              o.lastStep = { source: 'actual-' + name, tick: decoded.tick, digest: decoded.digest,
                players: decoded.players, worldTick: decoded.worldTick, rng: decoded.rng, complete: decoded.complete,
                profile: decoded.profile, ms, at,
                snapshotBytes: decoded.snapshotBytes, snapshotObjects: decoded.snapshotObjects,
                snapshotFields: decoded.snapshotFields, nativeInstance: instance, error: decoded.error };
            if (actualState?.native) {
              if (actualState.tick > 0 && (expectReceipt || receiptWitness.pending()) && !receiptEvidence)
                throw new Error('Expected actual receipt readback was replaced by legacy bhState');
              recordState(actualState, { source: name === 'bhStateReceipt' ? 'actual-bhStateReceipt' : 'actual-bhState',
                ...(receiptEvidence ? { receipt: receiptEvidence } : {}) });
            }
          } catch (cause) {
            if (o.errors.length < 16) o.errors.push({ type: 'phased_native_evidence', tick: decoded?.tick, error: String(cause) });
          }
          status();
          return result;
        };
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
  };
}
