import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createOriginalServer } from '../../apps/original-server/service.mjs';
import { normalizeRemoteAddress } from '../../apps/original-server/telemetry.mjs';
import { parseArguments } from '../../apps/original-server/index.mjs';

const CREATE = { type: 'create', swfHash: 'a'.repeat(64), mode: 'Coop', map: 'Boxy', characters: [0, 3] };
const ID1 = { type: 'identify', id: `bh_${'1'.repeat(32)}`, name: 'Иван' };
const ID2 = { type: 'identify', id: `bh_${'2'.repeat(32)}`, name: 'Player Two' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate) {
  const until = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= until) assert.fail('Timed out waiting for telemetry');
    await sleep(10);
  }
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    ws.on('error', () => {});
    ws.on('message', data => this.messages.push(JSON.parse(data.toString())));
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  async next(type) {
    await waitFor(() => this.messages.some(message => message.type === type));
    return this.messages.splice(this.messages.findIndex(message => message.type === type), 1)[0];
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, 'close');
    this.ws.close();
    await closed;
  }
}

async function fixture(t, options = {}, forwardedAddress = '8.8.8.8') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boxhead-telemetry-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Telemetry fixture</title>');
  const lines = [];
  const service = createOriginalServer({ host: '127.0.0.1', port: 0, webRoot: directory,
    shutdownGraceMs: 150, logger: line => lines.push(line), ...options });
  await service.listen();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${service.address().port}`;
  const events = name => lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .filter(record => record.event === name);
  const amp = name => lines.filter(line => line.startsWith(`BOXHEAD ${name} `));
  const connect = async (identity) => {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/original-ws`, { origin, headers: { 'X-Forwarded-For': forwardedAddress, 'X-Real-IP': forwardedAddress } });
    const client = new Client(ws);
    await once(ws, 'open');
    t.after(() => client.close());
    if (identity) client.send(identity);
    return client;
  };
  return { service, lines, events, amp, connect };
}

async function pair(f) {
  const host = await f.connect(ID1);
  host.send(CREATE);
  const invitation = await host.next('joined');
  const guest = await f.connect(ID2);
  guest.send({ type: 'join', room: invitation.room, token: invitation.token, swfHash: CREATE.swfHash });
  await guest.next('joined');
  await host.next('peer');
  host.send({ type: 'start' });
  await Promise.all([host.next('prepare'), guest.next('prepare')]);
  host.send({ type: 'ready' }); guest.send({ type: 'ready' });
  const frames = await Promise.all([host.next('frame'), guest.next('frame')]);
  assert.deepEqual(frames[0], frames[1]);
  return { host, guest, invitation, tick: frames[0].tick };
}

async function solo(f, identity = ID1) {
  const client = await f.connect(identity);
  client.send({ ...CREATE, dropIn: true });
  const invitation = await client.next('joined');
  client.send({ type: 'start' });
  await client.next('prepare');
  client.send({ type: 'ready' });
  const frame = await client.next('frame');
  client.send({ type: 'ack', tick: frame.tick, digest: 'native-1' });
  await waitFor(() => f.events('player_started').some(row => row.player_id === identity.id));
  return { client, invitation };
}

test('AMP player sessions start after peer agreement and end once with secret-free operator logs', async t => {
  const f = await fixture(t);
  const p = await pair(f);
  assert.equal(f.amp('PLAYER_JOIN').length, 0);
  assert.equal(f.events('room_player_joined').length, 2);
  assert.ok(f.lines.includes('BOXHEAD: Иван занял слот 1.'));
  assert.ok(f.lines.includes('BOXHEAD: Player Two занял слот 2.'));
  assert.equal(f.lines.filter(line => line.includes('первый кадр подтверждён')).length, 0);
  p.host.send({ type: 'ack', tick: p.tick, digest: 'same-native-state' });
  await sleep(30);
  assert.equal(f.amp('PLAYER_JOIN').length, 0, 'one client ACK must not establish agreed play');
  p.guest.send({ type: 'ack', tick: p.tick, digest: 'same-native-state' });
  await waitFor(() => f.amp('PLAYER_JOIN').length === 2);
  assert.ok(f.lines.includes('BOXHEAD: Иван начал игру: первый кадр подтверждён.'));
  assert.ok(f.lines.includes('BOXHEAD: Player Two начал игру: первый кадр подтверждён.'));
  await p.host.close();
  await waitFor(() => f.amp('PLAYER_LEAVE').length === 2);
  await p.guest.close();
  await f.service.close();
  assert.equal(f.amp('PLAYER_LEAVE').length, 2);
  const ended = f.events('player_session_ended');
  assert.equal(ended.length, 2);
  assert.ok(ended.every(row => row.played && row.first_verified_tick === 1 && row.last_verified_tick === 1));
  assert.ok(ended.every(row => row.reason === 'peer_disconnected' && row.native_ack_latency.samples === 1));
  assert.ok(ended.find(row => row.player_id === ID2.id).native_ack_latency.last_ms >= 20);
  assert.equal(f.lines.join('\n').includes(p.invitation.token), false);
  assert.equal(f.lines.join('\n').includes(p.invitation.room), false);
  const human = f.lines.filter(line => line.startsWith('BOXHEAD: '));
  assert.ok(human.some(line => line.includes('игра закончена (игрок отключился)')));
  assert.ok(human.every(line => !line.includes(ID1.id) && !line.includes(ID2.id)));

  const text = await readFile(new URL('../../tools/amp/boxhead-console-overrides.kvp', import.meta.url), 'utf8');
  const kvp = Object.fromEntries(text.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const join = new RegExp(kvp['Console.UserJoinRegex']);
  const leave = new RegExp(kvp['Console.UserLeaveRegex']);
  for (const identity of [ID1, ID2]) {
    const joined = f.amp('PLAYER_JOIN').map(line => join.exec(line)).find(match => match?.groups.userid === identity.id);
    const left = f.amp('PLAYER_LEAVE').map(line => leave.exec(line)).find(match => match?.groups.userid === identity.id);
    assert.ok(joined && left);
    assert.equal(joined.groups.username, left.groups.username);
    assert.ok(joined.groups.username.startsWith(identity.name));
  }
  assert.ok(new RegExp(kvp['Console.AppReadyRegex']).test(f.amp('READY')[0]));
});

test('failed native agreement never creates a played Analytics session', async t => {
  const f = await fixture(t);
  const p = await pair(f);
  p.host.send({ type: 'ack', tick: p.tick, digest: 'host-state' });
  p.guest.send({ type: 'ack', tick: p.tick, digest: 'guest-state' });
  assert.equal((await p.host.next('paused')).reason, 'digest_mismatch');
  assert.equal((await p.guest.next('paused')).reason, 'digest_mismatch');
  assert.equal(f.amp('PLAYER_JOIN').length, 0);
  assert.equal(f.amp('PLAYER_LEAVE').length, 0);
  assert.ok(f.lines.some(line => line.includes('состояния игры разошлись')));
  assert.equal(f.lines.filter(line => line.includes('первый кадр подтверждён')).length, 0);
  assert.ok(f.events('player_session_ended').every(row => !row.played && row.played_ms === 0));
});

test('failed guest loading is an attempt, preserves the solo host and does not add Analytics playtime', async t => {
  const f = await fixture(t);
  const host = await solo(f);
  const guest = await f.connect(ID2);
  guest.send({ type: 'join', room: host.invitation.room, token: host.invitation.token, swfHash: CREATE.swfHash });
  await guest.next('prepare');
  await guest.close();
  await waitFor(() => f.events('player_session_ended').some(row => row.player_id === ID2.id));
  assert.equal(f.service.stats().rooms, 1);
  assert.equal(f.amp('PLAYER_JOIN').length, 1);
  assert.equal(f.amp('PLAYER_LEAVE').length, 0);
  const ended = f.events('player_session_ended').find(row => row.player_id === ID2.id);
  assert.equal(ended.played, false);
  assert.equal(ended.reason, 'peer_disconnected');
  assert.equal(f.events('catchup_failed').length, 1);
  assert.ok(f.lines.some(line => line.includes('Не удалось синхронизировать гостя')));
  assert.ok(f.lines.some(line => line.includes('вход завершён до начала игры')));
});

test('overlapping sessions from one browser retain a single AMP user until its final session ends', async t => {
  const f = await fixture(t);
  const first = await solo(f);
  const second = await solo(f, { ...ID1, name: 'Same Browser' });
  await waitFor(() => f.events('player_started').length === 2);
  assert.equal(f.amp('PLAYER_JOIN').length, 1);
  await first.client.close();
  await waitFor(() => f.events('player_session_ended').length === 1);
  assert.equal(f.amp('PLAYER_LEAVE').length, 0);
  await second.client.close();
  await waitFor(() => f.amp('PLAYER_LEAVE').length === 1);
  assert.equal(f.amp('PLAYER_JOIN')[0].replace(/ endpoint=\S+/, '').replace('PLAYER_JOIN', 'PLAYER_LEAVE'), f.amp('PLAYER_LEAVE')[0]);
});

test('status reports real websocket RTT separately from ACK latency and supplies numeric AMP metrics', async t => {
  const f = await fixture(t);
  const client = await f.connect(ID1);
  await waitFor(() => f.events('client_identified').length === 1);
  await sleep(30);
  f.service.consoleCommand('players');
  const status = f.events('player_status').at(-1);
  assert.equal(status.websocket_rtt.samples, 1);
  assert.ok(status.websocket_rtt.last_ms >= 0);
  assert.equal(status.native_ack_latency.samples, 0);
  client.ws.pong(Buffer.from('unsolicited'));
  await sleep(20);
  f.service.consoleCommand('players');
  assert.equal(f.events('player_status').at(-1).websocket_rtt.samples, 1);
  f.service.consoleCommand('status');
  const summary = f.events('server_status').at(-1);
  assert.equal(summary.connections, 1);
  assert.equal(summary.unique_playing_users, 0);
  assert.ok(summary.rss_mib > 0);
  assert.ok(summary.process_cpu_percent >= 0);
  const text = await readFile(new URL('../../tools/amp/boxhead-console-overrides.kvp', import.meta.url), 'utf8');
  const pattern = text.split('\n').find(line => line.startsWith('Console.MetricsRegex=')).split('=').slice(1).join('=');
  const match = new RegExp(pattern).exec(f.amp('METRICS').at(-1));
  assert.ok(match);
  assert.equal(Number(match.groups.Connections), 1);
  assert.equal(Number(match.groups.Playing_Users), 0);
  assert.ok(Object.values(match.groups).every(value => Number.isFinite(Number(value))));
  f.service.consoleCommand('pasted-secret-token');
  assert.equal(f.lines.join('\n').includes('pasted-secret-token'), false);
  assert.ok(f.lines.some(line => line.startsWith('BOXHEAD: Неизвестная команда.')));
  assert.ok(f.lines.some(line => line.startsWith('BOXHEAD: Состояние:')));
});

test('identity metadata is bounded, cannot forge log lines and cannot change an active identity', async t => {
  const f = await fixture(t);
  for (const identity of [
    { ...ID1, name: 'Ivan\nBOXHEAD PLAYER_JOIN userid=forged username=fake' },
    { ...ID1, name: 'A'.repeat(33) }, { ...ID1, id: 'not-a-browser-id' },
    { ...ID1, name: '<script>' }, { ...ID1, token: 'unexpected' },
  ]) {
    const client = await f.connect(identity);
    assert.equal((await client.next('error')).code, 'invalid_identity');
    assert.ok(f.lines.includes('BOXHEAD: Клиент отклонён (недопустимое имя или профиль).'));
  }
  const client = await f.connect(ID1);
  client.send({ ...ID2 });
  assert.equal((await client.next('error')).code, 'identity_locked');
  assert.equal(f.events('client_identified').length, 1);
  assert.equal(f.amp('PLAYER_JOIN').length, 0);
  assert.equal(f.lines.join('\n').includes('userid=forged'), false);
});

test('graceful shutdown closes all tracked player sessions before server_stopped', async t => {
  const f = await fixture(t);
  await solo(f);
  await f.service.close();
  assert.equal(f.amp('PLAYER_LEAVE').length, 1);
  assert.equal(f.events('player_session_ended')[0].reason, 'server_shutdown');
  assert.ok(f.lines.findIndex(line => line.startsWith('BOXHEAD PLAYER_LEAVE '))
    < f.lines.findIndex(line => line.includes('"event":"server_stopped"')));
});

test('metrics interval is explicit and rejects unsafe or ambiguous configuration', () => {
  assert.equal(parseArguments([], { METRICS_INTERVAL_MS: '45000' }).metricsIntervalMs, 45000);
  assert.equal(parseArguments(['--metrics-interval-ms', '60000'], {}).metricsIntervalMs, 60000);
  for (const value of ['0', '999', '3600001', '-1', '1.5', '30000;cmd']) {
    assert.throws(() => parseArguments([], { METRICS_INTERVAL_MS: value }));
  }
  assert.throws(() => createOriginalServer({ metricsIntervalMs: 0 }), /Invalid metricsIntervalMs/);
  assert.throws(() => createOriginalServer({ logger: null }), /Invalid log writer/);
});

test('foreground entrypoint accepts AMP STDIN commands and exits cleanly on SIGTERM', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boxhead-amp-console-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>AMP console fixture</title>');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../apps/original-server/index.mjs', import.meta.url)),
    '--host', '127.0.0.1', '--port', '0', '--web-root', directory], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, METRICS_INTERVAL_MS: '30000' },
  });
  const exited = once(child, 'close');
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { errors += data.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  await waitFor(() => output.includes('"event":"original_lockstep_listening"'));
  child.stdin.write('players\nrooms\nstatus\nhelp\npasted-private-secret\n');
  await waitFor(() => output.includes('"event":"console_unknown_command"'));
  assert.ok(output.includes('"event":"player_count"'));
  assert.ok(output.includes('"event":"room_count"'));
  assert.ok(output.includes('BOXHEAD METRICS '));
  assert.ok(output.includes('BOXHEAD CONSOLE commands: status, players, rooms, help'));
  assert.equal(output.includes('pasted-private-secret'), false);
  child.stdin.end();
  await sleep(25);
  assert.equal(child.exitCode, null, 'EOF must not stop the foreground game service');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0, errors);
  assert.equal(signal, null);
  assert.ok(output.includes('"event":"server_stopped"'));
});

test('a closed STDOUT pipe does not crash the foreground game service', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boxhead-amp-closed-console-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>AMP closed console</title>');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../apps/original-server/index.mjs', import.meta.url)),
    '--host', '127.0.0.1', '--port', '0', '--web-root', directory], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, METRICS_INTERVAL_MS: '30000' },
  });
  const exited = once(child, 'close');
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { errors += data.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  await waitFor(() => output.includes('"event":"original_lockstep_listening"'));
  const address = JSON.parse(output.split('\n').find(line => line.includes('"event":"original_lockstep_listening"')));
  child.stdout.destroy();
  child.stdin.write('status\nplayers\nrooms\n');
  await sleep(75);
  assert.equal(child.exitCode, null, errors);
  assert.equal(child.signalCode, null, errors);
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200, 'the server still serves the game after console failure');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0, errors);
  assert.equal(signal, null);
  assert.equal(errors.includes('Unhandled'), false);
});


test('transport IP validation canonicalizes IPv4-mapped IPv6 and rejects unsafe text', () => {
  assert.equal(normalizeRemoteAddress('::ffff:192.0.2.25'), '192.0.2.25');
  assert.equal(normalizeRemoteAddress('2001:DB8::1'), '2001:db8::1');
  assert.equal(normalizeRemoteAddress('::1'), '::1');
  for (const bad of [null, 'ip=8.8.8.8', '1.2.3.4\nINJECTED', '999.0.0.1', '']) assert.equal(normalizeRemoteAddress(bad), null);
});

test('AMP receives the socket IP after verified play, ignoring spoofed forwarding headers', async t => {
  const f = await fixture(t);
  await solo(f);
  await waitFor(() => f.amp('PLAYER_JOIN').length === 1);
  assert.ok(f.amp('PLAYER_JOIN')[0].includes(' endpoint=127.0.0.1 '));
  const config = await readFile(new URL('../../tools/amp/boxhead-console-overrides.kvp', import.meta.url), 'utf8');
  const regex = new RegExp(config.split('\n').find(line => line.startsWith('Console.UserJoinRegex=')).slice('Console.UserJoinRegex='.length));
  assert.equal(regex.exec(f.amp('PLAYER_JOIN')[0]).groups.endpoint, '127.0.0.1');
});

test('AMP receives the actual forwarded client after verified play through a trusted proxy', async t => {
  const f = await fixture(t, { trustedProxyIPs: ['127.0.0.1'] }, '203.0.113.99, 198.51.100.8');
  await solo(f);
  await waitFor(() => f.amp('PLAYER_JOIN').length === 1);
  assert.ok(f.amp('PLAYER_JOIN')[0].includes(' endpoint=198.51.100.8 '));
  assert.ok(!f.amp('PLAYER_JOIN')[0].includes('203.0.113.99'));
});
