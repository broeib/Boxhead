import type { Slot } from './protocol';
import { readOnlineProfile, type NativeControls } from './menu';

/** Default personal online preset. A network slot routes actions, never key preferences. */
export const ONLINE_KEYS: Readonly<Record<string, number>> = {
  KeyW: 1, KeyS: 2, KeyA: 4, KeyD: 8, Space: 16, KeyE: 32, KeyQ: 64,
};
export const ONLINE_BINDINGS: readonly number[] = [87, 83, 65, 68, 32, 69, 81];

const NUMBER_WEAPON_KEYS: Readonly<Record<string, number>> = {
  Digit1: 128, Digit2: 256, Digit3: 512, Digit4: 1024, Digit5: 2048,
  Digit6: 4096, Digit7: 8192, Digit8: 16384, Digit9: 32768, Digit0: 65536,
};

export function maskForCodes(_slot: Slot, codes: Iterable<string>): number {
  let mask = 0;
  for (const code of codes) mask |= (ONLINE_KEYS[code] ?? 0) | (NUMBER_WEAPON_KEYS[code] ?? 0);
  return mask;
}

// Reference defaults for the original local Controls dialog; never overwritten.
export const DEFAULT_CONTROLS: Readonly<NativeControls> = {
  p1: [38, 40, 37, 39, 191, 190, 188],
  p2: [87, 83, 65, 68, 32, 69, 81],
};

export function maskForKeyCodes(bindings: readonly number[], held: ReadonlySet<number>): number {
  let mask = bindings.reduce((value, key, index) => value | (key !== 0 && held.has(key) ? 1 << index : 0), 0);
  // Original messages advertise 1..0. Each online client selects only its own
  // player's weapon; the native game still checks unlocks and ammunition.
  for (let digit = 0; digit <= 9; digit++) {
    if (held.has(48 + digit)) mask |= 1 << (digit === 0 ? 16 : digit + 6);
  }
  return mask;
}

const PHYSICAL_KEY_CODES: Readonly<Record<string, number>> = {
  Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backslash: 220,
};

function eventKeyCode(event: KeyboardEvent): number {
  // Preserve the physical choice on non-Latin layouts, including punctuation,
  // arrows and numpad bindings exposed by the native personal-controls panel.
  if (/^Key[A-Z]$/.test(event.code)) return event.code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(event.code)) return 96 + Number(event.code.slice(6));
  if (event.code) return PHYSICAL_KEY_CODES[event.code] ?? 0;
  return Number.isInteger(event.keyCode) && event.keyCode > 0 && event.keyCode <= 255 ? event.keyCode : 0;
}

function localBindings(controls?: NativeControls): number[] {
  return controls?.online ? readOnlineProfile(controls.online).bindings : [...ONLINE_BINDINGS];
}

function keyLabel(key: number): string {
  if (key >= 65 && key <= 90) return String.fromCharCode(key);
  if (key >= 96 && key <= 105) return 'Num ' + (key - 96);
  return ({ 32: 'Space', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
    37: '←', 38: '↑', 39: '→', 40: '↓', 45: 'Insert', 46: 'Delete',
    106: 'Num *', 107: 'Num +', 109: 'Num −', 110: 'Num .', 111: 'Num /',
    187: '=', 188: ',', 189: '−', 190: '.', 191: '/', 220: '\\' } as Record<number, string>)[key] ?? String(key);
}

export function describeControls(slot: Slot, controls?: NativeControls): string {
  const keys = localBindings(controls).map(keyLabel);
  return `Player ${slot}: ${keys.slice(0, 4).join(' / ')} — move; ${keys[4]} — fire; ${keys[6]} — previous weapon; ${keys[5]} — next weapon; 1–0 — select weapon.`;
}

/** Render the current player's actual bindings without HTML interpolation. */
export function renderControls(container: HTMLElement, slot: Slot, controls?: NativeControls): void {
  const keys = localBindings(controls).map(keyLabel);
  const title = document.createElement('p');
  title.className = 'controls-title';
  title.textContent = `Player ${slot} controls`;
  const list = document.createElement('dl');
  list.className = 'control-groups';
  const groups: [string, string[]][] = [
    ['Move', [keys[0], keys[2], keys[1], keys[3]]], ['Fire', [keys[4]]],
    ['Previous weapon', [keys[6]]], ['Next weapon', [keys[5]]], ['Select weapon', ['1–0']],
  ];
  for (const [label, bindings] of groups) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const definition = document.createElement('dd');
    for (const key of bindings) {
      const badge = document.createElement('kbd');
      badge.textContent = key;
      definition.append(badge);
    }
    group.append(term, definition);
    list.append(group);
  }
  container.replaceChildren(title, list);
}

/** Installed only in network mode. Local SWF receives untouched native keyboard events. */
export class OriginalInput {
  private readonly held = new Set<number>();
  private slot: Slot | null = null;
  private enabled = false;
  private destroyed = false;
  private lastMask = 0;
  private readonly bindings: readonly number[];

  constructor(private readonly stage: HTMLElement, private readonly send: (mask: number, clear?: boolean) => void,
    nativeControls?: NativeControls) {
    this.bindings = localBindings(nativeControls);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setSlot(slot: Slot): void {
    this.releaseAll();
    this.slot = slot;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.releaseAll();
    this.enabled = enabled;
  }

  releaseAll(): void {
    this.held.clear();
    this.lastMask = 0;
    if (!this.destroyed) this.send(0, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.releaseAll();
    this.destroyed = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onBlur = (): void => { this.releaseAll(); };
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.releaseAll();
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    // Prevent physical keyboard input from also driving Ruffle's native input path.
    // bhStep is the sole source of gameplay input in network mode.
    event.stopImmediatePropagation();
    const target = event.target;
    const editing = target instanceof Element && Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'));
    const focused = event.composedPath().includes(this.stage) ||
      document.activeElement === this.stage || this.stage.contains(document.activeElement);
    if (!editing && focused) event.preventDefault();
    const key = eventKeyCode(event);
    if (event.type === 'keyup') {
      if (this.held.delete(key)) this.publish();
      return;
    }
    if (!this.enabled || !this.slot || editing || !focused || event.isComposing) return;
    // Snapshot only this browser's personal online keys; never the peer slot's
    // saved offline bindings. Existing physical release/focus semantics remain.
    const bindings = this.bindings;
    if (key === 0 || (!bindings.includes(key) && (key < 48 || key > 57))) return;
    this.held.add(key);
    this.publish();
  };

  private publish(): void {
    const mask = this.slot ? maskForKeyCodes(this.bindings, this.held) : 0;
    if (mask === this.lastMask) return;
    this.lastMask = mask;
    this.send(mask);
  }
}

