export type RendererCrashDecision = 'ignore' | 'reload' | 'show-failure';

/**
 * One-shot renderer recovery with an explicit crash-loop breaker.
 *
 * Electron sessions and the interpreter live outside the renderer, so one
 * reload can safely reconnect them. A second crash inside the observation
 * window is left visible for diagnosis instead of looping indefinitely.
 */
export class RendererCrashRecovery {
  private automaticReloads: number[] = [];
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxAutomaticReloads = 1,
  ) {}

  /**
   * Starts a fresh observation window after a successful renderer load.
   * A crash cancels this timer before its decision is made, so a timer left
   * over from the dead renderer cannot erase the crash-loop history.
   */
  armStabilityTimer(): void {
    this.cancelStabilityTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.automaticReloads = [];
    }, this.windowMs);
    (this.stableTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  decide(reason: string, now = Date.now()): RendererCrashDecision {
    this.cancelStabilityTimer();
    if (reason === 'clean-exit') return 'ignore';
    this.automaticReloads = this.automaticReloads.filter(
      (timestamp) => now - timestamp < this.windowMs,
    );
    if (this.automaticReloads.length >= this.maxAutomaticReloads) {
      return 'show-failure';
    }
    this.automaticReloads.push(now);
    return 'reload';
  }

  markStable(): void {
    this.cancelStabilityTimer();
    this.automaticReloads = [];
  }

  dispose(): void {
    this.cancelStabilityTimer();
  }

  private cancelStabilityTimer(): void {
    if (this.stableTimer === null) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }
}
