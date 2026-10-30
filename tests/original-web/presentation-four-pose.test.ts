import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { OriginalPresentationPump, FOUR_POSE_PRESENTATION_MODE, THREE_POSE_PRESENTATION_MODE,
  type PresentationClock, type PresentationVisibility } from '../../apps/original-web/src/presentation';

type Mode = typeof FOUR_POSE_PRESENTATION_MODE | typeof THREE_POSE_PRESENTATION_MODE;
type Paint = { at: number; nominal: number; tick: number; alpha: number; pose: number };
type PoseRow = [number, number, number];
type PaintRow = [number, number, number];
type Recording = { client: number; firstLiveTick: number; poses: PoseRow[]; paints: PaintRow[] };

function fixture(mode: Mode = FOUR_POSE_PRESENTATION_MODE) {
  let now = 0, next = 0, tick = 0, nominal = 0, hidden = false;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const listeners = new Set<() => void>();
  const paints: Paint[] = [], failures: { at: number; tick: number; error: unknown }[] = [];
  const waits: { at: number; tick: number }[] = [];
  const clock: PresentationClock = { now: () => now,
    request(callback) { callbacks.set(++next, callback); return next; },
    cancel(id) { callbacks.delete(id); } };
  const visibility: PresentationVisibility = { hidden: () => hidden,
    subscribe(changed) { listeners.add(changed); return () => { listeners.delete(changed); }; } };
  const failed = vi.fn((error: unknown) => { failures.push({ at: now, tick, error }); });
  const span = mode === FOUR_POSE_PRESENTATION_MODE ? 3 : 2;
  const present = vi.fn((alpha: number): unknown => {
    const pose = tick - span + span * alpha;
    paints.push({ at: now, nominal, tick, alpha, pose });
    return { version: 1, enabled: true, rendered: true, tick, alpha,
      mode, poseVersion: span, poseTick: pose };
  });
  const pump = new OriginalPresentationPump(present, clock, failed, { mode, visibility });
  // Unit-only inspection of the finite-history guard and bounded clock ring.
  // No native diagnostic callback/API is added to production for these tests.
  const timeline = () => (pump as unknown as { buffered: {
    historyWaitAt: number | null; starts: unknown[]; restoreCanonical: boolean;
  } }).buffered;
  return { pump, present, failed, failures, paints, waits, callbacks, listeners, timeline,
    step(availableAt: number, nextTick: number, startedAt = availableAt, frameMs = 40) {
      now = availableAt; tick = nextTick; pump.stepped(tick, frameMs, startedAt);
    },
    frame(rafAt: number, observedAt = rafAt) {
      nominal = rafAt; now = observedAt;
      for (const [id, callback] of [...callbacks]) if (callbacks.delete(id)) callback(rafAt);
      if (timeline().historyWaitAt !== null) waits.push({ at: observedAt, tick });
    },
    visibility(value: boolean) { hidden = value; for (const listener of [...listeners]) listener(); },
  };
}

const refresh = 1000 / 60;
function continuous(paints: Paint[], firstTick = 1, maxSpeed = 1.05) {
  for (let i = 1; i < paints.length; i++) {
    const previous = paints[i - 1], current = paints[i];
    expect(current.pose, 'no ordinary arrival resets the cursor backwards').toBeGreaterThanOrEqual(previous.pose - 1e-8);
    expect(current.pose - previous.pose, 'visual slew is bounded against actual callback-entry time')
      .toBeLessThanOrEqual(maxSpeed * (current.at - previous.at) / 40 + 1e-8);
    expect(current.pose).toBeLessThanOrEqual(current.tick);
    expect(current.pose).toBeGreaterThanOrEqual(Math.max(firstTick, current.tick - 3) - 1e-8);
  }
}

function recordedFixture(): Recording[] {
  const compressed = readFileSync(new URL('./fixtures/presentation-v9b-recorded-timing.json.gz', import.meta.url));
  expect(createHash('sha256').update(compressed).digest('hex'))
    .toBe('f93e4ada6740c00dda466cd06ffffa3b5ed05cf5d7540ea16e5ae7dd3ac31c8d');
  const raw = gunzipSync(compressed);
  expect(createHash('sha256').update(raw).digest('hex'))
    .toBe('4de9c8ed358047abca3e00648c9da1b7cde0e39018a8f62db9f5077460321966');
  const value = JSON.parse(raw.toString('utf8'));
  expect(value.schema).toBe('boxhead-four-pose-recorded-timing-fixture-v1');
  expect(value.sourceSha256).toBe('1d026c6113ac997588eea1b82a162bab074604bc5527ca19fd7c826e66f2bd50');
  expect(value.clients.map((client: Recording) => [client.client, client.firstLiveTick, client.poses.length]))
    .toEqual([[1, 1, 3876], [2, 3655, 506]]);
  return value.clients;
}

function play(recording: Recording, f = fixture()) {
  const events = [
    ...recording.poses.map(row => ({ kind: 'pose' as const, at: row[1] + row[2], row })),
    ...recording.paints.map(row => ({ kind: 'paint' as const, at: row[1], row })),
  ].sort((a, b) => a.at - b.at || Number(a.kind === 'paint') - Number(b.kind === 'paint'));
  for (const event of events) {
    if (f.failures.length) break;
    if (event.kind === 'pose') f.step(event.at, event.row[0], event.row[1]);
    else f.frame(event.row[0], event.row[1]);
  }
  return f;
}

function regular(count = 400, interval = 40): Recording {
  const poses: PoseRow[] = Array.from({ length: count }, (_, i) => [i + 1, i * interval, 14]);
  const end = poses.at(-1)![1] + 14;
  const paints: PaintRow[] = [];
  for (let frame = 1; frame * refresh <= end; frame++) paints.push([frame * refresh, frame * refresh, 1]);
  return { client: 1, firstLiveTick: 1, poses, paints };
}

describe('explicit four-pose clock: retained timing regressions, not native or FPS evidence', () => {
  it('starts only from an actual captured pose and keeps the existing v2 constructor opt-in separate', () => {
    const f = fixture(); f.frame(10); expect(f.present).not.toHaveBeenCalled();
    f.step(32, 101, 20); f.frame(20, 33.4); f.frame(36, 50);
    expect(f.paints).toEqual([{ at: 33.4, nominal: 20, tick: 101, alpha: 1, pose: 101 }]);
    f.step(75, 102, 60);
    expect(f.paints.at(-1)!.pose).toBe(101);
    // The nominal36/actual50 callback above missed the cadence deadline, so
    // 33.4 remains the last actual sample. At75 the new pose is available but
    // the bounded clock has advanced only41.6ms and must still interpolate.
    f.frame(55, 75);
    expect(f.paints.at(-1)!.pose).toBeGreaterThan(101);
    expect(f.paints.at(-1)!.pose).toBeLessThan(102);
    // The original83.4 sample is50ms after33.4: reaching the known endpoint
    // is valid during startup, before enough history exists for75ms lag.
    f.frame(70, 83.4);
    expect(f.paints.at(-1)!.pose).toBe(102);
    continuous(f.paints, 101);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('preserves the recorded v2 failure as an independent control instead of weakening its old resource guard', () => {
    const recording = recordedFixture()[0], f = play(recording, fixture(THREE_POSE_PRESENTATION_MODE));
    expect(f.failures).toHaveLength(1); expect(f.failures[0].tick).toBe(3438);
    expect(String(f.failures[0].error)).toContain('three-pose history');
    expect(f.callbacks.size).toBe(0);
    // This is the pinned timing-model failure, not a captured old browser
    // warning. The input explicitly lacked actual Present/warning evidence.
  });

  it.each([0, 1])('keeps every retained client%s live timing pose in the bounded history without clock failure or history waits', index => {
    const recording = recordedFixture()[index], f = play(recording);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.waits).toEqual([]);
    expect(f.paints.length).toBeGreaterThan(recording.poses.length);
    continuous(f.paints, recording.firstLiveTick);
    expect(f.timeline().starts.length).toBeLessThanOrEqual(32);
    expect(f.callbacks.size).toBe(1);
    f.pump.close(); expect(f.callbacks.size).toBe(0); expect(f.listeners.size).toBe(0);
  });

  it('uses actual entry for bounded progression when nominal rAF and native availability have different order', () => {
    const f = fixture(); f.step(14, 1, 0); f.frame(0, 15);
    f.step(54, 2, 40); f.frame(33.4, 55); f.frame(50, 60);
    f.step(94, 3, 80); f.frame(66.7, 95); f.frame(83.4, 100);
    f.step(134, 4, 120); f.frame(100, 135);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.waits).toEqual([]); continuous(f.paints);
    expect(f.paints.some(row => row.at - row.nominal > 30)).toBe(true);
  });

  it('repairs rate changes with bounded positive slew and returns to the same75ms nominal target, not115ms', () => {
    const poses: PoseRow[] = [];
    let start = 0;
    for (let tick = 1; tick <= 800; tick++) {
      poses.push([tick, start, 14]); start += tick >= 200 && tick < 350 ? 1000 / 24 : 40;
    }
    const paints: PaintRow[] = [];
    for (let frame = 1; frame * refresh <= poses.at(-1)![1] + 14; frame++) {
      paints.push([frame * refresh, frame * refresh, 1]);
    }
    const f = play({ client: 1, firstLiveTick: 1, poses, paints });
    expect(f.failed).not.toHaveBeenCalled(); expect(f.waits).toEqual([]); continuous(f.paints);
    const rates = f.paints.slice(1).map((row, i) => (row.pose - f.paints[i].pose) * 1000 / (row.at - f.paints[i].at));
    expect(Math.max(...rates)).toBeGreaterThan(25.001); expect(Math.max(...rates)).toBeLessThanOrEqual(26.25 + 1e-6);
    const lastSegment = poses[349], tail = f.paints.filter(row => row.at > poses.at(-1)![1] - 5000);
    const delayTicks = tail.map(row => lastSegment[0] + (row.at - lastSegment[1]) / 40 - row.pose);
    const meanDelayMs = delayTicks.reduce((a, b) => a + b, 0) * 40 / delayTicks.length;
    expect(meanDelayMs).toBeGreaterThan(70); expect(meanDelayMs).toBeLessThan(80);
  });

  it('continues tracking a long24.5TPS source without ordinary cursor resets or a fifth retained interval', () => {
    const f = play(regular(3000, 1000 / 24.5));
    expect(f.failed).not.toHaveBeenCalled(); expect(f.waits).toEqual([]); continuous(f.paints);
    const tail = f.paints.filter(paint => paint.at > 20_000), first = tail[0], last = tail.at(-1)!;
    const rate = (last.pose - first.pose) * 1000 / (last.at - first.at);
    expect(rate).toBeGreaterThan(24.4); expect(rate).toBeLessThan(24.6);
    expect(f.timeline().starts.length).toBe(32);
  });

  it('holds the last known pose during a genuine native stall without extrapolation or repeated endpoint calls', () => {
    const f = play(regular(150)), before = f.paints.at(-1)!.at;
    for (let i = 1; i <= 60; i++) f.frame(before + i * refresh);
    expect(f.paints.at(-1)!.pose).toBe(150); const count = f.paints.length;
    f.frame(before + 2000); f.frame(before + 3000);
    expect(f.paints).toHaveLength(count); expect(f.failed).not.toHaveBeenCalled();
  });

  it('an ordinary arrival at the same actual time cannot assign the visual position', () => {
    const f = play(regular(150)), previous = f.paints.at(-1)!;
    const at = previous.at + 2 * refresh;
    f.step(at - 1, 151, at - 14); f.frame(at, at);
    const current = f.paints.at(-1)!;
    expect(current.tick).toBe(151);
    expect(current.pose).toBeGreaterThanOrEqual(previous.pose);
    expect(current.pose - previous.pose).toBeLessThanOrEqual((at - previous.at) * 1.05 / 40 + 1e-8);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('observed hidden/resume restores canonical once and clears every listener on close', () => {
    const f = play(regular(100)), count = f.paints.length;
    f.visibility(true);
    for (let tick = 101; tick <= 200; tick++) { f.step(40 * tick + 14, tick, 40 * tick); f.frame(40 * tick + 15); }
    expect(f.paints).toHaveLength(count); f.visibility(false); f.frame(8050);
    expect(f.paints).toHaveLength(count + 1); expect(f.paints.at(-1)!.pose).toBe(200);
    f.pump.close(); expect(f.listeners.size).toBe(0); expect(f.callbacks.size).toBe(0);
    f.visibility(true); f.visibility(false); f.frame(9000); expect(f.paints).toHaveLength(count + 1);
  });

  it('an actual discontinuous tick or long unseen paint gap restores once without a replay loop', () => {
    const f = fixture(); f.step(14, 1, 0); f.frame(17);
    f.step(2014, 80, 2000); f.frame(2017); expect(f.paints.at(-1)!.pose).toBe(80);
    for (let tick = 81; tick <= 180; tick++) f.step(2000 + (tick - 80) * 40 + 14, tick, 2000 + (tick - 80) * 40);
    const count = f.paints.length; f.frame(6050);
    expect(f.paints).toHaveLength(count + 1); expect(f.paints.at(-1)!.pose).toBe(180);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('retains a visible finite-history overload failure for an impossible sustained60TPS live stream', () => {
    const f = fixture(); f.step(10, 1, 0); f.frame(17);
    for (let tick = 2; tick <= 40 && !f.failures.length; tick++) {
      f.step(17 + (tick - 1) * 17 + 2, tick, 17 + (tick - 1) * 17 + 1);
      f.frame(17 + tick * 17);
    }
    expect(f.failures).toHaveLength(1); expect(String(f.failures[0].error)).toContain('four-pose history');
    expect(f.callbacks.size).toBe(0); continuous(f.paints);
  });

  it('rejects a regressing actual clock even when nominal rAF timestamps keep increasing', () => {
    const f = fixture(); f.step(14, 1, 0); f.frame(17, 25); f.frame(34, 24);
    expect(f.failures).toHaveLength(1); expect(String(f.failures[0].error)).toContain('not monotonic');
    expect(f.callbacks.size).toBe(0);
  });

  it.each(['v2', 'wrong-version', 'wrong-pose', 'stale-tick'])('rejects %s response after exact four-pose negotiation', fault => {
    const f = fixture();
    f.present.mockImplementation(alpha => ({ version: 1, enabled: true, rendered: true,
      tick: fault === 'stale-tick' ? 0 : 1, mode: fault === 'v2' ? THREE_POSE_PRESENTATION_MODE : FOUR_POSE_PRESENTATION_MODE,
      poseVersion: fault === 'wrong-version' || fault === 'v2' ? 2 : 3,
      poseTick: fault === 'wrong-pose' ? 0.5 : -2 + 3 * alpha }));
    f.step(14, 1, 0); f.frame(17); f.frame(34);
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.present).toHaveBeenCalledTimes(1);
    expect(f.callbacks.size).toBe(0); expect(f.listeners.size).toBe(0);
  });
});
