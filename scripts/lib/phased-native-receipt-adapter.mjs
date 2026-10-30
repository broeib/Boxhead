/** Passive v3 adapter for actual Step, full four-phase or compact two-phase calls.
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
          if (activeNativeCall !== null) evidence(() => { throw new Error('Nested observed native callback: ' + name); });
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
          if (receiptWitness.pending()) evidence(() => receiptWitness.expectCall(name));
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
          finally { activeReceiptCall = priorReceiptCall; activeNativeCall = priorNativeCall; }
          const ms = now() - at;
          let decoded = result;
          if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded); } catch {} }
          if (receiptWitness.pending()) {
            if (['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhFrameBegin'].includes(name))
              evidence(() => receiptWitness.phase(name, request(name, params), decoded, at, ms));
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
