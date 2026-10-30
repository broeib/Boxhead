// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTROLS, OriginalInput, describeControls, renderControls } from '../../apps/original-web/src/input';
import type { NativeControls } from '../../apps/original-web/src/menu';

let input: OriginalInput | undefined;
afterEach(() => { input?.destroy(); input = undefined; document.body.replaceChildren(); });

function fixture(slot: 1 | 2, controls?: NativeControls) {
  const stage = document.createElement('div'); stage.tabIndex = 0; document.body.append(stage); stage.focus();
  const send = vi.fn(); input = new OriginalInput(stage, send, controls);
  input.setSlot(slot); input.setEnabled(true); send.mockClear();
  const key = (type: string, code: string, keyCode = 0) => stage.dispatchEvent(new KeyboardEvent(type, { keyCode, code, bubbles: true, composed: true }));
  return { stage, send, key };
}

describe('personal online preset independent of local slot and offline Controls', () => {
  it.each([1, 2] as const)('defaults to WASD/Space/QE for slot %s without inheriting offline P1/P2', (slot) => {
    const controls = { p1: [73, 75, 74, 76, 90, 88, 67], p2: [38, 40, 37, 39, 191, 190, 188] };
    const original = JSON.parse(JSON.stringify(controls));
    const f = fixture(slot, controls);
    f.key('keydown', 'KeyL'); f.key('keydown', 'KeyZ'); f.key('keydown', 'Slash');
    expect(f.send).not.toHaveBeenCalled();
    f.key('keydown', 'KeyD'); f.key('keydown', 'Space');
    expect(f.send).toHaveBeenLastCalledWith(24);
    f.key('keyup', 'Space'); expect(f.send).toHaveBeenLastCalledWith(8);
    f.key('keyup', 'KeyD');
    f.key('keydown', 'KeyQ'); expect(f.send).toHaveBeenLastCalledWith(64);
    f.key('keyup', 'KeyQ'); expect(f.send).toHaveBeenLastCalledWith(0);
    f.key('keydown', 'KeyE'); expect(f.send).toHaveBeenLastCalledWith(32);
    f.key('keyup', 'KeyE'); expect(f.send).toHaveBeenLastCalledWith(0);
    window.dispatchEvent(new Event('blur'));
    expect(f.send).toHaveBeenLastCalledWith(0, true);
    expect(controls).toEqual(original);
    expect(DEFAULT_CONTROLS.p1).toEqual([38, 40, 37, 39, 191, 190, 188]);
    expect(DEFAULT_CONTROLS.p2).toEqual([87, 83, 65, 68, 32, 69, 81]);
    expect(describeControls(slot, controls)).toContain(`Player ${slot}: W / S / A / D`);
  });

  it.each([1, 2] as const)('uses only the personal online selection for assigned slot %s', (slot) => {
    const controls: NativeControls = { p1: [...DEFAULT_CONTROLS.p1], p2: [...DEFAULT_CONTROLS.p2],
      online: { character: 3, bindings: [73, 75, 74, 76, 90, 88, 67] } };
    const f = fixture(slot, controls);
    f.key('keydown', 'KeyW'); f.key('keydown', 'Space'); f.key('keydown', 'KeyE');
    expect(f.send).not.toHaveBeenCalled();
    for (const [code, bit] of [['KeyI', 1], ['KeyK', 2], ['KeyJ', 4], ['KeyL', 8], ['KeyZ', 16], ['KeyX', 32], ['KeyC', 64]] as const) {
      f.key('keydown', code); expect(f.send).toHaveBeenLastCalledWith(bit);
      f.key('keyup', code); expect(f.send).toHaveBeenLastCalledWith(0);
    }
    f.key('keydown', 'Digit2'); expect(f.send).toHaveBeenLastCalledWith(256);
    f.key('keyup', 'Digit2'); expect(f.send).toHaveBeenLastCalledWith(0);
    expect(describeControls(slot, controls)).toContain('I / K / J / L');
    expect(describeControls(slot, controls)).toContain('Z — fire');
    expect(describeControls(slot, controls)).toContain('C — previous weapon; X — next weapon');
  });

  it('takes a private binding snapshot rather than observing later preference mutations', () => {
    const controls = { p1: [...DEFAULT_CONTROLS.p1], p2: [...DEFAULT_CONTROLS.p2],
      online: { character: 0, bindings: [73, 75, 74, 76, 90, 88, 67] } };
    const f = fixture(2, controls);
    controls.online.bindings[0] = 87;
    f.key('keydown', 'KeyI'); expect(f.send).toHaveBeenLastCalledWith(1);
    f.key('keyup', 'KeyI'); f.send.mockClear();
    f.key('keydown', 'KeyW'); expect(f.send).not.toHaveBeenCalled();
  });

  it('normalizes custom arrows and punctuation by physical code on another layout', () => {
    const f = fixture(2, { p1: [...DEFAULT_CONTROLS.p1], p2: [...DEFAULT_CONTROLS.p2],
      online: { character: 1, bindings: [38, 40, 37, 39, 191, 190, 188] } });
    f.key('keydown', 'ArrowUp', 67); expect(f.send).toHaveBeenLastCalledWith(1);
    f.key('keyup', 'ArrowUp', 67); expect(f.send).toHaveBeenLastCalledWith(0);
    f.key('keydown', 'Slash', 190); expect(f.send).toHaveBeenLastCalledWith(16);
    f.key('keyup', 'Slash', 190); expect(f.send).toHaveBeenLastCalledWith(0);
    f.key('keydown', 'Comma', 191); expect(f.send).toHaveBeenLastCalledWith(64);
    f.key('keyup', 'Comma', 191); expect(f.send).toHaveBeenLastCalledWith(0);
  });

  it('uses physical code rather than a layout-specific legacy keyCode with defaults', () => {
    const f = fixture(2);
    f.key('keydown', 'KeyW', 67); expect(f.send).toHaveBeenLastCalledWith(1);
    f.key('keyup', 'KeyW', 67); expect(f.send).toHaveBeenLastCalledWith(0);
  });
});


it('renders readable control groups using the player’s actual custom bindings', () => {
  const container = document.createElement('div');
  const controls: NativeControls = { p1: [...DEFAULT_CONTROLS.p1], p2: [...DEFAULT_CONTROLS.p2],
    online: { character: 0, bindings: [73, 75, 74, 76, 90, 88, 67] } };
  renderControls(container, 2, controls);
  expect(container.querySelector('.controls-title')?.textContent).toBe('Player 2 controls');
  const groups = [...container.querySelectorAll('.control-groups > div')];
  expect(groups.map(group => [group.querySelector('dt')?.textContent,
    [...group.querySelectorAll('kbd')].map(key => key.textContent)])).toEqual([
    ['Move', ['I', 'J', 'K', 'L']], ['Fire', ['Z']], ['Previous weapon', ['C']],
    ['Next weapon', ['X']], ['Select weapon', ['1–0']],
  ]);
  renderControls(container, 1);
  expect(container.querySelectorAll('.controls-title')).toHaveLength(1);
  expect(container.textContent).toContain('Space');
});
