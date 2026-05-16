/**
 * FrameBuffer — T1+T2 scope.
 * Coalesces PTY data chunks per session over a 16ms window.
 * Per-session independent buffers (T2).
 * endSession(): discard pending buffer for a session (T2).
 */

type FlushCallback = (sessionId: string, data: string) => void;

const COALESCE_MS = 16;

export class FrameBuffer {
  private readonly chunks = new Map<string, string[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushCallback: FlushCallback | null = null;

  onFlush(cb: FlushCallback): void {
    this.flushCallback = cb;
  }

  push(sessionId: string, data: string): void {
    const existing = this.chunks.get(sessionId) ?? [];
    existing.push(data);
    this.chunks.set(sessionId, existing);

    if (!this.timers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flush(sessionId);
      }, COALESCE_MS);
      this.timers.set(sessionId, timer);
    }
  }

  /** Discard all buffered data for a session (call on session end). */
  endSession(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    this.chunks.delete(sessionId);
  }

  private flush(sessionId: string): void {
    this.timers.delete(sessionId);
    const chunks = this.chunks.get(sessionId) ?? [];
    this.chunks.delete(sessionId);
    if (chunks.length === 0) return;
    const coalesced = chunks.join("");
    this.flushCallback?.(sessionId, coalesced);
  }
}
