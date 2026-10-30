import { describe, expect, it, vi } from 'vitest';
import { OriginalSession } from '../../apps/original-web/src/session';

async function fixture() {
  let now = 0;
  let stepDurationMs = 0;
  let rejectedInputSequence: number | undefined;
  const sent: Record<string, unknown>[] = [];
  const wire: { at: number; message: Record<string, unknown> }[] = [];
  const failed = vi.fn();
  const step = vi.fn((tick: number) => {
    now += stepDurationMs;
    return { tick, digest: 'mock-heartbeat-native-state', players: [1, 2].map((slot) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200, flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 })) };
  });
  const session = new OriginalSession(
    { type: 'create', setup: { mode: 'Coop', map: 'ROOM_Single_0001', characters: [0, 1] } },
    'a'.repeat(64),
    { prepare: async () => undefined, step },
    { send: (message) => {
      if (message.type === 'input' && message.seq === rejectedInputSequence) throw new Error('Renewal transport failure');
      sent.push(message); wire.push({ at: now, message });
    }, close: vi.fn() },
    { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), stepped: vi.fn(), failed },
    () => now,
  );
  session.opened();
  await session.receive(JSON.stringify({ type: 'joined', slot: 1, room: 'test-room', token: 'test-token' }));
  await session.receive(JSON.stringify({ type: 'prepare', seed: 7, mode: 'Coop', map: 'ROOM_Single_0001', characters: [0, 1], swfHash: 'a'.repeat(64) }));
  await session.receive(JSON.stringify({ type: 'frame', tick: 1, p1: 0, p2: 0 }));
  return {
    session, sent, wire, failed, step,
    time: (value: number) => { now = value; },
    stepDuration: (value: number) => { stepDurationMs = value; },
    rejectInput: (seq: number) => { rejectedInputSequence = seq; },
    inputs: () => sent.filter((message) => message.type === 'input'),
  };
}

describe('held original input heartbeat', () => {
  it('refreshes the same held mask with increasing sequence every 200 ms', async () => {
    const f = await fixture();
    f.session.input(8);
    f.time(199); f.session.checkTimeout();
    expect(f.inputs()).toEqual([{ type: 'input', seq: 1, mask: 8 }]);
    f.time(200); f.session.checkTimeout();
    f.time(400); f.session.checkTimeout();
    expect(f.inputs()).toEqual([
      { type: 'input', seq: 1, mask: 8 }, { type: 'input', seq: 2, mask: 8 }, { type: 'input', seq: 3, mask: 8 },
    ]);
    f.session.input(0, true);
    f.time(800); f.session.checkTimeout();
    expect(f.inputs().at(-1)).toEqual({ type: 'input', seq: 4, mask: 0, clear: true });
    expect(f.inputs()).toHaveLength(4);
  });
  it('does not let successful heartbeats hide a frozen native/server frame stream', async () => {
    const f = await fixture();
    f.session.input(16);
    for (let now = 200; now <= 45_000; now += 200) { f.time(now); f.session.checkTimeout(); }
    expect(f.session.phase).toBe('running');
    f.time(45_001); f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.inputs().at(-1)).toMatchObject({ mask: 0, clear: true });
  });
  it('keeps a held selector renewed while frame callbacks run but the watchdog timer is delayed', async () => {
    const f = await fixture();
    f.session.input(32);
    // No checkTimeout calls for 1600 ms: more than two server input leases.
    // Real frame callbacks still complete while a timer task is waiting.
    for (let tick = 2; tick <= 17; tick++) {
      f.time((tick - 1) * 100);
      await f.session.receive(JSON.stringify({ type: 'frame', tick, p1: 32, p2: 0 }));
    }
    const held = f.wire.filter(({ message }) => message.type === 'input');
    expect(held.map(({ at }) => at)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600]);
    expect(held.map(({ message }) => message)).toEqual(held.map((_, index) => ({ type: 'input', seq: index + 1, mask: 32 })));
    expect(f.failed).not.toHaveBeenCalled();
    // The delayed timer must not duplicate a renewal sent by a frame callback.
    f.session.checkTimeout();
    expect(f.inputs()).toHaveLength(9);
    // Only the actual local release sends zero, and neutral input is not renewed.
    f.time(1650); f.session.input(0);
    f.time(1700);
    await f.session.receive(JSON.stringify({ type: 'frame', tick: 18, p1: 0, p2: 0 }));
    f.time(2400); f.session.checkTimeout();
    expect(f.inputs()).toHaveLength(10);
    expect(f.inputs().at(-1)).toEqual({ type: 'input', seq: 10, mask: 0 });
  });
  it('renews before entering a synchronous native step when the lease renewal is already due', async () => {
    const f = await fixture();
    f.session.input(32);
    f.time(250); f.stepDuration(100);
    await f.session.receive(JSON.stringify({ type: 'frame', tick: 2, p1: 32, p2: 0 }));
    expect(f.wire.slice(-2)).toEqual([
      { at: 250, message: { type: 'input', seq: 2, mask: 32 } },
      { at: 350, message: { type: 'ack', tick: 2, digest: 'mock-heartbeat-native-state' } },
    ]);
  });
  it('renews after a slow valid native step before the ACK can open the next server frame', async () => {
    const f = await fixture();
    f.session.input(32);
    f.time(150); f.stepDuration(100);
    await f.session.receive(JSON.stringify({ type: 'frame', tick: 2, p1: 32, p2: 0 }));
    expect(f.wire.slice(-2)).toEqual([
      { at: 250, message: { type: 'input', seq: 2, mask: 32 } },
      { at: 250, message: { type: 'ack', tick: 2, digest: 'mock-heartbeat-native-state' } },
    ]);
  });
  it.each([
    { position: 'before native step', at: 200, duration: 0, expectedSteps: 0 },
    { position: 'after native step', at: 100, duration: 150, expectedSteps: 1 },
  ])('does not ACK a frame if renewal fails $position', async ({ at, duration, expectedSteps }) => {
    const f = await fixture();
    f.step.mockClear();
    f.session.input(32);
    f.rejectInput(2); f.time(at); f.stepDuration(duration);
    await f.session.receive(JSON.stringify({ type: 'frame', tick: 2, p1: 32, p2: 0 }));
    expect(f.session.phase).toBe('failed');
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.step).toHaveBeenCalledTimes(expectedSteps);
    expect(f.sent.some((message) => message.type === 'ack' && message.tick === 2)).toBe(false);
    expect(f.inputs().at(-1)).toEqual({ type: 'input', seq: 3, mask: 0, clear: true });
  });
});
