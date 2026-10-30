import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type PrepareMessage } from '../../apps/original-web/src/protocol';

const setup: PrepareMessage = { type: 'prepare', seed: 7, mode: 'Coop', map: 'ROOM_Single_0001',
  characters: [0, 1], settings: DEFAULT_SETTINGS, swfHash: 'a'.repeat(64) };

type StepFailure = 'throw' | 'native-error' | 'missing' | 'stale' | 'malformed';

async function fixture(query: string, options: { terminal?: boolean; stepMs?: number; failure?: StepFailure;
  ruffleLoop?: boolean; allowPresentation?: boolean; threePose?: boolean; fourPose?: boolean; invalidPoseConfig?: boolean } = {}) {
  vi.resetModules();
  let state = 'menu', tick = 0, playerCount = 2, now = 0, nextFrame = 0;
  const timing = { stepMs: options.stepMs ?? 0, failure: options.failure };
  const loading = { action: async (): Promise<unknown> => undefined, createFailure: false };
  const terminal = options.terminal ?? true;
  const frames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let presented = { tick: 0, alpha: 0 }, playerGeneration = 0;
  const rendered: Array<{ at: number; generation: number; tick: number; alpha: number }> = [];
  const order: string[] = [];
  const players = [1, 2].map(slot => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200,
    flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 }));
  const invoke = vi.fn((name: string, ...args: unknown[]): unknown => {
    if (name === 'bhInfo') return { version: 1, engine: 'original-swf', presentationVersion: 1,
      state, tick, canPrepare: state === 'menu' };
    if (name === 'bhPresentationConfig') return { version: 1, ok: true, enabled: !!args[0] && options.allowPresentation !== false,
      ...(options.fourPose && args[0] ? { mode: 'four-pose-v3', poseVersion: options.invalidPoseConfig ? 2 : 3 }
        : options.threePose && args[0] ? { mode: 'three-pose-v2', poseVersion: options.invalidPoseConfig ? 1 : 2 } : {}) };
    if (name === 'bhPrepare') {
      state = 'ready'; playerCount = (args[6] as { initialPlayers?: number } | undefined)?.initialPlayers ?? 2;
      return { state, tick };
    }
    if (name === 'bhStep') {
      now += timing.stepMs;
      if (timing.failure === 'throw') throw new Error('Native step threw');
      if (timing.failure === 'missing') return undefined;
      if (timing.failure === 'malformed') return { tick: Number(args[0]) };
      if (timing.failure === 'stale') return { tick, digest: 'native-' + tick, players: players.slice(0, playerCount) };
      tick = Number(args[0]);
      if (timing.failure === 'native-error') {
        state = 'error'; return { tick, state, error: 'Native step rejected', digest: 'native-' + tick, players: players.slice(0, playerCount) };
      }
      state = 'playing'; if (args[3] !== undefined) playerCount = 2;
      return { tick, digest: 'native-' + tick, players: players.slice(0, playerCount),
        ...(terminal ? { complete: 'player-dead' } : {}) };
    }
    if (name === 'bhState') return { tick, digest: 'native-' + tick, rng: 7, players: players.slice(0, playerCount), entities: [],
      ...(tick > 0 && terminal ? { complete: 'player-dead' } : {}) };
    if (name === 'bhPresent') {
      presented = { tick, alpha: Number(args[0]) }; order.push('present');
      return { version: 1, enabled: true, rendered: true, tick, alpha: args[0],
        ...(options.fourPose ? { mode: 'four-pose-v3', poseVersion: 3, poseTick: tick - 3 + 3 * Number(args[0]) }
          : options.threePose ? { mode: 'three-pose-v2', poseVersion: 2, poseTick: tick - 2 + 2 * Number(args[0]) } : {}) };
    }
    throw new Error('Unexpected native callback: ' + name);
  });
  const create = vi.fn(() => {
    if (loading.createFailure) throw new Error('Player construction failed');
    state = 'menu'; tick = 0; playerCount = 2; presented = { tick: 0, alpha: 0 };
    const generation = ++playerGeneration;
    let pending: number | null = null;
    const renderer = (at: number): void => {
      pending = request(renderer);
      order.push('render'); rendered.push({ at, generation, ...presented });
    };
    const player = { style: {}, isConnected: true, load: vi.fn(() => loading.action()),
      remove: vi.fn(() => {
        player.isConnected = false;
        if (pending !== null) frames.delete(pending);
      }), ruffle: () => ({ callExternalInterface: invoke }) };
    // Deliberately start as early as construction. The pinned renderer rearms
    // first and renders later; this fixture checks ordering, not engine/FPS.
    if (options.ruffleLoop) pending = request(renderer);
    return player;
  });
  const location = { href: 'http://example.test/' + query };
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', { RufflePlayer: { newest: () => ({ createPlayer: create }) } });
  const { OriginalRuffleHost } = await import('../../apps/original-web/src/ruffle');
  const host = new OriginalRuffleHost({ replaceChildren: vi.fn(), append: vi.fn() } as unknown as HTMLElement);
  const controller = new AbortController();
  await host.load('/Boxhead_2Play.online.swf', controller.signal);
  const bridge = host.bridge();
  return { host, bridge, invoke, location, timing, frames, request, loading, create, controller, rendered, order,
    setTime(at: number) { now = at; },
    frame(at: number) {
      now = at;
      for (const [id, callback] of [...frames]) {
        if (frames.delete(id)) callback(at);
      }
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('presentation host lifecycle (mock callbacks, not engine or FPS evidence)', () => {
  it.each([{ query: '?presentation=off', enabled: false }, { query: '?presentation-clock=three-pose-v2', enabled: true }])(
    'preserves the initial local presentation preference through the invitation rewrite: $query',
    async ({ query, enabled }) => {
      const f = await fixture(query);
      // The real joined handler clears the query before native preparation.
      f.location.href = 'http://example.test/#room=abcdefghijkl';
      await f.bridge.prepare(setup);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
        .toEqual([enabled ? ['bhPresentationConfig', true, 'three-pose-v2'] : ['bhPresentationConfig', false]]);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPrepare'))
        .toEqual([['bhPrepare', 7, 'Coop', 'ROOM_Single_0001', 0, 1, DEFAULT_SETTINGS]]);
      expect(f.frames.size).toBe(enabled ? 1 : 0);
      if (!enabled) expect(f.request).not.toHaveBeenCalled();
      f.host.destroy(); expect(f.frames.size).toBe(0);
    },
  );

  it('selects the buffered clock only after the actual two-field native mode negotiation', async () => {
    const f = await fixture('?presentation-clock=three-pose-v2', { terminal: false, threePose: true });
    await f.bridge.prepare(setup); f.invoke.mockClear(); f.setTime(100);
    f.bridge.step(1, 0, 0); f.frame(133);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', 1]]);
    f.setTime(140); f.bridge.step(2, 0, 0); f.frame(150);
    const calls = f.invoke.mock.calls.filter(([name]) => name === 'bhPresent');
    const secondPose = 2 * Number(calls[1][1]);
    expect(secondPose).toBeGreaterThan(1); expect(secondPose).toBeLessThan(2);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(2);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhState')).toHaveLength(2);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it('restores native drawing when a partially negotiated new presentation contract is returned', async () => {
    const f = await fixture('?presentation-clock=three-pose-v2', { terminal: false, threePose: true, invalidPoseConfig: true });
    await f.bridge.prepare(setup);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig')).toEqual([
      ['bhPresentationConfig', true, 'three-pose-v2'], ['bhPresentationConfig', false],
    ]);
    f.invoke.mockClear(); f.setTime(100); f.bridge.step(1, 0, 0); f.frame(133);
    expect(f.frames.size).toBe(0);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toHaveLength(0);
    f.host.destroy();
  });

  it('rejects legacy pose results after new-mode negotiation without executing another game step', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = await fixture('?presentation-clock=three-pose-v2', { terminal: false, threePose: true });
    await f.bridge.prepare(setup); f.setTime(100); f.bridge.step(1, 0, 0); f.invoke.mockClear();
    f.invoke.mockImplementationOnce(() => ({ version: 1, enabled: true, rendered: true, tick: 1, alpha: 1 }));
    f.frame(133);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhPresent']);
    expect(warning).toHaveBeenCalledOnce(); expect(f.frames.size).toBe(0);
    await Promise.resolve();
    expect(f.invoke.mock.calls.at(-1)).toEqual(['bhPresentationConfig', false]);
    f.host.destroy();
  });

  it('keeps the explicit four-pose selection through invitation rewriting and uses its actual native formula', async () => {
    const f = await fixture('?presentation-clock=four-pose-v3', { terminal: false, fourPose: true });
    f.location.href = 'http://example.test/#room=abcdefghijkl';
    await f.bridge.prepare(setup);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
      .toEqual([['bhPresentationConfig', true, 'four-pose-v3']]);
    f.invoke.mockClear(); f.setTime(100); f.bridge.step(1, 0, 0); f.frame(133);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', 1]]);
    f.setTime(140); f.bridge.step(2, 0, 0); f.frame(150);
    const calls = f.invoke.mock.calls.filter(([name]) => name === 'bhPresent');
    expect(calls).toHaveLength(2);
    const pose = 2 - 3 + 3 * Number(calls[1][1]);
    expect(pose).toBeGreaterThan(1); expect(pose).toBeLessThan(2);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(2);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhState')).toHaveLength(2);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it.each([{ threePose: true }, {}, { fourPose: true, invalidPoseConfig: true }])(
    'does not downgrade an explicit four-pose request to a different native contract: %j', async options => {
      const f = await fixture('?presentation-clock=four-pose-v3', { terminal: false, ...options });
      await f.bridge.prepare(setup);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig')).toEqual([
        ['bhPresentationConfig', true, 'four-pose-v3'], ['bhPresentationConfig', false],
      ]);
      f.invoke.mockClear(); f.setTime(100); f.bridge.step(1, 0, 0); f.frame(133);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toHaveLength(0);
      expect(f.frames.size).toBe(0); f.host.destroy();
    },
  );

  it('rejects a three-pose return after actual four-pose configuration without an extra native tick', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = await fixture('?presentation-clock=four-pose-v3', { terminal: false, fourPose: true });
    await f.bridge.prepare(setup); f.setTime(100); f.bridge.step(1, 0, 0); f.invoke.mockClear();
    f.invoke.mockImplementationOnce(() => ({ version: 1, enabled: true, rendered: true, tick: 1, alpha: 1,
      mode: 'three-pose-v2', poseVersion: 2, poseTick: 1 }));
    f.frame(133);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhPresent']);
    expect(warning).toHaveBeenCalledOnce(); expect(f.frames.size).toBe(0);
    await Promise.resolve();
    expect(f.invoke.mock.calls.at(-1)).toEqual(['bhPresentationConfig', false]);
    f.host.destroy();
  });

  it('explicit legacy selection uses the original one-argument configuration', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false });
    await f.bridge.prepare(setup);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
      .toEqual([['bhPresentationConfig', true]]);
    f.setTime(100); f.bridge.step(1, 0, 0); f.frame(120);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', .5]]);
    f.host.destroy();
  });

  it('the existing off preference remains effective with an explicit four-pose selection', async () => {
    const f = await fixture('?presentation=off&presentation-clock=four-pose-v3', { terminal: false, fourPose: true });
    await f.bridge.prepare(setup);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
      .toEqual([['bhPresentationConfig', false]]);
    expect(f.frames.size).toBe(0); expect(f.request).not.toHaveBeenCalled(); f.host.destroy();
  });

  it.each(['', 'four-pose-v2', 'five-pose-v4'])('rejects an unknown explicit presentation clock: %s', async mode => {
    await expect(fixture('?presentation-clock=' + mode, { terminal: false })).rejects.toThrow('Unknown original game display mode');
  });

  it('defers terminal bitmap disposal until after the complete synchronous native readback', async () => {
    const f = await fixture('?presentation-clock=legacy-v1');
    await f.bridge.prepare(setup);
    f.invoke.mockClear();
    expect(f.bridge.step(1, 0, 0).complete).toBe('player-dead');
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhStep', 'bhInfo', 'bhState']);
    expect(f.frames.size).toBe(0);
    await Promise.resolve();
    expect(f.invoke.mock.calls.at(-1)).toEqual(['bhPresentationConfig', false]);
    f.host.destroy();
  });

  it('passes the actual invocation start after Step returns and waits until the next animation frame to present', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, stepMs: 28 });
    await f.bridge.prepare(setup);
    f.invoke.mockClear(); f.setTime(100);
    expect(f.bridge.step(1, 0, 0).tick).toBe(1);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhStep', 'bhInfo', 'bhState']);
    expect(f.frames.size).toBe(1);
    f.frame(133);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', 0.825]]);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(1);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it.each(['throw', 'native-error', 'missing', 'stale', 'malformed'] as const)('does not start presentation for a %s native step', async failure => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, stepMs: 28, failure });
    await f.bridge.prepare(setup); f.invoke.mockClear(); f.setTime(100);
    expect(() => f.bridge.step(1, 0, 0)).toThrow();
    // Only the early, dormant dispatcher exists; a rejected native step must
    // never activate a presentation callback or execute a second native step.
    expect(f.frames.size).toBe(1); f.frame(133);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([]);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(1);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it('ignores historical replay timing and starts the first live segment at the actual joining invocation', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, stepMs: 70 });
    await f.bridge.prepare({ ...setup, initialPlayers: 1, personalProgression: true, replay: true }, undefined, 2);
    f.invoke.mockClear(); f.setTime(0);
    expect(f.bridge.step(1, 0, 0).tick).toBe(1);
    expect(f.frames.size).toBe(1); f.frame(80);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([]);
    f.timing.stepMs = 20; f.setTime(100);
    expect(f.bridge.step(2, 0, 0, { slot: 2, character: 1 }).tick).toBe(2);
    f.frame(125);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', 0.625]]);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(2);
    f.host.destroy();
  });

  it('does not start live presentation when the native joining step fails', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, stepMs: 10 });
    await f.bridge.prepare({ ...setup, initialPlayers: 1, personalProgression: true, replay: true }, undefined, 2);
    expect(f.bridge.step(1, 0, 0).tick).toBe(1);
    f.timing.failure = 'native-error'; f.setTime(40);
    expect(() => f.bridge.step(2, 0, 0, { slot: 2, character: 1 })).toThrow();
    expect(f.frames.size).toBe(1); f.frame(60);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([]);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it('defers timestamp failure cleanup until after the same synchronous native readback', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // An impossible regressing clock is an explicit fault fixture, not a
    // simulated native timing result or evidence about browser performance.
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, stepMs: -1 });
    await f.bridge.prepare(setup); f.invoke.mockClear(); f.setTime(100);
    expect(f.bridge.step(1, 0, 0).tick).toBe(1);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhStep', 'bhInfo', 'bhState']);
    expect(f.frames.size).toBe(0); expect(warning).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(f.invoke.mock.calls.at(-1)).toEqual(['bhPresentationConfig', false]);
    f.host.destroy();
  });

  it('stays dormant through the menu, then presents before the same opportunity renders the bitmap', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, ruffleLoop: true });
    f.frame(10); f.frame(20);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.order).toEqual(['render', 'render']);
    await f.bridge.prepare(setup);
    f.invoke.mockClear(); f.order.length = 0; f.setTime(40);
    f.bridge.step(1, 0, 0);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhStep', 'bhInfo', 'bhState']);
    f.frame(50); f.frame(67);
    expect(f.order).toEqual(['present', 'render', 'present', 'render']);
    expect(f.rendered.slice(-2)).toEqual([
      { at: 50, generation: 1, tick: 1, alpha: 0.25 },
      { at: 67, generation: 1, tick: 1, alpha: 0.675 },
    ]);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(1);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it('closes the reserved dispatcher when the native configuration declines presentation', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false, allowPresentation: false });
    expect(f.frames.size).toBe(1);
    await f.bridge.prepare(setup);
    expect(f.frames.size).toBe(0);
    f.bridge.step(1, 0, 0); f.frame(20);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([]);
    f.host.destroy();
  });

  it('closes both scheduling layers on presentation fallback and disposes only after the callback returns', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false });
    await f.bridge.prepare(setup); f.bridge.step(1, 0, 0);
    const stale = [...f.frames.values()][0];
    f.invoke.mockClear();
    f.invoke.mockImplementationOnce(() => ({ version: 1, enabled: false, rendered: false, tick: 1 }));
    f.frame(20);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhPresent']);
    expect(f.frames.size).toBe(0);
    stale(40); f.frame(60);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(f.invoke.mock.calls.at(-1)).toEqual(['bhPresentationConfig', false]);
    f.host.destroy();
  });

  it('load cancellation immediately closes dormant or active presentation without waiting for destruction', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false });
    await f.bridge.prepare(setup); f.bridge.step(1, 0, 0);
    const stale = [...f.frames.values()][0];
    f.invoke.mockClear();
    f.controller.abort();
    expect(f.frames.size).toBe(0);
    stale(20); f.frame(40);
    expect(f.invoke).not.toHaveBeenCalled();
    f.host.destroy();
  });

  it('cancellation inside a native presentation cannot rearm its finishing pump', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false });
    await f.bridge.prepare(setup); f.bridge.step(1, 0, 0);
    f.invoke.mockClear();
    f.invoke.mockImplementationOnce(() => {
      f.controller.abort();
      return { version: 1, enabled: true, rendered: true, tick: 1 };
    });
    f.frame(20); f.frame(40);
    expect(f.frames.size).toBe(0);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhPresent']);
    f.host.destroy();
  });

  it.each(['construction', 'load'] as const)('cleans up the early dispatcher on player %s failure', async kind => {
    const f = await fixture('?presentation-clock=legacy-v1');
    if (kind === 'construction') f.loading.createFailure = true;
    else f.loading.action = async () => { throw new Error('Player load failed'); };
    await expect(f.host.load('/Boxhead_2Play.online.swf', new AbortController().signal)).rejects.toThrow('failed');
    expect(f.frames.size).toBe(0);
    f.host.destroy();
  });

  it('aborts a pending load before its promise settles and ignores its stale dispatcher callback', async () => {
    const f = await fixture('?presentation-clock=legacy-v1');
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { finish = resolve; });
    f.loading.action = () => pending;
    const controller = new AbortController();
    const loading = f.host.load('/Boxhead_2Play.online.swf', controller.signal);
    const rejected = expect(loading).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(f.create).toHaveBeenCalledTimes(2);
    const stale = [...f.frames.values()][0];
    controller.abort();
    expect(f.frames.size).toBe(0);
    stale(20); expect(f.frames.size).toBe(0);
    finish(undefined); await rejected;
    expect(f.frames.size).toBe(0);
    f.host.destroy();
  });

  it('a superseded load cannot cancel the replacement dispatcher or restart its own callback', async () => {
    const f = await fixture('?presentation-clock=legacy-v1', { terminal: false });
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { finish = resolve; });
    f.loading.action = () => pending;
    const oldLoad = f.host.load('/Boxhead_2Play.online.swf', new AbortController().signal);
    const rejected = expect(oldLoad).rejects.toThrow('cancelled');
    await Promise.resolve();
    const stale = [...f.frames.values()][0];
    f.loading.action = async () => undefined;
    await f.host.load('/Boxhead_2Play.online.swf', new AbortController().signal);
    const bridge = f.host.bridge();
    await bridge.prepare(setup); bridge.step(1, 0, 0);
    finish(undefined); await rejected;
    expect(f.frames.size).toBe(1);
    stale(10); expect(f.frames.size).toBe(1);
    f.invoke.mockClear(); f.frame(20);
    expect(f.invoke.mock.calls).toEqual([['bhPresent', 0.5]]);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });
});

describe('default four-pose selection (mock native integration, not FPS evidence)', () => {
  it('negotiates four poses from the unparameterized URL and retains the selection after invitation rewriting', async () => {
    const f = await fixture('', { terminal: false, fourPose: true });
    expect(new URL(f.location.href).search).toBe('');
    f.location.href = 'http://example.test/#room=abcdefghijkl';
    await f.bridge.prepare(setup);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
      .toEqual([['bhPresentationConfig', true, 'four-pose-v3']]);
    f.invoke.mockClear(); f.setTime(100); f.bridge.step(1, 0, 0); f.frame(133);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', 1]]);
    f.setTime(140); f.bridge.step(2, 0, 0); f.frame(150);
    const presentations = f.invoke.mock.calls.filter(([name]) => name === 'bhPresent');
    expect(presentations).toHaveLength(2);
    const alpha = Number(presentations[1][1]), poseTick = 2 - 3 + 3 * alpha;
    expect(alpha).toBeGreaterThan(0); expect(alpha).toBeLessThan(1);
    expect(poseTick).toBeGreaterThan(1); expect(poseTick).toBeLessThan(2);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(2);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhState')).toHaveLength(2);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it('retains the initially defaulted mode through player reload instead of rereading a later URL', async () => {
    const f = await fixture('', { terminal: false, fourPose: true });
    await f.bridge.prepare(setup); f.setTime(100); f.bridge.step(1, 0, 0); f.frame(133);
    f.location.href = 'http://example.test/?presentation-clock=legacy-v1#room=abcdefghijkl';
    await f.host.load('/Boxhead_2Play.online.swf', new AbortController().signal);
    const replacement = f.host.bridge(); await replacement.prepare(setup);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
      .toEqual([['bhPresentationConfig', true, 'four-pose-v3'], ['bhPresentationConfig', true, 'four-pose-v3']]);
    expect(f.create).toHaveBeenCalledTimes(2);
    f.invoke.mockClear(); f.setTime(200); replacement.step(1, 0, 0); f.frame(233);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([['bhPresent', 1]]);
    f.host.destroy(); expect(f.frames.size).toBe(0);
  });

  it.each([{}, { threePose: true }, { fourPose: true, invalidPoseConfig: true }])(
    'does not silently downgrade the no-query default when native four-pose negotiation is absent or invalid: %j', async options => {
      const f = await fixture('', { terminal: false, ...options });
      await f.bridge.prepare(setup);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresentationConfig'))
        .toEqual([['bhPresentationConfig', true, 'four-pose-v3'], ['bhPresentationConfig', false]]);
      f.invoke.mockClear(); f.setTime(100); f.bridge.step(1, 0, 0); f.frame(133);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhPresent')).toEqual([]);
      expect(f.invoke.mock.calls.filter(([name]) => name === 'bhStep')).toHaveLength(1);
      expect(f.frames.size).toBe(0); f.host.destroy();
    },
  );

  it('rejects a legacy Present reply after default-four negotiation without issuing another game tick', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = await fixture('', { terminal: false, fourPose: true });
    await f.bridge.prepare(setup); f.setTime(100); f.bridge.step(1, 0, 0); f.invoke.mockClear();
    f.invoke.mockImplementationOnce(() => ({ version: 1, enabled: true, rendered: true, tick: 1, alpha: 1 }));
    f.frame(133);
    expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['bhPresent']);
    expect(warning).toHaveBeenCalledOnce(); expect(f.frames.size).toBe(0);
    await Promise.resolve();
    expect(f.invoke.mock.calls.at(-1)).toEqual(['bhPresentationConfig', false]);
    f.host.destroy();
  });
});
