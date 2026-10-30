import { describe, expect, it, vi } from 'vitest';
import { OriginalSession } from '../../apps/original-web/src/session';
import type { LockstepBridge, StepResult } from '../../apps/original-web/src/bridge';
import type { ConnectionIntent } from '../../apps/original-web/src/protocol';

const hash = 'a'.repeat(64);
const prepare = { type: 'prepare', seed: 7, mode: 'Coop', map: 'rooms', characters: [0, 1], swfHash: hash };
const frame = (tick: number) => JSON.stringify({ type: 'frame', tick, p1: 17, p2: 8 });
const nativePlayers = () => [1, 2].map((slot) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200, flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 }));

function fixture(intent: ConnectionIntent = { type: 'create', setup: { mode: 'Coop', map: 'rooms', characters: [0, 1] } }) {
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn();
  const events = { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), running: vi.fn(), stepped: vi.fn(), finishing: vi.fn(), completed: vi.fn(), failed: vi.fn() };
  const bridge: LockstepBridge = {
    prepare: vi.fn(async () => undefined),
    step: vi.fn((tick: number): StepResult => ({ tick, digest: `native-world-${tick}`, players: nativePlayers() })),
  };
  let now = 0;
  const session = new OriginalSession(intent, hash, bridge, { send: (message) => { sent.push(message); }, close }, events, () => now);
  return { session, sent, close, events, bridge, setTime: (value: number) => { now = value; } };
}

async function ready(f: ReturnType<typeof fixture>, slot: 1 | 2 = 1) {
  f.session.opened();
  await f.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot, token: 'secret-token' }));
  await f.session.receive(JSON.stringify(prepare));
}

describe('lockstep transport (mock bridge, not two-browser proof)', () => {
  it('sends ACK only after native step returns its actual matching tick and digest', async () => {
    const f = fixture();
    await ready(f);
    expect(f.sent.filter((message) => message.type === 'ack')).toEqual([]);
    await f.session.receive(frame(1));
    expect(f.bridge.step).toHaveBeenCalledWith(1, 17, 8);
    expect(f.sent.filter((message) => message.type === 'ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-world-1' }]);
  });
  it('never ACKs a failed native step', async () => {
    const f = fixture();
    await ready(f);
    vi.mocked(f.bridge.step).mockImplementation(() => { throw new Error('native failure'); });
    await f.session.receive(frame(1));
    expect(f.sent.some((message) => message.type === 'ack')).toBe(false);
    expect(f.session.phase).toBe('failed');
    expect(f.close).toHaveBeenCalled();
  });
  it('never ACKs a returned tick mismatch or malformed digest', async () => {
    for (const result of [
      { tick: 2, digest: 'native', players: nativePlayers() },
      { tick: 1, digest: '', players: nativePlayers() },
    ]) {
      const f = fixture();
      await ready(f);
      vi.mocked(f.bridge.step).mockReturnValue(result);
      await f.session.receive(frame(1));
      expect(f.sent.some((message) => message.type === 'ack')).toBe(false);
      expect(f.session.phase).toBe('failed');
    }
  });
  it('rejects duplicate frames without a second native step', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    await f.session.receive(frame(1));
    expect(f.bridge.step).toHaveBeenCalledTimes(1);
    expect(f.sent.filter((message) => message.type === 'ack')).toHaveLength(1);
    expect(f.session.phase).toBe('failed');
  });
  it('rejects a frame before native preparation', async () => {
    const f = fixture();
    await f.session.receive(frame(1));
    expect(f.bridge.step).not.toHaveBeenCalled();
    expect(f.sent.some((message) => message.type === 'ack')).toBe(false);
  });
  it('requires the exact assigned slot', async () => {
    const f = fixture({ type: 'join', invitation: { room: 'room1', token: 'secret-token' } });
    await f.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 1, token: 'secret-token' }));
    expect(f.session.phase).toBe('failed');
    expect(f.events.joined).not.toHaveBeenCalled();
  });
  it('checks SWF identity before native preparation', async () => {
    const f = fixture();
    await f.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 1, token: 'secret-token' }));
    await f.session.receive(JSON.stringify({ ...prepare, swfHash: 'b'.repeat(64) }));
    expect(f.bridge.prepare).not.toHaveBeenCalled();
    expect(f.sent.some((message) => message.type === 'ready')).toBe(false);
  });
  it('cannot send ready after disconnect during asynchronous preparation', async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.bridge.prepare).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await f.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 1, token: 'secret-token' }));
    const pending = f.session.receive(JSON.stringify(prepare));
    f.session.disconnected();
    finish();
    await pending;
    expect(f.sent.some((message) => message.type === 'ready')).toBe(false);
    expect(f.session.phase).toBe('failed');
  });
  it('handles a server pause immediately while preparation is pending', async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.bridge.prepare).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await f.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 1, token: 'secret-token' }));
    const pending = f.session.receive(JSON.stringify(prepare));
    await f.session.receive('{"type":"paused","reason":"divergence"}');
    finish();
    await pending;
    expect(f.sent.some((message) => message.type === 'ready')).toBe(false);
    expect(f.session.phase).toBe('failed');
  });
  it('sends increasing input sequences and releases keys on close', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    f.session.input(17);
    f.session.input(17);
    f.session.input(0);
    f.session.input(8);
    f.session.close();
    expect(f.sent.filter((message) => message.type === 'input')).toEqual([
      { type: 'input', seq: 1, mask: 17 },
      { type: 'input', seq: 2, mask: 0 },
      { type: 'input', seq: 3, mask: 8 },
      { type: 'input', seq: 4, mask: 0, clear: true },
    ]);
    await f.session.receive(frame(1));
    expect(f.bridge.step).toHaveBeenCalledTimes(1);
  });
  it('stops after the bounded network idle grace', async () => {
    const f = fixture();
    await ready(f);
    await f.session.receive(frame(1));
    f.setTime(45_001);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.close).toHaveBeenCalled();
  });
  it('does not time out an idle waiting room', async () => {
    const f = fixture();
    await f.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 1, token: 'secret-token' }));
    f.setTime(60_000);
    f.session.checkTimeout();
    expect(f.session.phase).toBe('waiting');
  });
  it('lets only the host issue one start request', async () => {
    const host = fixture();
    await host.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 1, token: 'secret-token' }));
    host.session.start(); host.session.start();
    expect(host.sent.filter((message) => message.type === 'start')).toHaveLength(1);
    const guest = fixture({ type: 'join', invitation: { room: 'room1', token: 'secret-token' } });
    await guest.session.receive(JSON.stringify({ type: 'joined', room: 'room1', slot: 2, token: 'secret-token' }));
    guest.session.start();
    expect(guest.sent.some((message) => message.type === 'start')).toBe(false);
  });
  it('stops at the actual native terminal tick and discards already pipelined frames', async () => {
    const f = fixture(); await ready(f);
    vi.mocked(f.bridge.step).mockImplementation((tick) => ({ tick, digest: 'native-terminal', players: [], complete: 'player dead' }));
    await f.session.receive(frame(1));
    await f.session.receive(frame(2));
    expect(f.session.phase).toBe('completing');
    expect(f.bridge.step).toHaveBeenCalledTimes(1);
    expect(f.sent.filter((message) => message.type === 'ack')).toEqual([{ type: 'ack', tick: 1, digest: 'native-terminal', complete: 'player dead' }]);
    await f.session.receive(JSON.stringify({ type: 'completed', tick: 1, complete: 'player dead' }));
    expect(f.session.phase).toBe('completed');
    expect(f.events.completed).toHaveBeenCalledWith(1, 'player dead');
    f.session.disconnected();
    expect(f.events.failed).not.toHaveBeenCalled();
  });
  it('rejects a server completion without the matching native result', async () => {
    const f = fixture(); await ready(f);
    await f.session.receive(JSON.stringify({ type: 'completed', tick: 1, complete: 'player1 wins' }));
    expect(f.session.phase).toBe('failed');
    expect(f.events.completed).not.toHaveBeenCalled();
  });
  it('sends hard clear even after keyup already sent a zero mask', async () => {
    const f = fixture(); await ready(f);
    await f.session.receive(frame(1));
    f.session.input(16); f.session.input(0); f.session.input(0, true);
    expect(f.sent.filter((message) => message.type === 'input')).toEqual([
      { type: 'input', seq: 1, mask: 16 }, { type: 'input', seq: 2, mask: 0 },
      { type: 'input', seq: 3, mask: 0, clear: true },
    ]);
  });
  it('waits for a slow peer after local readiness without sending input or using the gameplay watchdog', async () => {
    const f = fixture(); await ready(f);
    expect(f.session.phase).toBe('ready');
    f.session.input(8);
    f.session.input(0, true);
    f.setTime(180_000); f.session.checkTimeout();
    expect(f.session.phase).toBe('ready');
    expect(f.sent.some((message) => message.type === 'input')).toBe(false);
    expect(f.events.running).not.toHaveBeenCalled();
    await f.session.receive(frame(1));
    expect(f.session.phase).toBe('running');
    expect(f.events.running).toHaveBeenCalledWith(1);
    f.session.input(8);
    expect(f.sent.at(-1)).toEqual({ type: 'input', seq: 1, mask: 8 });
  });
  it('keeps the peer readiness wait bounded to 190 seconds', async () => {
    const f = fixture(); await ready(f);
    f.setTime(190_000); f.session.checkTimeout();
    expect(f.session.phase).toBe('ready');
    f.setTime(190_001); f.session.checkTimeout();
    expect(f.session.phase).toBe('failed');
    expect(f.sent.some((message) => message.type === 'input')).toBe(false);
  });
});
