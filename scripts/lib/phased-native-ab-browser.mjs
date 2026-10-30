/** Browser-side functional A/B driver. It calls the actual registered native
 * callbacks, uses the production export owner, and independently observes their
 * actual digest/receipt wire. It never changes a game object or fabricates a
 * native result. Dependencies are bundled from the recorded source files. */
export function createPhasedNativeAbBrowser({ target, api, side, NativeSnapshotExports,
  createReceiptObserver, afterPaint, now = () => performance.now(), maxObservations = 4000 }) {
  if (!['baseline', 'candidate'].includes(side)) throw new Error('Unknown phased A/B side');
  const owner = new NativeSnapshotExports(target, 'phased_ab_' + side);
  const witness = createReceiptObserver({ cloneCapture: true, maxObservations });
  const producer = target.boxheadDigestOriginalState;
  let busy = false, completed = null, failure = null;
  if (typeof producer !== 'function' || typeof afterPaint !== 'function') throw new Error('Missing actual phased A/B collaborators');
  target.boxheadDigestOriginalState = function (...args) {
    if (args[1] === undefined) return Reflect.apply(producer, this, args);
    witness.beforeDigest(args[0], args[1]);
    const result = Reflect.apply(producer, this, args);
    witness.afterDigest(result);
    return result;
  };
  function request(name, args) {
    if (name === 'bhStep' || name === 'bhStepBegin' || name === 'bhFrameBegin') {
      const joinArgument = args[3] === undefined ? 'undefined' : args[3] === null ? 'null' : 'player';
      return { arity: args.length, tick: args[0], p1: args[1], p2: args[2], joinArgument,
        ...(joinArgument === 'player' ? { join: { ...args[3] } } : {}), receiptToken: args[4] };
    }
    return { arity: args.length, receiptToken: args[0], epoch: args[1], tick: args[2] };
  }
  function call(name, ...args) {
    if (failure) throw new Error('Phased A/B owner is closed after failure: ' + failure.error);
    const pending = witness.pending();
    if (pending) witness.expectCall(name);
    const at = now();
    const raw = owner.invoke(name, args, () => Reflect.apply(api.callExternalInterface, api, [name, ...args]));
    const ms = now() - at;
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (pending) {
      if (['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhFrameBegin'].includes(name))
        witness.phase(name, request(name, args), value, at, ms);
      else if (name === 'bhStep' || name === 'bhStepCommit' || name === 'bhFrameCommit')
        witness.completeStep('actual-' + name, value, request(name, args), at, ms);
      else if (name === 'bhInfo') witness.info(value, at, ms);
      else if (name === 'bhStateReceipt') {
        const observation = witness.consume(value, at, ms);
        const actual = owner.consumeReceipt(raw);
        witness.equalData(observation.snapshot, { ...actual, entities: actual.native.entities },
          'Independent capture versus production receipt reconstruction');
        if (!Object.isFrozen(observation.argument)) throw new Error('Actual digest argument was not frozen');
        completed = { state: actual, receipt: observation.wire, capturedGraphFrozen: true };
      }
    }
    return value;
  }
  async function command(input) {
    if (busy || witness.pending() || failure) throw new Error('Overlapping or failed phased A/B command');
    busy = true; completed = null;
    const staged = side === 'candidate' && input.tick > 0 && input.tick % 25 === 0;
    const compact = side === 'candidate' && input.tick > 0 && input.tick % 25 !== 0;
    const phased = staged || compact;
    const started = now(), presents = [], taskWaits = [];
    try {
      const token = staged ? owner.beginStagedStep(input.tick) : compact ? owner.beginCompactStep(input.tick) : owner.beginStep(input.tick);
      const name = staged ? 'bhStepBegin' : compact ? 'bhFrameBegin' : 'bhStep';
      const args = [input.tick, input.p1, input.p2, input.join, token];
      witness.begin({ source: 'actual-' + name, ...request(name, args) });
      let step;
      if (phased) {
        call(name, ...args);
        const key = compact ? owner.compactStepRequest() : owner.stagedStepRequest();
        if (!key || key.tick !== input.tick || key.token !== token) throw new Error('Actual Begin omitted its validated identity');
        for (const [index, alpha] of (compact ? [0.5] : [0.25, 0.5, 0.75]).entries()) {
          const present = call('bhPresent', alpha);
          if (!present || present.version !== 1 || present.enabled !== true || present.tick !== input.tick
            || present.alpha !== alpha || present.error !== undefined)
            throw new Error('Actual intermediate Present failed');
          presents.push(present);
          const waitAt = now(); await afterPaint(); taskWaits.push({ after: ['begun', 'prepared', 'projected'][index], at: waitAt, ms: now() - waitAt });
          if (!compact && index < 2) call(index === 0 ? 'bhStepPrepare' : 'bhStepProject', key.token, key.epoch, key.tick);
        }
        step = call(compact ? 'bhFrameCommit' : 'bhStepCommit', key.token, key.epoch, key.tick);
      } else step = call(name, ...args);
      // No await is allowed from the final Step/Commit through its actual
      // Info and one-shot native Receipt. Only that receipt reconstructs state.
      const info = call('bhInfo');
      const key = owner.receiptRequest();
      call('bhStateReceipt', key.token, key.epoch, key.tick);
      if (!completed || witness.pending() || owner.expectsReceipt()) throw new Error('Actual phased A/B receipt was not consumed');
      const result = { step, info, ...completed, presents, taskWaits, milliseconds: now() - started,
        staged, compact, source: staged ? 'actual-bhStepCommit' : compact ? 'actual-bhFrameCommit' : 'actual-bhStep' };
      completed = null; return result;
    } catch (error) {
      failure = { error: String(error?.stack ?? error), staged, compact, tick: input.tick };
      if (phased) {
        try {
          const cleanup = key => Reflect.apply(api.callExternalInterface, api,
            [compact ? 'bhFrameAbort' : 'bhStepAbort', key.token, key.epoch, key.tick]);
          if (compact) owner.abortCompactStep(cleanup); else owner.abortStagedStep(cleanup);
        } catch (cleanupError) { failure.cleanupError = String(cleanupError); }
      } else owner.cancel();
      throw error;
    } finally { busy = false; }
  }
  return { call, command, proof: () => ({ ...witness.counts(), busy, failure }),
    dispose: () => owner.dispose() };
}
