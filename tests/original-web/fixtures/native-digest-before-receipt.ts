/** Checksums the original VM's state projection; never simulates or substitutes game state. */
export const MAX_NATIVE_ENCODING_LENGTH = 8 * 1024 * 1024;

export function hashOriginalState(text: string): string {
  if (typeof text !== 'string' || text.length > MAX_NATIVE_ENCODING_LENGTH) {
    throw new Error('Original state encoding exceeds the 8 MiB character limit');
  }
  let forward = 2166136261;
  let reverse = 2166136261;
  for (let i = 0; i < text.length; i++) {
    forward = Math.imul(forward ^ text.charCodeAt(i), 16777619);
    reverse = Math.imul(reverse ^ text.charCodeAt(text.length - 1 - i), 16777619);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return 'native-v2-' + hex(forward) + hex(reverse);
}

/** Native projection tags, lexical object-key order and UTF-16 string lengths.
 * Number formatting is explicitly JavaScript String(number): AS2's decimal
 * formatting differs, so the VM must fail closed if this helper is unavailable.
 */
export function encodeOriginalState(value: unknown): string {
  const parts: string[] = [];
  const active = new Set<object>();
  let length = 0;
  function append(part: string): void {
    length += part.length;
    if (length > MAX_NATIVE_ENCODING_LENGTH) throw new Error('Original state encoding exceeds the 8 MiB character limit');
    parts.push(part);
  }
  function encode(item: unknown, depth: number): void {
    if (depth > 256) throw new Error('Original state projection nesting is too deep');
    if (item === null) { append('z'); return; }
    if (item === undefined) { append('u'); return; }
    if (typeof item === 'boolean') { append(item ? 't' : 'f'); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Original VM must encode non-finite numbers explicitly');
      append('n' + String(item) + ';'); return;
    }
    if (typeof item === 'string') { append('s' + item.length + ':' + item); return; }
    if (typeof item !== 'object') throw new Error('Unsupported value in original state projection');
    if (active.has(item)) throw new Error('Original state projection must contain explicit graph references');
    active.add(item);
    const keys = Object.keys(item).sort();
    append('o' + keys.length + ':');
    for (const key of keys) {
      encode(key, depth + 1);
      encode((item as Record<string, unknown>)[key], depth + 1);
    }
    active.delete(item);
  }
  encode(value, 0);
  return parts.join('');
}

export function digestOriginalState(value: unknown): { digest: string; bytes: number } {
  const encoded = encodeOriginalState(value);
  // `bytes` retains the AS2 callback's legacy name; its unit is UTF-16 code units.
  return { digest: hashOriginalState(encoded), bytes: encoded.length };
}

export function installOriginalDigestHelpers(target: Record<string, unknown>): void {
  target.boxheadHashOriginalState = hashOriginalState;
  target.boxheadDigestOriginalState = digestOriginalState;
}
