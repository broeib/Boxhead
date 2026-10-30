import { describe, expect, it, vi } from 'vitest';
import { OriginalBridge, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { digestOriginalState } from '../../apps/original-web/src/native-digest';
import { NativeSnapshotExports } from '../../apps/original-web/src/native-snapshot-export';
import type { PrepareMessage } from '../../apps/original-web/src/protocol';

const player = { slot: 1, id: 1, x: 1, y: 0, z: 0, angle: 0, life: 200,
  flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 };
const prepare: PrepareMessage = { type: 'prepare', seed: 7, swfHash: 'a'.repeat(64), mode: 'Coop',
  map: 'ROOM_Single_0001', characters: [0, 1], initialPlayers: 1, personalProgression: true, replay: true };
type Value = Record<string, unknown>;
type Digest = (native: unknown, key?: unknown) => { digest: string; bytes: number; receipt?: Value };

/** Contract stubs test client failure boundaries; they are not AVM1 evidence. */
function fixture(...capabilities: unknown[]) {
  const capability = capabilities.length === 0 ? 1 : capabilities[0];
  let tick = 0; let phase = 'menu'; let epoch = 0; let receipt: Value | undefined;
  let change: (point: string, value: Value) => Value = (_point, value) => value;
  const target: Value = {};
  const collector = new NativeSnapshotExports(target, 'bridge');
  function snapshot() {
    const scope = tick % 25 === 0 ? 'full' : 'frame';
    const rng = { seed: 7, state: 7, calls: tick };
    const native = change('native', { scope, tick, rng, entities: [{ id: 1, life: 200 }] });
    const digest = digestOriginalState(native);
    return { version: 1, engine: 'original-swf', state: phase, tick, digest: digest.digest,
      digestSchema: 'native-projection-v3', scope, players: [{ ...player }], rng, native,
      snapshotBytes: digest.bytes, snapshotObjects: 3, snapshotFields: 8,
      profile: { projectMs: 1, encodeMs: 0, hashMs: 1 } };
  }
  const raw = vi.fn<NativeInvoke>((name, ...args) => {
    if (name === 'bhInfo') return change('info', { version: 1, engine: 'original-swf', state: phase, tick,
      canPrepare: phase === 'menu', ...(capability !== undefined ? { snapshotReceiptVersion: capability } : {}) });
    if (name === 'bhPrepare') { phase = 'ready'; return { state: phase, tick: 0 }; }
    if (name === 'bhState') return snapshot();
    if (name === 'bhStep') {
      tick = args[0] as number; phase = 'playing';
      const state = snapshot();
      if (args[4] !== undefined) {
        const key = { version: 1, token: args[4], epoch: ++epoch, tick, scope: state.scope };
        const reply = (target.boxheadDigestOriginalState as Digest)(state.native, key);
        const { native: _native, ...header } = state;
        receipt = { ...key, header: change('header', { ...header, digest: reply.digest, snapshotBytes: reply.bytes }) };
      }
      return change('step', { tick, digest: state.digest, players: state.players });
    }
    if (name === 'bhStateReceipt') {
      const current = receipt; receipt = undefined;
      return current && change('receipt', current);
    }
    return undefined;
  });
  const invoke: NativeInvoke = (name, ...args) => collector.invoke(name, args, () => raw(name, ...args));
  return { bridge: new OriginalBridge(invoke, collector), raw, target, collector,
    change: (fn: typeof change) => { change = fn; } };
}

describe('OriginalBridge snapshot receipts', () => {
  it('keeps tick zero legacy and uses one native receipt for every supported step including full25', async () => {
    const f = fixture(); await f.bridge.prepare(prepare, undefined, 2);
    expect(f.raw.mock.calls.filter(call => call[0] === 'bhState')).toEqual([['bhState', false, false, true]]);
    f.raw.mockClear();
    for (let tick = 1; tick <= 26; tick++) expect(f.bridge.step(tick, 17, 0).tick).toBe(tick);
    expect(f.raw.mock.calls).toHaveLength(78);
    for (let offset = 0; offset < f.raw.mock.calls.length; offset += 3) {
      const tick = offset / 3 + 1;
      const [step, info, receipt] = f.raw.mock.calls.slice(offset, offset + 3);
      expect(step.slice(0, 5)).toEqual(['bhStep', tick, 17, 0, undefined]);
      expect(typeof step[5]).toBe('string');
      expect(info).toEqual(['bhInfo']);
      expect(receipt).toEqual(['bhStateReceipt', step[5], tick, tick]);
    }
  });

  it('retains the exact old argument list and actual bhState when capability is absent', async () => {
    const f = fixture(undefined); await f.bridge.prepare(prepare, undefined, 2); f.raw.mockClear();
    f.bridge.step(1, 17, 0);
    expect(f.raw.mock.calls).toEqual([['bhStep', 1, 17, 0], ['bhInfo'], ['bhState', false, false, true]]);
  });

  it('rejects an invalid advertised capability before the first gameplay step', async () => {
    const f = fixture(2);
    await expect(f.bridge.prepare(prepare, undefined, 2)).rejects.toThrow();
    expect(f.raw.mock.calls.some(call => call[0] === 'bhStep')).toBe(false);
  });

  it('does not silently choose legacy when the VM advertises receipts but its JS collector is absent', async () => {
    const f = fixture();
    const missingCollector = new OriginalBridge(f.raw);
    await expect(missingCollector.prepare(prepare, undefined, 2)).rejects.toThrow('controller');
    expect(f.raw.mock.calls.some(call => call[0] === 'bhStep')).toBe(false);
  });

  it.each(['step', 'info', 'receipt', 'header', 'players', 'unsafe-native'])
    ('fails closed after a malformed supported %s with no legacy retry or subsequent Step', async kind => {
      const f = fixture(); await f.bridge.prepare(prepare, undefined, 2); f.raw.mockClear();
      f.change((point, value) => {
        if (kind === 'step' && point === 'step') return { ...value, tick: 2 };
        if (kind === 'info' && point === 'info') return { ...value, tick: 2 };
        if (kind === 'receipt' && point === 'receipt') return { ...value, token: 'foreign' };
        if (kind === 'header' && point === 'header') return { ...value, digest: 'foreign' };
        if (kind === 'players' && point === 'header') return { ...value, players: [{ ...player, slot: 2 }] };
        if (kind === 'unsafe-native' && point === 'native') return { ...value, entities: [{ constructor: {} }] };
        return value;
      });
      expect(() => f.bridge.step(1, 17, 0)).toThrow();
      expect(f.raw.mock.calls.some(call => call[0] === 'bhState')).toBe(false);
      const count = f.raw.mock.calls.length;
      expect(() => f.bridge.step(2, 17, 0)).toThrow();
      expect(f.raw.mock.calls).toHaveLength(count);
      expect(() => f.collector.receiptRequest()).toThrow();
    });

  it('accepts a real terminal result with an empty final native roster', async () => {
    const f = fixture(); await f.bridge.prepare(prepare, undefined, 2);
    f.change((point, value) => point === 'step' ? { ...value, players: [], complete: 'playerdead' }
      : point === 'header' ? { ...value, players: [] } : value);
    expect(f.bridge.step(1, 0, 0).complete).toBe('playerdead');
  });
});
