import { describe, expect, it, vi } from 'vitest';
import { OriginalPresentationPump, THREE_POSE_PRESENTATION_MODE,
  type PresentationClock, type PresentationVisibility } from '../../apps/original-web/src/presentation';

type Paint = { at: number; tick: number; alpha: number; pose: number };

function fixture() {
  let now = 0, next = 0, tick = 0, hidden = false;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const listeners = new Set<() => void>();
  const paints: Paint[] = [];
  const clock: PresentationClock = { now: () => now,
    request(callback) { callbacks.set(++next, callback); return next; },
    cancel(id) { callbacks.delete(id); } };
  const visibility: PresentationVisibility = { hidden: () => hidden,
    subscribe(changed) { listeners.add(changed); return () => { listeners.delete(changed); }; } };
  const failed = vi.fn();
  const present = vi.fn((alpha: number): unknown => {
    const pose = tick - 2 + 2 * alpha;
    paints.push({ at: now, tick, alpha, pose });
    return { version: 1, enabled: true, rendered: true, tick, alpha,
      mode: THREE_POSE_PRESENTATION_MODE, poseVersion: 2, poseTick: pose };
  });
  const pump = new OriginalPresentationPump(present, clock, failed,
    { mode: THREE_POSE_PRESENTATION_MODE, visibility });
  return { pump, present, failed, paints, callbacks, listeners,
    step(availableAt: number, nextTick: number, startedAt = availableAt, frameMs = 40) {
      now = availableAt; tick = nextTick; pump.stepped(tick, frameMs, startedAt);
    },
    frame(at: number) {
      now = at;
      for (const [id, callback] of [...callbacks]) if (callbacks.delete(id)) callback(at);
    },
    visibility(value: boolean) { hidden = value; for (const listener of [...listeners]) listener(); },
  };
}

const refresh = 1000 / 60;
type Step = { tick: number; start: number; available: number; release: number };
type Block = { from: number; to: number };

/**
 * Scheduling model only, not a native game or an FPS measurement. Every pose
 * becomes available AFTER its actual callback cost. Full steps expose their
 * pose after Begin, retain the owner through the measured remaining phases,
 * and let the following compact step start only after a subsequent paint.
 */
function alignedStream({ count = 350, interval = 40, staged = false,
  worstBegin = false, costs = [10, 15, 20] } = {}) {
  const steps: Step[] = [], blocks: Block[] = [];
  const afterPaint = (at: number) => Math.ceil((at + 1e-7) / refresh) * refresh + 0.25;
  let release = -1;
  for (let index = 0; index < count; index++) {
    const tick = index + 1;
    const start = afterPaint(Math.max(index * interval, release));
    const full = staged && tick % 25 === 0;
    const cost = full ? (worstBegin ? 20 : 10) : costs[index % costs.length];
    const available = start + cost;
    blocks.push({ from: start, to: available });
    release = available;
    if (full) {
      for (const phaseMs of [6.4, 14.8, 9.6]) {
        const phaseAt = afterPaint(release);
        blocks.push({ from: phaseAt, to: phaseAt + phaseMs });
        release = phaseAt + phaseMs;
      }
    }
    steps.push({ tick, start, available, release });
  }
  const end = steps.at(-1)!.available;
  const paints: number[] = [];
  for (let frame = 0; frame * refresh < end; frame++) {
    const at = frame * refresh;
    if (!blocks.some(block => block.from < at && at < block.to)) paints.push(at);
  }
  return { steps, paints, blocks };
}

function play(stream: ReturnType<typeof alignedStream>, f = fixture()) {
  const events = [
    ...stream.steps.map(step => ({ at: step.available, step })),
    ...stream.paints.map(at => ({ at, step: null })),
  ].sort((a, b) => a.at - b.at || Number(a.step === null) - Number(b.step === null));
  for (const event of events) {
    if (event.step) f.step(event.at, event.step.tick, event.step.start);
    else f.frame(event.at);
  }
  return f;
}

function expectContinuous(paints: Paint[], frameMs = 40) {
  for (let i = 1; i < paints.length; i++) {
    const previous = paints[i - 1], current = paints[i];
    expect(current.pose, 'a native arrival cannot move the visual cursor backwards').toBeGreaterThanOrEqual(previous.pose - 1e-9);
    expect(current.pose - previous.pose, 'a native arrival cannot advance more than elapsed game time')
      .toBeLessThanOrEqual((current.at - previous.at) / frameMs + 1e-8);
    expect(current.pose).toBeLessThanOrEqual(current.tick);
    expect(current.pose).toBeGreaterThanOrEqual(Math.max(1, current.tick - 2) - 1e-8);
  }
}

describe('explicit three-pose presentation clock (scheduling model, not FPS evidence)', () => {
  it('starts with the first actual pose and never manufactures pre-capture history', () => {
    const f = fixture();
    f.frame(10); expect(f.present).not.toHaveBeenCalled();
    f.step(32, 101, 20); f.frame(33.4); f.frame(50);
    expect(f.paints).toEqual([{ at: 33.4, tick: 101, alpha: 1, pose: 101 }]);
    f.step(75, 102, 60); f.frame(83.4);
    expect(f.paints.at(-1)!.pose).toBeGreaterThan(101);
    expect(f.paints.at(-1)!.pose).toBeLessThan(102);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('keeps a continuous cursor across actual 33/50 ms aligned starts and 10–20 ms availability costs', () => {
    const stream = alignedStream();
    const starts = stream.steps.slice(1).map((step, index) => Math.round(step.start - stream.steps[index].start));
    expect(starts).toContain(33); expect(starts).toContain(50);
    const f = play(stream);
    expect(f.failed).not.toHaveBeenCalled();
    expectContinuous(f.paints);
    const expected = stream.paints.filter(at => at >= 4000);
    const actual = f.paints.filter(paint => paint.at >= 4000);
    expect(actual.map(paint => paint.at)).toEqual(expected);
    for (let i = 1; i < actual.length; i++) expect(actual[i].pose).toBeGreaterThan(actual[i - 1].pose);
  });

  it('continues through measured median staged phases and the following 14 ms compact callback', () => {
    const stream = alignedStream({ staged: true, costs: [14] });
    const full = stream.steps.filter(step => step.tick % 25 === 0);
    expect(full.every(step => step.release - step.start > 57 && step.release - step.start < 61)).toBe(true);
    const f = play(stream);
    expect(f.failed).not.toHaveBeenCalled(); expectContinuous(f.paints);
    const afterWarmup = f.paints.filter(paint => paint.at >= 4000);
    expect(afterWarmup.map(paint => paint.at)).toEqual(stream.paints.filter(at => at >= 4000));
    for (let i = 1; i < afterWarmup.length; i++) expect(afterWarmup[i].pose).toBeGreaterThan(afterWarmup[i - 1].pose);
  });

  it('retains real movement at each available paint across a 76 ms full step and next compact, with no extra draws', () => {
    const stream = alignedStream({ staged: true, worstBegin: true, costs: [14] });
    const full = stream.steps.filter(step => step.tick % 25 === 0);
    expect(full.every(step => step.release - step.start > 74 && step.release - step.start < 78)).toBe(true);
    const f = play(stream);
    expect(f.failed).not.toHaveBeenCalled(); expectContinuous(f.paints);
    const afterWarmup = f.paints.filter(paint => paint.at >= 4000);
    expect(afterWarmup.map(paint => paint.at)).toEqual(stream.paints.filter(at => at >= 4000));
    for (let i = 1; i < afterWarmup.length; i++) expect(afterWarmup[i].pose).toBeGreaterThan(afterWarmup[i - 1].pose);
    // An endpoint can be reached at the last old-state paint. A three-pose
    // buffer cannot promise unlimited coverage; repeated held endpoints may
    // not be counted as additional native presentations.
    expect(f.present.mock.calls.length).toBe(f.paints.length);
  });

  it('tracks a long 24.5 TPS arrival stream without per-step phase resets or exhausting the three maps', () => {
    const stream = alignedStream({ count: 3000, interval: 1000 / 24.5, staged: true, costs: [14] });
    const f = play(stream);
    expect(f.failed).not.toHaveBeenCalled(); expectContinuous(f.paints);
    const tail = f.paints.filter(paint => paint.at >= 20_000);
    expect(tail.map(paint => paint.at)).toEqual(stream.paints.filter(at => at >= 20_000));
    const first = tail[0], last = tail.at(-1)!;
    const rate = (last.pose - first.pose) * 1000 / (last.at - first.at);
    expect(rate).toBeGreaterThan(24.4); expect(rate).toBeLessThan(24.6);
  });

  it('stops at the last captured pose during an actual native stall without repeating fake frames', () => {
    const f = play(alignedStream({ count: 150, costs: [14] }));
    const at = f.paints.at(-1)!.at;
    for (let frame = 1; frame < 61; frame++) f.frame(at + frame * refresh);
    expect(f.paints.at(-1)!.pose).toBe(150);
    const count = f.paints.length;
    f.frame(at + 2000); f.frame(at + 3000);
    expect(f.paints.length).toBe(count); expect(f.failed).not.toHaveBeenCalled();
  });

  it('an ordinary new native pose at the same clock time cannot reset the visual cursor', () => {
    const f = play(alignedStream({ count: 150, costs: [14] }));
    const previous = f.paints.at(-1)!;
    const nextAt = previous.at + 2 * refresh;
    f.step(nextAt - 1, 151, nextAt - 14); f.frame(nextAt);
    const current = f.paints.at(-1)!;
    expect(current.pose - previous.pose).toBeGreaterThanOrEqual(0);
    expect(current.pose - previous.pose).toBeLessThanOrEqual((current.at - previous.at) / 40 + 1e-8);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('resumes from observed hidden state with one canonical restore, bounded work and removed listeners on close', () => {
    const f = play(alignedStream({ count: 100, costs: [14] }));
    const before = f.paints.length;
    f.visibility(true);
    for (let i = 101; i <= 200; i++) { f.step(40 * i + 14, i, 40 * i); f.frame(40 * i + 15); }
    expect(f.paints.length).toBe(before);
    f.visibility(false); f.frame(8050);
    expect(f.paints.length).toBe(before + 1);
    expect(f.paints.at(-1)!.pose).toBe(200);
    expect(f.paints.at(-1)!.alpha).toBe(1);
    expect(f.failed).not.toHaveBeenCalled();
    f.pump.close(); expect(f.listeners.size).toBe(0); expect(f.callbacks.size).toBe(0);
    f.visibility(true); f.visibility(false); f.frame(9000);
    expect(f.paints.length).toBe(before + 1);
  });

  it('restores once after an actual discontinuous tick stream, then resumes ordinary bounded phase progression', () => {
    const f = fixture(); f.step(14, 1, 0); f.frame(17);
    f.step(2014, 80, 2000); f.frame(2017);
    expect(f.paints.at(-1)!.pose).toBe(80);
    f.step(2054, 81, 2040); f.frame(2067);
    expect(f.paints.at(-1)!.pose).toBeGreaterThan(80);
    expect(f.paints.at(-1)!.pose).toBeLessThanOrEqual(81);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('does not become permanently stuck after a long paint discontinuity without a visibility signal', () => {
    const f = fixture(); f.step(14, 1, 0); f.frame(17);
    for (let tick = 2; tick <= 100; tick++) f.step((tick - 1) * 40 + 14, tick, (tick - 1) * 40);
    const count = f.paints.length;
    f.frame(4000);
    expect(f.paints.length).toBe(count + 1); expect(f.paints.at(-1)!.pose).toBe(100);
    f.step(4054, 101, 4040); f.frame(4067);
    expect(f.paints.at(-1)!.pose).toBeGreaterThan(100);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('reports ordinary finite-history exhaustion instead of forcing a jump or holding forever', () => {
    const f = fixture(); f.step(10, 1, 0); f.frame(17);
    // Deliberately impossible live cadence: multiple new ticks per paint. It
    // must not be disguised as a long hidden gap or silently reset the cursor.
    for (let tick = 2; tick <= 12; tick++) {
      f.step(17 + (tick - 1) * 17 + 2, tick, 17 + (tick - 1) * 17 + 1);
      f.frame(17 + tick * 17);
    }
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(String(f.failed.mock.calls[0][0])).toMatch(/three-pose history/);
    expect(f.callbacks.size).toBe(0);
    expectContinuous(f.paints);
  });

  it.each(['legacy', 'wrong-version', 'wrong-pose', 'stale-tick'])('rejects %s responses after explicit v2 negotiation', fault => {
    const f = fixture();
    f.present.mockImplementation(alpha => ({ version: 1, enabled: true, rendered: true,
      tick: fault === 'stale-tick' ? 0 : 1,
      ...(fault === 'legacy' ? {} : { mode: THREE_POSE_PRESENTATION_MODE,
        poseVersion: fault === 'wrong-version' ? 1 : 2,
        poseTick: fault === 'wrong-pose' ? 0.5 : -1 + 2 * alpha }) }));
    f.step(14, 1, 0); f.frame(17); f.frame(34);
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.present).toHaveBeenCalledTimes(1);
    expect(f.callbacks.size).toBe(0); expect(f.listeners.size).toBe(0);
  });
});
