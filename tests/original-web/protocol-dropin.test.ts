import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseServerMessage } from '../../apps/original-web/src/protocol';

const prepare = {
  type: 'prepare', seed: 7, mode: 'Coop', map: 'ROOM_Single_0001',
  characters: [0, 1], swfHash: 'a'.repeat(64),
};
const parse = (message: unknown) => parseServerMessage(JSON.stringify(message));

describe('drop-in wire contract', () => {
  it('keeps legacy paired preparation compatible without inventing drop-in flags', () => {
    const message = parse(prepare);
    expect(message).toMatchObject({ ...prepare, settings: DEFAULT_SETTINGS, frameMs: 40 });
    expect(message).not.toHaveProperty('initialPlayers');
    expect(message).not.toHaveProperty('replay');
    expect(message).not.toHaveProperty('personalProgression');
  });

  it.each([false, true])('preserves the agreed solo roster and personal progression during replay=%s', (replay) => {
    const options = { initialPlayers: 1, personalProgression: true, replay };
    expect(parse({ ...prepare, ...options })).toMatchObject(options);
  });

  it('accepts an explicit paired start without replay', () => {
    expect(parse({ ...prepare, initialPlayers: 2, replay: false, personalProgression: true }))
      .toMatchObject({ initialPlayers: 2, replay: false, personalProgression: true });
  });

  it.each([
    { initialPlayers: 0 }, { initialPlayers: 3 }, { initialPlayers: 1.5 },
    { initialPlayers: '1' }, { initialPlayers: null },
    { replay: 1 }, { replay: 'true' }, { replay: null },
    { personalProgression: 1 }, { personalProgression: 'true' }, { personalProgression: null },
    { replay: true },
    { replay: true, initialPlayers: 2, personalProgression: true },
    { replay: true, initialPlayers: 1 },
    { replay: true, initialPlayers: 1, personalProgression: false },
  ])('rejects an ambiguous or incompatible catch-up configuration: %j', (options) => {
    expect(() => parse({ ...prepare, ...options })).toThrow();
  });

  it.each([[0, 80], [1, 40], [2, 20]])('keeps original speed %s at %s ms during replay', (speed, frameMs) => {
    const message = { ...prepare, settings: { ...DEFAULT_SETTINGS, speed }, frameMs,
      initialPlayers: 1, personalProgression: true, replay: true };
    expect(parse(message)).toMatchObject({ frameMs, settings: { ...DEFAULT_SETTINGS, speed } });
    expect(() => parse({ ...message, frameMs: frameMs + 1 })).toThrow();
  });

  it.each([0, 3])('preserves a single commanded spawn with character %s', (character) => {
    const message = { type: 'frame', tick: 81, p1: 17, p2: 0, join: { slot: 2, character } };
    expect(parse(message)).toEqual(message);
  });

  it('preserves an explicit leave on the frame without encoding it in inputs', () => {
    const message = { type: 'frame', tick: 82, p1: 17, p2: 0, leave: { slot: 2 } };
    expect(parse(message)).toEqual(message);
  });

  it.each([null, [], {}, { slot: 1 }, { slot: '2' }, { slot: 2, reason: 'left' }])(
    'rejects an invalid leave event: %j', leave => {
      expect(() => parse({ type: 'frame', tick: 1, p1: 0, p2: 0, leave })).toThrow();
    });

  it('rejects simultaneous leave and join and unknown frame fields', () => {
    expect(() => parse({ type: 'frame', tick: 1, p1: 0, p2: 0,
      join: { slot: 2, character: 1 }, leave: { slot: 2 } })).toThrow();
    expect(() => parse({ type: 'frame', tick: 1, p1: 0, p2: 0, event: 'leave' })).toThrow();
  });

  it.each([
    null, [], {}, { slot: 2 }, { character: 0 },
    { slot: 1, character: 0 }, { slot: '2', character: 0 },
    { slot: 2, character: -1 }, { slot: 2, character: 4 },
    { slot: 2, character: 0.5 }, { slot: 2, character: '0' },
    { slot: 2, character: 0, score: 100 },
    [{ slot: 2, character: 0 }, { slot: 2, character: 1 }],
  ])('rejects a malformed or augmented spawn command: %j', (join) => {
    expect(() => parse({ type: 'frame', tick: 81, p1: 0, p2: 0, join })).toThrow();
  });

  it.each([0, 1, 0x7fffffff])('accepts a bounded catch-up point at tick %s', (tick) => {
    expect(parse({ type: 'caught_up', tick })).toEqual({ type: 'caught_up', tick });
  });

  it.each([-1, 0.5, 0x80000000, '1', null])('rejects an invalid catch-up tick: %j', (tick) => {
    expect(() => parse({ type: 'caught_up', tick })).toThrow();
  });

  it('does not accept missing ticks or extra state in a catch-up acknowledgement', () => {
    expect(() => parse({ type: 'caught_up' })).toThrow();
    expect(() => parse({ type: 'caught_up', tick: 0, digest: 'claimed-state' })).toThrow();
  });

  it.each([
    { type: 'join_sync', state: 'paused', tick: 3000, verified: 500, timeoutMs: 120000 },
    { type: 'join_sync', state: 'progress', tick: 3000, verified: 3000 },
    { type: 'join_sync', state: 'resumed', tick: 3000, joined: true },
    { type: 'join_sync', state: 'resumed', tick: 0, joined: false },
  ])('preserves a finite synchronization boundary: %j', (message) => {
    expect(parse(message)).toEqual(message);
  });

  it.each([
    { state: 'paused', tick: 3, verified: 4, timeoutMs: 1000 },
    { state: 'paused', tick: 3, verified: -1, timeoutMs: 1000 },
    { state: 'paused', tick: 3, verified: 0, timeoutMs: 0 },
    { state: 'paused', tick: 3, verified: 0, timeoutMs: 180001 },
    { state: 'paused', tick: 3, verified: 0 },
    { state: 'progress', tick: 3, verified: 0, timeoutMs: 120000 },
    { state: 'progress', tick: 3.5, verified: 0 },
    { state: 'resumed', tick: 3, joined: 'true' },
    { state: 'resumed', tick: 3, joined: true, verified: 3 },
    { state: 'unknown', tick: 3, verified: 0 },
  ])('rejects unbounded, inconsistent or augmented synchronization: %j', (message) => {
    expect(() => parse({ type: 'join_sync', ...message })).toThrow();
  });
});
