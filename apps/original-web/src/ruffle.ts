import { OriginalBridge, type NativeInvoke } from './bridge';
import { ClientError } from './protocol';
import { installSnapshotDigestHelpers, NativeSnapshotExports } from './native-snapshot-export';
import { sha256Hex } from './sha256';
import { OriginalPresentationDispatcher, OriginalPresentationPump, THREE_POSE_PRESENTATION_MODE,
  FOUR_POSE_PRESENTATION_MODE } from './presentation';
import { yieldAfterOriginalPaint } from './staged-step-scheduler';

type RuffleAPI = { callExternalInterface?: (name: string, ...args: unknown[]) => unknown; volume?: number };
type RufflePlayer = HTMLElement & {
  load: (options: Record<string, unknown>) => Promise<unknown>;
  ruffle?: () => RuffleAPI;
  [key: string]: unknown;
};
type Runtime = {
  config?: Record<string, unknown>;
  newest?: () => { createPlayer: () => RufflePlayer };
};
export type OriginalRenderer = 'wgpu-webgl' | 'webgpu';
const runtimeWindow = window as unknown as { RufflePlayer?: Runtime };
let scriptPromise: Promise<void> | undefined;

async function loadRuntime(): Promise<void> {
  // The SWF supplies its actual native projection. JavaScript only accelerates
  // its canonical encoding/checksum; the original AS2 remains the simulation.
  installSnapshotDigestHelpers(window as unknown as Record<string, unknown>);
  if (typeof runtimeWindow.RufflePlayer?.newest === 'function') return;
  if (!scriptPromise) {
    runtimeWindow.RufflePlayer ??= {};
    runtimeWindow.RufflePlayer.config = {
      ...runtimeWindow.RufflePlayer.config,
      publicPath: '/ruffle/',
      preferredRenderer: 'wgpu-webgl',
    };
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/ruffle/ruffle.js';
      script.async = true;
      const timer = setTimeout(() => {
        script.remove();
        reject(new ClientError('Timed out loading local Ruffle.'));
      }, 15_000);
      script.onload = () => {
        clearTimeout(timer);
        if (typeof runtimeWindow.RufflePlayer?.newest !== 'function') {
          reject(new ClientError('Local Ruffle did not provide a runtime.'));
        } else resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        reject(new ClientError('Could not load /ruffle/ruffle.js.'));
      };
      document.head.append(script);
    }).catch((error: unknown) => {
      scriptPromise = undefined;
      throw error;
    });
  }
  await scriptPromise;
}

export class OriginalRuffleHost {
  private generation = 0;
  private player: RufflePlayer | null = null;
  private snapshotExports: NativeSnapshotExports | null = null;
  private replayAudio: { player: RufflePlayer; api: RuffleAPI; volume: number } | null = null;
  private presentation: OriginalPresentationPump | null = null;
  private presentationClock: OriginalPresentationDispatcher | null = null;
  // The invitation URL is rewritten on room join. Preserve this local A/B
  // choice from page initialization instead of reading the later room URL.
  private readonly presentationRequested = new URL(location.href).searchParams.get('presentation') !== 'off';
  private readonly requestedPresentationClock = (() => {
    const mode = new URL(location.href).searchParams.get('presentation-clock');
    if (mode === null) return FOUR_POSE_PRESENTATION_MODE;
    if (mode === 'legacy-v1' || mode === THREE_POSE_PRESENTATION_MODE || mode === FOUR_POSE_PRESENTATION_MODE) return mode;
    throw new ClientError('Unknown original game display mode.');
  })();

  constructor(private readonly container: HTMLElement) {}

  async load(source: string | Uint8Array, signal: AbortSignal, renderer: OriginalRenderer = 'wgpu-webgl'): Promise<void> {
    const generation = ++this.generation;
    this.presentation?.close();
    this.presentation = null;
    this.presentationClock?.close();
    this.presentationClock = null;
    this.setReplayMuted(false);
    this.snapshotExports?.dispose();
    this.snapshotExports = null;
    this.player?.remove();
    this.player = null;
    this.container.replaceChildren();
    await loadRuntime();
    this.assertCurrent(generation, signal);
    const ruffle = runtimeWindow.RufflePlayer?.newest?.();
    if (!ruffle) throw new ClientError('The Ruffle runtime is unavailable.');
    // Register before createPlayer/load can start Ruffle's own rAF. This clock
    // remains dormant through menus/loading/replay; it never advances the VM.
    const presentationClock = this.presentationRequested ? new OriginalPresentationDispatcher(
      { now: () => performance.now(), request: (callback) => requestAnimationFrame(callback), cancel: (id) => cancelAnimationFrame(id) },
      signal,
    ) : null;
    this.presentationClock = presentationClock;
    let player: RufflePlayer | null = null;
    let snapshotExports: NativeSnapshotExports | null = null;
    try {
      player = ruffle.createPlayer();
      player.id = 'original-ruffle-player';
      player.tabIndex = 0;
      player.style.width = '100%';
      player.style.height = '100%';
      this.player = player;
      snapshotExports = new NativeSnapshotExports(window as unknown as Record<string, unknown>);
      this.snapshotExports = snapshotExports;
      this.container.append(player);
      await player.load({
        ...(typeof source === 'string'
          ? { url: source }
          : { data: source, swfFileName: 'Boxhead_2Play.online.swf' }),
        base: new URL('/', location.href).href,
        preferredRenderer: renderer,
        autoplay: 'on',
        letterbox: 'off',
        quality: 'high',
        // Large original maps can exceed 15 seconds in one bitmap initializer
        // on software renderers. Keep a finite budget for local and online loads.
        maxExecutionDuration: 60,
        scale: 'exactFit',
        forceScale: true,
        allowScriptAccess: true,
        openInNewTab: false,
      });
      this.assertCurrent(generation, signal);
    } catch (error) {
      presentationClock?.close();
      if (this.presentationClock === presentationClock) this.presentationClock = null;
      snapshotExports?.dispose();
      if (this.snapshotExports === snapshotExports) this.snapshotExports = null;
      player?.remove();
      if (this.player === player) this.player = null;
      throw error;
    }
  }

  bridge(): OriginalBridge {
    const player = this.player;
    const snapshotExports = this.snapshotExports;
    const presentationClock = this.presentationClock;
    if (!player || !snapshotExports) throw new ClientError('The online SWF has not loaded yet.');
    let presentationSupported = false;
    let presentationEnabled = false;
    let presentationMode: typeof THREE_POSE_PRESENTATION_MODE | typeof FOUR_POSE_PRESENTATION_MODE | undefined;
    let replaying = false;
    let stagedVisualActive = false;
    let frameMs = 40;
    const stopPresentationClock = (): void => {
      presentationClock?.close();
      if (this.presentationClock === presentationClock) this.presentationClock = null;
    };
    const callPlayer = (name: string, ...args: unknown[]): unknown => {
      if (this.player !== player || !player.isConnected) {
        throw new ClientError('The SWF is already closed.');
      }
      const api = player.ruffle?.();
      if (typeof api?.callExternalInterface === 'function') {
        return api.callExternalInterface(name, ...args);
      }
      // Compatibility with Ruffle versions exposing callbacks on the player.
      // Select one invocation path; never retry an executed bhStep elsewhere.
      const callback = player[name];
      if (typeof callback === 'function') return callback.apply(player, args);
      throw new ClientError('A required ExternalInterface callback is missing.');
    };
    const record = (raw: unknown): Record<string, unknown> | null => {
      try {
        const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      } catch { return null; }
    };
    const disposeStagedWorld = (): void => {
      stagedVisualActive = false;
      presentationEnabled = false;
      // An awaited phase can reject after load() already installed another
      // player. Its old cleanup must never close the new generation's pump.
      if (this.player !== player) {
        snapshotExports.dispose();
        presentationClock?.close();
        return;
      }
      this.presentation?.close();
      this.presentation = null;
      stopPresentationClock();
      snapshotExports.dispose();
      if (this.snapshotExports === snapshotExports) this.snapshotExports = null;
      if (this.player === player) {
        this.setReplayMuted(false);
        player.remove();
        this.player = null;
      }
    };
    const invoke: NativeInvoke = (name, ...args) => {
      if (name === 'bhPrepare' && presentationSupported) {
        const settings = args[5] as { speed?: number } | undefined;
        frameMs = settings?.speed === 0 ? 80 : settings?.speed === 2 ? 20 : 40;
        replaying = (args[6] as { replay?: boolean } | undefined)?.replay === true;
        // One local A/B switch affects presentation only; original game rules,
        // native checks, room messages and the SWF artifact remain identical.
        const requested = this.requestedPresentationClock;
        const configured = record(!this.presentationRequested ? callPlayer('bhPresentationConfig', false)
          : requested === 'legacy-v1' ? callPlayer('bhPresentationConfig', true)
            : callPlayer('bhPresentationConfig', true, requested));
        const buffered = (requested === THREE_POSE_PRESENTATION_MODE
          && configured?.mode === THREE_POSE_PRESENTATION_MODE && configured.poseVersion === 2)
          || (requested === FOUR_POSE_PRESENTATION_MODE
            && configured?.mode === FOUR_POSE_PRESENTATION_MODE && configured.poseVersion === 3);
        const legacy = requested !== FOUR_POSE_PRESENTATION_MODE
          && configured?.mode === undefined && configured?.poseVersion === undefined;
        presentationMode = buffered ? (requested === FOUR_POSE_PRESENTATION_MODE
          ? FOUR_POSE_PRESENTATION_MODE : THREE_POSE_PRESENTATION_MODE) : undefined;
        presentationEnabled = configured?.version === 1 && configured.ok === true && configured.enabled === true
          && (buffered || legacy) && presentationClock !== null;
        // Older SWFs ignore the second argument and retain their original
        // one-interval protocol. A partial/unknown new contract cannot select
        // a clock with a different interpretation of the same alpha value.
        // Explicit four-pose qualification requires that exact native mode;
        // the historical default's legacy compatibility does not downgrade it.
        if (configured?.enabled === true && !presentationEnabled) callPlayer('bhPresentationConfig', false);
        if (!presentationEnabled) stopPresentationClock();
      }
      const isBegin = name === 'bhStepBegin' || name === 'bhFrameBegin';
      const isCommit = name === 'bhStepCommit' || name === 'bhFrameCommit';
      const stepStartedAt = name === 'bhStep' || isBegin ? performance.now() : undefined;
      const raw = snapshotExports.invoke(name, args, () => callPlayer(name, ...args));
      const value = (name === 'bhInfo' || name === 'bhStep' || isBegin || isCommit) ? record(raw) : null;
      if (name === 'bhInfo' && value?.presentationVersion === 1) presentationSupported = true;
      if (isBegin) stagedVisualActive = true;
      if (name === 'bhStateReceipt') stagedVisualActive = false;
      const begun = isBegin && value?.phase === 'begun';
      const finished = (name === 'bhStep' || isCommit)
        && typeof value?.digest === 'string' && Array.isArray(value.players);
      if ((begun || finished) && presentationEnabled && value
        && Number.isInteger(value.tick) && value.tick === args[isCommit ? 2 : 0]
        && value.error === undefined && value.state !== 'error') {
        if (!isCommit && args[3] !== undefined) replaying = false;
        if (value.complete) {
          this.presentation?.close();
          this.presentation = null;
          presentationEnabled = false;
          stopPresentationClock();
          // The bridge still has to consume this step's native receipt. Leave
          // its synchronous transaction intact before disposing visual buffers.
          queueMicrotask(() => {
            if (this.player !== player || !player.isConnected) return;
            try { callPlayer('bhPresentationConfig', false); } catch { /* Session validation owns native failures. */ }
          });
        } else if (!replaying && stepStartedAt !== undefined) {
          if (!this.presentation) {
            this.presentation = new OriginalPresentationPump(
              (alpha) => snapshotExports.invoke('bhPresent', [alpha], () => callPlayer('bhPresent', alpha)),
              presentationClock!,
              (error) => {
                presentationEnabled = false;
                stopPresentationClock();
                if (stagedVisualActive) {
                  disposeStagedWorld();
                  console.warn('Original game staged presentation failed:', error instanceof Error ? error.message : String(error));
                  return;
                }
                // A rejected step timestamp can be detected while the native
                // receipt transaction is still unwinding. Dispose only after
                // that synchronous Step / Info / Receipt boundary completes.
                queueMicrotask(() => {
                  if (this.player !== player || !player.isConnected) return;
                  try { callPlayer('bhPresentationConfig', false); } catch { /* Preserve native session failure handling. */ }
                });
                console.warn('Original game presentation fallback:', error instanceof Error ? error.message : String(error));
              },
              { mode: presentationMode },
            );
          }
          // Begin has executed exactly one original Process/Draw. Its visual
          // tick is intentionally visible before the transaction is ACKed;
          // the session's committed tick still waits for Commit/Info/Receipt.
          this.presentation.stepped(value.tick as number, frameMs, stepStartedAt);
        }
      }
      return raw;
    };
    return new OriginalBridge(invoke, snapshotExports, {
      alignLiveStepsToPaint: this.presentationRequested && presentationClock !== null,
      yield: yieldAfterOriginalPaint,
      abort: (key) => callPlayer('bhStepAbort', key.token, key.epoch, key.tick),
      abortCompact: (key) => callPlayer('bhFrameAbort', key.token, key.epoch, key.tick),
      dispose: disposeStagedWorld,
    });
  }

  setReplayMuted(muted: boolean): void {
    if (!muted) {
      const saved = this.replayAudio;
      this.replayAudio = null;
      if (saved && this.player === saved.player && saved.player.isConnected) saved.api.volume = saved.volume;
      return;
    }
    if (this.replayAudio) return;
    const player = this.player;
    const api = player?.ruffle?.();
    const volume = api?.volume;
    // The bundled Ruffle public API exposes volume without pausing the VM.
    // Preserve the current user value, including an already muted player.
    if (!player || !api || typeof volume !== 'number' || !Number.isFinite(volume)) return;
    this.replayAudio = { player, api, volume };
    api.volume = 0;
  }

  destroy(): void {
    ++this.generation;
    this.presentation?.close();
    this.presentation = null;
    this.presentationClock?.close();
    this.presentationClock = null;
    this.setReplayMuted(false);
    this.snapshotExports?.dispose();
    this.snapshotExports = null;
    this.player?.remove();
    this.player = null;
    this.container.replaceChildren();
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (generation !== this.generation || signal.aborted) throw new ClientError('Loading cancelled.');
  }
}

export async function fetchOnlineSWF(signal: AbortSignal): Promise<{ bytes: Uint8Array; hash: string }> {
  const response = await fetch('/Boxhead_2Play.online.swf', {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok || !response.body) throw new ClientError('The online /Boxhead_2Play.online.swf is missing.');
  const limit = 32 * 1024 * 1024;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body.cancel();
    throw new ClientError('The online SWF exceeds the size limit.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ClientError('The online SWF exceeds the size limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const signature = String.fromCharCode(...bytes.subarray(0, 3));
  if (size < 8 || !['FWS', 'CWS', 'ZWS'].includes(signature)) {
    throw new ClientError('Received a different file instead of the online SWF.');
  }
  const hash = await sha256Hex(bytes, signal);
  // Load these exact hashed bytes into Ruffle, avoiding a second asset fetch.
  return { bytes, hash };
}

