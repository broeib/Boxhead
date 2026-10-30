import assert from 'node:assert/strict';

export const BUFFERED_NATIVE_PRESENTATION_LIMITS = Object.freeze({ pending: 4096, total: 500000, errors: 16, histogramBins: 65536 });

/** Pure, self-contained recorder for an already completed actual bhPresent.
 * It neither calls the player nor modifies/returns a replacement native value.
 * Invalid values remain explicit diagnostic failures, not valid zero samples.
 * Root observers can call this at their existing measured callback boundary. */
export function recordBufferedNativePresentationCall({ at, ms, arity, requestedAlpha, result, threw = false, exception }) {
  const row = { source: 'actual-bhPresent', at: null, endedAt: null, ms: null, arity: null,
    requestedAlpha: null, outcome: threw ? 'throw' : 'return', issues: [] };
  const issue = code => { if (!row.issues.includes(code) && row.issues.length < 16) row.issues.push(code); };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const kind = value => value === null ? 'null' : typeof value === 'number' && !Number.isFinite(value)
    ? Number.isNaN(value) ? 'NaN' : value > 0 ? '+Infinity' : '-Infinity' : typeof value;
  const own = (value, name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor) return { present: false };
    if (!Object.hasOwn(descriptor, 'value')) { issue('accessor:' + name); return { present: true }; }
    return { present: descriptor.value !== undefined, value: descriptor.value };
  };
  if (finite(at) && at >= 0 && finite(ms) && ms >= 0 && finite(at + ms)) {
    row.at = at; row.ms = ms; row.endedAt = at + ms;
  } else issue('invalid-clock');
  if (Number.isSafeInteger(arity) && arity >= 0 && arity <= 0xffffffff) row.arity = arity;
  if (arity !== 1) issue('invalid-arity');
  if (finite(requestedAlpha)) row.requestedAlpha = requestedAlpha;
  else { row.requestedAlphaKind = kind(requestedAlpha); issue('invalid-request-alpha'); }
  if (finite(requestedAlpha) && (requestedAlpha < 0 || requestedAlpha > 1)) issue('invalid-request-alpha');
  try {
    if (threw) {
      row.exception = { name: 'other' };
      if (exception !== null && (typeof exception === 'object' || typeof exception === 'function')) {
        // Own data only: diagnostic inspection must not invoke error getters.
        const name = own(exception, 'name'), message = own(exception, 'message');
        if (typeof name.value === 'string' && ['Error', 'TypeError', 'RangeError', 'ClientError', 'RuntimeError'].includes(name.value))
          row.exception.name = name.value;
        if (typeof message.value === 'string') {
          row.exception.message = message.value.slice(0, 256);
          row.exception.truncated = message.value.length > 256;
        }
      } else row.exception.valueKind = kind(exception);
      issue('native-threw'); return row;
    }
    let value = result;
    if (typeof value === 'string') {
      if (value.length > 16384) { row.returnKind = 'string-over-limit'; issue('invalid-return'); return row; }
      try { value = JSON.parse(value); } catch { row.returnKind = 'non-json-string'; issue('invalid-return'); return row; }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      row.returnKind = Array.isArray(value) ? 'array' : kind(value); issue('invalid-return'); return row;
    }
    for (const name of ['version', 'tick', 'alpha', 'commands', 'interpolated', 'totalFrames', 'poseVersion', 'poseTick']) {
      const field = own(value, name);
      if (!field.present) continue;
      if (finite(field.value)) row[name] = field.value;
      else { (row.invalidFields ??= {})[name] = kind(field.value); issue('invalid-field:' + name); }
    }
    for (const name of ['enabled', 'rendered', 'unchanged']) {
      const field = own(value, name);
      if (!field.present) continue;
      if (typeof field.value === 'boolean') row[name] = field.value;
      else { (row.invalidFields ??= {})[name] = kind(field.value); issue('invalid-field:' + name); }
    }
    for (const name of ['mode', 'error']) {
      const field = own(value, name);
      if (!field.present) continue;
      if (typeof field.value === 'string') {
        row[name] = field.value.slice(0, name === 'mode' ? 64 : 256);
        if (row[name].length !== field.value.length) issue('truncated-field:' + name);
      } else { (row.invalidFields ??= {})[name] = kind(field.value); issue('invalid-field:' + name); }
    }
    if (row.version !== 1 || typeof row.enabled !== 'boolean' || typeof row.rendered !== 'boolean') issue('invalid-status');
    for (const name of ['tick', 'commands', 'interpolated', 'totalFrames'])
      if (!Number.isSafeInteger(row[name]) || row[name] < 0 || row[name] > 0x7fffffff) issue('invalid-count:' + name);
    if (!finite(row.alpha) || row.alpha < 0 || row.alpha > 1 || row.alpha !== requestedAlpha) issue('returned-alpha-differs');
    if (row.interpolated > row.commands || (row.rendered && !row.enabled) || (row.unchanged === true && row.rendered))
      issue('inconsistent-render-status');
    if (Object.hasOwn(row, 'error')) issue('native-returned-error');
    const hasMode = Object.hasOwn(row, 'mode') || Object.hasOwn(row, 'poseVersion') || Object.hasOwn(row, 'poseTick');
    if (hasMode) {
      // These are two explicit native contracts, not a caller-supplied formula.
      const span = row.mode === 'three-pose-v2' ? 2 : row.mode === 'four-pose-v3' ? 3 : null;
      if (span === null || row.poseVersion !== span || !finite(row.poseTick)
        || row.poseTick < row.tick - span || row.poseTick > row.tick
        || row.poseTick !== row.tick - span + span * row.alpha)
        issue(row.mode === 'three-pose-v2' ? 'invalid-three-pose-clock'
          : row.mode === 'four-pose-v3' ? 'invalid-four-pose-clock' : 'invalid-buffered-pose-clock');
    }
  } catch { issue('return-inspection-failed'); }
  return row;
}

/** Self-contained browser wrapper. No extra native calls, pixel reads or GPU
 * queries. Other API methods retain their native receiver. Queue loss and any
 * invalid actual result remain visible after every drain. */
export function installBufferedNativePresentationObserver({ player, now, recordCall, limits }) {
  if (!player || typeof player.ruffle !== 'function' || typeof now !== 'function' || typeof recordCall !== 'function')
    throw new Error('Invalid native presentation observer installation');
  for (const [key, maximum] of [['pending', 16384], ['total', 2000000], ['errors', 64]])
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1 || limits[key] > maximum)
      throw new Error('Invalid native presentation observation bound');
  if (Object.hasOwn(player, '__boxheadBufferedNativePresentationObserver')) throw new Error('Native presentation observer installed twice');
  const original = player.ruffle;
  let queue = [], calls = 0, dropped = 0, failedCalls = 0;
  const errors = [];
  const fail = (code, sequence) => {
    if (errors.length < limits.errors) errors.push({ code, sequence });
  };
  const clock = () => { try { return now(); } catch { return null; } };
  player.ruffle = function (...args) {
    const api = Reflect.apply(original, this, args);
    return new Proxy(api, {
      get(target, key) {
        const method = Reflect.get(target, key, target);
        if (key !== 'callExternalInterface') return typeof method === 'function' ? method.bind(target) : method;
        return function (name, ...params) {
          if (name !== 'bhPresent') return Reflect.apply(method, target, [name, ...params]);
          const at = clock();
          let result, thrown = false, exception;
          try { result = Reflect.apply(method, target, [name, ...params]); }
          catch (error) { thrown = true; exception = error; }
          const end = clock(); calls++;
          try {
            if (queue.length >= limits.pending || calls > limits.total) {
              dropped++; fail('presentation-capacity', calls);
            } else {
              const row = recordCall({ at, ms: typeof at === 'number' && typeof end === 'number' ? end - at : null,
                arity: params.length, requestedAlpha: params[0], result, threw: thrown, exception });
              queue.push({ sequence: calls, ...row });
              if (row.issues.length) { failedCalls++; fail('invalid-presentation-call', calls); }
            }
          } catch { failedCalls++; fail('presentation-observation-failed', calls); }
          if (thrown) throw exception;
          return result;
        };
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
  };
  const observation = () => ({ schema: 'original-native-buffered-presentation-observer-v2', calls, dropped, failedCalls,
    complete: errors.length === 0 && dropped === 0, extraNativeCalls: 0, errors: errors.map(row => ({ ...row })),
    limits: { pending: limits.pending, total: limits.total, errors: limits.errors } });
  const control = { drain() { const rows = queue; queue = []; return { rows, observation: observation() }; },
    status: observation };
  Object.defineProperty(player, '__boxheadBufferedNativePresentationObserver', { value: control });
  return control;
}

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validateBufferedNativePresentationRow(row, { requiredMode = null } = {}) {
  assert([null, 'legacy-v1', 'three-pose-v2', 'four-pose-v3'].includes(requiredMode), 'Unknown required presentation mode');
  assert(row && typeof row === 'object' && !Array.isArray(row));
  const allowed = new Set(['source', 'at', 'endedAt', 'ms', 'arity', 'requestedAlpha', 'outcome', 'issues',
    'version', 'enabled', 'rendered', 'tick', 'alpha', 'commands', 'interpolated', 'totalFrames',
    'mode', 'poseVersion', 'poseTick', 'unchanged']);
  assert(Object.keys(row).every(key => allowed.has(key)), 'Unexpected presentation evidence fields');
  assert.equal(row.source, 'actual-bhPresent'); assert.deepEqual(row.issues, []); assert.equal(row.outcome, 'return');
  assert(finite(row.at) && finite(row.endedAt) && row.endedAt >= row.at && finite(row.ms)
    && Math.abs(row.at + row.ms - row.endedAt) <= .000001, 'Invalid actual Present clock');
  assert.equal(row.arity, 1); assert(finite(row.requestedAlpha) && row.requestedAlpha <= 1);
  assert.equal(row.alpha, row.requestedAlpha); assert.equal(row.version, 1);
  assert.equal(typeof row.enabled, 'boolean'); assert.equal(typeof row.rendered, 'boolean');
  for (const name of ['tick', 'commands', 'interpolated', 'totalFrames'])
    assert(Number.isSafeInteger(row[name]) && row[name] >= 0 && row[name] <= 0x7fffffff, 'Invalid Present count: ' + name);
  assert(row.interpolated <= row.commands && (!row.rendered || row.enabled));
  if (Object.hasOwn(row, 'unchanged')) { assert.equal(typeof row.unchanged, 'boolean'); assert(!row.unchanged || !row.rendered); }
  const modeFields = ['mode', 'poseVersion', 'poseTick'].filter(key => Object.hasOwn(row, key));
  const actualMode = modeFields.length === 0 ? 'legacy-v1' : row.mode;
  if (requiredMode !== null) assert.equal(actualMode, requiredMode, 'Actual presentation mode differs from its required mode');
  if (modeFields.length) {
    assert.equal(modeFields.length, 3);
    assert(row.mode === 'three-pose-v2' || row.mode === 'four-pose-v3', 'Unknown native buffered presentation mode');
    const span = row.mode === 'three-pose-v2' ? 2 : 3;
    assert.equal(row.poseVersion, span);
    assert(Number.isFinite(row.poseTick) && row.poseTick >= row.tick - span && row.poseTick <= row.tick);
    assert.equal(row.poseTick, row.tick - span + span * row.alpha, 'Actual pose clock differs from its actual alpha/tick');
  }
  return row;
}

function histogram(maximum) {
  const bins = new Map(); let count = 0, sum = 0, min = Infinity, max = -Infinity;
  return {
    add(value) {
      assert(finite(value)); const key = Math.round(value * 1000) / 1000;
      bins.set(key, (bins.get(key) ?? 0) + 1); assert(bins.size <= maximum, 'Presentation timing histogram bound');
      count++; sum += value; min = Math.min(min, value); max = Math.max(max, value);
    },
    summary() {
      if (!count) return { count: 0 };
      const sorted = [...bins].sort((a, b) => a[0] - b[0]);
      const q = fraction => {
        const target = Math.floor((count - 1) * fraction); let seen = 0;
        for (const [value, frequency] of sorted) { seen += frequency; if (seen > target) return value; }
        throw new Error('Presentation histogram is inconsistent');
      };
      return { count, min, mean: sum / count, p50: q(.5), p95: q(.95), p99: q(.99), max, percentilePrecisionMs: .001 };
    },
  };
}

function poseProgress(to) {
  let first = null, last = null, heldFrom = null, holdCalls = 0;
  let samples = 0, advances = 0, equal = 0, regressions = 0, advancedTicks = 0, regressedTicks = 0;
  let maximumHoldMs = 0, maximumHoldCalls = 0;
  return {
    add(poseTick, at) {
      assert(Number.isFinite(poseTick) && finite(at)); samples++;
      if (last === null) { first = { poseTick, at }; heldFrom = at; holdCalls = 1; }
      else if (poseTick === last.poseTick) { equal++; holdCalls++; }
      else {
        maximumHoldMs = Math.max(maximumHoldMs, at - heldFrom); maximumHoldCalls = Math.max(maximumHoldCalls, holdCalls);
        if (poseTick > last.poseTick) { advances++; advancedTicks += poseTick - last.poseTick; }
        else { regressions++; regressedTicks += last.poseTick - poseTick; }
        heldFrom = at; holdCalls = 1;
      }
      last = { poseTick, at };
    },
    summary() {
      return { samples, firstPoseTick: first?.poseTick ?? null, lastPoseTick: last?.poseTick ?? null,
        firstAt: first?.at ?? null, lastAt: last?.at ?? null, advances, equal, regressions, advancedTicks, regressedTicks,
        maximumHoldMs: last === null ? null : Math.max(maximumHoldMs, to - heldFrom),
        maximumHoldCalls: Math.max(maximumHoldCalls, holdCalls),
        trailingHoldMs: last === null ? null : to - heldFrom };
    },
  };
}

/** Streaming ACK-window summary. Requested pose and rendered replay pose are
 * separate scalar observations. Neither establishes per-entity positions,
 * distinct output pixels or GPU/display completion. No stage/capture exclusion. */
export function createBufferedNativePresentationWindow(window, { requiredMode = 'three-pose-v2',
  histogramBins = BUFFERED_NATIVE_PRESENTATION_LIMITS.histogramBins } = {}) {
  assert(window && finite(window.from) && finite(window.to) && window.to > window.from);
  assert(['legacy-v1', 'three-pose-v2', 'four-pose-v3'].includes(requiredMode), 'Unknown required presentation mode');
  assert(Number.isSafeInteger(histogramBins) && histogramBins > 0 && histogramBins <= 65536);
  const callback = histogram(histogramBins), gap = histogram(histogramBins), renderedGap = histogram(histogramBins);
  const requestedPose = poseProgress(window.to), renderedPose = poseProgress(window.to);
  let priorEnd = null, priorRow = null, first = null, last = null, firstRendered = null, lastRendered = null;
  let calls = 0, rendered = 0, unchanged = 0, interpolatedCalls = 0, interpolatedCommands = 0, boundaryExcluded = 0;
  let alphaZero = 0, alphaOne = 0, alphaInterior = 0, threePose = 0, fourPose = 0, legacy = 0;
  let alphaOneRun = null, longestAlphaOneRunMs = 0, maxGapMs = 0, maxRenderedGapMs = 0;
  const closeClamp = at => { if (alphaOneRun !== null) { longestAlphaOneRunMs = Math.max(longestAlphaOneRunMs, at - alphaOneRun); alphaOneRun = null; } };
  return {
    observe(row) {
      validateBufferedNativePresentationRow(row);
      assert(priorEnd === null || row.at >= priorEnd, 'Present calls overlap or move backwards'); priorEnd = row.endedAt;
      if (row.endedAt <= window.from || row.at >= window.to) return;
      if (row.at < window.from || row.endedAt > window.to) { boundaryExcluded++; return; }
      validateBufferedNativePresentationRow(row, { requiredMode });
      if (requiredMode !== 'legacy-v1') assert(row.enabled, 'Gameplay presentation was disabled');
      if (priorRow) {
        assert(row.tick >= priorRow.tick, 'Native Present tick regressed in one campaign');
        assert.equal(row.totalFrames - priorRow.totalFrames, row.rendered ? 1 : 0, 'An actual private replay was omitted or duplicated');
      }
      calls++; callback.add(row.ms); first ??= row; last = row;
      if (priorRow) { const delta = row.at - priorRow.at; gap.add(delta); maxGapMs = Math.max(maxGapMs, delta); }
      if (row.requestedAlpha === 0) alphaZero++;
      else if (row.requestedAlpha === 1) alphaOne++;
      else alphaInterior++;
      if (row.requestedAlpha === 1) alphaOneRun ??= row.at; else closeClamp(row.at);
      if (row.mode === 'three-pose-v2') { threePose++; requestedPose.add(row.poseTick, row.at); }
      else if (row.mode === 'four-pose-v3') { fourPose++; requestedPose.add(row.poseTick, row.at); }
      else legacy++;
      if (row.unchanged === true) unchanged++;
      if (row.interpolated > 0) interpolatedCalls++;
      interpolatedCommands += row.interpolated;
      if (row.rendered) {
        rendered++; firstRendered ??= row;
        if (lastRendered) { const delta = row.endedAt - lastRendered.endedAt; renderedGap.add(delta); maxRenderedGapMs = Math.max(maxRenderedGapMs, delta); }
        lastRendered = row;
        if (row.mode === 'three-pose-v2' || row.mode === 'four-pose-v3') renderedPose.add(row.poseTick, row.endedAt);
      }
      priorRow = row;
    },
    summary() {
      const duration = window.to - window.from;
      const leading = first ? first.at - window.from : duration, trailing = last ? window.to - last.endedAt : duration;
      const renderLeading = firstRendered ? firstRendered.endedAt - window.from : duration;
      const renderTrailing = lastRendered ? window.to - lastRendered.endedAt : duration;
      return { ...window, schema: 'original-native-buffered-presentation-window-v2', requiredMode,
        calls, rendered, unchanged, interpolatedCalls, interpolatedCommands, threePose, fourPose, legacy, boundaryExcluded,
        windowMs: duration, callsPerWindowSecond: calls * 1000 / duration, renderedPerWindowSecond: rendered * 1000 / duration,
        firstAt: first?.at ?? null, lastEndedAt: last?.endedAt ?? null,
        leadingUnobservedMs: leading, trailingUnobservedMs: trailing,
        maximumCallSilenceMs: Math.max(maxGapMs, leading, last ? window.to - last.at : duration),
        maximumRenderedSilenceMs: Math.max(maxRenderedGapMs, renderLeading, renderTrailing),
        actualCallGapMs: gap.summary(), callbackMs: callback.summary(), actualRenderedReturnGapMs: renderedGap.summary(),
        alpha: { zero: alphaZero, one: alphaOne, interior: alphaInterior,
          longestOneRunMs: Math.max(longestAlphaOneRunMs, alphaOneRun === null ? 0 : window.to - alphaOneRun) },
        requestedPose: requestedPose.summary(), renderedPose: renderedPose.summary(),
        exclusions: [],
        scope: 'Whole same-browser ACK window. Raw actual bhPresent calls only; requested poseTick and rendered replay poseTick are separate scalars. Holds include trailing time through the ACK boundary.',
        limits: 'Advancing poseTick is not per-entity motion or distinct pixels: spawn, teleport, missing history and unchanged geometry can snap/hold individual commands. No GPU completion or monitor scan-out claim.' };
    },
  };
}

export function summarizeBufferedNativePresentationCalls(rows, from, to, options) {
  assert(Array.isArray(rows));
  const window = createBufferedNativePresentationWindow({ from, to }, options);
  for (const row of rows) window.observe(row);
  return window.summary();
}
