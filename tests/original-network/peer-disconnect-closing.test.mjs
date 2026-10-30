import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createOriginalServer } from '../../apps/original-server/service.mjs';
import { restorePeerDisconnectClosingSource } from './fixtures/peer-disconnect-source.mjs';

const SWF_HASH = 'a'.repeat(64);
const CREATE = { type: 'create', swfHash: SWF_HASH, mode: 'Coop', map: 'Boxy', characters: [0, 3] };

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    this.onPaused = null;
    this.closed = new Promise(resolve => ws.once('close', code => resolve(code)));
    ws.on('error', () => {});
    ws.on('message', bytes => {
      const value = JSON.parse(bytes.toString());
      const index = this.waiters.findIndex(row => row.type === value.type);
      if (index < 0) this.messages.push(value);
      else {
        const [row] = this.waiters.splice(index, 1);
        clearTimeout(row.timer);
        row.resolve(value);
      }
      // Send in the actual WebSocket message callback, before the following
      // close frame is consumed. This deterministically represents a final
      // native ACK/input already queued when paused reaches the application.
      if (value.type === 'paused') this.onPaused?.(value);
    });
  }

  send(value) { this.ws.send(JSON.stringify(value)); }

  next(type, timeout = 2000) {
    const index = this.messages.findIndex(row => row.type === type);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const row = { type, resolve, timer: undefined };
      row.timer = setTimeout(() => {
        const index = this.waiters.indexOf(row);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for ' + type));
      }, timeout);
      this.waiters.push(row);
    });
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'test_complete');
    return this.closed;
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boxhead-peer-close-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Peer close fixture</title>');
  const lines = [], clients = [];
  const service = createOriginalServer({ host: '127.0.0.1', port: 0, webRoot: directory,
    maxInFlightFrames: 1, shutdownGraceMs: 300, logger: line => lines.push(line) });
  await service.listen();
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + service.address().port;
  return {
    service,
    events: name => lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .filter(row => row.event === name),
    connect: async () => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/original-ws', { origin });
      const client = new Client(ws); clients.push(client);
      await once(ws, 'open');
      return client;
    },
  };
}

async function pair(f) {
  const host = await f.connect(); host.send(CREATE);
  const invitation = await host.next('joined');
  const guest = await f.connect();
  guest.send({ type: 'join', room: invitation.room, token: invitation.token, swfHash: SWF_HASH });
  await guest.next('joined'); await host.next('peer');
  host.send({ type: 'start' });
  await Promise.all([host.next('prepare'), guest.next('prepare')]);
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  const [first, second] = await Promise.all([host.next('frame'), guest.next('frame')]);
  assert.deepEqual(first, { type: 'frame', tick: 1, p1: 0, p2: 0 });
  assert.deepEqual(second, first);
  return { host, guest };
}

test('peer retirement provenance remains bound to the original reviewed revision', async () => {
  const source = readFileSync(new URL('./fixtures/baseline-service.mjs.txt', import.meta.url), 'utf8');
  restorePeerDisconnectClosingSource(source);
});

for (const [departing, lateMessage] of [
  ['host', { type: 'ack', tick: 1, digest: 'native-1' }],
  ['host', CREATE],
]) {
  test('retired peer closes normally when ' + departing + ' leaves before queued ' + lateMessage.type,
    { timeout: 5000 }, async t => {
      const f = await fixture(t), players = await pair(f);
      const survivor = players[departing === 'host' ? 'guest' : 'host'];
      const first = players[departing];
      // A valid pending tick exists at retirement; the late ACK must not
      // resurrect it, release new credit, or count as native agreement.
      first.send({ type: 'ack', tick: 1, digest: 'native-1' });
      let attempted = 0;
      survivor.onPaused = paused => {
        assert.equal(paused.reason, 'peer_disconnected');
        assert.equal(survivor.ws.readyState, WebSocket.OPEN);
        attempted += 1;
        survivor.send(lateMessage);
      };
      assert.equal(await first.close(), 1000);
      assert.deepEqual(await survivor.next('paused'), {
        type: 'paused', reason: 'peer_disconnected', tick: 1, p1: 0, p2: 0,
      });
      assert.equal(await survivor.closed, 1000);
      assert.equal(attempted, 1);
      assert.equal(f.service.stats().rooms, 0);
      assert.equal(f.events('client_rejected').length, 0);
      assert.equal(f.events('player_started').length, 0, 'A discarded terminal ACK cannot establish play');
      assert.equal(f.events('room_created').length, 1, 'Closing transport cannot create a replacement room');
      assert.equal(survivor.messages.some(row => row.type === 'error' || row.type === 'frame'), false);
    });
}

test('an active room still rejects a skipped native ACK and pauses its peer', { timeout: 5000 }, async t => {
  const f = await fixture(t), players = await pair(f);
  players.guest.send({ type: 'ack', tick: 2, digest: 'native-2' });
  assert.equal((await players.guest.next('error')).code, 'invalid_ack');
  assert.equal(await players.guest.closed, 1008);
  assert.equal((await players.host.next('paused')).reason, 'protocol_error');
  assert.equal(f.events('client_rejected').filter(row => row.reason === 'invalid_ack').length, 1);
  assert.equal(f.service.stats().rooms, 0);
});

test('an ordinary unbound connection cannot submit a native ACK', { timeout: 5000 }, async t => {
  const f = await fixture(t), client = await f.connect();
  client.send({ type: 'ack', tick: 1, digest: 'native-1' });
  assert.equal((await client.next('error')).code, 'invalid_ack');
  assert.equal(await client.closed, 1008);
  assert.equal(f.service.stats().rooms, 0);
});

test('a loading guest disconnect leaves the solo host open with its next frame', { timeout: 5000 }, async t => {
  const f = await fixture(t), host = await f.connect();
  host.send({ ...CREATE, dropIn: true });
  const invitation = await host.next('joined');
  host.send({ type: 'start' }); await host.next('prepare');
  host.send({ type: 'ready' });
  assert.equal((await host.next('frame')).tick, 1);
  const guest = await f.connect();
  guest.send({ type: 'join', room: invitation.room, token: invitation.token, swfHash: SWF_HASH });
  await guest.next('joined'); await guest.next('prepare');
  assert.equal(await guest.close(), 1000);
  assert.equal(host.ws.readyState, WebSocket.OPEN);
  host.send({ type: 'ack', tick: 1, digest: 'native-1' });
  assert.equal((await host.next('frame')).tick, 2);
  assert.equal(f.service.stats().rooms, 1);
  assert.equal(f.service.catchupStats().failed, 1);
  assert.equal(host.messages.some(row => row.type === 'paused' || row.type === 'error'), false);
});
