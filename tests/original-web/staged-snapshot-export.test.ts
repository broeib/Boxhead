import { describe, expect, it, vi } from 'vitest';
import type { NativeCallback } from '../../apps/original-web/src/bridge';
import { NativeSnapshotExports } from '../../apps/original-web/src/native-snapshot-export';
import { digestOriginalState } from '../../apps/original-web/src/native-digest';

type Data = Record<string, unknown>;
type Digest = (native: unknown, key?: unknown) => { digest: string; bytes: number };
/** Client contract fixtures only; actual AVM/fence parity needs the CI VM. */
function fixture() {
  const target: Data = {};
  const collector = new NativeSnapshotExports(target, 'staged');
  const token = collector.beginStagedStep(25);
  const key = { token, epoch: 1, tick: 25 };
  const native = { tick: 25, scope: 'full', entities: [{ id: 1, life: 200 }], rng: { state: 7 } };
  const status = (phase: string) => ({ version: 1, phase, ...key });
  const beginArgs = [25, 17, 0, undefined, token];
  const nextArgs = [token, 1, 25];
  const begin = () => collector.invoke('bhStepBegin', beginArgs, () => status('begun'));
  const prepare = () => collector.invoke('bhStepPrepare', nextArgs, () => status('prepared'));
  const project = () => collector.invoke('bhStepProject', nextArgs, () => status('projected'));
  let receipt: Data | undefined;
  const exportGraph = (change: Data = {}) => (target.boxheadDigestOriginalState as Digest)(native,
    { version: 1, ...key, scope: 'full', ...change });
  const commit = (action: () => unknown = () => exportGraph()) => collector.invoke('bhStepCommit', nextArgs, () => {
    const result = action() as ReturnType<Digest>;
    const header = { version: 1, engine: 'original-swf', state: 'playing', tick: 25, scope: 'full',
      digestSchema: 'native-projection-v3', digest: result?.digest, snapshotBytes: result?.bytes,
      players: [], rng: { state: 7 }, snapshotObjects: 2, snapshotFields: 5,
      profile: { projectMs: 1, hashMs: 1, encodeMs: 0 } };
    receipt = { version: 1, ...key, scope: 'full', header };
    return { tick: 25, digest: result?.digest, players: [] };
  });
  const info = () => collector.invoke('bhInfo', [], () => ({ tick: 25 }));
  const receive = () => collector.invoke('bhStateReceipt', nextArgs, () => receipt);
  return { target, collector, key, token, native, status, beginArgs, nextArgs,
    begin, prepare, project, commit, exportGraph, info, receive };
}

describe('staged native snapshot identity and one actual final export', () => {
  it('permits only the exact neutral departure in the owned Begin transaction', () => {
    const f = fixture();
    expect(() => f.collector.invoke('bhStepBegin', [...f.beginArgs, { slot: 2 }], () => f.status('begun'))).not.toThrow();
    expect(f.collector.stagedStepRequest()).toEqual(f.key);
  });
  it.each([
    [25, 17, 1, undefined, 'staged_1', { slot: 2 }],
    [25, 17, 0, { slot: 2, character: 1 }, 'staged_1', { slot: 2 }],
    [25, 17, 0, undefined, 'staged_1', { slot: 2, extra: 1 }],
  ])('rejects malformed departure before beginning a native transaction', (...args) => {
    const f = fixture(); const raw = vi.fn();
    expect(() => f.collector.invoke('bhStepBegin', args, raw)).toThrow();
    expect(raw).not.toHaveBeenCalled();
  });
  it('retains only identity across three stages and receives the actual full graph once at Commit', async () => {
    const f = fixture();
    f.begin();
    expect(f.collector.stagedStepRequest()).toEqual(f.key);
    await Promise.resolve();
    f.collector.invoke('bhPresent', [0.25], () => ({ tick: 25 }));
    f.prepare();
    f.collector.invoke('bhPresent', [0.5], () => ({ tick: 25 }));
    f.project();
    f.collector.invoke('bhPresent', [1], () => ({ tick: 25 }));
    const digest = vi.fn(f.target.boxheadDigestOriginalState as Digest);
    f.target.boxheadDigestOriginalState = digest;
    const result = f.commit();
    expect(digest).toHaveBeenCalledTimes(1);
    expect(result.digest).toBe(digestOriginalState(f.native).digest);
    f.info();
    const state = f.collector.consumeReceipt(f.receive());
    expect(state.native).toBe(f.native);
    expect(Object.isFrozen(f.native.entities[0])).toBe(true);
    expect(() => f.collector.beginStep(26)).not.toThrow();
  });

  it.each([0, 1, 24, 26, 50.5])('rejects staged scope at tick %s before any callback', tick => {
    const collector = new NativeSnapshotExports({}, 'scope');
    expect(() => collector.beginStagedStep(tick)).toThrow();
    expect(() => collector.beginStep(1)).toThrow();
  });

  it.each(['bhInfo', 'bhState', 'bhStep', 'bhStepProject', 'bhStepCommit', 'bhCheckpointExport', 'bhMenuPoll'] as NativeCallback[])
    ('rejects %s between Begin and Prepare before entering the VM', name => {
      const f = fixture(); f.begin(); const raw = vi.fn();
      expect(() => f.collector.invoke(name, f.nextArgs, raw)).toThrow();
      expect(raw).not.toHaveBeenCalled();
      expect(() => f.collector.beginStep(26)).toThrow();
      expect(() => f.collector.stagedStepRequest()).toThrow();
    });

  it.each([
    { phase: 'prepared' }, { epoch: 0 }, { epoch: 0x80000000 }, { token: 'other' },
    { tick: 26 }, { version: 2 }, { digest: 'invented' }, { scope: 'full' },
  ])('rejects a malformed Begin status %j without allowing a retry', change => {
    const f = fixture();
    expect(() => f.collector.invoke('bhStepBegin', f.beginArgs, () => ({ ...f.status('begun'), ...change }))).toThrow();
    expect(() => f.collector.beginStep(25)).toThrow();
  });

  it.each(['prepare', 'project'] as const)('requires the exact Begin epoch in %s replies', phase => {
    const f = fixture(); f.begin(); if (phase === 'project') f.prepare();
    expect(() => f.collector.invoke(phase === 'prepare' ? 'bhStepPrepare' : 'bhStepProject', f.nextArgs,
      () => ({ ...f.status(phase === 'prepare' ? 'prepared' : 'projected'), epoch: 2 }))).toThrow();
  });

  it.each([['other', 1, 25], ['staged_1', 2, 25], ['staged_1', 1, 50], ['staged_1', 1, 25, 0]])
    ('rejects altered phase arguments %j', (...args) => {
      const f = fixture(); f.begin(); const raw = vi.fn();
      expect(() => f.collector.invoke('bhStepPrepare', args, raw)).toThrow();
      expect(raw).not.toHaveBeenCalled();
    });

  it('does not allow an intermediate phase to capture an early graph, even if it catches the error', () => {
    const f = fixture(); f.begin();
    expect(() => f.collector.invoke('bhStepPrepare', f.nextArgs, () => {
      try { f.exportGraph(); } catch { /* invalid native code cannot recover */ }
      return f.status('prepared');
    })).toThrow();
  });

  it.each(['missing', 'double', 'wrong-epoch', 'legacy'] as const)('rejects %s Commit exports', mode => {
    const f = fixture(); f.begin(); f.prepare(); f.project();
    expect(() => f.commit(() => {
      if (mode === 'missing') return undefined;
      if (mode === 'wrong-epoch') return f.exportGraph({ epoch: 2 });
      if (mode === 'legacy') return (f.target.boxheadDigestOriginalState as Digest)(f.native);
      const first = f.exportGraph();
      try { f.exportGraph(); } catch { /* sticky poison */ }
      return first;
    })).toThrow();
  });

  it('requires Info before the actual Receipt and forbids a second Info', () => {
    const early = fixture(); early.begin(); early.prepare(); early.project(); early.commit();
    expect(() => early.receive()).toThrow();
    const duplicate = fixture(); duplicate.begin(); duplicate.prepare(); duplicate.project(); duplicate.commit(); duplicate.info();
    expect(() => duplicate.info()).toThrow();
  });

  it.each([NaN, Infinity, -0.1, 1.1, '0.5'])('rejects invalid presentation alpha %s without native work', alpha => {
    const f = fixture(); f.begin(); const raw = vi.fn();
    expect(() => f.collector.invoke('bhPresent', [alpha], raw)).toThrow();
    expect(raw).not.toHaveBeenCalled();
  });

  it('keeps cross-owner reentry sticky when native catches the nested error', () => {
    const f = fixture(); f.begin(); const other = new NativeSnapshotExports(f.target, 'other');
    expect(() => f.collector.invoke('bhStepPrepare', f.nextArgs, () => {
      try { other.invoke('bhInfo', [], () => 0); } catch { /* invalid reentry */ }
      return f.status('prepared');
    })).toThrow();
    expect(() => f.collector.beginStep(26)).toThrow();
    expect(() => other.beginStep(1)).toThrow();
  });

  it('keeps only the validated cleanup tuple after failure, calls cleanup once, and never revives', () => {
    const f = fixture(); f.begin(); f.prepare();
    expect(() => f.collector.invoke('bhInfo', [], () => 0)).toThrow();
    const cleanup = vi.fn(() => true);
    f.collector.abortStagedStep(cleanup);
    f.collector.abortStagedStep(cleanup);
    expect(cleanup.mock.calls).toEqual([[f.key]]);
    expect(() => f.collector.beginStagedStep(50)).toThrow();
  });

  it('poisons a cancelled partial transaction even after its normal callback stack has unwound', () => {
    const f = fixture(); f.begin(); f.collector.cancel();
    expect(() => f.collector.beginStep(26)).toThrow();
    const cleanup = vi.fn(); f.collector.abortStagedStep(cleanup);
    expect(cleanup).toHaveBeenCalledWith(f.key);
  });

  it('does not invent an epoch or execute cleanup when Begin never validated one', () => {
    const f = fixture(); const cleanup = vi.fn();
    f.collector.abortStagedStep(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(() => f.collector.beginStep(25)).toThrow();
  });

  it('rejects reused epochs across a completed staged transaction and the next native export', () => {
    const f = fixture(); f.begin(); f.prepare(); f.project(); f.commit(); f.info();
    f.collector.consumeReceipt(f.receive());
    const token = f.collector.beginStep(26);
    expect(() => f.collector.invoke('bhStep', [26, 0, 0, undefined, token], () =>
      (f.target.boxheadDigestOriginalState as Digest)({ tick: 26, scope: 'frame', entities: [] },
        { version: 1, token, epoch: 1, tick: 26, scope: 'frame' }))).toThrow();
  });
});
