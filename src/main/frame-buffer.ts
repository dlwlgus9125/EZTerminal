/**
 * FrameBuffer — T1 skeleton scope.
 * Coalesces PTY data chunks per session over a 16ms window.
 * Single-session in T1; per-session independence expanded in T2.
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

  private flush(sessionId: string): void {
    this.timers.delete(sessionId);
    const chunks = this.chunks.get(sessionId) ?? [];
    this.chunks.delete(sessionId);
    if (chunks.length === 0) return;
    const coalesced = chunks.join("");
    this.flushCallback?.(sessionId, coalesced);
  }
}
