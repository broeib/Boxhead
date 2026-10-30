import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockstepBridge, StepResult } from '../../apps/original-web/src/bridge';
import { OriginalSession } from '../../apps/original-web/src/session';
import type { PlayerJoin, PlayerLeave, PrepareMessage, Slot } from '../../apps/original-web/src/protocol';

// These tests control a bridge promise to verify the session's scheduling
// contract. They are not native receipt, VM fidelity or browser FPS evidence.
const hash = 'a'.repeat(64);
const room = 'CompactRoom01';
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
function fixture(options: { slot?: Slot; full?: boolean; compact?: boolean; enableAfterJoin?: boolean; checkpoint?: boolean; align?: boolean } = {}) {
  const slot = options.slot ?? 1;
  const clock = { wall: 0, work: 0 };
  let fullCapable = options.full ?? true;
  let compactCapable = options.compact ?? true;
  let aligned = options.align ?? false;
  let inFlight = false;
  let nativeTick = 0;
  let roster: Slot[] = [1];
  const trace: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const paints = controlledPaint();
  const flights: (ReturnType<typeof deferred<StepResult>> & { kind: 'full' | 'compact'; tick: number; join?: PlayerJoin; signal?: AbortSignal })[] = [];
  const result = (tick: number, join?: PlayerJoin): StepResult => ({ tick, digest: digest(tick),
    worldTick: tick, players: (join ? [1, 2] as Slot[] : roster).map(player) });
  const step = vi.fn((tick: number, _p1: number, _p2: number, join?: PlayerJoin, leave?: PlayerLeave) => {
    expect(inFlight).toBe(false);
    nativeTick = tick;
    if (join) { roster = [1, 2]; if (options.enableAfterJoin) { fullCapable = true; compactCapable = true; } }
    if (leave) roster = [1];
    trace.push('step:' + tick);
    return result(tick);
  });
  const phased = async (kind: 'full' | 'compact', tick: number, _p1: number, _p2: number, join?: PlayerJoin, signal?: AbortSignal) => {
    expect(inFlight).toBe(false);
    inFlight = true;
    const flight = { ...deferred<StepResult>(), kind, tick, join, signal };
    flights.push(flight);
    trace.push('begin:' + kind + ':' + tick);
    try {
      const value = await flight.promise;
      // The bridge contract resolves only after its own final readback. The
      // actual native implementation is qualified by separate bridge/VM tests.
      trace.push('commit:' + kind + ':' + tick, 'info:' + tick, 'receipt:' + tick);
      nativeTick = tick;
      if (join) roster = [1, 2];
      return value;
    } finally { inFlight = false; }
  };
  const stepStaged = vi.fn((tick: number, p1: number, p2: number, join?: PlayerJoin, signal?: AbortSignal) =>
    phased('full', tick, p1, p2, join, signal));
  const stepCompact = vi.fn((tick: number, p1: number, p2: number, join?: PlayerJoin, signal?: AbortSignal) =>
    phased('compact', tick, p1, p2, join, signal));
  const exportCheckpoint = vi.fn(() => {
    expect(inFlight).toBe(false);
    trace.push('export:' + nativeTick);
    return { version: 1 as const, tick: nativeTick, digest: digest(nativeTick), payload: 'fixture-immutable-payload' };
  });
  const bridge: LockstepBridge = { prepare: vi.fn(async () => {}), step, stepStaged, stepCompact,
    supportsStagedStep: vi.fn(() => fullCapable && !inFlight),
    supportsCompactStep: vi.fn(() => compactCapable && !inFlight),
    requiresPaintBeforeStep: vi.fn(() => aligned && (fullCapable || compactCapable) && !inFlight),
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
  const value = { session, bridge, events, sent, send, close, trace, paints, flights, step, stepStaged, stepCompact,
    exportCheckpoint, clock, slot, result,
    capabilities: () => ({ full: fullCapable, compact: compactCapable }),
    setCapabilities: (full: boolean, compact: boolean) => { fullCapable = full; compactCapable = compact; },
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
  f.trace.length = 0;
}

async function warmSync(f: ReturnType<typeof fixture>, last = 23) {
  const before = f.capabilities();
  f.setCapabilities(false, false);
  for (let tick = 1; tick <= last; tick++) await f.receive(frame(tick));
  f.setCapabilities(before.full, before.compact);
  f.trace.length = 0;
}

async function releasePaint(f: ReturnType<typeof fixture>, index: number) {
  await f.paints.requested(index + 1);
  f.paints.requests[index].resolve();
  // Wake the suspended FIFO owner, then its selected bridge promise.
  await Promise.resolve(); await Promise.resolve();
}

describe('compact two-phase live FIFO (controlled promises, not native or FPS evidence)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('scheduler', undefined);
  });
  afterEach(async () => {
    for (const cleanup of fixtureCleanup.splice(0)) cleanup();
    await Promise.resolve(); await Promise.resolve();
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it('holds ordinary gameplay, controls and the next frame until the actual compact receipt completes', async () => {
    const f = fixture(); await ready(f);
    const current = f.receive(frame(1));
    expect(f.stepCompact).toHaveBeenCalledExactlyOnceWith(1, 17, 0, undefined, expect.any(AbortSignal), undefined);
    const control = f.receive(peer), later = f.receive(frame(2));
    expect(f.messages('ack')).toEqual([]); expect(f.events.peer).not.toHaveBeenCalled();
    expect(f.step).not.toHaveBeenCalled(); expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.bridge.supportsCompactStep?.()).toBe(false);
    f.finish(); await current; await control; await f.paints.requested(1);
    expect(f.trace).toEqual(['begin:compact:1', 'commit:compact:1', 'info:1', 'receipt:1',
      'send:ack:1', 'stepped:1', 'peer:true']);
    expect(f.stepCompact).toHaveBeenCalledOnce();
    await releasePaint(f, 0); expect(f.flights[1].kind).toBe('compact');
    expect(f.messages('ack')).toHaveLength(1);
    f.finish(1); await later;
    expect(f.messages('ack').map(value => value.tick)).toEqual([1, 2]);
  });

  it('retains compact24, full25 four-phase and compact26 ordering under one FIFO owner', async () => {
    const f = fixture(); await ready(f); await warmSync(f);
    const compact = f.receive(frame(24)), full = f.receive(frame(25)), later = f.receive(frame(26));
    expect(f.flights.map(value => value.kind)).toEqual(['compact']);
    f.finish(); await compact; await releasePaint(f, 0);
    expect(f.stepStaged).toHaveBeenCalledExactlyOnceWith(25, 17, 0, undefined, expect.any(AbortSignal), undefined);
    expect(f.stepCompact).toHaveBeenCalledOnce();
    f.finish(1); await full; await releasePaint(f, 1);
    expect(f.flights.map(value => value.kind)).toEqual(['compact', 'full', 'compact']);
    f.finish(2); await later;
    expect(f.messages('ack').slice(-3).map(value => value.tick)).toEqual([24, 25, 26]);
    expect(f.step).toHaveBeenCalledTimes(23);
  });

  it('keeps a legacy ordinary step synchronous when only full staging is available', async () => {
    const f = fixture({ compact: false }); await ready(f); await f.receive(frame(1));
    expect(f.step).toHaveBeenCalledExactlyOnceWith(1, 17, 0);
    expect(f.stepCompact).not.toHaveBeenCalled(); expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: digest(1) }]);
  });

  it('uses synchronous full25 when full capability is absent without routing it through FrameBegin', async () => {
    const f = fixture({ full: false }); await ready(f); await warmSync(f, 24);
    await f.receive(frame(25));
    expect(f.step).toHaveBeenLastCalledWith(25, 17, 0);
    expect(f.stepCompact).not.toHaveBeenCalled(); expect(f.stepStaged).not.toHaveBeenCalled();
    const later = f.receive(frame(26));
    expect(f.stepCompact).toHaveBeenCalledExactlyOnceWith(26, 17, 0, undefined, expect.any(AbortSignal), undefined);
    f.finish(); await later;
    expect(f.messages('ack').at(-1)?.tick).toBe(26);
  });

  it('fails a declared compact capability without its callback before any native entry', async () => {
    const f = fixture(); await ready(f); delete f.bridge.stepCompact;
    await f.receive(frame(1));
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
    expect(f.step).not.toHaveBeenCalled(); expect(f.stepStaged).not.toHaveBeenCalled();
  });

  it('keeps replay ordinary and full ticks synchronous with the existing two-frame task budget', async () => {
    const f = fixture({ slot: 2 }); await ready(f, { replayBatchMax: 8, replayBatchExtendedMax: 32 });
    const pending = f.receive({ type: 'replay_frames', frames: Array.from({ length: 26 }, (_, index) => frame(index + 1)) });
    expect(f.step).toHaveBeenCalledTimes(2); expect(f.messages('ack')).toHaveLength(2);
    await vi.runAllTimersAsync(); await pending;
    expect(f.step).toHaveBeenCalledTimes(26); expect(f.stepCompact).not.toHaveBeenCalled();
    expect(f.stepStaged).not.toHaveBeenCalled(); expect(f.paints.yieldPaint).not.toHaveBeenCalled();
    expect(f.session.phase).toBe('replaying');
  });

  it('learns compact capability only after the guest real spawn and keeps its next command ordered', async () => {
    const f = fixture({ slot: 2, full: false, compact: false, enableAfterJoin: true });
    await ready(f); await warmSync(f, 1); await f.receive({ type: 'caught_up', tick: 1 });
    await f.receive(frame(2, { join: { slot: 2, character: 3 }, p2: 17 }));
    expect(f.stepCompact).not.toHaveBeenCalled();
    const pending = f.receive(frame(3, { p2: 65 }));
    expect(f.stepCompact).toHaveBeenCalledExactlyOnceWith(3, 17, 65, undefined, expect.any(AbortSignal), undefined);
    f.finish(); await pending;
    expect(f.events.running).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.messages('ack').at(-1)?.tick).toBe(3);
  });

  it('forwards an exact compact spawn command and does not publish membership before completion', async () => {
    const f = fixture(); await ready(f);
    const join = { slot: 2 as const, character: 3 };
    const current = f.receive(frame(1, { join, p1: 65, p2: 17 }));
    expect(f.stepCompact).toHaveBeenCalledExactlyOnceWith(1, 65, 17, join, expect.any(AbortSignal), undefined);
    const later = f.receive(frame(2, { p2: 33 }));
    expect(f.messages('ack')).toEqual([]);
    f.finish(); await current; await releasePaint(f, 0);
    f.finish(1); await later;
    expect(f.messages('ack').map(value => value.tick)).toEqual([1, 2]);
    expect(f.session.phase).toBe('running');
  });

  it.each([24, 25])('executes a leave on tick %i synchronously before either native fence opens', async tick => {
    const f = fixture();
    await ready(f, { membershipVersion: 1 });
    f.setCapabilities(false, false);
    await f.receive(frame(1, { join: { slot: 2, character: 1 } }));
    for (let index = 2; index < tick; index++) await f.receive(frame(index));
    f.setCapabilities(true, true);
    f.step.mockClear();
    await f.receive(frame(tick, { leave: { slot: 2 } }));
    expect(f.session.phase).toBe('running');
    expect(f.step).toHaveBeenCalledExactlyOnceWith(tick, 17, 0, undefined, { slot: 2 });
    expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.stepCompact).not.toHaveBeenCalled();
    expect(f.messages('ack').at(-1)).toEqual({ type: 'ack', tick, digest: digest(tick) });
  });

  it('counts the active compact frame in the exact 32-frame live bound', async () => {
    const f = fixture(); await ready(f);
    const waits = [f.receive(frame(1))];
    for (let tick = 2; tick <= 32; tick++) waits.push(f.receive(frame(tick)));
    expect(f.session.phase).toBe('running'); expect(f.stepCompact).toHaveBeenCalledOnce();
    waits.push(f.receive(frame(33))); await Promise.all(waits);
    expect(f.session.phase).toBe('failed'); expect(f.flights[0].signal?.aborted).toBe(true);
    f.finish(); await Promise.resolve(); await Promise.resolve();
    expect(f.messages('ack')).toEqual([]); expect(f.step).not.toHaveBeenCalled();
  });

  it('counts the active compact frame in the 256-message bound without dispatching queued controls', async () => {
    const f = fixture(); await ready(f);
    const waits = [f.receive(frame(1))];
    for (let index = 0; index < 255; index++) waits.push(f.receive(peer));
    expect(f.session.phase).toBe('running'); expect(f.events.peer).not.toHaveBeenCalled();
    waits.push(f.receive(peer)); await Promise.all(waits);
    expect(f.session.phase).toBe('failed'); expect(f.events.peer).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([]);
  });

  it.each(['close', 'disconnect', 'reject', 'error', 'paused', 'malformed'] as const)(
    'cancels compact %s immediately and rejects any stale completion without a retry', async kind => {
      const f = fixture(); await ready(f);
      const current = f.receive(frame(1)), later = f.receive(frame(2)), control = f.receive(peer);
      if (kind === 'close') f.session.close();
      else if (kind === 'disconnect') f.session.disconnected();
      else if (kind === 'reject') f.session.reject('fixture rejection');
      else if (kind === 'malformed') await f.receive('{');
      else await f.receive({ type: kind });
      await Promise.all([current, later, control]);
      expect(f.session.phase).toBe(kind === 'close' ? 'closed' : 'failed');
      expect(f.flights[0].signal?.aborted).toBe(true);
      f.finish(); await Promise.resolve(); await Promise.resolve();
      expect(f.messages('ack')).toEqual([]); expect(f.step).not.toHaveBeenCalled();
      expect(f.stepCompact).toHaveBeenCalledOnce(); expect(f.events.peer).not.toHaveBeenCalled();
    });

  it('never reruns gameplay synchronously after FrameCommit or its readback rejects', async () => {
    const f = fixture(); await ready(f);
    const current = f.receive(frame(1)), later = f.receive(frame(2));
    f.flights[0].reject(new Error('fixture FrameCommit receipt failure'));
    await Promise.all([current, later]);
    expect(f.session.phase).toBe('failed'); expect(f.step).not.toHaveBeenCalled();
    expect(f.stepCompact).toHaveBeenCalledOnce(); expect(f.messages('ack')).toEqual([]);
  });

  it.each(['tick', 'digest', 'players'] as const)('rejects malformed compact final %s before ACK', async field => {
    const f = fixture(); await ready(f); const pending = f.receive(frame(1));
    const invalid = { ...f.result(1), [field]: field === 'tick' ? 2 : field === 'digest' ? '' : null } as unknown as StepResult;
    f.finish(0, invalid); await pending;
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
    expect(f.step).not.toHaveBeenCalled();
  });

  it.each([1, 3])('rejects queued compact duplicate/skipped tick %s before its Begin', async tick => {
    const f = fixture(); await ready(f);
    const current = f.receive(frame(1)), later = f.receive(frame(tick));
    f.finish(); await current; await releasePaint(f, 0); await later;
    expect(f.session.phase).toBe('failed'); expect(f.stepCompact).toHaveBeenCalledOnce();
    expect(f.messages('ack').map(value => value.tick)).toEqual([1]);
  });

  it('keeps the original progress deadline across compact stages without a watchdog callback', async () => {
    const f = fixture(); await ready(f); const pending = f.receive(frame(1));
    f.clock.wall = 10_001; f.finish(); await pending;
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
  });

  it('applies a queued pause original receive deadline to the active compact step', async () => {
    const f = fixture(); await ready(f); const current = f.receive(frame(1));
    f.clock.wall = 100; const control = f.receive(pause(1, 1000));
    f.clock.wall = 1101; f.finish(); await Promise.all([current, control]);
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
    expect(f.events.joinSync).not.toHaveBeenCalled();
  });

  it('does not extend a queued pause deadline when the compact receipt finally releases controls', async () => {
    const f = fixture(); await ready(f); const current = f.receive(frame(1));
    f.clock.wall = 100; const control = f.receive(pause(1, 1000));
    f.clock.wall = 1000; f.finish(); await Promise.all([current, control]);
    expect(f.events.joinSync).toHaveBeenCalledOnce();
    f.clock.wall = 6101;
    await f.receive({ type: 'join_sync', state: 'resumed', tick: 1, joined: false });
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack').map(value => value.tick)).toEqual([1]);
  });

  it('retains a post-compact paint boundary even when the FIFO drained before the next frame arrived', async () => {
    const f = fixture(); await ready(f); const first = f.receive(frame(1));
    f.finish(); await first;
    const next = f.receive(frame(2)); await f.paints.requested(1);
    expect(f.stepCompact).toHaveBeenCalledOnce();
    f.clock.wall = 10_001; await releasePaint(f, 0); await next;
    expect(f.session.phase).toBe('failed'); expect(f.stepCompact).toHaveBeenCalledOnce();
    expect(f.messages('ack').map(value => value.tick)).toEqual([1]);
  });

  it('keeps held-key transmission independent and rechecks a renewal callback before ACK', async () => {
    const f = fixture(); await ready(f); const current = f.receive(frame(1));
    f.session.input(17); f.clock.wall = 200; f.session.checkTimeout();
    expect(f.messages('input').map(value => value.mask)).toEqual([17, 17]);
    expect(f.messages('ack')).toEqual([]);
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(message => { send(message); if (message.type === 'input') f.clock.wall = 10_001; });
    f.clock.wall = 9999; f.finish(); await current;
    expect(f.session.phase).toBe('failed'); expect(f.messages('ack')).toEqual([]);
  });

  it('holds a checkpoint request through compact completion and captures only the next real full25 receipt', async () => {
    const f = fixture({ checkpoint: true }); await ready(f); await warmSync(f);
    const current = f.receive(frame(24));
    const checkpoint = f.receive({ type: 'checkpoint_request', id: 'compactcheckpt01', minimumTick: 24 });
    const full = f.receive(frame(25)), next = f.receive(frame(26));
    expect(f.session.phase).toBe('running');
    expect(f.exportCheckpoint).not.toHaveBeenCalled();
    f.finish(); await Promise.all([current, checkpoint]); await f.paints.requested(1);
    expect(f.exportCheckpoint).not.toHaveBeenCalled();
    await releasePaint(f, 0); expect(f.stepStaged).toHaveBeenCalledOnce();
    expect(f.exportCheckpoint).not.toHaveBeenCalled();
    f.finish(1); await full; await f.paints.requested(2);
    expect(f.exportCheckpoint).toHaveBeenCalledOnce();
    expect(f.trace.indexOf('receipt:25')).toBeLessThan(f.trace.indexOf('send:ack:25'));
    expect(f.trace.indexOf('send:ack:25')).toBeLessThan(f.trace.indexOf('export:25'));
    expect(f.stepCompact).toHaveBeenCalledOnce();
    await releasePaint(f, 1); f.finish(2); await next;
    expect(f.trace.indexOf('export:25')).toBeLessThan(f.trace.indexOf('begin:compact:26'));
  });

  it('keeps terminal compact ACK/completed order while skipping already queued later gameplay', async () => {
    const f = fixture(); await ready(f);
    const current = f.receive(frame(1)), later = f.receive(frame(2));
    const completed = f.receive({ type: 'completed', tick: 1, complete: 'player dead' });
    f.finish(0, { ...f.result(1), complete: 'player dead' });
    await Promise.all([current, later, completed]);
    expect(f.session.phase).toBe('completed'); expect(f.stepCompact).toHaveBeenCalledOnce();
    expect(f.step).not.toHaveBeenCalled(); expect(f.stepStaged).not.toHaveBeenCalled();
    expect(f.messages('ack')).toEqual([{ type: 'ack', tick: 1, digest: digest(1), complete: 'player dead' }]);
    expect(f.trace.indexOf('send:ack:1')).toBeLessThan(f.trace.indexOf('finishing'));
    expect(f.trace.indexOf('finishing')).toBeLessThan(f.trace.indexOf('completed'));
  });

  it('keeps a reentrant frame received during ACK in the existing compact owner', async () => {
    const f = fixture(); await ready(f); let next: Promise<void> | undefined;
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(message => { send(message); if (message.type === 'ack' && message.tick === 1) next = f.receive(frame(2)); });
    const current = f.receive(frame(1)); f.finish(); await current;
    await f.paints.requested(1); expect(next).toBeDefined(); expect(f.stepCompact).toHaveBeenCalledOnce();
    await releasePaint(f, 0); f.finish(1); await next;
    expect(f.messages('ack').map(value => value.tick)).toEqual([1, 2]);
  });

  it.each(['reject', 'cancel'] as const)('does not enter another compact after post-commit paint %s', async kind => {
    const f = fixture(); await ready(f); const current = f.receive(frame(1)), next = f.receive(frame(2));
    f.finish(); await current; await f.paints.requested(1);
    if (kind === 'reject') f.paints.requests[0].reject(new Error('fixture renderer stalled'));
    else f.session.close();
    await next; f.paints.requests[0].resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.stepCompact).toHaveBeenCalledOnce(); expect(f.messages('ack').map(value => value.tick)).toEqual([1]);
    expect(f.session.phase).toBe(kind === 'cancel' ? 'closed' : 'failed');
  });

  it('aligns compact Begin before execution while retaining the original ready allowance', async () => {
    const f = fixture({ align: true }); await ready(f); f.clock.wall = 100_000;
    const pending = f.receive(frame(1));
    expect(f.stepCompact).not.toHaveBeenCalled(); expect(f.messages('ack')).toEqual([]);
    await releasePaint(f, 0); expect(f.stepCompact).toHaveBeenCalledOnce();
    f.finish(); await pending;
    expect(f.session.phase).toBe('running'); expect(f.messages('ack').at(-1)?.tick).toBe(1);
  });
});
