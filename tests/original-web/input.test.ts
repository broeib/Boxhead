// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OriginalInput } from '../../apps/original-web/src/input';

let input: OriginalInput | undefined;

afterEach(() => {
  input?.destroy();
  input = undefined;
  document.body.replaceChildren();
});

function fixture(slot: 1 | 2) {
  const stage = document.createElement('div');
  stage.tabIndex = 0;
  document.body.append(stage);
  const send = vi.fn();
  input = new OriginalInput(stage, send);
  input.setSlot(slot);
  input.setEnabled(true);
  stage.focus();
  send.mockClear();
  const key = (type: 'keydown' | 'keyup', code: string) => {
    stage.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, composed: true }));
  };
  return { stage, send, key };
}

describe('network keyboard lifecycle', () => {
  it.each([1, 2] as const)('uses shared fixed WASD/Space for slot %s and clears on blur', (slot) => {
    const f = fixture(slot);
    for (const code of ['ArrowUp', 'ArrowRight', 'Slash', 'Period', 'Comma']) f.key('keydown', code);
    expect(f.send).not.toHaveBeenCalled();
    f.key('keydown', 'KeyW');
    f.key('keydown', 'Space');
    expect(f.send.mock.calls.map(([mask]) => mask)).toEqual([1, 17]);
    window.dispatchEvent(new Event('blur'));
    expect(f.send).toHaveBeenLastCalledWith(0, true);
    f.key('keydown', 'KeyD');
    expect(f.send).toHaveBeenLastCalledWith(8);
  });
  it.each([1, 2] as const)('preserves each movement and Q previous / E next press-release for slot %s', (slot) => {
    const f = fixture(slot);
    for (const [code, bit] of [['KeyW', 1], ['KeyS', 2], ['KeyA', 4], ['KeyD', 8], ['Space', 16], ['KeyQ', 64], ['KeyE', 32]] as const) {
      f.key('keydown', code);
      expect(f.send).toHaveBeenLastCalledWith(bit);
      const count = f.send.mock.calls.length;
      f.key('keydown', code);
      expect(f.send).toHaveBeenCalledTimes(count);
      f.key('keyup', code);
      expect(f.send).toHaveBeenLastCalledWith(0);
    }
  });
  it('blocks the native Ruffle keyboard path while online', () => {
    const f = fixture(1);
    const nativeListener = vi.fn();
    window.addEventListener('keydown', nativeListener);
    try {
      f.key('keydown', 'Space');
      expect(f.send).toHaveBeenLastCalledWith(16);
      expect(nativeListener).not.toHaveBeenCalled();
      input?.destroy();
      f.key('keydown', 'Space');
      expect(nativeListener).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('keydown', nativeListener); }
  });
  it('does not convert typing in the toolbar into game input', () => {
    const f = fixture(2);
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true }));
    expect(f.send).not.toHaveBeenCalled();
  });
  it('releases input and removes listeners on destruction', () => {
    const f = fixture(1);
    f.key('keydown', 'KeyD');
    input?.destroy();
    expect(f.send).toHaveBeenLastCalledWith(0, true);
    f.send.mockClear();
    f.key('keydown', 'Space');
    window.dispatchEvent(new Event('blur'));
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe('numeric weapon keys on separate clients', () => {
  it.each([1, 2] as const)('sends all ten number press/release masks for slot %s', (slot) => {
    const f = fixture(slot);
    for (const [code, bit] of [
      ['Digit1', 128], ['Digit2', 256], ['Digit3', 512], ['Digit4', 1024], ['Digit5', 2048],
      ['Digit6', 4096], ['Digit7', 8192], ['Digit8', 16384], ['Digit9', 32768], ['Digit0', 65536],
    ] as const) {
      f.key('keydown', code);
      expect(f.send).toHaveBeenLastCalledWith(bit);
      f.key('keyup', code);
      expect(f.send).toHaveBeenLastCalledWith(0);
    }
  });
  it('keeps movement held when a number is released and clears both on blur', () => {
    const f = fixture(2);
    f.key('keydown', 'KeyD'); f.key('keydown', 'Digit2');
    expect(f.send).toHaveBeenLastCalledWith(264);
    f.key('keyup', 'Digit2');
    expect(f.send).toHaveBeenLastCalledWith(8);
    f.key('keydown', 'Digit0');
    expect(f.send).toHaveBeenLastCalledWith(65544);
    window.dispatchEvent(new Event('blur'));
    expect(f.send).toHaveBeenLastCalledWith(0, true);
  });
});
