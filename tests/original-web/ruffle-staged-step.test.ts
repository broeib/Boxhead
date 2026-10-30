import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestOriginalState } from '../../apps/original-web/src/native-digest';
import type { PrepareMessage } from '../../apps/original-web/src/protocol';

type Data = Record<string, unknown>;
const setup: PrepareMessage = { type: 'prepare', seed: 7, mode: 'Coop', map: 'ROOM_Single_0001',
  characters: [0, 1], swfHash: 'a'.repeat(64) };
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Stub renderer/VM integration. This checks ordering and generations, not FPS. */
async function fixture(compact = false, options: { defaultFour?: boolean } = {}) {
  vi.resetModules();
  let now = 0; let nextFrame = 0; let generation = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const tasks: (() => void)[] = [];
  const traces: { generation: number; name: string; tick: number; args: unknown[] }[] = [];
  const paints: { generation: number; tick: number; alpha: number }[] = [];
  const presentations: { generation: number; value: Data }[] = [];
  const configurations: unknown[][] = [];
  const created: { isConnected: boolean; remove(): void }[] = [];
  const request = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; };
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  const initialURL = options.defaultFour ? 'http://example.test/' : 'http://example.test/?presentation-clock=legacy-v1';
  const location = { href: initialURL };
  vi.stubGlobal('location', location);
  class Channel {
    port1 = { onmessage: null as (() => void) | null, close() {} };
    port2 = { postMessage: () => tasks.push(() => this.port1.onmessage?.()), close() {} };
  }
  vi.stubGlobal('MessageChannel', Channel);
  const target: Data = {};
  const createPlayer = () => {
    const ownGeneration = ++generation;
    let tick = 0; let epoch = 0; let phase = 'menu'; let rendered = { tick: 0, alpha: 0 };
    let receipt: Data | undefined; let stageKey: Data | undefined; let renderFrame: number | null = null;
    const players = [1, 2].map(slot => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200,
      flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 }));
    const snapshot = () => {
      const scope = tick % 25 === 0 ? 'full' : 'frame';
      const native = { tick, scope, entities: [{ id: 1, life: 200 }] };
      const digest = digestOriginalState(native);
      return { version: 1, engine: 'original-swf', state: phase, tick, scope, native, rng: { state: 7 },
        players, digestSchema: 'native-projection-v3', digest: digest.digest, snapshotBytes: digest.bytes,
        snapshotObjects: 1, snapshotFields: 2, profile: { projectMs: 1, hashMs: 1, encodeMs: 0 } };
    };
    const commit = (key: Data) => {
      const full = snapshot();
      const reply = (target.boxheadDigestOriginalState as (native: unknown, key: Data) => { digest: string; bytes: number })(full.native, key);
      const { native: _native, ...header } = full;
      receipt = { ...key, header: { ...header, digest: reply.digest, snapshotBytes: reply.bytes } };
      return { tick, digest: reply.digest, players };
    };
    const invoke = (name: string, ...args: unknown[]) => {
      traces.push({ generation: ownGeneration, name, tick, args });
      if (name === 'bhInfo') return { version: 1, engine: 'original-swf', state: phase, tick,
        canPrepare: phase === 'menu', presentationVersion: 1, snapshotReceiptVersion: 1, stagedStepVersion: 1,
        ...(compact ? { compactStepVersion: 1 } : {}) };
      if (name === 'bhPresentationConfig') {
        configurations.push(args);
        return { version: 1, ok: true, enabled: args[0] === true,
          ...(options.defaultFour && args[0] === true ? { mode: 'four-pose-v3', poseVersion: 3 } : {}) };
      }
      if (name === 'bhPrepare') { phase = 'ready'; return { state: phase, tick: 0 }; }
      if (name === 'bhState') return snapshot();
      if (name === 'bhStep' || name === 'bhStepBegin' || name === 'bhFrameBegin') {
        tick = args[0] as number; epoch++; phase = 'playing';
        const key = { version: 1, token: args[4], epoch, tick, scope: tick % 25 === 0 ? 'full' : 'frame' };
        if (name === 'bhStep') return commit(key);
        stageKey = key; return { version: 1, phase: 'begun', token: key.token, epoch, tick };
      }
      if (name === 'bhStepPrepare' || name === 'bhStepProject') return {
        version: 1, phase: name === 'bhStepPrepare' ? 'prepared' : 'projected', token: args[0], epoch, tick };
      if (name === 'bhStepCommit' || name === 'bhFrameCommit') return commit(stageKey!);
      if (name === 'bhStateReceipt') { const result = receipt; receipt = undefined; return result; }
      if (name === 'bhStepAbort' || name === 'bhFrameAbort') { phase = 'error'; return true; }
      if (name === 'bhPresent') {
        rendered = { tick, alpha: args[0] as number };
        const value = { version: 1, enabled: true, rendered: true, tick,
          ...(options.defaultFour ? { alpha: args[0], mode: 'four-pose-v3', poseVersion: 3,
            poseTick: tick - 3 + 3 * Number(args[0]) } : {}) };
        presentations.push({ generation: ownGeneration, value });
        return value;
      }
      throw new Error('unexpected callback ' + name);
    };
    const player = { isConnected: true, style: {}, tabIndex: 0, id: '',
      load: async () => undefined,
      ruffle: () => ({ callExternalInterface: invoke }),
      remove: () => { player.isConnected = false; if (renderFrame !== null) frames.delete(renderFrame); } };
    const render = () => {
      renderFrame = request(render);
      paints.push({ generation: ownGeneration, ...rendered });
    };
    renderFrame = request(render); created.push(player);
    return player;
  };
  target.RufflePlayer = { newest: () => ({ createPlayer }) };
  vi.stubGlobal('window', target);
  const { OriginalRuffleHost } = await import('../../apps/original-web/src/ruffle');
  const host = new OriginalRuffleHost({ replaceChildren() {}, append() {} } as unknown as HTMLElement);
  disposals.push(() => host.destroy());
  const loadSignal = new AbortController();
  await host.load('/fixture.swf', loadSignal.signal);
  if (options.defaultFour) location.href = 'http://example.test/#room=abcdefghijkl';
  const bridge = host.bridge(); await bridge.prepare(setup);
  const paintAt = (at: number): void => {
    now = at; const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(now);
  };
  for (let tick = 1; tick <= (compact ? 25 : 24); tick++) {
    now = tick * 40; bridge.step(tick, 17, 17);
    // Warm up a real bounded pose clock with renderer opportunities. A test
    // that runs 25 native ticks without painting would exhaust its history.
    if (options.defaultFour) paintAt(now + 20);
  }
  traces.length = 0; paints.length = 0; presentations.length = 0;
  now = options.defaultFour && compact ? 1040 : 1000;
  return { host, bridge, traces, paints, presentations, configurations, initialURL, location, created, frames, tasks,
    paint() { paintAt(now + 1000 / 60); },
    async task() { tasks.shift()?.(); await Promise.resolve(); },
    async reload() {
      await host.load('/new-fixture.swf', new AbortController().signal);
      const replacement = host.bridge(); await replacement.prepare(setup);
      replacement.step(1, 17, 17); return replacement;
    } };
}

describe('Ruffle staged visual integration', () => {
  it('presents the actual Begin tick before Commit and lets the renderer run before the next phase task', async () => {
    const f = await fixture(); const done = vi.fn();
    const pending = f.bridge.stepStaged(25, 17, 17).then(done);
    f.paint(); await Promise.resolve();
    expect(f.traces.map(row => row.name)).toEqual(['bhStepBegin', 'bhPresent']);
    expect(f.paints.at(-1)).toMatchObject({ generation: 1, tick: 25 });
    expect(f.paints.at(-1)!.alpha).toBeCloseTo((1000 / 60) / 40);
    expect(done).not.toHaveBeenCalled();
    await f.task();
    expect(f.traces.at(-1)?.name).toBe('bhStepPrepare');
    f.paint(); await f.task(); f.paint(); await f.task(); await pending;
    expect(f.traces.filter(row => row.name !== 'bhPresent').map(row => row.name)).toEqual([
      'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhInfo', 'bhStateReceipt']);
    expect(f.created[0].isConnected).toBe(true);
  });

  it('aborts and removes a cancelled partial world, including its presentation and renderer loops', async () => {
    const f = await fixture(); const signal = new AbortController();
    const pending = f.bridge.stepStaged(25, 17, 17, undefined, signal.signal);
    const failure = expect(pending).rejects.toThrow('cancelled');
    f.paint(); await f.task(); signal.abort(); await failure;
    expect(f.traces.at(-1)?.name).toBe('bhStepAbort');
    expect(f.created[0].isConnected).toBe(false);
    expect(f.frames.size).toBe(0);
    expect(() => f.host.bridge()).toThrow('has not loaded yet');
  });

  it('never lets an old awaited transaction dispose the replacement player or its presentation', async () => {
    const f = await fixture(); const pending = f.bridge.stepStaged(25, 17, 17);
    const failure = expect(pending).rejects.toThrow();
    const replacement = await f.reload();
    expect(f.created[0].isConnected).toBe(false);
    f.paint(); await f.task(); await failure;
    expect(f.created[1].isConnected).toBe(true);
    f.paint();
    expect(f.paints.at(-1)).toMatchObject({ generation: 2, tick: 1 });
    expect(replacement.step(2, 0, 0).tick).toBe(2);
    expect(f.traces.filter(row => row.generation === 1).map(row => row.name)).toEqual(['bhStepBegin']);
  });

  it('presents compact Begin once, paints before Commit, and never resets its visual clock at Commit', async () => {
    const f = await fixture(true); const done = vi.fn();
    const pending = f.bridge.stepCompact(26, 17, 17).then(done);
    f.paint(); await Promise.resolve();
    expect(f.traces.map(row => row.name)).toEqual(['bhFrameBegin', 'bhPresent']);
    expect(f.paints.at(-1)).toMatchObject({ generation: 1, tick: 26 });
    expect(f.paints.at(-1)!.alpha).toBeCloseTo((1000 / 60) / 40);
    expect(done).not.toHaveBeenCalled();
    await f.task(); await pending;
    expect(f.traces.filter(row => row.name !== 'bhPresent').map(row => row.name)).toEqual([
      'bhFrameBegin', 'bhFrameCommit', 'bhInfo', 'bhStateReceipt']);
    f.paint();
    expect(f.paints.at(-1)!.alpha).toBeCloseTo((2 * 1000 / 60) / 40);
    expect(f.created[0].isConnected).toBe(true);
  });

  it('uses compact Abort on cancellation and removes both visual loops', async () => {
    const f = await fixture(true); const signal = new AbortController();
    const pending = f.bridge.stepCompact(26, 17, 17, undefined, signal.signal);
    const failure = expect(pending).rejects.toThrow('cancelled');
    f.paint(); signal.abort(); await failure;
    expect(f.traces.at(-1)?.name).toBe('bhFrameAbort');
    expect(f.traces.some(row => row.name === 'bhStepAbort' || row.name === 'bhFrameCommit')).toBe(false);
    expect(f.created[0].isConnected).toBe(false);
    expect(f.frames.size).toBe(0);
  });

  it('cannot dispose a replacement generation when an old compact wait resumes', async () => {
    const f = await fixture(true); const pending = f.bridge.stepCompact(26, 17, 17);
    const failure = expect(pending).rejects.toThrow();
    const replacement = await f.reload();
    f.paint(); await f.task(); await failure;
    expect(f.created[1].isConnected).toBe(true);
    expect(replacement.step(2, 0, 0).tick).toBe(2);
    expect(f.traces.filter(row => row.generation === 1).map(row => row.name)).toEqual(['bhFrameBegin']);
  });
});

describe('default-four phased native integration', () => {
  function assertPresentations(rows: { generation: number; value: Data }[], tick: number) {
    expect(rows.length).toBeGreaterThan(0);
    let previous = -Infinity;
    for (const row of rows) {
      expect(row.generation).toBe(1);
      expect(row.value).toMatchObject({ version: 1, enabled: true, rendered: true, tick,
        mode: 'four-pose-v3', poseVersion: 3 });
      const alpha = row.value.alpha as number, pose = row.value.poseTick as number;
      expect(typeof alpha).toBe('number'); expect(Number.isFinite(alpha)).toBe(true);
      expect(alpha).toBeGreaterThanOrEqual(0); expect(alpha).toBeLessThanOrEqual(1);
      expect(pose).toBeCloseTo(tick - 3 + 3 * alpha, 10); expect(pose).toBeGreaterThanOrEqual(previous);
      previous = pose;
    }
  }

  it('presents valid default-four poses between all full stages and keeps Commit, Info and Receipt together', async () => {
    const f = await fixture(false, { defaultFour: true }), done = vi.fn();
    expect(new URL(f.initialURL).search).toBe(''); expect(new URL(f.location.href).search).toBe('');
    expect(f.configurations).toEqual([[true, 'four-pose-v3']]);
    const pending = f.bridge.stepStaged(25, 17, 17).then(done);
    f.paint(); await Promise.resolve();
    expect(f.traces.map(row => row.name)).toEqual(['bhStepBegin', 'bhPresent']);
    expect(f.paints.at(-1)).toMatchObject({ generation: 1, tick: 25 });
    expect(done).not.toHaveBeenCalled(); assertPresentations(f.presentations, 25);
    await f.task(); f.paint(); await f.task(); f.paint(); await f.task(); await pending;
    expect(f.traces.filter(row => row.name !== 'bhPresent').map(row => row.name)).toEqual([
      'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhInfo', 'bhStateReceipt']);
    expect(f.traces.slice(-3).map(row => row.name)).toEqual(['bhStepCommit', 'bhInfo', 'bhStateReceipt']);
    expect(done).toHaveBeenCalledOnce(); assertPresentations(f.presentations, 25);
    expect(f.created[0].isConnected).toBe(true); f.paint(); assertPresentations(f.presentations, 25);
    expect(f.traces.filter(row => row.name === 'bhStep' || row.name === 'bhStepBegin')).toHaveLength(1);
  });

  it('presents the actual compact Begin with default four poses before its single Commit/Info/Receipt boundary', async () => {
    const f = await fixture(true, { defaultFour: true }), done = vi.fn();
    expect(new URL(f.initialURL).search).toBe(''); expect(f.configurations).toEqual([[true, 'four-pose-v3']]);
    const pending = f.bridge.stepCompact(26, 17, 17).then(done);
    f.paint(); await Promise.resolve();
    expect(f.traces.map(row => row.name)).toEqual(['bhFrameBegin', 'bhPresent']);
    expect(f.paints.at(-1)).toMatchObject({ generation: 1, tick: 26 });
    expect(done).not.toHaveBeenCalled(); assertPresentations(f.presentations, 26);
    await f.task(); await pending;
    expect(f.traces.filter(row => row.name !== 'bhPresent').map(row => row.name)).toEqual([
      'bhFrameBegin', 'bhFrameCommit', 'bhInfo', 'bhStateReceipt']);
    expect(f.traces.slice(-3).map(row => row.name)).toEqual(['bhFrameCommit', 'bhInfo', 'bhStateReceipt']);
    expect(done).toHaveBeenCalledOnce(); f.paint(); assertPresentations(f.presentations, 26);
    expect(f.created[0].isConnected).toBe(true);
    expect(f.traces.filter(row => row.name === 'bhStep' || row.name === 'bhFrameBegin')).toHaveLength(1);
  });
});
