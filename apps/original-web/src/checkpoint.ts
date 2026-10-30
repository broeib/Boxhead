import { ClientError, CHECKPOINT_CHUNK_BYTES, MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_RAW_BYTES, type CheckpointHeader } from './protocol';
import { sha256Hex } from './sha256';

export interface NativeCheckpoint { version: 1; tick: number; digest: string; payload: string }

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ClientError('State transfer cancelled.');
}

function nextCheckpointTask(signal: AbortSignal): Promise<void> {
  check(signal);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new ClientError('State transfer cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 0);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Encode an already immutable checkpoint buffer without monopolising a live host. */
export async function encodeCheckpointChunks(bytes: Uint8Array, signal: AbortSignal): Promise<string[]> {
  check(signal);
  if (bytes.length < 1 || bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new ClientError('The world snapshot is too large to transfer.');
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHECKPOINT_CHUNK_BYTES) {
    check(signal);
    const part = bytes.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES);
    let binary = '';
    // Keep the call argument count small on every supported browser; joining
    // eight-bit code units preserves exactly the existing canonical base64.
    for (let begin = 0; begin < part.length; begin += 8192) {
      binary += String.fromCharCode(...part.subarray(begin, begin + 8192));
    }
    chunks.push(btoa(binary));
    // At most four 32 KiB chunks per task. A real task boundary permits native
    // frames, input and presentation to proceed; a microtask yield would not.
    if (chunks.length % 4 === 0 && offset + CHECKPOINT_CHUNK_BYTES < bytes.length) {
      await nextCheckpointTask(signal);
    }
  }
  check(signal);
  return chunks;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      check(signal);
      const result = await reader.read();
      check(signal);
      if (result.done) break;
      length += result.value.length;
      if (length > limit) throw new ClientError('The world snapshot exceeds the size limit.');
      parts.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export async function packCheckpoint(id: string, value: NativeCheckpoint, signal: AbortSignal): Promise<{ header: CheckpointHeader; chunks: string[] }> {
  check(signal);
  const { version, tick, digest, payload } = value;
  if (version !== 1 || !Number.isSafeInteger(tick) || tick < 25 || tick % 25 !== 0
    || !/^[!-~]{1,256}$/.test(digest) || typeof payload !== 'string'
    || !payload.length || payload.length > MAX_CHECKPOINT_RAW_BYTES) {
    throw new ClientError('The native world snapshot does not match the contract.');
  }
  // Native export and its unchanged-world readback have already completed.
  // These captured primitive values are immutable even if the host advances
  // another frame while encoding waits; no live graph is read after the yield.
  await nextCheckpointTask(signal);
  check(signal);
  const raw = new TextEncoder().encode(payload);
  if (raw.length > MAX_CHECKPOINT_RAW_BYTES) throw new ClientError('The native world snapshot is too large.');
  const encoding = typeof CompressionStream === 'function' ? 'deflate' : 'plain';
  const bytes = encoding === 'deflate'
    ? await readBounded(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')), MAX_CHECKPOINT_BYTES, signal)
    : raw;
  if (bytes.length < 1 || bytes.length > MAX_CHECKPOINT_BYTES) throw new ClientError('The world snapshot is too large to transfer.');
  const sha256 = await sha256Hex(bytes, signal);
  const chunks = await encodeCheckpointChunks(bytes, signal);
  check(signal);
  return { header: { type: 'checkpoint_begin', id, version: 1, tick, digest,
    encoding, bytes: bytes.length, uncompressedBytes: raw.length, sha256, chunks: chunks.length }, chunks };
}

/** One strictly ordered bounded transfer. It never modifies the native VM. */
export class CheckpointReceiver {
  private readonly bytes: Uint8Array;
  private offset = 0;
  private index = 0;
  constructor(readonly header: CheckpointHeader) { this.bytes = new Uint8Array(header.bytes); }

  add(index: number, data: string): void {
    if (index !== this.index || index >= this.header.chunks) throw new ClientError('World snapshot chunks are out of order.');
    const binary = atob(data);
    const expected = Math.min(CHECKPOINT_CHUNK_BYTES, this.bytes.length - this.offset);
    if (binary.length !== expected || btoa(binary) !== data) throw new ClientError('A world snapshot chunk is corrupted.');
    for (let i = 0; i < binary.length; i++) this.bytes[this.offset++] = binary.charCodeAt(i);
    this.index++;
  }

  async unpack(signal: AbortSignal): Promise<string> {
    if (this.offset !== this.bytes.length || this.index !== this.header.chunks) throw new ClientError('The world snapshot is incomplete.');
    if (await sha256Hex(this.bytes, signal) !== this.header.sha256) throw new ClientError('The world snapshot SHA256 does not match.');
    check(signal);
    if (this.header.encoding === 'deflate' && typeof DecompressionStream !== 'function') {
      throw new ClientError('This browser cannot decompress the world snapshot.');
    }
    const raw = this.header.encoding === 'deflate'
      ? await readBounded(new Blob([new Uint8Array(this.bytes).buffer]).stream().pipeThrough(new DecompressionStream('deflate')), this.header.uncompressedBytes, signal)
      : this.bytes;
    if (raw.length !== this.header.uncompressedBytes) throw new ClientError('The decompressed world snapshot size does not match.');
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  }
}
