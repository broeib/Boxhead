import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createOriginalServer } from './service.mjs';
import { createConsoleSink, createRemoteAddressResolver } from './telemetry.mjs';

// Startup/help/shutdown diagnostics can run outside the telemetry lifecycle.
// Use the same bounded, asynchronous-error-safe transport for these fixed lines.
function diagnostic(stream, text) {
  const sink = createConsoleSink(stream);
  sink.write(text);
  sink.close();
}

export function parseArguments(args, environment = process.env) {
  const values = {
    host: environment.HOST ?? '0.0.0.0',
    port: environment.PORT ?? '7777',
    webRoot: environment.WEB_ROOT ?? 'dist/original-web',
    ...(environment.METRICS_INTERVAL_MS === undefined ? {} : { metricsIntervalMs: environment.METRICS_INTERVAL_MS }),
    ...(environment.TRUSTED_PROXY_IPS === undefined ? {} : { trustedProxyIPs: environment.TRUSTED_PROXY_IPS }),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return null;
    const key = { '--host': 'host', '--port': 'port', '--web-root': 'webRoot', '--metrics-interval-ms': 'metricsIntervalMs', '--trusted-proxy-ips': 'trustedProxyIPs' }[argument];
    if (!key || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    values[key] = args[++index];
  }
  if (!/^[0-9]+$/.test(String(values.port))) throw new Error('PORT must be an integer');
  values.port = Number(values.port);
  if (values.trustedProxyIPs !== undefined) {
    if (typeof values.trustedProxyIPs !== 'string') throw new TypeError('Invalid TRUSTED_PROXY_IPS');
    values.trustedProxyIPs = values.trustedProxyIPs.trim() === '' ? [] : values.trustedProxyIPs.split(',').map(ip => ip.trim());
    createRemoteAddressResolver(values.trustedProxyIPs);
  }
  if (values.metricsIntervalMs !== undefined) {
    if (!/^[0-9]+$/.test(String(values.metricsIntervalMs))) throw new Error('METRICS_INTERVAL_MS must be an integer');
    values.metricsIntervalMs = Number(values.metricsIntervalMs);
    if (!Number.isSafeInteger(values.metricsIntervalMs) || values.metricsIntervalMs < 1000 || values.metricsIntervalMs > 3_600_000) {
      throw new Error('METRICS_INTERVAL_MS must be between 1000 and 3600000');
    }
  }
  return values;
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const config = parseArguments(args, environment);
  if (!config) {
    diagnostic(process.stdout, 'Usage: node apps/original-server/index.mjs [--host HOST] [--port PORT] [--web-root DIRECTORY] [--metrics-interval-ms MILLISECONDS] [--trusted-proxy-ips IP,IP]\nForwarded client IPs are accepted only from explicitly listed proxy addresses; default: none.\nConsole commands: status, players, rooms, help');
    return null;
  }
  const service = createOriginalServer(config);
  try {
    await service.listen();
  } catch (error) {
    await service.close();
    throw error;
  }
  const address = service.address();
  diagnostic(process.stdout, JSON.stringify({
    event: 'original_lockstep_listening',
    mode: 'server-coordinated-lockstep',
    host: address.address,
    port: address.port,
  }));
  let stopping = false;
  const consoleInput = createInterface({ input: process.stdin, terminal: false });
  consoleInput.on('line', (line) => {
    const command = line.trim().toLowerCase();
    if (command && !stopping) service.consoleCommand(command);
  });
  const closeService = service.close;
  service.close = () => {
    consoleInput.close();
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    return closeService();
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await service.close();
    } catch {
      diagnostic(process.stderr, 'Original lockstep shutdown failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    diagnostic(process.stderr, `Original lockstep startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
