import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OriginalBridge, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { OriginalSession } from '../../apps/original-web/src/session';
import { type ConnectionIntent, type PrepareMessage, type Slot } from '../../apps/original-web/src/protocol';

const hash = 'a'.repeat(64);
const room = 'DropInRoom01';
const setup = { mode: 'Coop' as const, map: 'ROOM_Single_0001', characters: [0, 1] as [number, number] };
const prepare: PrepareMessage = { type: 'prepare', ...setup, seed: 7, swfHash: hash,
  initialPlayers: 1, personalProgression: true, replay: false };
const host: ConnectionIntent = { type: 'create', setup, dropIn: true, listed: true };
const guest: ConnectionIntent = { type: 'join_open', room, character: 3 };
const player = (slot: Slot) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0,
  life: 200, flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 });
const frame = (tick: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'frame', tick, p1: 17, p2: 0, ...extra });

/** Real client guard classes with stub native callbacks; not native-game evidence. */
function fixture(intent: ConnectionIntent = host) {
  let now = 0;
  let workNow = 0;
  let nativeTick = 0;
  let nativePhase = 'menu';
  let roster: Slot[] = [1, 2];
  const trace: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn();
  const events = { joined: vi.fn(), peer: vi.fn(), preparing: vi.fn(), prepared: vi.fn(),
    running: vi.fn(), replaying: vi.fn(), joinSync: vi.fn(), stepped: vi.fn(), finishing: vi.fn(), completed: vi.fn(), failed: vi.fn() };
  const invoke = vi.fn<NativeInvoke>((name, ...args) => {
    if (name === 'bhInfo') {
      trace.push(`info:${nativeTick}`);
      return { version: 1, engine: 'original-swf', state: nativePhase, tick: nativeTick,
        canPrepare: nativePhase === 'menu' };
    }
    if (name === 'bhPrepare') {
      const options = args[6] as { initialPlayers?: number } | undefined;
      roster = options?.initialPlayers === 1 ? [1] : [1, 2];
      nativePhase = 'ready';
      nativeTick = 0;
      return { state: 'ready', tick: 0 };
    }
    if (name === 'bhStep') {
      nativeTick = args[0] as number;
      nativePhase = 'playing';
      if (args[3] !== undefined) roster = [1, 2];
      trace.push(`step:${nativeTick}`);
      return { tick: nativeTick, digest: `native-${nativeTick}`, players: roster.map(player) };
    }
    if (name === 'bhState') {
      trace.push(`state:${nativeTick}`);
      return { tick: nativeTick, digest: `native-${nativeTick}`, rng: 7,
        players: roster.map(player), entities: [] };
    }
    return undefined;
  });
  const bridge = new OriginalBridge(invoke);
  const step = vi.spyOn(bridge, 'step');
  const send = vi.fn((message: Record<string, unknown>) => {
    sent.push(message); trace.push('send:' + message.type + ':' + (message.tick ?? ''));
  });
  const session = new OriginalSession(intent, hash, bridge, {
    send, close,
  }, events, () => now, () => workNow);
  return { session, bridge, step, invoke, events, sent, trace, close, send,
    slot: (intent.type === 'create' ? 1 : 2) as Slot,
    setTime: (value: number) => { now = value; },
    setWorkTime: (value: number) => { workNow = value; },
    messages: (type: string) => sent.filter((message) => message.type === type) };
}

async function joined(f: ReturnType<typeof fixture>) {
  f.session.opened();
  await f.session.receive(JSON.stringify({ type: 'joined', room, slot: f.slot, token: 'test-only-token' }));
}

async function ready(f: ReturnType<typeof fixture>, options: Partial<PrepareMessage> = {}) {
  await joined(f);
  await f.session.receive(JSON.stringify({ ...prepare, replay: f.slot === 2, ...options }));
}

const batch = (first: number, count = 4) => JSON.stringify({
  type: 'replay_frames',
  frames: Array.from({ length: count }, (_, index) => ({ type: 'frame', tick: first + index, p1: 17, p2: 0 })),
});
const replayOffer = (size: number): Partial<PrepareMessage> => size <= 8
  ? { replayBatchMax: size } : { replayBatchMax: 8, replayBatchExtendedMax: size };
const sync = (tick: number, timeoutMs = 1500, verified = 0) => JSON.stringify({
  type: 'join_sync', state: 'paused', tick, verified, timeoutMs,
});

describe('cooperative replay FIFO (stub native callbacks, not browser responsiveness evidence)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('finishes two whole native frames before a real timer task and retains every per-frame result', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    f.trace.length = 0;
    const finished = vi.fn();
    const pending = f.session.receive(batch(1, 64)).then(finished);
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2]);
    expect(f.events.stepped.mock.calls).toEqual([[1], [2]]);
    expect(vi.getTimerCount()).toBe(1);
    // Settling promise microtasks alone must never run the third native frame.
    await Promise.resolve();
    await Promise.resolve();
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(finished).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await pending;
    expect(finished).toHaveBeenCalledOnce();
    expect(f.trace).toEqual(Array.from({ length: 64 }, (_, index) => index + 1).flatMap(tick => [
      `step:${tick}`, `info:${tick}`, `state:${tick}`, `send:ack:${tick}`,
    ]));
    expect(f.events.stepped.mock.calls).toEqual(Array.from({ length: 64 }, (_, index) => [index + 1]));
    expect(f.session.phase).toBe('replaying');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[3, 2], [4, 2], [8, 1], [9, 1]])('yields after completed native work costing %sms per frame reaches 8ms or two frames, without interrupting a frame', async (cost, firstSlice) => {
    const f = fixture(guest);
    await ready(f, replayOffer(8));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (name === 'bhState') f.setWorkTime((result?.tick as number) * cost);
      return result;
    });
    const boundaries: { step: number; ack: number; stepped: number; delay: number | undefined }[] = [];
    const schedule = globalThis.setTimeout.bind(globalThis);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      boundaries.push({ step: f.step.mock.calls.length, ack: f.messages('ack').length,
        stepped: f.events.stepped.mock.calls.length, delay });
      return schedule(callback, delay, ...args);
    });
    f.trace.length = 0;
    const pending = f.session.receive(batch(1, 8));
    expect(f.step).toHaveBeenCalledTimes(firstSlice);
    expect(f.messages('ack')).toHaveLength(firstSlice);
    expect(f.trace.slice(-4)).toEqual([
      `step:${firstSlice}`, `info:${firstSlice}`, `state:${firstSlice}`, `send:ack:${firstSlice}`,
    ]);
    expect(boundaries).toEqual([{ step: firstSlice, ack: firstSlice, stepped: firstSlice, delay: 0 }]);
    // A fake-timer "next" helper may drain more than one continuation. Inspect
    // every actual scheduling boundary, independently of that helper's policy.
    await vi.runAllTimersAsync();
    await pending;
    const expected = firstSlice === 2 ? [2, 4, 6] : [1, 2, 3, 4, 5, 6, 7];
    expect(boundaries).toEqual(expected.map(tick => ({ step: tick, ack: tick, stepped: tick, delay: 0 })));
    expect(f.step).toHaveBeenCalledTimes(8);
    expect(f.messages('ack')).toHaveLength(8);
    expect(f.trace).toEqual(Array.from({ length: 8 }, (_, index) => index + 1).flatMap(tick => [
      `step:${tick}`, `info:${tick}`, `state:${tick}`, `send:ack:${tick}`,
    ]));
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it.each([
    ['wall only', 4000, 0, 2],
    ['work only', 0, 8, 1],
  ] as const)('uses the independent work clock for slices when %s advances', async (_kind, wallCost, workCost, firstSlice) => {
    const f = fixture(guest);
    await ready(f, replayOffer(8));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (name === 'bhState') {
        const tick = result?.tick as number;
        f.setTime(tick * wallCost);
        f.setWorkTime(tick * workCost);
      }
      return result;
    });
    const pending = f.session.receive(batch(1, 4));
    expect(f.step).toHaveBeenCalledTimes(firstSlice);
    expect(f.messages('ack')).toHaveLength(firstSlice);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    await pending;
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2, 3, 4]);
    expect(f.events.stepped.mock.calls).toEqual([[1], [2], [3], [4]]);
    expect(f.events.failed).not.toHaveBeenCalled();
    expect(f.session.phase).toBe('replaying');
  });

  it('carries one owner budget across queued small packets and a single historical frame', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(8));
    const first = f.session.receive(batch(1, 1));
    const second = f.session.receive(batch(2, 1));
    const single = f.session.receive(frame(3));
    const last = f.session.receive(batch(4, 7));
    await Promise.all([first, second]);
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    await Promise.all([single, last]);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
  });

  it('also bounds an already queued burst from an old server with no batch negotiation', async () => {
    const f = fixture(guest);
    await ready(f);
    const pending = Array.from({ length: 24 }, (_, index) => f.session.receive(frame(index + 1)));
    await Promise.all(pending.slice(0, 2));
    expect(f.messages('ready')).toEqual([{ type: 'ready' }]);
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  });

  it('accepts the next full packet at native tick2 and checks its first tick only at ordered dispatch', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const first = f.session.receive(batch(1, 64));
    const second = f.session.receive(batch(65, 64));
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.session.phase).toBe('replaying');
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('rejects a queued packet with a wrong first tick when it reaches the owner', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const first = f.session.receive(batch(1, 64));
    const second = f.session.receive(batch(66, 64));
    expect(f.session.phase).toBe('replaying');
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(64);
    expect(f.messages('ack')).toHaveLength(64);
  });

  it('parses the last member of a queued packet immediately and never executes any of that malformed packet', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const first = f.session.receive(batch(1, 64));
    const invalid = JSON.parse(batch(65, 64));
    invalid.frames[63].tick++;
    await f.session.receive(JSON.stringify(invalid));
    await first;
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(f.step).toHaveBeenCalledTimes(2);
  });

  it('keeps pause/progress/caught_up/spawn and later live frames behind all preceding replay work', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    f.events.joinSync.mockImplementation(message => { f.trace.push(`control:${message.state}`); });
    f.events.running.mockImplementation(() => { f.trace.push('running'); });
    const pending = [
      f.session.receive(batch(1, 10)),
      f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 10, verified: 2, timeoutMs: 1500 })),
      f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 10, verified: 10 })),
      f.session.receive(JSON.stringify({ type: 'caught_up', tick: 10 })),
      f.session.receive(frame(11, { join: { slot: 2, character: 3 } })),
      f.session.receive(frame(12)),
    ];
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(f.events.running).not.toHaveBeenCalled();
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.session.phase).toBe('running');
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.events.joinSync.mock.calls.map(([message]) => message.state)).toEqual(['paused', 'progress']);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(f.trace.indexOf('control:paused')).toBeGreaterThan(f.trace.indexOf('send:ack:10'));
    expect(f.trace.indexOf('control:progress')).toBeLessThan(f.trace.indexOf('step:11'));
    f.session.input(16);
    expect(f.messages('input')).toHaveLength(1);
  });

  it.each(['close', 'disconnect', 'reject', 'server-error', 'server-paused', 'parse'] as const)('cancels a pending timer and every accepted receive immediately on %s', async (kind) => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const first = f.session.receive(batch(1, 64));
    const second = f.session.receive(batch(65, 64));
    const control = f.session.receive(JSON.stringify({ type: 'caught_up', tick: 128 }));
    const staleResume = timers.mock.calls[0]?.[0];
    expect(typeof staleResume).toBe('function');
    if (kind === 'close') f.session.close();
    else if (kind === 'disconnect') f.session.disconnected();
    else if (kind === 'reject') f.session.reject('fixture rejection');
    else await f.session.receive(kind === 'parse' ? '{bad-json' : JSON.stringify({ type: kind === 'server-error' ? 'error' : 'paused' }));
    // No timer advancement is needed to settle the cancelled receives.
    await Promise.all([first, second, control]);
    expect(f.session.phase).toBe(kind === 'close' ? 'closed' : 'failed');
    expect(vi.getTimerCount()).toBe(0);
    if (typeof staleResume === 'function') staleResume();
    await vi.runAllTimersAsync();
    await f.session.receive(batch(129, 64));
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.events.failed).toHaveBeenCalledTimes(kind === 'close' ? 0 : 1);
  });

  it.each([false, true])('bounds not-started frames at exactly128, overflow=%s', async (overflow) => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const pending = [f.session.receive(batch(1, 64)), f.session.receive(batch(65, 64)), f.session.receive(batch(129, 2))];
    // Two completed ACKs leave exactly128 accepted, not-started frames.
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.session.phase).toBe('replaying');
    if (overflow) pending.push(f.session.receive(frame(131)));
    if (overflow) {
      await Promise.all(pending);
      expect(f.session.phase).toBe('failed');
      expect(f.step).toHaveBeenCalledTimes(2);
      expect(f.messages('ack')).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } else {
      await vi.runAllTimersAsync();
      await Promise.all(pending);
      expect(f.session.phase).toBe('replaying');
      expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 130 }, (_, index) => index + 1));
    }
  });

  it('bounds queued controls independently at256 messages and cancels without dispatching their payloads', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const pending = [f.session.receive(batch(1, 64))];
    const control = JSON.stringify({ type: 'join_sync', state: 'progress', tick: 64, verified: 2 });
    for (let index = 0; index < 255; index++) pending.push(f.session.receive(control));
    expect(f.session.phase).toBe('replaying');
    pending.push(f.session.receive(control));
    await Promise.all(pending);
    expect(f.session.phase).toBe('failed');
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['absolute', 'progress', 'barrier'] as const)('checks the unchanged %s work deadline after a yield without a watchdog callback', async (kind) => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    let firstTick = 1;
    if (kind === 'absolute') {
      for (let tick = 1; tick <= 19; tick++) {
        f.setTime(tick * 9000);
        await f.session.receive(frame(tick));
      }
      firstTick = 20;
      f.setTime(179999);
    } else if (kind === 'barrier') {
      // Keep the real final gap at eight. One whole 9ms frame exceeds the
      // soft 8ms work budget and leaves native work inside that barrier.
      await f.session.receive(sync(8));
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args) as Record<string, unknown> | undefined;
        if (name === 'bhState') f.setWorkTime((result?.tick as number) * 9);
        return result;
      });
    }
    const firstSlice = kind === 'barrier' ? 1 : 2;
    const packetSize = kind === 'barrier' ? 8 : 32;
    const first = f.session.receive(batch(firstTick, packetSize));
    expect(f.step).toHaveBeenCalledTimes(firstTick + firstSlice - 1);
    expect(vi.getTimerCount()).toBe(1);
    // Even another valid packet arriving during the pause is not progress.
    if (kind === 'progress') f.setTime(9000);
    const second = kind === 'barrier' ? Promise.resolve() : f.session.receive(batch(firstTick + packetSize, packetSize));
    f.setTime(kind === 'absolute' ? 180001 : kind === 'barrier' ? 1501 : 10001);
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(firstTick + firstSlice - 1);
    expect(f.messages('ack')).toHaveLength(firstTick + firstSlice - 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before', 'after'] as const)('enforces a queued pause deadline %s the next native frame while keeping its control ordered', async (when) => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const delegate = f.invoke.getMockImplementation()!;
    if (when === 'after') f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (name === 'bhState' && result?.tick === 3) f.setTime(1501);
      return result;
    });
    const pending = [
      f.session.receive(batch(1, 6)),
      f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 10, verified: 2, timeoutMs: 1500 })),
      f.session.receive(batch(7, 4)),
    ];
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.setTime(when === 'before' ? 1501 : 1490);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 2 : 3);
    expect(f.messages('ack')).toHaveLength(2);
  });

  it('never extends the earliest queued work deadline with another later paused control', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const pending = [
      f.session.receive(batch(1, 10)),
      f.session.receive(sync(10, 1500, 2)),
    ];
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.setTime(1000);
    pending.push(f.session.receive(sync(10, 1500, 2)));
    f.setTime(1501);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('keeps earned final-control delivery grace after a queued fixed target finished within its actual work budget', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    f.events.joinSync.mockImplementation(message => { if (message.state === 'paused') f.setTime(1501); });
    const pending = [
      f.session.receive(batch(1, 10)),
      f.session.receive(sync(10, 1500, 2)),
      f.session.receive(JSON.stringify({ type: 'caught_up', tick: 10 })),
      f.session.receive(frame(11, { join: { slot: 2, character: 3 } })),
    ];
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.setTime(1400);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.session.phase).toBe('running');
    expect(f.step).toHaveBeenCalledTimes(11);
    expect(f.messages('ack')).toHaveLength(11);
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('stops after the first post-yield readback mismatch and never dispatches a queued confirmation', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      return name === 'bhState' && result?.tick === 3 ? { ...result, digest: 'wrong' } : result;
    });
    const pending = [f.session.receive(batch(1, 32)), f.session.receive(JSON.stringify({ type: 'caught_up', tick: 32 }))];
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(3);
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2]);
    expect(f.events.running).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a real terminal result after a yield, drops its unexecuted tail, and accepts only the matching completion', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      return name === 'bhStep' && result?.tick === 3 ? { ...result, complete: 'player dead' } : result;
    });
    const pending = [
      f.session.receive(batch(1, 32)),
      f.session.receive(JSON.stringify({ type: 'completed', tick: 3, complete: 'player dead' })),
      f.session.receive(frame(33)),
    ];
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(f.session.phase).toBe('completed');
    expect(f.step).toHaveBeenCalledTimes(3);
    expect(f.messages('ack').at(-1)).toEqual({ type: 'ack', tick: 3, digest: 'native-3', complete: 'player dead' });
    expect(f.events.completed).toHaveBeenCalledExactlyOnceWith(3, 'player dead');
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it.each(['send', 'stepped'] as const)('never starts a second native owner from a reentrant %s callback', async (source) => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    let nested: Promise<void> | undefined;
    const enqueue = (tick: unknown) => { if (tick === 1) nested = f.session.receive(batch(17, 16)); };
    if (source === 'send') {
      const delegate = f.send.getMockImplementation()!;
      f.send.mockImplementation(message => { delegate(message); if (message.type === 'ack') enqueue(message.tick); });
    } else f.events.stepped.mockImplementation(enqueue);
    const first = f.session.receive(batch(1, 16));
    await Promise.resolve();
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(nested).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    await Promise.all([first, nested]);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('rejects a premature frame while prepare is unresolved instead of deferring it into replay', async () => {
    const f = fixture(guest);
    await joined(f);
    let finishPrepare!: () => void;
    vi.spyOn(f.bridge, 'prepare').mockImplementation(() => new Promise<void>(resolve => { finishPrepare = resolve; }));
    const pending = f.session.receive(JSON.stringify({ ...prepare, replay: true, ...replayOffer(64) }));
    expect(f.session.phase).toBe('preparing');
    await f.session.receive(frame(1));
    expect(f.session.phase).toBe('failed');
    finishPrepare();
    await pending;
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ready')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the live host path synchronous with no replay queue or timer', async () => {
    const f = fixture(host);
    await ready(f);
    const pending = Array.from({ length: 64 }, (_, index) => f.session.receive(frame(index + 1)));
    expect(f.step).toHaveBeenCalledTimes(64);
    expect(f.messages('ack')).toHaveLength(64);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all(pending);
    expect(f.session.phase).toBe('running');
    expect(f.events.failed).not.toHaveBeenCalled();
  });
});

