/** Bounded passive failure history for the new phased checkpoint diagnostic.
 * The caller supplies an already completed actual native call. No callback,
 * state query, timer, pixel read or GPU query is issued by this helper. */
export function createCheckpointPresentationDiagnostics({ globalObject, now, context, recordPresent, requiredMode = 'three-pose-v2' }) {
  if (!globalObject?.console || typeof globalObject.console.warn !== 'function'
    || typeof now !== 'function' || typeof context !== 'function' || typeof recordPresent !== 'function')
    throw new Error('Invalid checkpoint presentation diagnostics installation');
  if (!['three-pose-v2', 'four-pose-v3'].includes(requiredMode)) throw new Error('Invalid checkpoint presentation mode');
  const limits = { presentCalls: 200000, events: 256, warnings: 64, configs: 64, infos: 64,
    warningArguments: 4, stringCharacters: 1024, errors: 16 };
  const events = [], warnings = [], configs = [], infos = [], errors = [];
  const present = { calls: 0, returned: 0, threw: 0, failures: 0, modeMismatches: 0, enabled: 0, disabled: 0, rendered: 0,
    first: null, last: null, firstFailure: null, lastFailure: null, maximumCallbackMs: null,
    minimumHistoryHeadroom: null, lastHistoryHeadroom: null };
  let active = true, sequence = 0, dropped = 0, warningCalls = 0, configCalls = 0, infoCalls = 0;
  let previousStatus = null;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const kind = value => value === null ? 'null' : typeof value === 'number' && !Number.isFinite(value)
    ? Number.isNaN(value) ? 'NaN' : value > 0 ? '+Infinity' : '-Infinity' : typeof value;
  const fail = code => { if (errors.length < limits.errors && !errors.includes(code)) errors.push(code); };
  const own = (value, name) => {
    if (value === null || !['object', 'function'].includes(typeof value)) return { absent: true };
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor) return { absent: true };
    return Object.hasOwn(descriptor, 'value') ? { value: descriptor.value } : { accessor: true };
  };
  const primitive = value => {
    if (value === undefined) return { kind: 'undefined' };
    if (value === null || typeof value === 'boolean' || finite(value)) return value;
    if (typeof value === 'string') {
      if (value.length <= limits.stringCharacters) return value;
      fail('string-truncated'); return { kind: 'string', value: value.slice(0, limits.stringCharacters), truncated: true };
    }
    return { kind: kind(value) };
  };
  const clock = () => { try { const value = now(); if (finite(value) && value >= 0) return value; } catch {}
    fail('clock-unavailable'); return null; };
  const current = instance => {
    const result = {};
    try {
      const value = context();
      for (const name of ['lastStepTick', 'ackTick', 'nativeReceiptPending', 'stagedPending']) {
        const field = own(value, name);
        if (field.accessor) { fail('context-accessor'); continue; }
        if (!field.absent) result[name] = primitive(field.value);
      }
      const last = own(value, 'lastNative');
      if (last.accessor) fail('context-accessor');
      else if (last.value) {
        result.lastNative = {};
        for (const name of ['name', 'at', 'endedAt']) {
          const field = own(last.value, name);
          if (field.accessor) fail('context-accessor');
          else if (!field.absent) result.lastNative[name] = primitive(field.value);
        }
      }
      if (instance !== undefined) result.instance = primitive(instance);
    } catch { fail('context-inspection-failed'); }
    return result;
  };
  const append = (list, row, maximum) => {
    if (list.length >= maximum) { dropped++; fail('history-capacity'); return; }
    list.push(row);
  };
  const event = (type, row) => append(events, { sequence: ++sequence, type, ...row }, limits.events);
  const inspect = (raw, threw, exception) => {
    const result = { outcome: threw ? 'throw' : 'return', fields: {} };
    if (threw) {
      result.exception = {};
      for (const name of ['name', 'message']) {
        const field = own(exception, name);
        if (field.accessor) result.exception[name] = { kind: 'accessor' };
        else if (!field.absent) result.exception[name] = primitive(field.value);
      }
      if (Object.keys(result.exception).length === 0) result.exception.kind = kind(exception);
      return result;
    }
    let value = raw;
    if (typeof value === 'string') {
      if (value.length > 16384) { result.returnKind = 'string-over-limit'; fail('return-over-limit'); return result; }
      try { value = JSON.parse(value); } catch { result.returnKind = 'non-json-string'; return result; }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      result.returnKind = Array.isArray(value) ? 'array' : kind(value); return result;
    }
    for (const name of ['version', 'ok', 'requested', 'enabled', 'rendered', 'tick', 'alpha', 'commands',
      'interpolated', 'totalFrames', 'mode', 'poseVersion', 'poseTick', 'unchanged', 'error']) {
      const field = own(value, name);
      if (field.accessor) result.fields[name] = { kind: 'accessor' };
      else if (!field.absent && field.value !== undefined) result.fields[name] = primitive(field.value);
    }
    return result;
  };
  function observeNative({ name, params, at, ms, result, threw = false, exception, instance }) {
    if (!active || !['bhPresent', 'bhPresentationConfig', 'bhPresentationInfo'].includes(name)) return;
    try {
      const callContext = current(instance);
      if (!finite(at) || at < 0 || !finite(ms) || ms < 0 || !finite(at + ms)) fail('invalid-native-clock');
      if (name === 'bhPresent') {
        present.calls++; present[threw ? 'threw' : 'returned']++;
        if (present.calls > limits.presentCalls) { dropped++; fail('presentation-call-capacity'); return; }
        const row = { call: present.calls, ...recordPresent({ at, ms, arity: params.length,
          requestedAlpha: params[0], result, threw, exception }), context: callContext };
        if (!Array.isArray(row.issues)) throw new Error('Invalid presentation recorder');
        if (row.enabled === true && row.mode !== requiredMode) {
          present.modeMismatches++;
          if (row.issues.length < 16) row.issues.push('unexpected-required-pose-mode');
        }
        if (row.enabled === true) present.enabled++; else if (row.enabled === false) present.disabled++;
        if (row.rendered === true) present.rendered++;
        if (finite(row.ms)) present.maximumCallbackMs = Math.max(present.maximumCallbackMs ?? 0, row.ms);
        const failed = threw || row.issues.length > 0;
        if (failed) { present.failures++; present.firstFailure ??= row; present.lastFailure = row; }
        if (!failed && (row.mode === 'three-pose-v2' || row.mode === 'four-pose-v3') && finite(row.poseTick) && finite(row.tick)) {
          const span = row.mode === 'four-pose-v3' ? 3 : 2;
          const headroom = { call: row.call, at: row.at, tick: row.tick, alpha: row.alpha, poseTick: row.poseTick,
            mode: row.mode, poseVersion: row.poseVersion, headroomTicks: row.poseTick - (row.tick - span) };
          present.lastHistoryHeadroom = headroom;
          if (present.minimumHistoryHeadroom === null
            || headroom.headroomTicks < present.minimumHistoryHeadroom.headroomTicks) present.minimumHistoryHeadroom = headroom;
        }
        const status = JSON.stringify([row.outcome, row.enabled, row.mode, row.poseVersion]);
        if (present.first === null) { present.first = row; event('first-present', row); }
        else if (failed || status !== previousStatus) event(failed ? 'present-failure' : 'present-status-change', row);
        present.last = row; previousStatus = status;
        return;
      }
      const config = name === 'bhPresentationConfig', count = config ? ++configCalls : ++infoCalls;
      const row = { call: count, source: 'actual-' + name, at, ms, endedAt: finite(at) && finite(ms) ? at + ms : null,
        arity: params.length, arguments: params.slice(0, limits.warningArguments).map(primitive),
        ...inspect(result, threw, exception), context: callContext };
      if (params.length > limits.warningArguments) fail('native-arguments-truncated');
      append(config ? configs : infos, row, config ? limits.configs : limits.infos);
      event(config ? 'presentation-config' : 'presentation-info', row);
    } catch { fail('native-observation-failed'); }
  }
  const consoleObject = globalObject.console, originalWarn = consoleObject.warn;
  const warningPrefix = new Set(['Original game presentation fallback:', 'Original game staged presentation failed:']);
  function observedWarn(...args) {
    if (!active || !warningPrefix.has(args[0])) return Reflect.apply(originalWarn, this, args);
    const at = clock(); let result, threw = false, exception;
    try { result = Reflect.apply(originalWarn, this, args); }
    catch (error) { threw = true; exception = error; }
    const end = clock();
    try {
      warningCalls++;
      if (!finite(at) || !finite(end) || end < at) fail('invalid-warning-clock');
      const row = { call: warningCalls, source: 'actual-console.warn', at,
        ms: finite(at) && finite(end) ? end - at : null, endedAt: end, arity: args.length,
        arguments: args.slice(0, limits.warningArguments).map(primitive),
        outcome: threw ? 'throw' : 'return', context: current(), lastActualPresent: present.last && {
          call: present.last.call, at: present.last.at, endedAt: present.last.endedAt,
          tick: present.last.tick, alpha: present.last.alpha, poseTick: present.last.poseTick,
          enabled: present.last.enabled, rendered: present.last.rendered },
        lastValidHistoryHeadroom: present.lastHistoryHeadroom };
      if (args.length > limits.warningArguments) fail('warning-arguments-truncated');
      append(warnings, row, limits.warnings); event('presentation-warning', row);
    } catch { fail('warning-observation-failed'); }
    if (threw) throw exception;
    return result;
  }
  consoleObject.warn = observedWarn;
  return {
    observeNative,
    snapshot() { return structuredClone({ schema: 'original-checkpoint-presentation-diagnostics-v2', requiredMode,
      complete: errors.length === 0 && dropped === 0, extraNativeCalls: 0, limits, dropped, errors,
      present, warnings: { calls: warningCalls, rows: warnings }, configs: { calls: configCalls, rows: configs },
      infos: { calls: infoCalls, rows: infos }, events,
      scope: 'Selected own primitive return/throw fields and actual presentation warnings; all callbacks and warnings retain original receiver/result/exception. Healthy Present calls retain first/last aggregates, not every frame. No pixel, GPU, display-completion or FPS proof.' }); },
    close() { active = false; if (consoleObject.warn === observedWarn) consoleObject.warn = originalWarn; },
  };
}
