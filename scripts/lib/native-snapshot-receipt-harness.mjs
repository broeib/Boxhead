import { createNativeSnapshotReceiptObserver } from './native-snapshot-receipt-observer.mjs';

/** Browser adapter around the real production controller and raw EI boundary.
 * A disabled receipt side still uses production readState/invoke in a fair
 * receipt experiment. The runner's default legacy path does not install this.
 */
export function installNativeReceiptHarness(target, checks, controller, readState, rawCall,
  { enabled, qualification }) {
  const witness = enabled ? createNativeSnapshotReceiptObserver({ cloneCapture: qualification }) : null;
  let observationError = null, observation = null, awaitingLegacy = null, observedLegacy = null;
  let lastStepTick = 0, bareLegacyAfterSteps = 0, qualified = 0;
  const fail = message => { observationError ??= message; throw new Error('Receipt harness: ' + observationError); };
  const rememberError = error => { observationError ??= String(error?.stack ?? error); };
  const checkHealthy = () => {
    if (observationError) fail(observationError);
    const evidence = witness?.counts();
    if (evidence?.failed) fail(evidence.error);
  };
  checks.readState = readState;

  if (enabled) {
    const producer = target.boxheadDigestOriginalState;
    if (typeof producer !== 'function') fail('actual digest producer is missing');
    target.boxheadDigestOriginalState = function (...args) {
      const observing = witness.pending();
      // An observer error is sticky, but must never skip, duplicate or replace
      // the actual digest producer. Fail the experiment after the native call.
      if (observing || args[1] !== undefined) {
        try { witness.beforeDigest(args[0], args[1]); } catch (error) { rememberError(error); }
      }
      const result = Reflect.apply(producer, this, args);
      if (observing || args[1] !== undefined) {
        try { witness.afterDigest(result); } catch (error) { rememberError(error); }
      }
      return result;
    };
  }

  checks.call = function (name, ...args) {
    checkHealthy();
    if (enabled && name === 'bhStep' && !witness.pending()) fail('receipt step was not explicitly opened');
    const result = controller.invoke(name, args, () => rawCall(name, ...args));
    if (enabled) {
      try {
        if (name === 'bhStep') { witness.step(result); lastStepTick = args[0]; }
        else if (witness.pending() && name === 'bhInfo') witness.info(result);
        else if (name === 'bhStateReceipt') observation = witness.consume(result);
        else if (name === 'bhState' && args.length === 0 && lastStepTick > 0) {
          bareLegacyAfterSteps++;
          if (!qualification || !awaitingLegacy || observedLegacy !== null)
            fail('unexpected extra bare legacy read');
          observedLegacy = result;
        }
      } catch (error) { rememberError(error); }
    }
    checkHealthy();
    return result;
  };
  checks.beginReceiptStep = function (tick) {
    checkHealthy();
    if (!enabled || observation || awaitingLegacy) fail('prior receipt proof is incomplete');
    const token = controller.beginStep(tick);
    witness.begin(token, tick);
    return token;
  };
  checks.receiptRequest = () => controller.receiptRequest();
  checks.finishReceipt = function (raw) {
    checkHealthy();
    if (!enabled || !observation) fail('actual native receipt was not observed');
    const observed = observation;
    const state = readState(controller.consumeReceipt(raw));
    if (state.native !== observed.argument || state.entities !== observed.argument.entities)
      fail('production reconstruction changed the actual digest graph identity');
    const stateHeader = Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'native' && key !== 'entities'));
    witness.equalData(stateHeader, observed.wire.receipt.header, 'controller/native receipt header');
    if (qualification) witness.equalData(state, observed.snapshot, 'controller/independent captured snapshot');
    const result = { state,
      proof: { ...observed.wire, controllerHeaderEqual: true, controllerSnapshotEqual: qualification ? true : null,
        qualificationExtraLegacyRead: false, legacyEqual: null, legacyComparisons: 0 },
      wire: { kind: 'receipt', requestedReceipt: true, nativeObject: true, nativeHasEntities: true,
        normalizedAlias: true, controllerGraphIsActualArgument: true,
        snapshotKeys: Object.keys(state).sort() } };
    observation = null;
    if (qualification) awaitingLegacy = result;
    return result;
  };
  checks.qualifyReceipt = function (result, legacy) {
    checkHealthy();
    if (!enabled || !qualification || awaitingLegacy !== result || observedLegacy !== legacy)
      fail('legacy equality must use this step\'s extra actual bare callback');
    const compared = witness.equalData(result.state, legacy, 'receipt/actual legacy snapshot');
    result.proof.qualificationExtraLegacyRead = true;
    result.proof.legacyEqual = true;
    result.proof.legacyComparisons = 1;
    result.proof.legacyComparison = compared;
    awaitingLegacy = null; observedLegacy = null; qualified++;
  };
  checks.receiptCounts = () => enabled ? { ...witness.counts(), bareLegacyAfterSteps, qualified,
    incompleteProof: observation !== null || awaitingLegacy !== null, observationError } : null;
}
