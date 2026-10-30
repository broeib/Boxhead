import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createOriginalServer } from '../../apps/original-server/service.mjs';

// Integrated native menu smoke, independent of the complete two-browser E2E.
// The render probe is real; only the missing-callback case substitutes an asset.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'test-results/original-web');
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// launch.ts permits two sequential renderer attempts, each followed by a
// 20-second callback wait. The negative asset has no callbacks in either one.
// Allow another 15 seconds per attempt for actual WASM/renderer startup; this
// is a bounded test allowance, not a new runtime retry or gameplay timeout.
const missingCallbackBudgetMs = 2 * (20000 + 15000);
const report = { classification: 'ORIGINAL_NATIVE_MENU_BOOT_SMOKE', pass: false, source: {},
  checks: { originalPreserved: false, nativeMenuBoot: false, renderProbe: false,
    noPrematureSockets: false, missingBridgeRejected: false, failedPlayerRemoved: false, reloadRecovery: false },
  boots: [], onlineRequests: 0, gameSockets: 0, error: null, cleanup: {},
  budgets: { overallMs: 150000, missingCallbackMs: missingCallbackBudgetMs } };
const started = Date.now(), deadline = started + 150000;
let browserServer, browser, page, server, phase = 'start', expired = false;
let missingCallbackStarted;
const timeout = (cap = 30000) => {
  assert(Date.now() < deadline, 'Native menu smoke exceeded its overall deadline');
  return Math.max(1, Math.min(cap, deadline - Date.now()));
};
const bounded = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Bounded smoke cleanup expired')), ms);
  })]); } finally { clearTimeout(timer); }
};
const timer = setTimeout(() => {
  expired = true;
  void browserServer?.kill().catch(() => {});
  void server?.close().catch(() => {});
}, 150000);
timer.unref();

async function assertNativeMenu(label) {
  await page.waitForFunction(() => document.querySelector('#status')?.dataset.state === 'menu', null, { timeout: timeout(45000) });
  await page.waitForFunction(() => {
    try {
      let info = document.querySelector('#original-ruffle-player')?.ruffle().callExternalInterface('bhInfo');
      if (typeof info === 'string') info = JSON.parse(info);
      return info?.menuReady === true;
    } catch { return false; }
  }, null, { timeout: timeout(30000) });
  await page.locator('#original-ruffle-player canvas').waitFor({ state: 'attached', timeout: timeout(10000) });
  const dimensions = await page.locator('#stage').boundingBox();
  assert(dimensions);
  assert.equal(dimensions.width, 640);
  assert.equal(dimensions.height, 480);
  assert.equal(await page.evaluate(() => document.querySelectorAll('button:not(#fullscreen), input, select').length), 0,
    'Obsolete external room controls must not return');
  assert.equal(await page.locator('#stage').getAttribute('data-render-check'), 'supported');
  const native = await page.evaluate(() => {
    const api = document.querySelector('#original-ruffle-player').ruffle();
    const read = (name) => {
      const value = api.callExternalInterface(name);
      return typeof value === 'string' ? JSON.parse(value) : value;
    };
    const info = read('bhInfo');
    return { info: { version: info.version, engine: info.engine, menuVersion: info.menuVersion,
      menuReady: info.menuReady, canPrepare: info.canPrepare, tick: info.tick }, probe: read('bhRenderCheck') };
  });
  assert.deepEqual(native.info, { version: 1, engine: 'original-swf', menuVersion: 1,
    menuReady: true, canPrepare: true, tick: 0 });
  assert.deepEqual(native.probe, { supported: true, pixel: 0x24ba6c, expected: 0x24ba6c },
    'Actual native BitmapData.draw must produce its expected pixel');
  assert.equal(report.gameSockets, 0, 'A native menu without create/join/list must not open a game socket');
  assert.equal(server.stats().connections, 0);
  assert.equal(server.stats().rooms, 0);
  report.boots.push({ label, ...native, dimensions: { width: dimensions.width, height: dimensions.height },
    rendererPreference: await page.locator('#stage').getAttribute('data-renderer-preference') });
  await page.locator('#stage').screenshot({ path: path.join(output, `${label}.png`), timeout: timeout(7000) });
}

try {
  const original = await readFile(path.join(root, 'public/Boxhead_2Play.swf'));
  const online = await readFile(path.join(root, 'public/Boxhead_2Play.online.swf'));
  report.source.originalSha256 = hash(original);
  report.source.onlineSha256 = hash(online);
  assert.equal(report.source.originalSha256, '34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece');
  assert.notEqual(report.source.onlineSha256, report.source.originalSha256);
  report.checks.originalPreserved = true;
  server = createOriginalServer({ host: '127.0.0.1', port: 0,
    webRoot: path.resolve(root, process.env.ORIGINAL_TEST_WEB_ROOT || 'dist/original-web') });
  await server.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const served = await fetch(origin + '/Boxhead_2Play.online.swf', { signal: AbortSignal.timeout(timeout(10000)) });
  assert(served.ok);
  report.source.servedOnlineSha256 = hash(Buffer.from(await served.arrayBuffer()));
  assert.equal(report.source.servedOnlineSha256, report.source.onlineSha256, 'Built frontend serves a stale online SWF');
  const executablePath = process.env.CHROME_BIN || process.env.CHROME_PATH;
  browserServer = await chromium.launchServer({ ...(executablePath ? { executablePath } : {}),
    headless: true, timeout: timeout(20000),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  if (expired) throw new Error('Native menu smoke exceeded its overall deadline');
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: timeout(10000) });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1000, height: 850 }, deviceScaleFactor: 1 });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === '/original-ws') report.gameSockets += 1;
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/Boxhead_2Play.online.swf') report.onlineRequests += 1;
  });
  phase = 'initial_native_menu';
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: timeout() });
  await assertNativeMenu('01-native-menu');
  assert.equal(report.onlineRequests, 1);
  report.checks.nativeMenuBoot = true;
  report.checks.renderProbe = true;

  // An untouched source movie has no bridge/menu callbacks. It must fail
  // visibly and must never open a room socket or claim online readiness.
  phase = 'missing_callback_guard';
  const substitute = (route) => route.fulfill({ status: 200,
    contentType: 'application/x-shockwave-flash', body: original });
  await page.route('**/Boxhead_2Play.online.swf', substitute);
  missingCallbackStarted = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeout() });
  await page.waitForFunction(() => document.querySelector('#status')?.dataset.state === 'error', null,
    { timeout: timeout(missingCallbackBudgetMs) });
  report.missingCallbackElapsedMs = Date.now() - missingCallbackStarted;
  assert.match(await page.locator('#status').innerText(), /bhInfo|callback|мост|ExternalInterface|меню/i);
  assert.equal(report.gameSockets, 0, 'A missing bridge must never create a socket or claim readiness');
  assert.equal(server.stats().rooms, 0);
  assert.equal(await page.locator('#original-ruffle-player').count(), 0, 'Failed SWF must be removed');
  assert.equal(report.onlineRequests, 2);
  report.checks.missingBridgeRejected = true;
  report.checks.failedPlayerRemoved = true;
  await page.screenshot({ path: path.join(output, '02-missing-callback-error.png'), timeout: timeout(7000) });

  // Restore the real asset and recover through a fresh page load. The removed
  // #local toolbar button is not replaced with a synthetic native state change.
  phase = 'reload_recovery';
  await page.unroute('**/Boxhead_2Play.online.swf', substitute);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeout() });
  await assertNativeMenu('03-recovered-native-menu');
  assert.equal(report.onlineRequests, 3);
  report.checks.reloadRecovery = true;
  report.checks.noPrematureSockets = true;
  report.pass = true;
} catch (error) {
  report.error = { phase, name: error?.name ?? 'Error', message: expired ? 'Overall deadline exceeded' : String(error?.message ?? error).slice(0, 1200) };
  if (phase === 'missing_callback_guard' && missingCallbackStarted) report.missingCallbackElapsedMs = Date.now() - missingCallbackStarted;
  if (page && !expired) report.failureUI = await bounded(page.evaluate(() => ({
    status: document.querySelector('#status')?.dataset.state,
    text: document.querySelector('#status')?.textContent?.slice(0, 700),
    players: document.querySelectorAll('#original-ruffle-player').length,
  })), 1000).catch(() => null);
  if (page && !expired) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {});
} finally {
  if (browserServer) {
    try { await bounded(browserServer.close(), 4000); report.cleanup.browserClosed = true; }
    catch {
      try { await bounded(browserServer.kill(), 2000); report.cleanup.browserKilled = true; }
      catch { report.cleanup.browserKilled = false; }
    }
  }
  if (server) {
    try { await bounded(server.close(), 3000); report.cleanup.serverClosed = true; }
    catch { report.cleanup.serverClosed = false; }
  }
  clearTimeout(timer);
  if ((!report.cleanup.browserClosed && !report.cleanup.browserKilled) || !report.cleanup.serverClosed) report.pass = false;
  report.elapsedMs = Date.now() - started;
  const json = JSON.stringify(report, null, 2);
  assert(Buffer.byteLength(json) < 16384, 'Smoke report must remain bounded');
  await writeFile(path.join(output, 'report.json'), json + '\n');
  console.log(json);
  if (!report.pass) process.exitCode = 1;
}
