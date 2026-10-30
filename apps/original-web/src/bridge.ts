import { ClientError, boundedText, integer, isMask, isRecord, readSettings, readPlayerJoin, readPlayerLeave, type PlayerJoin, type PlayerLeave, type Slot, type PrepareMessage } from './protocol';
import { MAX_NATIVE_ENCODING_LENGTH } from './native-digest';
import type { NativeSnapshotExports, StagedStepKey } from './native-snapshot-export';
import type { NativeCheckpoint } from './checkpoint';
import { MAX_CHECKPOINT_RAW_BYTES } from './protocol';
import { readControls, readMenuEvent, readRenderCheck, type NativeControls, type NativeMenuEvent, type NativeMenuUpdate, type NativeRenderCheck } from './menu';

export type NativeCallback = 'bhInfo' | 'bhPrepare' | 'bhStep' | 'bhState' | 'bhStateReceipt' | 'bhMenuPoll' | 'bhMenuUpdate' | 'bhRenderCheck' | 'bhControls' | 'bhCheckpointExport' | 'bhCheckpointImport'
  | 'bhStepBegin' | 'bhStepPrepare' | 'bhStepProject' | 'bhStepCommit' | 'bhStepAbort' | 'bhPresent'
  | 'bhFrameBegin' | 'bhFrameCommit' | 'bhFrameAbort' | 'bhReplayEnd';
export type NativeInvoke = (name: NativeCallback, ...args: unknown[]) => unknown;
export interface NativeInfo {
  version: 1;
  engine: 'original-swf';
  state: 'menu' | 'loading' | 'ready' | 'playing' | 'error';
  tick: number;
  canPrepare?: boolean;
  menuVersion?: 1;
  snapshotReceiptVersion?: 1;
  stagedStepVersion?: 1;
  compactStepVersion?: 1;
  checkpointVersion?: 1;
}
export interface StepResult extends Record<string, unknown> {
  tick: number;
  digest: string;
  players: Record<string, unknown>[];
  complete?: string | null;
}
export interface LockstepBridge {
  prepare(message: PrepareMessage, signal?: AbortSignal, localSlot?: Slot): Promise<void>;
  step(tick: number, p1: number, p2: number, join?: PlayerJoin, leave?: PlayerLeave): StepResult;
  supportsStagedStep?(): boolean;
  supportsCompactStep?(): boolean;
  /** The foreground renderer requests live work in the task after paint. */
  requiresPaintBeforeStep?(): boolean;
  stepStaged?(tick: number, p1: number, p2: number, join?: PlayerJoin, signal?: AbortSignal, leave?: PlayerLeave): Promise<StepResult>;
  stepCompact?(tick: number, p1: number, p2: number, join?: PlayerJoin, signal?: AbortSignal, leave?: PlayerLeave): Promise<StepResult>;
  finishReplay?(tick: number): void;
  supportsCheckpoint?(): boolean;
  exportCheckpoint?(): NativeCheckpoint;
  importCheckpoint?(payload: string, tick: number, digest: string): StepResult;
}
export interface StagedStepRuntime {
  /** Schedule compact and full live invocations after the renderer, as well
   * as the boundaries inside a full step. Replay keeps its ordinary tasks. */
  alignLiveStepsToPaint?: boolean;
  /** Resolve in a task following a rendering opportunity, never inside rAF. */
  yield(signal?: AbortSignal): Promise<void>;
  /** Pinned native cleanup callback, outside the ordinary poisoned collector. */
  abort(key: StagedStepKey): unknown;
  /** Separate compact callback; a full-step abort must never close its owner. */
  abortCompact?(key: StagedStepKey): unknown;
  /** A partially advanced world is permanently disposed after any failure. */
  dispose(): void;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length > MAX_NATIVE_ENCODING_LENGTH) throw new ClientError('The SWF bridge response is too large.');
  try { return JSON.parse(value); } catch {
    throw new ClientError('The SWF bridge returned invalid JSON.');
  }
}

function safeNativeData(value: unknown, depth = 0, budget = { remaining: 100_000, characters: MAX_NATIVE_ENCODING_LENGTH }): void {
  if (--budget.remaining < 0 || depth > 24) throw new ClientError('The SWF state exceeds the size limit.');
  // ExternalInterface may preserve an absent optional terminal result as undefined.
  // The native projection itself normalises graph undefined/NaN as explicit objects.
  if (value === null || value === undefined || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') {
    budget.characters -= value.length;
    if (budget.characters < 0) throw new ClientError('The SWF state strings exceed the total size limit.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 16_384) throw new ClientError('The SWF state array is too large.');
    for (const entry of value) safeNativeData(entry, depth + 1, budget);
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 16_384) throw new ClientError('The SWF state object is too large.');
    for (const key of keys) {
      budget.characters -= key.length;
      if (budget.characters < 0) throw new ClientError('The SWF state fields exceed the total size limit.');
      if (key.length > 256 || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new ClientError('Invalid SWF state field.');
      }
      safeNativeData(value[key], depth + 1, budget);
    }
    return;
  }
  throw new ClientError('The SWF bridge returned invalid state values.');
}

function players(value: unknown, uninitialised = false): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 2) return false;
  const slots = new Set<number>();
  return value.every((player) => {
    if (!isRecord(player) || !integer(player.slot, 1, 2) || slots.has(player.slot) ||
        !integer(player.id, 0, 0x7fffffff) || !integer(player.flags, 0, 0xffffffff) ||
        !['x', 'y', 'z', 'angle'].every((key) => typeof player[key] === 'number' && Number.isFinite(player[key]))) return false;
    // Original Process_Init runs on the first gameplay tick. At prepared tick 0
    // only identity/position/flags exist; do not invent health or run a hidden tick.
    for (const key of ['life', 'ammo']) {
      if (uninitialised && player[key] === undefined) continue;
      if (typeof player[key] !== 'number' || !Number.isFinite(player[key])) return false;
    }
    for (const key of ['state', 'weapon']) {
      if (uninitialised && player[key] === undefined) continue;
      if (!boundedText(player[key], 128)) return false;
    }
    slots.add(player.slot);
    return true;
  });
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
}

export function readInfo(raw: unknown): NativeInfo {
  const value = decode(raw);
  if (!isRecord(value) || value.version !== 1 || value.engine !== 'original-swf' ||
      !['menu', 'loading', 'ready', 'playing', 'error'].includes(String(value.state)) ||
      !integer(value.tick, 0, 0x7fffffff) ||
      (value.canPrepare !== undefined && typeof value.canPrepare !== 'boolean') ||
      (value.menuVersion !== undefined && value.menuVersion !== 1) ||
      (value.snapshotReceiptVersion !== undefined && value.snapshotReceiptVersion !== 1) ||
      (value.stagedStepVersion !== undefined && value.stagedStepVersion !== 1) ||
      (value.compactStepVersion !== undefined && value.compactStepVersion !== 1) ||
      (value.checkpointVersion !== undefined && value.checkpointVersion !== 1) ||
      (value.error !== undefined && !boundedText(value.error, 1024))) {
    throw new ClientError('bhInfo does not match the original SWF contract.');
  }
  if (value.state === 'error') throw new ClientError('The original SWF reported a bridge error.');
  return value as unknown as NativeInfo;
}

export function readStep(raw: unknown): StepResult {
  const value = decode(raw);
  safeNativeData(value);
  if (!isRecord(value) || !integer(value.tick, 1, 0x7fffffff) || !digest(value.digest) || !players(value.players)) {
    throw new ClientError('bhStep did not return a valid tick, native digest and state for the existing players.');
  }
  if (value.complete !== undefined && value.complete !== null && value.complete !== '' &&
      (!boundedText(value.complete, 128) || value.complete === 'error')) {
    throw new ClientError('The original game returned a completion error.');
  }
  return value as StepResult;
}

export function readState(raw: unknown): Record<string, unknown> {
  const value = decode(raw);
  // Validate the exact received envelope once, before adding a compatibility
  // alias. The complete native projection still passes the original budgets.
  safeNativeData(value);
  if (!isRecord(value) || !players(value.players, value.tick === 0) ||
      !Object.prototype.hasOwnProperty.call(value, 'rng') || value.rng === null) {
    throw new ClientError('bhState is missing the original native RNG, players and entities.');
  }
  const hasEntities = 'entities' in value;
  let entities = value.entities;
  if (!hasEntities) {
    const native = value.native;
    // An omitted top-level alias is valid only for the complete current native
    // snapshot envelope. A present invalid alias must never use this fallback.
    if (!['version', 'engine', 'state', 'tick', 'digest', 'digestSchema', 'scope', 'players', 'rng', 'native']
          .every(key => Object.hasOwn(value, key)) ||
        value.version !== 1 || value.engine !== 'original-swf' ||
        (value.state !== 'ready' && value.state !== 'playing') || value.error !== undefined ||
        !integer(value.tick, 0, 0x7fffffff) || !digest(value.digest) ||
        value.digestSchema !== 'native-projection-v3' ||
        (value.scope !== 'frame' && value.scope !== 'full') || value.rng === undefined ||
        !isRecord(native) || !['tick', 'scope', 'entities'].every(key => Object.hasOwn(native, key)) ||
        native.tick !== value.tick || native.scope !== value.scope) {
      throw new ClientError('bhState returned an incomplete or inconsistent native snapshot without top-level entities.');
    }
    entities = native.entities;
  }
  if (!(Array.isArray(entities) || isRecord(entities))) {
    throw new ClientError('bhState is missing the original native RNG, players and entities.');
  }
  if (value.tick !== undefined && !integer(value.tick, 0, 0x7fffffff)) {
    throw new ClientError('bhState returned an invalid tick.');
  }
  if (value.digest !== undefined && !digest(value.digest)) {
    throw new ClientError('bhState returned an invalid digest.');
  }
  return hasEntities ? value : { ...value, entities };
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClientError('Loading cancelled.');
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ClientError('Loading cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Calls only real Ruffle ExternalInterface callbacks; there is no simulated bridge. */
export class OriginalBridge implements LockstepBridge {
  private prepared = false;
  private lastTick = 0;
  private initialPlayers: 1 | 2 = 2;
  private joinedPlayers: 1 | 2 = 2;
  private membershipVersion = 0;
  private snapshotReceipts = false;
  private checkpointGuest = false;
  private stagedStepSupported = false;
  private compactStepSupported = false;
  private stepInFlight = false;
  private asynchronousStepKind: 'staged' | 'compact' | null = null;
  private stagedFailureHandled = false;

  constructor(private readonly invoke: NativeInvoke, private readonly snapshotExports?: NativeSnapshotExports,
    private readonly stagedRuntime?: StagedStepRuntime) {}

  async waitUntilAvailable(signal?: AbortSignal, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (true) {
      cancelled(signal);
      let raw: unknown;
      try { raw = this.invoke('bhInfo'); } catch { raw = undefined; }
      if (raw !== undefined && raw !== null && raw !== '') {
        if (readInfo(raw).canPrepare === true) return;
      }
      if (Date.now() >= deadline) {
        throw new ClientError('The online SWF did not finish loading the original menu. Online play stopped.');
      }
      await delay(50, signal);
    }
  }

  info(): NativeInfo { return readInfo(this.call('bhInfo')); }

  menuPoll(): NativeMenuEvent | null { return readMenuEvent(decode(this.call('bhMenuPoll'))); }

  menuUpdate(update: NativeMenuUpdate): void {
    const result = decode(this.call('bhMenuUpdate', update.state, update.payload));
    if (!isRecord(result) || result.ok !== true) throw new ClientError('The original menu did not confirm the update.');
  }

  controls(): NativeControls { return readControls(decode(this.call('bhControls'))); }
  renderCheck(): NativeRenderCheck { return readRenderCheck(decode(this.call('bhRenderCheck'))); }

  async prepare(message: PrepareMessage, signal?: AbortSignal, localSlot: Slot = 1): Promise<void> {
    cancelled(signal);
    if (this.stepInFlight) {
      this.stopStagedStep();
      throw new ClientError('Preparation cannot interrupt an unfinished native step.');
    }
    this.prepared = false;
    this.snapshotReceipts = false;
    this.stagedStepSupported = false;
    this.compactStepSupported = false;
    this.snapshotExports?.cancel();
    this.initialPlayers = message.initialPlayers ?? 2;
    this.joinedPlayers = this.initialPlayers;
    this.membershipVersion = message.membershipVersion ?? 0;
    this.checkpointGuest = message.replay === true && localSlot === 2 && this.initialPlayers === 1;
    if (message.replay === true && (localSlot !== 2 || (this.initialPlayers !== 1 && this.membershipVersion !== 2) || message.personalProgression !== true)) {
      throw new ClientError('Only a guest joining a solo room can accelerate replay rendering.');
    }
    // Registered callbacks can precede completion of the original background
    // resource-loading tasks. Do not race the native menu with an arbitrary sleep.
    await this.waitUntilAvailable(signal, 20_000);
    const args: unknown[] = [message.seed, message.mode, message.map,
      message.characters[0], message.characters[1], readSettings(message.settings)];
    if (message.initialPlayers !== undefined || message.personalProgression !== undefined) {
      args.push({ initialPlayers: this.initialPlayers, personalProgression: message.personalProgression === true, localSlot,
        ...(message.replay === true ? { replay: true } : {}),
        ...(this.membershipVersion ? { membershipVersion: this.membershipVersion } : {}) });
    }
    const status = decode(this.call('bhPrepare', ...args));
    if (!isRecord(status) || status.ok === false || status.state === 'error' ||
        (status.error !== undefined && status.error !== '') ||
        !(status.ok === true || status.state === 'loading' || status.state === 'ready')) {
      throw new ClientError('bhPrepare did not confirm preparation of the original game.');
    }
    // The native resource/cache initializer has its own 180-second ceiling.
    const deadline = Date.now() + 185_000;
    while (true) {
      cancelled(signal);
      const info = this.info();
      if (info.state === 'ready') {
        if (info.tick !== 0) throw new ClientError('The prepared SWF must start at tick 0.');
        this.checkedState(0);
        if (info.snapshotReceiptVersion === 1 && !this.snapshotExports) {
          throw new ClientError('The SWF requires an available native receipt controller. Online play stopped.');
        }
        this.snapshotReceipts = info.snapshotReceiptVersion === 1;
        this.stagedStepSupported = info.stagedStepVersion === 1;
        this.compactStepSupported = info.compactStepVersion === 1;
        this.lastTick = 0;
        this.prepared = true;
        return;
      }
      if (info.state === 'playing' || Date.now() >= deadline) {
        throw new ClientError('The SWF did not enter the paused ready state.');
      }
      await delay(40, signal);
    }
  }

  supportsCheckpoint(): boolean {
    return this.prepared && this.membershipVersion === 0 && this.info().checkpointVersion === 1;
  }

  finishReplay(tick: number): void {
    if (!this.prepared || this.membershipVersion === 0 || this.stepInFlight || tick !== this.lastTick || this.joinedPlayers !== 1) {
      throw new ClientError('Invalid native world restore boundary.');
    }
    const info = readInfo(this.call('bhReplayEnd', tick));
    if (info.tick !== tick || !['ready', 'playing'].includes(info.state)) {
      this.prepared = false;
      throw new ClientError('The native world did not confirm replay completion.');
    }
  }

  exportCheckpoint(): NativeCheckpoint {
    if (!this.prepared || this.checkpointGuest || this.joinedPlayers !== 1 || this.lastTick < 25 || this.lastTick % 25 !== 0) {
      throw new ClientError('Only a solo host at a full checkpoint can create a world snapshot.');
    }
    const before = this.info();
    const raw = this.call('bhCheckpointExport');
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isRecord(value) || value.version !== 1 || value.tick !== this.lastTick || !digest(value.digest)
      || typeof value.payload !== 'string' || !value.payload.length || value.payload.length > MAX_CHECKPOINT_RAW_BYTES) {
      throw new ClientError('Native world export was not confirmed.');
    }
    const after = this.info();
    const state = readState(this.call('bhState', false, false, true));
    if (before.state !== 'playing' || after.state !== before.state || after.tick !== before.tick
      || state.tick !== value.tick || state.digest !== value.digest) {
      throw new ClientError('Exporting the snapshot changed the native host world.');
    }
    return { version: 1, tick: value.tick as number, digest: value.digest, payload: value.payload };
  }

  importCheckpoint(payload: string, tick: number, expectedDigest: string): StepResult {
    if (!this.prepared || !this.checkpointGuest || this.lastTick !== 0 || this.joinedPlayers !== 1
      || !integer(tick, 25, 0x7fffffff) || tick % 25 !== 0 || !digest(expectedDigest)
      || typeof payload !== 'string' || payload.length < 1 || payload.length > MAX_CHECKPOINT_RAW_BYTES) {
      throw new ClientError('Only a new guest can import a world before the first native step.');
    }
    try {
      const result = readStep(this.call('bhCheckpointImport', payload, tick, expectedDigest));
      const info = this.info();
      const state = readState(this.call('bhState', false, false, true));
      if (result.tick !== tick || result.digest !== expectedDigest || result.complete
        || info.state !== 'playing' || info.tick !== tick || info.checkpointVersion !== 1
        || state.tick !== tick || state.digest !== expectedDigest
        || result.players.length !== 1 || result.players[0].slot !== 1
        || (state.players as Record<string, unknown>[]).length !== 1
        || (state.players as Record<string, unknown>[])[0].slot !== 1) {
        throw new ClientError('Native readback did not confirm the restored world.');
      }
      this.lastTick = tick;
      return result;
    } catch (error) {
      this.prepared = false;
      this.snapshotExports?.cancel();
      throw error;
    }
  }

  supportsStagedStep(): boolean {
    return this.prepared && !this.stepInFlight && this.snapshotReceipts && this.stagedStepSupported
      && this.snapshotExports !== undefined && this.stagedRuntime !== undefined;
  }

  supportsCompactStep(): boolean {
    return this.prepared && !this.stepInFlight && this.snapshotReceipts && this.compactStepSupported
      && this.snapshotExports !== undefined && this.stagedRuntime?.abortCompact !== undefined;
  }

  requiresPaintBeforeStep(): boolean {
    // Capability is cached from the preceding validated Info. Never query the
    // native VM to make a scheduling decision while another owner is active.
    return this.stagedRuntime?.alignLiveStepsToPaint === true
      && (this.supportsStagedStep() || this.supportsCompactStep());
  }

  private validateStep(tick: number, p1: number, p2: number, join?: PlayerJoin, leave?: PlayerLeave): void {
    if (this.stepInFlight) {
      this.stopStagedStep();
      throw new ClientError('The next native step arrived before the previous one finished.');
    }
    if (!this.prepared || tick !== this.lastTick + 1 || !isMask(p1) || !isMask(p2)) {
      throw new ClientError('Invalid native step order or input mask.');
    }
    if (leave !== undefined) {
      readPlayerLeave(leave);
      if (this.membershipVersion === 0 || this.joinedPlayers !== 2 || join !== undefined || p2 !== 0) {
        throw new ClientError('Invalid second-player departure.');
      }
    }
    if (join !== undefined) {
      readPlayerJoin(join);
      if (this.joinedPlayers !== 1) throw new ClientError('The second player is already in the world.');
    } else if (this.joinedPlayers === 1 && p2 !== 0) {
      throw new ClientError('Input for the second player arrived before they spawned.');
    }
  }

  step(tick: number, p1: number, p2: number, join?: PlayerJoin, leave?: PlayerLeave): StepResult {
    this.validateStep(tick, p1, p2, join, leave);
    try {
      // Invoke exactly once. Only an explicitly supported VM gets the fifth
      // token argument; older runtimes keep their original argument list.
      const token = this.snapshotReceipts ? this.snapshotExports!.beginStep(tick) : undefined;
      const raw = leave !== undefined ? this.call('bhStep', tick, p1, p2, join, token, leave)
        : token !== undefined ? this.call('bhStep', tick, p1, p2, join, token)
        : join === undefined ? this.call('bhStep', tick, p1, p2) : this.call('bhStep', tick, p1, p2, join);
      return this.finishStep(raw, tick, join, 'sync', leave);
    } catch (error) {
      this.snapshotExports?.cancel();
      this.prepared = false;
      throw error;
    }
  }

  async stepStaged(tick: number, p1: number, p2: number, join?: PlayerJoin, signal?: AbortSignal, leave?: PlayerLeave): Promise<StepResult> {
    cancelled(signal);
    this.validateStep(tick, p1, p2, join, leave);
    // Select compatibility before executing anything. A failed/partial staged
    // transaction must never run bhStep as a retry on the advanced world.
    if (leave !== undefined || tick % 25 !== 0 || !this.supportsStagedStep()) return this.step(tick, p1, p2, join, leave);
    this.stepInFlight = true;
    this.asynchronousStepKind = 'staged';
    try {
      const token = this.snapshotExports!.beginStagedStep(tick);
      this.call('bhStepBegin', tick, p1, p2, join, token);
      for (const callback of ['bhStepPrepare', 'bhStepProject', 'bhStepCommit'] as const) {
        const key = this.snapshotExports!.stagedStepRequest();
        await this.stagedRuntime!.yield(signal);
        cancelled(signal);
        const current = this.snapshotExports!.stagedStepRequest();
        if (current.token !== key.token || current.epoch !== key.epoch || current.tick !== key.tick) {
          throw new ClientError('The native stage owner changed while waiting for a frame.');
        }
        const raw = this.call(callback, key.token, key.epoch, key.tick);
        if (callback === 'bhStepCommit') {
          // Complete native export, Info, one-shot receipt and graph validation
          // remain one synchronous continuation before the session can ACK.
          return this.finishStep(raw, tick, join, 'staged', leave);
        }
      }
      throw new ClientError('The full native check did not complete.');
    } catch (error) {
      this.stopStagedStep();
      throw error;
    } finally {
      this.stepInFlight = false;
      this.asynchronousStepKind = null;
    }
  }

  async stepCompact(tick: number, p1: number, p2: number, join?: PlayerJoin, signal?: AbortSignal, leave?: PlayerLeave): Promise<StepResult> {
    cancelled(signal);
    this.validateStep(tick, p1, p2, join, leave);
    // Scope and compatibility are selected before Begin. Once the original
    // Process/Draw has run, failure cannot fall back to another simulation.
    if (leave !== undefined || tick % 25 === 0 || !this.supportsCompactStep()) return this.step(tick, p1, p2, join, leave);
    this.stepInFlight = true;
    this.asynchronousStepKind = 'compact';
    try {
      const token = this.snapshotExports!.beginCompactStep(tick);
      this.call('bhFrameBegin', tick, p1, p2, join, token);
      const key = this.snapshotExports!.compactStepRequest();
      await this.stagedRuntime!.yield(signal);
      cancelled(signal);
      const current = this.snapshotExports!.compactStepRequest();
      if (current.token !== key.token || current.epoch !== key.epoch || current.tick !== key.tick) {
        throw new ClientError('The intermediate native frame owner changed while waiting.');
      }
      const raw = this.call('bhFrameCommit', key.token, key.epoch, key.tick);
      // No yield can separate this actual export from Info, Receipt and the
      // checked state returned to Session for its ACK.
      return this.finishStep(raw, tick, join, 'compact', leave);
    } catch (error) {
      this.stopStagedStep();
      throw error;
    } finally {
      this.stepInFlight = false;
      this.asynchronousStepKind = null;
    }
  }

  private finishStep(raw: unknown, tick: number, join?: PlayerJoin,
    protocol: 'sync' | 'staged' | 'compact' = 'sync', leave?: PlayerLeave): StepResult {
    const result = readStep(raw);
    if (result.tick !== tick) throw new ClientError('The bhStep tick differs from the server frame. ACK was not sent.');
    const info = this.info();
    if (info.tick !== tick || (info.state !== 'playing' && info.state !== 'ready')
      || (this.snapshotReceipts && info.snapshotReceiptVersion !== 1)
      || (protocol === 'staged' && info.stagedStepVersion !== 1)
      || (protocol === 'compact' && info.compactStepVersion !== 1)) {
      throw new ClientError('bhInfo does not confirm the completed native tick. ACK was not sent.');
    }
    const state = this.checkedState(tick, result.digest);
    const stateHasGuest = (state.players as Record<string, unknown>[]).some((player) => player.slot === 2);
    const resultHasGuest = result.players.some((player) => player.slot === 2);
    if (leave) {
      if (stateHasGuest || resultHasGuest) throw new ClientError('The SWF did not confirm the departure of the second player.');
      this.joinedPlayers = 1;
    }
    if (this.joinedPlayers === 1 && !join && (stateHasGuest || resultHasGuest)) {
      throw new ClientError('The second player spawned without a server command. ACK was not sent.');
    }
    if (join) {
      if (!resultHasGuest || !stateHasGuest) throw new ClientError('The SWF did not confirm the spawn of the second player.');
      this.joinedPlayers = 2;
    }
    this.stagedStepSupported = info.stagedStepVersion === 1;
    this.compactStepSupported = info.compactStepVersion === 1;
    this.lastTick = tick;
    return result;
  }

  private stopStagedStep(): void {
    if (this.stagedFailureHandled) return;
    this.stagedFailureHandled = true;
    this.prepared = false;
    this.stagedStepSupported = false;
    this.compactStepSupported = false;
    try {
      if (this.asynchronousStepKind === 'compact') {
        this.snapshotExports?.abortCompactStep(key => this.stagedRuntime?.abortCompact?.(key));
      } else this.snapshotExports?.abortStagedStep(key => this.stagedRuntime?.abort(key));
    } catch { /* Disposal is mandatory even when native cleanup rejects. */ }
    finally { this.stagedRuntime?.dispose(); }
  }

  private checkedState(tick: number, expectedDigest?: string): Record<string, unknown> {
    // Read the same cached actual snapshot with its entity graph transferred
    // only under native. Older callbacks ignore the optional third argument.
    let raw: unknown;
    if (tick > 0 && this.snapshotReceipts) {
      const request = this.snapshotExports!.receiptRequest();
      const receipt = this.call('bhStateReceipt', request.token, request.epoch, request.tick);
      raw = this.snapshotExports!.consumeReceipt(receipt);
    } else raw = this.call('bhState', false, false, true);
    const state = readState(raw);
    // The original removes a dead player from mPlayerThings and may keep no
    // live players on the terminal tick. Preparation must match the agreed roster.
    if (tick === 0 && ((state.players as unknown[]).length !== this.initialPlayers ||
        (this.initialPlayers === 1 && !(state.players as Record<string, unknown>[]).some((player) => player.slot === 1)))) {
      throw new ClientError(this.initialPlayers === 2 ? 'The prepared game must contain both initial players.' :
        'The prepared solo room must contain only the host.');
    }
    if (state.tick !== undefined && state.tick !== tick) {
      throw new ClientError('The bhState tick differs from bhStep. ACK was not sent.');
    }
    if (expectedDigest !== undefined && state.digest !== undefined && state.digest !== expectedDigest) {
      throw new ClientError('The bhState native digest differs from bhStep. ACK was not sent.');
    }
    return state;
  }

  private call(name: NativeCallback, ...args: unknown[]): unknown {
    try { return this.invoke(name, ...args); } catch {
      throw new ClientError('Could not call a required original SWF bridge callback.');
    }
  }
}

