import { afterEach, describe, expect, it, vi } from 'vitest';
import { OriginalSession } from '../../apps/original-web/src/session';
import type { LockstepBridge, StepResult } from '../../apps/original-web/src/bridge';
import { parseServerMessage, type Slot } from '../../apps/original-web/src/protocol';

// Controlled bridge receipts verify protocol/timing, not native VM fidelity.
const hash = 'a'.repeat(64);
const room = 'NetworkRoom1';
const setup = { mode: 'Coop' as const, map: 'ROOM_Single_0001', characters: [0, 1] as [number, number] };
const frame = (tick: number, fields = {}) => ({ type: 'frame', tick, p1: 0, p2: 0, ...fields });
const waiting = (tick: number, timeoutMs = 30_000, slots: Slot[] = [2]) =>
  ({ type: 'network_status', state: 'waiting', tick, timeoutMs, slots });
const resumed = (tick: number) => ({ type: 'network_status', state: 'resumed', tick });
const result = (tick: number): StepResult => ({ tick, digest: `native-network-${tick}`, players: [1, 2].map(slot =>
  ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200, flags: 9,
    state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 })) });
const cleanups: (() => void)[] = [];

function fixture(kind: 'sync' | 'full' | 'compact' = 'sync', slot: Slot = 1) {
  const clock = { now: 0 };
  const sent: Record<string, unknown>[] = [];
  const events = { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), running: vi.fn(), stepped: vi.fn(),
    networkStatus: vi.fn(), completed: vi.fn(), failed: vi.fn() };
  const bridge: LockstepBridge = { prepare: vi.fn(async () => {}), step: vi.fn(result),
    supportsStagedStep: () => kind === 'full', supportsCompactStep: () => kind === 'compact',
    stepStaged: vi.fn(async tick => result(tick)), stepCompact: vi.fn(async tick => result(tick)) };
  const close = vi.fn();
  const session = new OriginalSession(slot === 1 ? { type: 'create', setup }
    : { type: 'join_open', room }, hash, bridge, { send: message => { sent.push(message); }, close },
  events, () => clock.now, () => 0, async () => {});
  cleanups.push(() => session.close());
  return { session, clock, events, bridge, close,
    receive: (message: unknown) => session.receive(JSON.stringify(message)),
    messages: (type: string) => sent.filter(message => message.type === type),
    ready: async (fields = {}) => {
      await session.receive(JSON.stringify({ type: 'joined', room, slot, token: 'test-token' }));
      await session.receive(JSON.stringify({ type: 'prepare', ...setup, seed: 7, swfHash: hash,
        initialPlayers: 2, membershipVersion: 2, personalProgression: true, ...fields }));
      expect(session.phase).toBe((fields as { replay?: boolean }).replay ? 'replaying' : 'ready');
    } };
}

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('strict network recovery wire messages', () => {
  it.each([waiting(0, 1, [1]), waiting(2, 60_000, [2, 1]), resumed(0)])('accepts the exact contract %j', message => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });
  const malformed = [
    { ...waiting(0), state: 'paused' }, { ...waiting(0), tick: -1 }, { ...waiting(0), tick: 1.5 },
    { ...waiting(0), tick: 0x80000000 }, { ...waiting(0), timeoutMs: 0 },
    { ...waiting(0), timeoutMs: 60_001 }, { ...waiting(0), timeoutMs: '30000' },
    { ...waiting(0), slots: [] }, { ...waiting(0), slots: [1, 1] }, { ...waiting(0), slots: [3] },
    { ...waiting(0), slots: ['1'] }, { ...waiting(0), slots: null }, { ...waiting(0), slots: [1, 2, 1] },
    { type: 'network_status', state: 'waiting', tick: 0, slots: [1] },
    { type: 'network_status', state: 'waiting', tick: 0, timeoutMs: 1 },
    { ...waiting(0), extra: true }, { ...resumed(0), timeoutMs: 1 }, { ...resumed(0), slots: [1] },
    { type: 'network_status', state: 'resumed' }, { type: 'network_status', state: 'unknown', tick: 0 },
  ];
  it.each(malformed)('rejects malformed recovery fields %j', message => {
    expect(() => parseServerMessage(JSON.stringify(message))).toThrow();
  });
  it('fails the active session closed on a malformed notice', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1));
    await f.receive({ ...waiting(0), slots: [2, 2] });
    expect(f.session.phase).toBe('failed'); expect(f.close).toHaveBeenCalledOnce();
    expect(f.events.networkStatus).not.toHaveBeenCalled();
    expect(f.messages('ack')).toHaveLength(1);
  });
});

describe('bounded live network recovery', () => {
  it.each(['sync', 'full', 'compact'] as const)('executes a delayed %s frame after 15 seconds of quiet network time', async kind => {
    const f = fixture(kind); await f.ready();
    const target = kind === 'full' ? 25 : 2;
    for (let tick = 1; tick < target; tick++) await f.receive(frame(tick));
    f.clock.now = 15_000; f.session.checkTimeout();
    expect(f.session.phase).toBe('running');
    await f.receive(frame(target));
    expect(f.session.phase).toBe('running');
    expect(f.messages('ack').at(-1)).toEqual({ type: 'ack', tick: target, digest: result(target).digest });
    expect(f.events.failed).not.toHaveBeenCalled();
  });

  it('pauses input, preserves native tick and resumes without fabricating an ACK or advancing the world', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1)); await f.receive(frame(2));
    f.session.input(17);
    f.clock.now = 5000; await f.receive(waiting(0));
    expect(f.messages('input').at(-1)).toMatchObject({ mask: 0, clear: true });
    const inputCount = f.messages('input').length;
    f.session.input(32); f.clock.now = 15_000; f.session.checkTimeout();
    expect(f.messages('input')).toHaveLength(inputCount);
    expect(f.events.stepped.mock.calls).toEqual([[1], [2]]);
    await f.receive(resumed(2));
    expect(f.events.networkStatus.mock.calls).toEqual([[waiting(0)], [resumed(2)]]);
    expect(f.messages('ack')).toHaveLength(2);
    await f.receive(frame(3));
    expect(f.session.phase).toBe('running'); expect(f.messages('ack').at(-1)?.tick).toBe(3);
    f.session.input(32); expect(f.messages('input').at(-1)).toMatchObject({ mask: 32 });
  });

  it('accepts a tick-zero pause while a guest is ready for its first frame', async () => {
    const f = fixture('compact', 2); await f.ready();
    f.clock.now = 5000; await f.receive(waiting(0, 30_000, [1]));
    f.clock.now = 15_000; f.session.checkTimeout(); await f.receive(resumed(0));
    expect(f.session.phase).toBe('ready'); expect(f.events.running).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
    await f.receive(frame(1)); expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('keeps the first deadline when partial verification and repeated waiting notices arrive', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1)); await f.receive(frame(2));
    f.clock.now = 5000; await f.receive(waiting(0, 30_000, [1, 2]));
    f.clock.now = 34_000; await f.receive(waiting(1));
    f.clock.now = 40_000; f.session.checkTimeout(); expect(f.session.phase).toBe('running');
    f.clock.now = 40_001; f.session.checkTimeout();
    expect(f.session.phase).toBe('failed'); expect(f.events.networkStatus).toHaveBeenLastCalledWith(null);
    expect(f.messages('ack')).toHaveLength(2);
  });

  it('allows bounded delivery of the host resume emitted at guest eviction, then accepts the real leave frame', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1)); await f.receive(frame(2));
    f.clock.now = 5000; await f.receive(waiting(0));
    f.clock.now = 35_100; await f.receive({ type: 'peer', slot: 2, connected: false });
    await f.receive(resumed(2)); await f.receive(frame(3, { leave: { slot: 2 } }));
    expect(f.session.phase).toBe('running');
    expect(f.bridge.step).toHaveBeenLastCalledWith(3, 0, 0, undefined, { slot: 2 });
    expect(f.messages('ack').at(-1)?.tick).toBe(3);
  });

  it.each(['frame', 'resume'] as const)('rejects a late %s beyond the fixed deadline even without a watchdog callback', async kind => {
    const f = fixture(); await f.ready(); await f.receive(frame(1));
    f.clock.now = 5000; await f.receive(waiting(0));
    f.clock.now = 40_001; await f.receive(kind === 'frame' ? frame(2) : resumed(1));
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(1);
    expect(f.bridge.step).toHaveBeenCalledOnce();
  });

  it('never renews the 45-second idle limit with a resume control', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1));
    f.clock.now = 5000; await f.receive(waiting(0));
    f.clock.now = 34_000; await f.receive(resumed(1));
    f.clock.now = 45_000; f.session.checkTimeout(); expect(f.session.phase).toBe('running');
    f.clock.now = 45_001; await f.receive(frame(2));
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(1);
  });

  it.each([waiting(4), resumed(1)])('rejects a future tick or unsolicited resume %j', async message => {
    const f = fixture(); await f.ready();
    for (let tick = 1; tick <= 3; tick++) await f.receive(frame(tick));
    await f.receive(message);
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(3);
  });

  it.each([32, 33])('bounds server verification lag at the configured live queue limit: %i ticks', async lag => {
    const f = fixture(); await f.ready();
    for (let tick = 1; tick <= lag; tick++) await f.receive(frame(tick));
    await f.receive(waiting(0));
    expect(f.messages('ack')).toHaveLength(lag);
    if (lag === 32) {
      expect(f.session.phase).toBe('running');
      await f.receive(resumed(lag)); await f.receive(frame(lag + 1));
      expect(f.session.phase).toBe('running'); expect(f.messages('ack').at(-1)?.tick).toBe(lag + 1);
    } else {
      expect(f.session.phase).toBe('failed'); expect(f.events.networkStatus).not.toHaveBeenCalled();
    }
  });

  it('rejects a frame before resume without executing it', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1)); await f.receive(waiting(0));
    await f.receive(frame(2)); expect(f.session.phase).toBe('failed');
    expect(f.bridge.step).toHaveBeenCalledOnce();
  });

  it('bounds even an oversized server allowance to 45 seconds while ready', async () => {
    const f = fixture(); await f.ready(); await f.receive(waiting(0, 60_000));
    f.clock.now = 45_000; f.session.checkTimeout(); expect(f.session.phase).toBe('ready');
    f.clock.now = 45_001; await f.receive(resumed(0));
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
  });

  it('keeps waiting/resumed controls behind the real in-flight native receipt', async () => {
    const f = fixture('compact'); await f.ready();
    let finish!: (value: StepResult) => void;
    vi.mocked(f.bridge.stepCompact!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.receive(frame(1)); f.clock.now = 5000;
    const notice = f.receive(waiting(0));
    expect(f.events.networkStatus).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
    finish(result(1)); await pending; await notice;
    expect(f.events.networkStatus).toHaveBeenCalledExactlyOnceWith(waiting(0));
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: result(1).digest }]);
    f.clock.now = 15_000; await f.receive(resumed(1)); await f.receive(frame(2));
    expect(f.session.phase).toBe('running'); expect(f.messages('ack')).toHaveLength(2);
  });

  it('checks a queued network deadline before ACK without granting control-delivery grace to native work', async () => {
    const f = fixture('compact'); await f.ready();
    let finish!: (value: StepResult) => void;
    vi.mocked(f.bridge.stepCompact!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.receive(frame(1)); f.clock.now = 100;
    const notice = f.receive(waiting(0, 1000)); f.clock.now = 1101;
    finish(result(1)); await Promise.all([pending, notice]);
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
    expect(f.events.networkStatus).not.toHaveBeenCalled();
  });

  it('handles guest eviction while a native terminal result awaits server confirmation', async () => {
    const f = fixture(); await f.ready();
    vi.mocked(f.bridge.step).mockReturnValue({ ...result(1), complete: 'player dead' });
    await f.receive(frame(1)); f.clock.now = 5000; await f.receive(waiting(0));
    f.clock.now = 35_100; await f.receive({ type: 'peer', slot: 2, connected: false });
    await f.receive({ type: 'completed', tick: 1, complete: 'player dead' });
    expect(f.session.phase).toBe('completed'); expect(f.events.failed).not.toHaveBeenCalled();
    expect(f.events.networkStatus).toHaveBeenLastCalledWith(null);
    expect(f.messages('ack')).toHaveLength(1);
  });

  it('rejects recovery during replay without changing its existing work budget', async () => {
    const f = fixture('sync', 2); await f.ready({ replay: true, initialPlayers: 1 });
    await f.receive(waiting(0)); expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toEqual([]); expect(f.events.networkStatus).not.toHaveBeenCalled();
  });

  it.each(['completed', 'disconnected', 'close'] as const)('clears the waiting event on %s', async end => {
    const f = fixture(); await f.ready();
    vi.mocked(f.bridge.step).mockReturnValue({ ...result(1), complete: 'player dead' });
    await f.receive(frame(1)); await f.receive(waiting(0));
    f.clock.now = 15_000; f.session.checkTimeout(); expect(f.session.phase).toBe('completing');
    if (end === 'completed') await f.receive({ type: 'completed', tick: 1, complete: 'player dead' });
    else f.session[end]();
    expect(f.events.networkStatus).toHaveBeenLastCalledWith(null);
    expect(f.bridge.step).toHaveBeenCalledOnce(); expect(f.messages('ack')).toHaveLength(1);
  });

  it.each(['full', 'compact'] as const)('still cancels a genuinely hung %s native transaction after ten seconds', async kind => {
    const f = fixture(kind); await f.ready(); const target = kind === 'full' ? 25 : 2;
    for (let tick = 1; tick < target; tick++) await f.receive(frame(tick));
    let finish!: (value: StepResult) => void;
    const callback = kind === 'full' ? f.bridge.stepStaged! : f.bridge.stepCompact!;
    vi.mocked(callback).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.clock.now = 15_000; const pending = f.receive(frame(target));
    // The prior committed compact requires its existing paint boundary.
    await Promise.resolve(); await Promise.resolve();
    f.clock.now = 25_000; f.session.checkTimeout(); expect(f.session.phase).toBe('running');
    f.clock.now = 25_001; f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    finish(result(target)); await pending;
    expect(f.messages('ack')).toHaveLength(target - 1);
    expect(f.events.stepped).toHaveBeenCalledTimes(target - 1);
  });

  it('does not ACK synchronous native work that returns after ten seconds without a timer callback', async () => {
    const f = fixture(); await f.ready(); await f.receive(frame(1)); f.clock.now = 15_000;
    vi.mocked(f.bridge.step).mockImplementationOnce(tick => { f.clock.now += 10_001; return result(tick); });
    await f.receive(frame(2)); expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(1);
  });
});
