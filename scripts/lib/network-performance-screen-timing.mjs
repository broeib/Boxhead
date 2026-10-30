import assert from 'node:assert/strict';

function stats(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.floor((sorted.length - 1) * p)];
  return { count: values.length, min: sorted[0], p50: percentile(0.5), p95: percentile(0.95),
    p99: percentile(0.99), max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
}

/** Actual submission wall-clock pacing, deliberately separate from nominal
 * rAF intervals and bucketed draw counts. Use one browser's monotonic clock.
 * Multiple default-framebuffer passes inside one rAF bucket count once. */
export function summarizeScreenSubmissionTiming(rows, from, to) {
  assert(Array.isArray(rows));
  assert(Number.isFinite(from) && from >= 0 && Number.isFinite(to) && to > from);
  let priorFrame = -1, priorAt = -Infinity;
  const grouped = [];
  for (const row of rows) {
    assert(row && Object.keys(row).sort().join(',') === 'at,frame,kind,tick', 'Unexpected screen timing row');
    assert(Number.isSafeInteger(row.frame) && row.frame >= 0 && row.frame >= priorFrame, 'Submission frame order changed');
    assert(Number.isFinite(row.at) && row.at >= 0 && row.at >= priorAt, 'Submission monotonic clock moved backwards');
    assert(Number.isSafeInteger(row.tick) && row.tick > 0);
    assert(row.kind === 'draw' || row.kind === 'color-blit');
    priorFrame = row.frame; priorAt = row.at;
    let frame = grouped.at(-1);
    if (!frame || frame.frame !== row.frame) {
      frame = { frame: row.frame, firstAt: row.at, lastAt: row.at, submissions: 0 }; grouped.push(frame);
    }
    frame.lastAt = row.at; frame.submissions++;
  }
  // Count only entire buckets whose submissions all belong to this window.
  // No gaps at the selected first/last ACK boundaries are invented or hidden.
  const frames = grouped.filter(frame => frame.firstAt >= from && frame.lastAt <= to);
  const gaps = frames.slice(1).map((frame, i) => frame.lastAt - frames[i].lastAt);
  const first = frames[0], last = frames.at(-1);
  return {
    schema: 'boxhead-default-framebuffer-submit-timing-v2', clock: 'same-browser performance.now',
    windowFrom: from, windowTo: to, windowMs: to - from,
    observedFrames: frames.length, submissions: frames.reduce((sum, frame) => sum + frame.submissions, 0),
    firstFrameAt: first?.lastAt ?? null, lastFrameAt: last?.lastAt ?? null,
    framesPerWindowSecond: frames.length * 1000 / (to - from),
    steadySubmissionRate: frames.length > 1 && last.lastAt > first.lastAt
      ? (frames.length - 1) * 1000 / (last.lastAt - first.lastAt) : null,
    actualSubmissionGapMs: stats(gaps), withinFrameSubmissionSpanMs: stats(frames.map(frame => frame.lastAt - frame.firstAt)),
    gapsOver25ms: gaps.filter(ms => ms > 25).length,
    gapsOver33_5ms: gaps.filter(ms => ms > 33.5).length,
    gapsOver50ms: gaps.filter(ms => ms > 50).length,
    scope: 'Successful CPU calls submitting to the actual default framebuffer, grouped by observed rAF bucket; not GPU/display completion or distinct pixels.',
  };
}
