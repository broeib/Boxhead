import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Fallback, sha256Hex } from '../../apps/original-web/src/sha256';

const encode = (text: string) => new TextEncoder().encode(text);
const reference = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
afterEach(() => { vi.unstubAllGlobals(); });

describe('SHA-256 asset identity on private HTTP LAN origins', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('matches the standard known vector %s', async (input, expected) => {
    expect(await sha256Fallback(encode(input))).toBe(expected);
  });
  it('matches Node crypto for a 2 MiB binary asset and does not mutate it', async () => {
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31 + (i >>> 8)) & 255);
    const before = reference(bytes);
    expect(await sha256Fallback(bytes)).toBe(before);
    expect(reference(bytes)).toBe(before);
  });
  it.each([55, 56, 63, 64, 65, 119, 120, 127, 128])('pads the %i-byte boundary correctly, including subarray views', async (length) => {
    const backing = Uint8Array.from({ length: length + 11 }, (_, i) => (i * 73) & 255);
    const view = backing.subarray(3, length + 3);
    expect(await sha256Fallback(view)).toBe(reference(view));
    vi.stubGlobal('crypto', webcrypto);
    expect(await sha256Hex(view)).toBe(reference(view));
  });
  it('retains the exact SHA-256 check when SubtleCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    const bytes = encode('An original SWF must have the same identity on HTTP and HTTPS.');
    expect(await sha256Hex(bytes)).toBe(reference(bytes));
  });
  it('prefers available WebCrypto and supports cancellation', async () => {
    const digest = vi.fn((algorithm: AlgorithmIdentifier, bytes: BufferSource) => webcrypto.subtle.digest(algorithm, bytes));
    vi.stubGlobal('crypto', { subtle: { digest } });
    expect(await sha256Hex(encode('abc'))).toBe(reference(encode('abc')));
    expect(digest).toHaveBeenCalledTimes(1);
    const abort = new AbortController(); abort.abort();
    await expect(sha256Fallback(new Uint8Array(10), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
