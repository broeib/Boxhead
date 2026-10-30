/** Independent v3 evidence for synchronous, four-phase full and two-phase frame callbacks.
 * This module does not import the production capture controller, manufacture a
 * digest, call a VM, write world state, or decide whether a gameplay ACK is sent.
 * The factory is self-contained so the campaign observer can inject its exact source.
 */
export function createPhasedNativeSnapshotReceiptObserver({ cloneCapture = false, maxObservations = 20000 } = {}) {
  let evidenceError = null;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = message => { evidenceError ??= message; throw new Error('Native receipt evidence: ' + evidenceError); };
  const require = (condition, message) => { if (evidenceError !== null) fail(evidenceError); if (!condition) fail(message); };
  const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= 0x7fffffff;
  const metadataKeys = ['epoch', 'scope', 'tick', 'token', 'version'];
  const headerFields = ['version', 'engine', 'state', 'tick', 'digest', 'digestSchema', 'scope',
    'players', 'rng', 'snapshotBytes', 'snapshotObjects', 'snapshotFields', 'profile'];
  let active = null, lastEpoch = 0, lastTick = 0, begun = 0, consumed = 0;
  const seenTokens = new Set();
  require(typeof cloneCapture === 'boolean', 'capture mode must be boolean');
  require(Number.isSafeInteger(maxObservations) && maxObservations >= 1 && maxObservations <= 120000,
    'campaign evidence capacity must be an integer in 1..120000');

  function data(value, key, label) {
    require(record(value) || Array.isArray(value), label + ' is not data');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    require(descriptor && own(descriptor, 'value'), label + '.' + key + ' is absent or an accessor');
    return descriptor.value;
  }
  function keys(value, expected, label) {
    require(record(value), label + ' is not an object');
    require(Object.getOwnPropertySymbols(value).length === 0, label + ' has symbol fields');
    const actual = Object.getOwnPropertyNames(value).sort();
    require(actual.length === expected.length && actual.every((key, index) => key === expected[index]),
      label + ' has unexpected fields');
    for (const key of actual) data(value, key, label);
  }
  function metadata(value, label) {
    keys(value, metadataKeys, label);
    require(value.version === 1 && typeof value.token === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(value.token),
      label + ' has an invalid version or token');
    require(integer(value.tick, 1) && integer(value.epoch, 1), label + ' has an invalid epoch or tick');
    require(value.scope === (value.tick % 25 === 0 ? 'full' : 'frame'), label + ' has the wrong full/frame cadence');
    return { version: value.version, token: value.token, epoch: value.epoch, tick: value.tick, scope: value.scope };
  }
  function sameMetadata(a, b, label) {
    for (const key of metadataKeys) require(Object.is(a[key], b[key]), label + ' differs at ' + key);
  }

  /** Compare all own data fields in memory, including undefined, sparse arrays,
   * nonenumerable array length and the sign of zero. JSON/canonical hashes cannot
   * prove the signed-zero distinction. No getter is invoked by this comparison.
   */
  function equalData(left, right, label = 'snapshot') {
    const stack = [{ left, right, path: label, depth: 0 }];
    const paired = new WeakMap();
    const activeLeft = new WeakSet(), activeRight = new WeakSet();
    let values = 0, objects = 0, maxDepth = 0;
    while (stack.length) {
      const item = stack.pop(), a = item.left, b = item.right;
      if (item.exit) { activeLeft.delete(a); activeRight.delete(b); continue; }
      if (++values > 4000000 || item.depth > 256) fail(label + ' comparison budget exceeded');
      maxDepth = Math.max(maxDepth, item.depth);
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        require(typeof a !== 'function' && typeof b !== 'function' && typeof a !== 'symbol' && typeof b !== 'symbol'
          && typeof a !== 'bigint' && typeof b !== 'bigint', item.path + ' is not native data');
        require(Object.is(a, b), item.path + ' value differs');
        continue;
      }
      require(Array.isArray(a) === Array.isArray(b), item.path + ' array/object kind differs');
      require(!activeLeft.has(a) && !activeRight.has(b), item.path + ' contains an implicit cycle');
      for (const value of [a, b]) {
        const prototype = Object.getPrototypeOf(value);
        require(prototype === null || prototype === Object.prototype || (Array.isArray(value) && prototype === Array.prototype),
          item.path + ' is not a plain native object');
        require(Object.getOwnPropertySymbols(value).length === 0, item.path + ' has symbol fields');
      }
      let rights = paired.get(a);
      if (rights?.has(b)) continue;
      if (!rights) { rights = new WeakSet(); paired.set(a, rights); }
      rights.add(b); objects++;
      activeLeft.add(a); activeRight.add(b);
      stack.push({ left: a, right: b, exit: true });
      const aKeys = Object.getOwnPropertyNames(a).sort(), bKeys = Object.getOwnPropertyNames(b).sort();
      require(aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index]),
        item.path + ' own fields differ');
      for (let index = aKeys.length - 1; index >= 0; index--) {
        const key = aKeys[index];
        stack.push({ left: data(a, key, item.path), right: data(b, key, item.path),
          path: item.path + '/' + key, depth: item.depth + 1 });
      }
    }
    return { values, objects, maxDepth };
  }

  const fullPhaseNames = ['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit'];
  const compactPhaseNames = ['bhFrameBegin', 'bhFrameCommit'];
  const phaseNames = () => active?.compact ? compactPhaseNames : fullPhaseNames;
  const phaseValues = ['begun', 'prepared', 'projected'];
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const epsilon = .000001;
  function interval(at, ms, previousEnd, label) {
    require(finite(at) && finite(ms), label + ' has invalid callback timing');
    require(previousEnd === undefined || previousEnd <= at + epsilon, label + ' overlaps or precedes its predecessor');
  }
  function commandRequest(command) {
    const { source, ...request } = command;
    return request;
  }
  function begin(command) {
    require(active === null, 'a prior observation was not consumed');
    require(record(command), 'missing actual native command');
    const commandKeys = ['arity', 'joinArgument', 'p1', 'p2', 'receiptToken', 'source', 'tick'];
    if (command.joinArgument === 'player') commandKeys.push('join');
    keys(command, commandKeys.sort(), 'actual native command');
    const token = command.receiptToken, tick = command.tick;
    require(['actual-bhStep', 'actual-bhStepBegin', 'actual-bhFrameBegin'].includes(command.source),
      'unknown actual native command source');
    require(command.arity === 5 && integer(command.p1) && command.p1 <= 131071
      && integer(command.p2) && command.p2 <= 131071, 'invalid actual native masks or arity');
    require(['undefined', 'null', 'player'].includes(command.joinArgument), 'unknown native join argument kind');
    if (command.joinArgument === 'player') {
      keys(command.join, ['character', 'slot'], 'actual native join');
      require(command.join.slot === 2 && integer(command.join.character) && command.join.character <= 3, 'invalid actual native join');
    }
    require(typeof token === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(token), 'invalid step token');
    require(integer(tick, 1) && tick > lastTick, 'duplicate or nonmonotone step tick');
    const compact = command.source === 'actual-bhFrameBegin';
    const full = command.source === 'actual-bhStepBegin';
    const staged = full || compact;
    require(!full || tick % 25 === 0, 'full staged command changed the full-check cadence');
    require(!compact || tick % 25 !== 0, 'compact staged command replaced a full-check tick');
    require(!seenTokens.has(token) && seenTokens.size < maxObservations, 'reused token or evidence capacity exceeded');
    seenTokens.add(token); begun++;
    active = { token, tick, staged, compact, execution: compact ? 'staged-frame' : full ? 'staged-full' : 'sync', command: { ...command, ...(command.join ? { join: { ...command.join } } : {}) },
      stages: [], captures: 0, replies: 0, steps: 0, infos: 0 };
  }

  function phase(name, request, raw, at, ms) {
    require(active !== null && active.staged && active.steps === 0, 'phase return has no active staged command');
    const index = active.stages.length;
    require(index < phaseNames().length - 1 && name === phaseNames()[index], 'native stage was repeated, skipped or reordered');
    require(active.captures === 0 && active.replies === 0, 'native graph was exported before Commit');
    const previous = active.stages.at(-1);
    interval(at, ms, previous ? previous.at + previous.ms : undefined, 'actual ' + name);
    keys(raw, ['epoch', 'phase', 'tick', 'token', 'version'], 'actual stage witness');
    require(raw.version === 1 && raw.phase === phaseValues[index] && raw.token === active.token
      && raw.tick === active.tick && integer(raw.epoch, 1) && raw.epoch > lastEpoch, 'stage witness identity differs');
    if (index === 0) {
      equalData(request, commandRequest(active.command), 'Begin actual request');
      active.epoch = raw.epoch;
    } else {
      equalData(request, { arity: 3, receiptToken: active.token, epoch: active.epoch, tick: active.tick }, 'stage actual request');
      require(raw.epoch === active.epoch, 'stage epoch changed');
    }
    active.stages.push({ name, source: 'actual-' + name, at, ms, request: { ...request,
      ...(request.join ? { join: { ...request.join } } : {}) }, witness: {
      version: raw.version, phase: raw.phase, receiptToken: raw.token, epoch: raw.epoch, tick: raw.tick } });
  }

  function beforeDigest(native, rawMetadata) {
    require(active !== null, 'receipt digest occurred outside its actual step');
    require(active.captures === 0, 'more than one digest argument was observed for the step');
    require(!active.staged || active.stages.length === phaseNames().length - 1,
      'digest occurred before all actual stage witnesses');
    const meta = metadata(rawMetadata, 'digest metadata');
    require(meta.token === active.token && meta.tick === active.tick && meta.epoch > lastEpoch,
      'digest metadata does not belong to this VM step');
    require(!active.staged || meta.epoch === active.epoch, 'Commit digest differs from the observed Begin epoch');
    require(record(native) && own(native, 'entities') && record(data(native, 'entities', 'native')),
      'actual digest argument is missing its entity graph');
    require(data(native, 'tick', 'native') === meta.tick && data(native, 'scope', 'native') === meta.scope,
      'actual digest graph has a different tick or scope');
    active.captures++;
    active.metadata = meta;
    active.argument = native;
    // Qualification clones before the production callback can inspect or
    // accidentally mutate its input. Timing/cold mode retains the actual
    // callback object only until the matching receipt; it does not clone every
    // compact graph and does not treat an internal production cache as evidence.
    if (cloneCapture) equalData(native, native, 'actual digest argument data');
    active.native = cloneCapture ? structuredClone(native) : native;
  }

  function afterDigest(rawReply) {
    require(active !== null && active.captures === 1 && active.replies === 0,
      'digest reply has no unique actual argument');
    keys(rawReply, ['bytes', 'digest', 'receipt'], 'digest reply');
    require(typeof rawReply.digest === 'string' && /^native-v2-[0-9a-f]{16}$/.test(rawReply.digest), 'invalid digest reply');
    require(integer(rawReply.bytes) && rawReply.bytes <= 8000000, 'invalid digest length');
    sameMetadata(metadata(rawReply.receipt, 'digest reply receipt'), active.metadata, 'digest reply receipt');
    if (cloneCapture) equalData(active.native, active.argument, 'digest argument before/after producer');
    active.reply = { digest: rawReply.digest, bytes: rawReply.bytes, receipt: { ...rawReply.receipt } };
    active.replies++;
  }

  function completeStep(source, raw, request, at, ms) {
    require(active !== null && active.captures === 1 && active.replies === 1 && active.steps === 0,
      'step return has no unique digest observation');
    require(record(raw) && !raw.error && raw.tick === active.tick && raw.worldTick === active.tick,
      'step return does not belong to the commanded world tick');
    require(raw.digest === active.reply.digest && raw.snapshotBytes === active.reply.bytes,
      'step return differs from the actual digest callback');
    require(source === (active.staged ? 'actual-' + phaseNames().at(-1) : 'actual-bhStep'),
      'final result came from the wrong native callback');
    if (active.staged) {
      require(active.stages.length === phaseNames().length - 1, 'Commit has missing completed native phases');
      equalData(request, { arity: 3, receiptToken: active.token, epoch: active.epoch, tick: active.tick }, 'Commit actual request');
      const previous = active.stages.at(-1);
      interval(at, ms, previous.at + previous.ms, 'actual Commit');
      active.stages.push({ name: phaseNames().at(-1), source, at, ms, request: { ...request } });
    } else {
      equalData(request, commandRequest(active.command), 'Step actual request');
      interval(at, ms, undefined, 'actual Step');
    }
    active.completionSource = source; active.finalAt = at; active.finalMs = ms;
    active.step = raw; active.steps++;
  }

  function info(raw, at, ms) {
    require(active !== null && active.steps === 1 && active.infos === 0,
      'info return is missing, duplicated or out of order');
    require(record(raw) && raw.snapshotReceiptVersion === 1 && !raw.error && raw.state !== 'error'
      && raw.tick === active.tick, 'info does not attest this receipt-capable VM tick');
    require(!active.staged || raw.stagedStepVersion === 1, 'Info omitted the actual staged capability');
    require(!active.compact || raw.compactStepVersion === 1, 'Info omitted the actual compact capability');
    interval(at, ms, active.finalAt + active.finalMs, 'actual Info');
    active.infoAt = at; active.infoMs = ms;
    active.info = raw; active.infos++;
  }

  function consume(raw, at, ms) {
    require(active !== null && active.captures === 1 && active.replies === 1 && active.steps === 1 && active.infos === 1,
      'receipt return has no complete Step/Info/digest observation');
    interval(at, ms, active.infoAt + active.infoMs, 'actual Receipt');
    keys(raw, ['epoch', 'header', 'scope', 'tick', 'token', 'version'], 'native receipt');
    const meta = metadata({ version: raw.version, token: raw.token, epoch: raw.epoch, tick: raw.tick, scope: raw.scope },
      'native receipt binding');
    sameMetadata(meta, active.metadata, 'native receipt binding');
    const header = data(raw, 'header', 'receipt');
    require(record(header) && !own(header, 'native') && !own(header, 'entities') && !own(header, 'error'),
      'receipt header includes a graph, entity alias or error');
    require(Object.getOwnPropertySymbols(header).length === 0, 'receipt header has symbol fields');
    const headerKeys = Object.getOwnPropertyNames(header).sort();
    for (const key of headerKeys) data(header, key, 'receipt header');
    for (const key of headerFields) require(own(header, key), 'receipt header omitted ' + key);
    require(header.version === 1 && header.engine === 'original-swf' && header.digestSchema === 'native-projection-v3'
      && header.tick === active.tick && header.scope === active.metadata.scope && header.state === active.info.state,
      'receipt header identity differs from actual native evidence');
    require(header.digest === active.reply.digest && header.snapshotBytes === active.reply.bytes,
      'receipt header differs from digest/length');
    for (const key of ['players', 'rng', 'profile', 'snapshotObjects', 'snapshotFields'])
      equalData(header[key], active.step[key], 'receipt header/step ' + key);
    for (const key of ['seed', 'state', 'calls'])
      require(Object.is(data(header.rng, key, 'header rng'), data(active.native.rng, key, 'native rng')),
        'receipt/native RNG differs at ' + key);
    if (cloneCapture) equalData(raw, raw, 'actual native receipt data');
    const savedReceipt = cloneCapture ? structuredClone(raw) : raw;
    const snapshot = { ...savedReceipt.header, native: active.native, entities: active.native.entities };
    const observation = {
      argument: active.argument,
      snapshot,
      wire: { schema: 'original-phased-native-snapshot-receipt-observation-v3', execution: active.execution,
        metadata: { ...active.metadata }, digestReply: active.reply, receipt: savedReceipt,
        completionSource: active.completionSource, command: active.command, stages: active.stages,
        transaction: active.staged ? { from: active.stages[0].at, committedAt: active.finalAt + active.finalMs,
          verifiedAt: at + ms, wallMs: active.finalAt + active.finalMs - active.stages[0].at,
          verifiedWallMs: at + ms - active.stages[0].at,
          stageSumMs: active.stages.reduce((total, row) => total + row.ms, 0),
          maxStageMs: Math.max(...active.stages.map(row => row.ms)) } : null,
        headerKeys, captureCount: active.captures, replyCount: active.replies,
        actualDigestArgument: true, actualNativeReceipt: true, noTransferredGraphInReceipt: true,
        cloneBeforeProducer: cloneCapture, nativeArgumentIdentity: cloneCapture ? null : snapshot.native === active.argument },
    };
    lastEpoch = active.metadata.epoch; lastTick = active.tick; consumed++;
    active = null;
    return observation;
  }

  function expectCall(name) {
    require(active !== null, 'native callback has no active observation');
    const expected = active.steps ? (active.infos ? 'bhStateReceipt' : 'bhInfo')
      : active.staged ? phaseNames()[active.stages.length] : 'bhStep';
    const presentation = name === 'bhPresent' && active.staged && active.stages.length > 0
      && active.stages.length < phaseNames().length && active.steps === 0;
    require(name === expected || presentation, 'native callback is nested, unsolicited or out of phase: ' + name);
  }

  return { begin, phase, expectCall, beforeDigest, afterDigest, completeStep, info, consume, equalData,
    pending: () => active !== null,
    pendingStaged: () => active?.staged === true,
    status: () => active === null ? null : { tick: active.tick, staged: active.staged, execution: active.execution,
      phase: active.steps ? (active.infos ? 'awaiting-receipt' : 'awaiting-info')
        : active.staged ? phaseNames()[active.stages.length] : 'bhStep' },
    counts: () => ({ begun, consumed, pending: active !== null, lastEpoch, lastTick, cloneCapture,
      failed: evidenceError !== null, error: evidenceError }) };
}
