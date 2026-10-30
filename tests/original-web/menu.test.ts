import { describe, expect, it, vi } from 'vitest';
import { OriginalBridge, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { loadOriginalMenu } from '../../apps/original-web/src/launch';
import { readControls, readMenuEvent, readOnlineProfile, readRenderCheck } from '../../apps/original-web/src/menu';
import { DEFAULT_SETTINGS } from '../../apps/original-web/src/protocol';
import type { OriginalRenderer } from '../../apps/original-web/src/ruffle';

describe('native menu boundary (unit contract, not browser evidence)', () => {
  it('accepts configuration selected in the original screens without replacing it', () => {
    const event = { version: 1, seq: 4, event: 'create', payload: { name: 'Комната', mode: 'DeathMatch',
      map: 'ROOM_Single_0016', characters: [3, 2], settings: { ...DEFAULT_SETTINGS, speed: 0, gameAmount: 3 } } };
    expect(readMenuEvent(event)).toEqual(event);
    expect(readMenuEvent(null)).toBeNull();
  });
  it('rejects unknown actions, invalid room names and forged room ids', () => {
    for (const value of [
      { version: 1, seq: 0, event: 'list', payload: {} },
      { version: 1, seq: 1, event: 'eval', payload: {} },
      { version: 1, seq: 1, event: 'join', payload: { room: '../unsafe' } },
      { version: 1, seq: 1, event: 'create', payload: { name: ' room ', mode: 'Coop', map: 'ROOM_Single_0001', characters: [0, 1] } },
    ]) expect(() => readMenuEvent(value)).toThrow();
  });
  it('requires an actual matching pixel rather than a claimed supported flag', () => {
    expect(readRenderCheck({ supported: true, pixel: 0x24ba6c, expected: 0x24ba6c }).supported).toBe(true);
    expect(readRenderCheck({ supported: false, pixel: 0xff0000, expected: 0x24ba6c }).supported).toBe(false);
    expect(() => readRenderCheck({ supported: true, pixel: 0xff0000, expected: 0x24ba6c })).toThrow();
  });
  it('copies exactly seven original key codes for each local player', () => {
    const source = { p1: [73, 75, 74, 76, 90, 88, 67], p2: [87, 83, 65, 68, 32, 69, 81] };
    const result = readControls(source);
    expect(result).toEqual(source);
    source.p1[4] = 16;
    expect(result.p1[4]).toBe(90);
    expect(() => readControls({ ...source, p2: [1, 2] })).toThrow();
  });
  it('copies personal controls without treating either offline player as the local online player', () => {
    const online = { character: 2, bindings: [73, 75, 74, 76, 90, 88, 67] };
    const controls = readControls({ p1: [38, 40, 37, 39, 191, 190, 188], p2: [87, 83, 65, 68, 32, 69, 81], online });
    expect(controls.online).toEqual(online);
    online.bindings[0] = 87;
    expect(controls.online?.bindings[0]).toBe(73);
    for (const malformed of [
      { ...online, character: 4 }, { ...online, bindings: [1] },
      { ...online, bindings: [87, 87, 65, 68, 32, 69, 81] },
      { ...online, bindings: [87, 83, 65, 68, 50, 69, 81] },
    ]) expect(() => readOnlineProfile(malformed)).toThrow();
  });
  it("retains each joining browser's character and the host drop-in request without sending key preferences", () => {
    const create = { version: 1, seq: 5, event: 'create', payload: { name: 'My room', mode: 'Coop',
      map: 'ROOM_Single_0001', characters: [3, 0], character: 3, dropIn: true, settings: DEFAULT_SETTINGS,
      controls: [73, 75, 74, 76, 90, 88, 67] } };
    const parsed = readMenuEvent(create);
    expect(parsed?.payload).toMatchObject({ character: 3, characters: [3, 0], dropIn: true });
    expect(parsed?.payload).not.toHaveProperty('controls');
    expect(readMenuEvent({ version: 1, seq: 6, event: 'join', payload: { room: 'abcdefghijkl', character: 2 } }))
      .toEqual({ version: 1, seq: 6, event: 'join', payload: { room: 'abcdefghijkl', character: 2 } });
    expect(() => readMenuEvent({ ...create, payload: { ...create.payload, character: 1 } })).toThrow();
    expect(() => readMenuEvent({ version: 1, seq: 6, event: 'join', payload: { room: 'abcdefghijkl', character: 4 } })).toThrow();
  });
  it('requires native acknowledgement when changing the in-game menu', () => {
    const invoke = vi.fn<NativeInvoke>(() => ({ ok: false }));
    const bridge = new OriginalBridge(invoke);
    expect(() => bridge.menuUpdate({ state: 'closed', payload: {} })).toThrow();
    invoke.mockReturnValue({ ok: true });
    bridge.menuUpdate({ state: 'lobby', payload: { slot: 1, peerConnected: true } });
    expect(invoke).toHaveBeenLastCalledWith('bhMenuUpdate', 'lobby', { slot: 1, peerConnected: true });
  });
});

function launchFixture(results: boolean[]) {
  const invoke = vi.fn<NativeInvoke>((name) => {
    if (name === 'bhInfo') return { version: 1, menuVersion: 1, engine: 'original-swf', state: 'menu', tick: 0, canPrepare: true };
    if (name === 'bhRenderCheck') {
      const supported = results.shift() ?? false;
      return { supported, expected: 0x24ba6c, pixel: supported ? 0x24ba6c : 0xff0000 };
    }
    return null;
  });
  return { invoke, host: {
    load: vi.fn<(source: string | Uint8Array, signal: AbortSignal, renderer?: OriginalRenderer) => Promise<void>>(async () => undefined),
    bridge: () => new OriginalBridge(invoke), destroy: vi.fn(),
  } };
}

describe('bounded native renderer startup', () => {
  it('uses the first working real draw probe without a redundant second load', async () => {
    const f = launchFixture([true]);
    const result = await loadOriginalMenu(f.host, new Uint8Array(8), new AbortController().signal);
    expect(result.renderer).toBe('wgpu-webgl');
    expect(f.host.load).toHaveBeenCalledTimes(1);
  });
  it('tries WebGPU once after an unsupported first bitmap renderer', async () => {
    const f = launchFixture([false, true]);
    const result = await loadOriginalMenu(f.host, new Uint8Array(8), new AbortController().signal);
    expect(result.renderer).toBe('webgpu');
    expect(f.host.load.mock.calls.map((call) => call[2])).toEqual(['wgpu-webgl', 'webgpu']);
    expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it('stops before any world creation when both actual draw probes fail', async () => {
    const f = launchFixture([false, false]);
    await expect(loadOriginalMenu(f.host, new Uint8Array(8), new AbortController().signal)).rejects.toThrow('BitmapData.draw');
    expect(f.host.load).toHaveBeenCalledTimes(2);
    expect(f.invoke.mock.calls.some(([name]) => name === 'bhPrepare')).toBe(false);
  });
  it('also tries the second preference after a renderer initialization failure', async () => {
    const f = launchFixture([true]);
    f.host.load.mockRejectedValueOnce(new Error('GPU init failed'));
    expect((await loadOriginalMenu(f.host, new Uint8Array(8), new AbortController().signal)).renderer).toBe('webgpu');
  });
});
