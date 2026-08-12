import {
  RUNTIME_PARK_GRACE_MS,
  type RuntimeLifecycleTier,
  type RuntimeSurfaceActivity,
} from '../shared/runtime-lifecycle';

interface RuntimeLifecycleClock {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface RuntimeSurfaceLifecycleOptions {
  readonly graceMs?: number;
  readonly clock?: RuntimeLifecycleClock;
}

const DEFAULT_CLOCK: RuntimeLifecycleClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/** One panel's race-safe active/passive/parked state machine. Visible panes in
 * unfocused windows remain passive indefinitely; only an invisible surface
 * crosses the 30-second renderer-release boundary. */
export class RuntimeSurfaceLifecycle {
  private readonly graceMs: number;
  private readonly clock: RuntimeLifecycleClock;
  private tier: RuntimeLifecycleTier = 'passive';
  private activity: RuntimeSurfaceActivity | null = null;
  private inactiveSince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  public constructor(
    private readonly onTierChange: (tier: RuntimeLifecycleTier) => void,
    options: RuntimeSurfaceLifecycleOptions = {},
  ) {
    this.graceMs = Math.max(0, options.graceMs ?? RUNTIME_PARK_GRACE_MS);
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  public get currentTier(): RuntimeLifecycleTier {
    return this.tier;
  }

  public update(activity: RuntimeSurfaceActivity): RuntimeLifecycleTier {
    if (this.disposed) return this.tier;
    this.activity = activity;
    this.reconcile();
    return this.tier;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.activity = null;
  }

  private reconcile(): void {
    const activity = this.activity;
    if (!activity || this.disposed) return;
    const nativeVisible = activity.windowVisible && !activity.windowMinimized;
    const inactive = !activity.panelVisible || !nativeVisible;

    if (!inactive) {
      this.inactiveSince = null;
      this.cancelTimer();
      this.setTier(activity.windowFocused ? 'active' : 'passive');
      return;
    }

    const now = this.clock.now();
    if (this.inactiveSince === null) this.inactiveSince = now;
    const remaining = this.graceMs - (now - this.inactiveSince);
    if (remaining <= 0) {
      this.cancelTimer();
      this.setTier('parked');
      return;
    }

    this.setTier('passive');
    this.cancelTimer();
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.reconcile();
    }, remaining);
    (this.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private setTier(next: RuntimeLifecycleTier): void {
    if (next === this.tier) return;
    this.tier = next;
    this.onTierChange(next);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimer(this.timer);
    this.timer = null;
  }
}
