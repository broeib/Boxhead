export interface PlayerIdentity { id: string; name: string }

const STORAGE_KEY = 'boxhead.online.identity.v1';
const PLAYER_ID = /^bh_[a-f0-9]{32}$/;
const PLAYER_NAME = /^[\p{L}\p{N} _.-]{1,32}$/u;
let pageIdentity: PlayerIdentity | null = null;

export function normalizePlayerName(value: string): string | null {
  const name = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  return PLAYER_NAME.test(name) ? name : null;
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function save(identity: PlayerIdentity, target: Pick<Storage, 'setItem'> | null): void {
  try { target?.setItem(STORAGE_KEY, JSON.stringify(identity)); } catch { /* private browser / full storage */ }
}

/** A private browser label, unrelated to invitation tokens or authentication. */
export function loadPlayerIdentity(target: Pick<Storage, 'getItem' | 'setItem'> | null = storage(),
  random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): PlayerIdentity {
  try {
    const saved: unknown = JSON.parse(target?.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const value = saved as Record<string, unknown>;
      if (typeof value.id === 'string' && PLAYER_ID.test(value.id)
        && typeof value.name === 'string' && normalizePlayerName(value.name) === value.name) {
        return { id: value.id, name: value.name };
      }
    }
  } catch { /* malformed or unavailable local storage */ }
  const bytes = random(new Uint8Array(16));
  const id = `bh_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
  const identity = { id, name: `Player-${id.slice(-8)}` };
  save(identity, target);
  return identity;
}

/**
 * Edit the browser nickname inside the original My Character screen.
 */
export function mountPlayerIdentity(): {
  message(): { type: 'identify'; id: string; name: string } | null;
  setConnected(connected: boolean): void;
  edit(): void;
} {
  try { pageIdentity ??= loadPlayerIdentity(); } catch { /* no crypto: server uses an anonymous connection id */ }
  const holder = document.createElement('form');
  holder.id = 'player-profile';
  holder.hidden = true;
  const label = document.createElement('label');
  label.htmlFor = 'player-name';
  label.textContent = 'Online name';
  const input = document.createElement('input');
  input.id = 'player-name';
  input.type = 'text';
  input.maxLength = 32;
  input.size = 20;
  input.setAttribute('autocomplete', 'nickname');
  input.spellcheck = false;
  input.value = pageIdentity?.name ?? '';
  input.placeholder = 'Guest';
  input.disabled = pageIdentity === null;
  input.title = 'Name shown in the player list. Up to 32 characters: letters, numbers, spaces, _ . -';
  label.append(input);
  holder.append(label);
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.textContent = 'Save';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  holder.append(saveButton, cancelButton);
  document.getElementById('stage-shell')?.append(holder);
  const close = () => { holder.hidden = true; document.getElementById('stage')?.focus(); };
  cancelButton.addEventListener('click', close);
  holder.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  holder.addEventListener('keyup', event => event.stopPropagation());
  input.addEventListener('input', () => {
    input.setCustomValidity(normalizePlayerName(input.value) === null
      ? 'Use 1–32 characters: letters, numbers, spaces, _ . -' : '');
  });
  holder.addEventListener('submit', event => {
    event.preventDefault();
    if (!pageIdentity || input.disabled) return;
    const name = normalizePlayerName(input.value);
    if (name === null) { input.reportValidity(); return; }
    pageIdentity = { ...pageIdentity, name };
    input.value = name;
    save(pageIdentity, storage());
    close();
  });
  return {
    message: () => pageIdentity ? { type: 'identify', ...pageIdentity } : null,
    setConnected: connected => { input.disabled = connected || pageIdentity === null; if (connected) close(); },
    edit: () => { if (!pageIdentity || input.disabled) return; input.value = pageIdentity.name; holder.hidden = false; input.focus(); input.select(); },
  };
}
