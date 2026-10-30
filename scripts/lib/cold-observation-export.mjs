// This function is also passed directly to Playwright page.evaluate. Keep it
// self-contained: installation snapshots only small metadata and array lengths,
// never a complete array, checkpoint graph, or serialized observation.
export function installColdObservationExport(options, realm = globalThis) {
  const o = realm.__dropin;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  require(o && !realm.__coldObservationExport, 'Missing observer or duplicate export installation');
  require(Number.isSafeInteger(options.minimumTick) && o.tick >= options.minimumTick,
    'Observation cutoff precedes the required paired live window');
  const maxChunkChars = options.maxChunkChars ?? 131072;
  const maxVisits = options.maxVisits ?? 16384;
  const maxSliceMs = options.maxSliceMs ?? 8;
  require(Number.isSafeInteger(maxChunkChars) && maxChunkChars >= 4096 && maxChunkChars <= 131072,
    'Invalid export chunk limit');
  require(Number.isSafeInteger(maxVisits) && maxVisits >= 1 && maxVisits <= 16384, 'Invalid export visit limit');
  require(Number.isFinite(maxSliceMs) && maxSliceMs > 0 && maxSliceMs <= 8, 'Invalid export slice budget');
  const now = () => realm.performance.now();
  let copied = 0, copiedChars = 0;
  function copySmall(value, depth = 0) {
    require(++copied <= 4096 && depth <= 32, 'Export metadata exceeds its small-copy bound');
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string') {
        copiedChars += value.length;
        require(copiedChars <= 65536, 'Export metadata strings exceed their small-copy bound');
      }
      return value;
    }
    const result = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) Object.defineProperty(result, key, {
      value: copySmall(value[key], depth + 1), enumerable: true, configurable: true, writable: true,
    });
    return result;
  }
  const snapshot = {}, lengths = {}, arrayLimits = new WeakMap();
  for (const key of Object.keys(o)) {
    if (key === 'lastCompact') continue; // Existing success export excluded this duplicate compact graph.
    const value = o[key];
    if (Array.isArray(value)) {
      // Evidence arrays append immutable records; rooms is replaced wholesale.
      // Captured references and lengths fix both cases without copying bodies.
      lengths[key] = value.length;
      arrayLimits.set(value, value.length);
      snapshot[key] = value;
    } else snapshot[key] = copySmall(value);
  }
  const cutoff = { schema: 'cold-observation-cutoff-v1', pageAt: now(), tick: o.tick,
    arrayLengths: lengths, excludedDuplicate: 'lastCompact',
    replacedList: 'rooms',
    scope: 'Captured array prefixes and copied scalar/metadata values; game state and observer handlers keep running',
    maxChunkChars, maxVisits, maxSliceMs };
  snapshot.evidenceCutoff = cutoff;
  const active = new WeakSet(), stack = [{ kind: 'value', value: snapshot, key: null }];
  let number = 0, pending = null, finished = false;
  const health = (details = false) => ({ pageAt: now(), tick: o.tick, errorCount: o.errors.length,
    errors: o.errors.slice(-32), completed: o.completed, prepares: o.prepares.length,
    nativePrepares: o.nativePrepares.length, nativePlayers: o.nativePlayers.length,
    arrayLengths: Object.fromEntries(Object.keys(lengths).map(key => [key, o[key].length])),
    ...(details ? { nativeCallbackTiming: copySmallForHealth(o.nativeCallbackTiming) } : {}),
    status: realm.document?.querySelector('#status')?.dataset.state ?? null });
  function copySmallForHealth(value) {
    copied = 0; copiedChars = 0;
    return copySmall(value);
  }
  function nextEvent() {
    if (stack.length) {
      const frame = stack.at(-1);
      if (frame.kind === 'string') {
        if (frame.offset < frame.value.length) {
          const value = frame.value.slice(frame.offset, frame.offset + 1024);
          frame.offset += value.length;
          return ['part', value];
        }
        stack.pop(); return ['stringEnd'];
      }
      if (frame.kind === 'object' || frame.kind === 'array') {
        if (frame.index === frame.length) {
          stack.pop(); active.delete(frame.value); return ['end', frame.kind];
        }
        const key = frame.kind === 'array' ? frame.index : frame.keys[frame.index];
        frame.index++;
        if (frame.kind === 'array') require(frame.value.length >= frame.length, 'Captured observer array was shortened');
        const value = frame.value[key], type = typeof value;
        if (frame.kind === 'object' && (type === 'undefined' || type === 'function' || type === 'symbol')) return undefined;
        stack.push({ kind: 'value', key, value: frame.kind === 'array'
          && (type === 'undefined' || type === 'function' || type === 'symbol') ? null : value });
        return undefined;
      }
      stack.pop();
      const { key, value } = frame, type = typeof value;
      require(typeof key !== 'string' || key.length <= 1024, 'Oversized native property name in export');
      // The bounded event envelope crosses CDP as JSON text. Preserve native
      // signed zero for the in-memory audit even though JSON encodes it as 0.
      if (type === 'number' && Object.is(value, -0)) return ['negativeZero', key];
      if (value === null || type === 'boolean' || type === 'number')
        return ['value', key, type === 'number' && !Number.isFinite(value) ? null : value];
      if (type === 'string') {
        if (value.length <= 1024) return ['value', key, value];
        stack.push({ kind: 'string', value, offset: 0 });
        return ['string', key];
      }
      require(type === 'object', 'Unsupported non-JSON observation value');
      require(!active.has(value), 'Cyclic native observation cannot be exported');
      const array = Array.isArray(value);
      require(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
        'Non-plain observation object cannot be exported');
      active.add(value);
      const keys = array ? null : Object.keys(value), kind = array ? 'array' : 'object';
      stack.push({ kind, value, keys, index: 0,
        length: array ? arrayLimits.get(value) ?? value.length : keys.length });
      return [kind, key];
    }
    return null;
  }
  realm.__coldObservationExport = {
    cutoff,
    health,
    next() {
      require(!finished, 'Observation export cursor was already exhausted');
      const startedAt = now(), events = [];
      let chars = 2, visits = 0;
      while (visits < maxVisits && (visits === 0 || now() - startedAt < maxSliceMs)) {
        const event = pending ?? nextEvent();
        visits++;
        if (event === null) { finished = true; break; }
        if (event === undefined) continue;
        // Only a bounded primitive event is serialized here, never its graph.
        const encodedLength = JSON.stringify(event).length;
        require(encodedLength + 2 <= maxChunkChars, 'One export event exceeds the chunk bound');
        const added = encodedLength + (events.length ? 1 : 0);
        if (chars + added > maxChunkChars) { pending = event; break; }
        pending = null; events.push(event); chars += added;
      }
      return { number: ++number, events, done: finished, eventJsonChars: chars,
        visits, pageWorkMs: now() - startedAt, health: health() };
    },
  };
  return { cutoff, health: health() };
}

// Reconstruct the original JSON value incrementally on Node. Only primitive
// events are stringified; full graphs and complete observations never are.
export function createColdObservationAssembler(redact = value => value) {
  const stack = [];
  let root, rootSet = false, string = null;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  function attach(key, value) {
    const frame = stack.at(-1);
    if (!frame) { require(!rootSet && key === null, 'Duplicate or invalid export root'); root = value; rootSet = true; return ''; }
    const prefix = frame.count++ ? ',' : '';
    if (frame.kind === 'array') {
      require(key === frame.value.length, 'Nonconsecutive exported array entry');
      frame.value.push(value); return prefix;
    }
    require(typeof key === 'string' && !Object.hasOwn(frame.value, key), 'Duplicate exported object key');
    Object.defineProperty(frame.value, key, { value, enumerable: true, configurable: true, writable: true });
    return prefix + JSON.stringify(redact(key)) + ':';
  }
  function scalar(key, value) {
    const stored = typeof value === 'string' ? (key === 'room' || key === 'token' ? '[redacted]' : redact(value)) : value;
    return attach(key, value) + JSON.stringify(stored);
  }
  return {
    consume(events) {
      const text = [];
      for (const event of events) {
        const [kind, key, value] = event;
        if (kind === 'part') { require(string !== null, 'String part without a start'); string.parts.push(key); continue; }
        if (kind === 'stringEnd') {
          require(string !== null, 'String end without a start');
          text.push(scalar(string.key, string.parts.join(''))); string = null; continue;
        }
        require(string === null, 'Unfinished primitive string');
        if (kind === 'string') { string = { key, parts: [] }; continue; }
        if (kind === 'negativeZero') { text.push(scalar(key, -0)); continue; }
        if (kind === 'value') { text.push(scalar(key, value)); continue; }
        if (kind === 'object' || kind === 'array') {
          const next = kind === 'array' ? [] : {};
          text.push(attach(key, next) + (kind === 'array' ? '[' : '{'));
          stack.push({ kind, value: next, count: 0 }); continue;
        }
        require(kind === 'end' && stack.at(-1)?.kind === key, 'Unbalanced observation export');
        stack.pop(); text.push(key === 'array' ? ']' : '}');
      }
      return text.join('');
    },
    finish() { require(rootSet && !stack.length && string === null, 'Incomplete observation export'); return root; },
  };
}

export async function drainColdObservationExport({ next, write, checkHealth, yieldTurn, redact,
  onChunk = () => {}, maxChunkChars = 131072, maxVisits = 16384 }) {
  const assembler = createColdObservationAssembler(redact);
  const stats = { chunks: 0, visits: 0, eventJsonChars: 0, writtenChars: 0,
    maxEventJsonChars: 0, maxVisits: 0, pageWorkMs: 0, maxPageWorkMs: 0,
    envelopeJsonChars: 0, maxEnvelopeJsonChars: 0 };
  while (true) {
    checkHealth();
    const chunk = await next();
    checkHealth(chunk.health);
    if (chunk.number !== stats.chunks + 1 || chunk.eventJsonChars > maxChunkChars || chunk.visits > maxVisits)
      throw new Error('Observation cursor exceeded its bounded ordered contract');
    const text = assembler.consume(chunk.events);
    // A long primitive string can finish in this chunk. Its file writes are
    // sliced too; no complete object/graph serialization or parsing is used.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + maxChunkChars);
      // Do not hand Node two separately encoded halves of a Unicode surrogate.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      await write(text.slice(offset, end)); offset = end;
      await yieldTurn(); checkHealth();
    }
    stats.chunks++; stats.visits += chunk.visits; stats.eventJsonChars += chunk.eventJsonChars;
    stats.writtenChars += text.length;
    stats.maxEventJsonChars = Math.max(stats.maxEventJsonChars, chunk.eventJsonChars);
    stats.maxVisits = Math.max(stats.maxVisits, chunk.visits);
    stats.pageWorkMs += chunk.pageWorkMs;
    stats.maxPageWorkMs = Math.max(stats.maxPageWorkMs, chunk.pageWorkMs);
    if (Number.isSafeInteger(chunk.envelopeJsonChars)) {
      stats.envelopeJsonChars += chunk.envelopeJsonChars;
      stats.maxEnvelopeJsonChars = Math.max(stats.maxEnvelopeJsonChars, chunk.envelopeJsonChars);
    }
    onChunk(stats, chunk.health);
    // Also yield for an empty/structural slice: progress/error handlers must
    // get an event-loop turn even when there were no file bytes to write.
    await yieldTurn(); checkHealth();
    if (chunk.done) return { observation: assembler.finish(), stats };
  }
}
