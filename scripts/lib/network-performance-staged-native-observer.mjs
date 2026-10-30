import { validateNativeProjectStats } from './native-project-evidence.mjs';

/** Passive v2 measurement of actual Step or four-stage Commit/Info/receipt calls.
 * No native callback is added, and every original result/exception is retained.
 * The receipt adapter validates the real digest argument and native receipt;
 * this observer retains only timings and binding metadata, never a graph copy.
 * Self-contained for injection into an independent browser process.
 */
export function installNetworkPerformanceStagedNativeObserver({ globalObject, player, observation,
  installReceiptAdapter, createReceiptObserver, recordPresentationCall, expectReceipt, maxObservations = 120000, now }) {
  const o = observation;
  if (typeof recordPresentationCall !== 'function') throw new Error('Actual presentation recorder is required');
  if (o.performanceStagedNativeObserverInstalled) throw new Error('Performance observer already installed');
  o.performanceStagedNativeObserverInstalled = true;
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
        at: now(), playerSlots: state.players.map(player => player.slot),
        ...(receipt ? { receiptObservation: receipt, finalCallback: o.lastStep } : {}),
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
          let result;
          try { result = Reflect.apply(value, target, [name, ...params]); }
          catch (exception) {
            // Preserve the original thrown value and receiver. The one
            // existing callback boundary also records failed presentations;
            // no second wrapper, native query, retry or clock is introduced.
            if (name === 'bhPresent') try {
              const ms = now() - at;
              if (o.presentations.length >= maxObservations * 8) throw new Error('Presentation evidence bound exceeded');
              o.presentations.push(recordPresentationCall({ at, ms, arity: params.length,
                requestedAlpha: params[0], threw: true, exception }));
            } catch (cause) { fail(cause); }
            throw exception;
          }
          const ms = now() - at;
          try {
            let decoded = result;
            if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded); } catch {} }
            if (name === 'bhPresent') {
              if (o.presentations.length >= maxObservations * 8) throw new Error('Presentation evidence bound exceeded');
              o.presentations.push(recordPresentationCall({ at, ms, arity: params.length,
                requestedAlpha: params[0], result }));
            }
            if (['bhStep', 'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhState', 'bhStateReceipt', 'bhInfo'].includes(name)
              && (o.tick > 0 || name === 'bhStep' || name === 'bhStepBegin')) {
              if (o.callbacks.length >= maxObservations * 8) throw new Error('Performance callback evidence bound exceeded');
              const header = name === 'bhStateReceipt' ? decoded?.header : decoded;
              o.callbacks.push({ name, source: 'actual-' + name, at, ms, tick: decoded?.tick, digest: header?.digest,
                ...(name === 'bhInfo' ? { stagedStepVersion: decoded?.stagedStepVersion } : {}),
                profile: header?.profile, snapshotBytes: header?.snapshotBytes,
                snapshotObjects: header?.snapshotObjects, snapshotFields: header?.snapshotFields,
                // Retain an already-returned native capability/counter witness.
                // This adds no query and is outside the hashed game graph.
                ...(header?.nativeProjectionScan ? { nativeProjectionScan: { ...header.nativeProjectionScan } } : {}),
                ...(header?.nativeProject ? { nativeProject: { ...header.nativeProject } } : {}),
                ...(Array.isArray(header?.players) ? { playerSlots: header.players.map(player => player.slot),
                  ...((name === 'bhStep' || name === 'bhStepCommit') ? { players: header.players.map(player => ({ ...player })) } : {}) } : {}),
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
export function validatePerformanceStagedNativeWindow(observation, firstTick, lastTick, { expectNativeProject = false } = {}) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  require(Number.isSafeInteger(firstTick) && Number.isSafeInteger(lastTick)
    && firstTick >= 1 && lastTick >= firstTick, 'Invalid native measurement bounds');
  require(Array.isArray(observation.errors) && observation.errors.length === 0, 'Native measurement contains an observation failure');
  const within = row => row.tick >= firstTick && row.tick <= lastTick;
  const callbacks = observation.callbacks.filter(within);
  const finalCalls = callbacks.filter(row => row.name === 'bhStep' || row.name === 'bhStepCommit');
  const readbacks = observation.readbacks.filter(within);
  const acknowledgements = observation.acks.filter(within);
  const count = lastTick - firstTick + 1;
  require(finalCalls.length === count && readbacks.length === count && acknowledgements.length === count,
    'Actual native completion/readback/ACK coverage is incomplete or duplicated');
  require(observation.expectedReadbackSource === 'actual-bhStateReceipt', 'Staged measurement requires actual native receipts');
  let lastEpoch = 0, stagedSteps = 0, callbackCount = 0, previousAckAt = null;
  const tokens = new Set(), epsilon = .000001;
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(), [...expected].sort());
  for (let index = 0; index < count; index++) {
    const tick = firstTick + index, step = finalCalls[index], state = readbacks[index], ack = acknowledgements[index];
    const staged = tick % 25 === 0, finalName = staged ? 'bhStepCommit' : 'bhStep';
    require(step.tick === tick && state.tick === tick && ack.tick === tick, 'Native measurement ticks are not contiguous');
    require(step.name === finalName && step.source === 'actual-' + finalName, 'Full check was not the actual four-stage completion');
    require(state.source === observation.expectedReadbackSource, 'Native readback mode changed during measurement');
    require(typeof state.digest === 'string' && /^native-v2-[a-f0-9]{16}$/.test(state.digest)
      && step.digest === state.digest && ack.digest === state.digest, 'Actual native completion/readback/ACK digests differ');
    require(state.scope === (staged ? 'full' : 'frame'), 'Native readback checkpoint cadence differs');
    const binding = state.receiptBinding, saved = state.receiptObservation;
    require(binding && binding.version === 1 && binding.tick === tick && binding.scope === state.scope
      && Number.isSafeInteger(binding.epoch) && binding.epoch > lastEpoch,
    'Native receipt tick/epoch/scope binding differs');
    require(typeof binding.receiptToken === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(binding.receiptToken)
      && !tokens.has(binding.receiptToken), 'Native receipt token is missing or repeated');
    for (const key of ['actualDigestArgument', 'actualNativeReceipt', 'noTransferredGraphInReceipt',
      'nativeArgumentIdentity', 'capturedGraphFrozen']) require(binding[key] === true, 'Unproven native receipt field: ' + key);
    require(binding.captureCount === 1 && binding.replyCount === 1 && binding.cloneBeforeProducer === false,
      'Native receipt observation has duplicate work or a graph clone');
    require(saved?.schema === 'original-staged-native-receipt-observation-v2'
      && saved.completionSource === 'actual-' + finalName && saved.tick === tick,
    'Actual final callback source is not bound to this receipt');
    require(state.finalCallback?.source === saved.completionSource && state.finalCallback.tick === tick
      && state.finalCallback.worldTick === tick && state.finalCallback.digest === state.digest, 'Receipt lacks its actual final callback');
    require(saved.command?.source === (staged ? 'actual-bhStepBegin' : 'actual-bhStep')
      && saved.command.arity === 5 && saved.command.tick === tick && saved.command.receiptToken === binding.receiptToken,
    'Actual native command is missing or rebound');
    const frames = observation.frames.filter(row => row.tick === tick);
    require(frames.length === 1, 'Actual native command lacks one received frame');
    const frame = frames[0], command = saved.command;
    require(command.p1 === frame.p1 && command.p2 === frame.p2, 'Actual native masks differ from their received frame');
    if (frame.join === undefined) require(command.joinArgument === 'undefined' && !Object.hasOwn(command, 'join'),
      'Native join argument does not match the absent wire command');
    else require(command.joinArgument === 'player' && keys(command.join, ['slot', 'character'])
      && command.join.slot === 2 && frame.join.slot === 2 && command.join.character === frame.join.character,
    'Actual native join differs from the commanded player');
    require(keys(command, ['source', 'arity', 'tick', 'p1', 'p2', 'joinArgument', 'receiptToken',
      ...(frame.join === undefined ? [] : ['join'])]), 'Actual command evidence fields changed');
    const metadataKeys = ['version', 'receiptToken', 'epoch', 'tick', 'scope'];
    for (const metadata of [saved.metadata, saved.digestReply?.receipt, saved.receipt]) {
      require(metadata && metadataKeys.every(key => metadata[key] === binding[key]), 'Receipt/digest metadata differ from their lease');
      require(keys(metadata, metadata === saved.receipt ? [...metadataKeys, 'header'] : metadataKeys),
        'Receipt/digest metadata fields changed');
    }
    const names = staged ? ['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhInfo', 'bhStateReceipt']
      : ['bhStep', 'bhInfo', 'bhStateReceipt'];
    const calls = callbacks.filter(row => row.tick === tick);
    require(calls.length === names.length && calls.every((row, i) => row.name === names[i]
      && row.source === 'actual-' + names[i] && finite(row.at) && finite(row.ms)), 'Actual native callback sequence differs');
    for (let i = 1; i < calls.length; i++) require(calls[i - 1].at + calls[i - 1].ms <= calls[i].at + epsilon,
      'Actual native callbacks overlap or are reordered');
    require(finite(frame.at) && frame.at <= calls[0].at + epsilon
      && (previousAckAt === null || previousAckAt <= calls[0].at + epsilon),
    'Native work precedes its received frame or the preceding actual ACK');
    const info = calls.at(-2), receipt = calls.at(-1), completed = state.finalCallback;
    require(saved.info?.source === 'actual-bhInfo' && saved.info.value.tick === tick
      && saved.info.value.snapshotReceiptVersion === 1 && finite(saved.at) && finite(saved.ms), 'Actual Info/receipt evidence missing');
    require(completed.at + completed.ms <= saved.info.at + epsilon
      && saved.info.at + saved.info.ms <= saved.at + epsilon && saved.at + saved.ms <= state.at + epsilon
      && receipt.at + receipt.ms <= ack.at + epsilon && state.at <= ack.at + epsilon,
    'Actual completion/Info/receipt/readback/ACK order differs');
    require(same(saved.receipt.header.players.map(player => player.slot), state.playerSlots)
      && saved.receipt.header.digest === state.digest && saved.digestReply.digest === state.digest,
    'Final native header differs from the observed readback');
    for (const key of ['players', 'rng', 'profile', 'snapshotBytes', 'snapshotObjects', 'snapshotFields'])
      require(same(saved.receipt.header[key], completed[key]), 'Final header/completion differs at ' + key);
    if (staged) {
      stagedSteps++;
      require(info.stagedStepVersion === 1 && saved.info.value.stagedStepVersion === 1,
        'Actual Info did not attest the staged native capability');
      require(Array.isArray(saved.stages) && saved.stages.length === 4, 'Missing actual staged phase witnesses');
      for (let i = 0; i < 4; i++) {
        const row = saved.stages[i], outer = calls[i];
        require(row.name === names[i] && row.source === 'actual-' + names[i] && finite(row.at) && finite(row.ms)
          && outer.at <= row.at + epsilon && row.at + row.ms <= outer.at + outer.ms + epsilon,
        'Saved phase witness does not belong to its actual callback');
        if (i < 3) require(row.witness?.version === 1 && row.witness.phase === ['begun', 'prepared', 'projected'][i]
          && row.witness.tick === tick && row.witness.epoch === binding.epoch
          && row.witness.receiptToken === binding.receiptToken
          && keys(row.witness, ['version', 'phase', 'receiptToken', 'epoch', 'tick']), 'Staged witness token/epoch/tick differs');
        if (i === 0) {
          const { source, ...request } = command;
          require(same(row.request, request), 'Actual Begin request differs from the received command');
        } else require(keys(row.request, ['arity', 'receiptToken', 'epoch', 'tick']) && row.request.arity === 3
          && row.request.receiptToken === binding.receiptToken && row.request.epoch === binding.epoch && row.request.tick === tick,
        'Actual stage request was rebound or has extra arguments');
        require(i === 3 ? !Object.hasOwn(row, 'witness') : true, 'Commit contains a fabricated early-stage witness');
      }
      const tx = saved.transaction, begin = saved.stages[0], commit = saved.stages[3];
      require(tx && finite(tx.from) && finite(tx.committedAt) && finite(tx.verifiedAt)
        && tx.from === begin.at && tx.committedAt === commit.at + commit.ms && tx.verifiedAt === saved.at + saved.ms
        && Math.abs(tx.wallMs - (tx.committedAt - tx.from)) <= epsilon
        && Math.abs(tx.verifiedWallMs - (tx.verifiedAt - tx.from)) <= epsilon
        && Math.abs(tx.stageSumMs - saved.stages.reduce((sum, row) => sum + row.ms, 0)) <= epsilon
        && tx.maxStageMs === Math.max(...saved.stages.map(row => row.ms)), 'Staged wall/sum/max timing was altered');
    } else require(Array.isArray(saved.stages) && saved.stages.length === 0 && saved.transaction === null,
      'Synchronous native completion claims staged timing');
    callbackCount += calls.length; tokens.add(binding.receiptToken); lastEpoch = binding.epoch; previousAckAt = ack.at;
  }
  return { observedCompletions: count, observedReadbacks: count, observedAcks: count,
    actualSynchronousSteps: count - stagedSteps, actualStagedCommits: stagedSteps, actualCallbacks: callbackCount,
    source: observation.expectedReadbackSource, receiptBindings: count, extraNativeCalls: 0, graphClones: 0,
    ...(expectNativeProject ? { nativeProject: validatePerformanceStagedNativeProjectWindow(observation, firstTick, lastTick) } : {}) };
}

/** No additional VM query: bind the capability already returned by each live
 * Info read to the unchanged full-check cadence. Warmup supplies the preceding
 * witness, so even a full graph on the first measured tick must advance. */
export function validatePerformanceStagedNativeProjectWindow(observation, firstTick, lastTick) {
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
