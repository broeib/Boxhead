import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { yieldAfterOriginalPaint } from '../../apps/original-web/src/staged-step-scheduler';

function environment() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const tasks: (() => void)[] = [];
  const closed = vi.fn();
  const page = Object.assign(new EventTarget(), { hidden: false });
  class Channel {
    port1 = { onmessage: null as (() => void) | null, close: closed };
    port2 = { postMessage: () => tasks.push(() => this.port1.onmessage?.()), close: closed };
  }
  vi.stubGlobal('MessageChannel', Channel);
  vi.stubGlobal('document', page);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  return { page, frames, tasks, closed,
    frame() { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(16.7); },
    task() { tasks.shift()?.(); } };
}

describe('staged work yields through a paint opportunity and then an actual task', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('does not resume in the rAF microtask queue before the remaining renderer callbacks', async () => {
    const f = environment(); const trace: string[] = [];
    const pending = yieldAfterOriginalPaint().then(() => trace.push('phase'));
    requestAnimationFrame(() => trace.push('ruffle-render'));
    await Promise.resolve();
    expect(trace).toEqual([]);
    f.frame();
    await Promise.resolve();
    expect(trace).toEqual(['ruffle-render']);
    expect(f.tasks).toHaveLength(1);
    f.task(); await pending;
    expect(trace).toEqual(['ruffle-render', 'phase']);
    expect(f.closed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before-frame', 'after-frame'] as const)('cancels %s and ignores an already posted stale task', async moment => {
    const f = environment(); const abort = new AbortController();
    const pending = yieldAfterOriginalPaint(abort.signal);
    const result = expect(pending).rejects.toThrow('cancelled');
    if (moment === 'after-frame') f.frame();
    abort.abort(); await result;
    f.frame(); f.task(); await Promise.resolve();
    expect(f.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule native work for an already aborted owner', async () => {
    const f = environment(); const abort = new AbortController(); abort.abort();
    await expect(yieldAfterOriginalPaint(abort.signal)).rejects.toThrow('cancelled');
    expect(f.frames.size).toBe(0); expect(f.tasks).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a task in a hidden tab without waiting indefinitely for suppressed rAF', async () => {
    const f = environment(); f.page.hidden = true; const done = vi.fn();
    const pending = yieldAfterOriginalPaint().then(done);
    expect(f.frames.size).toBe(0); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    f.task(); await pending; expect(done).toHaveBeenCalledOnce();
  });

  it('handles hiding while a visible frame was pending and cancels the stale frame', async () => {
    const f = environment(); const done = vi.fn();
    const pending = yieldAfterOriginalPaint().then(done);
    f.page.hidden = true; f.page.dispatchEvent(new Event('visibilitychange'));
    expect(f.frames.size).toBe(0); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    f.task(); await pending;
    f.page.dispatchEvent(new Event('visibilitychange'));
    expect(f.tasks).toHaveLength(0); expect(done).toHaveBeenCalledOnce();
  });

  it('fails a stalled visible renderer after its finite wait instead of faking a paint', async () => {
    const f = environment(); const pending = yieldAfterOriginalPaint();
    const result = expect(pending).rejects.toThrow('did not provide a frame');
    await vi.advanceTimersByTimeAsync(1000); await result;
    expect(f.frames.size).toBe(0); expect(f.tasks).toHaveLength(0);
  });

  it('preserves task separation when MessageChannel is unavailable', async () => {
    const f = environment(); vi.stubGlobal('MessageChannel', undefined); const done = vi.fn();
    const pending = yieldAfterOriginalPaint().then(done);
    f.frame(); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    await vi.runAllTimersAsync(); await pending; expect(done).toHaveBeenCalledOnce();
  });

  it('cleans up on a channel construction error and never falls back to immediate native execution', async () => {
    const f = environment(); vi.stubGlobal('MessageChannel', class { constructor() { throw new Error('unavailable'); } });
    const pending = yieldAfterOriginalPaint(); const result = expect(pending).rejects.toThrow('could not continue');
    f.frame(); await result; expect(vi.getTimerCount()).toBe(0);
  });
});
