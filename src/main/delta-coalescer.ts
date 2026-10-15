import type { DaemonTranscriptItem } from '../shared/daemon-protocol';

/**
 * Batches streaming text deltas before they become durable transcript rows.
 *
 * Providers emit a delta per token or word. Persisting each one costs a SQLite
 * transaction, an event and a renderer refetch, so adapters buffer deltas per
 * message and flush on a short timer, a size bound, or a block boundary. The
 * caller supplies `build`, which allocates the transcript sequence only when a
 * row is actually emitted, so sequences stay gapless.
 *
 * Ordering contract: an adapter must call `flushAll()` before it emits any other
 * transcript item, so a buffered delta never lands after a later tool call.
 */
export interface DeltaCoalescerOptions {
  readonly intervalMs?: number;
  readonly maxChars?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

interface PendingDelta {
  text: string;
  build: (text: string) => DaemonTranscriptItem | undefined;
}

export class DeltaCoalescer {
  private readonly pending = new Map<string, PendingDelta>();
  private timer: unknown;
  private readonly intervalMs: number;
  private readonly maxChars: number;
  private readonly schedule: NonNullable<DeltaCoalescerOptions['schedule']>;
  private readonly cancel: NonNullable<DeltaCoalescerOptions['cancel']>;

  constructor(
    private readonly emit: (item: DaemonTranscriptItem) => void,
    options: DeltaCoalescerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 80;
    this.maxChars = options.maxChars ?? 2_048;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Buffer `text` for message `key`; `build` turns the accumulated text into one delta row. */
  append(key: string, text: string, build: (text: string) => DaemonTranscriptItem | undefined): void {
    if (!text) return;
    const current = this.pending.get(key);
    if (current) {
      current.text += text;
      current.build = build;
    } else {
      this.pending.set(key, { text, build });
    }
    if ((current?.text.length ?? text.length) >= this.maxChars) {
      this.flush(key);
      return;
    }
    if (this.timer === undefined) {
      this.timer = this.schedule(() => {
        this.timer = undefined;
        this.flushAll();
      }, this.intervalMs);
    }
  }

  flush(key: string): void {
    const current = this.pending.get(key);
    if (!current) return;
    this.pending.delete(key);
    const item = current.build(current.text);
    if (item) this.emit(item);
    if (this.pending.size === 0) this.clearTimer();
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key);
    this.clearTimer();
  }

  /** Drops nothing: pending text is flushed so an interrupted stream keeps what arrived. */
  dispose(): void {
    this.flushAll();
  }

  get size(): number {
    return this.pending.size;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}
