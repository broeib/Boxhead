import { describe, expect, it, vi } from 'vitest';
import { OriginalBridge, type NativeInvoke, type StagedStepRuntime } from '../../apps/original-web/src/bridge';
import { NativeSnapshotExports } from '../../apps/original-web/src/native-snapshot-export';
import { digestOriginalState } from '../../apps/original-web/src/native-digest';
import type { PlayerJoin, PrepareMessage } from '../../apps/original-web/src/protocol';

type Data = Record<string, unknown>;
const setup: PrepareMessage = { type: 'prepare', seed: 7, swfHash: 'a'.repeat(64), mode: 'Coop',
  map: 'ROOM_Single_0001', characters: [0, 1], initialPlayers: 2, personalProgression: true };
const player = (slot: number) => ({ slot, id: slot, x: slot, y: 0, z: 0, angle: 0, life: 200,
  flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 });

/** Real client guards around contract stubs; not compiled-SWF evidence. */
function fixture(capability: unknown = 1, scheduler = true) {
  let tick = 0; let epoch = 0; let state = 'menu'; let roster = [1, 2];
  let stagedCapability = capability;
  let receipt: Data | undefined; let stagedKey: Data | undefined;
  let change = (_name: string, value: Data): Data => value;
  const target: Data = {}; const collector = new NativeSnapshotExports(target, 'bridge_stage');
  const waits: { resume(): void; reject(error: Error): void }[] = [];
  const trace: string[] = [];
  const snapshot = () => {
    const scope = tick % 25 === 0 ? 'full' : 'frame';
    const native = { scope, tick, rng: { seed: 7, state: 7, calls: tick }, entities: [{ id: 1, life: 200 }] };
    const digest = digestOriginalState(native);
    return { version: 1, engine: 'original-swf', state, tick, digest: digest.digest, scope,
      digestSchema: 'native-projection-v3', rng: { seed: 7, state: 7, calls: tick },
      players: roster.map(player), native, snapshotBytes: digest.bytes, snapshotObjects: 3, snapshotFields: 8,
      profile: { projectMs: 1, encodeMs: 0, hashMs: 1 } };
  };
  const exportState = (key: Data) => {
    const full = snapshot();
    const reply = (target.boxheadDigestOriginalState as (native: unknown, key: Data) => { digest: string; bytes: number })(full.native, key);
    const { native: _native, ...header } = full;
    receipt = change('receipt', { ...key, header: change('header', { ...header, digest: reply.digest, snapshotBytes: reply.bytes }) });
    return change('result', { tick, digest: reply.digest, players: full.players });
  };
  const raw = vi.fn<NativeInvoke>((name, ...args) => {
    trace.push(name);
    if (name === 'bhInfo') return change('info', { version: 1, engine: 'original-swf', state, tick,
      canPrepare: state === 'menu', snapshotReceiptVersion: 1,
      ...(stagedCapability === undefined ? {} : { stagedStepVersion: stagedCapability }) });
    if (name === 'bhPrepare') {
      roster = (args[6] as { initialPlayers?: number })?.initialPlayers === 1 ? [1] : [1, 2];
      state = 'ready'; return { state, tick: 0 };
    }
    if (name === 'bhState') return snapshot();
    if (name === 'bhStep' || name === 'bhStepBegin') {
      tick = args[0] as number; state = 'playing'; epoch++;
      if (args[3] !== undefined) roster = [1, 2];
      const key = { version: 1, token: args[4], epoch, tick, scope: tick % 25 === 0 ? 'full' : 'frame' };
      if (name === 'bhStep') return exportState(key);
      stagedKey = key;
      return change('begin', { version: 1, phase: 'begun', token: key.token, epoch, tick });
    }
    if (name === 'bhStepPrepare' || name === 'bhStepProject') return change(name,
      { version: 1, phase: name === 'bhStepPrepare' ? 'prepared' : 'projected', token: args[0], epoch, tick });
    if (name === 'bhStepCommit') return exportState(stagedKey!);
    if (name === 'bhStateReceipt') { const current = receipt; receipt = undefined; return current; }
    if (name === 'bhStepAbort') { state = 'error'; return true; }
    if (name === 'bhPresent') return { version: 1, enabled: true, rendered: true, tick };
    return undefined;
  });
  const runtime: StagedStepRuntime = {
    yield: vi.fn(signal => new Promise<void>((resolve, reject) => {
      trace.push('paint-task');
      const abort = () => reject(new Error('aborted stage wait'));
      signal?.addEventListener('abort', abort, { once: true });
      waits.push({ resume: () => { signal?.removeEventListener('abort', abort); resolve(); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
    })),
    abort: vi.fn(key => raw('bhStepAbort', key.token, key.epoch, key.tick)),
    dispose: vi.fn(),
  };
  const invoke: NativeInvoke = (name, ...args) => collector.invoke(name, args, () => raw(name, ...args));
  const bridge = new OriginalBridge(invoke, collector, scheduler ? runtime : undefined);
  return { bridge, collector, raw, waits, runtime, trace,
    change: (fn: typeof change) => { change = fn; }, capability: (value: unknown) => { stagedCapability = value; },
    async advance(count = 1) { for (let i = 0; i < count; i++) { waits.shift()!.resume(); await Promise.resolve(); } },
    async ready(initialPlayers: 1 | 2 = 2) {
      await bridge.prepare({ ...setup, initialPlayers });
      for (let i = 1; i <= 24; i++) bridge.step(i, 17, initialPlayers === 2 ? 17 : 0);
      raw.mockClear(); trace.length = 0;
    } };
}

describe('OriginalBridge staged full checks', () => {
  it('advertises foreground paint alignment only for an explicitly enabled, prepared and idle runtime', async () => {
    const f = fixture(); f.runtime.alignLiveStepsToPaint = true;
    expect(f.bridge.requiresPaintBeforeStep()).toBe(false);
    await f.ready(); expect(f.bridge.requiresPaintBeforeStep()).toBe(true);
    const pending = f.bridge.stepStaged(25, 17, 17);
    expect(f.bridge.requiresPaintBeforeStep()).toBe(false);
    await f.advance(3); await pending;
    expect(f.bridge.requiresPaintBeforeStep()).toBe(true);
    f.runtime.alignLiveStepsToPaint = false;
    expect(f.bridge.requiresPaintBeforeStep()).toBe(false);
  });

  it('performs three paint-task waits, then Commit/Info/Receipt together before returning a result', async () => {
    const f = fixture(); await f.ready(); const done = vi.fn();
    const pending = f.bridge.stepStaged(25, 17, 17).then(done);
    expect(f.trace).toEqual(['bhStepBegin', 'paint-task']);
    expect(f.bridge.supportsStagedStep()).toBe(false);
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    await f.advance(); expect(f.trace.slice(-2)).toEqual(['bhStepPrepare', 'paint-task']);
    await f.advance(); expect(f.trace.slice(-2)).toEqual(['bhStepProject', 'paint-task']);
    expect(done).not.toHaveBeenCalled();
    await f.advance(); await pending;
    expect(f.trace).toEqual(['bhStepBegin', 'paint-task', 'bhStepPrepare', 'paint-task', 'bhStepProject',
      'paint-task', 'bhStepCommit', 'bhInfo', 'bhStateReceipt']);
    expect(done.mock.calls[0][0].tick).toBe(25);
    expect(f.bridge.supportsStagedStep()).toBe(true);
    expect(f.runtime.dispose).not.toHaveBeenCalled();
    expect(f.bridge.step(26, 0, 0).tick).toBe(26);
  });

  it('keeps compact frames synchronous and chooses fallback before touching a full transaction', async () => {
    const f = fixture(); await f.ready();
    expect(f.bridge.step(25, 0, 0).tick).toBe(25);
    f.trace.length = 0;
    expect((await f.bridge.stepStaged(26, 0, 0)).tick).toBe(26);
    expect(f.trace).toEqual(['bhStep', 'bhInfo', 'bhStateReceipt']);
    expect(f.runtime.yield).not.toHaveBeenCalled();
  });

  it.each(['no-capability', 'no-scheduler'] as const)('uses the original full step with %s', async mode => {
    const f = fixture(mode === 'no-capability' ? undefined : 1, mode !== 'no-scheduler');
    if (mode === 'no-capability') f.capability(undefined);
    await f.ready();
    expect(f.bridge.supportsStagedStep()).toBe(false);
    expect((await f.bridge.stepStaged(25, 0, 0)).tick).toBe(25);
    expect(f.trace).toEqual(['bhStep', 'bhInfo', 'bhStateReceipt']);
  });

  it('rejects an unsupported capability version before any step', async () => {
    const f = fixture(2);
    await expect(f.bridge.prepare(setup)).rejects.toThrow();
    expect(f.raw.mock.calls.some(([name]) => name.startsWith('bhStep'))).toBe(false);
  });

  it.each([0, 1, 2])('disposes cancellation after phase %i without ACK data or synchronous retry', async completedWaits => {
    const f = fixture(); await f.ready(); const abort = new AbortController();
    const pending = f.bridge.stepStaged(25, 17, 17, undefined, abort.signal);
    const result = expect(pending).rejects.toThrow('aborted');
    await f.advance(completedWaits); abort.abort(); await result;
    expect(f.runtime.abort).toHaveBeenCalledOnce();
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    expect(f.raw.mock.calls.some(([name]) => name === 'bhStep' || name === 'bhStepCommit' || name === 'bhStateReceipt')).toBe(false);
    expect(() => f.bridge.step(25, 17, 17)).toThrow();
  });

  it.each(['begin', 'bhStepPrepare', 'bhStepProject', 'result', 'info', 'header', 'receipt'])
    ('fails closed on malformed %s and never substitutes a legacy read', async point => {
      const f = fixture(); await f.ready();
      f.change((name, value) => name !== point ? value
        : point === 'header' ? { ...value, digest: 'forged' }
        : point === 'receipt' ? { ...value, token: 'foreign' } : { ...value, tick: 26 });
      const pending = f.bridge.stepStaged(25, 17, 17);
      const result = expect(pending).rejects.toThrow();
      for (let i = 0; i < 3 && f.waits.length > 0; i++) await f.advance();
      await result;
      expect(f.runtime.dispose).toHaveBeenCalledOnce();
      expect(f.raw.mock.calls.some(([name]) => name === 'bhStep' || name === 'bhState')).toBe(false);
      expect(() => f.bridge.step(26, 0, 0)).toThrow();
    });

  it('rejects a later synchronous step while partial, invalidates the owner, and disposes once it unwinds', async () => {
    const f = fixture(); await f.ready(); const pending = f.bridge.stepStaged(25, 17, 17);
    const result = expect(pending).rejects.toThrow();
    expect(() => f.bridge.step(26, 0, 0)).toThrow();
    expect(f.runtime.dispose).toHaveBeenCalled();
    await f.advance(); await result;
    expect(f.raw.mock.calls.some(([name]) => name === 'bhStepPrepare' || name === 'bhStep')).toBe(false);
  });

  it('still disposes the world if native abort itself throws', async () => {
    const f = fixture(); await f.ready();
    vi.mocked(f.runtime.abort).mockImplementation(() => { throw new Error('cleanup rejected'); });
    const pending = f.bridge.stepStaged(25, 17, 17); const result = expect(pending).rejects.toThrow('wait failed');
    f.waits.shift()!.reject(new Error('wait failed')); await result;
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    expect(() => f.bridge.step(25, 0, 0)).toThrow();
  });

  it('returns the actual terminal result only after its empty final roster was checked', async () => {
    const f = fixture(); await f.ready();
    f.change((name, value) => name === 'result' ? { ...value, players: [], complete: 'playerdead' }
      : name === 'header' ? { ...value, players: [] } : value);
    const pending = f.bridge.stepStaged(25, 0, 0); await f.advance(3);
    expect((await pending).complete).toBe('playerdead');
    expect(f.trace.slice(-3)).toEqual(['bhStepCommit', 'bhInfo', 'bhStateReceipt']);
  });

  it('retains real guest spawn arguments and validates its final roster', async () => {
    const f = fixture(); await f.ready(1);
    const join: PlayerJoin = { slot: 2, character: 1 };
    const pending = f.bridge.stepStaged(25, 17, 0, join); await f.advance(3);
    expect((await pending).players.map(p => p.slot)).toEqual([1, 2]);
    expect(f.raw.mock.calls[0].slice(0, 5)).toEqual(['bhStepBegin', 25, 17, 0, join]);
  });

  it('refreshes a formerly unavailable capability only from the next validated native Info', async () => {
    const f = fixture(); f.capability(undefined); await f.ready();
    expect(f.bridge.supportsStagedStep()).toBe(false);
    f.capability(1); f.bridge.step(25, 0, 0);
    expect(f.bridge.supportsStagedStep()).toBe(true);
  });
});
