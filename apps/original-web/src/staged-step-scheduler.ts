import { ClientError } from './protocol';

/** A phase starts in a separate task after the browser's rendering update.
 * Resolving directly inside rAF would run the async continuation as a
 * microtask before paint. MessageChannel posts it after all rAF callbacks,
 * including Ruffle's render, have returned. Hidden tabs use an ordinary task;
 * they cannot provide a foreground paint guarantee. */
export function yieldAfterOriginalPaint(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let channel: MessageChannel | null = null;
    const page = typeof document === 'undefined' ? undefined : document;
    const cleanup = (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = null;
      timer = null;
      channel?.port1.close();
      channel?.port2.close();
      channel = null;
      page?.removeEventListener('visibilitychange', visibility);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const abort = (): void => finish(new ClientError('Waiting for the native stage was cancelled.'));
    const post = (): void => {
      if (done || channel) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try {
        // This is a task boundary, not Promise.resolve or a rAF microtask.
        // Timers provide the same task separation on older browsers.
        if (typeof MessageChannel === 'undefined') timer = setTimeout(() => finish(), 0);
        else {
          channel = new MessageChannel();
          channel.port1.onmessage = () => finish();
          channel.port2.postMessage(0);
        }
      } catch { finish(new ClientError('The browser could not continue the native stage.')); }
    };
    const visibility = (): void => { if (page?.hidden) post(); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    page?.addEventListener('visibilitychange', visibility);
    if (page?.hidden || typeof requestAnimationFrame === 'undefined') { post(); return; }
    try {
      frame = requestAnimationFrame(() => { frame = null; post(); });
      // An inactive/broken visible renderer must not hold the native world
      // indefinitely. This does not extend the session's existing deadlines.
      timer = setTimeout(() => {
        if (page?.hidden) post();
        else finish(new ClientError('The browser did not provide a frame for the native stage.'));
      }, 1000);
    } catch { finish(new ClientError('A browser frame is unavailable for the native stage.')); }
  });
}
