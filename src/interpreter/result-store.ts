/**
 * ResultStore — credit/backpressure buffer on the interpreter side (architecture §3).
 *
 * A pipeline produces rows lazily. The store wraps that single AsyncIterator and
 * buffers rows *as they are pulled*, keyed implicitly to one block (one store per
 * block). The renderer never receives the whole result — it requests windows via
 * `requestRows`/`setViewport` and the interpreter answers with `chunk {start, rows}`
 * slices taken from this store.
 *
 * Two properties make this honest backpressure:
 *   1. `ensure(target)` only advances the source until `target` rows are buffered
 *      (or the source is exhausted). A 100k-row source is *not* drained just to
 *      serve the first window — only what the granted window needs is pulled.
 *   2. Pulls are serialized through `advanceChain` so the single underlying
 *      iterator is never advanced concurrently (a background total-count drain and
 *      an on-demand window fetch can both call `ensure` safely).
 *
 * The buffer lives in the utilityProcess (Node) memory, never in renderer/React
 * state — only window slices cross the IPC boundary.
 */

import type { ResultRow } from '../shared/ipc';

/**
 * Hard cap on a single served window. A renderer control asking for a huge `count`
 * would otherwise force the store to drain (and the chunk frame to carry) that many
 * rows at once — defeating the windowed/credit design. Real viewports request a few
 * hundred rows; this is a generous ceiling that bounds a malformed/oversized request.
 */
const MAX_WINDOW = 10_000;

export class ResultStore {
  private readonly rows: ResultRow[] = [];
  private done = false;
  /** Serializes source pulls: the single iterator is advanced one call at a time. */
  private advanceChain: Promise<void> = Promise.resolve();

  constructor(private readonly iterator: AsyncIterator<ResultRow>) {}

  /** Rows buffered so far (the running total while filling). */
  get count(): number {
    return this.rows.length;
  }

  /** True once the source has been fully consumed. */
  get exhausted(): boolean {
    return this.done;
  }

  at(index: number): ResultRow | undefined {
    return this.rows[index];
  }

  /**
   * Advance the source until at least `target` rows are buffered (or it is
   * exhausted). Serialized so the iterator is never advanced concurrently;
   * errors (e.g. abort) surface to *this* caller while later `ensure` calls keep
   * their ordering.
   */
  ensure(target: number): Promise<void> {
    const run = this.advanceChain.then(() => this.advanceUntil(target));
    this.advanceChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async advanceUntil(target: number): Promise<void> {
    while (!this.done && this.rows.length < target) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        return;
      }
      this.rows.push(next.value);
    }
  }

  /**
   * Return the [start, start+count) window, pulling rows on demand. `readAhead`
   * buffers extra rows past the window (so subsequent scrolls are instant) but is
   * NEVER included in the returned slice — the interpreter must not send beyond the
   * granted window.
   */
  async getWindow(
    start: number,
    count: number,
    readAhead = 0,
  ): Promise<{ start: number; rows: ResultRow[] }> {
    const safeStart = Math.max(0, Math.trunc(start));
    const safeCount = Math.min(MAX_WINDOW, Math.max(0, Math.trunc(count)));
    await this.ensure(safeStart + safeCount + Math.max(0, readAhead));
    return { start: safeStart, rows: this.rows.slice(safeStart, safeStart + safeCount) };
  }

  /** Stop consuming the source and release it. */
  async dispose(): Promise<void> {
    this.done = true;
    await this.iterator.return?.();
  }
}
