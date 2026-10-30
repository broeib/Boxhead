import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { advanceOriginalFrameDeadline } from '../../apps/original-server/frame-pacer.mjs';
import { restorePeerDisconnectClosingSource } from './fixtures/peer-disconnect-source.mjs';

const source = await readFile(new URL('../../apps/original-server/service.mjs', import.meta.url), 'utf8');
const predecessorSha256 = '1c2779ec6186d897cf2c6a60ed02db7b0adccd9c149bbf6ff24e316ed5c4cc25';
const networkTestsSha256 = '19fc3ba62da4ab567eaf66989a38b2ad9976dbc4d326e5e98c1b5e04400dbb8a';
// Exact source fixtures preserve the original provenance checks without importing private Git history.
const baselineFile = name => {
  const file = {'apps/original-server/service.mjs':'baseline-service.mjs.txt',
    'tests/original-network/network.test.mjs':'baseline-network.test.mjs.txt'}[name];
  assert(file, 'Unknown baseline source');
  return readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8');
};
const hash = (value) => createHash('sha256').update(value).digest('hex');

function replaceOnce(value, current, previous) {
  const at = value.indexOf(current);
  assert.notEqual(at, -1, `Missing reviewed source delta: ${current}`);
  assert.equal(value.indexOf(current, at + current.length), -1, `Repeated source delta: ${current}`);
  return value.slice(0, at) + previous + value.slice(at + current.length);
}

function declaration(name, indent = '  ') {
  const marker = `${indent}function ${name}(`;
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `Missing actual function ${name}`);
  assert.equal(source.indexOf(marker, at + marker.length), -1);
  const endMarker = `\n${indent}}\n`;
  const end = source.indexOf(endMarker, at);
  assert.notEqual(end, -1);
  return source.slice(at, end + endMarker.length);
}

function constant(name) {
  const found = source.match(new RegExp(`^const ${name} = .+;$`, 'gm'));
  assert.equal(found?.length, 1, `Missing actual constant ${name}`);
  return found[0];
}

const ackStart = source.indexOf("      case 'ack': {");
const ackEnd = source.indexOf('\n      default:', ackStart);
assert.ok(ackStart > 0 && ackEnd > ackStart);
const ackCase = source.slice(ackStart, ackEnd);

// Execute the production scheduler, sampler, ACK branch and join/retirement
// functions with controlled outer dependencies. No second pacing algorithm or
// test-only service option replaces the function under test. The existing real
// WebSocket suite separately covers transport, input and protocol integration.
const makeActualFunctions = new Function('deps', `
  'use strict';
  const { performance, setTimeout, clearTimeout, config, send, telemetry,
    advanceOriginalFrameDeadline } = deps;
  const WebSocket = { OPEN: 1 };
  const rooms = new Map();
  const catchupCounters = { maximumBarrierMs: 0, barriers: 0, failed: 0,
    completed: 0, historyCapped: 0, verifiedReplayFrames: 0 };
  const refreshDirectory = () => {};
  const reject = (peer, code) => deps.rejections.push({ peer, code });
  const departedAck = Object.freeze({ departed: true });
  ${['COMPLETIONS', 'ACTION_BITS', 'ACTION_MASK', 'MAX_SEQUENCE'].map(constant).join('\n')}
  ${declaration('exactKeys', '')}
  ${['finishJoinBarrier', 'clearCatchupTimers', 'clearCheckpoint', 'clearLiveInput',
    'beginJoinBarrier', 'reportJoinProgress', 'cancelCatchup', 'armCatchupTimeout',
    'pumpCatchup', 'retireRoom', 'endRoom', 'completeRoom', 'armAckTimeout',
    'missingAckSlots', 'beginNetworkRecovery', 'expireNetworkRecovery', 'finishNetworkRecovery',
    'failPeer', 'departGuest', 'drainAcknowledgedFrames',
    'sampleInput', 'scheduleFrame', 'matchesReplayAck'].map((name) => declaration(name)).join('\n')}
  function acknowledge(peer, message) {
    const now = performance.now();
    const replayAck = matchesReplayAck(peer, message);
    switch (message.type) {
      ${ackCase}
      default: throw new Error('Fixture accepts only actual ACK messages');
    }
  }
  return { scheduleFrame, acknowledge, beginJoinBarrier, pumpCatchup, cancelCatchup,
    endRoom, rooms, catchupCounters };
`);

function fixture({ frameMs = 40, start = 0, maxInFlightFrames = 2, catchingUp = false,
  inputTimeoutMs = 100000, ackTimeoutMs = 5000, ackRecoveryTimeoutMs = 30000 } = {}) {
  let now = start;
  let nextTimerId = 1;
  const timers = new Map();
  const sent = [];
  const acknowledgements = [];
  const played = [];
  const roomEvents = [];
  const rejections = [];
  let onSend = () => {};
  const setTimeout = (fn, delay) => {
    assert.equal(typeof fn, 'function');
    assert.ok(Number.isFinite(delay) && Number.isInteger(delay) && delay >= 0);
    const id = { id: nextTimerId++, unref() {} };
    timers.set(id, { fn, at: now + delay, delay });
    return id;
  };
  const clearTimeout = (id) => { timers.delete(id); };
  const api = makeActualFunctions({
    performance: { now: () => now }, setTimeout, clearTimeout,
    advanceOriginalFrameDeadline, rejections,
    config: { maxInFlightFrames, inputTimeoutMs, ackTimeoutMs, ackRecoveryTimeoutMs,
      initialReplayAckTimeoutMs: 30000, shutdownGraceMs: 300, maxCatchupBarrierMs: 1500,
      maxReplayInFlightFrames: 128, maxHistoryFrames: 120000 },
    send: (peer, message) => {
      sent.push({ peer, slot: peer?.slot, message, at: now });
      onSend(peer, message);
    },
    telemetry: {
      acknowledge: (peer, sentAt, receivedAt) => acknowledgements.push({ peer, sentAt, receivedAt }),
      played: (peer, room, tick) => played.push({ peer, room, tick }),
      roomEvent: (kind, room, reason) => roomEvents.push({ kind, room, reason }),
      left: () => {},
    },
  });
  const room = {
    id: 'fixture', frameMs, phase: 'playing', activePlayers: catchingUp ? 1 : 2,
    players: [], ready: [true, true], masks: [0, 0], pressed: [0, 0], released: [0, 0],
    applied: [0, 0], neutral: [false, false], inputAt: [now, now],
    pending: new Map(), history: [], historyAvailable: catchingUp,
    terminalTick: null, verifiedTick: 0, tick: 0, lastFrameAt: -Infinity,
    nextFrameDue: null, lastActivity: now, nextJoin: null,
    joinBarrierAt: null, joinBarrierTick: null, joinBarrierDeadline: null, joinSyncAnnounced: false,
    networkRecovery: null,
    frameTimer: undefined, ackTimer: undefined, phaseTimer: undefined, listed: false,
  };
  const peers = [1, 2].map((slot) => ({
    ws: { readyState: 1, close() {} },
    room, slot, lastAckTick: 0, lastSequence: -1, completed: false,
    catchingUp: catchingUp && slot === 2, catchupReady: false, catchupSentTick: 0,
    catchupDeadline: start + 10000, replayBatch: 0, replayBatchMax: 0,
    lastSyncProgressAt: -Infinity, checkpoint: null, retiredCheckpoints: [], character: 3,
  }));
  room.players = [...peers];
  api.rooms.set(room.id, room);
  const moveTo = (at) => {
    assert.ok(Number.isFinite(at) && at >= now, `Fixture clock moved backward: ${at} < ${now}`);
    now = at;
  };
  const fire = (id, at = timers.get(id)?.at) => {
    const timer = timers.get(id);
    assert.ok(timer, `No actual timer ${id}`);
    moveTo(at);
    timers.delete(id);
    timer.fn();
  };
  const ack = (slot, tick = room.tick, extra = {}) => {
    api.acknowledge(peers[slot - 1], { type: 'ack', tick, digest: `native-${tick}`, ...extra });
  };
  return {
    api, room, peers, timers, sent, acknowledgements, played, roomEvents, rejections,
    now: () => now, moveTo, fire, ack,
    schedule: () => api.scheduleFrame(room),
    fireFrame: (at) => fire(room.frameTimer, at),
    ackBoth: (tick = room.tick, extra = {}) => { ack(1, tick, extra); ack(2, tick, extra); },
    frames: () => sent.filter((entry) => entry.message.type === 'frame' && entry.peer === peers[0]),
    setOnSend: (fn) => { onSend = fn; },
  };
}

test('the historical pacing and peer-close provenance remains bound to the baseline revision', async () => {
  let restored = restorePeerDisconnectClosingSource(baselineFile('apps/original-server/service.mjs'));
  const replacements = [
    ["import { advanceOriginalFrameDeadline } from './frame-pacer.mjs';\n", ''],
    ['      const remaining = room.nextFrameDue === null ? 0 : room.nextFrameDue - performance.now();',
      '      const remaining = room.lastFrameAt + room.frameMs - performance.now();'],
    ['      room.nextFrameDue = advanceOriginalFrameDeadline(room.nextFrameDue, room.lastFrameAt, room.frameMs);\n', ''],
    ['    room.frameTimer = setTimeout(emit, room.nextFrameDue === null\n      ? 0 : Math.max(0, Math.ceil(room.nextFrameDue - performance.now())));',
      '    room.frameTimer = setTimeout(emit, Math.max(0, Math.ceil(room.lastFrameAt + room.frameMs - performance.now())));'],
    ['          nextFrameDue: null,\n', ''],
  ];
  for (const [current, previous] of replacements) restored = replaceOnce(restored, current, previous);
  assert.equal(Buffer.byteLength(restored), 59262);
  assert.equal(hash(restored), predecessorSha256);
  assert.equal(hash(baselineFile('tests/original-network/network.test.mjs')), networkTestsSha256);
});

test('deadline advancement keeps the exact speed and a small, explicit jitter budget', () => {
  for (const frameMs of [80, 40, 20]) {
    const budget = Math.min(frameMs / 8, 5);
    assert.equal(advanceOriginalFrameDeadline(null, 123.25, frameMs), 123.25 + frameMs);
    assert.equal(advanceOriginalFrameDeadline(200, 200, frameMs), 200 + frameMs);
    assert.equal(advanceOriginalFrameDeadline(200, 200 + budget, frameMs), 200 + frameMs);
    assert.equal(advanceOriginalFrameDeadline(200, 200 + budget + 0.25, frameMs), 200 + budget + 0.25 + frameMs);
    assert.equal(advanceOriginalFrameDeadline(200, 10000, frameMs), 10000 + frameMs);
  }
});

test('invalid, early, infinite or precision-exhausted clocks cannot create a catch-up deadline', () => {
  for (const emittedAt of [NaN, Infinity, -Infinity, -1, undefined, null, '100']) {
    assert.throws(() => advanceOriginalFrameDeadline(null, emittedAt, 40), RangeError);
  }
  for (const frameMs of [NaN, Infinity, -Infinity, 0, -1, undefined, null, '40']) {
    assert.throws(() => advanceOriginalFrameDeadline(null, 100, frameMs), RangeError);
  }
  for (const previousDue of [NaN, Infinity, -Infinity, -1, undefined, '100']) {
    assert.throws(() => advanceOriginalFrameDeadline(previousDue, 100, 40), RangeError);
  }
  assert.throws(() => advanceOriginalFrameDeadline(101, 100, 40), RangeError);
  assert.throws(() => advanceOriginalFrameDeadline(null, Number.MAX_VALUE, Number.MAX_VALUE), RangeError);
  assert.throws(() => advanceOriginalFrameDeadline(null, Number.MAX_VALUE, 40), RangeError);
});

test('the first actual emission anchors a finite grid without changing the actual sampling or send clock', () => {
  const h = fixture({ start: 100 });
  h.room.masks = [1, 2];
  h.schedule();
  const firstTimer = h.room.frameTimer;
  assert.equal(h.timers.get(firstTimer).delay, 0);
  h.schedule();
  assert.equal(h.room.frameTimer, firstTimer);
  assert.equal(h.room.nextFrameDue, null);
  assert.equal(h.room.lastFrameAt, -Infinity);
  h.fireFrame(113.25);
  assert.equal(h.room.tick, 1);
  assert.equal(h.room.lastFrameAt, 113.25);
  assert.equal(h.room.nextFrameDue, 153.25);
  assert.equal(h.room.pending.get(1).sentAt, 113.25);
  assert.deepEqual(h.frames().map(({ message, at }) => ({ message, at })), [
    { message: { type: 'frame', tick: 1, p1: 1, p2: 2 }, at: 113.25 },
  ]);
  assert.equal(h.sent[0].message, h.sent[1].message);
  assert.equal(h.timers.get(h.room.frameTimer).at, 153.25);
});

for (const frameMs of [80, 40, 20]) {
  test(`actual scheduleFrame absorbs repeated timer lateness without speeding up the ${frameMs} ms simulation`, () => {
    const h = fixture({ frameMs, start: 100.125 });
    h.schedule();
    let firstAt;
    for (let index = 0; index < 200; index += 1) {
      const timer = h.timers.get(h.room.frameTimer);
      h.fireFrame(timer.at + 0.8);
      firstAt ??= h.room.lastFrameAt;
      const ideal = firstAt + index * frameMs;
      assert.equal(h.room.tick, index + 1);
      assert.ok(h.room.lastFrameAt >= ideal - 1e-8, 'No emission before its absolute grid slot');
      assert.ok(h.room.lastFrameAt - ideal < 1.81, 'Sub-millisecond lateness must not accumulate');
      assert.ok(Math.abs(h.room.nextFrameDue - (firstAt + (index + 1) * frameMs)) < 1e-8);
      h.ackBoth();
      assert.equal(h.room.verifiedTick, index + 1);
      assert.equal(h.room.pending.size, 0);
    }
    const frames = h.frames();
    assert.equal(frames.length, 200);
    for (let index = 1; index < frames.length; index += 1) {
      assert.ok(frames[index].at - frames[index - 1].at >= frameMs - Math.min(frameMs / 8, 5) - 1e-8);
    }
    assert.equal(h.played.length, 400);
    assert.equal(h.rejections.length, 0);
  });
}

test('an early timer callback neither emits nor advances the grid and repeated scheduling has one owner', () => {
  const h = fixture();
  h.schedule(); h.fireFrame(); h.ackBoth();
  const due = h.room.nextFrameDue;
  const previousTimer = h.room.frameTimer;
  h.room.pressed[0] = 16;
  h.fireFrame(33);
  assert.equal(h.room.tick, 1);
  assert.equal(h.room.nextFrameDue, due);
  assert.equal(h.room.lastFrameAt, 0);
  assert.equal(h.room.pressed[0], 16);
  assert.notEqual(h.room.frameTimer, previousTimer);
  assert.equal(h.timers.get(h.room.frameTimer).at, 40);
  const rearmed = h.room.frameTimer;
  h.schedule(); h.schedule();
  assert.equal(h.room.frameTimer, rearmed);
  h.fireFrame();
  assert.equal(h.room.tick, 2);
  assert.equal(h.frames()[1].message.p1, 16);
});

test('the budget boundary permits only bounded correction and a larger delay starts a full interval', () => {
  for (const frameMs of [80, 40, 20]) {
    for (const extra of [0, 0.25]) {
      const budget = Math.min(frameMs / 8, 5);
      const h = fixture({ frameMs });
      h.schedule(); h.fireFrame(); h.ackBoth();
      const actual = frameMs + budget + extra;
      h.fireFrame(actual);
      assert.equal(h.frames().length, 2);
      assert.equal(h.room.nextFrameDue, extra === 0 ? frameMs * 2 : actual + frameMs);
      assert.equal(h.timers.get(h.room.frameTimer).delay, extra === 0 ? Math.ceil(frameMs - budget) : frameMs);
      assert.equal(h.room.pending.get(2).sentAt, actual);
    }
  }
});

test('a long event-loop stall emits one sequential frame and cannot schedule an immediate catch-up burst', () => {
  const h = fixture();
  h.schedule(); h.fireFrame(); h.ackBoth();
  h.fireFrame(1000);
  assert.deepEqual(h.frames().map(({ message, at }) => [message.tick, at]), [[1, 0], [2, 1000]]);
  assert.equal(h.room.nextFrameDue, 1040);
  assert.equal(h.timers.get(h.room.frameTimer).delay, 40);
  h.ackBoth();
  h.fireFrame();
  assert.deepEqual(h.frames().map(({ message, at }) => [message.tick, at]), [[1, 0], [2, 1000], [3, 1040]]);
});

test('two in-flight frames remain bounded by both real ACK slots and resume without burst after a slow host', () => {
  const h = fixture();
  h.schedule(); h.fireFrame(); h.fireFrame();
  assert.equal(h.room.pending.size, 2);
  assert.equal(h.room.frameTimer, undefined);
  h.ack(2, 1); h.ack(2, 2);
  assert.equal(h.room.verifiedTick, 0);
  assert.equal(h.room.pending.size, 2);
  assert.equal(h.room.frameTimer, undefined);
  assert.equal(h.room.nextFrameDue, 80);
  h.moveTo(500);
  h.ack(1, 1);
  assert.equal(h.room.verifiedTick, 1);
  assert.equal(h.room.pending.size, 1);
  assert.equal(h.timers.get(h.room.frameTimer).delay, 0);
  assert.equal(h.room.nextFrameDue, 80, 'ACK does not advance the emission grid');
  h.fireFrame();
  assert.equal(h.room.tick, 3);
  assert.equal(h.room.pending.size, 2);
  assert.equal(h.room.nextFrameDue, 540);
  assert.equal(h.room.frameTimer, undefined);
  h.ack(1, 2);
  assert.equal(h.room.verifiedTick, 2);
  assert.equal(h.timers.get(h.room.frameTimer).at, 540);
  assert.equal(h.room.pending.get(3).sentAt, 500);
  assert.deepEqual(h.acknowledgements.map(({ sentAt, receivedAt }) => [sentAt, receivedAt]),
    [[0, 40], [40, 40], [0, 500], [40, 500]]);
});

test('a configured one-frame window also waits for both ACKs and keeps actual timestamps', () => {
  const h = fixture({ maxInFlightFrames: 1 });
  h.schedule(); h.fireFrame();
  assert.equal(h.room.frameTimer, undefined);
  h.moveTo(200);
  h.ack(1);
  assert.equal(h.room.frameTimer, undefined);
  h.ack(2);
  assert.equal(h.timers.get(h.room.frameTimer).delay, 0);
  assert.equal(h.room.nextFrameDue, 40);
  h.fireFrame();
  assert.equal(h.room.tick, 2);
  assert.equal(h.room.nextFrameDue, 240);
  assert.equal(h.room.pending.get(2).sentAt, 200);
  assert.equal(h.room.frameTimer, undefined);
});

test('partial ACKs cannot renew soft or hard recovery deadlines of the actual oldest send', () => {
  const h = fixture({ maxInFlightFrames: 1, ackTimeoutMs: 100, ackRecoveryTimeoutMs: 300 });
  h.schedule(); h.fireFrame(12.5);
  h.moveTo(90.25);
  h.ack(2);
  assert.equal(h.room.pending.get(1).sentAt, 12.5);
  assert.equal(h.room.nextFrameDue, 52.5);
  const timeoutAt = h.timers.get(h.room.ackTimer).at;
  assert.ok(timeoutAt >= 112.5 && timeoutAt < 113.5);
  h.fire(h.room.ackTimer);
  assert.equal(h.room.phase, 'playing');
  assert.equal(h.room.pending.size, 1);
  assert.equal(h.room.frameTimer, undefined);
  assert.ok(h.sent.some(({ message }) => message.type === 'network_status' && message.state === 'waiting'));
  const recoveryAt = h.timers.get(h.room.ackTimer).at;
  assert.ok(recoveryAt >= 412.5 && recoveryAt < 413.5);
  h.fire(h.room.ackTimer);
  assert.equal(h.room.phase, 'paused');
  assert.equal(h.room.pending.size, 0);
  assert.equal(h.room.frameTimer, undefined);
  assert.ok(h.sent.some(({ message }) => message.type === 'paused' && message.reason === 'ack_timeout'));
});

test('input expiry uses actual elapsed time even when the emission deadline is old', () => {
  const h = fixture({ inputTimeoutMs: 600 });
  h.room.masks[0] = 1;
  h.schedule(); h.fireFrame(); h.ackBoth();
  h.room.masks[0] = 17;
  h.room.pressed[0] = h.room.released[0] = 16;
  h.fireFrame(650);
  assert.equal(h.frames()[0].message.p1, 1);
  assert.equal(h.frames()[1].message.p1, 0);
  assert.equal(h.room.pending.get(2).sentAt, 650);
  assert.equal(h.room.nextFrameDue, 690);
  assert.equal(h.room.masks[0] | h.room.pressed[0] | h.room.released[0] | h.room.applied[0], 0);
});

test('the original release-before-repress sampling remains one edge per real frame', () => {
  const h = fixture();
  h.room.masks[0] = 17;
  h.room.pressed[0] = 16;
  h.schedule(); h.fireFrame(); h.ackBoth();
  h.room.pressed[0] = h.room.released[0] = 16;
  h.fireFrame(); h.ackBoth();
  h.fireFrame();
  assert.deepEqual(h.frames().map(({ message }) => message.p1), [17, 1, 17]);
  assert.deepEqual(h.frames().map(({ message }) => message.tick), [1, 2, 3]);
});

test('the actual bounded join barrier resumes with exactly one commanded spawn and a fresh interval', () => {
  const h = fixture({ catchingUp: true });
  h.schedule(); h.fireFrame(); h.ack(1);
  h.room.masks = [17, 18];
  h.room.pressed = [16, 16];
  h.moveTo(10);
  assert.equal(h.api.beginJoinBarrier(h.room, h.peers[1], h.now()), true);
  assert.equal(h.room.frameTimer, undefined);
  assert.equal(h.room.nextFrameDue, 40);
  h.schedule();
  assert.equal(h.room.frameTimer, undefined);
  assert.deepEqual(h.room.masks, [0, 0]);
  h.moveTo(200);
  Object.assign(h.peers[1], { catchupReady: true, lastAckTick: 1, catchupSentTick: 1 });
  h.api.pumpCatchup(h.room);
  assert.equal(h.room.activePlayers, 2);
  assert.equal(h.room.joinBarrierAt, null);
  assert.equal(h.room.nextFrameDue, 40);
  assert.equal(h.timers.get(h.room.frameTimer).delay, 0);
  assert.ok(h.sent.some(({ message }) => message.type === 'caught_up' && message.tick === 1));
  assert.ok(h.sent.some(({ message }) => message.type === 'join_sync' && message.state === 'resumed' && message.joined));
  h.fireFrame();
  assert.deepEqual(h.frames()[1].message, { type: 'frame', tick: 2, p1: 0, p2: 0, join: { slot: 2, character: 3 } });
  assert.equal(h.room.nextFrameDue, 240);
  assert.equal(h.room.inputAt[1], 200);
  h.ackBoth(); h.fireFrame();
  assert.equal(h.frames()[2].message.tick, 3);
  assert.equal(h.frames()[2].message.join, undefined);
});

test('an expired join barrier resumes the solo host without moving its grid before a real emission', () => {
  const h = fixture({ catchingUp: true });
  h.schedule(); h.fireFrame(); h.ack(1);
  h.moveTo(10);
  h.api.beginJoinBarrier(h.room, h.peers[1], h.now());
  const timeout = h.peers[1].catchupBarrierTimer;
  assert.equal(h.timers.get(timeout).at, 1510);
  h.fire(timeout);
  assert.equal(h.room.activePlayers, 1);
  assert.equal(h.room.players[1], null);
  assert.equal(h.room.joinBarrierAt, null);
  assert.equal(h.room.nextFrameDue, 40);
  assert.equal(h.api.catchupCounters.failed, 1);
  assert.ok(h.sent.some(({ message }) => message.type === 'join_sync' && message.state === 'resumed' && message.joined === false));
  assert.equal(h.timers.get(h.room.frameTimer).delay, 0);
  h.fireFrame();
  assert.deepEqual(h.frames()[1].message, { type: 'frame', tick: 2, p1: 0, p2: 0 });
  assert.equal(h.room.nextFrameDue, 1550);
  assert.equal(h.timers.get(h.room.frameTimer).delay, 40);
});

test('all phase, terminal, barrier and window gates apply both before arming and inside a queued callback', () => {
  const block = [
    (room) => { room.phase = 'paused'; },
    (room) => { room.terminalTick = 1; },
    (room) => { room.joinBarrierAt = 1; },
    (room) => { room.pending.set(-1, {}); room.pending.set(-2, {}); },
  ];
  for (const prevent of block) {
    const before = fixture();
    prevent(before.room); before.schedule();
    assert.equal(before.room.frameTimer, undefined);
    assert.equal(before.room.nextFrameDue, null);
    const queued = fixture();
    queued.schedule(); queued.fireFrame(); queued.ackBoth();
    prevent(queued.room); queued.fireFrame();
    assert.equal(queued.frames().length, 1);
    assert.equal(queued.room.tick, 1);
    assert.equal(queued.room.nextFrameDue, 40);
    assert.equal(queued.room.frameTimer, undefined);
  }
});

test('a real terminal ACK stops future frames before the matching completion arrives', () => {
  const h = fixture();
  h.schedule(); h.fireFrame();
  h.ack(1, 1, { complete: 'quit' });
  assert.equal(h.room.terminalTick, 1);
  assert.equal(h.room.frameTimer, undefined);
  assert.equal(h.room.phase, 'playing');
  assert.equal(h.room.nextFrameDue, 40);
  h.moveTo(200); h.schedule();
  assert.equal(h.room.frameTimer, undefined);
  h.ack(2, 1, { complete: 'quit' });
  assert.equal(h.room.phase, 'completed');
  assert.equal(h.room.pending.size, 0);
  assert.equal(h.api.rooms.has('fixture'), false);
  h.schedule();
  assert.equal(h.room.frameTimer, undefined);
  assert.equal(h.frames().length, 1);
});

test('out-of-order ACKs cannot free pacing capacity and native mismatches still retire the room', () => {
  const reordered = fixture();
  reordered.schedule(); reordered.fireFrame(); reordered.fireFrame();
  reordered.ack(1, 2);
  assert.deepEqual(reordered.rejections.map(({ code }) => code), ['invalid_ack']);
  assert.equal(reordered.room.pending.size, 2);
  assert.equal(reordered.room.frameTimer, undefined);
  for (const [extra, reason] of [
    [{ digest: 'different-native-state' }, 'digest_mismatch'],
    [{ complete: 'quit' }, 'completion_mismatch'],
  ]) {
    const h = fixture();
    h.schedule(); h.fireFrame(); h.ack(1);
    h.ack(2, 1, extra);
    assert.equal(h.room.phase, 'paused');
    assert.equal(h.room.frameTimer, undefined);
    assert.equal(h.room.pending.size, 0);
    assert.ok(h.sent.some(({ message }) => message.type === 'paused' && message.reason === reason));
  }
});

test('the terminal sequence limit retires before emitting or advancing the pacing clock', () => {
  const h = fixture();
  h.room.tick = 2147483647;
  h.schedule(); h.fireFrame();
  assert.equal(h.room.phase, 'paused');
  assert.equal(h.room.nextFrameDue, null);
  assert.equal(h.room.lastFrameAt, -Infinity);
  assert.equal(h.frames().length, 0);
  assert.ok(h.sent.some(({ message }) => message.type === 'paused' && message.reason === 'tick_limit'));
});

test('a synchronous send failure still prevents the second recipient and any subsequent frame', () => {
  const h = fixture();
  h.setOnSend((peer, message) => {
    if (message.type === 'frame' && peer === h.peers[0]) h.api.endRoom(h.room, 'send_failed');
  });
  h.schedule(); h.fireFrame();
  assert.equal(h.room.phase, 'paused');
  assert.equal(h.sent.filter(({ message }) => message.type === 'frame').length, 1);
  assert.equal(h.room.frameTimer, undefined);
  assert.equal(h.room.pending.size, 0);
  assert.equal(h.timers.size, 0);
});
