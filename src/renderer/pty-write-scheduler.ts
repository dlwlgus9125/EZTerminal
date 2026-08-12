import type { RuntimeLifecycleTier } from '../shared/runtime-lifecycle';

export interface PtyScheduledWrite {
  readonly bytes: Uint8Array;
  readonly onFlushed: () => void;
  readonly suppressSideEffects: boolean;
}
export interface PtyWriteSchedulerOptions {
  readonly passiveDelayMs?: number;
  readonly parkedDelayMs?: number;
  readonly maxBatchBytes?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Delays paint-facing writes in passive windows while keeping each original
 * xterm flush callback (and therefore PTY ACK accounting) exact. */
export class PtyWriteScheduler {
  private readonly passiveDelayMs: number;
  private readonly parkedDelayMs: number;
  private readonly maxBatchBytes: number;
  private readonly setTimer: NonNullable<PtyWriteSchedulerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<PtyWriteSchedulerOptions['clearTimer']>;
  private readonly queue: PtyScheduledWrite[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tier: RuntimeLifecycleTier;
  private disposed = false;

  public constructor(
    tier: RuntimeLifecycleTier,
    private readonly deliver: (write: PtyScheduledWrite) => void,
    options: PtyWriteSchedulerOptions = {},
  ) {
    this.tier = tier;
    this.passiveDelayMs = Math.max(1, options.passiveDelayMs ?? 67);
    this.parkedDelayMs = Math.max(
      this.passiveDelayMs,
      options.parkedDelayMs ?? 250,
    );
    this.maxBatchBytes = Math.max(1, options.maxBatchBytes ?? 256 * 1024);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  public write(write: PtyScheduledWrite): void {
    if (this.disposed) return;
    if (this.tier === 'active') {
      this.deliver(write);
      return;
    }
    this.queue.push(write);
    this.queuedBytes += write.bytes.byteLength;
    if (this.queuedBytes >= this.maxBatchBytes) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.tier === 'parked' ? this.parkedDelayMs : this.passiveDelayMs);
  }

  public setTier(tier: RuntimeLifecycleTier): void {
    if (this.disposed || tier === this.tier) return;
    this.tier = tier;
    if (tier === 'active') this.flush();
  }

  public flush(): void {
    if (this.disposed) return;
    this.cancelTimer();
    const writes = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const write of writes) this.deliver(write);
  }

  /** Drops not-yet-delivered callbacks. BlockController's sink detachment
   * requeues those exact in-flight entries; acknowledging here would lose them. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
