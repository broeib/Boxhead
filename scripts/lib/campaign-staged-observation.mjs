import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { installNetworkPerformancePaintObserverV2 } from './network-performance-paint-observer-v2.mjs';
import { inspectHardwareGpuWitness, compareHardwareGpuWitnesses } from './network-performance-gpu.mjs';
import { installNativePresentationObserver, recordNativePresentationCall,
  validateNativePresentationRow, createNativePresentationWindow } from './native-presentation-observer.mjs';

export const CAMPAIGN_STAGED_LIMITS = Object.freeze({ pendingIntervals: 4096,
  totalIntervalsPerClient: 500000, captureScopes: 64, gpuWitnessBytes: 1024 * 1024,
  histogramBins: 65536, pendingScreenSubmissions: 16384, totalScreenSubmissionsPerClient: 2000000,
  pendingPresentationCalls: 4096, totalPresentationCallsPerClient: 500000, presentationErrors: 16 });
const BASELINE_SHA256 = '9bd99c83d0037fdb6271fb875413a73e3aabe4a7c6715eec68188eb0bfc7176f';
const sourceFiles = ['campaign-staged-observation.mjs', 'network-performance-paint-observer-v2.mjs', 'network-performance-gpu.mjs',
  'staged-native-snapshot-receipt-observer.mjs', 'staged-native-receipt-adapter.mjs', 'native-presentation-observer.mjs'];
const sha = value => createHash('sha256').update(value).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Self-contained browser installer. It only reads the existing ACK observer's
// tick and the actual WebGL calls. It does not call any native SWF interface.
// The getter makes init-script ordering against __campaign immaterial.
export function installCampaignStagedPaint(globalObject, installPaint, limits) {
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
    const intervals = o.paintSamples, screenSubmissions = o.screenSubmissions, captures = completed.splice(0);
    o.paintSamples = []; o.screenSubmissions = [];
    return { intervals, screenSubmissions, screenTiming: o.screenTiming, captures, openCaptures: active.size, errors: o.errors,
      observation: o.paintObservation, tick: o.tick, presentation: globalObject.__campaignPresentation?.drain() ?? null };
  };
}

function validatePaintInterval(row) {
  assert(finite(row.from) && finite(row.at) && row.at > row.from && finite(row.ms)
    && Math.abs(row.at - row.from - row.ms) < .000001, 'Invalid paint interval');
  assert(Number.isSafeInteger(row.tick) && row.tick > 0);
  assert(Number.isSafeInteger(row.frame) && row.frame >= 0);
  assert(finite(row.observedFrom) && finite(row.observedAt) && row.observedAt >= row.observedFrom
    && finite(row.observedMs) && Math.abs(row.observedAt - row.observedFrom - row.observedMs) < .000001,
  'Invalid actual rAF callback entry interval');
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
      assert(bins.size <= CAMPAIGN_STAGED_LIMITS.histogramBins, 'Timing histogram bound exceeded');
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

export function createCampaignStagedPaintWindow(window, captures = []) {
  assert(Number.isSafeInteger(window.firstTick) && window.firstTick >= 1 && Number.isSafeInteger(window.lastTick)
    && window.lastTick > window.firstTick && finite(window.from) && window.to > window.from);
  for (const capture of captures) assert(finite(capture.from) && capture.to >= capture.from);
  const nominal = histogram(), callback = histogram(), submissionGap = histogram(), submissionSpan = histogram();
  let intervals = 0, elapsedMs = 0, drawIntervals = 0, screenIntervals = 0, draws = 0, screenDraws = 0, blits = 0;
  let boundaryExcluded = 0, actualCallbackIntervals = 0, screenFrames = 0, submissions = 0;
  let firstSubmission = null, previousSubmission = null;
  const longGaps = { gapsOver25ms: 0, gapsOver33_5ms: 0, gapsOver50ms: 0 };
  return {
    observeInterval(row) {
      validatePaintInterval(row);
      // Scheduled rAF and actual callback-entry clocks remain separate. No
      // stage, checkpoint, pilot or screenshot work is cut out of either.
      if (row.observedFrom >= window.from && row.observedAt <= window.to) {
        callback.add(row.observedMs); actualCallbackIntervals++;
      }
      if (row.at <= window.from || row.from >= window.to) return;
      if (row.from < window.from || row.at > window.to) { boundaryExcluded++; return; }
      intervals++; elapsedMs += row.ms; nominal.add(row.ms);
      draws += row.drawCalls; screenDraws += row.defaultFramebufferDrawCalls; blits += row.defaultFramebufferColorBlits;
      if (row.drawCalls > 0) drawIntervals++;
      if (row.defaultFramebufferDrawCalls > 0 || row.defaultFramebufferColorBlits > 0) screenIntervals++;
    },
    observeSubmissionGroup(group) {
      assert(Number.isSafeInteger(group.frame) && group.frame >= 0 && finite(group.firstAt)
        && finite(group.lastAt) && group.lastAt >= group.firstAt && Number.isSafeInteger(group.submissions) && group.submissions > 0);
      if (group.firstAt < window.from || group.lastAt > window.to) return;
      screenFrames++; submissions += group.submissions; submissionSpan.add(group.lastAt - group.firstAt);
      if (previousSubmission !== null) {
        const gap = group.lastAt - previousSubmission; submissionGap.add(gap);
        for (const [key, threshold] of [['gapsOver25ms', 25], ['gapsOver33_5ms', 33.5], ['gapsOver50ms', 50]])
          if (gap > threshold) longGaps[key]++;
      }
      firstSubmission ??= group.lastAt; previousSubmission = group.lastAt;
    },
    summary() {
      const windowMs = window.to - window.from;
      return { ...window, clock: 'This browser performance.now(); no cross-browser clock subtraction',
        nativeTicks: window.lastTick - window.firstTick, nativeBoundaryElapsedMs: windowMs,
        nativeTicksPerSecondIncludingObservationOverhead: (window.lastTick - window.firstTick) * 1000 / windowMs,
        scope: 'Whole ACK-bounded window, including all staged checks, pilot, evidence collection and screenshots; no capture/phase exclusions',
        captureAnnotations: captures.filter(value => value.from < window.to && value.to > window.from).map(value => ({
          id: value.id, label: value.label, from: value.from, to: value.to })),
        nominalRafBuckets: { timingBasis: 'scheduled rAF timestamp argument', intervals, elapsedMs,
          boundaryExcluded, intervalsWithDrawCalls: drawIntervals, intervalsWithDefaultFramebufferSubmissions: screenIntervals,
          intervalsWithDefaultFramebufferSubmissionsPerWindowSecond: screenIntervals * 1000 / windowMs,
          drawCalls: draws, defaultFramebufferDrawCalls: screenDraws, defaultFramebufferColorBlits: blits,
          intervalMs: nominal.summary() },
        actualRafCallbackEntry: { intervals: actualCallbackIntervals, intervalMs: callback.summary() },
        actualScreenSubmissions: { schema: 'boxhead-default-framebuffer-submit-timing-v2', clock: 'same-browser performance.now',
          windowFrom: window.from, windowTo: window.to, windowMs, observedFrames: screenFrames, submissions,
          firstFrameAt: firstSubmission, lastFrameAt: previousSubmission, framesPerWindowSecond: screenFrames * 1000 / windowMs,
          steadySubmissionRate: screenFrames > 1 && previousSubmission > firstSubmission
            ? (screenFrames - 1) * 1000 / (previousSubmission - firstSubmission) : null,
          actualSubmissionGapMs: submissionGap.summary(), withinFrameSubmissionSpanMs: submissionSpan.summary(), ...longGaps,
          scope: 'Successful CPU calls submitting to the actual default framebuffer, grouped by observed rAF bucket; not GPU/display completion or distinct pixels.' } };
    },
  };
}

export function createCampaignScreenGroups(visit) {
  let group = null, previousFrame = -1, previousAt = -Infinity, rows = 0;
  return {
    observe(row) {
      assert(row && Object.keys(row).sort().join(',') === 'at,frame,kind,tick', 'Unexpected screen timestamp fields');
      assert(Number.isSafeInteger(row.frame) && row.frame >= 0 && row.frame >= previousFrame
        && finite(row.at) && row.at >= previousAt && Number.isSafeInteger(row.tick) && row.tick > 0,
      'Screen timestamps are not monotonic');
      assert(row.kind === 'draw' || row.kind === 'color-blit');
      if (group && row.frame !== group.frame) { visit(group); group = null; }
      group ??= { frame: row.frame, firstAt: row.at, lastAt: row.at, submissions: 0 };
      group.lastAt = row.at; group.submissions++;
      previousFrame = row.frame; previousAt = row.at; rows++;
    },
    finish() { if (group) { visit(group); group = null; } return rows; },
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

export async function createCampaignStagedObservation({ out, report, append, bounded }) {
  const sources = await Promise.all(sourceFiles.map(async name => {
    const bytes = await readFile(new URL(name, import.meta.url));
    return { file: 'scripts/lib/' + name, bytes: bytes.length, sha256: sha(bytes) };
  }));
  assert.equal(sha(await readFile(new URL('../original-coop-campaign.mjs', import.meta.url))), BASELINE_SHA256,
    'The original sealed campaign runner changed');
  const clients = [1, 2].map(client => ({ client, intervals: 0, submissions: 0, lastAt: null,
    lastScreenAt: null, lastScreenFrame: null, captures: [], openCaptures: 0, observation: null, screenTiming: null,
    presentations: 0, lastPresentationEnd: null, presentationObservation: null }));
  const data = report.smoothness = { schema: 'original-campaign-staged-observation-v3', revision: 'actual-presentation-pose-clock-v1', requestedGPU: 'hardware',
    originalHarnessSha256: BASELINE_SHA256, sources, sourceClosureVerified: false, limits: CAMPAIGN_STAGED_LIMITS,
    extraNativeCallsByNewObserver: 0, gpuWitnesses: [], joinBoundary: null, captureScopes: [], clients,
    scope: 'Passive actual Ruffle submission wall clocks during the fifteen-wave campaign, including staged checks and all pilot/receipt/collector/capture overhead, separate from the controlled short benchmark.',
    pilotOverhead: 'The original pilot makes its existing stationary bhAnimationProbe only after committed receipt/ACK; an active transaction is observed passively and waited out. The paint observer adds no native calls.',
    timingBoundaries: 'From the actual paired guest-spawn ACK to each actual wave-completion ACK in the same browser. Actual submission buckets fit wholly inside the ACK window; scheduled rAF and actual callback-entry clocks are separate. No stage, native check, screenshot or pilot interval is excluded.',
    displayLimit: 'Successful WebGL CPU-call return is not GPU completion, distinct pixels or physical monitor scan-out. Percentiles use 1 microsecond bins; raw intervals and actual submission timestamps are retained in separately bounded gzip streams.',
    presentation: { schema: 'original-campaign-native-presentation-v1', requiredMode: 'three-pose-v2', poseVersion: 2,
      extraNativeCalls: 0, rawStream: 'client-{1,2}-presentation.ndjson.gz', sharedRawBytesLimit: report.evidence.rawBytesLimit,
      scope: 'Actual existing bhPresent request/return clocks and scalar pose fields. Requested pose progress and rendered replay progress are separate; repeated alpha clamps and trailing holds remain visible. No per-entity motion, distinct-pixel or display completion claim.' } };
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
    assert(Buffer.byteLength(text) <= CAMPAIGN_STAGED_LIMITS.gpuWitnessBytes);
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
      await page.addInitScript('(' + installCampaignStagedPaint.toString() + ')(window,('
        + installNetworkPerformancePaintObserverV2.toString() + '),' + JSON.stringify(CAMPAIGN_STAGED_LIMITS) + ');');
    },
    async observePresentation(page) {
      const install = (installObserver, recordCall, limits) => {
        if (window.__campaignPresentation) throw new Error('Campaign presentation observer installed twice');
        const player = document.querySelector('#original-ruffle-player');
        window.__campaignPresentation = installObserver({ player, now: () => performance.now(), recordCall, limits });
      };
      await page.evaluate('(' + install.toString() + ')((' + installNativePresentationObserver.toString()
        + '),(' + recordNativePresentationCall.toString() + '),'
        + JSON.stringify({ pending: CAMPAIGN_STAGED_LIMITS.pendingPresentationCalls,
          total: CAMPAIGN_STAGED_LIMITS.totalPresentationCallsPerClient, errors: CAMPAIGN_STAGED_LIMITS.presentationErrors }) + ');');
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
      assert(id <= CAMPAIGN_STAGED_LIMITS.captureScopes, 'Global capture evidence bound exceeded');
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
      assert(batch && Array.isArray(batch.intervals) && batch.intervals.length <= CAMPAIGN_STAGED_LIMITS.pendingIntervals,
        'Missing or overflowing passive paint batch');
      assert.deepEqual(batch.errors, [], 'Passive paint observation failed');
      const client = clients[index]; assert(client);
      client.openCaptures = batch.openCaptures; client.observation = batch.observation;
      const presentation = batch.presentation;
      assert(presentation && Array.isArray(presentation.rows)
        && presentation.rows.length <= CAMPAIGN_STAGED_LIMITS.pendingPresentationCalls, 'Missing or overflowing actual Present batch');
      client.presentationObservation = presentation.observation;
      for (const saved of presentation.rows) {
        assert.equal(saved.sequence, ++client.presentations, 'Actual Present sequence skipped or repeated');
        assert(client.presentations <= CAMPAIGN_STAGED_LIMITS.totalPresentationCallsPerClient, 'Total actual Present evidence bound exceeded');
        const { sequence, ...row } = saved;
        // Retain the bounded actual outcome before rejecting it. Failed
        // callbacks remain diagnostic evidence, never successful pose samples.
        append('client-' + (index + 1) + '-presentation', { schema: 'original-staged-campaign-presentation-call-v1',
          client: index + 1, sequence, ...row });
        validateNativePresentationRow(row);
        assert(client.lastPresentationEnd === null || row.at >= client.lastPresentationEnd, 'Actual Present callbacks overlap');
        client.lastPresentationEnd = row.endedAt;
      }
      assert.equal(presentation.observation?.schema, 'original-native-presentation-observer-v1');
      assert.equal(presentation.observation.calls, client.presentations);
      assert.equal(presentation.observation.extraNativeCalls, 0); assert.equal(presentation.observation.dropped, 0);
      assert.equal(presentation.observation.failedCalls, 0); assert.equal(presentation.observation.complete, true);
      assert.deepEqual(presentation.observation.errors, []);
      assert.deepEqual(presentation.observation.limits, { pending: CAMPAIGN_STAGED_LIMITS.pendingPresentationCalls,
        total: CAMPAIGN_STAGED_LIMITS.totalPresentationCallsPerClient, errors: CAMPAIGN_STAGED_LIMITS.presentationErrors });
      assert(Array.isArray(batch.screenSubmissions) && batch.screenSubmissions.length <= CAMPAIGN_STAGED_LIMITS.pendingScreenSubmissions,
        'Missing or overflowing actual submission timestamp batch');
      assert(batch.screenTiming?.schema === 'boxhead-default-framebuffer-submit-clock-v2'
        && batch.screenTiming.dropped === 0 && batch.screenTiming.rows === client.submissions + batch.screenSubmissions.length,
      'Actual submission timestamp coverage differs');
      client.screenTiming = batch.screenTiming;
      for (const row of batch.screenSubmissions) {
        assert(row && Object.keys(row).sort().join(',') === 'at,frame,kind,tick');
        assert(Number.isSafeInteger(row.frame) && row.frame >= 0 && Number.isSafeInteger(row.tick) && row.tick > 0
          && finite(row.at) && (client.lastScreenAt === null || row.at >= client.lastScreenAt)
          && (client.lastScreenFrame === null || row.frame >= client.lastScreenFrame)
          && (row.kind === 'draw' || row.kind === 'color-blit'), 'Actual screen stream ordering differs');
        assert(++client.submissions <= CAMPAIGN_STAGED_LIMITS.totalScreenSubmissionsPerClient, 'Total actual screen evidence bound exceeded');
        client.lastScreenAt = row.at; client.lastScreenFrame = row.frame;
        append('client-' + (index + 1) + '-screen', { schema: 'original-staged-campaign-screen-submission-v2',
          client: index + 1, sequence: client.submissions, ...row });
      }
      for (const capture of batch.captures) {
        assert(client.captures.length < CAMPAIGN_STAGED_LIMITS.captureScopes && finite(capture.from) && capture.to >= capture.from);
        assert(!client.captures.some(value => value.id === capture.id), 'Repeated capture exclusion');
        client.captures.push(capture);
      }
      for (const row of batch.intervals) {
        validatePaintInterval(row);
        assert(++client.intervals <= CAMPAIGN_STAGED_LIMITS.totalIntervalsPerClient, 'Total passive paint evidence bound exceeded');
        assert(finite(row.at) && finite(row.from) && row.at > row.from
          && (client.lastAt === null || row.from >= client.lastAt), 'Paint interval ordering changed');
        client.lastAt = row.at;
        append('client-' + (index + 1) + '-paint', { schema: 'original-staged-campaign-paint-interval-v2',
          client: index + 1, sequence: client.intervals, frame: row.frame, from: row.from, at: row.at, ms: row.ms, tick: row.tick,
          observedFrom: row.observedFrom, observedAt: row.observedAt, observedMs: row.observedMs,
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
      data.harnessSha256 = report.harnessSha256;
      assert.equal(sha(await readFile(new URL('../original-coop-campaign.mjs', import.meta.url))), BASELINE_SHA256);
      assert.equal(sha(await readFile(new URL('../original-coop-campaign-staged.mjs', import.meta.url))), report.harnessSha256,
        'Staged campaign producer changed during observation');
      data.sourceClosureVerified = true;
      if (!report.gameplayPassed || !data.joinBoundary || report.waves.length !== 15) {
        data.complete = false; data.reason = 'The original fifteen-wave campaign did not complete'; return;
      }
      assert.equal(data.gpuWitnesses.length, 4, 'Missing before/after hardware witness');
      for (const witness of data.gpuWitnesses) {
        assert(witness.hardware.pass && (witness.phase === 'before' || witness.matchesBefore));
        const bytes = await readFile(path.join(out, witness.file));
        assert.equal(bytes.length, witness.bytes); assert.equal(sha(bytes), witness.sha256, 'GPU witness file changed');
      }
      assert.equal(data.captureScopes.length, report.captures.length, 'A capture lacks its timing annotation');
      for (let index = 0; index < 2; index++) {
        const client = clients[index], joined = data.joinBoundary[index];
        assert.equal(client.openCaptures, 0, 'Capture annotation remained open');
        const scopes = data.captureScopes.filter(scope => scope.clients.includes(index + 1));
        assert.equal(client.captures.length, scopes.length, 'A capture lacks its local-clock annotation');
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
        const summaries = windows.map(window => createCampaignStagedPaintWindow(window, client.captures));
        const presentationSummaries = windows.map(window => createNativePresentationWindow(window, { requireThreePose: true }));
        const metadata = report.evidence.files.find(row => row.name === 'client-' + (index + 1) + '-paint.ndjson.gz');
        let sequence = 0;
        await eachPaintRow(out, metadata, row => {
          assert.equal(row.schema, 'original-staged-campaign-paint-interval-v2'); assert.equal(row.client, index + 1);
          assert.equal(row.sequence, ++sequence);
          for (const summary of summaries) summary.observeInterval(row);
        });
        assert.equal(sequence, client.intervals);
        const screenMetadata = report.evidence.files.find(row => row.name === 'client-' + (index + 1) + '-screen.ndjson.gz');
        const groups = createCampaignScreenGroups(group => { for (const summary of summaries) summary.observeSubmissionGroup(group); });
        let screenSequence = 0;
        await eachPaintRow(out, screenMetadata, row => {
          assert.equal(row.schema, 'original-staged-campaign-screen-submission-v2'); assert.equal(row.client, index + 1);
          assert.equal(row.sequence, ++screenSequence);
          const { schema, client: clientNumber, sequence: sequenceNumber, ...actual } = row;
          groups.observe(actual);
        });
        assert.equal(groups.finish(), client.submissions); assert.equal(screenSequence, client.submissions);
        client.screenStream = { ...screenMetadata };
        const presentationMetadata = report.evidence.files.find(row => row.name === 'client-' + (index + 1) + '-presentation.ndjson.gz');
        let presentationSequence = 0;
        await eachPaintRow(out, presentationMetadata, row => {
          assert.equal(row.schema, 'original-staged-campaign-presentation-call-v1'); assert.equal(row.client, index + 1);
          assert.equal(row.sequence, ++presentationSequence);
          const { schema, client: clientNumber, sequence: sequenceNumber, ...actual } = row;
          for (const summary of presentationSummaries) summary.observe(actual);
        });
        assert.equal(presentationSequence, client.presentations);
        client.presentationStream = { ...presentationMetadata };
        client.windows = summaries.map((value, index) => ({ ...value.summary(), nativePresentation: presentationSummaries[index].summary() }));
        for (const window of client.windows) {
          assert(window.nominalRafBuckets.intervals > 0 && window.actualScreenSubmissions.observedFrames > 0,
            'An actual combat wave has no measured default-framebuffer submissions');
          const presentation = window.nativePresentation;
          assert(presentation.calls > 0 && presentation.rendered > 0 && presentation.threePose === presentation.calls
            && presentation.legacy === 0, 'Actual combat window lacks the configured three-pose presentation');
          assert.equal(presentation.requestedPose.regressions, 0, 'Requested native pose clock regressed');
          assert.equal(presentation.renderedPose.regressions, 0, 'Rendered replay pose clock regressed');
          assert(presentation.requestedPose.advances > 0 && presentation.renderedPose.advances > 0,
            'Actual combat window repeated a held pose without advancing');
        }
        client.paintStream = { ...metadata };
      }
      data.complete = true;
    },
  };
}
