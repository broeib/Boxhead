import { expect, it, vi } from 'vitest';
import { CheckpointReceiver, encodeCheckpointChunks, packCheckpoint } from '../../apps/original-web/src/checkpoint';
import { OriginalSession } from '../../apps/original-web/src/session';
import { OriginalBridge, type NativeInvoke } from '../../apps/original-web/src/bridge';
import { CHECKPOINT_CHUNK_BYTES, MAX_CHECKPOINT_BYTES, parseServerMessage, type PrepareMessage } from '../../apps/original-web/src/protocol';

const id = 'CheckpointCase01';
const hash = 'a'.repeat(64);
const player = { slot: 1, id: 1, x: 1, y: 2, z: 0, angle: 0, life: 200,
  flags: 9, state: 'State_PlayerControl', weapon: 'pistol', ammo: 999999 };
const prepare: PrepareMessage = { type: 'prepare', seed: 7, mode: 'Coop', map: 'ROOM_Single_0001',
  characters: [0, 1], swfHash: hash, initialPlayers: 1, personalProgression: true,
  replay: true, checkpointVersion: 1 };

it('bounded compressed transfer preserves exact Unicode data and rejects missing/changed chunks', async () => {
  const signal = new AbortController().signal;
  const payload = JSON.stringify({ exact: 'state\u0000\ud800', text: 'Зомби'.repeat(10000) });
  const packed = await packCheckpoint(id, { version: 1, tick: 250, digest: 'native-250', payload }, signal);
  expect(parseServerMessage(JSON.stringify(packed.header))).toEqual(packed.header);
  const receiver = new CheckpointReceiver(packed.header);
  await expect(receiver.unpack(signal)).rejects.toThrow();
  packed.chunks.forEach((chunk, index) => receiver.add(index, chunk));
  expect(await receiver.unpack(signal)).toBe(payload);
  expect(() => receiver.add(0, packed.chunks[0])).toThrow();
  const altered = new CheckpointReceiver({ ...packed.header, sha256: 'b'.repeat(64) });
  packed.chunks.forEach((chunk, index) => altered.add(index, chunk));
  await expect(altered.unpack(signal)).rejects.toThrow('SHA256');
});

it('checkpoint base64 yields to queued browser tasks and preserves exact boundary bytes', async () => {
  const bytes = Uint8Array.from({ length: 9 * CHECKPOINT_CHUNK_BYTES + 17 }, (_, index) => index % 251);
  let anotherTaskRan = false;
  const timer = setTimeout(() => { anotherTaskRan = true; }, 0);
  try {
    const chunks = await encodeCheckpointChunks(bytes, new AbortController().signal);
    expect(anotherTaskRan).toBe(true);
    expect(chunks).toHaveLength(10);
    expect(chunks.map(chunk => Buffer.from(chunk, 'base64').length))
      .toEqual([...Array<number>(9).fill(CHECKPOINT_CHUNK_BYTES), 17]);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(Buffer.from(bytes));
    for (const chunk of chunks) expect(Buffer.from(chunk, 'base64').toString('base64')).toBe(chunk);
  } finally { clearTimeout(timer); }
});

it('checkpoint conversion stops when cancelled between browser tasks and rejects oversize input', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await expect(encodeCheckpointChunks(new Uint8Array(5 * CHECKPOINT_CHUNK_BYTES), controller.signal))
      .rejects.toThrow('cancelled');
  } finally { clearTimeout(timer); }
  await expect(encodeCheckpointChunks(new Uint8Array(MAX_CHECKPOINT_BYTES + 1), new AbortController().signal))
    .rejects.toThrow('too large');
});

it('packing yields before encoding and retains the already captured payload, tick and digest', async () => {
  const captured = { version: 1 as const, tick: 250, digest: 'native-250', payload: '{"before":true}' };
  const originalPayload = captured.payload;
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  let taskRan = false;
  const timer = setTimeout(() => { taskRan = true; }, 0);
  try {
    const pending = packCheckpoint(id, captured, new AbortController().signal);
    expect(encode).not.toHaveBeenCalled();
    captured.tick = 275;
    captured.digest = 'native-275';
    captured.payload = '{"after":true}';
    await Promise.resolve();
    expect(encode).not.toHaveBeenCalled();
    const packed = await pending;
    expect(taskRan).toBe(true);
    expect(encode).toHaveBeenCalledExactlyOnceWith(originalPayload);
    expect(packed.header.tick).toBe(250);
    expect(packed.header.digest).toBe('native-250');
    const receiver = new CheckpointReceiver(packed.header);
    packed.chunks.forEach((chunk, index) => receiver.add(index, chunk));
    expect(await receiver.unpack(new AbortController().signal)).toBe(originalPayload);
  } finally { clearTimeout(timer); encode.mockRestore(); }
});

it('cancelling the initial packing task prevents all payload encoding', async () => {
  const controller = new AbortController();
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await expect(packCheckpoint(id, { version: 1, tick: 250, digest: 'native-250', payload: '{}' }, controller.signal))
      .rejects.toThrow('cancelled');
    expect(encode).not.toHaveBeenCalled();
  } finally { clearTimeout(timer); encode.mockRestore(); }
});

function nativeFixture() {
  let tick = 0, state = 'menu';
  let corrupt = false;
  const invoke = vi.fn<NativeInvoke>((name, ...args) => {
    if (name === 'bhInfo') return { version: 1, engine: 'original-swf', state, tick, canPrepare: state === 'menu', checkpointVersion: 1 };
    if (name === 'bhPrepare') { state = 'ready'; return { state, tick }; }
    if (name === 'bhCheckpointImport') { tick = args[1] as number; state = 'playing'; }
    if (name === 'bhStep') { tick = args[0] as number; state = 'playing'; }
    return { tick, digest: corrupt ? 'wrong' : `native-${tick}`, players: [player], entities: [], rng: 7 };
  });
  return { invoke, bridge: new OriginalBridge(invoke), corrupt: () => { corrupt = true; } };
}

it('restore requires matching native readback and its failure prevents subsequent native steps', async () => {
  const f = nativeFixture(); await f.bridge.prepare(prepare, undefined, 2);
  f.corrupt();
  expect(() => f.bridge.importCheckpoint('{}', 250, 'native-250')).toThrow();
  const calls = f.invoke.mock.calls.length;
  expect(() => f.bridge.step(251, 0, 0)).toThrow();
  expect(f.invoke.mock.calls).toHaveLength(calls);
});

it('guest sends one restored-state attestation and ACKs only subsequently executed native frames', async () => {
  const f = nativeFixture();
  const sent: Record<string, unknown>[] = [];
  const failed = vi.fn();
  const session = new OriginalSession({ type: 'join_open', room: 'DropInRoom01' }, hash, f.bridge,
    { send: m => { sent.push(m); }, close: vi.fn() },
    { joined: vi.fn(), preparing: vi.fn(), prepared: vi.fn(), stepped: vi.fn(), failed });
  const receive = (value: unknown) => session.receive(JSON.stringify(value));
  session.opened();
  await receive({ type: 'joined', room: 'DropInRoom01', slot: 2, token: 'test-only-token' });
  await receive(prepare);
  expect(sent.find(m => m.type === 'ready')).toEqual({ type: 'ready', checkpointVersion: 1 });
  await receive({ type: 'checkpoint_wait', id, timeoutMs: 30000 });
  const packed = await packCheckpoint(id, { version: 1, tick: 250, digest: 'native-250', payload: '{}' }, new AbortController().signal);
  await receive(packed.header);
  for (let index = 0; index < packed.chunks.length; index++) await receive({ type: 'checkpoint_chunk', id, index, data: packed.chunks[index] });
  await receive({ type: 'checkpoint_end', id });
  expect(sent.filter(m => m.type === 'ack')).toEqual([]);
  expect(sent.filter(m => m.type === 'checkpoint_applied')).toEqual([
    { type: 'checkpoint_applied', id, tick: 250, digest: 'native-250', sha256: packed.header.sha256 },
  ]);
  await receive({ type: 'frame', tick: 251, p1: 0, p2: 0 });
  expect(sent.filter(m => m.type === 'ack')).toEqual([{ type: 'ack', tick: 251, digest: 'native-251' }]);
  expect(f.invoke.mock.calls.filter(c => c[0] === 'bhStep')).toEqual([['bhStep', 251, 0, 0]]);
  expect(failed).not.toHaveBeenCalled();
});
