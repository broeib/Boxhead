import { describe, expect, it, vi } from 'vitest';
import { OriginalSession } from '../../apps/original-web/src/session';
import type { LockstepBridge } from '../../apps/original-web/src/bridge';
import type { ConnectionIntent } from '../../apps/original-web/src/protocol';

const hash = 'a'.repeat(64);
const room = 'Room_1234567';
function fixture(intent: ConnectionIntent = { type: 'join_open', room }) {
  const send = vi.fn();
  const close = vi.fn();
  const events = { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), stepped: vi.fn(), failed: vi.fn(), joinFailed: vi.fn() };
  const bridge: LockstepBridge = { prepare: vi.fn(async () => undefined), step: vi.fn() };
  return { send, close, events, bridge, session: new OriginalSession(intent, hash, bridge, { send, close }, events) };
}

describe('native room-list handoff', () => {
  it('claims the selected public room using the existing discovery transport', () => {
    const f = fixture(); f.session.opened();
    expect(f.send).toHaveBeenCalledWith({ type: 'join_open', swfHash: hash, room });
  });
  it('does not close a subscribed socket on the normal room-claim race', async () => {
    const f = fixture(); f.session.opened();
    await f.session.receive(JSON.stringify({ type: 'rooms', rooms: [] }));
    expect(f.session.phase).toBe('joining');
    const message = { type: 'join_failed', room, code: 'unavailable' };
    await f.session.receive(JSON.stringify(message));
    expect(f.session.phase).toBe('closed');
    expect(f.close).not.toHaveBeenCalled();
    expect(f.events.joinFailed).toHaveBeenCalledWith(message);
    expect(f.events.failed).not.toHaveBeenCalled();
    expect(f.bridge.prepare).not.toHaveBeenCalled();
  });
  it('rejects a server that silently joins a different room', async () => {
    const f = fixture(); f.session.opened();
    await f.session.receive(JSON.stringify({ type: 'joined', room: 'Other1234567', token: 'token', slot: 2 }));
    expect(f.session.phase).toBe('failed');
    expect(f.events.joined).not.toHaveBeenCalled();
  });
  it('publishes the native room name and selected setup without dropping listed', () => {
    const setup = { mode: 'Coop' as const, map: 'ROOM_Single_0001', characters: [3, 2] as [number, number] };
    const f = fixture({ type: 'create', setup, name: 'Friends', listed: true });
    f.session.opened();
    expect(f.send).toHaveBeenCalledWith({ type: 'create', swfHash: hash, ...setup, name: 'Friends', listed: true });
  });
});
