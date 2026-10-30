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

/** Actual client collector/Bridge with contract stubs, not AVM or FPS evidence. */
function fixture() {
  let tick = 0; let epoch = 0; let state = 'menu'; let roster = [1, 2];
  let compactCapability: unknown = 1;
  let fullCapability: unknown = 1;
  let receipt: Data | undefined; let phaseKey: Data | undefined;
  let change = (_name: string, value: Data): Data => value;
  const target: Data = {}; const collector = new NativeSnapshotExports(target, 'bridge_compact');
  const waits: { resume(): void; reject(error: Error): void }[] = [];
  const trace: string[] = [];
  const snapshot = () => {
    const scope = tick % 25 === 0 ? 'full' : 'frame';
    const native = { scope, tick, rng: { state: 7, calls: tick }, entities: [{ id: 1, life: 200 }] };
    const digest = digestOriginalState(native);
    return { version: 1, engine: 'original-swf', state, tick, digest: digest.digest, scope,
      digestSchema: 'native-projection-v3', rng: { state: 7, calls: tick }, players: roster.map(player),
      native, snapshotBytes: digest.bytes, snapshotObjects: 3, snapshotFields: 8,
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
      ...(compactCapability === undefined ? {} : { compactStepVersion: compactCapability }),
      ...(fullCapability === undefined ? {} : { stagedStepVersion: fullCapability }) });
    if (name === 'bhPrepare') {
      roster = (args[6] as { initialPlayers?: number })?.initialPlayers === 1 ? [1] : [1, 2];
      state = 'ready'; return { state, tick: 0 };
    }
    if (name === 'bhState') return snapshot();
    if (name === 'bhStep' || name === 'bhStepBegin' || name === 'bhFrameBegin') {
      tick = args[0] as number; state = 'playing'; epoch++;
      if (args[3] !== undefined) roster = [1, 2];
      if (args[5] !== undefined) roster = [1];
      const key = { version: 1, token: args[4], epoch, tick, scope: tick % 25 === 0 ? 'full' : 'frame' };
      if (name === 'bhStep') return exportState(key);
      phaseKey = key;
      return change('begin', { version: 1, phase: 'begun', token: key.token, epoch, tick });
    }
    if (name === 'bhStepPrepare' || name === 'bhStepProject') return {
      version: 1, phase: name === 'bhStepPrepare' ? 'prepared' : 'projected', token: args[0], epoch, tick };
    if (name === 'bhStepCommit' || name === 'bhFrameCommit') return exportState(phaseKey!);
    if (name === 'bhStateReceipt') { const current = receipt; receipt = undefined; return current; }
    if (name === 'bhStepAbort' || name === 'bhFrameAbort') { state = 'error'; return true; }
    if (name === 'bhPresent') return { version: 1, enabled: true, rendered: true, tick };
    return undefined;
  });
  const runtime: StagedStepRuntime = {
    alignLiveStepsToPaint: true,
    yield: vi.fn(signal => new Promise<void>((resolve, reject) => {
      trace.push('paint-task');
      const abort = () => reject(new Error('aborted compact wait'));
      signal?.addEventListener('abort', abort, { once: true });
      waits.push({ resume: () => { signal?.removeEventListener('abort', abort); resolve(); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
    })),
    abort: vi.fn(key => raw('bhStepAbort', key.token, key.epoch, key.tick)),
    abortCompact: vi.fn(key => raw('bhFrameAbort', key.token, key.epoch, key.tick)),
    dispose: vi.fn(),
  };
  const invoke: NativeInvoke = (name, ...args) => collector.invoke(name, args, () => raw(name, ...args));
  const bridge = new OriginalBridge(invoke, collector, runtime);
  return { bridge, collector, raw, waits, runtime, trace,
    change: (fn: typeof change) => { change = fn; },
    capability: (value: unknown) => { compactCapability = value; },
    fullCapability: (value: unknown) => { fullCapability = value; },
    async advance(count = 1) { for (let i = 0; i < count; i++) { waits.shift()!.resume(); await Promise.resolve(); } },
    async ready(count = 0, initialPlayers: 1 | 2 = 2, membershipVersion?: 1 | 2) {
      await bridge.prepare({ ...setup, initialPlayers, membershipVersion });
      for (let i = 1; i <= count; i++) bridge.step(i, 17, initialPlayers === 2 ? 17 : 0);
      raw.mockClear(); trace.length = 0;
    } };
}

describe('OriginalBridge compact paint boundary', () => {
  it.each([{ tick: 24, method: 'stepCompact' as const }, { tick: 25, method: 'stepStaged' as const }])(
    'runs membership v1 leave at tick $tick with a synchronous receipt', async ({ tick, method }) => {
      const f = fixture();
      await f.bridge.prepare({ ...setup, initialPlayers: 1, membershipVersion: 1 });
      f.bridge.step(1, 17, 0, { slot: 2, character: 1 });
      for (let i = 2; i < tick; i++) f.bridge.step(i, 17, 0);
      f.raw.mockClear(); f.trace.length = 0;
      const result = await f.bridge[method](tick, 17, 0, undefined, undefined, { slot: 2 });
      expect(result.players.map(value => value.slot)).toEqual([1]);
      expect(f.trace).toEqual(['bhStep', 'bhInfo', 'bhStateReceipt']);
      expect(f.raw).toHaveBeenCalledWith('bhStep', tick, 17, 0, undefined, expect.any(String), { slot: 2 });
      expect(f.runtime.yield).not.toHaveBeenCalled();
    });
  it('fails closed for a corrupted membership v1 leave receipt', async () => {
    const f = fixture();
    await f.bridge.prepare({ ...setup, initialPlayers: 1, membershipVersion: 1 });
    f.bridge.step(1, 17, 0, { slot: 2, character: 1 });
    for (let i = 2; i < 24; i++) f.bridge.step(i, 17, 0);
    f.trace.length = 0;
    f.change((name, value) => name === 'receipt' ? { ...value, token: 'wrong' } : value);
    await expect(f.bridge.stepCompact(24, 17, 0, undefined, undefined, { slot: 2 })).rejects.toThrow();
    expect(f.trace.filter(name => name === 'bhStep')).toHaveLength(1);
    expect(f.trace).not.toContain('bhFrameBegin');
    expect(() => f.bridge.step(25, 17, 0)).toThrow();
  });
  it.each([{ tick: 24, method: 'stepCompact' as const }, { tick: 25, method: 'stepStaged' as const }])(
    'runs a leave at tick $tick through synchronous receipt verification before opening a fence', async ({ tick, method }) => {
      const f = fixture(); await f.ready(tick - 1, 2, 2);
      const result = await f.bridge[method](tick, 17, 0, undefined, undefined, { slot: 2 });
      expect(result.tick).toBe(tick);
      expect(result.players.map(value => value.slot)).toEqual([1]);
      expect(f.trace).toEqual(['bhStep', 'bhInfo', 'bhStateReceipt']);
      expect(f.raw).toHaveBeenCalledWith('bhStep', tick, 17, 0, undefined, expect.any(String), { slot: 2 });
      expect(f.runtime.yield).not.toHaveBeenCalled();
    });

  it('fails closed when the synchronous leave receipt is corrupted; no phased retry is allowed', async () => {
    const f = fixture(); await f.ready(23, 2, 2);
    f.change((name, value) => name === 'receipt' ? { ...value, token: 'wrong' } : value);
    await expect(f.bridge.stepCompact(24, 17, 0, undefined, undefined, { slot: 2 })).rejects.toThrow();
    expect(f.trace.filter(name => name === 'bhStep')).toHaveLength(1);
    expect(f.trace).not.toContain('bhFrameBegin');
    expect(() => f.bridge.step(25, 17, 0)).toThrow();
  });

  it('waits once after actual Begin and completes Commit/Info/Receipt before returning ACK data', async () => {
    const f = fixture(); await f.ready(); const done = vi.fn();
    const pending = f.bridge.stepCompact(1, 17, 17).then(done);
    expect(f.trace).toEqual(['bhFrameBegin', 'paint-task']);
    expect(f.bridge.supportsCompactStep()).toBe(false);
    expect(f.bridge.requiresPaintBeforeStep()).toBe(false);
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    await f.advance(); await pending;
    expect(f.trace).toEqual(['bhFrameBegin', 'paint-task', 'bhFrameCommit', 'bhInfo', 'bhStateReceipt']);
    expect(done.mock.calls[0][0].tick).toBe(1);
    expect(f.bridge.supportsCompactStep()).toBe(true);
    expect(f.runtime.dispose).not.toHaveBeenCalled();
  });

  it('preserves compact24 → full25 → compact26 with the shared monotonic receipt owner', async () => {
    const f = fixture(); await f.ready(23);
    let pending = f.bridge.stepCompact(24, 17, 17); await f.advance(); await pending;
    pending = f.bridge.stepStaged(25, 17, 17); await f.advance(3); await pending;
    pending = f.bridge.stepCompact(26, 17, 17); await f.advance(); await pending;
    expect(f.trace.filter(name => name !== 'paint-task')).toEqual([
      'bhFrameBegin', 'bhFrameCommit', 'bhInfo', 'bhStateReceipt',
      'bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhInfo', 'bhStateReceipt',
      'bhFrameBegin', 'bhFrameCommit', 'bhInfo', 'bhStateReceipt']);
  });

  it.each(['capability', 'cleanup'] as const)('selects compatibility before Begin if %s is unavailable', async missing => {
    const f = fixture();
    if (missing === 'capability') f.capability(undefined); else f.runtime.abortCompact = undefined;
    await f.ready(); expect(f.bridge.supportsCompactStep()).toBe(false);
    expect((await f.bridge.stepCompact(1, 0, 0)).tick).toBe(1);
    expect(f.trace).toEqual(['bhStep', 'bhInfo', 'bhStateReceipt']);
    expect(f.runtime.yield).not.toHaveBeenCalled();
  });

  it('never selects the compact ABI for a full25 tick', async () => {
    const f = fixture(); await f.ready(24);
    expect((await f.bridge.stepCompact(25, 0, 0)).tick).toBe(25);
    expect(f.trace).toEqual(['bhStep', 'bhInfo', 'bhStateReceipt']);
  });

  it('supports compact paint scheduling without the separate full capability', async () => {
    const f = fixture(); f.fullCapability(undefined);
    expect(f.bridge.requiresPaintBeforeStep()).toBe(false);
    await f.ready();
    expect(f.bridge.supportsStagedStep()).toBe(false);
    expect(f.bridge.requiresPaintBeforeStep()).toBe(true);
  });

  it('rejects an unknown compact capability version during preparation', async () => {
    const f = fixture(); f.capability(2);
    await expect(f.bridge.prepare(setup)).rejects.toThrow();
    expect(f.raw.mock.calls.some(([name]) => name === 'bhFrameBegin' || name === 'bhStep')).toBe(false);
  });

  it('aborts only the compact protocol on cancellation, without replay or ACK data', async () => {
    const f = fixture(); await f.ready(); const signal = new AbortController();
    const pending = f.bridge.stepCompact(1, 17, 17, undefined, signal.signal);
    const result = expect(pending).rejects.toThrow('aborted'); signal.abort(); await result;
    expect(f.runtime.abortCompact).toHaveBeenCalledOnce();
    expect(f.runtime.abort).not.toHaveBeenCalled();
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    expect(f.trace).toEqual(['bhFrameBegin', 'paint-task', 'bhFrameAbort']);
    expect(() => f.bridge.step(1, 0, 0)).toThrow();
  });

  it('does not open a native transaction when already cancelled', async () => {
    const f = fixture(); await f.ready(); const signal = new AbortController(); signal.abort();
    await expect(f.bridge.stepCompact(1, 0, 0, undefined, signal.signal)).rejects.toThrow();
    expect(f.trace).toEqual([]); expect(f.runtime.dispose).not.toHaveBeenCalled();
  });

  it.each(['begin', 'result', 'info', 'header', 'receipt'])
    ('disposes malformed %s without any legacy fallback', async point => {
      const f = fixture(); await f.ready();
      f.change((name, value) => name !== point ? value
        : point === 'header' ? { ...value, digest: 'forged' }
        : point === 'receipt' ? { ...value, scope: 'full' } : { ...value, tick: 2 });
      const pending = f.bridge.stepCompact(1, 17, 17); const result = expect(pending).rejects.toThrow();
      if (f.waits.length) await f.advance(); await result;
      expect(f.runtime.dispose).toHaveBeenCalledOnce();
      expect(f.trace.some(name => name === 'bhStep' || name === 'bhState' || name === 'bhStepAbort')).toBe(false);
      expect(() => f.bridge.step(2, 0, 0)).toThrow();
    });

  it('requires the same compact capability at the actual final Info', async () => {
    const f = fixture(); await f.ready(); const pending = f.bridge.stepCompact(1, 0, 0);
    const failure = expect(pending).rejects.toThrow(); f.capability(undefined); await f.advance(); await failure;
    expect(f.trace.includes('bhStateReceipt')).toBe(false);
    expect(f.runtime.abortCompact).toHaveBeenCalledOnce();
  });

  it('invalidates an in-flight compact owner when another step arrives', async () => {
    const f = fixture(); await f.ready(); const pending = f.bridge.stepCompact(1, 0, 0);
    const failure = expect(pending).rejects.toThrow();
    expect(() => f.bridge.step(2, 0, 0)).toThrow(); await f.advance(); await failure;
    expect(f.runtime.abortCompact).toHaveBeenCalledOnce();
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    expect(f.trace.includes('bhFrameCommit')).toBe(false);
  });

  it('still disposes if typed native cleanup rejects', async () => {
    const f = fixture(); await f.ready();
    vi.mocked(f.runtime.abortCompact!).mockImplementation(() => { throw new Error('cleanup failed'); });
    const pending = f.bridge.stepCompact(1, 0, 0); const result = expect(pending).rejects.toThrow('paint failed');
    f.waits.shift()!.reject(new Error('paint failed')); await result;
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });

  it('preserves the real join command and validates the guest after Commit', async () => {
    const f = fixture(); await f.ready(0, 1); const join: PlayerJoin = { slot: 2, character: 1 };
    const pending = f.bridge.stepCompact(1, 17, 0, join); await f.advance();
    expect((await pending).players.map(p => p.slot)).toEqual([1, 2]);
    expect(f.raw.mock.calls[0].slice(0, 5)).toEqual(['bhFrameBegin', 1, 17, 0, join]);
  });

  it('returns terminal data only after validating its actual empty roster', async () => {
    const f = fixture(); await f.ready();
    f.change((name, value) => name === 'result' ? { ...value, players: [], complete: 'playerdead' }
      : name === 'header' ? { ...value, players: [] } : value);
    const pending = f.bridge.stepCompact(1, 0, 0); await f.advance();
    expect((await pending).complete).toBe('playerdead');
    expect(f.trace.slice(-3)).toEqual(['bhFrameCommit', 'bhInfo', 'bhStateReceipt']);
  });

  it('learns a previously absent compact capability only after a validated synchronous receipt', async () => {
    const f = fixture(); f.capability(undefined); await f.ready();
    expect(f.bridge.supportsCompactStep()).toBe(false);
    f.capability(1); f.bridge.step(1, 0, 0);
    expect(f.bridge.supportsCompactStep()).toBe(true);
  });
});
