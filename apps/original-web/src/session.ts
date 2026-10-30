import { readStep, type LockstepBridge, type StepResult } from './bridge';
import { CheckpointReceiver, packCheckpoint } from './checkpoint';
import { yieldAfterOriginalPaint } from './staged-step-scheduler';
import {
  ClientError, DEFAULT_REPLAY_BATCH_FRAMES, isHash, isMask, parseServerMessage, publicError,
  type ConnectionIntent, type JoinedMessage, type Slot, type PrepareMessage, type JoinFailedMessage, type JoinSyncMessage, type NetworkStatusMessage, type FrameMessage, type ServerMessage,
} from './protocol';

export type Phase = 'joining' | 'waiting' | 'preparing' | 'ready' | 'replaying' | 'running' | 'completing' | 'completed' | 'failed' | 'closed';
// The server cancels at its hard replay deadline. Give its resume/cancel
// message a separate, fixed delivery allowance without extending guest work.
const HOST_RESUME_GRACE_MS = 5000;
// Guest work keeps its original hard deadline. Only after the actual fixed
// target was checked on time may its final control messages use this allowance.
const GUEST_FINAL_CONTROL_GRACE_MS = 5000;
const REPLAY_WORK_LIMIT_MS = 180_000;
const NATIVE_PROGRESS_LIMIT_MS = 10_000;
const NETWORK_IDLE_LIMIT_MS = 45_000;
// Guest eviction happens at the server deadline; its host resume still needs
// bounded delivery time. This grants no additional native work or new frames.
const NETWORK_CONTROL_GRACE_MS = 5000;
const NETWORK_WAIT_LIMIT_MS = NETWORK_IDLE_LIMIT_MS - NETWORK_CONTROL_GRACE_MS;
// A native frame is indivisible. These bounds request a browser task between
// completed frames; they do not promise a hard maximum duration for one step.
const REPLAY_SLICE_MS = 8;
const REPLAY_SLICE_FRAMES = 2;
const REPLAY_PENDING_FRAMES = 128;
const LIVE_PENDING_FRAMES = 32;
const REPLAY_PENDING_MESSAGES = 256;
interface ReplayInboxEntry {
  message: ServerMessage;
  receivedAt: number;
  framesLeft: number;
  liveFrames: number;
  resolve(): void;
}
interface FrameContext { starting: boolean; replaying: boolean }
export interface Transport {
  send(message: Record<string, unknown>): void;
  close(): void;
}
export interface SessionEvents {
  joined(message: JoinedMessage): void;
  peer?(connected: boolean): void;
  preparing(message: PrepareMessage): void;
  prepared(slot: Slot): void;
  running?(slot: Slot): void;
  replaying?(tick: number): void;
  joinSync?(message: JoinSyncMessage, slot: Slot): void;
  networkStatus?(message: NetworkStatusMessage | null): void;
  stepped(tick: number): void;
  finishing?(): void;
  completed?(tick: number, complete: string): void;
  failed(message: string): void;
  joinFailed?(message: JoinFailedMessage): void;
}

/** Server-coordinated lockstep. No client world simulation or digest synthesis. */
export class OriginalSession {
  phase: Phase = 'joining';
  private joinedMessage: JoinedMessage | null = null;
  private tick = 0;
  private seq = 0;
  private mask = 0;
  private lastInputSentAt = 0;
  private startSent = false;
  private initialPlayers: 1 | 2 = 2;
  private livePlayers: 1 | 2 = 2;
  private membershipVersion = 0;
  private replay = false;
  private replayBatch = 0;
  private replayDeadline: number | null = null;
  private awaitingGuestSpawn = false;
  private synchronization: { tick: number; verified: number; deadline: number; workFinishedAt: number | null } | null = null;
  private networkWaiting: { tick: number; deadline: number } | null = null;
  private nativeWorkDeadline: number | null = null;
  private terminal: string | undefined;
  private progress: number;
  private readonly abort = new AbortController();
  private readonly replayInbox: ReplayInboxEntry[] = [];
  private replayInboxActive: ReplayInboxEntry | null = null;
  private replayDraining = false;
  private replayPendingFrames = 0;
  private livePendingFrames = 0;
  private liveStepNeedsTask = false;
  private replayQueuedBarrierDeadline: number | null = null;
  private replaySliceStartedAt = 0;
  private replaySliceFrames = 0;
  private replayTimer: ReturnType<typeof setTimeout> | null = null;
  private replayResume: (() => void) | null = null;
  private checkpointSupported = false;
  private checkpointRequest: { id: string; minimumTick: number; capturing: boolean; chunks: string[] | null; nextChunk: number } | null = null;
  private checkpointWait: { id: string; deadline: number; receiver: CheckpointReceiver | null } | null = null;

  constructor(
    private readonly intent: ConnectionIntent,
    private readonly swfHash: string,
    private readonly bridge: LockstepBridge,
    private readonly transport: Transport,
    private readonly events: SessionEvents,
    private readonly now: () => number = Date.now,
    // Slice work uses an independent monotonic clock. Waiting or changes to
    // the wall clock never renew the existing absolute/progress deadlines.
    private readonly workNow: () => number = () => performance.now(),
    private readonly liveYield: (signal: AbortSignal) => Promise<void> = yieldAfterOriginalPaint,
  ) {
    if (!isHash(swfHash)) throw new ClientError('Invalid online SWF SHA256.');
    this.progress = now();
  }

  opened(): void {
    if (this.phase !== 'joining') return;
    try {
      if (this.intent.type === 'create') {
        this.transport.send({ type: 'create', swfHash: this.swfHash, ...this.intent.setup,
          ...(this.intent.name !== undefined ? { name: this.intent.name } : {}),
          ...(this.intent.listed !== undefined ? { listed: this.intent.listed } : {}),
          ...(this.intent.dropIn !== undefined ? { dropIn: this.intent.dropIn } : {}) });
      } else if (this.intent.type === 'join') {
        this.transport.send({ type: 'join', swfHash: this.swfHash, ...this.intent.invitation,
          ...(this.intent.character !== undefined ? { character: this.intent.character } : {}) });
      } else {
        this.transport.send({ type: 'join_open', swfHash: this.swfHash, room: this.intent.room,
          ...(this.intent.character !== undefined ? { character: this.intent.character } : {}) });
      }
    } catch { this.fail('Could not send the room request.'); }
  }

  async receive(raw: unknown): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'failed' || this.phase === 'completed') return;
    try {
      const message = parseServerMessage(raw);
      const receivedAt = this.now();
      // Fatal messages and parse failures cancel work immediately, even while
      // the single native owner is yielding. Other controls keep wire order.
      if (message.type === 'error' || message.type === 'paused') {
        this.fail(message.type === 'paused'
          ? 'The server stopped synchronization. The game has stopped; create or join a room again.'
          : 'The server rejected the request or detected a synchronization error. The game has stopped.');
        return;
      }
      if (this.phase === 'replaying' || this.replayDraining || this.supportsLiveStaging()) {
        return this.enqueueReplay(message, receivedAt);
      }
      return this.receiveMessage(message, receivedAt);
    } catch (error) { this.fail(publicError(error)); }
  }

  private async receiveMessage(message: ServerMessage, receivedAt: number): Promise<void> {
    try {
      if (message.type === 'checkpoint_request') {
        if (this.joinedMessage?.slot !== 1 || !['ready', 'running'].includes(this.phase) || this.livePlayers !== 1
          || !this.checkpointSupported || this.checkpointRequest) throw new ClientError('Unexpected host world snapshot request.');
        this.checkpointRequest = { id: message.id, minimumTick: message.minimumTick, capturing: false, chunks: null, nextChunk: 0 };
        this.captureRequestedCheckpoint();
        return;
      }
      if (message.type === 'checkpoint_cancel') {
        if (this.joinedMessage?.slot !== 1 || this.checkpointRequest?.id !== message.id) {
          throw new ClientError('Unexpected world snapshot cancellation.');
        }
        this.checkpointRequest = null;
        return;
      }
      if (message.type === 'checkpoint_credit') {
        const request = this.checkpointRequest;
        if (this.joinedMessage?.slot !== 1 || !request || request.id !== message.id || !request.chunks
          || message.index !== request.nextChunk || message.index > request.chunks.length) {
          throw new ClientError('The host snapshot transfer is out of sequence.');
        }
        if (message.index === request.chunks.length) {
          request.chunks = null;
          this.transport.send({ type: 'checkpoint_end', id: request.id });
        } else {
          request.nextChunk++;
          this.transport.send({ type: 'checkpoint_chunk', id: request.id, index: message.index, data: request.chunks[message.index] });
        }
        return;
      }
      if (message.type === 'checkpoint_wait') {
        if (this.phase !== 'replaying' || this.joinedMessage?.slot !== 2 || this.tick !== 0
          || !this.checkpointSupported || this.checkpointWait) throw new ClientError('Unexpected world transfer start.');
        this.checkpointWait = { id: message.id, deadline: receivedAt + message.timeoutMs, receiver: null };
        return;
      }
      if (message.type === 'checkpoint_fallback') {
        if (this.phase !== 'replaying' || this.tick !== 0 || this.checkpointWait?.id !== message.id
          || this.checkpointWait.receiver) throw new ClientError('Cannot replay history after world import has started.');
        this.checkpointWait = null;
        this.progress = this.now();
        return;
      }
      if (message.type === 'checkpoint_begin' || message.type === 'checkpoint_chunk' || message.type === 'checkpoint_end') {
        const waiting = this.checkpointWait;
        if (this.phase !== 'replaying' || this.joinedMessage?.slot !== 2 || this.tick !== 0
          || !waiting || waiting.id !== message.id || this.now() > waiting.deadline) {
          throw new ClientError('A world snapshot arrived outside the agreed transfer.');
        }
        if (message.type === 'checkpoint_begin') {
          if (waiting.receiver) throw new ClientError('Duplicate world snapshot start.');
          waiting.receiver = new CheckpointReceiver(message);
        } else if (message.type === 'checkpoint_chunk') {
          if (!waiting.receiver) throw new ClientError('A snapshot chunk arrived before its header.');
          waiting.receiver.add(message.index, message.data);
        } else {
          const receiver = waiting.receiver;
          if (!receiver || !this.bridge.importCheckpoint) throw new ClientError('Native world import is unavailable.');
          const payload = await receiver.unpack(this.abort.signal);
          if (this.abort.signal.aborted) return;
          this.requireCheckpointWorkTime(waiting.deadline);
          // Unpacking an already buffered stream can finish in microtasks.
          // Give the browser a task boundary before entering the indivisible
          // native import/readback transaction, retaining this FIFO owner.
          await this.yieldReplayTask();
          if (this.abort.signal.aborted) return;
          if (this.phase !== 'replaying' || this.tick !== 0 || this.checkpointWait !== waiting
            || waiting.receiver !== receiver) {
            throw new ClientError('The world transfer changed before native import.');
          }
          this.requireCheckpointWorkTime(waiting.deadline);
          const result = readStep(this.bridge.importCheckpoint(payload, receiver.header.tick, receiver.header.digest));
          if (this.abort.signal.aborted) return;
          this.requireCheckpointWorkTime(waiting.deadline);
          if (result.tick !== receiver.header.tick
            || result.digest !== receiver.header.digest || result.complete) throw new ClientError('The restored native world was not confirmed.');
          this.tick = result.tick;
          this.progress = this.now();
          this.checkpointWait = null;
          // This is an explicit restored-state attestation. No ACK is fabricated
          // for pre-checkpoint frames which this guest has never executed.
          this.transport.send({ type: 'checkpoint_applied', id: message.id, tick: result.tick,
            digest: result.digest, sha256: receiver.header.sha256 });
          if (this.abort.signal.aborted) return;
          this.events.replaying?.(this.tick);
          if (this.abort.signal.aborted) return;
          // Attestation follows complete native verification. Tail frames or
          // controls may already be queued, but cannot share this import task.
          await this.yieldReplayTask();
          if (this.abort.signal.aborted) return;
          this.replaySliceStartedAt = this.workNow();
          this.replaySliceFrames = 0;
        }
        return;
      }
      if (message.type === 'rooms') {
        // A subscribed discovery socket may have an update already in flight
        // while its join request is being processed. It is not a gameplay frame.
        if (this.phase === 'joining' && this.intent.type === 'join_open') return;
        throw new ClientError('A room list arrived during an active game.');
      }
      if (message.type === 'join_failed') {
        if (this.phase !== 'joining' || this.intent.type !== 'join_open' || message.room !== this.intent.room) {
          throw new ClientError('Unexpected room join rejection.');
        }
        // A room can disappear between the displayed list and a real click.
        // Keep this same socket subscribed so the player can select another.
        this.phase = 'closed';
        this.abort.abort();
        this.events.joinFailed?.(message);
        return;
      }
      if (message.type === 'joined') {
        const expectedSlot = this.intent.type === 'create' ? 1 : 2;
        if (this.phase !== 'joining' || message.slot !== expectedSlot ||
            (this.intent.type === 'join' && message.room !== this.intent.invitation.room)) {
          throw new ClientError('The server assigned an invalid room or slot, or repeated joined.');
        }
        if (this.intent.type === 'join_open' && message.room !== this.intent.room) {
          throw new ClientError('The server joined a different public room.');
        }
        this.joinedMessage = message;
        this.phase = 'waiting';
        this.progress = this.now();
        this.events.joined(message);
        if (this.intent.type === 'create' && this.intent.dropIn) this.start();
        return;
      }
      if (message.type === 'peer') {
        if ((!['waiting', 'ready', 'running'].includes(this.phase) && !(this.phase === 'completing' && this.networkWaiting)) ||
            this.joinedMessage?.slot !== 1) {
          throw new ClientError('Unexpected player notification.');
        }
        this.events.peer?.(message.connected);
        return;
      }
      if (message.type === 'network_status') {
        // At startup a prepared peer can still be waiting for its first frame.
        // The reported tick is server verification, never local advancement.
        if (!this.joinedMessage || !['ready', 'running', 'completing'].includes(this.phase) ||
            this.synchronization || message.tick > this.tick || this.tick - message.tick > LIVE_PENDING_FRAMES) {
          throw new ClientError('Unexpected network recovery point.');
        }
        this.requireNetworkTime();
        const waiting = this.networkWaiting;
        if (message.state === 'waiting') {
          if (waiting && message.tick < waiting.tick) throw new ClientError('Network verification moved backwards.');
          if (!waiting) this.release();
          if (this.abort.signal.aborted) return;
          this.mask = 0;
          this.networkWaiting = { tick: message.tick,
            // Repeated notices or partial ACKs cannot renew the first deadline.
            deadline: Math.min(waiting?.deadline ?? Infinity,
              receivedAt + Math.min(message.timeoutMs, NETWORK_WAIT_LIMIT_MS)) };
          this.requireNetworkTime();
        } else {
          if (!waiting || message.tick < waiting.tick) throw new ClientError('Unexpected network recovery confirmation.');
          this.networkWaiting = null;
          this.mask = 0;
          // A control message does not count as native progress or renew idle.
        }
        this.events.networkStatus?.(message);
        return;
      }
      if (message.type === 'join_sync') {
        if (this.networkWaiting) throw new ClientError('A join crossed the network recovery boundary.');
        const slot = this.joinedMessage?.slot;
        // A terminal native frame may have left one later issued frame in
        // flight. We deliberately ignore that frame, so a pause announced
        // against the server's issued tip can exceed our terminal native tick.
        // Keep waiting for its verified completion; never resume or extend it.
        if (slot === 1 && this.phase === 'completing' && this.terminal &&
            (this.initialPlayers === 1 || this.membershipVersion === 2) && this.livePlayers === 1 && message.tick >= this.tick) return;
        const hostCanWait = slot === 1 && ['ready', 'running', 'completing'].includes(this.phase);
        if (!slot || (this.initialPlayers !== 1 && this.membershipVersion !== 2) ||
            (this.livePlayers !== 1 && !(slot === 2 && this.phase === 'replaying' && this.membershipVersion > 0)) ||
            !(hostCanWait || (slot === 2 && this.phase === 'replaying'))) {
          throw new ClientError('Unexpected second-player synchronization.');
        }
        if (message.state === 'paused') {
          if (this.synchronization || message.tick < this.tick || message.verified > this.tick ||
              (slot === 1 && message.tick !== this.tick)) {
            throw new ClientError('The server changed the synchronization point or repeated its start.');
          }
          this.synchronization = { tick: message.tick, verified: message.verified,
            deadline: receivedAt + message.timeoutMs,
            workFinishedAt: slot === 2 && message.tick === this.tick ? this.progress : null };
          // No held movement or queued action may survive a deliberate pause.
          // The server independently clears its input state at the same boundary.
          this.mask = 0;
        } else {
          const sync = this.synchronization;
          const deliveryGrace = slot === 1 ? HOST_RESUME_GRACE_MS
            : message.state === 'progress' && message.verified === sync?.tick ? this.guestFinalControlGrace() : 0;
          if (!sync || message.tick !== sync.tick ||
              this.now() > sync.deadline + deliveryGrace) {
            throw new ClientError('Synchronization continued outside the agreed point or time limit.');
          }
          if (message.state === 'progress') {
            if (message.verified < sync.verified || message.verified > this.tick) {
              throw new ClientError('The server reported unconfirmed join progress.');
            }
            sync.verified = message.verified;
            // Progress does not move the fixed deadline or count as native work.
          } else {
            if (slot !== 1 || message.tick !== this.tick) {
              throw new ClientError('Only the paused host can resume this world.');
            }
            this.synchronization = null;
            this.mask = 0;
            this.progress = this.now();
          }
        }
        this.events.joinSync?.(message, slot);
        return;
      }
      if (message.type === 'prepare') {
        if (this.phase !== 'waiting' || !this.joinedMessage || message.swfHash !== this.swfHash) {
          throw new ClientError('Invalid prepare order or mismatched SWF SHA256.');
        }
        this.phase = 'preparing';
        this.initialPlayers = message.initialPlayers ?? 2;
        this.livePlayers = this.initialPlayers;
        this.membershipVersion = message.membershipVersion ?? 0;
        this.replay = message.replay === true;
        if (this.replay && this.joinedMessage.slot !== 2) throw new ClientError('The host cannot replay guest history.');
        this.progress = this.now();
        this.events.preparing(message);
        await this.bridge.prepare(message, this.abort.signal, this.joinedMessage.slot);
        if (this.abort.signal.aborted || this.phase !== 'preparing') return;
        this.phase = this.replay ? 'replaying' : 'ready';
        this.progress = this.now();
        this.replayBatch = this.replay ? Math.min(message.replayBatchExtendedMax ?? message.replayBatchMax ?? 0, DEFAULT_REPLAY_BATCH_FRAMES) : 0;
        this.replayDeadline = this.replay ? this.progress + REPLAY_WORK_LIMIT_MS : null;
        this.checkpointSupported = this.bridge.supportsCheckpoint?.() === true
          && (!this.replay || message.checkpointVersion === 1);
        this.transport.send({ type: 'ready', ...(this.replayBatch ? { replayBatch: this.replayBatch } : {}),
          ...(this.checkpointSupported ? { checkpointVersion: 1 } : {}) });
        this.events.prepared(this.joinedMessage.slot);
        if (this.replay) this.events.replaying?.(0);
        return;
      }
      if (message.type === 'caught_up') {
        if (this.phase !== 'replaying' || message.tick !== this.tick || this.joinedMessage?.slot !== 2 || this.livePlayers !== 1) {
          throw new ClientError('The server confirmed unverified match history.');
        }
        const now = this.now();
        const grace = this.guestFinalControlGrace();
        if (this.replayDeadline === null || now > this.replayDeadline + grace) {
          throw new ClientError('The server confirmed a join after the absolute replay deadline.');
        }
        if (this.synchronization && (message.tick !== this.synchronization.tick ||
            now > this.synchronization.deadline + grace)) {
          throw new ClientError('The server confirmed a join outside the agreed synchronization.');
        }
        if (this.membershipVersion > 0) {
          if (!this.bridge.finishReplay) throw new ClientError('The native bridge does not support completing the membership replay.');
          this.bridge.finishReplay(message.tick);
        }
        this.synchronization = null;
        this.phase = 'running';
        this.replayDeadline = null;
        this.replayBatch = 0;
        this.awaitingGuestSpawn = true;
        this.progress = this.now();
        return;
      }
      if (message.type === 'replay_frames') {
        if (this.phase !== 'replaying' || this.joinedMessage?.slot !== 2 || !this.replay ||
            (this.initialPlayers !== 1 && this.membershipVersion !== 2) || this.replayBatch < 1 ||
            message.frames.length > this.replayBatch || message.frames[0].tick !== this.tick + 1 ||
            (this.synchronization && message.frames[message.frames.length - 1].tick > this.synchronization.tick)) {
          throw new ClientError('A replay batch arrived without negotiation or out of sequence. ACK was not sent.');
        }
        // Validate the entire packet before its first native frame. The
        // shared owner budget also covers already queued packet boundaries.
        let roster = this.livePlayers;
        for (const frame of message.frames) {
          if ((frame.leave && (this.membershipVersion === 0 || roster !== 2 || frame.p2 !== 0)) ||
              (frame.join && roster !== 1) || (roster === 1 && !frame.join && frame.p2 !== 0)) {
            throw new ClientError('The replay batch contains an unsupported membership change. ACK was not sent.');
          }
          if (frame.join) roster = 2;
          if (frame.leave) roster = 1;
        }
        await this.receiveReplayFrames(message.frames);
        return;
      }
      if (message.type === 'frame') {
        if (this.phase === 'replaying') await this.receiveReplayFrames([message]);
        else if (this.supportsLiveStaging()) await this.receiveLiveFrame(message);
        else this.receiveFrame(message);
        return;
      }
      if (message.type === 'completed') {
        if (this.phase !== 'completing' || message.tick !== this.tick || message.complete !== this.terminal) {
          throw new ClientError('Server completion differs from the original game result.');
        }
        this.phase = 'completed';
        this.synchronization = null;
        this.clearNetworkWaiting();
        this.events.completed?.(message.tick, message.complete);
      }
    } catch (error) { this.fail(publicError(error)); }
  }

  private enqueueReplay(message: ServerMessage, receivedAt: number): Promise<void> {
    const frames = message.type === 'replay_frames' ? message.frames.length : message.type === 'frame' ? 1 : 0;
    // Resource classification follows the queued wire boundary without
    // applying caught_up or changing the session phase before its turn.
    const liveFrames = this.phase !== 'replaying' || this.replayInbox.some(entry => entry.message.type === 'caught_up')
      ? frames : 0;
    const messages = this.replayInbox.length + (this.replayInboxActive ? 1 : 0);
    if (this.livePendingFrames + liveFrames > LIVE_PENDING_FRAMES) {
      this.fail('The live native frame queue limit was exceeded. The game has stopped.');
      return Promise.resolve();
    }
    if (this.replayPendingFrames + frames > REPLAY_PENDING_FRAMES || messages >= REPLAY_PENDING_MESSAGES) {
      this.fail('The replay queue limit was exceeded. Native steps have stopped.');
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.replayInbox.push({ message, receivedAt, framesLeft: frames, liveFrames, resolve });
      this.replayPendingFrames += frames;
      this.livePendingFrames += liveFrames;
      if ((message.type === 'join_sync' && message.state === 'paused') ||
          (message.type === 'network_status' && message.state === 'waiting')) {
        const deadline = receivedAt + (message.type === 'network_status'
          ? Math.min(message.timeoutMs, NETWORK_WAIT_LIMIT_MS) : message.timeoutMs);
        // A queued control cannot change phase/target before its wire turn,
        // but its already known work deadline also bounds the active packet.
        this.replayQueuedBarrierDeadline = this.replayQueuedBarrierDeadline === null
          ? deadline : Math.min(this.replayQueuedBarrierDeadline, deadline);
      }
      if (!this.replayDraining) {
        this.replayDraining = true;
        this.replaySliceStartedAt = this.workNow();
        this.replaySliceFrames = 0;
        // Start synchronously. Only the explicit task wait below yields;
        // reentrant receive calls append to this owner's bounded FIFO.
        void this.drainReplay();
      }
    });
  }

  private async drainReplay(): Promise<void> {
    try {
      while (!this.abort.signal.aborted && this.phase !== 'completed' && this.replayInbox.length > 0) {
        const entry = this.replayInbox.shift()!;
        this.replayInboxActive = entry;
        try { await this.receiveMessage(entry.message, entry.receivedAt); }
        finally {
          if (this.replayInboxActive === entry) {
            this.replayPendingFrames -= entry.framesLeft;
            this.livePendingFrames -= entry.liveFrames;
            this.replayInboxActive = null;
          }
          this.refreshQueuedBarrierDeadline();
          entry.resolve();
        }
      }
    } catch (error) { this.fail(publicError(error)); }
    finally {
      this.clearReplayInbox();
      this.replayDraining = false;
      this.replaySliceFrames = 0;
    }
  }

  private async receiveReplayFrames(frames: FrameMessage[]): Promise<void> {
    for (const frame of frames) {
      if (this.abort.signal.aborted) return;
      if (this.replaySliceFrames >= REPLAY_SLICE_FRAMES ||
          (this.replaySliceFrames > 0 && this.workNow() - this.replaySliceStartedAt >= REPLAY_SLICE_MS)) {
        await this.yieldReplayTask();
        if (this.abort.signal.aborted) return;
        this.replaySliceStartedAt = this.workNow();
        this.replaySliceFrames = 0;
      }
      const entry = this.replayInboxActive;
      if (!entry || entry.framesLeft < 1) throw new ClientError('The native replay queue owner was lost.');
      entry.framesLeft--;
      this.replayPendingFrames--;
      this.replaySliceFrames++;
      // Step, info/readback, ACK, tick/progress and events finish together.
      // receiveFrame still checks the original deadlines on both sides of
      // native work; enqueuing or yielding never renews any work budget.
      if (!this.receiveFrame(frame)) return;
    }
  }

  private yieldReplayTask(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const resume = () => {
        if (this.replayResume !== resume) return;
        this.replayTimer = null;
        this.replayResume = null;
        resolve();
      };
      const rejectCurrent = (error: unknown) => {
        if (this.replayResume !== resume) return;
        this.replayTimer = null;
        this.replayResume = null;
        reject(error);
      };
      this.replayResume = resume;
      try {
        const scheduler = (globalThis as typeof globalThis & {
          scheduler?: { yield?: () => Promise<void> };
        }).scheduler;
        const yieldTask = scheduler?.yield;
        if (yieldTask === undefined) this.replayTimer = setTimeout(resume, 0);
        else {
          if (typeof yieldTask !== 'function') throw new ClientError('Invalid browser scheduler. Replay stopped.');
          // Keep the native receiver. Cancellation wakes our owner immediately;
          // the uncancellable scheduler promise later sees a stale identity.
          // Reject non-Promise thenables instead of accepting an immediate
          // continuation. The intrinsic also accepts genuine other-realm promises.
          Promise.prototype.then.call(yieldTask.call(scheduler), resume, rejectCurrent);
        }
      } catch (error) { rejectCurrent(error); }
    });
  }

  private clearReplayInbox(): void {
    if (this.replayTimer !== null) clearTimeout(this.replayTimer);
    this.replayResume?.();
    this.replayInboxActive?.resolve();
    this.replayInboxActive = null;
    for (const entry of this.replayInbox) entry.resolve();
    this.replayInbox.length = 0;
    this.replayPendingFrames = 0;
    this.livePendingFrames = 0;
    this.replayQueuedBarrierDeadline = null;
    if (this.abort.signal.aborted) this.liveStepNeedsTask = false;
  }

  private refreshQueuedBarrierDeadline(): void {
    this.replayQueuedBarrierDeadline = null;
    for (const entry of this.replayInbox) {
      const message = entry.message;
      if (!((message.type === 'join_sync' && message.state === 'paused') ||
          (message.type === 'network_status' && message.state === 'waiting'))) continue;
      const deadline = entry.receivedAt + (message.type === 'network_status'
        ? Math.min(message.timeoutMs, NETWORK_WAIT_LIMIT_MS) : message.timeoutMs);
      this.replayQueuedBarrierDeadline = this.replayQueuedBarrierDeadline === null
        ? deadline : Math.min(this.replayQueuedBarrierDeadline, deadline);
    }
  }

  private supportsLiveStaging(): boolean {
    if (this.phase !== 'ready' && this.phase !== 'running') return false;
    // This bridge capability is cached from actual native Info. It can become
    // available after the replay guest's real join step, and is false while
    // a phased transaction is active; the existing FIFO still owns that wait.
    const full = this.bridge.supportsStagedStep?.() === true;
    const compact = this.bridge.supportsCompactStep?.() === true;
    if (full && typeof this.bridge.stepStaged !== 'function') {
      throw new ClientError('The advertised staged native callback is missing.');
    }
    if (compact && typeof this.bridge.stepCompact !== 'function') {
      throw new ClientError('The advertised compact native callback is missing.');
    }
    return full || compact;
  }

  private async receiveLiveFrame(message: FrameMessage): Promise<boolean> {
    this.requireNetworkTime();
    // Start only when this frame owns the native-work queue. Quiet network
    // time before its arrival is not time spent executing a native command.
    const deadline = this.now() + NATIVE_PROGRESS_LIMIT_MS;
    this.nativeWorkDeadline = deadline;
    try { return await this.runLiveFrame(message, deadline); }
    finally { this.nativeWorkDeadline = null; }
  }

  private async runLiveFrame(message: FrameMessage, deadline: number): Promise<boolean> {
    const entry = this.replayInboxActive;
    if (!entry || entry.message !== message || entry.framesLeft !== 1) {
      throw new ClientError('The live native frame queue owner was lost.');
    }
    // A normally spaced WebSocket event can arrive just before vsync. Running
    // its 10–20 ms native work immediately would delay that paint even without
    // any backlog. The real foreground adapter explicitly requests one paint
    // boundary before every live step; legacy adapters/replay retain their
    // existing schedule. This never advances or acknowledges a native tick.
    if (this.bridge.requiresPaintBeforeStep?.() === true || this.liveStepNeedsTask || this.replaySliceFrames >= REPLAY_SLICE_FRAMES
      || (this.replaySliceFrames > 0 && this.workNow() - this.replaySliceStartedAt >= REPLAY_SLICE_MS)) {
      await this.liveYield(this.abort.signal);
      if (this.abort.signal.aborted) return false;
      if (this.replayInboxActive !== entry) throw new ClientError('The live native frame owner changed.');
      this.liveStepNeedsTask = false;
      this.replaySliceStartedAt = this.workNow();
      this.replaySliceFrames = 0;
    }
    const context = this.beginFrame(message);
    if (!context) return false;
    this.requireLiveWorkTime(deadline);
    this.replaySliceFrames++;
    // Capabilities are independent and are selected before entering a native
    // transaction. A compact-capable bridge does not change full25 cadence;
    // replay never reaches this path. Once Begin runs, a rejection propagates
    // without a synchronous retry of the already executed gameplay command.
    const fullTick = message.tick > 0 && message.tick % 25 === 0;
    // The current native fence accepts five Begin arguments; a leave has six.
    // Select the existing synchronous native path before opening a transaction.
    const staged = !message.leave && fullTick && this.bridge.supportsStagedStep?.() === true;
    const compact = !message.leave && !fullTick && this.bridge.supportsCompactStep?.() === true;
    const raw = staged
      ? await this.bridge.stepStaged!(message.tick, message.p1, message.p2, message.join, this.abort.signal, message.leave)
      : compact ? await this.bridge.stepCompact!(message.tick, message.p1, message.p2, message.join, this.abort.signal, message.leave)
        : message.leave ? this.bridge.step(message.tick, message.p1, message.p2, message.join, message.leave)
        : message.join ? this.bridge.step(message.tick, message.p1, message.p2, message.join)
          : this.bridge.step(message.tick, message.p1, message.p2);
    if (this.abort.signal.aborted) return false;
    if (this.replayInboxActive !== entry) throw new ClientError('The completed native frame owner changed.');
    this.requireLiveWorkTime(deadline);
    const result = readStep(raw);
    // Native readback validation and its getters must also remain inside the
    // original work deadline. Only the final result can earn an ACK/progress.
    this.requireLiveWorkTime(deadline);
    const continued = this.finishFrame(message, result, context, deadline);
    if ((staged || compact) && continued) this.liveStepNeedsTask = true;
    return continued;
  }

  private requireLiveWorkTime(deadline: number): void {
    this.requireNetworkTime();
    const now = this.now();
    if (now > deadline
      || (this.replayQueuedBarrierDeadline !== null && now > this.replayQueuedBarrierDeadline)
      || (this.synchronization !== null && now > this.synchronization.deadline)) {
      throw new ClientError('The live native step exceeded the agreed time limit. ACK was not sent.');
    }
  }

  private beginFrame(message: FrameMessage): FrameContext | null {
    if (this.abort.signal.aborted) return null;
    // Bounded transport pipelining can leave frames in flight after the
    // original VM reaches its terminal tick. Never execute those frames.
    if (this.phase === 'completing' && message.tick > this.tick) return null;
    this.requireNetworkTime();
    if (this.networkWaiting) throw new ClientError('A game frame arrived before network recovery was confirmed. ACK was not sent.');
    const starting = this.phase === 'ready' && message.tick === 1;
    if (starting) this.phase = 'running';
    const replaying = this.phase === 'replaying';
    if (this.checkpointWait) throw new ClientError('The server sent a frame before the world snapshot was confirmed.');
    if ((!replaying && this.phase !== 'running') || message.tick !== this.tick + 1) {
      throw new ClientError('A server tick was skipped, repeated or received too early. ACK was not sent.');
    }
    if (replaying) this.requireReplayWorkTime(this.now());
    if (this.synchronization && (!replaying || message.tick > this.synchronization.tick ||
        this.now() > this.synchronization.deadline)) {
      throw new ClientError('A game frame crossed the paused synchronization boundary. ACK was not sent.');
    }
    if ((message.leave && (this.membershipVersion === 0 || this.livePlayers !== 2 || message.p2 !== 0 || message.join !== undefined)) ||
        (message.join && this.livePlayers !== 1) ||
        (this.awaitingGuestSpawn && !message.join) ||
        (this.livePlayers === 1 && !message.join && message.p2 !== 0)) {
      throw new ClientError('The second-player spawn sequence is invalid. ACK was not sent.');
    }
    // Native work and queued frame callbacks can delay the watchdog timer.
    // Renew before entering the synchronous VM while the local key is held.
    if (!replaying && !this.refreshHeldInput()) return null;
    return { starting, replaying };
  }

  private receiveFrame(message: FrameMessage): boolean {
    const context = this.beginFrame(message);
    if (!context) return false;
    const deadline = context.replaying ? undefined : this.now() + NATIVE_PROGRESS_LIMIT_MS;
    if (deadline !== undefined) this.nativeWorkDeadline = deadline;
    try {
      const result = readStep(message.leave
        ? this.bridge.step(message.tick, message.p1, message.p2, message.join, message.leave)
        : message.join
        ? this.bridge.step(message.tick, message.p1, message.p2, message.join)
        : this.bridge.step(message.tick, message.p1, message.p2));
      if (deadline !== undefined) this.requireLiveWorkTime(deadline);
      return this.finishFrame(message, result, context, deadline);
    } finally { this.nativeWorkDeadline = null; }
  }

  private finishFrame(message: FrameMessage, result: StepResult, { starting, replaying }: FrameContext, liveDeadline?: number): boolean {
    if (this.abort.signal.aborted) return false;
    if (result.tick !== message.tick) {
      throw new ClientError('The native tick differs from the server tick. ACK was not sent.');
    }
    const nativeFinishedAt = this.now();
    if (replaying) this.requireReplayWorkTime(nativeFinishedAt);
    // The digest is returned by the native SWF. Never derive it from inputs.
    const complete = result.complete || undefined;
    // A slow valid step can cross the renewal deadline. Send the held input
    // before its ACK, which may let the server issue another frame.
    if (!complete && !replaying && !this.refreshHeldInput()) return false;
    if (liveDeadline !== undefined) this.requireLiveWorkTime(liveDeadline);
    this.transport.send({ type: 'ack', tick: result.tick, digest: result.digest,
      ...(complete ? { complete } : {}) });
    if (this.abort.signal.aborted) return false;
    this.tick = message.tick;
    this.progress = this.now();
    if (replaying && this.synchronization && message.tick === this.synchronization.tick) {
      this.synchronization.workFinishedAt = nativeFinishedAt;
    }
    if (message.join) this.livePlayers = 2;
    if (message.leave) this.livePlayers = 1;
    if (starting || this.awaitingGuestSpawn) this.events.running?.(this.joinedMessage!.slot);
    if (this.abort.signal.aborted) return false;
    this.awaitingGuestSpawn = false;
    if (replaying) this.events.replaying?.(this.tick);
    if (this.abort.signal.aborted) return false;
    this.events.stepped(this.tick);
    if (this.abort.signal.aborted) return false;
    if (complete) {
      this.terminal = complete;
      this.mask = 0;
      this.phase = 'completing';
      this.events.finishing?.();
    }
    if (!complete && !replaying) this.captureRequestedCheckpoint();
    return !this.abort.signal.aborted && this.phase !== 'completing';
  }

  private captureRequestedCheckpoint(): void {
    const request = this.checkpointRequest;
    if (!request || request.capturing || this.phase !== 'running' || this.tick < Math.max(25, request.minimumTick)
      || this.tick % 25 !== 0 || this.abort.signal.aborted) return;
    request.capturing = true;
    // Native capture is synchronous at a completed full-checkpoint boundary.
    // Compression/upload run asynchronously while the original host keeps playing.
    let snapshot;
    try {
      if (!this.bridge.exportCheckpoint) throw new ClientError('Native world export is unavailable.');
      snapshot = this.bridge.exportCheckpoint();
      if (snapshot.tick !== this.tick) throw new ClientError('The native export belongs to a different tick.');
    } catch {
      this.transport.send({ type: 'checkpoint_unavailable', id: request.id });
      return;
    }
    void packCheckpoint(request.id, snapshot, this.abort.signal).then(({ header, chunks }) => {
      if (this.abort.signal.aborted || this.checkpointRequest !== request || this.phase !== 'running') return;
      request.chunks = chunks;
      this.transport.send(header as unknown as Record<string, unknown>);
    }).catch(() => {
      if (!this.abort.signal.aborted && this.checkpointRequest === request) {
        try { this.transport.send({ type: 'checkpoint_unavailable', id: request.id }); }
        catch { this.fail('Could not transfer the world snapshot.'); }
      }
    });
  }

  private requireReplayWorkTime(now: number): void {
    // Synchronous native work can postpone timer callbacks. Check both sides
    // of every frame; neither a batch nor regular progress renews these limits.
    if (this.replayDeadline === null || now > this.replayDeadline ||
        now - this.progress > NATIVE_PROGRESS_LIMIT_MS ||
        (this.replayQueuedBarrierDeadline !== null && now > this.replayQueuedBarrierDeadline) ||
        (this.synchronization !== null && now > this.synchronization.deadline)) {
      throw new ClientError('Native replay exceeded the agreed time limit. ACK was not sent.');
    }
  }

  private requireCheckpointWorkTime(deadline: number): void {
    const now = this.now();
    // The transfer has its own progress allowance, but never extends the
    // original absolute replay limit or a barrier already received on wire.
    // Do not apply the shorter native-frame progress watchdog during transfer.
    if (now > deadline || this.replayDeadline === null || now > this.replayDeadline
      || (this.replayQueuedBarrierDeadline !== null && now > this.replayQueuedBarrierDeadline)
      || (this.synchronization !== null && now > this.synchronization.deadline)) {
      throw new ClientError('Native world transfer exceeded the agreed time limit.');
    }
  }

  start(): void {
    if (this.phase !== 'waiting' || this.joinedMessage?.slot !== 1 || this.startSent) return;
    this.startSent = true;
    try { this.transport.send({ type: 'start' }); } catch { this.fail('Could not send start.'); }
  }

  input(mask: number, clear = false): void {
    if (this.phase !== 'running' || this.awaitingGuestSpawn || this.synchronization || this.networkWaiting) return;
    if (!isMask(mask) || (clear && mask !== 0)) { this.fail('Invalid local input mask.'); return; }
    if (mask === this.mask && !clear) return;
    this.mask = mask;
    this.transmitInput(mask, clear);
  }

  checkTimeout(): void {
    if (this.nativeWorkDeadline !== null && this.now() > this.nativeWorkDeadline) {
      this.fail('The live native step exceeded the agreed time limit. ACK was not sent.');
      return;
    }
    try { this.requireNetworkTime(); }
    catch (error) { this.fail(publicError(error)); return; }
    if (this.checkpointWait && this.now() > this.checkpointWait.deadline) {
      this.fail('The time limit for receiving the world state expired.');
      return;
    }
    if (this.phase === 'replaying' && this.replayDeadline !== null &&
        this.now() > this.replayDeadline + this.guestFinalControlGrace()) {
      this.fail('The absolute replay deadline for the second player expired.');
      return;
    }
    const hostWaiting = this.joinedMessage?.slot === 1 && this.synchronization !== null;
    const deliveryGrace = hostWaiting ? HOST_RESUME_GRACE_MS : this.guestFinalControlGrace();
    if (this.synchronization && this.now() > this.synchronization.deadline + deliveryGrace) {
      this.fail('The time limit for the second player to join expired.');
      return;
    }
    const elapsed = this.now() - this.progress;
    if ((this.phase === 'joining' && elapsed > 10_000) ||
        ((this.phase === 'preparing' || this.phase === 'ready') && !hostWaiting && elapsed > 190_000) ||
        (this.phase === 'replaying' &&
          !hostWaiting && !this.checkpointWait && elapsed > 10_000)) {
      this.fail('Timed out waiting for the server or a native step. The game has stopped.');
      return;
    }
    this.refreshHeldInput();
  }

  private requireNetworkTime(): void {
    const now = this.now();
    if ((this.networkWaiting && now > this.networkWaiting.deadline + NETWORK_CONTROL_GRACE_MS) ||
        (this.awaitingGuestSpawn && now - this.progress > NATIVE_PROGRESS_LIMIT_MS) ||
        ((this.phase === 'running' || this.phase === 'completing') && this.tick > 0 && !this.synchronization &&
          now - this.progress > NETWORK_IDLE_LIMIT_MS)) {
      throw new ClientError('Timed out waiting for the game connection to recover. The game has stopped.');
    }
  }

  private clearNetworkWaiting(): void {
    if (!this.networkWaiting) return;
    this.networkWaiting = null;
    this.events.networkStatus?.(null);
  }

  private guestFinalControlGrace(): number {
    const sync = this.synchronization;
    return this.joinedMessage?.slot === 2 && this.phase === 'replaying' && sync !== null &&
      this.tick === sync.tick && sync.workFinishedAt !== null && sync.workFinishedAt <= sync.deadline
      ? GUEST_FINAL_CONTROL_GRACE_MS : 0;
  }

  disconnected(): void {
    if (this.phase !== 'completed') this.fail('The connection closed. Native steps have stopped.');
  }
  reject(message: string): void { this.fail(message); }

  close(): void {
    if (this.phase === 'closed') return;
    this.release();
    this.phase = 'closed';
    this.synchronization = null;
    this.clearNetworkWaiting();
    this.abort.abort();
    this.clearReplayInbox();
    try { this.transport.close(); } catch { /* already closed */ }
  }

  private release(): void {
    if (this.phase !== 'running' || this.awaitingGuestSpawn || this.synchronization || this.networkWaiting || this.seq >= 0x7fffffff) return;
    try { this.transport.send({ type: 'input', seq: ++this.seq, mask: 0, clear: true }); } catch { /* socket unavailable */ }
    this.mask = 0;
  }

  private transmitInput(mask: number, clear: boolean): void {
    if (this.seq >= 0x7fffffff) { this.fail('The input counter is exhausted.'); return; }
    try {
      this.transport.send({ type: 'input', seq: ++this.seq, mask, ...(clear ? { clear: true } : {}) });
      this.lastInputSentAt = this.now();
    } catch { this.fail('Could not send input. The game has stopped.'); }
  }

  private refreshHeldInput(): boolean {
    // The server expires input after 600 ms. Repeat the locally held mask;
    // a renewal never counts as native gameplay progress.
    if (this.phase === 'running' && !this.synchronization && !this.networkWaiting && this.mask !== 0 && this.now() - this.lastInputSentAt >= 200) {
      this.transmitInput(this.mask, false);
    }
    return this.phase === 'running';
  }

  private fail(message: string): void {
    if (this.phase === 'closed' || this.phase === 'failed' || this.phase === 'completed') return;
    this.release();
    this.phase = 'failed';
    this.synchronization = null;
    this.clearNetworkWaiting();
    this.abort.abort();
    this.clearReplayInbox();
    try { this.transport.close(); } catch { /* already closed */ }
    this.events.failed(message);
  }
}

