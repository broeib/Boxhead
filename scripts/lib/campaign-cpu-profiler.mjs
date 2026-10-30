import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

export const CAMPAIGN_CPU_LIMITS = Object.freeze({ minimumWave: 3, minimumZombies: 10,
  durationMs: 20000, samplingIntervalUs: 1000, pollMs: 1000, maximumPolls: 300,
  commandMs: 5000, stopMs: 10000, maximumProfileMs: 45000,
  maximumNodes: 65536, minimumSamples: 1000, maximumSamples: 100000, maximumStackVisits: 2000000,
  maximumProfileBytes: 16 * 1024 * 1024,
  maximumTotalProfileBytes: 32 * 1024 * 1024, maximumManifestBytes: 2 * 1024 * 1024 });
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const compress = promisify(gzip);
const sha = value => createHash('sha256').update(value).digest('hex');

export function sanitizedProfileURL(value) {
  assert.equal(typeof value, 'string');
  assert(value.length <= 16384, 'CPU profile URL bound exceeded');
  if (/^data:/i.test(value)) return '[redacted-data-url]';
  if (/^wss?:/i.test(value)) return '[redacted-debug-endpoint]';
  if (/^blob:https?:/i.test(value)) return 'blob:' + sanitizedProfileURL(value.slice(5));
  if (!/^https?:/i.test(value)) return value;
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return '[unparseable-http-script-url]'; }
}
const redactText = value => String(value).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi,
  value => value.length <= 16384 ? sanitizedProfileURL(value) : '[oversized-url]')
  .replace(/\b(room|token|invitation|inviteUrl)=([^\s&]+)/gi, '$1=[redacted]');
export const sanitizedDiagnosticError = error => redactText(error).slice(0, 2048);

export async function boundedCpu(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
export function waitCpu(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(new Error('CPU diagnostic cancelled')); };
    if (signal?.aborted) return aborted();
    timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
async function allCpu(tasks) {
  const results = await Promise.allSettled(tasks), failed = results.filter(row => row.status === 'rejected');
  if (failed.length) throw new Error(failed.map(row => sanitizedDiagnosticError(row.reason)).join('; '));
}

// Only the diagnostic entrypoint installs this hook. Forward the same receiver,
// arguments, resolved Browser and thrown error. Never retain the endpoint args.
export function captureCampaignBrowsers(chromium) {
  assert(chromium && typeof chromium.connect === 'function');
  const descriptor = Object.getOwnPropertyDescriptor(chromium, 'connect');
  assert(!descriptor || descriptor.configurable, 'Cannot install a reversible diagnostic connect hook');
  const original = chromium.connect, browsers = [], errors = [];
  async function observedConnect(...args) {
    const browser = await Reflect.apply(original, this, args);
    if (browsers.length >= 2 || browsers.includes(browser)) {
      if (errors.length < 8) errors.push('Unexpected duplicate or extra campaign browser');
    }
    else browsers.push(browser);
    return browser;
  }
  Object.defineProperty(chromium, 'connect', { value: observedConnect, configurable: true, writable: true });
  let restored = false;
  return { browsers: () => [...browsers], errors,
    restore() {
      if (restored) return;
      assert.equal(chromium.connect, observedConnect, 'Diagnostic connect hook was replaced');
      if (descriptor) Object.defineProperty(chromium, 'connect', descriptor); else delete chromium.connect;
      assert.equal(chromium.connect, original); restored = true;
    } };
}

// Read the existing observer's scalar records only. No native interface, input,
// paint drain, extra graph, game message, profiler command or mutation occurs.
export async function campaignCpuSnapshot(page) {
  return boundedCpu(page.evaluate(() => {
    const o = window.__campaign, row = o?.lastRecord;
    if (!o || !row) return null;
    return { at: performance.now(), tick: o.tick, ackTick: o.lastAck, recordTick: row.tick,
      wave: row.wave, entityCount: row.entityCount, zombies: row.counters?.zombies,
      devils: row.counters?.devils, localSlot: o.joined?.slot ?? null,
      prepared: Boolean(o.prepare), joined: Boolean(o.firstJoin),
      pendingNative: Boolean(o.stagedPending || o.nativeReceiptPending || o.pending), errors: o.errors.length };
  }), CAMPAIGN_CPU_LIMITS.commandMs, 'Read-only campaign CPU boundary');
}
export function isHeavyCampaignCpuScene(progress, snapshots) {
  if (progress?.stage !== 'playing' || !integer(progress.currentWave) || progress.currentWave < CAMPAIGN_CPU_LIMITS.minimumWave
    || !integer(progress.completedWaves) || progress.completedWaves < CAMPAIGN_CPU_LIMITS.minimumWave - 1
    || !integer(progress.pairedThroughTick) || progress.pairedThroughTick < 1
    || !Array.isArray(snapshots) || snapshots.length !== 2) return false;
  return snapshots.every((row, index) => row && finite(row.at) && integer(row.tick) && row.tick > 0
    && row.ackTick === row.tick && integer(row.recordTick) && row.recordTick >= row.ackTick && row.recordTick <= row.ackTick + 1
    && integer(row.wave) && row.wave >= CAMPAIGN_CPU_LIMITS.minimumWave
    && integer(row.zombies) && row.zombies >= CAMPAIGN_CPU_LIMITS.minimumZombies && integer(row.devils)
    && integer(row.entityCount) && row.entityCount >= row.zombies + row.devils
    && row.localSlot === index + 1 && row.prepared === true && row.joined === true && row.errors === 0);
}

export function summarizeCampaignCpuProfile(profile) {
  assert(profile && Array.isArray(profile.nodes) && profile.nodes.length > 0
    && profile.nodes.length <= CAMPAIGN_CPU_LIMITS.maximumNodes, 'CPU node count bound');
  assert(finite(profile.startTime) && finite(profile.endTime) && profile.endTime > profile.startTime);
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  assert(durationMs <= CAMPAIGN_CPU_LIMITS.maximumProfileMs, 'CPU profile duration bound');
  const samples = profile.samples, deltas = profile.timeDeltas;
  assert(Array.isArray(samples) && samples.length > 0 && samples.length <= CAMPAIGN_CPU_LIMITS.maximumSamples);
  assert(Array.isArray(deltas) && deltas.length === samples.length);
  const nodes = new Map(), parents = new Map(), totals = new Map(), keys = new Map(), weights = new Map();
  for (const node of profile.nodes) {
    assert(integer(node.id) && !nodes.has(node.id));
    assert(node.callFrame && typeof node.callFrame.functionName === 'string' && node.callFrame.functionName.length <= 16384);
    assert(typeof node.callFrame.scriptId === 'string' && node.callFrame.scriptId.length <= 128);
    assert(Number.isInteger(node.callFrame.lineNumber) && Number.isInteger(node.callFrame.columnNumber));
    node.callFrame.url = sanitizedProfileURL(node.callFrame.url);
    node.callFrame.functionName = redactText(node.callFrame.functionName);
    assert(node.children === undefined || Array.isArray(node.children));
    nodes.set(node.id, node);
    const frame = node.callFrame, key = JSON.stringify([frame.functionName, frame.url, frame.scriptId, frame.lineNumber, frame.columnNumber]);
    keys.set(node.id, key);
    if (!totals.has(key)) totals.set(key, { functionName: frame.functionName, url: frame.url,
      scriptId: frame.scriptId, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, selfMs: 0, inclusiveMs: 0 });
  }
  for (const node of nodes.values()) for (const child of node.children ?? []) {
    assert(nodes.has(child) && !parents.has(child), 'CPU profile is not one call tree'); parents.set(child, node.id);
  }
  const roots = [...nodes.keys()].filter(id => !parents.has(id));
  assert.equal(roots.length, 1, 'CPU profile must have exactly one root');
  const reachable = new Set(), pending = [roots[0]];
  while (pending.length) {
    const id = pending.pop(); assert(!reachable.has(id), 'CPU profile call tree contains a cycle');
    reachable.add(id); for (const child of nodes.get(id).children ?? []) pending.push(child);
  }
  assert.equal(reachable.size, nodes.size, 'CPU profile contains unreachable call nodes');
  let sampledUs = 0;
  for (let index = 0; index < samples.length; index++) {
    assert(nodes.has(samples[index]) && finite(deltas[index]), 'Invalid CPU sample/time delta');
    const ms = deltas[index] / 1000; sampledUs += deltas[index];
    weights.set(samples[index], (weights.get(samples[index]) ?? 0) + ms);
  }
  assert(Number.isFinite(sampledUs) && sampledUs <= CAMPAIGN_CPU_LIMITS.maximumProfileMs * 1000, 'CPU sampled time bound');
  let visits = 0;
  for (const [sampleId, ms] of weights) {
    totals.get(keys.get(sampleId)).selfMs += ms;
    const seen = new Set(); let current = sampleId, depth = 0;
    while (current !== undefined) {
      assert(++depth <= nodes.size, 'CPU profile call tree contains a cycle');
      assert(++visits <= CAMPAIGN_CPU_LIMITS.maximumStackVisits, 'CPU stack aggregation work bound');
      const key = keys.get(current);
      if (!seen.has(key)) { totals.get(key).inclusiveMs += ms; seen.add(key); }
      current = parents.get(current);
    }
  }
  const rows = [...totals.values()];
  return { profileStartUs: profile.startTime, profileEndUs: profile.endTime, profileDurationMs: durationMs,
    nodes: nodes.size, samples: samples.length, sampledTimeMs: sampledUs / 1000,
    topSelf: rows.filter(row => row.selfMs > 0).sort((a, b) => b.selfMs - a.selfMs).slice(0, 40),
    topInclusive: rows.filter(row => row.inclusiveMs > 0).sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 40),
    inclusiveScope: 'Weighted sampled call stacks; a recursively repeated function is counted once per stack. Sampling time is not a GPU or physical display measurement.' };
}

export async function captureCampaignCpuWindow({ pages, output, triggerProgress, signal, onState = async () => {},
  wait = waitCpu, clock = () => performance.now() }) {
  assert(Array.isArray(pages) && pages.length === 2);
  const result = { complete: false, status: 'preparing', samplingIntervalUs: CAMPAIGN_CPU_LIMITS.samplingIntervalUs,
    requestedDurationMs: CAMPAIGN_CPU_LIMITS.durationMs, errors: [], recordings: [1, 2].map(client => ({ client, status: 'preparing' })) };
  const captures = result.recordings.map((row, index) => ({ row, page: pages[index], session: null,
    startRequested: false, started: false, stopped: false }));
  let elapsed = false, rawTotal = 0;
  try {
    await allCpu(captures.map(async capture => {
      const pendingSession = Promise.resolve().then(() => capture.page.context().newCDPSession(capture.page));
      try { capture.session = await boundedCpu(pendingSession, CAMPAIGN_CPU_LIMITS.commandMs, 'CPU CDP session'); }
      catch (error) {
        // A timed-out acquisition may still resolve. Detach that late session
        // without waiting indefinitely; the original producer also owns and
        // closes the browser. This attempt remains explicitly incomplete.
        capture.row.lateSessionDetachScheduled = true;
        void pendingSession.then(session => boundedCpu(session.detach(), 2000, 'Late CPU session detach')).catch(() => {});
        throw error;
      }
      await boundedCpu(capture.session.send('Profiler.enable'), CAMPAIGN_CPU_LIMITS.commandMs, 'CPU enable');
      await boundedCpu(capture.session.send('Profiler.setSamplingInterval', { interval: CAMPAIGN_CPU_LIMITS.samplingIntervalUs }),
        CAMPAIGN_CPU_LIMITS.commandMs, 'CPU interval');
      capture.row.before = await campaignCpuSnapshot(capture.page); capture.row.status = 'ready';
    }));
    assert(isHeavyCampaignCpuScene(triggerProgress, captures.map(capture => capture.row.before)),
      'Heavy scene was not present at the profiler start boundary');
    await allCpu(captures.map(async capture => {
      capture.row.startRequestAtNodeMs = clock();
      capture.startRequested = true;
      await boundedCpu(capture.session.send('Profiler.start'), CAMPAIGN_CPU_LIMITS.commandMs, 'CPU start');
      capture.started = true; capture.row.startResolvedAtNodeMs = clock(); capture.row.status = 'recording';
      capture.row.firstObservedAfterStart = await campaignCpuSnapshot(capture.page);
    }));
    result.status = 'recording'; await onState(result);
    await wait(CAMPAIGN_CPU_LIMITS.durationMs, signal); elapsed = true;
  } catch (error) { result.errors.push(sanitizedDiagnosticError(error)); }
  finally {
    result.status = 'stopping';
    await Promise.all(captures.map(async capture => {
      try {
        if (!capture.startRequested) { capture.row.status = 'not-started'; return; }
        capture.row.stopRequestAtNodeMs = clock();
        const { profile } = await boundedCpu(capture.session.send('Profiler.stop'), CAMPAIGN_CPU_LIMITS.stopMs, 'CPU stop');
        capture.stopped = true; capture.row.stopResolvedAtNodeMs = clock();
        capture.row.after = await campaignCpuSnapshot(capture.page).catch(() => null);
        const summary = summarizeCampaignCpuProfile(profile), raw = Buffer.from(JSON.stringify(profile) + '\n');
        assert(raw.length <= CAMPAIGN_CPU_LIMITS.maximumProfileBytes, 'CPU profile byte bound');
        rawTotal += raw.length; assert(rawTotal <= CAMPAIGN_CPU_LIMITS.maximumTotalProfileBytes);
        const compressed = await compress(raw), name = 'client-' + capture.row.client + '.cpuprofile.gz';
        assert(compressed.length <= CAMPAIGN_CPU_LIMITS.maximumProfileBytes, 'Compressed CPU profile byte bound');
        await writeFile(path.join(output, name), compressed, { flag: 'wx' });
        Object.assign(capture.row, summary, { status: elapsed && summary.profileDurationMs >= CAMPAIGN_CPU_LIMITS.durationMs
          && summary.samples >= CAMPAIGN_CPU_LIMITS.minimumSamples ? 'captured' : 'captured-partial',
          file: name, rawBytes: raw.length, rawSha256: sha(raw), compressedBytes: compressed.length, sha256: sha(compressed),
          redaction: 'HTTP(S) script queries/fragments/credentials, debug endpoint URLs and data URLs are redacted. Nodes, edges, samples and time deltas remain retained.' });
      } catch (error) { capture.row.status = 'failed'; capture.row.error = sanitizedDiagnosticError(error); result.errors.push(capture.row.error); }
      finally {
        if (capture.session) {
          try { await boundedCpu(capture.session.send('Profiler.disable'), CAMPAIGN_CPU_LIMITS.commandMs, 'CPU disable'); capture.row.disabled = true; }
          catch (error) { capture.row.disabled = false; capture.row.disableError = sanitizedDiagnosticError(error); }
          try { await boundedCpu(capture.session.detach(), 2000, 'CPU session detach'); capture.row.detached = true; }
          catch (error) { capture.row.detached = false; capture.row.detachError = sanitizedDiagnosticError(error); }
        }
      }
    }));
  }
  result.complete = elapsed && result.errors.length === 0
    && result.recordings.every(row => row.status === 'captured' && row.disabled && row.detached && row.before && row.after
      && row.after.errors === 0 && row.after.at >= row.before.at && row.after.ackTick >= row.before.ackTick);
  result.status = result.complete ? 'captured' : 'incomplete'; result.rawProfileBytes = rawTotal;
  await onState(result); return result;
}
