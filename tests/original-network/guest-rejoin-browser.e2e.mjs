import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createOriginalServer } from '../../apps/original-server/service.mjs';

// Run against a disposable local server and independently launched browsers.
// The application alone prepares and steps the world, sends input and ACKs.
// Native gameplay evidence is observed from the actual digest and receipt callbacks.
// Do not inject a read callback into an in-flight native transaction.
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const webRoot = path.resolve(option('--web-root', 'dist/original-web'));
const out = path.resolve(option('--out', 'tmp/guest-rejoin-' + Date.now()));
const chrome = option('--chrome', process.env.CHROME_BIN || process.env.CHROME_PATH || '');
const mode = option('--mode', 'Coop');
const initialPlayers = Number(option('--initial-players', '1'));
assert(['Coop', 'DeathMatch'].includes(mode) && [1, 2].includes(initialPlayers), 'Invalid mode or initial player count');
const deadline = Date.now() + Number(option('--timeout-ms', '300000'));
await mkdir(out, { recursive: false });
const report = { pass: false, stage: 'setup', checks: [], errors: [], clients: [],
  limits: ['Independent local Chromium processes, not a WAN test.',
    'WebSocket ACKs and native graphs/receipts are observed passively; this is not a full gameplay campaign or FPS test.'] };
report.mode = mode; report.initialPlayers = initialPlayers;
if (initialPlayers === 2) report.limits.push('The real host start message is delayed until the real guest has joined the lobby; its contents are unchanged.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
report.swfSha256 = sha(await readFile(path.join(webRoot, 'Boxhead_2Play.online.swf')));
report.webAssets = {};
for (const name of (await readdir(path.join(webRoot, 'assets'))).filter(name => name.endsWith('.js')).sort()) {
  report.webAssets[name] = sha(await readFile(path.join(webRoot, 'assets', name)));
}
report.limits.push('Source hashes identify the server/test working tree; web asset hashes identify the independently selected compiled client.');
report.sourceSha256 = {};
for (const file of ['apps/original-server/service.mjs', 'apps/original-web/src/session.ts',
  'apps/original-web/src/protocol.ts', 'apps/original-web/src/bridge.ts', 'apps/original-web/src/native-snapshot-export.ts']) {
  report.sourceSha256[file] = sha(await readFile(file));
}
const browsers = [], pages = [], wire = [];
let pilotRunning = false, pilotTask;
const service = createOriginalServer({ host: '127.0.0.1', port: 0, webRoot, shutdownGraceMs: 300 });
let fatal;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const end = Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) {
    if (fatal) throw fatal;
    for (const page of pages) if (page && !page.isClosed() && await page.locator('#status').getAttribute('data-state').catch(() => null) === 'error') {
      throw new Error('Application stopped: ' + await page.locator('#status').innerText());
    }
    const result = await fn(); if (result) return result;
    await sleep(80);
  }
  throw new Error('Timeout: ' + label);
}
async function read(index, name) {
  return pages[index].evaluate(name => {
    try {
      const result = document.querySelector('#original-ruffle-player')?.ruffle().callExternalInterface(name);
      return typeof result === 'string' ? JSON.parse(result) : result;
    } catch { return null; }
  }, name);
}
async function click(index, name) {
  const info = await read(index, 'bhInfo'), bounds = info?.menuBounds?.[name];
  assert(bounds?.width > 0 && bounds?.height > 0, 'Missing native control: ' + name);
  const stage = await pages[index].locator('#stage').boundingBox(); assert(stage);
  await pages[index].mouse.click(stage.x + (bounds.x + bounds.width / 2) * stage.width / 640,
    stage.y + (bounds.y + bounds.height / 2) * stage.height / 480);
}
async function open(index, origin) {
  const browser = await chromium.launch({ executablePath: chrome || undefined, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  browsers[index] = browser;
  const context = await browser.newContext({ viewport: { width: 920, height: 760 }, serviceWorkers: 'block' });
  const page = await context.newPage(); pages[index] = page;
  const state = wire[index] = { acks: [], frames: [], inputs: [], rooms: [], errors: [], joined: null, prepare: null };
  page.on('pageerror', error => { fatal ??= error; });
  page.on('console', message => {
    if (message.type() === 'error' || /panic|unsafe guest|native.*error/i.test(message.text())) {
      (report.browserConsole ??= []).push({ client: index + 1, text: message.text().slice(0, 2000) });
    }
  });
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/original-ws') return;
    function observe(event, sent) {
      let m; try { m = JSON.parse(String(event.payload)); } catch { return; }
      if (sent && m.type === 'ack') state.acks.push({ tick: m.tick, digest: m.digest, complete: m.complete });
      if (sent && m.type === 'input') state.inputs.push({ seq: m.seq, mask: m.mask });
      if (!sent && m.type === 'joined') state.joined = { room: m.room, slot: m.slot };
      if (!sent && m.type === 'rooms') state.rooms = m.rooms;
      if (!sent && m.type === 'prepare') state.prepare = m;
      if (!sent && m.type === 'caught_up') state.caughtUp = m.tick;
      if (!sent && m.type === 'frame') state.frames.push(m);
      if (!sent && m.type === 'replay_frames') state.frames.push(...m.frames);
      if (!sent && ['error', 'paused', 'completed'].includes(m.type)) state.errors.push({ type: m.type, reason: m.reason, tick: m.tick });
    }
    socket.on('framesent', event => observe(event, true));
    socket.on('framereceived', event => observe(event, false));
  });
  await page.addInitScript(() => {
    const seen = new WeakSet(), captures = new Map();
    const evidence = window.__passiveNative = { samples: [], errors: [], calls: [] };
    function install() {
      const player = document.querySelector('#original-ruffle-player');
      if (!player || typeof player.ruffle !== 'function' || seen.has(player)) return;
      seen.add(player);
      const digest = window.boxheadDigestOriginalState;
      if (typeof digest !== 'function') { evidence.errors.push('native digest helper unavailable'); return; }
      window.boxheadDigestOriginalState = function(native, metadata) {
        const result = Reflect.apply(digest, this, [native, metadata]);
        if (metadata && typeof metadata.token === 'string') {
          if (!native || native.tick !== metadata.tick || native.scope !== metadata.scope || !result?.digest) {
            evidence.errors.push('actual digest graph, request or result invalid');
          } else captures.set(metadata.token, { tick: metadata.tick, epoch: metadata.epoch,
            scope: metadata.scope, digest: result.digest, actualGraph: true,
            hud: native.hud === undefined ? undefined : { deaths1: native.hud.mPlayer1_Deaths, deaths2: native.hud.mPlayer2_Deaths } });
        }
        return result;
      };
      const original = player.ruffle;
      player.ruffle = function (...args) {
        const api = Reflect.apply(original, this, args);
        return new Proxy(api, { get(target, key) {
          const member = Reflect.get(target, key, target);
          if (key !== 'callExternalInterface') return typeof member === 'function' ? member.bind(target) : member;
          return function(name, ...parameters) {
            let raw;
            try { raw = Reflect.apply(member, target, [name, ...parameters]); }
            catch (error) { evidence.calls.push({name, parameters, thrown: String(error)}); throw error; }
            let inspected = raw;
            if (typeof raw === 'string') { try { inspected = JSON.parse(raw); } catch {} }
            evidence.calls.push({ name, parameters, result: inspected && typeof inspected === 'object' ? {state: inspected.state, error: inspected.error, tick: inspected.tick} : inspected });
            if (evidence.calls.length > 100) evidence.calls.shift();
            if (name === 'bhStateReceipt') {
              let receipt = raw; if (typeof receipt === 'string') { try { receipt = JSON.parse(receipt); } catch {} }
              const capture = captures.get(parameters[0]);
              if (!capture || !receipt || receipt.token !== parameters[0] || receipt.epoch !== parameters[1] ||
                  receipt.tick !== parameters[2] || receipt.tick !== capture.tick || receipt.epoch !== capture.epoch ||
                  receipt.scope !== capture.scope || receipt.header?.digest !== capture.digest) {
                evidence.errors.push('actual receipt does not bind the captured native graph');
              } else {
                evidence.samples.push({ tick: capture.tick, digest: capture.digest, scope: capture.scope,
                  players: structuredClone(receipt.header.players), actualGraph: true, hud: capture.hud });
                if (evidence.samples.length > 512) evidence.samples.shift();
              }
              captures.delete(parameters[0]);
            }
            return raw;
          };
        }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
      };
    }
    new MutationObserver(install).observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', install, { once: true });
  });
  if (index === 0 && initialPlayers === 2) await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    let held;
    WebSocket.prototype.send = function (data) {
      let message; try { message = JSON.parse(data); } catch { /* normal transport */ }
      if (message?.type === 'start' && !held) { held = { socket: this, data }; return; }
      return Reflect.apply(send, this, [data]);
    };
    window.__releaseOriginalStart = () => {
      if (!held || held.socket.readyState !== WebSocket.OPEN) throw new Error('Original start was not held on an open socket');
      const item = held; held = null; Reflect.apply(send, item.socket, [item.data]);
    };
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await until(async () => (await read(index, 'bhInfo'))?.menuReady, 'native menu client ' + index, 90000);
  const stage = await page.locator('#stage').boundingBox();
  if (stage) await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  const modal = page.locator('#original-ruffle-player #hardware-acceleration-modal');
  if (await modal.isVisible()) await modal.locator('.close-modal').click({ noWaitAfter: true });
  await page.mouse.move(4, 4);
  await click(index, 'online');
  await until(async () => (await read(index, 'bhInfo'))?.menuState === 'online', 'online home');
  report.clients[index] = { browserVersion: browser.version() };
}
async function claimRoom(index, room) {
  await click(index, 'rooms');
  const row = await until(() => { const i = wire[index].rooms.findIndex(v => v.room === room); return i >= 0 ? i + 1 : 0; }, 'same room listed');
  const number = row - 1;
  for (let i = 0; i < Math.floor(number / 6); i++) await click(index, 'next');
  await click(index, 'room' + number % 6);
  await until(() => wire[index].joined?.room === room, 'guest joined same room');
}
async function join(index, room) {
  await claimRoom(index, room);
  await until(() => wire[index].caughtUp !== undefined && wire[index].frames.some(frame => frame.join && frame.tick > wire[index].caughtUp), 'guest native spawn', 180000);
  const frame = wire[index].frames.find(f => f.join && f.tick > wire[index].caughtUp);
  await until(() => wire[0].acks.some(a => a.tick >= frame.tick + 10) && wire[index].acks.some(a => a.tick >= frame.tick + 10), 'paired ACKs', 30000);
  for (let tick = frame.tick; tick <= frame.tick + 10; tick++) {
    const first = wire[0].acks.find(a => a.tick === tick), second = wire[index].acks.find(a => a.tick === tick);
    assert(first && second && first.digest === second.digest && first.complete === second.complete, 'Native ACK mismatch at ' + tick);
  }
  return frame.tick;
}
async function physicalGuestMovement(index) {
  const before = wire[index].inputs.at(-1)?.seq ?? -1;
  const beforeTick = wire[index].acks.at(-1)?.tick ?? 0;
  await pages[index].locator('#stage').focus();
  await pages[index].keyboard.down('KeyD');
  try {
    const input = await until(() => wire[index].inputs.find(row => row.seq > before && (row.mask & 8) !== 0), 'trusted guest movement input');
    const frame = await until(() => wire[index].frames.find(row => (row.p2 & 8) !== 0 && row.tick > beforeTick), 'guest movement frame');
    const guestAck = await until(() => wire[index].acks.find(row => row.tick === frame.tick), 'guest movement native ACK');
    const hostAck = await until(() => wire[0].acks.find(row => row.tick === frame.tick), 'host movement native ACK');
    assert.equal(guestAck.digest, hostAck.digest, 'Movement diverged between native worlds');
    return { inputSequence: input.seq, tick: frame.tick, digest: guestAck.digest };
  } finally { await pages[index].keyboard.up('KeyD'); }
}
async function nativeSample(index) {
  return until(async () => {
    const evidence = await pages[index].evaluate(() => window.__passiveNative);
    assert.deepEqual(evidence.errors, [], 'Passive native receipt observation failed');
    const sample = [...evidence.samples].reverse().find(row => wire[index].acks.some(a => a.tick === row.tick));
    if (!sample) return null;
    assert.equal(sample.digest, wire[index].acks.find(a => a.tick === sample.tick).digest);
    return sample;
  }, 'passively captured native receipt tied to ACK', 30000);
}

function startHostPilot() {
  pilotRunning = true;
  pilotTask = (async () => {
    const directions = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
    let index = 0;
    while (pilotRunning) {
      const direction = directions[index++ % directions.length];
      await pages[0].keyboard.down(direction);
      for (let n = 0; n < 3 && pilotRunning; n++) {
        await pages[0].keyboard.down('Space'); await sleep(180);
        await pages[0].keyboard.up('Space'); await sleep(180);
      }
      await pages[0].keyboard.up(direction);
    }
  })().catch(error => { fatal ??= error; });
}
try {
  await service.listen();
  const origin = 'http://127.0.0.1:' + service.address().port;
  report.stage = 'host'; await open(0, origin);
  await click(0, mode === 'Coop' ? 'coop' : 'deathmatch'); await until(async () => (await read(0, 'bhInfo'))?.menuBounds?.level, 'map');
  await click(0, 'options'); await until(async () => (await read(0, 'bhInfo'))?.menuBounds?.optionDamageOn, 'options');
  for (const name of ['optionDifficultyBeginner', 'optionDamageOn', 'optionSpeedNormal']) await click(0, name);
  await click(0, 'optionsClose');
  // Warm the first independent browser before starting the world so that
  // browser startup does not consume the host's original invincibility.
  report.stage = 'first guest browser'; await open(1, origin);
  report.stage = 'host starts'; await click(0, 'level');
  if (initialPlayers === 2) {
    await until(() => wire[0].joined, 'host room before the held start');
    await claimRoom(1, wire[0].joined.room);
    await pages[0].evaluate(() => window.__releaseOriginalStart());
  }
  await until(() => wire[0].acks.length >= 3 && wire[0].joined, 'host initial native frames', 180000);
  assert.deepEqual(wire[0].prepare.settings, { difficulty: 0, speed: 1, devils: 1, collisions: 1, damage: 1, gameAmount: 1 },
    'Original match must retain damage, devils and collisions');
  report.settings = wire[0].prepare.settings;
  assert.equal(wire[0].prepare.initialPlayers, initialPlayers);
  assert.equal(wire[0].prepare.mode, mode);
  await pages[0].locator('#stage').focus(); startHostPilot();
  const room = wire[0].joined.room;
  report.stage = 'first guest';
  let firstJoin;
  if (initialPlayers === 1) firstJoin = await join(1, room);
  else {
    await until(() => wire[0].acks.some(a => a.tick >= 11) && wire[1].acks.some(a => a.tick >= 11), 'initial pair ACKs', 180000);
    for (let tick = 1; tick <= 11; tick++) {
      const hostAck = wire[0].acks.find(a => a.tick === tick), guestAck = wire[1].acks.find(a => a.tick === tick);
      assert(hostAck && guestAck && hostAck.digest === guestAck.digest && hostAck.complete === guestAck.complete, 'Initial native mismatch at ' + tick);
    }
    firstJoin = 1;
  }
  report.firstJoin = { tick: firstJoin, host: await nativeSample(0), guest: await nativeSample(1) };
  assert.equal((await until(() => wire[0].acks.find(a => a.tick === report.firstJoin.guest.tick), 'host ACK for first guest snapshot')).digest,
    report.firstJoin.guest.digest, 'Host ACK differs from first guest native snapshot');
  assert(report.firstJoin.host.players.some(player => player.slot === 1 && player.life > 0), 'Host died before guest exit');
  assert(report.firstJoin.guest.players.some(player => player.slot === 2 && player.life > 0), 'First guest is not alive before exit');
  report.firstMovement = await physicalGuestMovement(1);
  if (mode === 'DeathMatch') {
    for (let index = 0; index < 2; index++) {
      await pages[index].locator('#stage').screenshot({ path: path.join(out, `deathmatch-player-${index + 1}.png`) });
    }
  }
  report.checks.push('First guest joined; eleven paired ACKs match and native snapshots match ACKs');
  report.stage = 'guest leaves'; await browsers[1].close();
  const afterClose = wire[0].acks.at(-1).tick;
  await until(() => {
    if (wire[0].errors.length) throw new Error('Host stopped on guest exit: ' + JSON.stringify(wire[0].errors));
    return wire[0].acks.at(-1)?.tick >= afterClose + 10;
  }, 'same host continues after guest exit', 30000);
  report.afterLeave = { before: afterClose, native: await nativeSample(0) };
  assert(report.afterLeave.native.players.some(player => player.slot === 1 && player.life > 0), 'Host is not alive after guest exit');
  assert.deepEqual(report.afterLeave.native.players.map(player => player.slot), [1], 'The departed guest remains in the native roster');
  assert.equal(report.afterLeave.native.players[0].id, report.firstJoin.host.players.find(player => player.slot === 1)?.id,
    'Host native identity changed after guest exit');
  assert.equal(wire[0].joined.room, room);
  report.checks.push('Same live host room continued after guest closed');
  report.stage = 'replacement'; await open(2, origin);
  const secondJoin = await join(2, room);
  report.replacement = { tick: secondJoin, host: await nativeSample(0), guest: await nativeSample(2) };
  assert.equal((await until(() => wire[0].acks.find(a => a.tick === report.replacement.guest.tick), 'host ACK for replacement snapshot')).digest,
    report.replacement.guest.digest, 'Host ACK differs from replacement native snapshot');
  assert.equal(wire[2].joined.room, room);
  const newborn = report.replacement.guest.players.find(player => player.slot === 2);
  assert(newborn && newborn.weapon === 'pistol', 'Replacement does not have initial weapon');
  if (mode === 'Coop') assert(newborn.score === 0 && newborn.kills === 0 && newborn.level === 0, 'Replacement does not have initial personal progress');
  report.replacementMovement = await physicalGuestMovement(2);
  assert.deepEqual(wire[0].errors, []); assert.deepEqual(wire[2].errors, []);
  report.checks.push('Same host room continued after guest closed', 'Fresh browser joined same room',
    'Eleven native ACKs matched after each spawn', 'Native state samples match their actual ACKs');
  report.pass = true; report.stage = 'complete';
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
  report.passiveOnFailure = await Promise.all(pages.map(page => page && !page.isClosed() ? page.evaluate(() => window.__passiveNative).catch(() => null) : null));
  process.exitCode = 1;
} finally {
  pilotRunning = false;
  await pilotTask;
  await Promise.allSettled(browsers.filter(Boolean).map(browser => browser.close()));
  await service.close();
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, stage: report.stage, report: path.join(out, 'report.json') }));
}
