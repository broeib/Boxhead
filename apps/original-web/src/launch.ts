import { ClientError } from './protocol';
import { OriginalBridge } from './bridge';
import type { OriginalRenderer, OriginalRuffleHost } from './ruffle';

/** Exactly two supported bitmap-capable preferences; never retry during a match. */
export async function loadOriginalMenu(
  host: Pick<OriginalRuffleHost, 'load' | 'bridge' | 'destroy'>,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ bridge: OriginalBridge; renderer: OriginalRenderer }> {
  let unsupported = false;
  let lastError: unknown;
  for (const renderer of ['wgpu-webgl', 'webgpu'] as const) {
    try {
      await host.load(bytes, signal, renderer);
      const bridge = host.bridge();
      await bridge.waitUntilAvailable(signal, 20_000);
      if (bridge.info().menuVersion !== 1) throw new ClientError('This version of the game does not include the online menu.');
      // A preference can silently fall back to Canvas/WebGL. Require the real
      // native BitmapData.draw/getPixel result before showing a playable menu.
      if (bridge.renderCheck().supported) return { bridge, renderer };
      unsupported = true;
    } catch (error) { lastError = error; }
    host.destroy();
    if (signal.aborted) throw new ClientError('Loading cancelled.');
  }
  if (unsupported) throw new ClientError('Your browser could not render BitmapData.draw, which the original game requires. Check browser hardware acceleration or use a browser with working WebGL 2 / WebGPU support. The game stopped before loading the map.');
  throw lastError ?? new ClientError('Could not load the original menu.');
}
