/**
 * Mirror auto-reply input gate accounting (PtyBlock's xterm branch).
 *
 * A non-controlling mirror suppresses xterm's synchronous auto-replies by
 * dropping `term.onData` while a query-carrying mirror write is in flight
 * (armed here; see PtyBlock's gate comment for the full rationale). Each
 * release runs in that write's flush callback — which xterm only guarantees
 * while its write-buffer chain survives, so a stranded callback must never be
 * able to gate input forever.
 *
 * A pty replay reset (resume/reconnect) starts a new stream generation:
 * `reset()` unblocks immediately, and a release belonging to a pre-reset
 * write becomes inert instead of driving the count negative — a negative
 * count would permanently disarm the gate and leak auto-replies into the
 * shared PTY input. Same generation-guard idiom as BlockController's
 * `ptyFlowEpoch`.
 */
export class MirrorWriteGate {
  private inFlight = 0;
  private epoch = 0;

  /** Account one query-carrying mirror write; returns its idempotent release. */
  arm(): () => void {
    this.inFlight += 1;
    const armedEpoch = this.epoch;
    let released = false;
    return () => {
      if (released || armedEpoch !== this.epoch) return;
      released = true;
      this.inFlight -= 1;
    };
  }

  /** True while any armed write is unflushed — mirror onData must be dropped. */
  get blocked(): boolean {
    return this.inFlight > 0;
  }

  /** New stream generation (pty replay reset): unblock now; every release
   * armed before this call becomes inert. */
  reset(): void {
    this.epoch += 1;
    this.inFlight = 0;
  }
}
