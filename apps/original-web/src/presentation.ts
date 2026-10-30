/** Render-only scheduling. Never invokes a native step or changes game time. */
export interface PresentationClock {
  now(): number;
  request(callback: (timestamp: number) => void): number;
  cancel(id: number): void;
}

/**
 * Reserve presentation's place before Ruffle creates its recurring rAF loop.
 *
 * In pinned Ruffle cac5c99ce4a17e606f4ee3090389bb878f852055,
 * web/src/lib.rs::RuffleHandle::tick rearms rAF, ticks, then renders when dirty.
 * core/src/player.rs::Player::call_internal_interface does not render, and
 * avm1/globals.rs::update_after_event only sets needs_render. Starting a separate
 * pump after the first native step therefore puts each bitmap update after that
 * opportunity's Ruffle render. This dispatcher is installed before createPlayer
 * and rearms first, preserving registration order without an engine API hook.
 * It invokes no native callback until a completed live step requests one.
 */
export class OriginalPresentationDispatcher implements PresentationClock {
  private scheduled: number | null = null;
  private nextCallback = 0;
  private closed = false;
  private readonly callbacks = new Map<number, (timestamp: number) => void>();
  private readonly aborted = (): void => this.close();

  constructor(private readonly clock: PresentationClock, private readonly signal?: AbortSignal) {
    if (signal?.aborted) { this.closed = true; return; }
    signal?.addEventListener('abort', this.aborted, { once: true });
    this.scheduled = this.clock.request(this.frame);
  }

  now(): number { return this.clock.now(); }

  request(callback: (timestamp: number) => void): number {
    const id = ++this.nextCallback;
    // A synchronous native callback can dispose its player. Its finishing pump
    // may still request another frame; never revive a disposed generation.
    if (!this.closed) this.callbacks.set(id, callback);
    return id;
  }

  cancel(id: number): void { this.callbacks.delete(id); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.aborted);
    if (this.scheduled !== null) this.clock.cancel(this.scheduled);
    this.scheduled = null;
    this.callbacks.clear();
  }

  private readonly frame = (timestamp: number): void => {
    this.scheduled = null;
    if (this.closed) return;
    // Reserve the next opportunity before any callback can register Ruffle's
    // loop or request its next presentation. Dormant frames do no bitmap work.
    this.scheduled = this.clock.request(this.frame);
    if (this.callbacks.size === 0) return;
    const callbacks = [...this.callbacks];
    for (const [id, callback] of callbacks) {
      if (this.closed) return;
      if (!this.callbacks.delete(id)) continue;
      callback(timestamp);
    }
  };
}

export interface PresentationResult {
  version: 1;
  enabled: boolean;
  rendered: boolean;
  tick: number;
  error?: string;
  mode?: string;
  poseVersion?: number;
  poseTick?: number;
}

export const THREE_POSE_PRESENTATION_MODE = 'three-pose-v2' as const;
export const FOUR_POSE_PRESENTATION_MODE = 'four-pose-v3' as const;

export interface PresentationVisibility {
  hidden(): boolean;
  subscribe(changed: () => void): () => void;
}

export interface PresentationPumpOptions {
  /** Requires an exact, successful native configuration of the same mode. */
  mode?: typeof THREE_POSE_PRESENTATION_MODE | typeof FOUR_POSE_PRESENTATION_MODE;
  visibility?: PresentationVisibility;
}

/**
 * A visual clock, not a simulation clock. Native ticks remain unmodified.
 *
 * Arrival times are samples for a bounded interval estimate. They never assign
 * the cursor. At normal speed the interior target is 75 ms (1.875 ticks), not a
 * promise of 80 ms stall coverage. The cursor advances at no more than 25 ticks/s
 * and slews down by at most five percent; absent future poses it stops. Starting
 * from the first real pose gradually fills the buffer without fabricated poses.
 */
class BufferedPoseTimeline {
  private tick = 0;
  private firstTick = 0;
  private frameMs = 40;
  private interval = 40;
  private startedAt = 0;
  private referenceTick = 0;
  private sampledAt = 0;
  private sampledNativeTick = 0;
  private cursor = 0;
  private initialized = false;
  private restoreCanonical = false;
  private historyWaitAt: number | null = null;
  private readonly starts: { tick: number; at: number }[] = [];

  stepped(tick: number, frameMs: number, startedAt: number): void {
    if (!this.initialized) {
      this.initialized = true;
      this.firstTick = tick;
      this.cursor = tick;
      this.sampledAt = startedAt;
      this.sampledNativeTick = tick;
      this.interval = frameMs;
    } else if (tick !== this.tick + 1 || frameMs !== this.frameMs) {
      // Only an actual discontinuity, never an ordinary 33/50 ms arrival,
      // permits one canonical restore and a fresh bounded visual buffer.
      this.firstTick = tick;
      this.restoreCanonical = true;
      this.starts.length = 0;
      this.interval = frameMs;
    }
    this.tick = tick;
    this.frameMs = frameMs;
    this.startedAt = startedAt;
    this.starts.push({ tick, at: startedAt });
    if (this.starts.length > 32) this.starts.shift();
    if (this.starts.length >= 8) {
      const oldest = this.starts[0];
      const observed = (startedAt - oldest.at) / (tick - oldest.tick);
      if (Number.isFinite(observed) && observed > 0) {
        // Filter both sides of alignment jitter. Clipping every observation
        // upward to frameMs biases an exact 25 Hz stream toward a slower clock.
        const bounded = Math.max(frameMs * 0.90, Math.min(frameMs * 1.10, observed));
        this.interval += (bounded - this.interval) / 16;
      }
    }
    // A full validation delays a few starts and then permits bounded catch-up.
    // Those individual outliers must not move the clock reference backwards.
    // Estimate phase from the median of the same finite window, projected to
    // this start time. This is only a clock estimate; sample() still caps every
    // displayed pose at the latest actually captured tick.
    const phases = this.starts.map(start => start.tick + (startedAt - start.at) / this.interval)
      .sort((left, right) => left - right);
    const middle = Math.floor(phases.length / 2);
    this.referenceTick = phases.length % 2 === 0
      ? (phases[middle - 1] + phases[middle]) / 2 : phases[middle];
  }

  resumed(): void { this.restoreCanonical = true; }

  sample(timestamp: number): number | null {
    const elapsed = Math.max(0, timestamp - this.sampledAt);
    // Some embedders do not expose visibility. A long paint gap that has lost
    // more than the entire three-pose history is a visible discontinuity too.
    // Restore once in O(1); do not replay missed presentations or strand a
    // cursor permanently behind a bounded buffer.
    if (elapsed >= Math.max(250, this.frameMs * 4)
      && this.tick - this.sampledNativeTick > 3) this.restoreCanonical = true;
    if (this.restoreCanonical) {
      this.cursor = this.tick;
      this.restoreCanonical = false;
      this.historyWaitAt = null;
    } else {
      const predicted = this.cursor + elapsed / this.interval;
      const target = this.referenceTick - 1.875 + Math.max(0, timestamp - this.startedAt) / this.interval;
      // One-second phase correction, constrained to [0.95, 1] of native speed.
      // A new pose can only alter this small rate correction, not position.
      const rate = Math.max(0.95 / this.frameMs,
        Math.min(1 / this.frameMs, 1 / this.interval + (target - predicted) / 1000));
      this.cursor = Math.min(this.tick, this.cursor + elapsed * rate);
    }
    this.sampledAt = Math.max(this.sampledAt, timestamp);
    this.sampledNativeTick = this.tick;
    const oldest = Math.max(this.firstTick, this.tick - 2);
    if (this.cursor + 1e-9 < oldest) {
      // Do not force the cursor forward when ordinary catch-up outruns history.
      // Keep the last real bitmap briefly, then surface the resource failure.
      // This guard is not counted as a rendered frame and cannot hold forever.
      this.historyWaitAt ??= timestamp;
      if (timestamp - this.historyWaitAt >= this.frameMs * 2) {
        throw new Error('Native presentation exhausted its three-pose history');
      }
      return null;
    }
    this.historyWaitAt = null;
    return this.cursor;
  }
}

/**
 * Explicit v3 visual contract. Four scalar poses retain three intervals while
 * the target remains 1.875 native intervals (75 ms at the original 25 TPS).
 * The extra interval is eviction headroom, not an additional display delay.
 *
 * Native invocation times and samples share the actual monotonic clock. A
 * nominal rAF timestamp can predate a newly available native pose when its
 * callback was delayed. Both rates of phase correction are bounded at five
 * percent of native speed; positive correction repairs accumulated visual lag
 * without assigning a new cursor on arrival. No future pose is extrapolated.
 * This separate class deliberately leaves the v2 rate/timestamp contract intact.
 */
class FourPoseTimeline {
  private tick = 0;
  private firstTick = 0;
  private frameMs = 40;
  private interval = 40;
  private startedAt = 0;
  private referenceTick = 0;
  private sampledAt = 0;
  private sampledNativeTick = 0;
  private cursor = 0;
  private initialized = false;
  private restoreCanonical = false;
  private historyWaitAt: number | null = null;
  private readonly starts: { tick: number; at: number }[] = [];

  stepped(tick: number, frameMs: number, startedAt: number): void {
    if (!this.initialized) {
      this.initialized = true;
      this.firstTick = tick;
      this.cursor = tick;
      this.sampledAt = startedAt;
      this.sampledNativeTick = tick;
      this.interval = frameMs;
    } else if (tick !== this.tick + 1 || frameMs !== this.frameMs) {
      this.firstTick = tick;
      this.restoreCanonical = true;
      this.starts.length = 0;
      this.interval = frameMs;
    }
    this.tick = tick;
    this.frameMs = frameMs;
    this.startedAt = startedAt;
    this.starts.push({ tick, at: startedAt });
    if (this.starts.length > 32) this.starts.shift();
    if (this.starts.length >= 8) {
      const oldest = this.starts[0];
      const observed = (startedAt - oldest.at) / (tick - oldest.tick);
      if (Number.isFinite(observed) && observed > 0) {
        const bounded = Math.max(frameMs * 0.90, Math.min(frameMs * 1.10, observed));
        this.interval += (bounded - this.interval) / 16;
      }
    }
    const phases = this.starts.map(start => start.tick + (startedAt - start.at) / this.interval)
      .sort((left, right) => left - right);
    const middle = Math.floor(phases.length / 2);
    this.referenceTick = phases.length % 2 === 0
      ? (phases[middle - 1] + phases[middle]) / 2 : phases[middle];
  }

  resumed(): void { this.restoreCanonical = true; }

  sample(timestamp: number): number | null {
    if (!Number.isFinite(timestamp) || timestamp < this.sampledAt || timestamp < 0) {
      throw new Error('Native four-pose presentation clock is not monotonic');
    }
    const elapsed = timestamp - this.sampledAt;
    if (elapsed >= Math.max(250, this.frameMs * 5)
      && this.tick - this.sampledNativeTick > 4) this.restoreCanonical = true;
    if (this.restoreCanonical) {
      this.cursor = this.tick;
      this.restoreCanonical = false;
      this.historyWaitAt = null;
    } else {
      const predicted = this.cursor + elapsed / this.interval;
      const target = this.referenceTick - 1.875 + Math.max(0, timestamp - this.startedAt) / this.interval;
      const rate = Math.max(0.95 / this.frameMs,
        Math.min(1.05 / this.frameMs, 1 / this.interval + (target - predicted) / 1000));
      this.cursor = Math.min(this.tick, this.cursor + elapsed * rate);
    }
    this.sampledAt = timestamp;
    this.sampledNativeTick = this.tick;
    const oldest = Math.max(this.firstTick, this.tick - 3);
    if (this.cursor + 1e-9 < oldest) {
      // A finite buffer still has a real overload limit. Never hide it by
      // teleporting the cursor, indefinitely holding a bitmap, or inventing
      // repeated presentations. Four poses do not promise arbitrary stalls.
      this.historyWaitAt ??= timestamp;
      if (timestamp - this.historyWaitAt >= this.frameMs * 2) {
        throw new Error('Native presentation exhausted its four-pose history');
      }
      return null;
    }
    this.historyWaitAt = null;
    return this.cursor;
  }
}

export class OriginalPresentationPump {
  private scheduled: number | null = null;
  private closed = false;
  private tick = 0;
  private stepAt = 0;
  private frameMs = 40;
  private nextPresentationAt = -Infinity;
  private lastTick = -1;
  private lastAlpha = -1;
  private readonly buffered: BufferedPoseTimeline | FourPoseTimeline | null;
  private readonly bufferedMode: PresentationPumpOptions['mode'];
  private hidden = false;
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(
    private readonly present: (alpha: number) => unknown,
    private readonly clock: PresentationClock,
    private readonly failed: (error: unknown) => void,
    options: PresentationPumpOptions = {},
  ) {
    this.bufferedMode = options.mode;
    this.buffered = options.mode === FOUR_POSE_PRESENTATION_MODE ? new FourPoseTimeline()
      : options.mode === THREE_POSE_PRESENTATION_MODE ? new BufferedPoseTimeline() : null;
    if (this.buffered) {
      const visibility = options.visibility ?? (typeof document === 'undefined' ? undefined : {
        hidden: () => document.visibilityState === 'hidden',
        subscribe: (changed: () => void) => {
          document.addEventListener('visibilitychange', changed);
          return () => document.removeEventListener('visibilitychange', changed);
        },
      });
      if (visibility) {
        this.hidden = visibility.hidden();
        this.unsubscribeVisibility = visibility.subscribe(() => {
          const hidden = visibility.hidden();
          if (this.hidden && !hidden) this.buffered?.resumed();
          this.hidden = hidden;
        });
      }
    }
  }

  stepped(tick: number, frameMs: number, startedAt: number): void {
    if (this.closed || !Number.isInteger(tick) || tick <= this.tick || ![20, 40, 80].includes(frameMs)) return;
    if (!Number.isFinite(startedAt) || startedAt < 0 || startedAt > this.clock.now() || startedAt < this.stepAt) {
      this.close();
      this.failed(new Error('Native presentation step timestamp is not monotonic'));
      return;
    }
    this.tick = tick;
    // The completed native step supplies its invocation start on this clock.
    // Variable snapshot cost must not restart a fresh interpolation interval
    // after that synchronous work. Rendering still waits for the next rAF.
    this.stepAt = startedAt;
    this.frameMs = frameMs;
    this.buffered?.stepped(tick, frameMs, startedAt);
    if (this.scheduled === null) this.scheduled = this.clock.request(this.frame);
  }

  close(): void {
    this.closed = true;
    if (this.scheduled !== null) this.clock.cancel(this.scheduled);
    this.scheduled = null;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  }

  private readonly frame = (timestamp: number): void => {
    this.scheduled = null;
    if (this.closed) return;
    if (this.hidden) { this.scheduled = this.clock.request(this.frame); return; }
    // A faster monitor does not multiply bitmap replay cost. Tolerate the
    // sub-millisecond jitter of a real 60 Hz vsync timestamp.
    const period = 1000 / 60;
    if (timestamp + 0.5 >= this.nextPresentationAt) {
      let poseTick: number | null = null;
      try {
        if (this.buffered) {
          if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('Invalid native presentation clock');
          // v3 samples actual entry time on the same clock as native starts;
          // nominal rAF still determines the at-most-60-Hz request cadence.
          poseTick = this.buffered.sample(this.bufferedMode === FOUR_POSE_PRESENTATION_MODE ? this.clock.now() : timestamp);
          if (poseTick === null) { this.scheduled = this.clock.request(this.frame); return; }
        }
      } catch (error) {
        this.close(); this.failed(error); return;
      }
      const poseSpan = this.bufferedMode === FOUR_POSE_PRESENTATION_MODE ? 3 : 2;
      const alpha = Math.max(0, Math.min(1, this.buffered
        ? (poseTick! - (this.tick - poseSpan)) / poseSpan : (timestamp - this.stepAt) / this.frameMs));
      if (this.lastTick !== this.tick || this.lastAlpha !== alpha) {
        try {
          const raw = this.present(alpha);
          const result = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<PresentationResult> | null;
          if (!result || result.version !== 1 || typeof result.enabled !== 'boolean' || typeof result.rendered !== 'boolean'
            || !Number.isInteger(result.tick) || result.tick !== this.tick || result.error) {
            throw new Error(result?.error || 'Native presentation result is unavailable or stale');
          }
          if (!result.enabled) throw new Error('Native presentation was disabled');
          if (this.buffered && (result.mode !== this.bufferedMode
            || result.poseVersion !== (this.bufferedMode === FOUR_POSE_PRESENTATION_MODE ? 3 : 2)
            || typeof result.poseTick !== 'number' || !Number.isFinite(result.poseTick)
            || Math.abs(result.poseTick - poseTick!) > 1e-7)) {
            throw new Error('Native presentation pose mode or phase does not match its visual clock');
          }
          this.lastTick = this.tick;
          this.lastAlpha = alpha;
        } catch (error) {
          this.close();
          this.failed(error);
          return;
        }
      }
      // Retain fractional cadence: resetting the deadline to each callback
      // would quantize 144 Hz displays to 48 rather than about 60 updates/s.
      this.nextPresentationAt = !Number.isFinite(this.nextPresentationAt) || timestamp - this.nextPresentationAt > period * 2
        ? timestamp + period : this.nextPresentationAt + period;
    }
    this.scheduled = this.clock.request(this.frame);
  };
}
