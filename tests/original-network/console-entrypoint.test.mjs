import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = new URL('../../apps/original-server/index.mjs', import.meta.url);

async function childFixture(t, args, closedStream, shutdownFailure = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boxhead-entrypoint-console-'));
  const witness = path.join(directory, 'uncaught.jsonl');
  const preload = path.join(directory, 'monitor.mjs');
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Console transport fixture</title>');
  // The monitor observes fatal errors without handling them or changing exit
  // behavior. A file witness remains usable even when stdout/stderr is closed.
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
process.on('uncaughtExceptionMonitor', error => {
  appendFileSync(${JSON.stringify(witness)}, JSON.stringify({ code: error.code, message: error.message }) + '\\n');
});\n`);
  let entry = fileURLToPath(ENTRY);
  if (shutdownFailure) {
    entry = path.join(directory, 'shutdown-failure.mjs');
    await writeFile(entry, `import { main } from ${JSON.stringify(ENTRY.href)};
import { setImmediate } from 'node:timers/promises';
const service = await main(['--host', '127.0.0.1', '--port', '0', '--web-root', ${JSON.stringify(directory)}], {});
const originalClose = service.close;
service.close = async () => { throw new Error('injected shutdown failure'); };
process.emit('SIGTERM');
await setImmediate();
await originalClose();\n`);
  }
  const child = spawn(process.execPath, ['--import', preload, entry, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, METRICS_INTERVAL_MS: '30000' },
  });
  const exited = once(child, 'close');
  const output = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr']) {
    if (stream === closedStream) child[stream].destroy();
    else child[stream].on('data', chunk => { output[stream] += chunk.toString(); });
  }
  child.stdin.end();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const [code, signal] = await exited;
  let uncaught = '';
  try { uncaught = await readFile(witness, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { code, signal, uncaught, ...output };
}

test('help remains successful when its stdout pipe is already closed', { timeout: 10_000 }, async t => {
  const result = await childFixture(t, ['--help'], 'stdout');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.uncaught, '', 'closed help output must not emit an unhandled EPIPE');
});

test('startup failure preserves exit code without an uncaught error on closed stderr', { timeout: 10_000 }, async t => {
  const result = await childFixture(t, ['--unknown-option'], 'stderr');
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.uncaught, '', 'startup diagnostics must tolerate an unavailable stderr');
});

test('shutdown failure preserves exit code and cleanup with closed stderr', { timeout: 10_000 }, async t => {
  const result = await childFixture(t, [], 'stderr', true);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.uncaught, '', 'shutdown diagnostics must tolerate an unavailable stderr');
  assert.match(result.stdout, /"event":"server_stopped"/, 'the original close must finish');
});
