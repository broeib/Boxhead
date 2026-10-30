import { describe, expect, it, vi } from 'vitest';
import type { NativeCallback } from '../../apps/original-web/src/bridge';
import { NativeSnapshotExports } from '../../apps/original-web/src/native-snapshot-export';
import { digestOriginalState } from '../../apps/original-web/src/native-digest';

type Data = Record<string, unknown>;
type Digest = (native: unknown, key?: unknown) => { digest: string; bytes: number };

/** Client ownership/ordering fixtures. Compiled AVM parity is a separate CI gate. */
function fixture(tick = 1) {
  const target: Data = {};
  const collector = new NativeSnapshotExports(target, 'compact');
  const token = collector.beginCompactStep(tick);
  const key = { token, epoch: 1, tick };
  const native = { tick, scope: 'frame', entities: [{ id: 1, life: 200 }], rng: { state: 7 } };
  const beginArgs = [tick, 17, 0, undefined, token];
  const nextArgs = [token, 1, tick];
  const begun = () => ({ version: 1, phase: 'begun', ...key });
  const begin = () => collector.invoke('bhFrameBegin', beginArgs, begun);
  const exportGraph = (change: Data = {}) => (target.boxheadDigestOriginalState as Digest)(native,
    { version: 1, ...key, scope: 'frame', ...change });
  let receipt: Data | undefined;
  const commit = (action: () => unknown = exportGraph) => collector.invoke('bhFrameCommit', nextArgs, () => {
    const result = action() as ReturnType<Digest>;
    receipt = { version: 1, ...key, scope: 'frame', header: {
      version: 1, engine: 'original-swf', state: 'playing', tick, scope: 'frame',
      digestSchema: 'native-projection-v3', digest: result?.digest, snapshotBytes: result?.bytes,
      players: [], rng: { state: 7 }, snapshotObjects: 2, snapshotFields: 5,
      profile: { projectMs: 1, hashMs: 1, encodeMs: 0 },
    } };
    return { tick, digest: result?.digest, players: [] };
  });
  const info = () => collector.invoke('bhInfo', [], () => ({ tick }));
  const receive = () => collector.invoke('bhStateReceipt', nextArgs, () => receipt);
  return { target, collector, token, key, native, beginArgs, nextArgs, begun,
    begin, exportGraph, commit, info, receive };
}

describe('compact two-phase native export ownership', () => {
  it('allows presentation between actual Begin and one Commit export, then consumes the exact frame receipt', async () => {
    const f = fixture(); const digest = vi.fn(f.target.boxheadDigestOriginalState as Digest);
    f.target.boxheadDigestOriginalState = digest;
    f.begin(); expect(digest).not.toHaveBeenCalled();
    expect(f.collector.compactStepRequest()).toEqual(f.key);
    await Promise.resolve();
    f.collector.invoke('bhPresent', [0.5], () => ({ tick: 1 }));
    expect(f.commit().digest).toBe(digestOriginalState(f.native).digest);
    expect(digest).toHaveBeenCalledOnce();
    f.info(); const state = f.collector.consumeReceipt(f.receive());
    expect(state.native).toBe(f.native);
    expect(Object.isFrozen(f.native.entities[0])).toBe(true);
    expect(() => f.collector.beginCompactStep(2)).not.toThrow();
  });

  it.each([0, -1, 25, 50, 1.5, NaN, 0x80000000])('rejects compact scope at tick %s', tick => {
    const collector = new NativeSnapshotExports({}, 'bad_scope');
    expect(() => collector.beginCompactStep(tick)).toThrow();
    expect(() => collector.beginStep(1)).toThrow();
  });

  it.each(['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhStepAbort',
    'bhStep', 'bhInfo', 'bhState', 'bhCheckpointExport', 'bhMenuPoll'] as NativeCallback[])
    ('blocks %s while the compact owner is active, before invoking the VM', name => {
      const f = fixture(); f.begin(); const raw = vi.fn();
      expect(() => f.collector.invoke(name, f.nextArgs, raw)).toThrow();
      expect(raw).not.toHaveBeenCalled();
      expect(() => f.collector.beginStep(2)).toThrow();
    });

  it.each(['bhFrameBegin', 'bhFrameCommit', 'bhFrameAbort'] as NativeCallback[])
    ('rejects unsolicited %s without an owner', name => {
      const collector = new NativeSnapshotExports({}, 'idle'); const raw = vi.fn();
      expect(() => collector.invoke(name, [], raw)).toThrow();
      expect(raw).not.toHaveBeenCalled();
    });

  it('forbids a compact callback and compact identity request inside a full transaction', () => {
    const a = new NativeSnapshotExports({}, 'full_a'); a.beginStagedStep(25);
    expect(() => a.invoke('bhFrameBegin', [25, 0, 0, undefined, 'full_a_1'], () => 0)).toThrow();
    const b = fixture(); b.begin();
    expect(() => b.collector.stagedStepRequest()).toThrow();
  });

  it.each([{ phase: 'prepared' }, { epoch: 0 }, { tick: 2 }, { token: 'foreign' },
    { scope: 'frame' }, { digest: 'early' }, { version: 2 }])('rejects malformed Begin witness %j', change => {
    const f = fixture();
    expect(() => f.collector.invoke('bhFrameBegin', f.beginArgs, () => ({ ...f.begun(), ...change }))).toThrow();
    expect(() => f.collector.beginStep(1)).toThrow();
  });

  it('keeps an attempted Begin export fatal even when native catches the error', () => {
    const f = fixture();
    expect(() => f.collector.invoke('bhFrameBegin', f.beginArgs, () => {
      try { f.exportGraph(); } catch { /* no recovery after advancing an invalid world */ }
      return f.begun();
    })).toThrow();
  });

  it.each(['missing', 'duplicate', 'wrong-epoch', 'wrong-scope', 'legacy'] as const)
    ('rejects %s Commit export', mode => {
      const f = fixture(); f.begin();
      expect(() => f.commit(() => {
        if (mode === 'missing') return undefined;
        if (mode === 'wrong-epoch') return f.exportGraph({ epoch: 2 });
        if (mode === 'wrong-scope') return f.exportGraph({ scope: 'full' });
        if (mode === 'legacy') return (f.target.boxheadDigestOriginalState as Digest)(f.native);
        const first = f.exportGraph();
        try { f.exportGraph(); } catch { /* duplicate export remains sticky */ }
        return first;
      })).toThrow();
    });

  it.each([['foreign', 1, 1], ['compact_1', 2, 1], ['compact_1', 1, 2], ['compact_1', 1, 1, 0]])
    ('rejects substituted Commit identity %j', (...args) => {
      const f = fixture(); f.begin(); const raw = vi.fn();
      expect(() => f.collector.invoke('bhFrameCommit', args, raw)).toThrow();
      expect(raw).not.toHaveBeenCalled();
    });

  it('requires one Info before Receipt and no presentation after Commit', () => {
    const early = fixture(); early.begin(); early.commit();
    expect(() => early.receive()).toThrow();
    const repeat = fixture(); repeat.begin(); repeat.commit(); repeat.info();
    expect(() => repeat.info()).toThrow();
    const paint = fixture(); paint.begin(); paint.commit();
    expect(() => paint.collector.invoke('bhPresent', [1], () => 0)).toThrow();
  });

  it('rejects cross-owner reentry even if its exception is swallowed in Commit', () => {
    const f = fixture(); f.begin(); const other = new NativeSnapshotExports(f.target, 'foreign');
    expect(() => f.commit(() => {
      try { other.invoke('bhInfo', [], () => 0); } catch { /* poisoned both owners */ }
      return f.exportGraph();
    })).toThrow();
    expect(() => other.beginStep(1)).toThrow();
  });

  it('poisons a cancelled owner and allows only its typed compact cleanup once', () => {
    const f = fixture(); f.begin(); f.collector.cancel(); const cleanup = vi.fn();
    expect(() => f.collector.abortStagedStep(cleanup)).toThrow();
    expect(cleanup).not.toHaveBeenCalled();
    f.collector.abortCompactStep(cleanup); f.collector.abortCompactStep(cleanup);
    expect(cleanup.mock.calls).toEqual([[f.key]]);
    expect(() => f.collector.beginStep(2)).toThrow();
  });

  it('does not invent an epoch when Begin failed before a valid witness', () => {
    const f = fixture(); const cleanup = vi.fn();
    f.collector.abortCompactStep(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(() => f.collector.beginCompactStep(1)).toThrow();
  });

  it('never permits native export from cleanup', () => {
    const f = fixture(); f.begin();
    expect(() => f.collector.abortCompactStep(() => f.exportGraph())).toThrow();
    expect(() => f.collector.beginStep(2)).toThrow();
  });

  it('shares monotonic epochs with the next full transaction', () => {
    const f = fixture(24); f.begin(); f.commit(); f.info(); f.collector.consumeReceipt(f.receive());
    const token = f.collector.beginStagedStep(25);
    expect(() => f.collector.invoke('bhStepBegin', [25, 0, 0, undefined, token],
      () => ({ version: 1, phase: 'begun', token, epoch: 1, tick: 25 }))).toThrow();
  });
});
