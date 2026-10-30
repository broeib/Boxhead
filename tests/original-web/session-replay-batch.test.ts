import { describe, expect, it, vi } from 'vitest';
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
  }, events, () => now, () => 0);
  return { session, bridge, step, invoke, events, sent, trace, close, send,
    slot: (intent.type === 'create' ? 1 : 2) as Slot,
    setTime: (value: number) => { now = value; },
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

describe('negotiated replay batches (stub native callbacks, not native/browser evidence)', () => {
  it('keeps an old server handshake and original single-frame replay compatible', async () => {
    const f = fixture(guest);
    await ready(f);
    expect(f.messages('ready')).toEqual([{ type: 'ready' }]);
    await f.session.receive(frame(1));
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
    expect(f.session.phase).toBe('replaying');
  });

  it.each([[1, 1], [2, 2], [4, 4], [5, 5], [7, 7], [8, 8]])('accepts offer %s with bounded ready.replayBatch=%s', async (offer, selected) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: offer });
    expect(f.messages('ready')).toEqual([{ type: 'ready', replayBatch: selected }]);
    expect(f.session.phase).toBe('replaying');
  });

  it.each([9, 16, 24, 31, 32, 33, 63, 64])('selects the explicitly extended offer %s while keeping the legacy field bounded', async (selected) => {
    const f = fixture(guest);
    await ready(f, replayOffer(selected));
    expect(f.messages('ready')).toEqual([{ type: 'ready', replayBatch: selected }]);
    expect(f.session.phase).toBe('replaying');
  });

  it('executes a large packet, an adaptive group8 and a final short tail through the same native path', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    await f.session.receive(batch(1, 32));
    await f.session.receive(batch(33, 8));
    expect(f.step).toHaveBeenCalledTimes(40);
    expect(f.session.phase).toBe('replaying');
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 43, verified: 40, timeoutMs: 1500 }));
    await f.session.receive(batch(41, 3));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 43 }));
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    await f.session.receive(frame(44, { join: { slot: 2, character: 3 } }));
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 44 }, (_, index) => index + 1));
  });

  it('rejects a packet33 after the explicitly negotiated offer32', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    await f.session.receive(batch(1, 33));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
  });

  it('prevalidates the last of thirty-two frames before any native step', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const invalid = JSON.parse(batch(1, 32));
    invalid.frames[31].tick = 33;
    await f.session.receive(JSON.stringify(invalid));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
  });

  it.each(['readback', 'native-throw', 'abort', 'terminal', 'ack-send'])('stops batch32 at frame31 on %s', async (kind) => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      if (kind === 'native-throw' && name === 'bhStep' && args[0] === 31) throw new Error('native fixture failed');
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (kind === 'readback' && name === 'bhState' && result?.tick === 31) return { ...result, digest: 'wrong' };
      if (kind === 'abort' && name === 'bhState' && result?.tick === 31) f.session.close();
      if (kind === 'terminal' && name === 'bhStep' && result?.tick === 31) return { ...result, complete: 'player dead' };
      return result;
    });
    if (kind === 'ack-send') {
      const send = f.send.getMockImplementation()!;
      f.send.mockImplementation(message => {
        if (message.type === 'ack' && message.tick === 31) throw new Error('fixture socket failed');
        send(message);
      });
    }
    await f.session.receive(batch(1, 32));
    expect(f.step).toHaveBeenCalledTimes(31);
    expect(f.messages('ack')).toHaveLength(kind === 'terminal' ? 31 : 30);
    expect(f.session.phase).toBe(kind === 'abort' ? 'closed' : kind === 'terminal' ? 'completing' : 'failed');
    await f.session.receive(batch(33, 32));
    expect(f.step).toHaveBeenCalledTimes(31);
  });

  it.each(['before', 'after'])('enforces the absolute deadline %s the thirty-first frame without a timer callback', async (when) => {
    const f = fixture(guest);
    await ready(f, replayOffer(32));
    for (let tick = 1; tick <= 19; tick++) {
      f.setTime(tick * 9000); await f.session.receive(frame(tick));
    }
    f.setTime(179999);
    if (when === 'before') {
      f.events.stepped.mockImplementation(tick => { if (tick === 49) f.setTime(180001); });
    } else {
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args) as Record<string, unknown> | undefined;
        if (name === 'bhState' && result?.tick === 50) f.setTime(180001);
        return result;
      });
    }
    await f.session.receive(batch(20, 32));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 49 : 50);
    expect(f.messages('ack')).toHaveLength(49);
    await f.session.receive(batch(52, 32));
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 49 : 50);
  });

  it('does not add batch negotiation to a host or ordinary two-player preparation', async () => {
    for (const intent of [host, guest]) {
      const f = fixture(intent);
      await ready(f, { initialPlayers: 2, replay: false });
      expect(f.messages('ready')).toEqual([{ type: 'ready' }]);
    }
  });

  it.each([4, 8, 32, 64])('preserves %s complete native step/info/readback/ACK sequences across bounded replay tasks', async (count) => {
    const f = fixture(guest);
    await ready(f, replayOffer(count));
    const ticks = Array.from({ length: count }, (_, index) => index + 1);
    f.trace.length = 0;
    let microtaskRan = false;
    queueMicrotask(() => { microtaskRan = true; });
    const pending = f.session.receive(batch(1, count));
    expect(f.step).toHaveBeenCalledTimes(Math.min(count, 2));
    expect(microtaskRan).toBe(false);
    await pending;
    expect(microtaskRan).toBe(true);
    expect(f.trace).toEqual(ticks.flatMap((tick) => [
      'step:' + tick, 'info:' + tick, 'state:' + tick, 'send:ack:' + tick,
    ]));
    expect(f.messages('ack')).toEqual(ticks.map((tick) => ({ type: 'ack', tick, digest: 'native-' + tick })));
    expect(f.events.stepped.mock.calls).toEqual(ticks.map(tick => [tick]));
    f.session.input(17);
    expect(f.messages('input')).toEqual([]);
    expect(f.session.phase).toBe('replaying');
  });

  it.each([1, 2, 3, 4, 5, 6, 7])('accepts a final short batch of %s and still waits for the real native guest spawn', async (count) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 8 });
    await f.session.receive(sync(count));
    await f.session.receive(batch(1, count));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: count }));
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(frame(count + 1, { join: { slot: 2, character: 3 } }));
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('ack')).toHaveLength(count + 1);
    f.session.input(16);
    expect(f.messages('input')).toHaveLength(1);
  });

  it.each(['unnegotiated', 'host', 'oversize', 'wrong-first-tick', 'after-caught-up'])('rejects an inadmissible batch: %s', async (kind) => {
    const f = fixture(kind === 'host' ? host : guest);
    await ready(f, kind === 'host' || kind === 'unnegotiated' ? {} : { replayBatchMax: 4 });
    if (kind === 'after-caught-up') await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 0 }));
    await f.session.receive(batch(kind === 'wrong-first-tick' ? 2 : 1, kind === 'oversize' ? 5 : 4));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('rejects nine frames even after negotiating the eight-frame maximum', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 8 });
    await f.session.receive(batch(1, 9));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('stops an eight-frame packet at its seventh native readback mismatch', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 8 });
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      return name === 'bhState' && result?.tick === 7 ? { ...result, digest: 'wrong' } : result;
    });
    await f.session.receive(batch(1, 8));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(7);
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2, 3, 4, 5, 6]);
    await f.session.receive(batch(9, 8));
    expect(f.step).toHaveBeenCalledTimes(7);
  });

  it.each(['before', 'after'])('checks the fixed barrier deadline %s the seventh frame of an eight-frame packet', async (when) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 8 });
    await f.session.receive(sync(8));
    f.setTime(1490);
    if (when === 'before') {
      f.events.stepped.mockImplementation((tick) => { if (tick === 6) f.setTime(1501); });
    } else {
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args) as Record<string, unknown> | undefined;
        if (name === 'bhState' && result?.tick === 7) f.setTime(1501);
        return result;
      });
    }
    await f.session.receive(batch(1, 8));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 6 : 7);
    expect(f.messages('ack').map(message => message.tick)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([
    { tick: 3 }, { tick: 1 }, { p2: 16 }, { leave: { slot: 2 } }, { extra: true },
  ])('prevalidates every nested frame before executing a valid prefix: %j', async (change) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const invalid = JSON.parse(batch(1));
    Object.assign(invalid.frames[1], change);
    await f.session.receive(JSON.stringify(invalid));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('executes historical join and guest input in a batch and verifies each digest', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const frames = JSON.parse(batch(1)).frames;
    frames[1].join = { slot: 2, character: 1 };
    frames[2].p2 = 16;
    await f.session.receive(JSON.stringify({ type: 'replay_frames', frames }));
    expect(f.session.phase).toBe('replaying');
    expect(f.step.mock.calls).toEqual([[1, 17, 0], [2, 17, 0, { slot: 2, character: 1 }],
      [3, 17, 16], [4, 17, 0]]);
    expect(f.messages('ack')).toEqual([1, 2, 3, 4].map(tick => ({ type: 'ack', tick, digest: `native-${tick}` })));
    expect(f.events.running).not.toHaveBeenCalled();
    expect(f.messages('input')).toEqual([]);
  });

  it('rejects a batch containing leave before executing its valid prefix', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const frames = JSON.parse(batch(1)).frames;
    frames[0].join = { slot: 2, character: 1 };
    frames[1].p2 = 16;
    frames[2].leave = { slot: 2 };
    frames[3].join = { slot: 2, character: 3 };
    await f.session.receive(JSON.stringify({ type: 'replay_frames', frames }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('rejects duplicate historical joins before executing a batch prefix', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const frames = JSON.parse(batch(1)).frames;
    frames[0].join = { slot: 2, character: 1 };
    frames[2].join = { slot: 2, character: 3 };
    await f.session.receive(JSON.stringify({ type: 'replay_frames', frames }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('rejects a whole batch that crosses the fixed barrier target', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    await f.session.receive(sync(3));
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('rejects a duplicate batch without re-executing any native frame', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    await f.session.receive(batch(1));
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(4);
    expect(f.messages('ack')).toHaveLength(4);
  });

  it.each(['readback-digest', 'native-tick', 'native-throw'])('stops at the first failed native result: %s', async (failure) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      if (failure === 'native-throw' && name === 'bhStep' && args[0] === 2) throw new Error('native fixture failed');
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (failure === 'readback-digest' && name === 'bhState' && result?.tick === 2) return { ...result, digest: 'wrong' };
      if (failure === 'native-tick' && name === 'bhStep' && args[0] === 2) return { ...result, tick: 3 };
      return result;
    });
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
    expect(f.events.stepped.mock.calls).toEqual([[1]]);
    await f.session.receive(batch(5));
    expect(f.step).toHaveBeenCalledTimes(2);
  });

  it('checks abort after native readback and does not ACK or run the next item', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (name === 'bhState' && result?.tick === 2) f.session.close();
      return result;
    });
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('closed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(1);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('stops the synchronous batch when a progress callback rejects the session', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    f.events.stepped.mockImplementation(() => f.session.reject('fixture cancellation'));
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
  });

  it('keeps the real terminal frame and never steps the remaining historical items', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      return name === 'bhStep' && args[0] === 2 ? { ...result, complete: 'player dead' } : result;
    });
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('completing');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toEqual([
      { type: 'ack', tick: 1, digest: 'native-1' },
      { type: 'ack', tick: 2, digest: 'native-2', complete: 'player dead' },
    ]);
  });

  it('does not execute another item after an ACK transport failure', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation((message) => {
      if (message.type === 'ack' && message.tick === 2) throw new Error('fixture socket failed');
      send(message);
    });
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(1);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('does not enter the first native frame after the fixed barrier deadline', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    await f.session.receive(sync(4));
    f.setTime(1501);
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('checks the deadline between frames even when the watchdog cannot run', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    await f.session.receive(sync(4));
    f.setTime(1490);
    f.events.stepped.mockImplementation(() => f.setTime(1501));
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
  });

  it('does not ACK a frame whose actual native readback crosses the barrier deadline', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    await f.session.receive(sync(4));
    f.setTime(1490);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (name === 'bhState' && result?.tick === 2) f.setTime(1501);
      return result;
    });
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(1);
  });

  it('preserves final-control delivery grace only after every batched native frame finished on time', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    await f.session.receive(sync(4));
    f.setTime(1500);
    await f.session.receive(batch(1));
    expect(f.messages('ack')).toHaveLength(4);
    f.setTime(1510);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('replaying');
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 4, verified: 4 }));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 4 }));
    expect(f.session.phase).toBe('running');
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(frame(5, { join: { slot: 2, character: 3 } }));
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
  });

  it.each([[4, 'before'], [4, 'after'], [8, 'before'], [8, 'after'], [32, 'before'], [32, 'after'], [64, 'before'], [64, 'after']] as const)('enforces the fixed 180-second work budget for batch%s %s each native step', async (count, when) => {
    const f = fixture(guest);
    await ready(f, replayOffer(count));
    // Regular genuine stub readbacks keep the progress watchdog alive; they
    // must not extend the separate absolute deadline set when ready was sent.
    for (let tick = 1; tick <= 19; tick++) {
      f.setTime(tick * 9000);
      await f.session.receive(frame(tick));
    }
    f.setTime(179999);
    await f.session.receive(frame(20));
    if (when === 'before') f.setTime(180001);
    else {
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args);
        if (name === 'bhState') f.setTime(180001);
        return result;
      });
    }
    await f.session.receive(batch(21, count));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 20 : 21);
    expect(f.messages('ack')).toHaveLength(20);
  });

  it.each(['before', 'after'])('keeps the ordinary progress watchdog %s each synchronous replay frame', async (when) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    if (when === 'before') f.setTime(10001);
    else {
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args);
        if (name === 'bhState') f.setTime(10001);
        return result;
      });
    }
    await f.session.receive(batch(1));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(f.messages('ack')).toEqual([]);
  });

  it('rejects delayed caught_up beyond the absolute deadline without synchronization or a watchdog callback', async () => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    for (let tick = 1; tick <= 19; tick++) {
      f.setTime(tick * 9000);
      await f.session.receive(frame(tick));
    }
    f.setTime(179999);
    await f.session.receive(batch(20, 1));
    expect(f.session.phase).toBe('replaying');
    expect(f.messages('ack')).toHaveLength(20);
    f.setTime(180001);
    // Deliberately do not run checkTimeout: receive must enforce this bound.
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 20 }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(20);
    expect(f.messages('ack')).toHaveLength(20);
    expect(f.events.running).not.toHaveBeenCalled();
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([180001, 184999, 185000, 185001])('bounds earned final-control grace by the absolute deadline at %s ms', async (receivedAt) => {
    const f = fixture(guest);
    await ready(f, { replayBatchMax: 4 });
    for (let tick = 1; tick <= 19; tick++) {
      f.setTime(tick * 9000);
      await f.session.receive(frame(tick));
    }
    f.setTime(179000);
    await f.session.receive(JSON.stringify({
      type: 'join_sync', state: 'paused', tick: 20, verified: 19, timeoutMs: 1500,
    }));
    // The sync deadline is 180500, later than the original absolute 180000.
    // Finish the real target within both work deadlines; its control grace is
    // valid, but cannot postpone the absolute control bound beyond 185000.
    f.setTime(179999);
    await f.session.receive(batch(20, 1));
    expect(f.messages('ack')).toHaveLength(20);
    f.setTime(receivedAt);
    // Again no watchdog callback between native completion and this control.
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 20 }));
    expect(f.step).toHaveBeenCalledTimes(20);
    expect(f.messages('ack')).toHaveLength(20);
    expect(f.events.running).not.toHaveBeenCalled();
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    if (receivedAt <= 185000) {
      expect(f.session.phase).toBe('running');
      expect(f.events.failed).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      await f.session.receive(frame(21, { join: { slot: 2, character: 3 } }));
      expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
      expect(f.messages('ack')).toHaveLength(21);
    } else {
      expect(f.session.phase).toBe('failed');
      expect(f.close).toHaveBeenCalledOnce();
    }
  });
  it('executes packet64, adaptive group8 and final short tail with a single real native spawn boundary', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    expect(f.messages('ready')).toEqual([{ type: 'ready', replayBatch: 64 }]);
    await f.session.receive(batch(1, 64));
    await f.session.receive(batch(65, 8));
    expect(f.step).toHaveBeenCalledTimes(72);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 75, verified: 72, timeoutMs: 1500 }));
    await f.session.receive(batch(73, 3));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 75 }));
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    await f.session.receive(frame(76, { join: { slot: 2, character: 3 } }));
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('ack').map(message => message.tick)).toEqual(Array.from({ length: 76 }, (_, index) => index + 1));
  });

  it('rejects packet65 even after the extended maximum offer64', async () => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    await f.session.receive(batch(1, 65));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
  });

  it.each([62, 63])('prevalidates malformed member index%s of packet64 before any native step', async (index) => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const invalid = JSON.parse(batch(1, 64));
    invalid.frames[index].tick++;
    await f.session.receive(JSON.stringify(invalid));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
  });

  it.each(['readback', 'native-throw', 'abort', 'terminal', 'ack-send'])('stops batch64 at frame63 on %s', async (kind) => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      if (kind === 'native-throw' && name === 'bhStep' && args[0] === 63) throw new Error('native fixture failed');
      const result = delegate(name, ...args) as Record<string, unknown> | undefined;
      if (kind === 'readback' && name === 'bhState' && result?.tick === 63) return { ...result, digest: 'wrong' };
      if (kind === 'abort' && name === 'bhState' && result?.tick === 63) f.session.close();
      if (kind === 'terminal' && name === 'bhStep' && result?.tick === 63) return { ...result, complete: 'player dead' };
      return result;
    });
    if (kind === 'ack-send') {
      const send = f.send.getMockImplementation()!;
      f.send.mockImplementation(message => {
        if (message.type === 'ack' && message.tick === 63) throw new Error('fixture socket failed');
        send(message);
      });
    }
    await f.session.receive(batch(1, 64));
    expect(f.step).toHaveBeenCalledTimes(63);
    expect(f.messages('ack')).toHaveLength(kind === 'terminal' ? 63 : 62);
    expect(f.session.phase).toBe(kind === 'abort' ? 'closed' : kind === 'terminal' ? 'completing' : 'failed');
    await f.session.receive(batch(65, 64));
    expect(f.step).toHaveBeenCalledTimes(63);
  });

  it.each(['before', 'after'])('checks the absolute deadline %s the63rd frame without a timer callback', async (when) => {
    const f = fixture(guest);
    await ready(f, replayOffer(64));
    for (let tick = 1; tick <= 19; tick++) {
      f.setTime(tick * 9000); await f.session.receive(frame(tick));
    }
    f.setTime(179999);
    if (when === 'before') {
      f.events.stepped.mockImplementation(tick => { if (tick === 81) f.setTime(180001); });
    } else {
      const delegate = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, ...args) => {
        const result = delegate(name, ...args) as Record<string, unknown> | undefined;
        if (name === 'bhState' && result?.tick === 82) f.setTime(180001);
        return result;
      });
    }
    await f.session.receive(batch(20, 64));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 81 : 82);
    expect(f.messages('ack')).toHaveLength(81);
    await f.session.receive(batch(84, 64));
    expect(f.step).toHaveBeenCalledTimes(when === 'before' ? 81 : 82);
  });

});
