// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkStatusMessage } from '../../apps/original-web/src/protocol';

const mocks = vi.hoisted(() => ({ destroy: vi.fn(), setReplayMuted: vi.fn() }));
vi.mock('../../apps/original-web/src/ruffle', () => ({
  OriginalRuffleHost: class { destroy = mocks.destroy; setReplayMuted = mocks.setReplayMuted; },
  fetchOnlineSWF: () => new Promise(() => {}),
}));
vi.mock('../../apps/original-web/src/fullscreen', () => ({ mountFullscreen: vi.fn() }));
vi.mock('../../apps/original-web/src/player-identity', () => ({ mountPlayerIdentity: () => ({ setConnected: vi.fn() }) }));

// UI-only contract: the DOM cover must never replace or inspect the VM world.
const html = readFileSync('apps/original-web/index.html', 'utf8');
let OriginalApp: typeof import('../../apps/original-web/src/main').OriginalApp;
type UI = {
  session: { phase: string };
  input: { setEnabled: ReturnType<typeof vi.fn> };
  networkStatus(message: NetworkStatusMessage | null): void;
};
const waiting: NetworkStatusMessage = { type: 'network_status', state: 'waiting', tick: 12, timeoutMs: 30_000, slots: [2] };

beforeAll(async () => {
  document.documentElement.innerHTML = html;
  ({ OriginalApp } = await import('../../apps/original-web/src/main'));
});
beforeEach(() => { document.documentElement.innerHTML = html; vi.clearAllMocks(); });

function fixture(phase = 'running') {
  const app = new OriginalApp();
  const ui = app as unknown as UI;
  ui.session = { phase };
  ui.input = { setEnabled: vi.fn() };
  const world = document.createElement('canvas'); world.id = 'original-ruffle-player';
  const stage = document.getElementById('stage')!;
  stage.append(world);
  return { ui, world, stage, cover: document.getElementById('join-sync')!, status: document.getElementById('status')! };
}

describe('network waiting cover', () => {
  it('shows human English text above the same world and unlocks only on resume', () => {
    const f = fixture(); f.ui.networkStatus(waiting);
    expect(f.cover.hidden).toBe(false); expect(f.cover.dataset.kind).toBe('network');
    expect(f.cover.textContent).toContain('Waiting for Player 2 to reconnect.');
    expect(f.cover.textContent).not.toMatch(/tick|digest|ACK|timeoutMs/);
    expect(f.stage.dataset.networkPaused).toBe('true');
    expect(f.ui.input.setEnabled).toHaveBeenLastCalledWith(false);
    expect(f.stage.firstElementChild).toBe(f.world); expect(mocks.destroy).not.toHaveBeenCalled();
    f.ui.networkStatus({ type: 'network_status', state: 'resumed', tick: 14 });
    expect(f.cover.hidden).toBe(true); expect(f.stage.dataset.networkPaused).toBeUndefined();
    expect(f.ui.input.setEnabled).toHaveBeenLastCalledWith(true);
    expect(f.status.textContent).toBe('Connection restored. Your game continues.');
    expect(f.stage.firstElementChild).toBe(f.world); expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it('preserves the first-frame loading cover after a ready-phase resume', () => {
    const f = fixture('ready'); f.stage.dataset.networkPreparation = 'true';
    f.ui.networkStatus({ ...waiting, tick: 0 });
    f.ui.networkStatus({ type: 'network_status', state: 'resumed', tick: 0 });
    expect(f.cover.hidden).toBe(false); expect(f.cover.dataset.kind).toBe('start');
    expect(f.stage.dataset.networkPreparation).toBe('true');
    expect(f.ui.input.setEnabled).toHaveBeenLastCalledWith(false);
    expect(f.stage.firstElementChild).toBe(f.world); expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it('keeps controls disabled while completing and clears the cover on closure', () => {
    const f = fixture('completing'); f.ui.networkStatus({ ...waiting, slots: [1, 2] });
    expect(f.cover.textContent).toContain('Waiting for both players to reconnect.');
    f.ui.networkStatus({ type: 'network_status', state: 'resumed', tick: 12 });
    expect(f.ui.input.setEnabled).toHaveBeenLastCalledWith(false);
    expect(f.status.textContent).toBe('Round finished. Waiting for the result…');
    f.ui.networkStatus(waiting); f.ui.networkStatus(null);
    expect(f.cover.hidden).toBe(true); expect(f.stage.dataset.networkPaused).toBeUndefined();
    expect(f.stage.firstElementChild).toBe(f.world); expect(mocks.destroy).not.toHaveBeenCalled();
  });
});
