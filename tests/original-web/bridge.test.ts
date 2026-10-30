import { describe, expect, it, vi } from 'vitest';
import { OriginalBridge, readInfo, readState, readStep, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { DEFAULT_SETTINGS, type PrepareMessage } from '../../apps/original-web/src/protocol';

const setup: PrepareMessage = { type: 'prepare', seed: 7, mode: 'Coop', map: 'rooms', characters: [0, 1], swfHash: 'a'.repeat(64) };
const nativePlayers = () => [1, 2].map((slot) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200, flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 }));

function nativeFixture(options: { wrongTick?: boolean; wrongDigest?: boolean; malformedState?: boolean } = {}) {
  let tick = 0;
  let state = 'menu';
  const invoke = vi.fn<NativeInvoke>((name, ...args) => {
    if (name === 'bhInfo') return { version: 1, engine: 'original-swf', state, tick, canPrepare: state === 'menu' };
    if (name === 'bhPrepare') { state = 'ready'; tick = 0; return { state: 'ready', tick: 0 }; }
    if (name === 'bhStep') {
      tick = args[0] as number;
      state = 'playing';
      return { tick: options.wrongTick ? tick + 1 : tick, digest: `native-${tick}`, players: nativePlayers() };
    }
    if (name === 'bhState') {
      if (options.malformedState) return { tick, players: nativePlayers() };
      return { tick, digest: options.wrongDigest && tick > 0 ? 'different' : `native-${tick}`, rng: 7, players: nativePlayers(), entities: [] };
    }
    return undefined;
  });
  return { bridge: new OriginalBridge(invoke), invoke };
}

describe('native bridge guards (mock callbacks, not engine proof)', () => {
  it('passes historical presentation only for the replaying slot-two solo-room guest', async () => {
    const f = nativeFixture();
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => name === 'bhState'
      ? { tick: 0, digest: 'native-0', rng: 7, entities: [], players: nativePlayers().slice(0, 1) }
      : delegate(name, ...args));
    await f.bridge.prepare({ ...setup, initialPlayers: 1, personalProgression: true, replay: true }, undefined, 2);
    expect(f.invoke).toHaveBeenCalledWith('bhPrepare', 7, 'Coop', 'rooms', 0, 1, DEFAULT_SETTINGS,
      { initialPlayers: 1, personalProgression: true, localSlot: 2, replay: true });
  });
  it.each([
    { slot: 1 as const, initialPlayers: 1 as const, personalProgression: true },
    { slot: 2 as const, initialPlayers: 2 as const, personalProgression: true },
    { slot: 2 as const, initialPlayers: 1 as const, personalProgression: false },
  ])('rejects invalid replay presentation membership before any native preparation: %j', async ({ slot, initialPlayers, personalProgression }) => {
    const f = nativeFixture();
    await expect(f.bridge.prepare({ ...setup, initialPlayers, personalProgression, replay: true }, undefined, slot))
      .rejects.toThrow(/a guest joining/);
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('passes original prepare arguments and calls one native step', async () => {
    const { bridge, invoke } = nativeFixture();
    await bridge.waitUntilAvailable();
    await bridge.prepare(setup);
    expect(invoke).toHaveBeenCalledWith('bhPrepare', 7, 'Coop', 'rooms', 0, 1, DEFAULT_SETTINGS);
    expect(bridge.step(1, 17, 8)).toMatchObject({ tick: 1, digest: 'native-1' });
    expect(invoke.mock.calls.filter(([name]) => name === 'bhStep')).toEqual([['bhStep', 1, 17, 8]]);
    expect(() => bridge.step(1, 17, 8)).toThrow();
    expect(invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(1);
  });
  it('does not acknowledge a mismatched native tick or retry it', async () => {
    const { bridge, invoke } = nativeFixture({ wrongTick: true });
    await bridge.prepare(setup);
    expect(() => bridge.step(1, 0, 0)).toThrow(/bhStep tick/);
    expect(invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(1);
  });
  it('rejects mismatching native snapshot digest', async () => {
    const { bridge } = nativeFixture({ wrongDigest: true });
    await bridge.prepare(setup);
    expect(() => bridge.step(1, 0, 0)).toThrow(/digest/);
  });
  it('requires native world fields before ready', async () => {
    const { bridge } = nativeFixture({ malformedState: true });
    await expect(bridge.prepare(setup)).rejects.toThrow(/RNG/);
  });
  it('fails explicitly for an absent bridge', async () => {
    const bridge = new OriginalBridge(() => undefined);
    await expect(bridge.waitUntilAvailable(undefined, 0)).rejects.toThrow(/menu/);
  });
  it('rejects malformed available bridge metadata immediately', async () => {
    const bridge = new OriginalBridge(() => ({ version: 1, engine: 'clone', state: 'ready', tick: 0 }));
    await expect(bridge.waitUntilAvailable()).rejects.toThrow(/bhInfo/);
  });
  it('does not prepare an already cancelled session', async () => {
    const { bridge, invoke } = nativeFixture();
    const abort = new AbortController();
    abort.abort();
    await expect(bridge.prepare(setup, abort.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects malformed values instead of treating input logs as native state', () => {
    expect(() => readInfo({ version: 1, engine: 'original-swf', state: 'ready', tick: -1 })).toThrow();
    expect(() => readStep({ tick: 1, digest: '', players: nativePlayers() })).toThrow();
    expect(() => readStep({ tick: 1, digest: 'hash', players: [{ ...nativePlayers()[0], x: NaN }, nativePlayers()[1]] })).toThrow();
    expect(() => readState({ tick: 1, inputs: [0, 0], digest: 'input-log-only' })).toThrow();
    expect(() => readState({ rng: 1, players: nativePlayers(), entities: [], tick: Infinity })).toThrow();
  });
  it('accepts bounded JSON-encoded callback results', () => {
    expect(readStep(JSON.stringify({ tick: 1, digest: 'abc123', players: nativePlayers() })).digest).toBe('abc123');
  });
  it('waits for the original menu resources before invoking prepare', async () => {
    vi.useFakeTimers();
    try {
      const f = nativeFixture();
      const delegate = f.invoke.getMockImplementation()!;
      let ready = false;
      f.invoke.mockImplementation((name, ...args) => name === 'bhInfo' && !ready
        ? { version: 1, engine: 'original-swf', state: 'menu', tick: 0, canPrepare: false }
        : delegate(name, ...args));
      const pending = f.bridge.prepare(setup);
      await vi.advanceTimersByTimeAsync(100);
      expect(f.invoke.mock.calls.some(([name]) => name === 'bhPrepare')).toBe(false);
      ready = true;
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPrepare')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('accepts absent optional completion and native undefined/non-finite sentinels', () => {
    expect(readStep({ tick: 1, digest: 'native', players: nativePlayers(), complete: undefined }).tick).toBe(1);
    expect(readState({ tick: 1, rng: 7, players: nativePlayers(), entities: [], native: { absent: { $undefined: 1 }, average: { $number: 'NaN' } } }).tick).toBe(1);
  });
  it('accepts the original full map grid string and bounds cumulative string data', () => {
    const state = { tick: 0, rng: 7, players: nativePlayers(), entities: [], native: { grid: 'cell:'.repeat(2000) } };
    expect(readState(state).tick).toBe(0);
    expect(() => readState({ ...state, native: { grid: 'x'.repeat(4_500_000), other: 'y'.repeat(4_500_000) } })).toThrow(/total size limit/);
  });
  it('allows native player removal on death, its respawn, and an empty terminal world', async () => {
    const f = nativeFixture();
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const result = delegate(name, ...args);
      if ((name === 'bhStep' || name === 'bhState') && result && typeof result === 'object' && 'players' in result && 'tick' in result) {
        const count = result.tick === 1 ? 1 : result.tick === 3 ? 0 : 2;
        return { ...result, players: nativePlayers().slice(0, count), ...(result.tick === 3 ? { complete: 'player dead' } : {}) };
      }
      return result;
    });
    await f.bridge.prepare(setup);
    expect(f.bridge.step(1, 0, 0).players).toHaveLength(1);
    expect(f.bridge.step(2, 0, 0).players).toHaveLength(2);
    expect(f.bridge.step(3, 0, 0)).toMatchObject({ players: [], complete: 'player dead' });
  });
  it('requires two initial slots and rejects duplicate or malformed remaining players', async () => {
    const f = nativeFixture();
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => name === 'bhState'
      ? { tick: 0, rng: 7, players: nativePlayers().slice(0, 1), entities: [] }
      : delegate(name, ...args));
    await expect(f.bridge.prepare(setup)).rejects.toThrow(/both initial/);
    expect(() => readStep({ tick: 1, digest: 'native', players: [nativePlayers()[0], nativePlayers()[0]] })).toThrow();
    expect(() => readStep({ tick: 1, digest: 'native', players: [{ ...nativePlayers()[0], slot: 3 }] })).toThrow();
    expect(() => readStep({ tick: 1, digest: 'native', players: [{ ...nativePlayers()[0], x: undefined }] })).toThrow();
  });
  it('accepts the observed pre-Process_Init tick-zero players without inventing gameplay fields', async () => {
    const initialPlayers = [
      { angle: 2.842170943040401e-14, flags: 1, id: 15, slot: 1, x: 8.5, y: 8.5, z: 0 },
      { angle: 3.141592653589811, flags: 1, id: 16, slot: 2, x: 13.5, y: 8.5, z: 0 },
    ];
    const f = nativeFixture();
    const delegate = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, ...args) => {
      const value = delegate(name, ...args);
      return name === 'bhState' && value && typeof value === 'object' && 'tick' in value && value.tick === 0
        ? { ...value, players: initialPlayers } : value;
    });
    await f.bridge.prepare(setup);
    expect(f.bridge.step(1, 0, 0).players).toHaveLength(2);
    const state = readState({ tick: 0, rng: 7, entities: {}, players: initialPlayers });
    expect(state.players).toEqual(initialPlayers);
    expect((state.players as Record<string, unknown>[])[0]).not.toHaveProperty('life');
    expect(() => readStep({ tick: 1, digest: 'native', players: initialPlayers })).toThrow();
    expect(() => readState({ tick: 0, rng: 7, entities: {}, players: [{ ...initialPlayers[0], life: NaN }, initialPlayers[1]] })).toThrow();
  });
  it('allows a cold native cache preparation through the 180-second native loading budget', async () => {
    vi.useFakeTimers();
    try {
      const f = nativeFixture();
      const delegate = f.invoke.getMockImplementation()!;
      let preparingAt: number | undefined;
      f.invoke.mockImplementation((name, ...args) => {
        if (name === 'bhPrepare') {
          preparingAt = Date.now(); delegate(name, ...args);
          return { state: 'loading', tick: 0 };
        }
        if (name === 'bhInfo' && preparingAt !== undefined && Date.now() - preparingAt < 180_000) {
          return { version: 1, engine: 'original-swf', state: 'loading', tick: 0, canPrepare: false };
        }
        return delegate(name, ...args);
      });
      const pending = f.bridge.prepare(setup);
      await vi.advanceTimersByTimeAsync(180_040);
      await pending;
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPrepare')).toHaveLength(1);
      expect(f.bridge.step(1, 0, 0).tick).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});
