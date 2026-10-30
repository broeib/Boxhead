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
const sync = (tick: number, timeoutMs = 1500) => JSON.stringify({
  type: 'join_sync', state: 'paused', tick, verified: 0, timeoutMs,
});

function controlledScheduler() {
  const requests: { receiver: unknown; resolve(): void; reject(error: unknown): void }[] = [];
  const waiting: { count: number; resolve(): void }[] = [];
  const api = { yield: vi.fn(function (this: unknown) {
    const receiver = this;
    return new Promise<void>((resolve, reject) => {
      requests.push({ receiver, resolve, reject });
      for (const wait of waiting) if (requests.length >= wait.count) wait.resolve();
    });
  }) };
  vi.stubGlobal('scheduler', api);
  return { api, requests, scheduled: (count: number) => new Promise<void>(resolve => {
    if (requests.length >= count) resolve();
    else waiting.push({ count, resolve });
  }) };
}

describe('feature-detected scheduler replay tasks (client mocks, no browser timing claim)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('uses the supported receiver exactly once and waits for it before the third complete native frame', async () => {
    const scheduler = controlledScheduler();
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    f.trace.length = 0;
    const pending = f.session.receive(batch(1, 4));
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.events.stepped).toHaveBeenCalledTimes(2);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
    expect(scheduler.requests[0].receiver).toBe(scheduler.api);
    expect(timer).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(f.step).toHaveBeenCalledTimes(2);
    scheduler.requests[0].resolve();
    await pending;
    expect(f.trace).toEqual(Array.from({ length: 4 }, (_, index) => index + 1).flatMap(tick => [
      `step:${tick}`, `info:${tick}`, `state:${tick}`, `send:ack:${tick}`,
    ]));
    expect(f.events.stepped).toHaveBeenCalledTimes(4);
    expect(f.session.phase).toBe('replaying');
    expect(timer).not.toHaveBeenCalled();
  });

  it('enforces the 8ms work budget below the two-frame cap through each own scheduler continuation', async () => {
    const scheduler = controlledScheduler();
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (name === 'bhState') f.setWorkTime((result?.tick as number) * 8);
      return result;
    });
    const pending = f.session.receive(batch(1, 6));
    for (const [index, tick] of [1, 2, 3, 4, 5].entries()) {
      await scheduler.scheduled(index + 1);
      expect(f.step).toHaveBeenCalledTimes(tick);
      expect(f.messages('ack')).toHaveLength(tick);
      expect(f.events.stepped).toHaveBeenCalledTimes(tick);
      expect(scheduler.requests[index].receiver).toBe(scheduler.api);
      scheduler.requests[index].resolve();
    }
    await pending;
    expect(scheduler.api.yield).toHaveBeenCalledTimes(5);
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null, {}, { yield: undefined }])('falls back to the original timer only for an absent API: %j', async (api) => {
    vi.stubGlobal('scheduler', api);
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const pending = f.session.receive(batch(1, 32));
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenCalledOnce();
    expect(timer.mock.calls[0][1]).toBe(0);
    await vi.runAllTimersAsync();
    await pending;
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject', 'bad-return', 'thenable', 'nonfunction', 'getter'] as const)('fails closed on supported/present scheduler %s without a timer fallback', async (kind) => {
    const failure = new Error('fixture scheduler failure');
    const api = kind === 'getter'
      ? Object.defineProperty({}, 'yield', { get() { throw failure; } })
      : { yield: kind === 'nonfunction' ? 17 : vi.fn(() => {
        if (kind === 'throw') throw failure;
        if (kind === 'reject') return Promise.reject(failure);
        if (kind === 'thenable') return { then: (resume: () => void) => { resume(); } };
        return undefined;
      }) };
    vi.stubGlobal('scheduler', api);
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await f.session.receive(batch(1, 32));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.events.failed).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
  });

  it('settles the current and queued receives when a real pending scheduler request rejects', async () => {
    const scheduler = controlledScheduler();
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const pending = [f.session.receive(batch(1, 32)), f.session.receive(batch(33, 32))];
    scheduler.requests[0].reject(new Error('actual pending scheduler rejection'));
    await Promise.all(pending);
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['close', 'resolve'], ['close', 'reject'], ['reject', 'resolve'], ['reject', 'reject'],
    ['disconnect', 'resolve'], ['disconnect', 'reject'], ['fatal', 'resolve'], ['fatal', 'reject'],
  ] as const)('cancels immediately on %s and ignores the stale scheduler %s', async (cancel, settle) => {
    const scheduler = controlledScheduler();
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const pending = [
      f.session.receive(batch(1, 32)), f.session.receive(batch(33, 32)),
      f.session.receive(JSON.stringify({ type: 'caught_up', tick: 64 })),
    ];
    if (cancel === 'close') f.session.close();
    else if (cancel === 'reject') f.session.reject('fixture reject');
    else if (cancel === 'disconnect') f.session.disconnected();
    else await f.session.receive(JSON.stringify({ type: 'paused' }));
    // The browser scheduler promise remains pending; our owner must not.
    await Promise.all(pending);
    expect(f.session.phase).toBe(cancel === 'close' ? 'closed' : 'failed');
    if (settle === 'resolve') scheduler.requests[0].resolve();
    else scheduler.requests[0].reject(new Error('late rejected continuation'));
    await Promise.resolve();
    await f.session.receive(frame(65));
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.events.failed).toHaveBeenCalledTimes(cancel === 'close' ? 0 : 1);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('does not let an obsolete continuation %s interfere with a newer pending slice', async (settle) => {
    const scheduler = controlledScheduler();
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const pending = [f.session.receive(batch(1, 4)), f.session.receive(batch(5, 2))];
    scheduler.requests[0].resolve();
    await scheduler.scheduled(2);
    expect(f.step).toHaveBeenCalledTimes(4);
    if (settle === 'resolve') scheduler.requests[0].resolve();
    else scheduler.requests[0].reject(new Error('duplicate old continuation'));
    await Promise.resolve();
    expect(f.step).toHaveBeenCalledTimes(4);
    expect(f.session.phase).toBe('replaying');
    scheduler.requests[1].resolve();
    await Promise.all(pending);
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('observes a genuine Promise through its intrinsic without reading an overridden then property', async () => {
    let resume!: () => void;
    const scheduled = new Promise<void>(resolve => { resume = resolve; });
    const thenGetter = vi.fn(() => { throw new Error('must not read own then'); });
    Object.defineProperty(scheduled, 'then', { get: thenGetter });
    let yieldCalls = 0;
    let yieldReceiver: unknown;
    // Keep mock return-value bookkeeping outside this deliberately poisoned
    // Promise. Only the session's intrinsic may inspect the returned object.
    const api = { yield: function (this: unknown) {
      yieldCalls++;
      yieldReceiver = this;
      return scheduled;
    } };
    vi.stubGlobal('scheduler', api);
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const pending = f.session.receive(batch(1, 4));
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(yieldCalls).toBe(1);
    expect(yieldReceiver).toBe(api);
    expect(thenGetter).not.toHaveBeenCalled();
    resume();
    await pending;
    expect(f.step).toHaveBeenCalledTimes(4);
    expect(f.messages('ack')).toHaveLength(4);
    expect(yieldCalls).toBe(1);
    expect(yieldReceiver).toBe(api);
    expect(thenGetter).not.toHaveBeenCalled();
    expect(f.events.failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['absolute', 'progress', 'barrier'] as const)('does not renew the %s deadline while a supported scheduler continuation waits', async (kind) => {
    const scheduler = controlledScheduler();
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
      // A genuine eight-frame final gap still yields after one whole 9ms frame;
      // the scheduler wait must not renew that fixed 1500ms work deadline.
      await f.session.receive(sync(8));
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args) as Record<string, unknown> | undefined;
        if (name === 'bhState') f.setWorkTime((result?.tick as number) * 9);
        return result;
      });
    }
    const firstSlice = kind === 'barrier' ? 1 : 2;
    const pending = f.session.receive(batch(firstTick, kind === 'barrier' ? 8 : 32));
    expect(f.step).toHaveBeenCalledTimes(firstTick + firstSlice - 1);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
    f.setTime(kind === 'absolute' ? 180001 : kind === 'barrier' ? 1501 : 10001);
    scheduler.requests[0].resolve();
    await pending;
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(firstTick + firstSlice - 1);
    expect(f.messages('ack')).toHaveLength(firstTick + firstSlice - 1);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
  });

  it('does not involve the scheduler in live-host frames', async () => {
    const scheduler = controlledScheduler();
    const f = fixture(host);
    await ready(f);
    const pending = Array.from({ length: 64 }, (_, index) => f.session.receive(frame(index + 1)));
    expect(f.step).toHaveBeenCalledTimes(64);
    await Promise.all(pending);
    expect(f.session.phase).toBe('running');
    expect(scheduler.api.yield).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

