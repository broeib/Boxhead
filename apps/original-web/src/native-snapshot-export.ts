import { ClientError, integer, isRecord } from './protocol';
import { digestOriginalState, digestOriginalStateReadonly, installOriginalDigestHelpers, MAX_NATIVE_ENCODING_LENGTH } from './native-digest';
import type { NativeCallback } from './bridge';

type Target = Record<string, unknown>;
type Scope = 'frame' | 'full';
interface ReceiptKey { version: 1; token: string; epoch: number; tick: number; scope: Scope }
interface Capture {
  key: ReceiptKey;
  native: Record<string, unknown>;
  digest: string;
  bytes: number;
}
interface Pending {
  token: string;
  tick: number;
  mode: 'sync' | 'staged' | 'compact';
  phase: 'open' | 'begun' | 'prepared' | 'projected' | 'captured' | 'receipted';
  epoch?: number;
  infoRead?: boolean;
  capture?: Capture;
  receipt?: unknown;
}
export interface StagedStepKey { token: string; epoch: number; tick: number }
interface Installation { target: Target }
interface Invocation { owner: NativeSnapshotExports; name: NativeCallback }

const installations = new WeakMap<Target, Installation>();
let activeInvocation: Invocation | null = null;
let nextOwner = 0;

function failure(message: string): ClientError {
  return new ClientError('Native snapshot receipt: ' + message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validKey(value: unknown): value is ReceiptKey & Record<string, unknown> {
  return isRecord(value) && exactKeys(value, ['version', 'token', 'epoch', 'tick', 'scope'])
    && value.version === 1 && typeof value.token === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(value.token)
    && integer(value.epoch, 1, 0x7fffffff) && integer(value.tick, 1, 0x7fffffff)
    && (value.scope === 'frame' || value.scope === 'full');
}

function decodeReceipt(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw.length > MAX_NATIVE_ENCODING_LENGTH) throw failure('response is too large.');
  try { return JSON.parse(raw); } catch { throw failure('response is not valid JSON.'); }
}

/** Install once per page. Later VM loads reuse the producer and never reset an
 * existing owner's capture or an outer, passive observation wrapper. */
export function installSnapshotDigestHelpers(target: Target): void {
  if (activeInvocation) {
    activeInvocation.owner.poison();
    throw failure('helper installation during a native call.');
  }
  if (installations.has(target)) return;
  installOriginalDigestHelpers(target);
  const installation: Installation = { target };
  installations.set(target, installation);
  target.boxheadDigestOriginalState = (native: unknown, request?: unknown) => {
    const invocation = activeInvocation;
    if (invocation?.name === 'bhStepAbort' || invocation?.name === 'bhFrameAbort') {
      invocation.owner.poison();
      throw failure('cleanup cannot export state.');
    }
    if (request === undefined) {
      if (invocation?.owner.expectsReceipt()) {
        invocation.owner.poison();
        throw failure('digest call skipped the required receipt.');
      }
      return digestOriginalState(native);
    }
    if (!invocation || !['bhStep', 'bhStepCommit', 'bhFrameCommit'].includes(invocation.name)
      || !invocation.owner.belongsTo(installation)) {
      invocation?.owner.poison();
      throw failure('export outside the active step of the corresponding VM.');
    }
    return invocation.owner.capture(native, request);
  };
}

/** One VM owns one collector. A staged transaction keeps only an identity
 * between tasks. Its actual graph is captured once at Commit and consumed by
 * that same task's native receipt; it is never a world-state cache. */
export class NativeSnapshotExports {
  private readonly installation: Installation;
  private readonly prefix: string;
  private serial = 0;
  private lastEpoch = 0;
  private pending: Pending | null = null;
  private disposed = false;
  private poisoned = false;
  private failedPhase: { mode: 'staged' | 'compact'; key: StagedStepKey } | null = null;

  constructor(target: Target, tokenPrefix?: string) {
    installSnapshotDigestHelpers(target);
    this.installation = installations.get(target)!;
    this.prefix = tokenPrefix ?? ('vm_' + (++nextOwner).toString(36));
    if (!/^[A-Za-z0-9_]{1,60}$/.test(this.prefix)) throw failure('invalid owner token.');
  }

  belongsTo(installation: Installation): boolean { return this.installation === installation; }
  expectsReceipt(): boolean { return this.pending !== null; }

  poison(): void {
    if (this.pending && this.pending.mode !== 'sync' && this.pending.epoch !== undefined) {
      this.failedPhase = { mode: this.pending.mode,
        key: { token: this.pending.token, epoch: this.pending.epoch, tick: this.pending.tick } };
    }
    this.poisoned = true;
    this.pending = null;
  }

  private assertAlive(): void {
    if (this.disposed || this.poisoned) throw failure('export is closed or invalid.');
  }

  beginStep(tick: number): string {
    return this.begin(tick, 'sync');
  }

  beginStagedStep(tick: number): string {
    if (!integer(tick, 25, 0x7fffffff) || tick % 25 !== 0) {
      this.poison();
      throw failure('stages are only allowed for a full check.');
    }
    return this.begin(tick, 'staged');
  }

  beginCompactStep(tick: number): string {
    if (!integer(tick, 1, 0x7fffffff) || tick % 25 === 0) {
      this.poison();
      throw failure('two phases are only allowed for an intermediate frame.');
    }
    return this.begin(tick, 'compact');
  }

  private begin(tick: number, mode: Pending['mode']): string {
    if (activeInvocation) {
      activeInvocation.owner.poison();
      this.poison();
      throw failure('nested step request.');
    }
    this.assertAlive();
    if (this.pending || !integer(tick, 1, 0x7fffffff) || this.serial >= 0x7fffffff) {
      this.poison();
      throw failure('repeated or nested step request.');
    }
    const token = this.prefix + '_' + (++this.serial).toString(36);
    this.pending = { token, tick, mode, phase: 'open' };
    return token;
  }

  stagedStepRequest(): StagedStepKey {
    return this.phaseRequest('staged');
  }

  compactStepRequest(): StagedStepKey {
    return this.phaseRequest('compact');
  }

  private phaseRequest(mode: 'staged' | 'compact'): StagedStepKey {
    this.assertAlive();
    const pending = this.pending;
    if (!pending || pending.mode !== mode || pending.epoch === undefined
      || !(mode === 'compact' ? ['begun'] : ['begun', 'prepared', 'projected']).includes(pending.phase)) {
      this.poison();
      throw failure('no confirmed intermediate stage.');
    }
    return { token: pending.token, epoch: pending.epoch, tick: pending.tick };
  }

  private allows(pending: Pending, name: NativeCallback, args: readonly unknown[]): boolean {
    if (pending.phase === 'open') {
      return name === (pending.mode === 'sync' ? 'bhStep' : pending.mode === 'compact' ? 'bhFrameBegin' : 'bhStepBegin')
        && (args.length === 5 || (args.length === 6 && args[2] === 0 && args[3] === undefined
          && isRecord(args[5]) && exactKeys(args[5], ['slot']) && args[5].slot === 2))
        && args[0] === pending.tick && args[4] === pending.token;
    }
    if (pending.phase === 'captured') {
      if (name === 'bhInfo') return args.length === 0 && (pending.mode === 'sync' || !pending.infoRead);
      return name === 'bhStateReceipt' && args.length === 3 && args[0] === pending.token
        && args[1] === pending.capture?.key.epoch && args[2] === pending.tick
        && (pending.mode === 'sync' || pending.infoRead === true);
    }
    if (pending.mode === 'sync' || pending.phase === 'receipted') return false;
    if (name === 'bhPresent') return args.length === 1 && typeof args[0] === 'number'
      && Number.isFinite(args[0]) && args[0] >= 0 && args[0] <= 1;
    const next = pending.mode === 'compact' ? 'bhFrameCommit' : pending.phase === 'begun' ? 'bhStepPrepare'
      : pending.phase === 'prepared' ? 'bhStepProject' : 'bhStepCommit';
    return name === next && args.length === 3 && args[0] === pending.token
      && args[1] === pending.epoch && args[2] === pending.tick;
  }

  private acceptStage(pending: Pending, name: NativeCallback, raw: unknown): void {
    const phase = name === 'bhStepBegin' || name === 'bhFrameBegin' ? 'begun'
      : name === 'bhStepPrepare' ? 'prepared' : 'projected';
    const value = decodeReceipt(raw);
    if (this.pending !== pending || !isRecord(value)
      || !exactKeys(value, ['version', 'phase', 'token', 'epoch', 'tick']) || value.version !== 1
      || value.phase !== phase || value.token !== pending.token || value.tick !== pending.tick
      || !integer(value.epoch, 1, 0x7fffffff) || value.epoch <= this.lastEpoch
      || (pending.epoch !== undefined && value.epoch !== pending.epoch) || pending.capture) {
      throw failure('the intermediate stage did not confirm the exact native transaction.');
    }
    this.assertAlive();
    pending.epoch = value.epoch as number;
    pending.phase = phase;
  }

  /** Wrap every public EI call, including menu/info, to detect reentry across
   * owners. The AS2 guard independently rejects calls bypassing this wrapper. */
  invoke<T>(name: NativeCallback, args: readonly unknown[], rawCall: () => T): T {
    if (activeInvocation) {
      activeInvocation.owner.poison();
      this.poison();
      throw failure('nested ExternalInterface call.');
    }
    this.assertAlive();
    const pending = this.pending;
    if ((pending && !this.allows(pending, name, args))
      || (!pending && ['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhStepCommit', 'bhStepAbort',
        'bhFrameBegin', 'bhFrameCommit', 'bhFrameAbort'].includes(name))) {
      this.poison();
      throw failure('call violates the native stage / Info / Receipt order.');
    }
    const invocation: Invocation = { owner: this, name };
    activeInvocation = invocation;
    try {
      const result = rawCall();
      this.assertAlive();
      if (pending && ['bhStepBegin', 'bhStepPrepare', 'bhStepProject', 'bhFrameBegin'].includes(name)) {
        this.acceptStage(pending, name, result);
      }
      if (pending && ['bhStep', 'bhStepCommit', 'bhFrameCommit'].includes(name)) {
        if (this.pending !== pending || !pending.capture
          || pending.phase !== (pending.mode === 'sync' ? 'open' : pending.mode === 'compact' ? 'begun' : 'projected')) {
          throw failure('step did not create exactly one native export.');
        }
        pending.phase = 'captured';
      }
      if (pending && pending.mode !== 'sync' && name === 'bhInfo') pending.infoRead = true;
      if (pending && name === 'bhStateReceipt') {
        if (this.pending !== pending || pending.phase !== 'captured' || !pending.capture) {
          throw failure('receipt is not linked to a completed native step.');
        }
        pending.receipt = result;
        pending.phase = 'receipted';
      }
      return result;
    } catch (error) {
      // Callback registration can still be pending during the ordinary menu
      // availability probe. No export exists to invalidate on that legacy path.
      if (pending) this.poison();
      throw error;
    } finally {
      if (activeInvocation === invocation) activeInvocation = null;
      else this.poison();
    }
  }

  /** Called only by the actual installed digest producer while native Step or
   * staged Commit is on the stack. No intermediate phase can export a graph. */
  capture(native: unknown, request: unknown): { digest: string; bytes: number; receipt: ReceiptKey } {
    try {
      this.assertAlive();
      const pending = this.pending;
      if (!activeInvocation || activeInvocation.owner !== this || !pending
        || activeInvocation.name !== (pending.mode === 'sync' ? 'bhStep' : pending.mode === 'compact' ? 'bhFrameCommit' : 'bhStepCommit')
        || pending.phase !== (pending.mode === 'sync' ? 'open' : pending.mode === 'compact' ? 'begun' : 'projected')
        || pending.capture || !validKey(request)
        || request.token !== pending.token || request.tick !== pending.tick || request.epoch <= this.lastEpoch
        || (pending.mode !== 'sync' && request.epoch !== pending.epoch)
        || request.scope !== (pending.tick % 25 === 0 ? 'full' : 'frame')
        || !isRecord(native) || native.tick !== request.tick || native.scope !== request.scope
        || !['tick', 'scope', 'entities'].every(field => Object.hasOwn(native, field))
        || !(isRecord(native.entities) || Array.isArray(native.entities))) {
        throw failure('native export was skipped, replaced or repeated.');
      }
      const digest = digestOriginalStateReadonly(native);
      // Foreign property-descriptor/proxy operations can execute host code;
      // reentry/disposal stays fatal even when its error is caught.
      this.assertAlive();
      if (this.pending !== pending || pending.capture) throw failure('export changed during digest.');
      const key: ReceiptKey = { version: 1, token: request.token, epoch: request.epoch, tick: request.tick, scope: request.scope };
      pending.capture = { key, native, digest: digest.digest, bytes: digest.bytes };
      return { ...digest, receipt: { ...key } };
    } catch (error) {
      this.poison();
      throw error;
    }
  }

  receiptRequest(): { token: string; epoch: number; tick: number } {
    this.assertAlive();
    const pending = this.pending;
    if (!pending || pending.phase !== 'captured' || !pending.capture) {
      this.poison();
      throw failure('no completed native step for the receipt.');
    }
    const key = pending.capture.key;
    return { token: key.token, epoch: key.epoch, tick: key.tick };
  }

  consumeReceipt(raw: unknown): Record<string, unknown> {
    try {
      this.assertAlive();
      if (activeInvocation) throw failure('receipt consumed inside a native call.');
      const pending = this.pending;
      const capture = pending?.capture;
      const value = decodeReceipt(raw);
      if (!pending || pending.phase !== 'receipted' || !Object.is(raw, pending.receipt) || !capture || !isRecord(value)
        || !exactKeys(value, ['version', 'token', 'epoch', 'tick', 'scope', 'header'])) {
        throw failure('a valid native receipt is missing.');
      }
      const key = capture.key;
      if (value.version !== 1 || value.token !== key.token || value.epoch !== key.epoch
        || value.tick !== key.tick || value.scope !== key.scope || !isRecord(value.header)) {
        throw failure('native receipt belongs to a different step.');
      }
      const header = value.header;
      if ('native' in header || 'entities' in header
        || !['version', 'engine', 'state', 'tick', 'scope', 'digest', 'digestSchema', 'players', 'rng',
          'snapshotBytes', 'snapshotObjects', 'snapshotFields', 'profile']
          .every(field => Object.hasOwn(header, field))
        || header.version !== 1 || header.engine !== 'original-swf'
        || (header.state !== 'ready' && header.state !== 'playing') || header.error !== undefined
        || header.tick !== key.tick || header.scope !== key.scope || header.digestSchema !== 'native-projection-v3'
        || header.digest !== capture.digest || header.snapshotBytes !== capture.bytes
        || !integer(header.snapshotObjects, 0, 0x7fffffff) || !integer(header.snapshotFields, 0, 0x7fffffff)
        || !isRecord(header.profile) || !['projectMs', 'encodeMs', 'hashMs'].every(field =>
          Object.hasOwn(header.profile as Record<string, unknown>, field)
          && typeof (header.profile as Record<string, unknown>)[field] === 'number'
          && Number.isFinite((header.profile as Record<string, unknown>)[field]))
        || capture.native.tick !== key.tick || capture.native.scope !== key.scope) {
        throw failure('final native header differs from the export.');
      }
      // All final headers come from the real native receipt. Only the graph
      // already received from that same VM/Step is attached here.
      const snapshot = { ...header, native: capture.native };
      this.lastEpoch = key.epoch;
      this.pending = null;
      return snapshot;
    } catch (error) {
      this.poison();
      throw error;
    }
  }

  cancel(): void {
    if (activeInvocation?.owner === this || (this.pending && this.pending.mode !== 'sync')) this.poison();
    else this.pending = null;
  }

  /** Cleanup is the sole allowed callback after a failed staged transaction.
   * It receives only the previously validated identity, never a new token or
   * a graph. The native gate independently pins its callback and owner. The
   * caller must dispose the VM even if cleanup rejects or has no known epoch. */
  abortStagedStep(rawCleanup: (key: StagedStepKey) => unknown): void {
    this.abortPhase('staged', rawCleanup);
  }

  abortCompactStep(rawCleanup: (key: StagedStepKey) => unknown): void {
    this.abortPhase('compact', rawCleanup);
  }

  private abortPhase(mode: 'staged' | 'compact', rawCleanup: (key: StagedStepKey) => unknown): void {
    this.poison();
    const failed = this.failedPhase;
    if (failed && failed.mode !== mode) throw failure('cleanup belongs to a different step protocol.');
    this.failedPhase = null;
    if (!failed || activeInvocation) return;
    const invocation: Invocation = { owner: this, name: mode === 'compact' ? 'bhFrameAbort' : 'bhStepAbort' };
    activeInvocation = invocation;
    try { rawCleanup(failed.key); }
    finally {
      if (activeInvocation === invocation) activeInvocation = null;
      this.pending = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.failedPhase = null;
  }
}
