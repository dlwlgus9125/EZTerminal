export const OPENCLAW_VISIBILITY_SEED_TIMEOUT_MS = 5_000;

/**
 * Bounds startup's dependency on an optional OpenClaw capability. A missing
 * IPC reply must fail closed without holding the entire workbench restore
 * forever. `cancelPending` is intentionally reusable for React StrictMode's
 * effect cleanup/re-subscribe cycle.
 */
export class OpenClawVisibilitySeedLatch {
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;

  constructor(
    private readonly onTimeout: () => void,
    private readonly timeoutMs = OPENCLAW_VISIBILITY_SEED_TIMEOUT_MS,
  ) {}

  wait(): Promise<void> {
    if (this.settled) return Promise.resolve();
    if (this.pendingResolve) {
      return new Promise((resolve) => {
        const previousResolve = this.pendingResolve;
        this.pendingResolve = () => {
          previousResolve?.();
          resolve();
        };
      });
    }

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        try {
          this.onTimeout();
        } finally {
          this.settle();
        }
      }, this.timeoutMs);
    });
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.finishPending();
  }

  cancelPending(): void {
    this.finishPending();
  }

  private finishPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }
}
