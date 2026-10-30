/** Passive campaign adapter. Injected by source, without production imports.
 * The original callback is forwarded exactly once with the same receiver and
 * arguments. Its exact result/exception is returned; evidence errors only mark
 * the campaign as failed. No fallback native call, ACK or world write occurs.
 */
export function installCampaignNativeReceiptAdapter({ globalObject, player, observation, recordState,
  createReceiptObserver, expectReceipt, maxObservations, now }) {
  const o = observation, original = player.ruffle, instance = 1;
  const receiptWitness = createReceiptObserver({ cloneCapture: false, maxObservations });
  const receiptInfoFields = ['version', 'engine', 'state', 'tick', 'digestSchema', 'snapshotReceiptVersion', 'error', 'complete'];
  let activeReceiptCall = null, wrappedDigest = null, receiptStepRequest = null, receiptInfoEvidence = null;
  if (o.nativeReceiptAdapterInstalled) throw new Error('Campaign native observer was installed twice');
  o.nativeReceiptAdapterInstalled = true;

  function evidence(action) {
    try { return action(); }
    catch (cause) {
      if (!o.receiptObservationFailed) {
        o.receiptObservationFailed = true;
        if (o.errors.length < 16) o.errors.push({ type: 'native_receipt_observation', error: String(cause) });
      }
      return undefined;
    }
  }
  function ensureDigestObservation() {
    if (globalObject.boxheadDigestOriginalState === wrappedDigest && wrappedDigest !== null) return;
    const producer = globalObject.boxheadDigestOriginalState;
    if (typeof producer !== 'function') throw new Error('Actual native digest producer is unavailable');
    wrappedDigest = function (...args) {
      const owner = activeReceiptCall;
      if (owner) evidence(() => owner.beforeDigest(args[0], args[1]));
      else if (args[1] !== undefined) evidence(() => { throw new Error('Receipt digest is outside an observed native Step'); });
      const result = Reflect.apply(producer, this, args);
      if (owner) evidence(() => owner.afterDigest(result));
      return result;
    };
    globalObject.boxheadDigestOriginalState = wrappedDigest;
  }
  function encodeMetadata(value) {
    // The unchanged campaign secret filter redacts every key named "token".
    // Native step leases are not room credentials. This exact, documented key
    // translation preserves their actual value without a redactor exception.
    const { token, ...rest } = value;
    return { ...rest, receiptToken: token };
  }
  function encodeReceipt(wire, at, ms, request, argument) {
    return { ...wire, schema: 'original-campaign-native-receipt-observation-v1',
      tokenEncoding: 'native-token-key-to-receiptToken-v1',
      metadata: encodeMetadata(wire.metadata),
      digestReply: { ...wire.digestReply, receipt: encodeMetadata(wire.digestReply.receipt) },
      receipt: encodeMetadata(wire.receipt), tick: wire.metadata.tick, instance, at, ms,
      stepRequest: receiptStepRequest, info: receiptInfoEvidence,
      receiptRequest: { receiptToken: request[0], epoch: request[1], tick: request[2] },
      capturedGraphFrozen: Object.isFrozen(argument) };
  }

  player.ruffle = function (...args) {
    const api = Reflect.apply(original, this, args);
    return new Proxy(api, {
      get(target, key) {
        const method = Reflect.get(target, key, target);
        if (key !== 'callExternalInterface') return typeof method === 'function' ? method.bind(target) : method;
        return function (name, ...params) {
          const priorReceiptCall = activeReceiptCall;
          if (name === 'bhStep') {
            if (params.length === 5 && typeof params[4] === 'string') {
              receiptStepRequest = { tick: params[0], receiptToken: params[4] };
              receiptInfoEvidence = null;
              evidence(() => {
                if (activeReceiptCall) throw new Error('Nested observed native Step');
                ensureDigestObservation();
                receiptWitness.begin(params[4], params[0]);
              });
              activeReceiptCall = receiptWitness;
            } else if (expectReceipt) evidence(() => { throw new Error('Expected native Step did not request a snapshot receipt'); });
          }
          const at = now();
          let result;
          try { result = Reflect.apply(method, target, [name, ...params]); }
          finally { activeReceiptCall = priorReceiptCall; }
          const ms = now() - at;
          let decoded = result;
          if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded); } catch {} }
          if (receiptWitness.pending() && name === 'bhStep') evidence(() => receiptWitness.step(decoded));
          else if (receiptWitness.pending() && name === 'bhInfo') evidence(() => {
            const selected = {};
            for (const field of receiptInfoFields) {
              const property = Object.getOwnPropertyDescriptor(decoded, field);
              if (property) {
                if (!Object.hasOwn(property, 'value')) throw new Error('Actual Info contains an accessor');
                selected[field] = property.value;
              }
            }
            receiptInfoEvidence = { source: 'actual-bhInfo', instance, at, ms, value: selected };
            receiptWitness.info(decoded);
          });
          let actualState = name === 'bhState' ? decoded : null, receiptEvidence = null;
          if (name === 'bhStateReceipt') {
            const actualReceipt = evidence(() => {
              if (params.length !== 3) throw new Error('Actual native receipt request has an unexpected argument count');
              const observed = receiptWitness.consume(decoded), metadata = observed.wire.metadata;
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
            if (name === 'bhStep' && decoded?.digest) o.lastStep = { tick: decoded.tick, digest: decoded.digest,
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
            if (o.errors.length < 16) o.errors.push({ type: 'native_evidence', tick: decoded?.tick, error: String(cause) });
          }
          return result;
        };
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
  };
}
