import { describe, expect, it } from 'vitest';
import { parseServerMessage, readRoomName } from '../../apps/original-web/src/protocol';

const room = { room: 'a'.repeat(12), name: 'Комната друзей', mode: 'Coop', map: 'ROOM_Single_0001', players: 1, capacity: 2 };
const parse = (value: unknown) => parseServerMessage(JSON.stringify(value));

describe('public room directory contract', () => {
  it('accepts empty and bounded public room snapshots', () => {
    expect(parse({ type: 'rooms', rooms: [] })).toEqual({ type: 'rooms', rooms: [] });
    expect(parse({ type: 'rooms', rooms: [room] })).toEqual({ type: 'rooms', rooms: [room] });
    expect(readRoomName('x'.repeat(48))).toHaveLength(48);
  });

  it.each([
    { type: 'rooms', rooms: null },
    { type: 'rooms', rooms: Array(129).fill(room) },
    { type: 'rooms', rooms: [room, room] },
    { type: 'rooms', rooms: [null] },
    { type: 'rooms', rooms: [{ ...room, token: 'never-in-a-directory' }] },
    { type: 'rooms', rooms: [room], token: 'never-in-a-directory' },
    { type: 'rooms', rooms: [{ ...room, name: '' }] },
    { type: 'rooms', rooms: [{ ...room, name: 'x'.repeat(49) }] },
    { type: 'rooms', rooms: [{ ...room, name: ' padded ' }] },
    { type: 'rooms', rooms: [{ ...room, name: 'line\nbreak' }] },
    { type: 'rooms', rooms: [{ ...room, room: 'short' }] },
    { type: 'rooms', rooms: [{ ...room, players: 2 }] },
    { type: 'rooms', rooms: [{ ...room, capacity: 3 }] },
    { type: 'rooms', rooms: [{ ...room, mode: 'Single' }] },
    { type: 'rooms', rooms: [{ ...room, map: '../map' }] },
  ])('rejects malformed or secret-bearing directory data %#', (message) => {
    expect(() => parse(message)).toThrow();
  });

  it.each(['unavailable', 'swf_mismatch'])('keeps %s as a recoverable join result', (code) => {
    expect(parse({ type: 'join_failed', room: room.room, code }))
      .toEqual({ type: 'join_failed', room: room.room, code });
  });

  it.each([
    { type: 'join_failed', room: room.room, code: 'arbitrary-server-text' },
    { type: 'join_failed', room: room.room, code: 'unavailable', token: 'never-in-a-decline' },
    { type: 'join_failed', room: '', code: 'unavailable' },
  ])('rejects malformed join declines %#', (message) => {
    expect(() => parse(message)).toThrow();
  });
});
