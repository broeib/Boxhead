import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { installNetworkPerformancePaintObserver } from './network-performance-paint-observer.mjs';
import { inspectHardwareGpuWitness, compareHardwareGpuWitnesses } from './network-performance-gpu.mjs';

export const CAMPAIGN_SMOOTH_LIMITS = Object.freeze({ pendingIntervals: 4096,
  totalIntervalsPerClient: 500000, captureScopes: 64, gpuWitnessBytes: 1024 * 1024,
  histogramBins: 65536, captureGuardMs: 1000 / 60 });
const BASELINE_SHA256 = '9bd99c83d0037fdb6271fb875413a73e3aabe4a7c6715eec68188eb0bfc7176f';
const sourceFiles = ['campaign-smooth-observation.mjs', 'network-performance-paint-observer.mjs', 'network-performance-gpu.mjs'];
const sha = value => createHash('sha256').update(value).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Self-contained browser installer. It only reads the existing ACK observer's
// tick and the actual WebGL calls. It does not call any native SWF interface.
// The getter makes init-script ordering against __campaign immaterial.
export function installCampaignSmoothPaint(globalObject, installPaint, limits) {
  if (globalObject.__campaignPaint) throw new Error('Campaign paint observer installed twice');
  const o = globalObject.__campaignPaint = { errors: [] };
  Object.defineProperty(o, 'tick', { get: () => globalObject.__campaign?.tick ?? 0 });
  const active = new Map(), completed = [];
  let captureCount = 0, lastCaptureId = 0;
  o.captureBoundary = (id, phase, label) => {
    if (!Number.isSafeInteger(id) || id < 1 || typeof label !== 'string' || label.length > 128)
      throw new Error('Invalid passive capture boundary');
    const at = globalObject.performance.now();
    if (phase === 'begin') {
      if (id <= lastCaptureId || active.has(id) || ++captureCount > limits.captureScopes) throw new Error('Capture evidence bound exceeded');
      lastCaptureId = id;
      active.set(id, { id, label, from: at, tickBefore: o.tick });
    } else if (phase === 'end') {
      const start = active.get(id);
      if (!start || start.label !== label) throw new Error('Unmatched passive capture boundary');
      completed.push({ ...start, to: at, tickAfter: o.tick }); active.delete(id);
    } else throw new Error('Unknown passive capture phase');
  };
  installPaint(globalObject, o, limits.pendingIntervals);
  o.drain = () => {
    const intervals = o.paintSamples, captures = completed.splice(0);
    o.paintSamples = [];
    return { intervals, captures, openCaptures: active.size, errors: o.errors,
      observation: o.paintObservation, tick: o.tick };
  };
}

function validatePaintInterval(row) {
  assert(finite(row.from) && finite(row.at) && row.at > row.from && finite(row.ms)
    && Math.abs(row.at - row.from - row.ms) < .000001, 'Invalid paint interval');
  assert(Number.isSafeInteger(row.tick) && row.tick > 0);
  for (const key of ['drawCalls', 'defaultFramebufferDrawCalls', 'defaultFramebufferColorBlits'])
    assert(Number.isSafeInteger(row[key]) && row[key] >= 0, 'Invalid passive draw count');
}

function histogram() {
  const bins = new Map();
  let count = 0, sum = 0, min = Infinity, max = -Infinity;
  return {
    add(value) {
      assert(finite(value), 'Invalid passive timing');
      const rounded = Math.round(value * 1000) / 1000;
      bins.set(rounded, (bins.get(rounded) ?? 0) + 1);
      assert(bins.size <= CAMPAIGN_SMOOTH_LIMITS.histogramBins, 'Timing histogram bound exceeded');
      count++; sum += value; min = Math.min(min, value); max = Math.max(max, value);
    },
    summary() {
      if (!count) return { count: 0 };
      const sorted = [...bins].sort((a, b) => a[0] - b[0]);
      const percentile = p => {
        const target = Math.floor((count - 1) * p); let seen = 0;
        for (const [value, frequency] of sorted) { seen += frequency; if (seen > target) return value; }
        throw new Error('Timing histogram is inconsistent');
      };
      return { count, mean: sum / count, min, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max,
        percentilePrecisionMs: .001 };
    },
  };
}

export function createCampaignPaintWindow(window, captures, guardMs = CAMPAIGN_SMOOTH_LIMITS.captureGuardMs) {
  assert(Number.isSafeInteger(window.firstTick) && window.firstTick >= 1 && Number.isSafeInteger(window.lastTick)
    && window.lastTick > window.firstTick && finite(window.from) && window.to > window.from);
  assert(finite(guardMs));
  for (const capture of captures) assert(finite(capture.from) && capture.to >= capture.from);
  const interval = histogram(), submissionGap = histogram();
  let previousSubmission = null, intervals = 0, elapsedMs = 0, drawIntervals = 0, screenIntervals = 0;
  let draws = 0, screenDraws = 0, blits = 0, boundaryExcluded = 0, captureExcluded = 0, tickExcluded = 0;
  const longGaps = { over25Ms: 0, over34Ms: 0, over50Ms: 0, over100Ms: 0 };
  return {
    observe(row) {
      validatePaintInterval(row);
      if (row.at <= window.from || row.from >= window.to) { previousSubmission = null; return; }
      if (row.from < window.from || row.at > window.to) { boundaryExcluded++; previousSubmission = null; return; }
      if (row.tick < window.firstTick || row.tick > window.lastTick) { tickExcluded++; previousSubmission = null; return; }
      if (captures.some(value => row.from < value.to + guardMs && row.at > value.from - guardMs)) {
        captureExcluded++; previousSubmission = null; return;
      }
      intervals++; elapsedMs += row.ms; interval.add(row.ms);
      draws += row.drawCalls; screenDraws += row.defaultFramebufferDrawCalls; blits += row.defaultFramebufferColorBlits;
      if (row.drawCalls > 0) drawIntervals++;
      if (row.defaultFramebufferDrawCalls > 0 || row.defaultFramebufferColorBlits > 0) {
        screenIntervals++;
        if (previousSubmission !== null) {
          const gap = row.at - previousSubmission; submissionGap.add(gap);
          for (const [key, threshold] of [['over25Ms', 25], ['over34Ms', 34], ['over50Ms', 50], ['over100Ms', 100]])
            if (gap > threshold) longGaps[key]++;
        }
        previousSubmission = row.at;
      }
    },
    summary() {
      return { ...window, clock: 'This browser performance.now(); no cross-browser clock subtraction',
        nativeTicks: window.lastTick - window.firstTick,
        nativeBoundaryElapsedMs: window.to - window.from,
        nativeTicksPerSecondIncludingCaptureOverhead: (window.lastTick - window.firstTick) * 1000 / (window.to - window.from),
        eligiblePaintIntervals: intervals, eligiblePaintDurationMs: elapsedMs,
        coverageOfNativeBoundaryTime: elapsedMs / (window.to - window.from),
        excludedIntervals: { boundary: boundaryExcluded, capture: captureExcluded, tick: tickExcluded },
        intervalsWithDrawCalls: drawIntervals, intervalsWithDefaultFramebufferSubmissions: screenIntervals,
        intervalsWithDefaultFramebufferSubmissionsPerSecond: elapsedMs ? screenIntervals * 1000 / elapsedMs : null,
        drawCalls: draws, defaultFramebufferDrawCalls: screenDraws, defaultFramebufferColorBlits: blits,
        intervalMs: interval.summary(), defaultFramebufferSubmissionIntervalMs: submissionGap.summary(),
        submissionGaps: longGaps };
    },
  };
}

async function eachPaintRow(out, metadata, visit) {
  assert(metadata && /^[a-z0-9-]+\.ndjson\.gz$/.test(metadata.name), 'Missing compressed paint stream');
  const input = createReadStream(path.join(out, metadata.name)), unzip = createGunzip(), hash = createHash('sha256');
  let compressedBytes = 0, rawBytes = 0, records = 0;
  input.on('data', chunk => { compressedBytes += chunk.length; hash.update(chunk); });
  input.on('error', error => unzip.destroy(error));
  input.pipe(unzip);
  const lines = createInterface({ input: unzip, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      rawBytes += Buffer.byteLength(line) + 1; records++;
      assert(line.length <= 16384 && rawBytes <= metadata.rawBytes && records <= metadata.records,
        'Compressed paint evidence exceeds its manifest');
      visit(JSON.parse(line));
    }
    assert.equal(records, metadata.records); assert.equal(rawBytes, metadata.rawBytes);
    assert.equal(compressedBytes, metadata.compressedBytes); assert.equal(hash.digest('hex'), metadata.sha256);
  } finally { lines.close(); input.destroy(); unzip.destroy(); }
}

export async function createCampaignSmoothObservation({ out, report, append, bounded }) {
  const sources = await Promise.all(sourceFiles.map(async name => {
    const bytes = await readFile(new URL(name, import.meta.url));
    return { file: 'scripts/lib/' + name, bytes: bytes.length, sha256: sha(bytes) };
  }));
  assert.equal(sha(await readFile(new URL('../original-coop-campaign.mjs', import.meta.url))), BASELINE_SHA256,
    'The original sealed campaign runner changed');
  const clients = [1, 2].map(client => ({ client, intervals: 0, lastAt: null, captures: [], openCaptures: 0, observation: null }));
  const data = report.smoothness = { schema: 'original-campaign-smooth-observation-v1', requestedGPU: 'hardware',
    originalHarnessSha256: BASELINE_SHA256, sources, sourceClosureVerified: false, limits: CAMPAIGN_SMOOTH_LIMITS,
    extraNativeCallsByNewObserver: 0, gpuWitnesses: [], joinBoundary: null, captureScopes: [], clients,
    scope: 'Passive actual Ruffle default-framebuffer submissions during the unchanged fifteen-wave campaign. This is combat evidence with pilot/receipt/collector overhead, separate from the controlled short FPS benchmark.',
    pilotOverhead: 'The sealed pilot retains read-only bhAnimationProbe calls while stationary. New observation adds no native calls and does not change that pilot.',
    timingBoundaries: 'From the actual paired guest-spawn ACK to each actual wave-completion ACK in the same browser. Paint intervals must fit completely inside the native boundary window. Every screenshot is excluded in each existing browser clock with one 60 Hz opportunity of guard on each side. Native boundary elapsed/TPS still include capture overhead.',
    displayLimit: 'WebGL submission is not proof of GPU completion, distinct pixels or physical monitor scan-out. Percentiles use 1 microsecond bins; raw intervals are retained in bounded compressed streams.' };
  let captureId = 0;

  async function captureHardware(page, browser, index, phase) {
    const artifact = { schema: 'boxhead-browser-gpu-diagnostic-v2', client: index + 1, phase,
      requestedMode: 'hardware', capturedAt: new Date().toISOString(), browserVersion: browser.version(),
      gpu: null, actualRuffleContexts: null, errors: [] };
    let session;
    try {
      session = await bounded(browser.newBrowserCDPSession(), 5000, 'GPU CDP session timeout');
      const system = await bounded(session.send('SystemInfo.getInfo'), 5000, 'GPU CDP witness timeout');
      artifact.gpu = system.gpu; // No command line, hostname or machine identifier.
    } catch (error) { artifact.errors.push('CDP SystemInfo: ' + String(error)); }
    finally { await session?.detach().catch(() => {}); }
    try {
      const observed = await bounded(page.evaluate(() => {
        const o = window.__campaignPaint;
        return { at: performance.now(), tick: window.__campaign?.tick ?? 0,
          visibility: document.visibilityState, gpu: o.readObservedWebGLGPU() };
      }), 5000, 'Actual Ruffle GPU witness timeout');
      artifact.actualRuffleContexts = observed.gpu;
      artifact.observedAt = observed.at; artifact.observedTick = observed.tick; artifact.visibility = observed.visibility;
    } catch (error) { artifact.errors.push('Actual Ruffle context: ' + String(error)); }
    artifact.hardware = inspectHardwareGpuWitness(artifact.gpu, artifact.actualRuffleContexts);
    if (artifact.visibility !== 'visible') artifact.errors.push('Measured game document is not visible');
    if (phase === 'before' && artifact.observedTick !== 0) artifact.errors.push('Before witness was captured after native gameplay started');
    if (phase === 'after' && report.completedAtTick !== undefined && artifact.observedTick < report.completedAtTick)
      artifact.errors.push('After witness precedes the completed combat window');
    if (artifact.errors.length) { artifact.hardware.pass = false; artifact.hardware.problems.push(...artifact.errors); }
    const text = JSON.stringify(artifact, null, 2) + '\n';
    assert(Buffer.byteLength(text) <= CAMPAIGN_SMOOTH_LIMITS.gpuWitnessBytes);
    const file = 'client-' + (index + 1) + '-gpu-' + phase + '.json';
    await writeFile(path.join(out, file), text, { flag: 'wx' });
    const row = { client: index + 1, phase, file, bytes: Buffer.byteLength(text), sha256: sha(text),
      observedAt: artifact.observedAt, observedTick: artifact.observedTick, visibility: artifact.visibility, hardware: artifact.hardware };
    data.gpuWitnesses.push(row);
    assert.equal(row.hardware.pass, true, 'Campaign hardware witness rejected: ' + row.hardware.problems.join('; '));
    if (phase === 'after') {
      const before = data.gpuWitnesses.find(value => value.client === index + 1 && value.phase === 'before');
      row.matchesBefore = compareHardwareGpuWitnesses(before?.hardware, row.hardware);
      assert.equal(row.matchesBefore, true, 'Campaign GPU changed across the native combat window');
    }
  }

  return {
    async install(page) {
      await page.addInitScript('(' + installCampaignSmoothPaint.toString() + ')(window,('
        + installNetworkPerformancePaintObserver.toString() + '),' + JSON.stringify(CAMPAIGN_SMOOTH_LIMITS) + ');');
    },
    recordJoin(pair) {
      assert.equal(data.joinBoundary, null, 'Repeated passive guest-spawn boundary');
      assert.equal(pair.length, 2); assert.equal(pair[0].tick, pair[1].tick);
      data.joinBoundary = pair.map((row, index) => {
        assert(row.frame?.join && row.ack.tick === row.tick && row.ack.digest === row.digest && finite(row.ack.at));
        return { client: index + 1, tick: row.tick, at: row.ack.at, digest: row.digest };
      });
    },
    async beginCapture(pages, label) {
      const id = ++captureId;
      assert(id <= CAMPAIGN_SMOOTH_LIMITS.captureScopes, 'Global capture evidence bound exceeded');
      data.captureScopes.push({ id, label, clients: pages.map((_, index) => index + 1) });
      await Promise.all(pages.map(page => bounded(page.evaluate(({ id, label }) => {
        window.__campaignPaint.captureBoundary(id, 'begin', label);
      }, { id, label }), 5000, 'Capture exclusion start timeout')));
      return id;
    },
    async endCapture(pages, id, label) {
      await Promise.all(pages.map(page => bounded(page.evaluate(({ id, label }) => {
        window.__campaignPaint.captureBoundary(id, 'end', label);
      }, { id, label }), 5000, 'Capture exclusion end timeout')));
    },
    consume(index, batch) {
      assert(batch && Array.isArray(batch.intervals) && batch.intervals.length <= CAMPAIGN_SMOOTH_LIMITS.pendingIntervals,
        'Missing or overflowing passive paint batch');
      assert.deepEqual(batch.errors, [], 'Passive paint observation failed');
      const client = clients[index]; assert(client);
      client.openCaptures = batch.openCaptures; client.observation = batch.observation;
      for (const capture of batch.captures) {
        assert(client.captures.length < CAMPAIGN_SMOOTH_LIMITS.captureScopes && finite(capture.from) && capture.to >= capture.from);
        assert(!client.captures.some(value => value.id === capture.id), 'Repeated capture exclusion');
        client.captures.push(capture);
      }
      for (const row of batch.intervals) {
        validatePaintInterval(row);
        assert(++client.intervals <= CAMPAIGN_SMOOTH_LIMITS.totalIntervalsPerClient, 'Total passive paint evidence bound exceeded');
        assert(finite(row.at) && finite(row.from) && row.at > row.from
          && (client.lastAt === null || row.from >= client.lastAt), 'Paint interval ordering changed');
        client.lastAt = row.at;
        append('client-' + (index + 1) + '-paint', { schema: 'original-campaign-paint-interval-v1',
          client: index + 1, sequence: client.intervals, from: row.from, at: row.at, ms: row.ms, tick: row.tick,
          drawCalls: row.drawCalls, defaultFramebufferDrawCalls: row.defaultFramebufferDrawCalls,
          defaultFramebufferColorBlits: row.defaultFramebufferColorBlits });
      }
    },
    async captureHardware(pages, browsers, phase) {
      for (let index = 0; index < pages.length; index++) {
        if (data.gpuWitnesses.some(row => row.client === index + 1 && row.phase === phase)) continue;
        await captureHardware(pages[index], browsers[index], index, phase);
      }
    },
    async finish() {
      for (const source of sources) {
        const bytes = await readFile(new URL(path.basename(source.file), import.meta.url));
        assert.equal(bytes.length, source.bytes); assert.equal(sha(bytes), source.sha256, 'Passive observer source changed');
      }
      data.sourceClosureVerified = true;
      data.harnessSha256 = report.harnessSha256;
      assert.equal(sha(await readFile(new URL('../original-coop-campaign.mjs', import.meta.url))), BASELINE_SHA256);
      if (!report.gameplayPassed || !data.joinBoundary || report.waves.length !== 15) {
        data.complete = false; data.reason = 'The original fifteen-wave campaign did not complete'; return;
      }
      assert.equal(data.gpuWitnesses.length, 4, 'Missing before/after hardware witness');
      for (const witness of data.gpuWitnesses) {
        assert(witness.hardware.pass && (witness.phase === 'before' || witness.matchesBefore));
        const bytes = await readFile(path.join(out, witness.file));
        assert.equal(bytes.length, witness.bytes); assert.equal(sha(bytes), witness.sha256, 'GPU witness file changed');
      }
      assert.equal(data.captureScopes.length, report.captures.length, 'A capture lacks exclusion scope evidence');
      for (let index = 0; index < 2; index++) {
        const client = clients[index], joined = data.joinBoundary[index];
        assert.equal(client.openCaptures, 0, 'Capture exclusion remained open');
        const scopes = data.captureScopes.filter(scope => scope.clients.includes(index + 1));
        assert.equal(client.captures.length, scopes.length, 'A capture lacks local-clock exclusion evidence');
        const captureNames = new Set(report.captures.map(row => row.name));
        for (const capture of client.captures) {
          assert(captureNames.has(capture.label));
          assert(scopes.some(scope => scope.id === capture.id && scope.label === capture.label));
        }
        assert.equal(joined.tick, report.join.tick);
        const waveEnd = wave => {
          const timing = wave.clientTiming.find(value => value.client === index + 1);
          assert(timing?.lastAck?.tick === wave.completedTick && finite(timing.lastAck.at));
          return { tick: wave.completedTick, at: timing.lastAck.at };
        };
        const makeWindow = (name, start, end) => ({ name, firstTick: start.tick, lastTick: end.tick, from: start.at, to: end.at });
        const windows = [makeWindow('first-ten-waves', joined, waveEnd(report.waves[9])),
          makeWindow('full-fifteen-waves', joined, waveEnd(report.waves[14]))];
        let previous = joined;
        for (const wave of report.waves) {
          const end = waveEnd(wave); windows.push(makeWindow('wave-' + wave.wave, previous, end)); previous = end;
        }
        const summaries = windows.map(window => createCampaignPaintWindow(window, client.captures));
        const metadata = report.evidence.files.find(row => row.name === 'client-' + (index + 1) + '-paint.ndjson.gz');
        let sequence = 0;
        await eachPaintRow(out, metadata, row => {
          assert.equal(row.schema, 'original-campaign-paint-interval-v1'); assert.equal(row.client, index + 1);
          assert.equal(row.sequence, ++sequence);
          for (const summary of summaries) summary.observe(row);
        });
        assert.equal(sequence, client.intervals);
        client.windows = summaries.map(value => value.summary());
        for (const window of client.windows) {
          assert(window.eligiblePaintIntervals > 0 && window.intervalsWithDefaultFramebufferSubmissions > 0,
            'An actual combat wave has no measured default-framebuffer submissions');
        }
        client.paintStream = { ...metadata };
      }
      data.complete = true;
    },
  };
}
