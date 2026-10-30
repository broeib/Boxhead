import { describe, expect, it, vi } from 'vitest';
import { OriginalBridge, readState, type NativeInvoke } from '../../apps/original-web/src/bridge';
import type { PrepareMessage } from '../../apps/original-web/src/protocol';

const player = { slot: 1, id: 1, x: 1, y: 0, z: 0, angle: 0, life: 200,
  flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 };
const prepare: PrepareMessage = { type: 'prepare', seed: 7, swfHash: 'a'.repeat(64),
  mode: 'Coop', map: 'ROOM_Single_0001', characters: [0, 1],
  initialPlayers: 1, personalProgression: true, replay: true };

function snapshot(tick: number, entities: unknown = [{ id: 1, life: 200 }]) {
  const scope = tick % 25 === 0 ? 'full' : 'frame';
  const rng = { seed: 7, state: 7, calls: tick };
  return { version: 1, engine: 'original-swf', state: tick === 0 ? 'ready' : 'playing',
    tick, digest: 'native-' + tick, digestSchema: 'native-projection-v3', scope,
    players: [{ ...player }], rng, native: { scope, tick, rng, entities },
    snapshotBytes: 321, snapshotObjects: 3, snapshotFields: 8,
    profile: { projectMs: 1, encodeMs: 0, hashMs: 1 } };
}

describe('single-projection native state readback', () => {
  it.each([0, 1, 25])('normalizes only the absent alias and preserves the complete actual envelope at tick%s', (tick) => {
    const raw = snapshot(tick);
    const before = JSON.stringify(raw);
    const state = readState(raw);
    expect(Object.hasOwn(raw, 'entities')).toBe(false);
    expect(JSON.stringify(raw)).toBe(before);
    expect(state).toEqual({ ...raw, entities: raw.native.entities });
    expect(state.native).toBe(raw.native);
    expect(state.entities).toBe(raw.native.entities);
    expect(state.players).toBe(raw.players);
    expect(state.profile).toBe(raw.profile);
  });

  it('accepts a JSON-encoded slim envelope and restores an in-memory alias after validation', () => {
    const state = readState(JSON.stringify(snapshot(25, { entity1: { life: 200 } })));
    expect(state.entities).toBe((state.native as Record<string, unknown>).entities);
    expect(state.scope).toBe('full');
  });

  it('retains the legacy bare state and the legacy duplicate-entities envelope', () => {
    const bare = { players: [{ ...player }], rng: 7, entities: [] };
    expect(readState(bare)).toBe(bare);
    const full = snapshot(25);
    const legacy = { ...full, entities: full.native.entities };
    expect(readState(legacy)).toBe(legacy);
    expect(readState(JSON.stringify(legacy))).toEqual(legacy);
  });

  it.each([undefined, null, false, 0, 'entities'])('rejects an explicitly present invalid top alias %j instead of falling back', (entities) => {
    expect(() => readState({ ...snapshot(1), entities })).toThrow();
  });

  it('does not hide an invalid inherited top alias behind the native entity graph', () => {
    const raw = Object.assign(Object.create({ entities: null }), snapshot(1));
    expect(() => readState(raw)).toThrow();
  });

  it.each([undefined, null, false, 0, 'entities'])('rejects an invalid native entity graph %j', (entities) => {
    const raw = snapshot(1);
    raw.native.entities = entities;
    expect(() => readState(raw)).toThrow();
  });

  it.each(['version', 'engine', 'state', 'tick', 'digest', 'digestSchema', 'scope', 'native'])('requires own current-snapshot header field %s for the slim path', (key) => {
    const raw: Record<string, unknown> = snapshot(1);
    delete raw[key];
    expect(() => readState(raw)).toThrow();
  });

  it.each([
    { version: 2 }, { engine: 'other' }, { state: 'error' }, { state: 'menu' },
    { tick: -1 }, { tick: 1.5 }, { digest: 'bad digest' }, { digest: undefined },
    { digestSchema: 'other' }, { scope: 'other' }, { rng: undefined }, { error: 'native failure' },
  ])('rejects invalid current snapshot metadata %j', (change) => {
    expect(() => readState({ ...snapshot(1), ...change })).toThrow();
  });

  it.each(['tick', 'scope', 'entities'])('requires own native field %s before normalizing the alias', (key) => {
    const raw = snapshot(1);
    const native: Record<string, unknown> = { ...raw.native };
    delete native[key];
    expect(() => readState({ ...raw, native })).toThrow();
    expect(() => readState({ ...raw, native: Object.assign(Object.create({ [key]: raw.native[key as keyof typeof raw.native] }), native) })).toThrow();
  });

  it.each([{ tick: 2 }, { scope: 'full' }])('rejects a native/header mismatch %j', (change) => {
    const raw = snapshot(1);
    expect(() => readState({ ...raw, native: { ...raw.native, ...change } })).toThrow();
  });

  it('validates all native entity descendants and rejects unsafe fields and values', () => {
    for (const entities of [
      [{ life: Number.NaN }], [{ callback: () => {} }],
      JSON.parse('{"entity":{"constructor":{}}}'),
      JSON.parse('{"entity":{"__proto__":{}}}'),
    ]) expect(() => readState(snapshot(1, entities))).toThrow();
  });

  it('charges the existing native node budget once before adding the duplicate compatibility alias', () => {
    const entities = Array.from({ length: 10 }, () => Array.from({ length: 6000 }, () => 0));
    const state = readState(snapshot(25, entities));
    expect(state.entities).toBe(entities);
    expect((state.native as Record<string, unknown>).entities).toBe(entities);
    // The unchanged 100k-node budget would reject two traversals of this graph.
    // It must still reject one graph that exceeds the actual original budget.
    const oversized = Array.from({ length: 10 }, () => Array.from({ length: 10000 }, () => 0));
    expect(() => readState(snapshot(25, oversized))).toThrow();
  });

  it('retains the original per-array and recursion limits for the sole native graph', () => {
    expect(() => readState(snapshot(1, Array.from({ length: 16385 }, () => 0)))).toThrow();
    let deep: unknown = {};
    for (let level = 0; level < 25; level++) deep = { child: deep };
    expect(() => readState(snapshot(1, deep))).toThrow();
  });
});

/** Production bridge guards with stub callbacks; not native/browser evidence. */
function bridgeFixture(legacy = false) {
  let tick = 0;
  let phase = 'menu';
  let alter: ((state: ReturnType<typeof snapshot>) => unknown) | undefined;
  const invoke = vi.fn<NativeInvoke>((name, ...args) => {
    if (name === 'bhInfo') return { version: 1, engine: 'original-swf', state: phase,
      tick, canPrepare: phase === 'menu' };
    if (name === 'bhPrepare') { phase = 'ready'; return { state: phase, tick: 0 }; }
    if (name === 'bhStep') {
      tick = args[0] as number; phase = 'playing';
      return { tick, digest: 'native-' + tick, players: [{ ...player }] };
    }
    if (name === 'bhState') {
      const state = snapshot(tick);
      if (alter && tick > 0) return alter(state);
      // The old callback ignores the optional arguments and returns its old shape.
      return legacy ? { tick, digest: state.digest, players: state.players, rng: 7, entities: [] } : state;
    }
    return undefined;
  });
  return { bridge: new OriginalBridge(invoke), invoke,
    alterReadback: (change: (state: ReturnType<typeof snapshot>) => unknown) => { alter = change; } };
}

describe('bridge requests a slim cached readback without reducing native checks', () => {
  it.each([false, true])('keeps one bhInfo and one bhState after each real step, legacy=%s', async (legacy) => {
    const f = bridgeFixture(legacy);
    await f.bridge.prepare(prepare, undefined, 2);
    expect(f.invoke.mock.calls.filter(call => call[0] === 'bhState')).toEqual([['bhState', false, false, true]]);
    f.invoke.mockClear();
    expect(f.bridge.step(1, 17, 0).tick).toBe(1);
    expect(f.invoke.mock.calls).toEqual([
      ['bhStep', 1, 17, 0], ['bhInfo'], ['bhState', false, false, true],
    ]);
    f.invoke.mockClear();
    expect(f.bridge.step(2, 0, 0).tick).toBe(2);
    expect(f.invoke.mock.calls).toEqual([
      ['bhStep', 2, 0, 0], ['bhInfo'], ['bhState', false, false, true],
    ]);
  });

  it.each(['native-tick', 'native-scope', 'state-tick', 'state-digest', 'present-invalid-alias'])('rejects inconsistent native readback and cannot advance to the next tick: %s', async (kind) => {
    const f = bridgeFixture();
    await f.bridge.prepare(prepare, undefined, 2);
    f.alterReadback(state => {
      if (kind === 'native-tick') return { ...state, native: { ...state.native, tick: 2 } };
      if (kind === 'native-scope') return { ...state, native: { ...state.native, scope: 'full' } };
      if (kind === 'state-tick') return { ...state, tick: 2, native: { ...state.native, tick: 2 } };
      if (kind === 'state-digest') return { ...state, digest: 'wrong-native-1' };
      return { ...state, entities: undefined };
    });
    f.invoke.mockClear();
    expect(() => f.bridge.step(1, 17, 0)).toThrow();
    expect(f.invoke.mock.calls.map(call => call[0])).toEqual(['bhStep', 'bhInfo', 'bhState']);
    const before = f.invoke.mock.calls.length;
    expect(() => f.bridge.step(2, 17, 0)).toThrow();
    expect(f.invoke.mock.calls).toHaveLength(before);
  });
});
