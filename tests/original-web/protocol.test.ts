import { describe, expect, it } from 'vitest';
import { maskForCodes } from '../../apps/original-web/src/input';
import { makeInvitation, parseInvitation, parseServerMessage, readSetup } from '../../apps/original-web/src/protocol';

const hash = 'a'.repeat(64);
const base = 'https://example.test/';

describe('original keyboard masks', () => {
  it('uses the same fixed WASD/Space/QE actions for either network slot', () => {
    expect(maskForCodes(1, ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyE', 'KeyQ'])).toBe(127);
    expect(maskForCodes(2, ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyE', 'KeyQ'])).toBe(127);
    expect(maskForCodes(1, ['ArrowUp', 'Slash', 'Comma'])).toBe(0);
    expect(maskForCodes(2, ['ArrowUp', 'Slash', 'Comma'])).toBe(0);
  });
  it('preserves simultaneous movement/fire and next/prev order', () => {
    expect(maskForCodes(1, ['KeyW', 'KeyD', 'Space'])).toBe(25);
    expect(maskForCodes(2, ['KeyS', 'KeyA', 'Space'])).toBe(22);
    expect(maskForCodes(1, ['KeyE'])).toBe(32);
    expect(maskForCodes(2, ['KeyQ'])).toBe(64);
  });
});

describe('original-ws guards', () => {
  it('accepts documented prepare and frames', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'prepare', seed: 0xffffffff, mode: 'Coop', map: 'rooms', characters: [0, 3], swfHash: hash }))).toMatchObject({ type: 'prepare', seed: 0xffffffff });
    expect(parseServerMessage('{"type":"frame","tick":1,"p1":127,"p2":0}')).toEqual({ type: 'frame', tick: 1, p1: 127, p2: 0 });
  });
  it.each([
    '{', 'null', '[]', '{"type":"unexpected"}',
    '{"type":"frame","tick":0,"p1":0,"p2":0}',
    '{"type":"frame","tick":1,"p1":131072,"p2":0}',
    '{"type":"frame","tick":1,"p1":1.5,"p2":0}',
    '{"type":"joined","room":"ok","slot":0,"token":"secret"}',
    '{"type":"joined","room":"ok","slot":2}',
  ])('rejects malformed socket data: %s', (raw) => {
    expect(() => parseServerMessage(raw)).toThrow();
  });
  it('rejects binary and oversized socket messages', () => {
    expect(() => parseServerMessage(new Uint8Array([1]))).toThrow();
    expect(() => parseServerMessage(' '.repeat(65_537))).toThrow();
  });
  it('requires explicit map and original character range', () => {
    expect(() => readSetup({ mode: 'Coop', map: '', characters: [0, 1] })).toThrow();
    expect(() => readSetup({ mode: 'Coop', map: 'rooms', characters: [0, 4] })).toThrow();
  });
});

describe('fragment invitations', () => {
  it('keeps authentication out of the request URL', () => {
    const link = makeInvitation(base, { room: 'room_1', token: 'private-token' });
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/');
    expect(url.hash).toContain('token=private-token');
    expect(parseInvitation(link, base)).toEqual({ room: 'room_1', token: 'private-token' });
  });
  it.each([
    'https://other.test/#room=r&token=t',
    'https://example.test/?room=r&token=t',
    'https://example.test/#room=r&token=t&token=duplicate',
    'https://example.test/#room=r&token=t&extra=x',
    'https://example.test/#room=r',
    'https://example.test/other#room=r&token=t',
  ])('rejects incompatible invitations: %s', (link) => {
    expect(() => parseInvitation(link, base)).toThrow();
  });
});
