/**
 * StatsVisibility — refcount combiner for the status panel's "is anyone
 * looking" gate (mobile remote-control M1). Before this, `main.ts` read
 * `SystemStatsService.isPanelVisible()` directly; now a remote (mobile)
 * viewer can also want the panel-open-only collectors running, so effective
 * visibility is `desktopVisible || remoteCount > 0`. `apply` fires only on a
 * transition of that combined boolean — never on every acquire/release/
 * setDesktopVisible call — so two overlapping viewers (desktop + mobile, or
 * two mobile connections) never toggle SystemStatsService's open-time loops
 * off and back on for no reason.
 */
export class StatsVisibility {
  private desktopVisible = false;
  private remoteCount = 0;
  private effective = false;

  constructor(private readonly apply: (effective: boolean) => void) {}

  setDesktopVisible(visible: boolean): void {
    this.desktopVisible = visible;
    this.recompute();
  }

  /** One remote viewer turned stats on. */
  acquire(): void {
    this.remoteCount++;
    this.recompute();
  }

  /** One remote viewer turned stats off. Clamped at 0 (double-release guard). */
  release(): void {
    if (this.remoteCount > 0) this.remoteCount--;
    this.recompute();
  }

  private recompute(): void {
    const next = this.desktopVisible || this.remoteCount > 0;
    if (next === this.effective) return;
    this.effective = next;
    this.apply(next);
  }
}
