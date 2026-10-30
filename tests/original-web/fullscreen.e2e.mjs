import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createOriginalServer } from '../../apps/original-server/service.mjs';
const server = createOriginalServer({ host: '127.0.0.1', port: 0, webRoot: 'dist/original-web' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || undefined, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(process.env.BOXHEAD_TEST_ORIGIN || `http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'menu', null, { timeout: 90000 });
  await page.waitForFunction(() => {
    try {
      const raw = document.querySelector('#original-ruffle-player').ruffle().callExternalInterface('bhInfo');
      return (typeof raw === 'string' ? JSON.parse(raw) : raw)?.menuBounds?.online;
    } catch { return false; }
  }, null, { timeout: 60000 });
  const warning = page.locator('#original-ruffle-player #hardware-acceleration-modal');
  if (await warning.isVisible()) await warning.locator('.close-modal').click();
  const button = page.locator('#fullscreen');
  const original = await page.locator('#stage').boundingBox();
  assert.equal(original.width, 640); assert.equal(original.height, 480);
  for (const exit of ['button', 'browser-exit']) {
    await button.click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'game-display');
    await page.waitForFunction(() => document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'true');
    // Fullscreen resizing can finish after the fullscreenchange event.
    await page.waitForFunction(() => {
      const b = document.querySelector('#stage').getBoundingClientRect();
      return Math.abs(b.width - innerWidth) < 1 && Math.abs(b.height - innerHeight) < 1;
    });
    const box = await page.locator('#stage').boundingBox();
    assert.deepEqual({width: box.width, height: box.height}, await page.evaluate(() => ({width: innerWidth, height: innerHeight})));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'stage');
    assert.equal((await button.textContent()).trim(), 'Exit fullscreen');
    if (await warning.isVisible()) await warning.locator('.close-modal').click();
    await page.screenshot({path: '/tmp/boxhead-stretch-fullscreen.png'});
    if (exit === 'button') await button.click(); else await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.waitForFunction(() => document.querySelector('#stage').getBoundingClientRect().width === 640);
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
  }
  assert.equal(server.stats().connections, 0);
  console.log('PASS: actual native menu, fullscreen fills full viewport, button exit, browser-initiated exit and focus');
} finally { await browser.close(); await server.close(); }
