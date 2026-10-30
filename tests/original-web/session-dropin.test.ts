import { describe, expect, it, vi } from 'vitest';
import { OriginalBridge, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { OriginalSession } from '../../apps/original-web/src/session';
import { DEFAULT_SETTINGS, type ConnectionIntent, type PrepareMessage, type Slot } from '../../apps/original-web/src/protocol';

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
      if (args[5] !== undefined) roster = [1];
      trace.push(`step:${nativeTick}`);
      return { tick: nativeTick, digest: `native-${nativeTick}`, players: roster.map(player) };
    }
    if (name === 'bhState') {
      trace.push(`state:${nativeTick}`);
      return { tick: nativeTick, digest: `native-${nativeTick}`, rng: 7,
        players: roster.map(player), entities: [] };
    }
    if (name === 'bhReplayEnd') return { version: 1, engine: 'original-swf', state: nativePhase, tick: nativeTick };
    return undefined;
  });
  const bridge = new OriginalBridge(invoke);
  const step = vi.spyOn(bridge, 'step');
  const session = new OriginalSession(intent, hash, bridge, {
    send: (message) => { sent.push(message); trace.push(`send:${message.type}:${message.tick ?? ''}`); }, close,
  }, events, () => now);
  return { session, bridge, step, invoke, events, sent, trace, close,
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

async function caughtUp(f: ReturnType<typeof fixture>, tick = 1) {
  await ready(f);
  for (let index = 1; index <= tick; index++) await f.session.receive(frame(index));
  await f.session.receive(JSON.stringify({ type: 'caught_up', tick }));
}

describe('drop-in client state machine (stub callbacks, not browser proof)', () => {
  it('executes and checks departure before accepting another guest', async () => {
    const f = fixture();
    await ready(f, { membershipVersion: 1 });
    await f.session.receive(frame(1));
    await f.session.receive(frame(2, { join: { slot: 2, character: 2 } }));
    await f.session.receive(frame(3, { leave: { slot: 2 } }));
    await f.session.receive(frame(4, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('running');
    expect(f.messages('ack')).toEqual([1, 2, 3, 4].map(tick => ({ type: 'ack', tick, digest: `native-${tick}` })));
    expect(f.invoke).toHaveBeenCalledWith('bhStep', 3, 17, 0, undefined, undefined, { slot: 2 });
  });

  it('replays earlier guest input and departure before ending native replay', async () => {
    const f = fixture(guest);
    await ready(f, { membershipVersion: 1 });
    await f.session.receive(frame(1));
    await f.session.receive(frame(2, { join: { slot: 2, character: 2 } }));
    await f.session.receive(frame(3, { p2: 8 }));
    await f.session.receive(frame(4, { leave: { slot: 2 } }));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 4 }));
    await f.session.receive(frame(5, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('running');
    expect(f.invoke).toHaveBeenCalledWith('bhReplayEnd', 4);
    expect(f.messages('ack')).toHaveLength(5);
  });

  it.each([
    { mode: 'Coop' as const, initialPlayers: 2 as const },
    { mode: 'DeathMatch' as const, initialPlayers: 1 as const },
    { mode: 'DeathMatch' as const, initialPlayers: 2 as const },
  ])('replays and replaces a guest with membership v2: $mode, initial=$initialPlayers', async options => {
    const f = fixture(guest);
    await ready(f, { ...options, membershipVersion: 2 });
    if (options.initialPlayers === 1) {
      await f.session.receive(frame(1));
      await f.session.receive(frame(2, { join: { slot: 2, character: 2 } }));
    } else {
      await f.session.receive(frame(1, { p2: 8 }));
      await f.session.receive(frame(2, { p2: 8 }));
    }
    await f.session.receive(frame(3, { leave: { slot: 2 } }));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 3 }));
    await f.session.receive(frame(4, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('running');
    expect(f.invoke).toHaveBeenCalledWith('bhReplayEnd', 3);
    expect(f.messages('ack')).toHaveLength(4);
  });

  it('starts a solo host once immediately after joined, before any peer arrives', async () => {
    const f = fixture();
    await joined(f);
    expect(f.sent).toEqual([
      { type: 'create', swfHash: hash, ...setup, listed: true, dropIn: true },
      { type: 'start' },
    ]);
    f.session.start();
    expect(f.messages('start')).toHaveLength(1);
    expect(f.events.peer).not.toHaveBeenCalled();
    expect(f.step).not.toHaveBeenCalled();
    await f.session.receive(JSON.stringify(prepare));
    await f.session.receive(frame(1));
    expect(f.session.phase).toBe('running');
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
  });

  it('preserves a guest character request and never lets that guest start the room', async () => {
    const f = fixture(guest);
    await joined(f);
    f.session.start();
    expect(f.sent).toEqual([{ type: 'join_open', swfHash: hash, room, character: 3 }]);
  });

  it('prepares a replaying guest from the host-only initial roster with its local slot', async () => {
    const f = fixture(guest);
    await ready(f);
    expect(f.invoke).toHaveBeenCalledWith('bhPrepare', 7, 'Coop', setup.map, 0, 1, DEFAULT_SETTINGS,
      { initialPlayers: 1, personalProgression: true, localSlot: 2, replay: true });
    expect(f.session.phase).toBe('replaying');
    expect(f.messages('ready')).toEqual([{ type: 'ready' }]);
    expect(f.events.replaying).toHaveBeenCalledWith(0);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('keeps replay input-free and ACKs every frame only after native step, info and readback', async () => {
    const f = fixture(guest);
    await ready(f);
    f.trace.length = 0;
    for (let tick = 1; tick <= 3; tick++) {
      f.setTime(tick * 500);
      f.session.input(17);
      f.session.input(0, true);
      f.session.checkTimeout();
      await f.session.receive(frame(tick, { p1: tick }));
    }
    expect(f.messages('input')).toEqual([]);
    expect(f.trace).toEqual([1, 2, 3].flatMap((tick) => [
      `step:${tick}`, `info:${tick}`, `state:${tick}`, `send:ack:${tick}`,
    ]));
    expect(f.messages('ack')).toEqual([1, 2, 3].map((tick) => ({ type: 'ack', tick, digest: `native-${tick}` })));
    expect(f.step.mock.calls).toEqual([[1, 1, 0], [2, 2, 0], [3, 3, 0]]);
    expect(f.events.replaying.mock.calls).toEqual([[0], [1], [2], [3]]);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('never ACKs a replay frame whose actual native readback disagrees', async () => {
    const f = fixture(guest);
    await ready(f);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      return name === 'bhState' ? { ...(result as Record<string, unknown>), digest: 'wrong-native-state' } : result;
    });
    await f.session.receive(frame(1));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([]);
    expect(f.messages('input')).toEqual([]);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([0, 2])('rejects caught_up tick %s when only tick 1 has a native ACK', async (tick) => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick }));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
    expect(f.messages('input')).toEqual([]);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('does not permit a host to replay history or consume a guest catch-up confirmation', async () => {
    const replayHost = fixture();
    await joined(replayHost);
    await replayHost.session.receive(JSON.stringify({ ...prepare, replay: true }));
    expect(replayHost.session.phase).toBe('failed');
    expect(replayHost.invoke).not.toHaveBeenCalled();
    const liveHost = fixture();
    await ready(liveHost);
    await liveHost.session.receive(frame(1));
    await liveHost.session.receive(JSON.stringify({ type: 'caught_up', tick: 1 }));
    expect(liveHost.session.phase).toBe('failed');
    expect(liveHost.step).toHaveBeenCalledTimes(1);
  });

  it('enables guest input only after an exact catch-up point and verified commanded spawn', async () => {
    const f = fixture(guest);
    await caughtUp(f, 2);
    expect(f.session.phase).toBe('running');
    f.session.input(16);
    f.session.input(0, true);
    f.setTime(200);
    f.session.checkTimeout();
    expect(f.messages('input')).toEqual([]);
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(frame(3, { join: { slot: 2, character: 3 } }));
    expect(f.step).toHaveBeenLastCalledWith(3, 17, 0, { slot: 2, character: 3 });
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    f.session.input(16);
    expect(f.messages('input')).toEqual([{ type: 'input', seq: 1, mask: 16 }]);
    expect(f.messages('ack')).toHaveLength(3);
  });

  it('can join at verified tick zero while still requiring the first commanded spawn', async () => {
    const f = fixture(guest);
    await caughtUp(f, 0);
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
    await f.session.receive(frame(1, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('running');
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
  });

  it('rejects a second catch-up confirmation without running another native frame', async () => {
    const f = fixture(guest);
    await caughtUp(f);
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 1 }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('requires the frame immediately after caught_up to contain the spawn', async () => {
    const f = fixture(guest);
    await caughtUp(f);
    await f.session.receive(frame(2));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it.each([
    { description: 'second-player input in host-only history', extra: { p2: 16 } },
    { description: 'unsupported leave in host-only history', extra: { leave: { slot: 2 } } },
  ])('rejects $description before executing native replay', async ({ extra }) => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(frame(1, extra));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
    expect(f.messages('input')).toEqual([]);
  });

  it('replays a previous guest and its input with native readbacks and no local control', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(frame(1, { join: { slot: 2, character: 1 } }));
    await f.session.receive(frame(2, { p2: 16 }));
    f.session.input(17);
    expect(f.step.mock.calls).toEqual([[1, 17, 0, { slot: 2, character: 1 }], [2, 17, 16]]);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' },
      { type: 'ack', tick: 2, digest: 'native-2' }]);
    expect(f.messages('input')).toEqual([]);
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 2 }));
    expect(f.session.phase).toBe('failed');
  });

  it('fails before executing a leave after the previous guest has joined', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(frame(1, { join: { slot: 2, character: 1 } }));
    await f.session.receive(frame(2, { leave: { slot: 2 } }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
    expect(f.messages('input')).toEqual([]);
  });

  it('does not ACK a historical join if the native digest readback disagrees', async () => {
    const f = fixture(guest);
    await ready(f);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      return name === 'bhState' ? { ...(result as Record<string, unknown>), digest: 'different' } : result;
    });
    await f.session.receive(frame(1, { join: { slot: 2, character: 1 } }));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([]);
  });

  it('rejects a live leave before the native step as well', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1, { join: { slot: 2, character: 1 } }));
    await f.session.receive(frame(2, { leave: { slot: 2 } }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
  });

  it('accepts exactly one spawn for the running solo host', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'peer', slot: 2, connected: true }));
    expect(f.session.phase).toBe('running');
    expect(f.events.peer).toHaveBeenCalledWith(true);
    await f.session.receive(frame(2, { join: { slot: 2, character: 3 } }));
    expect(f.messages('ack')).toHaveLength(2);
    await f.session.receive(frame(3, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('accepts a verified guest at tick zero while the solo host is ready for its first frame', async () => {
    const f = fixture();
    await ready(f);
    expect(f.session.phase).toBe('ready');
    // The service can finish a zero-history catch-up before its first frame
    // timer fires. Its peer notice must not invalidate the prepared host.
    await f.session.receive(JSON.stringify({ type: 'peer', slot: 2, connected: true }));
    expect(f.session.phase).toBe('ready');
    expect(f.events.peer).toHaveBeenCalledWith(true);
    expect(f.step).not.toHaveBeenCalled();
    await f.session.receive(frame(1, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('running');
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('does not accept another spawn in a world prepared with two players', async () => {
    const f = fixture();
    await ready(f, { initialPlayers: 2 });
    await f.session.receive(frame(1, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it('requires the actual native readback to contain the commanded guest, not just the step result', async () => {
    const f = fixture(guest);
    await caughtUp(f);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      return name === 'bhState' ? { ...(result as Record<string, unknown>), players: [player(1)] } : result;
    });
    await f.session.receive(frame(2, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('does not ACK an uncommanded second native player during solo history', async () => {
    const f = fixture(guest);
    await ready(f);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      return name === 'bhState' ? { ...(result as Record<string, unknown>), players: [player(1), player(2)] } : result;
    });
    await f.session.receive(frame(1));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([]);
    expect(f.messages('input')).toEqual([]);
  });

  it.each(['close', 'reject'] as const)('sends no input when %s occurs during replay or before the spawn', async (action) => {
    for (const synchronized of [false, true]) {
      const f = fixture(guest);
      if (synchronized) await caughtUp(f);
      else await ready(f);
      f.session.input(16);
      if (action === 'close') f.session.close();
      else f.session.reject('Test stop');
      expect(f.messages('input')).toEqual([]);
      expect(f.close).toHaveBeenCalledOnce();
    }
  });

  it('renews the replay timeout only after each verified native frame', async () => {
    const f = fixture(guest);
    await ready(f);
    f.setTime(9_000);
    await f.session.receive(frame(1));
    f.setTime(19_000);
    f.session.input(16);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('replaying');
    f.setTime(19_001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.messages('input')).toEqual([]);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1' }]);
  });

  it('allows a continuing replay to last over ten seconds without disabling the per-frame watchdog', async () => {
    const f = fixture(guest);
    await ready(f);
    for (let tick = 1; tick <= 3; tick++) {
      f.setTime(tick * 9_000);
      f.session.checkTimeout();
      expect(f.session.phase).toBe('replaying');
      await f.session.receive(frame(tick));
    }
    expect(f.messages('ack')).toHaveLength(3);
    f.setTime(37_001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
  });

  it('bounds waiting for the commanded spawn after caught_up and sends no input on timeout', async () => {
    const f = fixture(guest);
    await ready(f);
    f.setTime(9_000);
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 0 }));
    f.setTime(19_000);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('running');
    f.setTime(19_001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.messages('input')).toEqual([]);
    expect(f.step).not.toHaveBeenCalled();
  });

  it('allows host peer notices while playing without treating them as native progress', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    f.setTime(9_000);
    await f.session.receive(JSON.stringify({ type: 'peer', slot: 2, connected: true }));
    await f.session.receive(JSON.stringify({ type: 'peer', slot: 2, connected: false }));
    expect(f.session.phase).toBe('running');
    expect(f.events.peer.mock.calls).toEqual([[true], [false]]);
    expect(f.step).toHaveBeenCalledTimes(1);
    f.setTime(45_001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
  });

  it('holds the host past its ordinary watchdog only within the announced fixed deadline, then resumes with fresh input', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    f.session.input(17);
    f.setTime(1000);
    const paused = { type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 60000 };
    await f.session.receive(JSON.stringify(paused));
    f.setTime(30000);
    f.session.input(16);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('running');
    expect(f.messages('input')).toEqual([{ type: 'input', seq: 1, mask: 17 }]);
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.events.joinSync).toHaveBeenCalledWith(paused, 1);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 1, verified: 1 }));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'resumed', tick: 1, joined: false }));
    f.session.checkTimeout();
    expect(f.messages('input')).toHaveLength(1);
    await f.session.receive(frame(2));
    f.session.input(2);
    expect(f.messages('input')).toEqual([{ type: 'input', seq: 1, mask: 17 }, { type: 'input', seq: 2, mask: 2 }]);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('does not extend the host absolute deadline when valid progress messages keep arriving', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 20000 }));
    f.setTime(19000);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 1, verified: 1 }));
    f.session.checkTimeout();
    expect(f.session.phase).toBe('running');
    f.setTime(20001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('running'); // Bounded delivery grace for the server's cancellation.
    f.setTime(24000);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 1, verified: 1 }));
    f.setTime(25001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.messages('input')).toEqual([]);
    expect(f.step).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('accepts a same-world resumed(joined=%s) delivered just after the server hard deadline', async (joined) => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 1000 }));
    f.setTime(1500);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('running');
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'resumed', tick: 1, joined }));
    await f.session.receive(frame(2, joined ? { join: { slot: 2, character: 3 } } : {}));
    expect(f.session.phase).toBe('running');
    expect(f.messages('ack')).toHaveLength(2);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('replays toward the fixed boundary but still waits for the actual native guest spawn before enabling control', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 3, verified: 1, timeoutMs: 120000 }));
    await f.session.receive(frame(2));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 3, verified: 2 }));
    await f.session.receive(frame(3));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 3 }));
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(frame(4, { join: { slot: 2, character: 3 } }));
    f.session.input(16);
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('input')).toEqual([{ type: 'input', seq: 1, mask: 16 }]);
    expect(f.messages('ack')).toHaveLength(4);
  });

  it.each([1480, 1500])('accepts delayed final controls after a fixed target checked at %s ms, without enabling early input', async (finishedAt) => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 2, verified: 0, timeoutMs: 1500 }));
    f.setTime(1400);
    await f.session.receive(frame(1));
    f.setTime(finishedAt);
    await f.session.receive(frame(2));
    expect(f.messages('ack')).toHaveLength(2);
    // The server can accept the final ACK and promote before its deadline,
    // while the final progress/caught_up delivery arrives after ours.
    f.setTime(1510);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('replaying');
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 2, verified: 2 }));
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 2 }));
    f.session.input(16);
    expect(f.messages('input')).toEqual([]);
    expect(f.events.running).not.toHaveBeenCalled();
    f.setTime(1520);
    await f.session.receive(frame(3, { join: { slot: 2, character: 3 } }));
    f.session.input(16);
    expect(f.session.phase).toBe('running');
    expect(f.messages('ack')).toHaveLength(3);
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('input')).toEqual([{ type: 'input', seq: 1, mask: 16 }]);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('expires a missing caught_up at the fixed delivery deadline despite repeated final progress', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 1500 }));
    f.setTime(1480);
    await f.session.receive(frame(1));
    for (const time of [1510, 6499]) {
      f.setTime(time);
      await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 1, verified: 1 }));
      f.session.checkTimeout();
      expect(f.session.phase).toBe('replaying');
    }
    f.setTime(6500);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('replaying');
    f.setTime(6501);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toHaveLength(1);
    expect(f.messages('input')).toEqual([]);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each(['progress', 'caught_up'])('rejects %s after the fixed delivery grace even without a watchdog callback', async (kind) => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 1500 }));
    f.setTime(1480);
    await f.session.receive(frame(1));
    f.setTime(6501);
    await f.session.receive(JSON.stringify(kind === 'progress'
      ? { type: 'join_sync', state: 'progress', tick: 1, verified: 1 }
      : { type: 'caught_up', tick: 1 }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it.each(['watchdog', 'frame', 'progress', 'caught_up'])('does not grant delivery grace to an unfinished target: %s', async (action) => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 2, verified: 0, timeoutMs: 1500 }));
    f.setTime(1480);
    await f.session.receive(frame(1));
    f.setTime(1510);
    if (action === 'watchdog') f.session.checkTimeout();
    else await f.session.receive(action === 'frame' ? frame(2) : JSON.stringify(action === 'progress'
      ? { type: 'join_sync', state: 'progress', tick: 2, verified: 1 }
      : { type: 'caught_up', tick: 2 }));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
    expect(f.messages('input')).toEqual([]);
  });

  it('rejects a native replay step that started before but completed after the original deadline without sending its ACK', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 1500 }));
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      if (name === 'bhState') f.setTime(1501);
      return result;
    });
    f.setTime(1490);
    await f.session.receive(frame(1));
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([]);
    expect(f.events.stepped).not.toHaveBeenCalled();
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick: 1 }));
    expect(f.session.phase).toBe('failed');
    expect(f.events.running).not.toHaveBeenCalled();
  });

  it('does not accept non-final progress after the work deadline even after reaching the target on time', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 1500 }));
    f.setTime(1480);
    await f.session.receive(frame(1));
    f.setTime(1510);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 1, verified: 0 }));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toHaveLength(1);
  });

  it('does not execute a new replay frame during final control delivery grace', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 1500 }));
    f.setTime(1480);
    await f.session.receive(frame(1));
    f.setTime(1510);
    await f.session.receive(frame(2));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
  });

  it.each([0, 1])('recognizes a verified target already reached before the pause message, including tick %s', async (tick) => {
    const f = fixture(guest);
    await ready(f);
    if (tick === 1) await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick, verified: tick, timeoutMs: 1500 }));
    f.setTime(1510);
    f.session.checkTimeout();
    await f.session.receive(JSON.stringify({ type: 'caught_up', tick }));
    expect(f.session.phase).toBe('running');
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(frame(tick + 1, { join: { slot: 2, character: 3 } }));
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('keeps the guest per-frame watchdog during synchronization even when progress is announced', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 3, verified: 0, timeoutMs: 120000 }));
    f.setTime(10000);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'progress', tick: 3, verified: 0 }));
    f.setTime(10001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([]);
    expect(f.messages('input')).toEqual([]);
  });

  it('keeps a separate absolute guest deadline even while native replay continues to make progress', async () => {
    const f = fixture(guest);
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 10, verified: 0, timeoutMs: 6000 }));
    for (let tick = 1; tick <= 3; tick++) {
      f.setTime(tick * 2000);
      await f.session.receive(frame(tick));
    }
    f.setTime(6001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toHaveLength(3);
    expect(f.messages('input')).toEqual([]);
  });

  it('supports the zero-history ready host and one subsequent spawn', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 0, verified: 0, timeoutMs: 120000 }));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'resumed', tick: 0, joined: true }));
    await f.session.receive(frame(1, { join: { slot: 2, character: 3 } }));
    expect(f.session.phase).toBe('running');
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('rejects an advancing host frame while its agreed world is paused without invoking native work', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 120000 }));
    await f.session.receive(frame(2));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toHaveLength(1);
  });

  it.each(['completed', 'timeout'])('preserves the terminal %s path when a pause names a later ignored in-flight tick', async (outcome) => {
    const f = fixture();
    await ready(f);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      return name === 'bhStep' ? { ...(result as Record<string, unknown>), complete: 'player dead' } : result;
    });
    await f.session.receive(frame(1));
    await f.session.receive(frame(2));
    expect(f.session.phase).toBe('completing');
    f.setTime(9000);
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 2, verified: 0, timeoutMs: 120000 }));
    expect(f.session.phase).toBe('completing');
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(f.step).toHaveBeenCalledTimes(1);
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-1', complete: 'player dead' }]);
    if (outcome === 'completed') {
      await f.session.receive(JSON.stringify({ type: 'completed', tick: 1, complete: 'player dead' }));
      expect(f.session.phase).toBe('completed');
      expect(f.events.completed).toHaveBeenCalledExactlyOnceWith(1, 'player dead');
    } else {
      f.setTime(45001);
      f.session.checkTimeout();
      expect(f.session.phase).toBe('failed');
    }
    expect(f.messages('input')).toEqual([]);
  });

  it.each([
    { type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 120000 },
    { type: 'join_sync', state: 'progress', tick: 2, verified: 0 },
    { type: 'join_sync', state: 'resumed', tick: 2, joined: false },
  ])('rejects attempts to restart or move a fixed host boundary: %j', async (message) => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(JSON.stringify({ type: 'join_sync', state: 'paused', tick: 1, verified: 0, timeoutMs: 120000 }));
    await f.session.receive(JSON.stringify(message));
    expect(f.session.phase).toBe('failed');
    expect(f.messages('input')).toEqual([]);
    expect(f.step).toHaveBeenCalledTimes(1);
  });
});
