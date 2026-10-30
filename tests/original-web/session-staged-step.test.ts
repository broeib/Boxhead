import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockstepBridge, StepResult } from '../../apps/original-web/src/bridge';
import { OriginalSession } from '../../apps/original-web/src/session';
import type { PlayerJoin, PlayerLeave, PrepareMessage, Slot } from '../../apps/original-web/src/protocol';

// These tests control a bridge promise to verify the session's scheduling
// contract. They are not native receipt, VM fidelity or browser FPS evidence.
const hash = 'a'.repeat(64);
const room = 'StagedRoom01';
const setup = { mode: 'Coop' as const, map: 'ROOM_Single_0001', characters: [0, 1] as [number, number] };
const digest = (tick: number) => 'native-v2-' + tick.toString(16).padStart(16, '0');
const player = (slot: Slot) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0,
  life: 200, flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 });
const frame = (tick: number, fields: Record<string, unknown> = {}) => ({ type: 'frame', tick, p1: 17, p2: 0, ...fields });
const peer = { type: 'peer', slot: 2, connected: true };
const pause = (tick: number, timeoutMs = 1500) => ({ type: 'join_sync', state: 'paused', tick, verified: tick - 1, timeoutMs });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controlledPaint() {
  const requests: (ReturnType<typeof deferred<void>> & { signal: AbortSignal })[] = [];
  const waiters: { count: number; resolve(): void }[] = [];
  const yieldPaint = vi.fn((signal: AbortSignal) => {
    const request = { ...deferred<void>(), signal };
    requests.push(request);
    for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve();
    return request.promise;
  });
  return { requests, yieldPaint, requested: (count: number) => new Promise<void>(resolve => {
    if (requests.length >= count) resolve(); else waiters.push({ count, resolve });
  }) };
}

const fixtureCleanup: (() => void)[] = [];
function fixture(options: { slot?: Slot; capable?: boolean; enableAfterJoin?: boolean; checkpoint?: boolean; align?: boolean } = {}) {
  const slot = options.slot ?? 1;
  const clock = { wall: 0, work: 0 };
  let capable = options.capable ?? true;
  let aligned = options.align ?? false;
  let inFlight = false;
  let nativeTick = 0;
  let roster: Slot[] = [1];
  const trace: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const paints = controlledPaint();
  const flights: (ReturnType<typeof deferred<StepResult>> & { tick: number; join?: PlayerJoin; signal?: AbortSignal })[] = [];
  const result = (tick: number, join?: PlayerJoin): StepResult => ({ tick, digest: digest(tick),
    worldTick: tick, players: (join ? [1, 2] as Slot[] : roster).map(player) });
  const step = vi.fn((tick: number, _p1: number, _p2: number, join?: PlayerJoin, leave?: PlayerLeave) => {
    expect(inFlight).toBe(false);
    nativeTick = tick;
    if (join) { roster = [1, 2]; if (options.enableAfterJoin) capable = true; }
    if (leave) roster = [1];
    trace.push('step:' + tick);
    return result(tick);
  });
  const stepStaged = vi.fn(async (tick: number, _p1: number, _p2: number, join?: PlayerJoin, signal?: AbortSignal) => {
    expect(inFlight).toBe(false);
    inFlight = true;
    const flight = { ...deferred<StepResult>(), tick, join, signal };
    flights.push(flight);
    trace.push('begin:' + tick);
    try {
      const value = await flight.promise;
      // The bridge contract resolves only after its own final readback. The
      // actual native implementation is qualified by separate bridge/VM tests.
      trace.push('commit:' + tick, 'info:' + tick, 'receipt:' + tick);
      nativeTick = tick;
      if (join) roster = [1, 2];
      return value;
    } finally { inFlight = false; }
  });
  const exportCheckpoint = vi.fn(() => {
    expect(inFlight).toBe(false);
    trace.push('export:' + nativeTick);
    return { version: 1 as const, tick: nativeTick, digest: digest(nativeTick), payload: 'fixture-immutable-payload' };
  });
  const bridge: LockstepBridge = { prepare: vi.fn(async () => {}), step, stepStaged,
    supportsStagedStep: vi.fn(() => capable && !inFlight),
    requiresPaintBeforeStep: vi.fn(() => aligned && capable && !inFlight),
    supportsCheckpoint: () => options.checkpoint === true, exportCheckpoint };
  const events = { joined: vi.fn(), peer: vi.fn((connected: boolean) => trace.push('peer:' + connected)),
    preparing: vi.fn(), prepared: vi.fn(), running: vi.fn(), replaying: vi.fn(),
    joinSync: vi.fn((message: { state: string }) => trace.push('sync:' + message.state)),
    stepped: vi.fn((tick: number) => trace.push('stepped:' + tick)),
    finishing: vi.fn(() => trace.push('finishing')), completed: vi.fn(() => trace.push('completed')), failed: vi.fn() };
  const send = vi.fn((message: Record<string, unknown>) => {
    sent.push(message); trace.push('send:' + message.type + ':' + (message.tick ?? message.mask ?? ''));
  });
  const close = vi.fn();
  const session = new OriginalSession(slot === 1 ? { type: 'create', setup, dropIn: true }
    : { type: 'join_open', room, character: 3 }, hash, bridge, { send, close }, events,
  () => clock.wall, () => clock.work, paints.yieldPaint);
  const value = { session, bridge, events, sent, send, close, trace, paints, flights, step, stepStaged,
    exportCheckpoint, clock, slot, result, setCapable: (enabled: boolean) => { capable = enabled; },
    setAligned: (enabled: boolean) => { aligned = enabled; },
    receive: (message: unknown) => session.receive(typeof message === 'string' ? message : JSON.stringify(message)),
    messages: (type: string) => sent.filter(message => message.type === type),
    finish: (index = 0, replacement?: StepResult) => {
      const flight = flights[index]; flight.resolve(replacement ?? result(flight.tick, flight.join));
    } };
  fixtureCleanup.push(() => {
    session.close();
    for (let index = 0; index < flights.length; index++) value.finish(index);
    for (const paint of paints.requests) paint.resolve();
  });
  return value;
}

async function ready(f: ReturnType<typeof fixture>, fields: Partial<PrepareMessage> = {}) {
  f.session.opened();
  await f.receive({ type: 'joined', room, slot: f.slot, token: 'test-only-token' });
  await f.receive({ type: 'prepare', ...setup, seed: 7, swfHash: hash, initialPlayers: 1,
    personalProgression: true, replay: f.slot === 2, ...fields });
}

async function warm(f: ReturnType<typeof fixture>, first = 1, last = 24) {
  for (let tick = first; tick <= last; tick++) await f.receive(frame(tick));
  f.trace.length = 0;
}

describe('staged live session FIFO (controlled bridge promises, not native or paint evidence)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('scheduler', undefined);
  });
  afterEach(async () => {
    for (const cleanup of fixtureCleanup.splice(0)) cleanup();
    await Promise.resolve(); await Promise.resolve();
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it('executes a full25 leave synchronously before opening the staged fence', async () => {
    const f = fixture(); await ready(f, { membershipVersion: 1 });
    await f.receive(frame(1, { join: { slot: 2, character: 1 } }));
    await warm(f, 2, 24);
    f.step.mockClear();
    await f.receive(frame(25, { leave: { slot: 2 } }));
    expect(f.session.phase).toBe('running');
    expect(f.step).toHaveBeenCalledExactlyOnceWith(25, 17, 0, undefined, { slot: 2 });
    expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.messages('ack').at(-1)).toEqual({ type: 'ack', tick: 25, digest: digest(25) });
  });

  it('owns the entire full step and ordered controls, then waits for paint before the next queued frame', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25));
    expect(f.stepStaged).toHaveBeenCalledOnce();
    expect(f.flights[0].signal).toBeInstanceOf(AbortSignal);
    const control = f.receive(peer);
    const next = f.receive(frame(26));
    expect(f.messages('ack')).toHaveLength(24);
    expect(f.events.peer).not.toHaveBeenCalled();
    expect(f.step).toHaveBeenCalledTimes(24);
    await Promise.resolve();
    expect(f.messages('ack')).toHaveLength(24);
    f.finish(); await current; await control; await f.paints.requested(1);
    expect(f.trace).toEqual(['begin:25', 'commit:25', 'info:25', 'receipt:25', 'send:ack:25', 'stepped:25', 'peer:true']);
    expect(f.step).toHaveBeenCalledTimes(24);
    f.paints.requests[0].resolve(); await next;
    expect(f.trace.slice(-3)).toEqual(['step:26', 'send:ack:26', 'stepped:26']);
    expect(f.session.phase).toBe('running');
  });

  it('uses the original synchronous path when capability is false, including full ticks', async () => {
    const f = fixture({ capable: false }); await ready(f); await warm(f, 1, 25);
    expect(f.step).toHaveBeenCalledTimes(25);
    expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.paints.yieldPaint).not.toHaveBeenCalled();
    expect(f.messages('ack').at(-1)).toEqual({ type: 'ack', tick: 25, digest: digest(25) });
  });

  it('fails an advertised capability without its mandatory staged method before entering the VM', async () => {
    const f = fixture(); await ready(f); await warm(f);
    delete f.bridge.stepStaged;
    await f.receive(frame(25));
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(24);
    expect(f.messages('ack')).toHaveLength(24);
  });

  it('keeps replay full ticks synchronous with the existing two-frame budget and ordinary task scheduler', async () => {
    const f = fixture({ slot: 2 }); await ready(f, { replayBatchMax: 8, replayBatchExtendedMax: 32 });
    const pending = f.receive({ type: 'replay_frames', frames: Array.from({ length: 26 }, (_, index) => frame(index + 1)) });
    expect(f.step).toHaveBeenCalledTimes(2);
    expect(f.messages('ack')).toHaveLength(2);
    await vi.runAllTimersAsync(); await pending;
    expect(f.step).toHaveBeenCalledTimes(26);
    expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.paints.yieldPaint).not.toHaveBeenCalled();
    expect(f.session.phase).toBe('replaying');
  });

  it('learns capability after the real guest join without creating a second replay/live owner', async () => {
    const f = fixture({ slot: 2, capable: false, enableAfterJoin: true });
    await ready(f); await warm(f);
    await f.receive({ type: 'caught_up', tick: 24 });
    await f.receive(frame(25, { join: { slot: 2, character: 3 }, p2: 17 }));
    expect(f.stepStaged).not.toHaveBeenCalled();
    await warm(f, 26, 49);
    const pending = f.receive(frame(50));
    expect(f.stepStaged).toHaveBeenCalledExactlyOnceWith(50, 17, 0, undefined, expect.any(AbortSignal), undefined);
    f.finish(); await pending;
    expect(f.messages('ack').at(-1)?.tick).toBe(50);
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('passes the exact full-tick spawn command and masks, and publishes membership only on completion', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const join = { slot: 2 as const, character: 3 };
    const pending = f.receive(frame(25, { join, p1: 65, p2: 17 }));
    expect(f.stepStaged).toHaveBeenCalledExactlyOnceWith(25, 65, 17, join, expect.any(AbortSignal), undefined);
    const later = f.receive(frame(26, { p2: 33 }));
    expect(f.messages('ack')).toHaveLength(24);
    f.finish(); await pending; await f.paints.requested(1);
    f.paints.requests[0].resolve(); await later;
    expect(f.step).toHaveBeenLastCalledWith(26, 17, 33);
    expect(f.session.phase).toBe('running');
  });

  it('retains the exact 32-frame live bound including the active partial tick', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const waits = [f.receive(frame(25))];
    for (let tick = 26; tick <= 56; tick++) waits.push(f.receive(frame(tick)));
    expect(f.session.phase).toBe('running');
    expect(f.step).toHaveBeenCalledTimes(24);
    expect(f.stepStaged).toHaveBeenCalledOnce();
    waits.push(f.receive(frame(57)));
    await Promise.all(waits);
    expect(f.session.phase).toBe('failed');
    expect(f.flights[0].signal?.aborted).toBe(true);
    f.finish(); await Promise.resolve(); await Promise.resolve();
    expect(f.messages('ack')).toHaveLength(24);
    expect(f.step).toHaveBeenCalledTimes(24);
  });

  it('bounds controls at 256 messages including the active frame without dispatching them early', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const waits = [f.receive(frame(25))];
    for (let index = 0; index < 255; index++) waits.push(f.receive(peer));
    expect(f.session.phase).toBe('running');
    expect(f.events.peer).not.toHaveBeenCalled();
    waits.push(f.receive(peer)); await Promise.all(waits);
    expect(f.session.phase).toBe('failed');
    expect(f.messages('ack')).toHaveLength(24);
    expect(f.events.peer).not.toHaveBeenCalled();
  });

  it.each(['close', 'disconnect', 'reject', 'error', 'paused', 'malformed'] as const)(
    'cancels %s immediately while native stages await, and ignores their stale completion', async kind => {
      const f = fixture(); await ready(f); await warm(f);
      const current = f.receive(frame(25));
      const next = f.receive(frame(26));
      const control = f.receive(peer);
      if (kind === 'close') f.session.close();
      else if (kind === 'disconnect') f.session.disconnected();
      else if (kind === 'reject') f.session.reject('fixture rejection');
      else if (kind === 'malformed') await f.receive('{');
      else await f.receive({ type: kind });
      await Promise.all([current, next, control]);
      expect(f.session.phase).toBe(kind === 'close' ? 'closed' : 'failed');
      expect(f.flights[0].signal?.aborted).toBe(true);
      f.finish(); await Promise.resolve(); await Promise.resolve();
      expect(f.messages('ack')).toHaveLength(24);
      expect(f.step).toHaveBeenCalledTimes(24);
      expect(f.events.peer).not.toHaveBeenCalled();
    });

  it('does not retry synchronous gameplay after a rejected staged transaction', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); const next = f.receive(frame(26));
    f.flights[0].reject(new Error('fixture commit/readback rejection'));
    await Promise.all([current, next]);
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(24);
    expect(f.messages('ack')).toHaveLength(24);
  });

  it.each(['tick', 'digest', 'players'] as const)('rejects a malformed final %s before ACK', async field => {
    const f = fixture(); await ready(f); await warm(f);
    const pending = f.receive(frame(25));
    const invalid = { ...f.result(25), [field]: field === 'tick' ? 26 : field === 'digest' ? '' : null } as unknown as StepResult;
    f.finish(0, invalid); await pending;
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(24);
  });

  it.each([25, 27])('rejects queued duplicate/skipped frame %s without executing it', async tick => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); const later = f.receive(frame(tick));
    f.finish(); await current; await f.paints.requested(1);
    f.paints.requests[0].resolve(); await later;
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(24); expect(f.stepStaged).toHaveBeenCalledOnce();
    expect(f.messages('ack').at(-1)?.tick).toBe(25);
  });

  it('checks the original progress deadline after stages without requiring a watchdog callback', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const pending = f.receive(frame(25));
    f.clock.wall = 10_001; f.finish(); await pending;
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(24);
  });

  it('does not renew progress while waiting for a post-commit paint opportunity', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); const later = f.receive(frame(26));
    f.clock.wall = 1000; f.finish(); await current; await f.paints.requested(1);
    f.clock.wall = 11_001;
    f.paints.requests[0].resolve(); await later;
    expect(f.session.phase).toBe('failed');
    expect(f.step).toHaveBeenCalledTimes(24);
    expect(f.messages('ack').at(-1)?.tick).toBe(25);
  });

  it('applies a received queued pause deadline to the active full tick before its ACK', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); f.clock.wall = 100;
    const control = f.receive(pause(25, 1000));
    f.clock.wall = 1101; f.finish(); await Promise.all([current, control]);
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(24);
    expect(f.events.joinSync).not.toHaveBeenCalled();
  });

  it('retains the pause receive timestamp instead of extending it when finally dispatched', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); f.clock.wall = 100;
    const control = f.receive(pause(25, 1000));
    f.clock.wall = 1000; f.finish(); await Promise.all([current, control]);
    expect(f.events.joinSync).toHaveBeenCalledOnce();
    f.clock.wall = 6101; // received100 +1000ms pause + unchanged5000ms host delivery grace.
    await f.receive({ type: 'join_sync', state: 'resumed', tick: 25, joined: false });
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack').at(-1)?.tick).toBe(25);
  });

  it('removes only dispatched barrier bookkeeping and permits later full ticks after a valid resume', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); f.clock.wall = 100;
    const paused = f.receive(pause(25, 1000));
    const resumed = f.receive({ type: 'join_sync', state: 'resumed', tick: 25, joined: false });
    const later = f.receive(frame(26));
    f.clock.wall = 500; f.finish(); await Promise.all([current, paused, resumed]);
    await f.paints.requested(1); f.paints.requests[0].resolve(); await later;
    expect(f.trace.indexOf('send:ack:25')).toBeLessThan(f.trace.indexOf('sync:paused'));
    expect(f.trace.indexOf('sync:resumed')).toBeLessThan(f.trace.indexOf('step:26'));
    f.clock.wall = 1500; await warm(f, 27, 49);
    const nextFull = f.receive(frame(50)); f.finish(1); await nextFull;
    expect(f.session.phase).toBe('running'); expect(f.messages('ack').at(-1)?.tick).toBe(50);
  });

  it('permits the original ready allowance before the first compact command', async () => {
    const f = fixture(); await ready(f); f.clock.wall = 100_000;
    await f.receive(frame(1));
    expect(f.session.phase).toBe('running'); expect(f.messages('ack').at(-1)?.tick).toBe(1);
  });

  it('keeps input transmission and held-key renewal independent while the VM transaction is frozen', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25));
    f.session.input(17); f.clock.wall = 200; f.session.checkTimeout();
    expect(f.messages('input').map(value => value.mask)).toEqual([17, 17]);
    expect(f.messages('ack')).toHaveLength(24);
    f.finish(); await current;
    expect(f.messages('ack').at(-1)?.tick).toBe(25);
  });

  it('rechecks the deadline after a synchronous input renewal callback before sending ACK', async () => {
    const f = fixture(); await ready(f); await warm(f); f.session.input(17);
    const current = f.receive(frame(25));
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(message => { send(message); if (message.type === 'input') f.clock.wall = 10_001; });
    f.clock.wall = 9999; f.finish(); await current;
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(24);
  });

  it('captures a checkpoint requested during stages only after the completed full receipt and ACK', async () => {
    const f = fixture({ checkpoint: true }); await ready(f); await warm(f);
    const current = f.receive(frame(25));
    const checkpoint = f.receive({ type: 'checkpoint_request', id: 'stagedcheckpoint', minimumTick: 25 });
    const later = f.receive(frame(26));
    expect(f.exportCheckpoint).not.toHaveBeenCalled();
    f.finish(); await Promise.all([current, checkpoint]); await f.paints.requested(1);
    expect(f.exportCheckpoint).toHaveBeenCalledOnce();
    expect(f.trace.indexOf('receipt:25')).toBeLessThan(f.trace.indexOf('send:ack:25'));
    expect(f.trace.indexOf('send:ack:25')).toBeLessThan(f.trace.indexOf('export:25'));
    expect(f.step).toHaveBeenCalledTimes(24);
    f.paints.requests[0].resolve(); await later;
    expect(f.trace.indexOf('export:25')).toBeLessThan(f.trace.indexOf('step:26'));
  });

  it('retains terminal ACK/completed ordering and ignores already issued later native frames', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); const later = f.receive(frame(26));
    const completed = f.receive({ type: 'completed', tick: 25, complete: 'player dead' });
    expect(f.events.completed).not.toHaveBeenCalled();
    f.finish(0, { ...f.result(25), complete: 'player dead' });
    await Promise.all([current, later, completed]);
    expect(f.session.phase).toBe('completed'); expect(f.step).toHaveBeenCalledTimes(24);
    expect(f.messages('ack').at(-1)).toEqual({ type: 'ack', tick: 25, digest: digest(25), complete: 'player dead' });
    expect(f.trace.indexOf('send:ack:25')).toBeLessThan(f.trace.indexOf('finishing'));
    expect(f.trace.indexOf('finishing')).toBeLessThan(f.trace.indexOf('completed'));
  });

  it('fails a throwing final ACK send and does not execute queued native work', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); const later = f.receive(frame(26));
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(message => {
      if (message.type === 'ack' && message.tick === 25) throw new Error('fixture send failure');
      send(message);
    });
    f.finish(); await Promise.all([current, later]);
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toHaveLength(24);
    expect(f.step).toHaveBeenCalledTimes(24);
  });

  it('appends a frame received reentrantly from the valid ACK callback to the same owner', async () => {
    const f = fixture(); await ready(f); await warm(f);
    let later: Promise<void> | undefined;
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(message => {
      send(message); if (message.type === 'ack' && message.tick === 25) later = f.receive(frame(26));
    });
    const current = f.receive(frame(25)); f.finish(); await current; await f.paints.requested(1);
    expect(later).toBeDefined(); expect(f.step).toHaveBeenCalledTimes(24);
    f.paints.requests[0].resolve(); await later;
    expect(f.messages('ack').at(-1)?.tick).toBe(26);
  });

  it.each(['reject', 'cancel'] as const)('never resumes queued work after the paint boundary %s', async kind => {
    const f = fixture(); await ready(f); await warm(f);
    const current = f.receive(frame(25)); const later = f.receive(frame(26));
    f.finish(); await current; await f.paints.requested(1);
    if (kind === 'reject') f.paints.requests[0].reject(new Error('fixture renderer stalled'));
    else f.session.close();
    await later;
    f.paints.requests[0].resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.step).toHaveBeenCalledTimes(24);
    expect(f.messages('ack').at(-1)?.tick).toBe(25);
    expect(f.session.phase).toBe(kind === 'cancel' ? 'closed' : 'failed');
  });

  it('yields queued compact catch-up work again after 8ms instead of coalescing it into the post-commit task', async () => {
    const f = fixture(); await ready(f); await warm(f);
    const step = f.step.getMockImplementation()!;
    f.step.mockImplementation((...args) => { const value = step(...args); f.clock.work += 8; return value; });
    const current = f.receive(frame(25)); const next = f.receive(frame(26)); const third = f.receive(frame(27));
    f.finish(); await current; await f.paints.requested(1);
    f.paints.requests[0].resolve(); await next; await f.paints.requested(2);
    expect(f.messages('ack').at(-1)?.tick).toBe(26);
    expect(f.step).toHaveBeenCalledTimes(25);
    f.paints.requests[1].resolve(); await third;
    expect(f.messages('ack').at(-1)?.tick).toBe(27);
  });

  it('aligns isolated compact steps after paint before entering native code or sending ACK', async () => {
    const f = fixture({ align: true }); await ready(f);
    const first = f.receive(frame(1));
    expect(f.paints.requests).toHaveLength(1);
    expect(f.step).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
    f.paints.requests[0].resolve(); await first;
    expect(f.trace.slice(-3)).toEqual(['step:1', 'send:ack:1', 'stepped:1']);
    f.clock.wall = 40; f.clock.work = 40;
    const second = f.receive(frame(2));
    expect(f.paints.requests).toHaveLength(2); expect(f.step).toHaveBeenCalledOnce();
    f.paints.requests[1].resolve(); await second;
    expect(f.messages('ack').map(value => value.tick)).toEqual([1, 2]);
  });

  it('retains FIFO controls and one rendering opportunity for each queued aligned compact step', async () => {
    const f = fixture({ align: true }); await ready(f);
    const first = f.receive(frame(1)), control = f.receive(peer), second = f.receive(frame(2));
    expect(f.events.peer).not.toHaveBeenCalled(); expect(f.step).not.toHaveBeenCalled();
    f.paints.requests[0].resolve(); await first; await control; await f.paints.requested(2);
    expect(f.trace.indexOf('send:ack:1')).toBeLessThan(f.trace.indexOf('peer:true'));
    expect(f.step).toHaveBeenCalledOnce();
    f.paints.requests[1].resolve(); await second;
    expect(f.trace.indexOf('peer:true')).toBeLessThan(f.trace.indexOf('step:2'));
    expect(f.messages('ack').map(value => value.tick)).toEqual([1, 2]);
  });

  it('aligns full Begin and the next compact without exposing an ACK before the actual receipt', async () => {
    const f = fixture(); await ready(f); await warm(f); f.setAligned(true);
    const full = f.receive(frame(25)), next = f.receive(frame(26));
    expect(f.stepStaged).not.toHaveBeenCalled(); expect(f.messages('ack')).toHaveLength(24);
    f.paints.requests[0].resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.stepStaged).toHaveBeenCalledOnce(); expect(f.messages('ack')).toHaveLength(24);
    f.finish(); await full; await f.paints.requested(2);
    expect(f.trace.indexOf('receipt:25')).toBeLessThan(f.trace.indexOf('send:ack:25'));
    expect(f.step).toHaveBeenCalledTimes(24);
    f.paints.requests[1].resolve(); await next;
    expect(f.paints.requests).toHaveLength(2);
    expect(f.messages('ack').at(-1)?.tick).toBe(26);
  });

  it.each(['close', 'fatal'] as const)('cancels an aligned pre-step wait on %s without ever entering native code', async kind => {
    const f = fixture({ align: true }); await ready(f);
    const pending = f.receive(frame(1));
    if (kind === 'close') f.session.close();
    else await f.receive({ type: 'paused' });
    expect(f.paints.requests[0].signal.aborted).toBe(true);
    f.paints.requests[0].resolve(); await pending;
    expect(f.step).not.toHaveBeenCalled(); expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
    expect(f.session.phase).toBe(kind === 'close' ? 'closed' : 'failed');
  });

  it('does not renew the running progress deadline while waiting for the aligned paint', async () => {
    const f = fixture(); await ready(f); await warm(f, 1, 1); f.setAligned(true);
    const pending = f.receive(frame(2));
    f.clock.wall = 10_001; f.paints.requests[0].resolve(); await pending;
    expect(f.session.phase).toBe('failed'); expect(f.step).toHaveBeenCalledOnce();
    expect(f.messages('ack').map(value => value.tick)).toEqual([1]);
  });
});
