/**
 * Touch-drag → whole-cell scroll steps (TUI scroll parity, M3).
 *
 * xterm 6 has no touch handling at all (its embedded vs/ scrollable element
 * only listens for 'wheel'), so PtyBlock re-emits a touch drag as synthetic
 * WheelEvents — one per whole terminal cell of drag distance — and lets
 * xterm's own wheel decision tree route them (mouse reports when the child
 * enabled tracking, arrow-key fallback otherwise, viewport scroll on the
 * normal buffer). This class owns the only stateful part: accumulating
 * sub-cell drag deltas (finger movement arrives in fractional-pixel
 * increments) and carrying the residual across events, so slow drags still
 * scroll and a direction reversal doesn't jump a full cell early.
 */
export class TouchScrollAccumulator {
  private residual = 0;

  /**
   * Feed one drag delta in pixels (sign = scroll direction); returns the
   * whole cell-steps to emit now. Non-finite deltas and non-positive cell
   * heights (unmeasurable screen) are ignored.
   */
  feed(deltaPx: number, cellPx: number): number {
    if (!Number.isFinite(deltaPx) || !(cellPx > 0)) return 0;
    this.residual += deltaPx;
    // `|| 0` normalizes Math.trunc's negative zero (same class of trap as the
    // Math.round(-0.5) === -0 rollbar bug) so callers never see -0.
    const steps = Math.trunc(this.residual / cellPx) || 0;
    this.residual -= steps * cellPx;
    return steps;
  }

  /** Drop the carried residual (gesture ended, or a new gesture starts). */
  reset(): void {
    this.residual = 0;
  }
}
