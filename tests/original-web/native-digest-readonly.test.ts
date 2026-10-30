import { describe, expect, it } from 'vitest';
import { digestOriginalState, digestOriginalStateReadonly, encodeOriginalState } from '../../apps/original-web/src/native-digest';
import { digestOriginalState as baselineDigest, encodeOriginalState as baselineEncode } from './fixtures/native-digest-before-receipt';

describe('read-only canonical native export', () => {
  it.each([
    null, undefined, false, true, 0, -0, 1e-7, -1e21, 'a\u0000Ж😀',
    { z: undefined, a: null, n: -0, huge: 1e21, tiny: -1e-7 },
    { '\ud800': 'high', '\udc00': 'low', '😀': 'pair', a: [undefined, null, -0, { '$ref': 1 }] },
    { entities: { '$id': 0, '$array': [{ '$ref': 2 }, { '$id': 2, '$type': 'CThing', life: 200 }] }, tick: 25, scope: 'full' },
  ])('preserves pinned baseline tags, ordering, numbers and UTF-16 lengths for %j', original => {
    const value = structuredClone(original);
    const expected = baselineDigest(value);
    expect(encodeOriginalState(value)).toBe(baselineEncode(value));
    expect(digestOriginalState(value)).toEqual(expected);
    expect(digestOriginalStateReadonly(value)).toEqual(expected);
    expect(digestOriginalStateReadonly(value)).toEqual(expected);
  });

  it('freezes nested arrays and objects while preserving shared references and negative zero', () => {
    const shared = { angle: -0, life: 200 };
    const value = { first: shared, second: shared, sparse: Object.assign(new Array(4), { 2: shared }) };
    const expected = baselineDigest(value);
    expect(digestOriginalStateReadonly(value)).toEqual(expected);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.sparse)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(value.first).toBe(value.second);
    expect(Object.is(value.first.angle, -0)).toBe(true);
    expect(() => { value.first.life = 1; }).toThrow();
  });

  it('leaves the legacy API mutable', () => {
    const value = { nested: { life: 200 } };
    digestOriginalState(value);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(value.nested)).toBe(false);
    value.nested.life = 199;
    expect(digestOriginalState(value)).toEqual(baselineDigest(value));
  });

  it('rejects accessors without invoking them', () => {
    let calls = 0;
    const value = { get life() { calls++; return 200; } };
    expect(() => digestOriginalStateReadonly(value)).toThrow('data properties');
    expect(calls).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity, () => 1, Symbol('x')])('retains rejection of unsupported native values: %s', value => {
    expect(() => baselineDigest({ value })).toThrow();
    expect(() => digestOriginalStateReadonly({ value })).toThrow();
  });

  it('retains cycle and depth limits', () => {
    const cyclic: { next?: unknown } = {}; cyclic.next = cyclic;
    expect(() => baselineDigest(cyclic)).toThrow();
    expect(() => digestOriginalStateReadonly(cyclic)).toThrow();
    let deep: unknown = 0;
    for (let i = 0; i < 258; i++) deep = { child: deep };
    expect(() => baselineDigest(deep)).toThrow();
    expect(() => digestOriginalStateReadonly(deep)).toThrow();
  });
});
