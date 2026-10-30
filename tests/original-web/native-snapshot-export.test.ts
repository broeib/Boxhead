import { describe, expect, it } from 'vitest';
import { digestOriginalState } from '../../apps/original-web/src/native-digest';
import { installSnapshotDigestHelpers, NativeSnapshotExports } from '../../apps/original-web/src/native-snapshot-export';

type ObjectValue = Record<string, unknown>;
type DigestCall = (native: unknown, request?: unknown) => { digest: string; bytes: number; receipt?: ObjectValue };
const graph = (tick: number) => ({ tick, scope: tick % 25 === 0 ? 'full' : 'frame', entities: [{ id: 1, x: -0, flags: 2 }], rng: { seed: 7, calls: tick } });
function owner(target: ObjectValue = {}, prefix = 'owner') {
  return { target, collector: new NativeSnapshotExports(target, prefix), digest: () => target.boxheadDigestOriginalState as DigestCall };
}
function captured(tick = 1, epoch = 1, existing = owner()) {
  const { target, collector, digest } = existing;
  const token = collector.beginStep(tick);
  const native = graph(tick);
  const key = { version: 1, token, epoch, tick, scope: native.scope };
  let result!: ReturnType<DigestCall>;
  collector.invoke('bhStep', [tick, 0, 0, undefined, token], () => { result = digest()(native, key); });
  const header: ObjectValue = { version: 1, engine: 'original-swf', state: 'playing', tick, scope: native.scope,
    digestSchema: 'native-projection-v3', digest: result.digest, snapshotBytes: result.bytes,
    players: [{ slot: 1, id: 1 }], rng: { seed: 7, calls: tick }, snapshotObjects: 0, snapshotFields: 0,
    profile: { projectMs: 4, encodeMs: 0, hashMs: 2 }, futureField: { value: -0 } };
  const receipt: ObjectValue = { ...key, header };
  return { ...existing, target, collector, native, key, result, header, receipt };
}
function nativeReceipt(f: ReturnType<typeof captured>): unknown {
  return f.collector.invoke('bhStateReceipt', [f.key.token, f.key.epoch, f.key.tick], () => f.receipt);
}

describe('one-transfer native snapshot collector', () => {
  it.each([1, 25])('binds the actual graph and all final native headers at tick %i', tick => {
    const f = captured(tick);
    expect(f.result).toEqual({ ...digestOriginalState(f.native), receipt: f.key });
    expect(f.collector.receiptRequest()).toEqual({ token: f.key.token, epoch: 1, tick });
    f.collector.invoke('bhInfo', [], () => ({ tick }));
    const actual = f.collector.invoke('bhStateReceipt', [f.key.token, 1, tick], () => f.receipt);
    const state = f.collector.consumeReceipt(actual);
    expect(state.native).toBe(f.native);
    expect(state.players).toBe(f.header.players);
    expect(state.profile).toBe(f.header.profile);
    expect(Object.is((state.futureField as ObjectValue).value, -0)).toBe(true);
    expect(Object.hasOwn(state, 'entities')).toBe(false);
    expect(() => f.collector.consumeReceipt(actual)).toThrow();
  });

  it('retains the old one-argument canonical helper contract', () => {
    const f = owner();
    expect(f.digest()(graph(1))).toEqual(digestOriginalState(graph(1)));
    expect(f.collector.invoke('bhInfo', [], () => 42)).toBe(42);
  });

  it('permits ordinary availability retries before a callback is registered', () => {
    const f = owner();
    expect(() => f.collector.invoke('bhInfo', [], () => { throw new Error('not registered'); })).toThrow('not registered');
    expect(f.collector.invoke('bhInfo', [], () => ({ state: 'menu' }))).toEqual({ state: 'menu' });
  });

  it('does not replace a passive wrapper or reset another live owner on repeated install', () => {
    const f = captured();
    const original = f.target.boxheadDigestOriginalState as DigestCall;
    let calls = 0;
    const wrapper: DigestCall = (...args) => { calls++; return original(...args); };
    f.target.boxheadDigestOriginalState = wrapper;
    installSnapshotDigestHelpers(f.target);
    const second = owner(f.target, 'second');
    expect(f.target.boxheadDigestOriginalState).toBe(wrapper);
    expect(f.collector.consumeReceipt(nativeReceipt(f)).native).toBe(f.native);
    const other = captured(2, 1, second);
    expect(other.collector.consumeReceipt(nativeReceipt(other)).native).toBe(other.native);
    expect(calls).toBe(1);
  });

  it('rejects the next Step while the previous native receipt is unconsumed', () => {
    const f = captured();
    expect(() => f.collector.beginStep(2)).toThrow();
    expect(() => f.collector.consumeReceipt(f.receipt)).toThrow();
  });

  it.each(['missing', 'duplicate', 'legacy-only'])('rejects %s capture without substituting a legacy read', mode => {
    const f = owner(); const tick = 1; const token = f.collector.beginStep(tick);
    const key = { version: 1, token, epoch: 1, tick, scope: 'frame' };
    expect(() => f.collector.invoke('bhStep', [tick, 0, 0, undefined, token], () => {
      if (mode === 'missing') return;
      if (mode === 'legacy-only') { try { f.digest()(graph(tick)); } catch {} return; }
      f.digest()(graph(tick), key);
      try { f.digest()(graph(tick), key); } catch {}
    })).toThrow();
    expect(() => f.collector.receiptRequest()).toThrow();
  });

  it.each([
    { token: 'foreign' }, { epoch: 0 }, { epoch: 0x80000000 }, { tick: 2 }, { scope: 'full' }, { version: 2 }, { extra: true },
  ])('rejects a mismatched native callback key %j', change => {
    const f = owner(); const token = f.collector.beginStep(1);
    const key = { version: 1, token, epoch: 1, tick: 1, scope: 'frame', ...change };
    expect(() => f.collector.invoke('bhStep', [1, 0, 0, undefined, token], () => f.digest()(graph(1), key))).toThrow();
  });

  it('rejects a callback from another window/installation and a callback outside Step', () => {
    const first = owner(); const second = owner(); const token = first.collector.beginStep(1);
    const key = { version: 1, token, epoch: 1, tick: 1, scope: 'frame' };
    expect(() => first.collector.invoke('bhStep', [1, 0, 0, undefined, token], () => second.digest()(graph(1), key))).toThrow();
    expect(() => second.digest()(graph(1), key)).toThrow();
  });

  it.each(['same-owner', 'other-owner', 'install', 'dispose'])('keeps outer poison sticky after caught %s reentry', mode => {
    const f = owner(); const other = owner(f.target, 'other'); const token = f.collector.beginStep(1);
    const key = { version: 1, token, epoch: 1, tick: 1, scope: 'frame' };
    expect(() => f.collector.invoke('bhStep', [1, 0, 0, undefined, token], () => {
      try {
        if (mode === 'same-owner') f.collector.invoke('bhInfo', [], () => 0);
        if (mode === 'other-owner') other.collector.invoke('bhInfo', [], () => 0);
        if (mode === 'install') installSnapshotDigestHelpers(f.target);
        if (mode === 'dispose') f.collector.dispose();
      } catch {}
      try { return f.digest()(graph(1), key); } catch { return { digest: 'pretend-success' }; }
    })).toThrow();
    expect(() => f.collector.receiptRequest()).toThrow();
  });

  it('rejects a foreign graph accessor before it can perform reentry during hashing', () => {
    const f = owner(); const other = owner(f.target, 'other'); const token = f.collector.beginStep(1);
    let called = 0;
    const native = { ...graph(1), get foreign() { called++; try { other.collector.invoke('bhInfo', [], () => 0); } catch {} return 7; } };
    const key = { version: 1, token, epoch: 1, tick: 1, scope: 'frame' };
    expect(() => f.collector.invoke('bhStep', [1, 0, 0, undefined, token], () => f.digest()(native, key))).toThrow();
    expect(called).toBe(0);
  });

  it('rejects a stale epoch even with a fresh token and next native tick', () => {
    const f = captured(); f.collector.consumeReceipt(nativeReceipt(f));
    expect(() => captured(2, 1, f)).toThrow();
  });

  it.each(['token', 'epoch', 'tick', 'scope', 'digest', 'bytes', 'native-alias', 'entities-alias', 'error', 'missing-header',
    'missing-profile', 'missing-objects', 'missing-fields', 'undefined-profile', 'extra'])
    ('rejects malformed supported receipt: %s', kind => {
      const f = captured();
      if (kind === 'token') f.receipt.token = 'foreign';
      if (kind === 'epoch') f.receipt.epoch = 2;
      if (kind === 'tick') f.receipt.tick = 2;
      if (kind === 'scope') f.receipt.scope = 'full';
      if (kind === 'digest') f.header.digest = 'native-v2-forged';
      if (kind === 'bytes') f.header.snapshotBytes = (f.result.bytes + 1);
      if (kind === 'native-alias') f.header.native = f.native;
      if (kind === 'entities-alias') f.header.entities = f.native.entities;
      if (kind === 'error') f.header.error = 'failure';
      if (kind === 'missing-header') delete f.receipt.header;
      if (kind === 'missing-profile') delete f.header.profile;
      if (kind === 'missing-objects') delete f.header.snapshotObjects;
      if (kind === 'missing-fields') delete f.header.snapshotFields;
      if (kind === 'undefined-profile') f.header.profile = undefined;
      if (kind === 'extra') f.receipt.extra = true;
      const actual = nativeReceipt(f);
      expect(() => f.collector.consumeReceipt(actual)).toThrow();
      expect(() => f.collector.beginStep(2)).toThrow();
    });

  it('rejects an altered native reply instead of accepting a matching token alone', () => {
    const f = owner(); const original = f.digest();
    f.target.boxheadDigestOriginalState = ((...args) => ({ ...original(...args), digest: 'native-v2-altered' })) as DigestCall;
    const actual = captured(1, 1, f);
    const receipt = nativeReceipt(actual);
    expect(() => actual.collector.consumeReceipt(receipt)).toThrow();
  });

  it('requires an actual native receipt invocation and the exact object it returned', () => {
    const missing = captured();
    expect(() => missing.collector.consumeReceipt(missing.receipt)).toThrow();
    const replaced = captured(); nativeReceipt(replaced);
    expect(() => replaced.collector.consumeReceipt({ ...replaced.receipt })).toThrow();
  });

  it('prevents a passive wrapper from changing a non-header scalar after the canonical export', () => {
    const f = owner(); const original = f.digest();
    let blocked = false;
    f.target.boxheadDigestOriginalState = ((native, key) => {
      const result = original(native, key);
      try { ((native as ReturnType<typeof graph>).entities[0]).flags = 999; } catch { blocked = true; }
      return result;
    }) as DigestCall;
    const actual = captured(1, 1, f);
    const state = actual.collector.consumeReceipt(nativeReceipt(actual));
    expect(blocked).toBe(true);
    expect((state.native as ReturnType<typeof graph>).entities[0].flags).toBe(2);
    expect(Object.isFrozen((state.native as ReturnType<typeof graph>).entities[0])).toBe(true);
    expect(Object.isFrozen((state.native as ReturnType<typeof graph>).entities)).toBe(true);
  });

  it('does not retain cancelled or disposed snapshots', () => {
    const cancelled = captured(); cancelled.collector.cancel();
    expect(() => cancelled.collector.consumeReceipt(cancelled.receipt)).toThrow();
    const disposed = captured(); disposed.collector.dispose();
    expect(() => disposed.collector.consumeReceipt(disposed.receipt)).toThrow();
    expect(() => disposed.collector.beginStep(2)).toThrow();
  });
});
