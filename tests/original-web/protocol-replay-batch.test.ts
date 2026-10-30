import { describe, expect, it } from 'vitest';
import { parseServerMessage } from '../../apps/original-web/src/protocol';

const prepare = { type: 'prepare', seed: 7, swfHash: 'a'.repeat(64), mode: 'Coop',
  map: 'ROOM_Single_0001', characters: [0, 1], initialPlayers: 1, replay: true, personalProgression: true };
const frame = (tick: number, extra: Record<string, unknown> = {}) => ({ type: 'frame', tick, p1: 17, p2: 0, ...extra });
const parse = (value: unknown) => parseServerMessage(JSON.stringify(value));

describe('bounded historical frame wire parser', () => {
  it('keeps legacy prepare/frame messages and accepts a bounded replay-only offer', () => {
    expect(parse(prepare)).not.toHaveProperty('replayBatchMax');
    expect(parse({ ...prepare, replayBatchMax: 4 })).toMatchObject({ replay: true, replayBatchMax: 4 });
    expect(parse({ ...prepare, replayBatchMax: 8 })).toMatchObject({ replay: true, replayBatchMax: 8 });
    expect(parse({ ...prepare, replayBatchMax: 8, replayBatchExtendedMax: 32 })).toMatchObject({
      replay: true, replayBatchMax: 8, replayBatchExtendedMax: 32,
    });
    expect(parse(frame(1))).toEqual(frame(1));
    expect(parse({ ...prepare, replay: false })).not.toHaveProperty('replayBatchMax');
  });

  it.each([0, -1, 9, 1.5, '4', null, true])('rejects invalid offered batch bound %j', (replayBatchMax) => {
    expect(() => parse({ ...prepare, replayBatchMax })).toThrow();
  });

  it.each([9, 16, 24, 31, 32, 33, 63, 64])('accepts extended cap %s while retaining the compatible eight-frame offer', (replayBatchExtendedMax) => {
    expect(parse({ ...prepare, replayBatchMax: 8, replayBatchExtendedMax })).toMatchObject({
      replayBatchMax: 8, replayBatchExtendedMax,
    });
  });

  it.each([0, -1, 1, 8, 65, 128, 1.5, '64', null, true])('rejects invalid extended cap %j', (replayBatchExtendedMax) => {
    expect(() => parse({ ...prepare, replayBatchMax: 8, replayBatchExtendedMax })).toThrow();
  });

  it.each([
    { replayBatchMax: undefined }, { replayBatchMax: 4 }, { replayBatchMax: 32 },
    { replay: false }, { initialPlayers: 2 }, { personalProgression: false },
  ])('rejects an unbound or incompatible extended offer: %j', (change) => {
    expect(() => parse({ ...prepare, replayBatchMax: 8, replayBatchExtendedMax: 32, ...change })).toThrow();
  });

  it.each([
    { replay: false }, { replay: undefined }, { initialPlayers: 2 }, { personalProgression: false },
  ])('rejects batching outside a prepared solo historical guest: %j', (change) => {
    expect(() => parse({ ...prepare, replayBatchMax: 4, ...change })).toThrow();
  });

  it.each([1, 4, 8, 16, 31, 32, 33, 63, 64])('accepts %s structurally valid contiguous frames; the session enforces negotiation', (count) => {
    const message = { type: 'replay_frames', frames: Array.from({ length: count }, (_, index) => frame(9 + index)) };
    expect(parse(message)).toEqual(message);
  });

  it('preserves historical player events and input in the whole packet', () => {
    const message = { type: 'replay_frames', frames: [frame(1, { join: { slot: 2, character: 1 } }),
      frame(2, { p2: 16 }), frame(3, { leave: { slot: 2 } }), frame(4, { join: { slot: 2, character: 3 } })] };
    expect(parse(message)).toEqual(message);
  });

  it.each([
    { type: 'replay_frames', frames: [] },
    { type: 'replay_frames', frames: Array.from({ length: 65 }, (_, index) => frame(index + 1)) },
    { type: 'replay_frames', frames: Array.from({ length: 128 }, (_, index) => frame(index + 1)) },
    { type: 'replay_frames', frames: [frame(1)], extra: 1 },
    { type: 'replay_frames', frames: null },
    { type: 'replay_frames', frames: [frame(1), null] },
    { type: 'replay_frames', frames: [frame(1), frame(3)] },
    { type: 'replay_frames', frames: [frame(1), frame(1)] },
    { type: 'replay_frames', frames: [frame(2), frame(1)] },
    { type: 'replay_frames', frames: [frame(1), frame(2, { leave: { slot: 1 } })] },
    { type: 'replay_frames', frames: [frame(1, { extra: 0 })] },
    { type: 'replay_frames', frames: [frame(1, { type: 'other' })] },
    { type: 'replay_frames', frames: [{ tick: 1, p1: 17, p2: 0 }] },
    { type: 'replay_frames', frames: [frame(1, { p1: 131072 })] },
    { type: 'replay_frames', frames: [frame(1, { p1: '17' })] },
    { type: 'replay_frames', frames: [frame(0)] },
    { type: 'replay_frames', frames: [frame(2147483647), frame(2147483648)] },
  ])('rejects a malformed batch before exposing any of its frames: %j', (message) => {
    expect(() => parse(message)).toThrow();
  });

  it.each([{ tick: 30 }, { p2: 131072 }, { extra: 1 }, { join: { slot: 1, character: 1 } }])(
    'rejects a malformed last member before exposing any prefix of batch32: %j', (change) => {
      const frames = Array.from({ length: 32 }, (_, index) => frame(index + 1));
      Object.assign(frames[31], change);
      expect(() => parse({ type: 'replay_frames', frames })).toThrow();
    });
  it('keeps a full64 packet with maximum legal tick and input values inside the unchanged payload bound', () => {
    const message = { type: 'replay_frames', frames: Array.from({ length: 64 }, (_, index) =>
      frame(0x7fffffff - 63 + index, { p1: 0x1ffff })) };
    expect(JSON.stringify(message).length).toBeLessThan(65_536);
    expect(parse(message)).toEqual(message);
    expect(parse({ ...prepare, replayBatchMax: 8, replayBatchExtendedMax: 64 })).toMatchObject({
      replayBatchMax: 8, replayBatchExtendedMax: 64,
    });
  });

  it.each([{ tick: 62 }, { p2: 131072 }, { extra: 1 }, { join: { slot: 1, character: 1 } }])(
    'rejects a malformed member63 or64 before exposing any prefix of batch64: %j', (change) => {
      for (const index of [62, 63]) {
        const frames = Array.from({ length: 64 }, (_, offset) => frame(offset + 1));
        Object.assign(frames[index], change);
        expect(() => parse({ type: 'replay_frames', frames })).toThrow();
      }
    });

});
