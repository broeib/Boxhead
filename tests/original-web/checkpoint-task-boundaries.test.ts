import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OriginalBridge, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { CheckpointReceiver } from '../../apps/original-web/src/checkpoint';
import { OriginalSession } from '../../apps/original-web/src/session';
import { type PrepareMessage, type Slot } from '../../apps/original-web/src/protocol';

const hash = 'a'.repeat(64);
const room = 'DropInRoom01';
const id = 'CheckpointCase01';
const header = { type: 'checkpoint_begin', id, version: 1, tick: 250, digest: 'native-250',
  encoding: 'plain', bytes: 2, uncompressedBytes: 2, sha256: 'b'.repeat(64), chunks: 1 };
const prepare: PrepareMessage = { type: 'prepare', seed: 7, mode: 'Coop', map: 'ROOM_Single_0001',
  characters: [0, 1], swfHash: hash, initialPlayers: 1, personalProgression: true,
  replay: true, checkpointVersion: 1 };
const player = (slot: Slot) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0,
  life: 200, flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 });
const frame = (tick: number, extra: Record<string, unknown> = {}) => ({ type: 'frame', tick, p1: 0, p2: 0, ...extra });

function controlledScheduler() {
  const requests: { resolve(): void; reject(error: unknown): void }[] = [];
  const waiting: { count: number; resolve(): void }[] = [];
  const api = { yield: vi.fn(() => new Promise<void>((resolve, reject) => {
    requests.push({ resolve, reject });
    for (const waiter of waiting) if (requests.length >= waiter.count) waiter.resolve();
  })) };
  vi.stubGlobal('scheduler', api);
  return { api, requests, scheduled: (count: number) => new Promise<void>(resolve => {
    if (requests.length >= count) resolve();
    else waiting.push({ count, resolve });
  }) };
}

/** Real client guards with stub native callbacks; these are scheduling tests. */
function fixture() {
  let now = 0;
  let work = 0;
  let tick = 0;
  let state = 'menu';
  let roster: Slot[] = [1];
  const trace: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const invoke = vi.fn<NativeInvoke>((name, ...args) => {
    if (name === 'bhInfo') {
      trace.push(`info:${tick}`);
      return { version: 1, engine: 'original-swf', state, tick, canPrepare: state === 'menu', checkpointVersion: 1 };
    }
    if (name === 'bhPrepare') { state = 'ready'; return { state, tick }; }
    if (name === 'bhCheckpointImport') {
      tick = args[1] as number;
      state = 'playing';
      work += 70;
      trace.push(`import:${tick}`);
    }
    if (name === 'bhStep') {
      tick = args[0] as number;
      state = 'playing';
      if (args[3]) roster = [1, 2];
      trace.push(`step:${tick}`);
    }
    if (name === 'bhState') trace.push(`state:${tick}`);
    return { tick, digest: `native-${tick}`, players: roster.map(player), entities: [], rng: 7 };
  });
  const bridge = new OriginalBridge(invoke);
  const close = vi.fn();
  const send = vi.fn((message: Record<string, unknown>) => {
    sent.push(message);
    trace.push(`send:${message.type}:${message.tick ?? ''}`);
  });
  const events = { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), stepped: vi.fn(), failed: vi.fn(),
    running: vi.fn(() => { trace.push('running'); }), replaying: vi.fn(),
    joinSync: vi.fn((message: { state: string }) => { trace.push(`control:${message.state}`); }) };
  const session = new OriginalSession({ type: 'join_open', room }, hash, bridge, { send, close }, events,
    () => now, () => work);
  const receive = (message: unknown) => session.receive(JSON.stringify(message));
  return { session, receive, bridge, invoke, send, close, events, trace,
    setTime: (value: number) => { now = value; },
    setWorkTime: (value: number) => { work = value; },
    messages: (type: string) => sent.filter(message => message.type === type),
    nativeCalls: (name: string) => invoke.mock.calls.filter(call => call[0] === name) };
}

async function transferReady(f: ReturnType<typeof fixture>, waitAt = 0) {
  f.session.opened();
  await f.receive({ type: 'joined', room, slot: 2, token: 'test-only-token' });
  await f.receive(prepare);
  f.setTime(waitAt);
  await f.receive({ type: 'checkpoint_wait', id, timeoutMs: 30000 });
  await f.receive(header);
  await f.receive({ type: 'checkpoint_chunk', id, index: 0, data: 'e30=' });
  f.trace.length = 0;
}

describe('checkpoint task boundaries retain one verified import and ordered replay owner', () => {
  beforeEach(() => {
    // Real transfer/hash/Unicode checks live in checkpoint-transfer.test.ts.
    // Resolve unpack in a microtask to exercise the missing task boundary.
    vi.spyOn(CheckpointReceiver.prototype, 'unpack').mockResolvedValue('{}');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('separates unpack, indivisible import/readback/attestation, and queued tail/control/spawn work', async () => {
    const scheduler = controlledScheduler();
    const f = fixture();
    await transferReady(f);
    const end = f.receive({ type: 'checkpoint_end', id });
    await scheduler.scheduled(1);
    expect(f.nativeCalls('bhCheckpointImport')).toHaveLength(0);
    expect(f.messages('checkpoint_applied')).toEqual([]);
    expect(f.messages('ack')).toEqual([]);
    const pending = [end, f.receive(frame(251)),
      f.receive({ type: 'join_sync', state: 'paused', tick: 252, verified: 250, timeoutMs: 1500 }),
      f.receive(frame(252)), f.receive({ type: 'join_sync', state: 'progress', tick: 252, verified: 252 }),
      f.receive({ type: 'caught_up', tick: 252 }), f.receive(frame(253, { join: { slot: 2, character: 1 } }))];
    await Promise.resolve();
    expect(f.trace).toEqual([]);
    scheduler.requests[0].resolve();
    await scheduler.scheduled(2);
    expect(f.trace).toEqual(['import:250', 'info:250', 'state:250', 'send:checkpoint_applied:250']);
    expect(f.messages('checkpoint_applied')).toEqual([
      { type: 'checkpoint_applied', id, tick: 250, digest: 'native-250', sha256: header.sha256 },
    ]);
    expect(f.nativeCalls('bhStep')).toHaveLength(0);
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(f.events.running).not.toHaveBeenCalled();
    scheduler.requests[1].resolve();
    await Promise.all(pending);
    // Import's 70ms work is not charged to the fresh replay slice. Both
    // subsequent native frames retain readback before their own ACK.
    expect(scheduler.api.yield).toHaveBeenCalledTimes(2);
    expect(f.messages('ack').map(message => message.tick)).toEqual([251, 252, 253]);
    expect(f.nativeCalls('bhStep').map(call => call[1])).toEqual([251, 252, 253]);
    for (const tick of [251, 252, 253]) {
      expect(f.trace.indexOf(`step:${tick}`)).toBeLessThan(f.trace.indexOf(`info:${tick}`));
      expect(f.trace.indexOf(`info:${tick}`)).toBeLessThan(f.trace.indexOf(`state:${tick}`));
      expect(f.trace.indexOf(`state:${tick}`)).toBeLessThan(f.trace.indexOf(`send:ack:${tick}`));
    }
    expect(f.trace.indexOf('control:paused')).toBeGreaterThan(f.trace.indexOf('send:ack:251'));
    expect(f.trace.indexOf('control:progress')).toBeGreaterThan(f.trace.indexOf('send:ack:252'));
    expect(f.trace.indexOf('running')).toBeGreaterThan(f.trace.indexOf('send:ack:253'));
    expect(f.events.failed).not.toHaveBeenCalled();
    expect(f.session.phase).toBe('running');
  });

  it.each(['transfer', 'absolute', 'queued-barrier'] as const)(
    'rechecks the fixed %s deadline after the pre-import task without a watchdog callback', async (deadline) => {
    const scheduler = controlledScheduler();
    const f = fixture();
    // A delayed wait must not renew the original ready-time absolute budget,
    // even when its own transfer window would still have time remaining.
    await transferReady(f, deadline === 'absolute' ? 179000 : 0);
    const end = f.receive({ type: 'checkpoint_end', id });
    await scheduler.scheduled(1);
    const pending = [end];
    if (deadline === 'queued-barrier') pending.push(f.receive({
      type: 'join_sync', state: 'paused', tick: 250, verified: 0, timeoutMs: 1500,
    }));
    pending.push(f.receive(frame(251)));
    f.setTime(deadline === 'transfer' ? 30001 : deadline === 'absolute' ? 180001 : 1501);
    scheduler.requests[0].resolve();
    await Promise.all(pending);
    expect(f.session.phase).toBe('failed');
    expect(f.nativeCalls('bhCheckpointImport')).toHaveLength(0);
    expect(f.nativeCalls('bhStep')).toHaveLength(0);
    expect(f.messages('checkpoint_applied')).toEqual([]);
    expect(f.messages('ack')).toEqual([]);
    expect(f.events.joinSync).not.toHaveBeenCalled();
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
  });

  it.each(['readback', 'deadline', 'absolute'] as const)('never attests or starts a post-import task on native %s failure', async (failure) => {
    const scheduler = controlledScheduler();
    const f = fixture();
    await transferReady(f, failure === 'absolute' ? 179000 : 0);
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const value = delegate(name, ...args) as Record<string, unknown>;
      if (name === 'bhState' && value.tick === 250) {
        if (failure === 'readback') return { ...value, digest: 'wrong' };
        f.setTime(failure === 'absolute' ? 180001 : 30001);
      }
      return value;
    });
    const end = f.receive({ type: 'checkpoint_end', id });
    await scheduler.scheduled(1);
    const tail = f.receive(frame(251));
    scheduler.requests[0].resolve();
    await Promise.all([end, tail]);
    expect(f.session.phase).toBe('failed');
    expect(f.nativeCalls('bhCheckpointImport')).toHaveLength(1);
    expect(f.nativeCalls('bhState')).toContainEqual(['bhState', false, false, true]);
    expect(f.nativeCalls('bhStep')).toHaveLength(0);
    expect(f.messages('checkpoint_applied')).toEqual([]);
    expect(f.messages('ack')).toEqual([]);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
  });

  it('retains the checkpoint transfer allowance beyond the shorter native-frame progress watchdog', async () => {
    const scheduler = controlledScheduler();
    const f = fixture();
    await transferReady(f);
    f.setTime(11000);
    const end = f.receive({ type: 'checkpoint_end', id });
    await scheduler.scheduled(1);
    scheduler.requests[0].resolve();
    await scheduler.scheduled(2);
    expect(f.messages('checkpoint_applied')).toHaveLength(1);
    scheduler.requests[1].resolve();
    await end;
    await f.receive(frame(251));
    expect(f.session.phase).toBe('replaying');
    expect(f.events.failed).not.toHaveBeenCalled();
    expect(f.messages('ack').map(message => message.tick)).toEqual([251]);
  });

  it.each([0, 1])('propagates scheduler rejection at checkpoint boundary %s without replay or extra attestation', async (boundary) => {
    const scheduler = controlledScheduler();
    const f = fixture();
    await transferReady(f);
    const end = f.receive({ type: 'checkpoint_end', id });
    await scheduler.scheduled(1);
    const tail = f.receive(frame(251));
    if (boundary === 1) {
      scheduler.requests[0].resolve();
      await scheduler.scheduled(2);
    }
    scheduler.requests[boundary].reject(new Error('checkpoint scheduler rejected'));
    await Promise.all([end, tail]);
    expect(f.session.phase).toBe('failed');
    expect(f.nativeCalls('bhCheckpointImport')).toHaveLength(boundary);
    expect(f.messages('checkpoint_applied')).toHaveLength(boundary);
    expect(f.nativeCalls('bhStep')).toHaveLength(0);
    expect(f.messages('ack')).toEqual([]);
    expect(f.events.failed).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([[0, 'close'], [1, 'close'], [0, 'disconnect'], [1, 'disconnect'], [0, 'fatal'], [1, 'fatal']] as const)(
    'cancels boundary %s immediately on %s and ignores its late continuation', async (boundary, cancel) => {
      const scheduler = controlledScheduler();
      const f = fixture();
      await transferReady(f);
      const end = f.receive({ type: 'checkpoint_end', id });
      await scheduler.scheduled(1);
      const tail = f.receive(frame(251));
      if (boundary === 1) {
        scheduler.requests[0].resolve();
        await scheduler.scheduled(2);
      }
      if (cancel === 'close') f.session.close();
      else if (cancel === 'disconnect') f.session.disconnected();
      else await f.receive({ type: 'paused' });
      await Promise.all([end, tail]);
      expect(f.session.phase).toBe(cancel === 'close' ? 'closed' : 'failed');
      scheduler.requests[boundary].resolve();
      await Promise.resolve();
      await f.receive(frame(251));
      expect(f.nativeCalls('bhCheckpointImport')).toHaveLength(boundary);
      expect(f.messages('checkpoint_applied')).toHaveLength(boundary);
      expect(f.nativeCalls('bhStep')).toHaveLength(0);
      expect(f.messages('ack')).toEqual([]);
      expect(f.close).toHaveBeenCalledOnce();
      expect(scheduler.api.yield).toHaveBeenCalledTimes(boundary + 1);
    },
  );

  it.each(['close', 'send-error', 'event-reject'] as const)(
    'does not create a new task after an attestation callback %s', async (failure) => {
    const scheduler = controlledScheduler();
    const f = fixture();
    await transferReady(f);
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(message => {
      if (message.type === 'checkpoint_applied' && failure === 'send-error') throw new Error('attestation send failed');
      send(message);
      if (message.type === 'checkpoint_applied' && failure === 'close') f.session.close();
    });
    if (failure === 'event-reject') f.events.replaying.mockImplementation(() => f.session.reject('attestation event rejected'));
    const end = f.receive({ type: 'checkpoint_end', id });
    await scheduler.scheduled(1);
    scheduler.requests[0].resolve();
    await end;
    expect(f.session.phase).toBe(failure === 'close' ? 'closed' : 'failed');
    expect(f.nativeCalls('bhCheckpointImport')).toHaveLength(1);
    expect(f.messages('checkpoint_applied')).toHaveLength(failure === 'send-error' ? 0 : 1);
    expect(f.nativeCalls('bhStep')).toHaveLength(0);
    expect(f.messages('ack')).toEqual([]);
    expect(scheduler.api.yield).toHaveBeenCalledOnce();
  });

  it('keeps host boundary selection/export/readback synchronous while the captured packet waits and the host advances', async () => {
    const scheduler = controlledScheduler();
    let tick = 0;
    let state = 'menu';
    const trace: string[] = [];
    let deliverHeader!: (value: Record<string, unknown>) => void;
    const headerDelivered = new Promise<Record<string, unknown>>(resolve => { deliverHeader = resolve; });
    const invoke = vi.fn<NativeInvoke>((name, ...args) => {
      if (name === 'bhInfo') {
        trace.push(`info:${tick}`);
        return { version: 1, engine: 'original-swf', state, tick, canPrepare: state === 'menu', checkpointVersion: 1 };
      }
      if (name === 'bhPrepare') { state = 'ready'; return { state, tick }; }
      if (name === 'bhStep') {
        tick = args[0] as number;
        state = 'playing';
        trace.push(`step:${tick}`);
      }
      if (name === 'bhCheckpointExport') {
        trace.push(`export:${tick}`);
        return { version: 1, tick, digest: `native-${tick}`, payload: '{"captured":25}' };
      }
      if (name === 'bhState') trace.push(`state:${tick}`);
      return { tick, digest: `native-${tick}`, players: [player(1)], entities: [], rng: 7 };
    });
    const failed = vi.fn();
    const session = new OriginalSession({ type: 'create', dropIn: true, setup: {
      mode: 'Coop', map: prepare.map, characters: [0, 1],
    } }, hash, new OriginalBridge(invoke), {
      send(message) {
        trace.push(`send:${message.type}:${message.tick ?? ''}`);
        if (message.type === 'checkpoint_begin') deliverHeader(message);
      }, close: vi.fn(),
    }, { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), stepped: vi.fn(), failed }, () => 0, () => 0);
    const receive = (message: unknown) => session.receive(JSON.stringify(message));
    session.opened();
    await receive({ type: 'joined', room, slot: 1, token: 'test-only-token' });
    await receive({ type: 'prepare', seed: 7, mode: 'Coop', map: prepare.map, characters: [0, 1],
      swfHash: hash, initialPlayers: 1, personalProgression: true, replay: false });
    for (let next = 1; next <= 24; next++) await receive(frame(next));
    await receive({ type: 'checkpoint_request', id, minimumTick: 25 });
    trace.length = 0;
    const capturedFrame = receive(frame(25));
    expect(trace).toEqual(['step:25', 'info:25', 'state:25', 'send:ack:25',
      'info:25', 'export:25', 'info:25', 'state:25']);
    const nextFrame = receive(frame(26));
    expect(trace.slice(-4)).toEqual(['step:26', 'info:26', 'state:26', 'send:ack:26']);
    await Promise.all([capturedFrame, nextFrame]);
    const packed = await headerDelivered;
    expect(packed.tick).toBe(25);
    expect(packed.digest).toBe('native-25');
    expect(invoke.mock.calls.filter(call => call[0] === 'bhCheckpointExport')).toEqual([['bhCheckpointExport']]);
    expect(session.phase).toBe('running');
    expect(failed).not.toHaveBeenCalled();
    expect(scheduler.api.yield).not.toHaveBeenCalled();
  });
});
