import { describe, expect, it } from 'vitest';
import { digestOriginalState, encodeOriginalState, hashOriginalState, MAX_NATIVE_ENCODING_LENGTH } from '../../apps/original-web/src/native-digest';

describe('original VM checksum accelerator', () => {
  it('matches FNV-1a reference vectors in both UTF-16 directions', () => {
    expect(hashOriginalState('')).toBe('native-v2-811c9dc5811c9dc5');
    expect(hashOriginalState('a')).toBe('native-v2-e40c292ce40c292c');
    expect(hashOriginalState('hello')).toBe('native-v2-4f9f2cab871304bb');
  });

  it('uses the native encoder tags and lexical keys, including explicit undefined/NaN sentinels', () => {
    const state = { z: null, a: [3, false], missing: { $undefined: 1 }, nan: { $number: 'NaN' } };
    expect(encodeOriginalState(state)).toBe('o4:s1:ao2:s1:0n3;s1:1fs7:missingo1:s10:$undefinedn1;s3:nano1:s7:$numbers3:NaNs1:zz');
    expect(encodeOriginalState(undefined)).toBe('u');
    expect(encodeOriginalState('😀')).toBe('s2:😀');
  });

  it('hashes actual state values, independent of property insertion order', () => {
    const first = { tick: 7, player: { x: 4, health: 100 } };
    const reordered = { player: { health: 100, x: 4 }, tick: 7 };
    expect(digestOriginalState(first)).toEqual(digestOriginalState(reordered));
    expect(digestOriginalState({ ...first, player: { x: 5, health: 100 } }).digest).not.toBe(digestOriginalState(first).digest);
    expect(digestOriginalState({ ...first, player: { x: 4, health: 99 } }).digest).not.toBe(digestOriginalState(first).digest);
  });

  it('rejects overlong, cyclic and unnormalised non-finite projections', () => {
    expect(() => hashOriginalState('x'.repeat(MAX_NATIVE_ENCODING_LENGTH + 1))).toThrow('8 MiB');
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => encodeOriginalState(cycle)).toThrow('explicit graph references');
    expect(() => encodeOriginalState({ value: NaN })).toThrow('non-finite');
  });
});
