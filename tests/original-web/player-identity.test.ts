import { describe, expect, it, vi } from 'vitest';
import { loadPlayerIdentity, normalizePlayerName } from '../../apps/original-web/src/player-identity';

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('browser identity for operator Analytics', () => {
  it('keeps a browser identity and chosen nickname across new sessions', () => {
    const storage = memoryStorage();
    const random = vi.fn((bytes: Uint8Array) => bytes.fill(31));
    const first = loadPlayerIdentity(storage, random);
    expect(first.id).toMatch(/^bh_[a-f0-9]{32}$/);
    const key = [...storage.values.keys()][0];
    storage.setItem(key, JSON.stringify({ ...first, name: 'Иван_2709' }));
    expect(loadPlayerIdentity(storage, random)).toEqual({ ...first, name: 'Иван_2709' });
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('recovers a corrupt profile and works with unavailable persistent storage', () => {
    const storage = memoryStorage();
    const first = loadPlayerIdentity(storage, bytes => bytes.fill(1));
    const key = [...storage.values.keys()][0];
    storage.setItem(key, JSON.stringify({ ...first, name: 'spoof\nBOXHEAD PLAYER_JOIN' }));
    const fresh = loadPlayerIdentity(storage, bytes => bytes.fill(2));
    expect(fresh.id).not.toEqual(first.id);
    expect(fresh.name).toMatch(/^Player-/);
    const unavailable = { getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); } };
    expect(() => loadPlayerIdentity(unavailable, bytes => bytes.fill(3))).not.toThrow();
  });

  it('normalizes harmless spacing and rejects console/markup injection', () => {
    expect(normalizePlayerName('  Иван  Петров ')).toEqual('Иван Петров');
    expect(normalizePlayerName('Alice_2.7')).toEqual('Alice_2.7');
    for (const value of ['', 'A'.repeat(33), 'a\nb', 'a\rb', '\u001b[31m', '<b>Admin</b>', 'A\u202eB']) {
      expect(normalizePlayerName(value)).toBeNull();
    }
  });
});
