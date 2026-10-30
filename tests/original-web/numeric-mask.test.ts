import { describe, expect, it } from 'vitest';
import { isMask, parseServerMessage } from '../../apps/original-web/src/protocol';
import { maskForCodes, maskForKeyCodes, DEFAULT_CONTROLS, ONLINE_BINDINGS } from '../../apps/original-web/src/input';

describe('17-bit original network action masks', () => {
  it.each([128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536])('accepts a numeric weapon bit %s on both slots', (mask) => {
    expect(parseServerMessage(JSON.stringify({ type: 'frame', tick: 1, p1: mask, p2: mask })))
      .toEqual({ type: 'frame', tick: 1, p1: mask, p2: mask });
  });
  it('accepts the complete action mask and preserves direct selection with fixed online keys', () => {
    const codes = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyE', 'KeyQ',
      'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
    expect(maskForCodes(1, codes)).toBe(131071);
    expect(maskForCodes(2, codes)).toBe(131071);
    expect(isMask(131071)).toBe(true);
    expect(maskForKeyCodes(ONLINE_BINDINGS, new Set([50]))).toBe(256);
    expect(DEFAULT_CONTROLS.p2).toEqual([87, 83, 65, 68, 32, 69, 81]);
  });
  it.each([-1, 0.5, 131072, 2147483647, NaN, Infinity])('rejects invalid or out-of-range action masks %s', (mask) => {
    expect(isMask(mask)).toBe(false);
  });
});
