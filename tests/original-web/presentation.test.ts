import { describe, expect, it, vi } from 'vitest';
import { OriginalPresentationDispatcher, OriginalPresentationPump, type PresentationClock } from '../../apps/original-web/src/presentation';

function fixture() {
  let now = 0, next = 0, tick = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const clock: PresentationClock = { now: () => now,
    request: (callback) => { frames.set(++next, callback); return next; }, cancel: (id) => { frames.delete(id); } };
  const failed = vi.fn();
  const present = vi.fn((alpha: number): unknown => ({ version: 1, enabled: true, rendered: true, tick, alpha }));
  const pump = new OriginalPresentationPump(present, clock, failed);
  return { pump, present, failed, frames,
    step(at: number, nextTick: number, frameMs = 40, startedAt = at) {
      now = at; tick = nextTick; pump.stepped(nextTick, frameMs, startedAt);
    },
    frame(at: number) { now = at; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(at); },
  };
}

describe('original render-only presentation pump', () => {
  it('does nothing before a native tick and gives intermediate phases without requesting game steps', () => {
    const f = fixture(); f.frame(10); expect(f.present).not.toHaveBeenCalled();
    f.step(10, 1); f.frame(20); f.frame(37); f.frame(54);
    expect(f.present.mock.calls.map(([alpha]) => alpha)).toEqual([0.25, 0.675, 1]);
    // Stalled native simulation freezes at its last known state, never extrapolates.
    f.frame(1000); expect(f.present).toHaveBeenCalledTimes(3);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('caps replay work on high-refresh displays and does not skip a new tick at alpha one', () => {
    const f = fixture(); f.step(0, 1);
    for (let i = 0; i <= 20; i++) f.frame(i * 4);
    expect(f.present.mock.calls.length).toBeLessThanOrEqual(5);
    f.step(80, 2); f.frame(120);
    expect(f.present.mock.lastCall).toEqual([1]);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('uses actual step starts instead of adding variable callback cost to the phase', () => {
    const f = fixture();
    f.step(28, 1, 40, 0); f.frame(33);
    expect(f.present.mock.lastCall).toEqual([0.825]);
    f.step(55, 2, 40, 40); f.frame(60);
    expect(f.present.mock.lastCall).toEqual([0.5]);
    // With starts 40 ms apart, the logical phase advances by elapsed wall time,
    // even though the synchronous callback durations were 28 ms and 15 ms.
    const logicalAdvance = 1 + Number(f.present.mock.calls[1][0]) - Number(f.present.mock.calls[0][0]);
    expect(logicalAdvance).toBeCloseTo((60 - 33) / 40);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('clamps a callback longer than one native interval without extrapolating or waiting another interval', () => {
    const f = fixture(); f.step(70, 1, 40, 0); f.frame(75);
    expect(f.present.mock.calls).toEqual([[1]]);
    f.frame(120); expect(f.present.mock.calls).toEqual([[1]]);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('does not reset the start for an old tick and rejects a regressing timestamp for a new tick', () => {
    const f = fixture(); f.step(120, 1, 40, 100); f.frame(125);
    expect(f.present.mock.lastCall).toEqual([0.625]);
    f.step(130, 1, 40, 130); f.frame(145);
    expect(f.present.mock.lastCall).toEqual([1]);
    f.step(150, 2, 40, 99);
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.frames.size).toBe(0);
  });

  it.each([NaN, Infinity, -1, 21])('does not schedule a native phase with invalid start timestamp %s', startedAt => {
    const f = fixture(); f.step(20, 1, 40, startedAt);
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.frames.size).toBe(0);
    expect(f.present).not.toHaveBeenCalled();
  });

  it.each([20, 40, 80])('preserves the native %i ms setting as an interpolation interval', frameMs => {
    const f = fixture(); f.step(0, 1, frameMs); f.frame(frameMs / 2);
    expect(f.present).toHaveBeenCalledWith(0.5);
  });

  it.each([120, 144, 165, 240])('retains a fractional sixty-update cadence on a %i Hz monitor', refreshHz => {
    const f = fixture(); let tick = 0;
    for (let i = 0; i < refreshHz; i++) {
      const at = i * 1000 / refreshHz, nextTick = Math.floor(at / 40) + 1;
      if (nextTick > tick) { tick = nextTick; f.step((tick - 1) * 40, tick); }
      f.frame(at);
    }
    expect(f.present.mock.calls.length).toBeGreaterThanOrEqual(58);
    expect(f.present.mock.calls.length).toBeLessThanOrEqual(61);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('teardown cancels a pending callback and a stale callback cannot revive a reset VM', () => {
    const f = fixture(); f.step(0, 1); const pending = [...f.frames.values()][0]; f.pump.close();
    expect(f.frames.size).toBe(0); pending(20); f.step(40, 2); f.frame(60);
    expect(f.present).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
  });

  it.each(['stale', 'disabled', 'native-error', 'exception'])('stops once on %s presentation without retrying a native callback', fault => {
    const f = fixture();
    f.present.mockImplementation(() => {
      if (fault === 'exception') throw new Error('render failure');
      return { version: 1, enabled: fault !== 'disabled', rendered: false, tick: fault === 'stale' ? 0 : 1,
        ...(fault === 'native-error' ? { error: 'bounded native fallback' } : {}) };
    });
    f.step(0, 1); f.frame(10); f.frame(30); f.step(40, 2); f.frame(60);
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.present).toHaveBeenCalledTimes(1); expect(f.frames.size).toBe(0);
  });
});

describe('presentation dispatcher before the pinned Ruffle rAF loop (scheduling fixtures only)', () => {
  function dispatcherFixture(signal?: AbortSignal) {
    let now = 0, next = 0;
    const frames = new Map<number, (timestamp: number) => void>();
    const clock: PresentationClock = {
      now: () => now,
      request: callback => { frames.set(++next, callback); return next; },
      cancel: id => { frames.delete(id); },
    };
    const dispatcher = new OriginalPresentationDispatcher(clock, signal);
    return { dispatcher, clock, frames,
      frame(at: number) {
        now = at;
        // Match rAF's ordered snapshot and cancellation behavior: requests made
        // inside a callback belong to the next opportunity, not this snapshot.
        for (const [id, callback] of [...frames]) {
          if (frames.delete(id)) callback(at);
        }
      },
    };
  }

  it('reserves its order while dormant and presents before a later recurring renderer', () => {
    const f = dispatcherFixture();
    const calls: string[] = [];
    const renderer = (): void => { f.clock.request(renderer); calls.push('render'); };
    f.clock.request(renderer);
    f.frame(10); f.frame(20);
    expect(calls).toEqual(['render', 'render']);
    calls.length = 0;
    const present = (): void => { calls.push('present'); f.dispatcher.request(present); };
    f.dispatcher.request(present);
    f.frame(30); f.frame(40);
    expect(calls).toEqual(['present', 'render', 'present', 'render']);
    expect(f.frames.size).toBe(2);
    f.dispatcher.close(); expect(f.frames.size).toBe(1);
  });

  it('rearms before an owned callback can start or restart a renderer', () => {
    const f = dispatcherFixture();
    const calls: string[] = [];
    const renderer = (): void => { f.clock.request(renderer); calls.push('render'); };
    const present = (): void => { calls.push('present'); f.dispatcher.request(present); };
    f.dispatcher.request(() => { f.clock.request(renderer); f.dispatcher.request(present); });
    f.frame(10); expect(calls).toEqual([]);
    f.frame(20); f.frame(30);
    expect(calls).toEqual(['present', 'render', 'present', 'render']);
    f.dispatcher.close();
  });

  it('keeps newly requested work for the next opportunity and honors cancellation within a dispatch', () => {
    const f = dispatcherFixture();
    const calls: string[] = [];
    let cancelled = 0;
    f.dispatcher.request(() => {
      calls.push('first');
      f.dispatcher.cancel(cancelled);
      f.dispatcher.request(() => { calls.push('next'); });
    });
    cancelled = f.dispatcher.request(() => { calls.push('cancelled'); });
    f.frame(10); expect(calls).toEqual(['first']);
    f.frame(20); expect(calls).toEqual(['first', 'next']);
    f.dispatcher.close(); expect(f.frames.size).toBe(0);
  });

  it('aborts dormant or active work and stale callbacks cannot restart the dispatcher', () => {
    const controller = new AbortController();
    const f = dispatcherFixture(controller.signal);
    const present = vi.fn();
    f.dispatcher.request(present);
    const stale = [...f.frames.values()][0];
    controller.abort();
    expect(f.frames.size).toBe(0);
    stale(10); f.frame(20);
    expect(present).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
    f.dispatcher.request(present); f.frame(30);
    expect(present).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
    f.dispatcher.close();
    expect(dispatcherFixture(controller.signal).frames.size).toBe(0);
  });

  it('closing inside a callback cancels its already reserved next frame and remaining work', () => {
    const f = dispatcherFixture();
    const later = vi.fn();
    f.dispatcher.request(() => { f.dispatcher.close(); });
    f.dispatcher.request(later);
    f.frame(10); f.frame(20);
    expect(later).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
  });
});
