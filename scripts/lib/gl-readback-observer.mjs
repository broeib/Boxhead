// Opt-in diagnostic only. These three functions are serialized by Playwright;
// each is self-contained and the ordinary game/harness never imports this file.
// No pixel contents, URLs, call stacks, GL queries or native game calls are read.
export function installGlReadbackObserver() {
  const key = '__boxheadGlReadbackDiagnosticV1';
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  const limits = Object.freeze({ durationMs: 10000, maximumInstallMs: 180000,
    maximumContexts: 8, maximumTrackedBuffers: 8192, maximumReads: 2048,
    maximumTransfers: 1024, maximumReadsPerTransfer: 32, maximumErrors: 8,
    maximumObservedCalls: 2500000, maximumAllocationBytes: 1073741824 });
  const now = performance.now.bind(performance);
  const apply = Reflect.apply;
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const isInteger = Number.isSafeInteger;
  const finite = Number.isFinite;
  const isView = ArrayBuffer.isView;
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedByteLength = ownDescriptor(typedPrototype, 'byteLength').get;
  const typedLength = ownDescriptor(typedPrototype, 'length').get;
  const dataViewByteLength = ownDescriptor(DataView.prototype, 'byteLength').get;
  const arrayBufferByteLength = ownDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  const methods = ['bindBuffer', 'bufferData', 'bufferSubData', 'copyBufferSubData',
    'deleteBuffer', 'pixelStorei', 'readPixels', 'getBufferSubData'];
  const PACK = 0x88eb, COPY_WRITE = 0x8f37;
  const allowedTargets = new Set([0x8892, 0x8893, 0x8f36, COPY_WRITE, PACK, 0x88ec, 0x8c8e, 0x8a11]);
  const parameterFields = new Map([[0x0d05, 'alignment'], [0x0d02, 'rowLength'],
    [0x0d03, 'skipRows'], [0x0d04, 'skipPixels']]);
  const contextMap = new WeakMap(), bufferMap = new WeakMap();
  const contexts = [], saved = [], reads = [], transfers = [], errors = [];
  const counts = { calls: 0, trackedBuffers: 0, reads: 0, transfers: 0,
    pairedTransfers: 0, exactTransfers: 0, unpairedTransfers: 0,
    directReads: 0, originalThrows: 0, preArmReadCalls: 0,
    readPixelsMs: 0, getBufferSubDataMs: 0, transferredBytes: 0,
    pairedTransferredBytes: 0, pairedPaddedBytes: 0 };
  let installed = false, active = false, armed = false, stopped = false, restored = false;
  let installationAt = now(), startAt = null, stopAt = null, reason = null;
  let timer = null, installTimer = null, generation = 0, prototype = null;

  function error(code) {
    if (errors.length < limits.maximumErrors && !errors.includes(code)) errors.push(code);
  }
  function restore() {
    let all = true;
    for (let index = saved.length - 1; index >= 0; index--) {
      const entry = saved[index];
      try {
        const current = ownDescriptor(prototype, entry.name);
        if (current?.value !== entry.wrapper) {
          all = false; error('wrapper-replaced:' + entry.name); continue;
        }
        if (entry.descriptor) define(prototype, entry.name, entry.descriptor);
        else delete prototype[entry.name];
        if (prototype[entry.name] !== entry.original) {
          all = false; error('restore-value:' + entry.name);
        }
      } catch { all = false; error('restore-failed:' + entry.name); }
    }
    restored = all;
  }
  function stop(why) {
    if (stopped) return;
    active = false; stopped = true; stopAt = now(); reason = why;
    clearTimeout(timer); clearTimeout(installTimer); restore();
  }
  function fail(code) { error(code); stop('observer-error'); }
  function integer(value, maximum = limits.maximumAllocationBytes) {
    return typeof value === 'number' && isInteger(value) && value >= 0 && value <= maximum;
  }
  function product(left, right) {
    const value = left * right;
    return integer(value) ? value : null;
  }
  function context(object) {
    if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return null;
    let value = contextMap.get(object);
    if (!value) {
      if (contexts.length >= limits.maximumContexts) { fail('context-limit'); return null; }
      // addInitScript runs before document code. No getContext wrapper is used,
      // so the independent paint observer can retain its own ownership chain.
      value = { id: contexts.length + 1, bindings: new Map(),
        pack: { alignment: 4, rowLength: 0, skipRows: 0, skipPixels: 0 },
        packKnown: true, reads: 0, transfers: 0 };
      contextMap.set(object, value); contexts.push(value);
    }
    return value;
  }
  function buffer(object) {
    if (object === null) return null;
    if (typeof object !== 'object' && typeof object !== 'function') return null;
    let value = bufferMap.get(object);
    if (!value) {
      if (counts.trackedBuffers >= limits.maximumTrackedBuffers) { fail('buffer-limit'); return null; }
      value = { id: ++counts.trackedBuffers, allocationBytes: null, allocationGeneration: 0,
        pending: null, deleted: false };
      bufferMap.set(object, value);
    }
    return value;
  }
  function bound(ctx, target) {
    const entry = ctx && allowedTargets.has(target) ? ctx.bindings.get(target) ?? null : null;
    return entry && !entry.deleted ? entry : null;
  }
  function viewRange(value, offset, length) {
    if (!isView(value)) return null;
    // Intrinsic accessors avoid invoking a user-defined shadowing property.
    // No array element or backing-buffer content is inspected.
    let bytes, elements, elementBytes;
    try {
      bytes = apply(typedByteLength, value, []);
      elements = apply(typedLength, value, []);
      elementBytes = elements === 0 ? 1 : bytes / elements;
    } catch {
      try { bytes = apply(dataViewByteLength, value, []); elements = bytes; elementBytes = 1; }
      catch { return null; }
    }
    if (!integer(bytes) || !integer(elementBytes, 8) || elementBytes === 0 || bytes % elementBytes) return null;
    const start = offset === undefined ? 0 : offset;
    const count = length === undefined || length === 0 ? elements - start : length;
    if (!integer(start) || !integer(count) || start > elements || count > elements - start) return null;
    return { destinationViewBytes: bytes, elementBytes, elementOffset: start,
      elementLength: count, bytes: count * elementBytes };
  }
  function allocationSize(args) {
    if (integer(args[1])) return args[1];
    try {
      const bytes = apply(arrayBufferByteLength, args[1], []);
      if (integer(bytes)) return bytes;
    } catch { /* ArrayBufferView overload below. */ }
    return viewRange(args[1], args[3], args[4])?.bytes ?? null;
  }
  function elapsed() {
    if (active && now() - startAt >= limits.durationMs) stop('duration');
    return active;
  }
  function readInfo(ctx, args, at) {
    if (reads.length >= limits.maximumReads) { fail('read-limit'); return null; }
    const [x, y, width, height, format, type, destination] = args;
    const entry = bound(ctx, PACK);
    const scalar = value => typeof value === 'number' && finite(value) ? value : null;
    const row = { id: reads.length + 1, context: ctx.id, at,
      x: scalar(x), y: scalar(y), width: scalar(width), height: scalar(height),
      format: scalar(format), type: scalar(type), buffer: entry?.id ?? null,
      bufferOffset: typeof destination === 'number' ? scalar(destination) : null,
      allocationBytes: entry?.allocationBytes ?? null,
      allocationGeneration: entry?.allocationGeneration ?? null,
      pack: { ...ctx.pack }, rgba8: format === 0x1908 && type === 0x1401,
      requestedPayloadBytes: null, rowStrideBytes: null, endByteExclusive: null,
      paddedEndByteExclusive: null, exactLayout: false, durationMs: null, threw: false };
    if (row.rgba8 && integer(width) && integer(height) && integer(destination)
      && ctx.packKnown && integer(ctx.pack.rowLength) && integer(ctx.pack.skipRows)
      && integer(ctx.pack.skipPixels) && [1, 2, 4, 8].includes(ctx.pack.alignment)) {
      const rowPixels = ctx.pack.rowLength || width;
      const stride = Math.ceil(rowPixels * 4 / ctx.pack.alignment) * ctx.pack.alignment;
      const first = destination + ctx.pack.skipRows * stride + ctx.pack.skipPixels * 4;
      const end = width === 0 || height === 0 ? destination : first + (height - 1) * stride + width * 4;
      const paddedEnd = width === 0 || height === 0 ? destination : first + height * stride;
      const payload = product(width * 4, height);
      if (rowPixels >= width + ctx.pack.skipPixels && integer(stride) && integer(first) && integer(end)
        && integer(paddedEnd) && payload !== null) {
        Object.assign(row, { requestedPayloadBytes: payload, rowStrideBytes: stride,
          endByteExclusive: end, paddedEndByteExclusive: paddedEnd, exactLayout: true });
      }
    }
    return { row, entry };
  }
  function transferInfo(ctx, args, at) {
    if (transfers.length >= limits.maximumTransfers) { fail('transfer-limit'); return null; }
    const entry = bound(ctx, args[0]);
    const range = viewRange(args[2], args[3], args[4]);
    const pending = entry?.pending;
    const matching = pending && pending.context === ctx.id && pending.generation === generation
      && pending.allocationGeneration === entry.allocationGeneration;
    const sourceByteOffset = integer(args[1]) ? args[1] : null;
    const allocationBytes = entry?.allocationBytes ?? null;
    const row = { id: transfers.length + 1, context: ctx.id, at,
      target: typeof args[0] === 'number' && finite(args[0]) ? args[0] : null,
      buffer: entry?.id ?? null, sourceByteOffset,
      allocationBytes, allocationGeneration: entry?.allocationGeneration ?? null,
      destinationViewBytes: range?.destinationViewBytes ?? null,
      destinationElementBytes: range?.elementBytes ?? null,
      destinationElementOffset: range?.elementOffset ?? null,
      destinationElementLength: range?.elementLength ?? null,
      transferredBytes: range?.bytes ?? null, readIds: matching ? [...pending.ids] : [],
      readCount: matching ? pending.count : 0,
      requestedPayloadBytes: matching ? pending.payloadBytes : null,
      requiredEndByteExclusive: matching ? pending.end : null,
      paddedEndByteExclusive: matching ? pending.paddedEnd : null,
      exactPair: Boolean(matching && pending.exact && range && sourceByteOffset === 0
        && allocationBytes !== null && range.bytes === allocationBytes && pending.end <= range.bytes),
      reason: matching ? null : entry ? 'no-observed-current-readPixels' : 'unknown-bound-buffer',
      durationMs: null, threw: false };
    if (matching && !row.exactPair) row.reason = 'unsupported-or-incomplete-layout';
    return { row, entry };
  }
  function before(name, receiver, args) {
    if (stopped) return null;
    if (++counts.calls > limits.maximumObservedCalls) { fail('call-limit'); return null; }
    const ctx = context(receiver);
    if (!ctx || stopped) return null;
    if (name === 'readPixels' || name === 'getBufferSubData') {
      if (!elapsed()) return { ctx, active: false };
      const at = now();
      const detail = name === 'readPixels' ? readInfo(ctx, args, at) : transferInfo(ctx, args, at);
      return detail && !stopped ? { ctx, active: true, ...detail } : null;
    }
    return { ctx, active: false };
  }
  function after(name, args, state, threw) {
    if (!state || stopped) return;
    const { ctx } = state;
    if (threw) {
      if (armed) counts.originalThrows++;
      if (state.row) { state.row.durationMs = now() - state.row.at; state.row.threw = true; }
      // The original thrown object is propagated unchanged by the wrapper.
      error('original-threw:' + name);
      stop('original-error'); return;
    }
    if (name === 'bindBuffer') {
      if (allowedTargets.has(args[0])) ctx.bindings.set(args[0], buffer(args[1]));
    } else if (name === 'bufferData') {
      const entry = bound(ctx, args[0]);
      if (entry) { entry.allocationBytes = allocationSize(args); entry.allocationGeneration++; entry.pending = null; }
    } else if (name === 'bufferSubData' || name === 'copyBufferSubData') {
      const entry = bound(ctx, args[name === 'bufferSubData' ? 0 : 1]);
      if (entry) entry.pending = null;
    } else if (name === 'deleteBuffer') {
      const entry = args[0] && bufferMap.get(args[0]);
      if (entry) {
        entry.deleted = true; entry.pending = null;
        for (const current of contexts) for (const [target, binding] of current.bindings)
          if (binding === entry) current.bindings.set(target, null);
      }
    } else if (name === 'pixelStorei') {
      const field = parameterFields.get(args[0]);
      if (field) {
        const valid = field === 'alignment' ? [1, 2, 4, 8].includes(args[1]) : integer(args[1]);
        if (valid) ctx.pack[field] = args[1]; else ctx.packKnown = false;
      }
    } else if (name === 'readPixels') {
      if (!state.active) { counts.preArmReadCalls++; return; }
      const { row, entry } = state;
      row.durationMs = now() - row.at; reads.push(row); counts.reads++; ctx.reads++;
      counts.readPixelsMs += row.durationMs;
      if (!entry) { counts.directReads++; return; }
      let pending = entry.pending;
      if (!pending || pending.generation !== generation || pending.allocationGeneration !== entry.allocationGeneration) {
        pending = { context: ctx.id, generation, allocationGeneration: entry.allocationGeneration,
          ids: [], count: 0, exact: true, payloadBytes: 0, end: 0, paddedEnd: 0 };
        entry.pending = pending;
      }
      if (pending.ids.length >= limits.maximumReadsPerTransfer) { fail('reads-per-transfer-limit'); return; }
      pending.ids.push(row.id); pending.count++;
      pending.exact &&= row.exactLayout && row.bufferOffset === 0;
      if (pending.payloadBytes !== null && row.requestedPayloadBytes !== null) pending.payloadBytes += row.requestedPayloadBytes;
      if (row.endByteExclusive !== null) pending.end = Math.max(pending.end, row.endByteExclusive);
      if (row.paddedEndByteExclusive !== null) pending.paddedEnd = Math.max(pending.paddedEnd, row.paddedEndByteExclusive);
      if (!integer(pending.payloadBytes)) { pending.exact = false; pending.payloadBytes = null; }
    } else if (name === 'getBufferSubData' && state.active) {
      const { row, entry } = state;
      row.durationMs = now() - row.at; transfers.push(row); counts.transfers++; ctx.transfers++;
      counts.getBufferSubDataMs += row.durationMs;
      if (row.transferredBytes !== null) counts.transferredBytes += row.transferredBytes;
      if (row.readCount > 0) counts.pairedTransfers++; else counts.unpairedTransfers++;
      if (row.exactPair) {
        counts.exactTransfers++; counts.pairedTransferredBytes += row.transferredBytes;
        counts.pairedPaddedBytes += row.paddedEndByteExclusive;
      }
      if (entry) entry.pending = null;
    }
  }
  function snapshot() {
    return { schema: 'boxhead-webgl-readback-observer-v1', installed, armed, active,
      complete: installed && armed && stopped && reason === 'duration' && restored
        && errors.length === 0 && counts.transfers > 0,
      comparisonComplete: counts.transfers > 0 && counts.exactTransfers === counts.transfers,
      restored, stopped, status: reason ?? (active ? 'recording' : 'waiting'),
      installationAt, startAt, stopAt, elapsedMs: startAt === null || stopAt === null ? null : stopAt - startAt,
      limits, counts: { ...counts }, errors: [...errors],
      contexts: contexts.map(ctx => ({ id: ctx.id, reads: ctx.reads, transfers: ctx.transfers })),
      reads, transfers,
      assumptions: 'Installed by addInitScript before document code; initial PACK state is the WebGL default. Calls and plain numeric arguments are observed after a normal return; GL error/context state is not queried.',
      scope: 'CPU call durations include diagnostic overhead and GPU waits. exactPair requires observed readPixels, RGBA/UNSIGNED_BYTE pack layout, known allocation and whole-allocation getBufferSubData from offset zero. No pixel content is read. Padded byte counts include the final row padding, conservatively matching a staging allocation.' };
  }
  const api = Object.freeze({
    arm(options) {
      if (armed || stopped || !installed) return { ok: false, status: reason ?? 'already-armed-or-unavailable' };
      if (!options || options.durationMs !== limits.durationMs) return { ok: false, status: 'invalid-duration' };
      generation++; startAt = now(); armed = true; active = true;
      clearTimeout(installTimer); timer = setTimeout(() => stop('duration'), limits.durationMs);
      return { ok: true, startAt, durationMs: limits.durationMs, contexts: contexts.length,
        trackedBuffers: counts.trackedBuffers };
    },
    collect() { if (!stopped) stop(active && now() - startAt >= limits.durationMs ? 'duration' : 'collected-early'); return snapshot(); },
  });
  define(globalThis, key, { value: api, configurable: false, enumerable: false, writable: false });
  try {
    prototype = globalThis.WebGL2RenderingContext?.prototype;
    if (!prototype) { error('WebGL2-unavailable'); stop('unavailable'); return; }
    for (const name of methods) {
      const descriptor = ownDescriptor(prototype, name), original = prototype[name];
      if (typeof original !== 'function' || (descriptor && (!descriptor.configurable || !('value' in descriptor)))) {
        throw new Error('unsupported-method:' + name);
      }
      function observed(...args) {
        let state = null;
        try { state = before(name, this, args); } catch { fail('observe-before:' + name); }
        let result;
        try { result = apply(original, this, args); }
        catch (originalError) {
          try { after(name, args, state, true); } catch { fail('observe-throw:' + name); }
          throw originalError;
        }
        try { after(name, args, state, false); } catch { fail('observe-after:' + name); }
        return result;
      }
      const replacement = descriptor ? { ...descriptor, value: observed }
        : { value: observed, configurable: true, writable: true, enumerable: false };
      define(prototype, name, replacement); saved.push({ name, descriptor, original, wrapper: observed });
    }
    installed = true;
    installTimer = setTimeout(() => stop('arm-timeout'), limits.maximumInstallMs);
  } catch { error('installation-failed'); stop('unavailable'); }
}

export function armGlReadbackObserver(options) {
  const observer = globalThis.__boxheadGlReadbackDiagnosticV1;
  return observer ? observer.arm(options) : { ok: false, status: 'observer-missing' };
}

export function collectGlReadbackObserver() {
  const observer = globalThis.__boxheadGlReadbackDiagnosticV1;
  return observer ? observer.collect() : { schema: 'boxhead-webgl-readback-observer-v1',
    installed: false, armed: false, complete: false, restored: false, status: 'observer-missing', errors: ['observer-missing'] };
}
