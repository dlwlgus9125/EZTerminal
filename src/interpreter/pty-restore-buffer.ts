/**
 * Bounded semantic PTY restore state for late attach/mobile reconnect.
 *
 * PTY OUTPUT is mirrored into xterm's official Node/headless terminal. A late
 * attacher receives a serialized VT snapshot followed by every output byte
 * newer than that snapshot. User input is deliberately absent from this API,
 * so reconnect can never replay keystrokes or secrets into the child.
 */

import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal, type ITerminalAddon } from '@xterm/headless';

export const PTY_SEMANTIC_SCROLLBACK_LINES = 1000;
export const PTY_SEMANTIC_SNAPSHOT_BYTES = 512 * 1024;
export const PTY_SEMANTIC_TAIL_BYTES = 256 * 1024;
export const PTY_SEMANTIC_SNAPSHOT_INTERVAL_BYTES = 64 * 1024;
export const PTY_SEMANTIC_PENDING_OPS = 1024;

export type PtySemanticRestoreFailure =
  | 'semantic-gap'
  | 'serializer-failed'
  | 'snapshot-too-large'
  | 'resize-pending';

export interface PtySemanticRestoreReplay {
  readonly mode: 'semantic';
  readonly snapshot: Uint8Array;
  readonly tail: readonly Uint8Array[];
  readonly snapshotEpoch: number;
  readonly replayEpoch: number;
  readonly tailBytes: number;
  readonly cols: number;
  readonly rows: number;
}

export interface PtySemanticRestoreFallback {
  readonly mode: 'fallback';
  readonly reason: PtySemanticRestoreFailure;
  readonly snapshotEpoch: number;
  readonly replayEpoch: number;
  readonly gapAfterEpoch?: number;
}

export type PtySemanticRestoreCapture = PtySemanticRestoreReplay | PtySemanticRestoreFallback;

interface TailEntry {
  readonly epoch: number;
  readonly data: Uint8Array;
}

interface WriteOperation {
  readonly kind: 'write';
  readonly entry: TailEntry;
}

interface ResizeOperation {
  readonly kind: 'resize';
  cols: number;
  rows: number;
}

type RestoreOperation = WriteOperation | ResizeOperation;

interface RestoreTerminal {
  write(data: Uint8Array, callback: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: ITerminalAddon): void;
  dispose(): void;
}

interface RestoreSerializer {
  serialize(options: { scrollback: number }): string;
}

export interface PtySemanticRestoreOptions {
  readonly scrollbackLines?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxTailBytes?: number;
  readonly snapshotIntervalBytes?: number;
  readonly maxPendingOperations?: number;
  /** Test seam; production uses the official xterm 6 packages above. */
  readonly createModel?: (cols: number, rows: number, scrollback: number) => {
    readonly terminal: RestoreTerminal;
    readonly serializer: RestoreSerializer;
  };
}

const encoder = new TextEncoder();

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function createXtermModel(
  cols: number,
  rows: number,
  scrollback: number,
): { terminal: RestoreTerminal; serializer: RestoreSerializer } {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback,
  });
  const serializer = new SerializeAddon();
  // Both packages are built from the same xterm.js 6.0.0 commit. The addon's
  // declaration names the browser Terminal even though the runtime contract is
  // the shared addon API officially supported by @xterm/headless.
  terminal.loadAddon(serializer as unknown as ITerminalAddon);
  return { terminal, serializer };
}

/** Bounded semantic snapshot plus an exact epoch-ordered raw tail. */
export class PtySemanticRestoreBuffer {
  private readonly terminal?: RestoreTerminal;
  private readonly serializer?: RestoreSerializer;
  private readonly maxSnapshotBytes: number;
  private readonly maxTailBytes: number;
  private readonly snapshotIntervalBytes: number;
  private readonly maxPendingOperations: number;
  private serializeScrollback: number;

  private streamEpoch = 0;
  private committedEpoch = 0;
  private snapshotEpoch = 0;
  private snapshot: Uint8Array = new Uint8Array(0);
  private snapshotCols: number;
  private snapshotRows: number;
  private targetCols: number;
  private targetRows: number;
  private modelCols: number;
  private modelRows: number;
  private readonly tail: TailEntry[] = [];
  private tailBytes = 0;
  private bytesSinceSnapshot = 0;
  private readonly operations: RestoreOperation[] = [];
  private writing = false;
  private pendingResizes = 0;
  private failure?: Exclude<PtySemanticRestoreFailure, 'resize-pending'>;
  private gapAfterEpoch?: number;
  private disposed = false;

  constructor(cols: number, rows: number, options: PtySemanticRestoreOptions = {}) {
    this.targetCols = positiveInteger(cols, 80);
    this.targetRows = positiveInteger(rows, 24);
    this.snapshotCols = this.targetCols;
    this.snapshotRows = this.targetRows;
    this.modelCols = this.targetCols;
    this.modelRows = this.targetRows;
    this.serializeScrollback = positiveInteger(
      options.scrollbackLines,
      PTY_SEMANTIC_SCROLLBACK_LINES,
    );
    this.maxSnapshotBytes = positiveInteger(
      options.maxSnapshotBytes,
      PTY_SEMANTIC_SNAPSHOT_BYTES,
    );
    this.maxTailBytes = positiveInteger(options.maxTailBytes, PTY_SEMANTIC_TAIL_BYTES);
    this.snapshotIntervalBytes = positiveInteger(
      options.snapshotIntervalBytes,
      PTY_SEMANTIC_SNAPSHOT_INTERVAL_BYTES,
    );
    this.maxPendingOperations = positiveInteger(
      options.maxPendingOperations,
      PTY_SEMANTIC_PENDING_OPS,
    );

    try {
      const model = (options.createModel ?? createXtermModel)(
        this.targetCols,
        this.targetRows,
        this.serializeScrollback,
      );
      this.terminal = model.terminal;
      this.serializer = model.serializer;
    } catch {
      this.failure = 'serializer-failed';
      this.gapAfterEpoch = 0;
    }
  }

  /** Mirror one PTY output chunk. Bytes are copied because node-pty owns the source buffer. */
  feed(data: Uint8Array): void {
    if (this.disposed || data.byteLength === 0) return;
    const entry: TailEntry = {
      epoch: ++this.streamEpoch,
      data: Uint8Array.from(data),
    };
    if (this.failure) return;

    this.tail.push(entry);
    this.tailBytes += entry.data.byteLength;
    if (this.tailBytes > this.maxTailBytes) {
      this.fail('semantic-gap', this.snapshotEpoch);
      return;
    }
    if (!this.enqueue({ kind: 'write', entry })) return;
    this.pump();
  }

  /** Queue a grid change in the same ordering domain as output writes. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.targetCols = positiveInteger(cols, this.targetCols);
    this.targetRows = positiveInteger(rows, this.targetRows);
    if (this.failure) return;
    this.pendingResizes += 1;
    if (!this.enqueue({ kind: 'resize', cols: this.targetCols, rows: this.targetRows })) {
      this.pendingResizes = Math.max(0, this.pendingResizes - 1);
      return;
    }
    this.pump();
  }

  /** Capture a stable snapshot followed by every exact output epoch after it. */
  capture(): PtySemanticRestoreCapture {
    const replayEpoch = this.streamEpoch;
    if (this.failure) return this.fallback(this.failure, replayEpoch);
    if (this.pendingResizes > 0) return this.fallback('resize-pending', replayEpoch);

    let expectedEpoch = this.snapshotEpoch + 1;
    for (const entry of this.tail) {
      if (entry.epoch !== expectedEpoch) {
        this.fail('semantic-gap', expectedEpoch - 1);
        return this.fallback('semantic-gap', replayEpoch);
      }
      expectedEpoch += 1;
    }
    if (expectedEpoch - 1 !== replayEpoch) {
      this.fail('semantic-gap', expectedEpoch - 1);
      return this.fallback('semantic-gap', replayEpoch);
    }

    return {
      mode: 'semantic',
      snapshot: this.snapshot,
      tail: this.tail.map((entry) => entry.data),
      snapshotEpoch: this.snapshotEpoch,
      replayEpoch,
      tailBytes: this.tailBytes,
      cols: this.snapshotCols,
      rows: this.snapshotRows,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.operations.length = 0;
    this.tail.length = 0;
    this.tailBytes = 0;
    try {
      this.terminal?.dispose();
    } catch {
      // The semantic model is best-effort and must never affect PTY teardown.
    }
  }

  private enqueue(operation: RestoreOperation): boolean {
    const pending = this.operations.length + (this.writing ? 1 : 0);
    if (pending >= this.maxPendingOperations) {
      this.fail('semantic-gap', this.committedEpoch);
      return false;
    }
    this.operations.push(operation);
    return true;
  }

  private pump(): void {
    if (this.disposed || this.failure || this.writing) return;
    const operation = this.operations.shift();
    if (!operation) return;
    const terminal = this.terminal;
    if (!terminal) {
      this.fail('serializer-failed', this.committedEpoch);
      return;
    }

    if (operation.kind === 'resize') {
      this.pendingResizes = Math.max(0, this.pendingResizes - 1);
      try {
        terminal.resize(operation.cols, operation.rows);
        this.modelCols = operation.cols;
        this.modelRows = operation.rows;
        this.captureSnapshot();
      } catch {
        this.fail('serializer-failed', this.committedEpoch);
      }
      this.pump();
      return;
    }

    this.writing = true;
    try {
      terminal.write(operation.entry.data, () => {
        if (this.disposed) return;
        this.writing = false;
        this.committedEpoch = operation.entry.epoch;
        this.bytesSinceSnapshot += operation.entry.data.byteLength;
        if (this.bytesSinceSnapshot >= this.snapshotIntervalBytes) this.captureSnapshot();
        this.pump();
      });
    } catch {
      this.writing = false;
      this.fail('serializer-failed', this.committedEpoch);
    }
  }

  private captureSnapshot(): void {
    if (this.failure || this.disposed || !this.serializer) return;
    try {
      let scrollback = this.serializeScrollback;
      while (scrollback > 0) {
        const encoded = encoder.encode(this.serializer.serialize({ scrollback }));
        if (encoded.byteLength <= this.maxSnapshotBytes) {
          this.commitSnapshot(encoded, scrollback);
          return;
        }
        scrollback = scrollback === 1 ? 0 : Math.floor(scrollback / 2);
      }
      const viewport = encoder.encode(this.serializer.serialize({ scrollback: 0 }));
      if (viewport.byteLength <= this.maxSnapshotBytes) {
        this.commitSnapshot(viewport, 0);
        return;
      }
      this.fail('snapshot-too-large', this.committedEpoch);
    } catch {
      this.fail('serializer-failed', this.committedEpoch);
    }
  }

  private commitSnapshot(encoded: Uint8Array, scrollback: number): void {
    this.snapshot = encoded;
    this.snapshotEpoch = this.committedEpoch;
    this.snapshotCols = this.modelCols;
    this.snapshotRows = this.modelRows;
    this.serializeScrollback = scrollback;
    this.bytesSinceSnapshot = 0;
    this.dropTailThrough(this.snapshotEpoch);
  }

  private dropTailThrough(epoch: number): void {
    while (this.tail.length > 0 && this.tail[0].epoch <= epoch) {
      const removed = this.tail.shift();
      if (removed) this.tailBytes -= removed.data.byteLength;
    }
  }

  private fail(
    reason: Exclude<PtySemanticRestoreFailure, 'resize-pending'>,
    gapAfterEpoch: number,
  ): void {
    if (!this.failure) {
      this.failure = reason;
      this.gapAfterEpoch = gapAfterEpoch;
    }
    this.operations.length = 0;
    this.tail.length = 0;
    this.tailBytes = 0;
    this.pendingResizes = 0;
  }

  private fallback(
    reason: PtySemanticRestoreFailure,
    replayEpoch: number,
  ): PtySemanticRestoreFallback {
    return {
      mode: 'fallback',
      reason,
      snapshotEpoch: this.snapshotEpoch,
      replayEpoch,
      ...(this.gapAfterEpoch === undefined ? {} : { gapAfterEpoch: this.gapAfterEpoch }),
    };
  }
}
