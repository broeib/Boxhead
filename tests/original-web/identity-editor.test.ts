// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { mountPlayerIdentity } from '../../apps/original-web/src/player-identity';

describe('nickname editor', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><div id="stage-shell"><div id="stage" tabindex="0"></div></div></main>';
    localStorage.clear();
  });
  it('stays inside the game, saves valid names and locks while connected', () => {
    const identity = mountPlayerIdentity();
    const form = document.querySelector<HTMLFormElement>('#player-profile')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    expect(form.hidden).toBe(true);
    expect(form.parentElement?.id).toBe('stage-shell');
    identity.edit();
    expect(form.hidden).toBe(false);
    input.value = '  Alice  2 ';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(identity.message()?.name).toBe('Alice 2');
    expect(form.hidden).toBe(true);
    identity.setConnected(true);
    identity.edit();
    expect(form.hidden).toBe(true);
  });
});
