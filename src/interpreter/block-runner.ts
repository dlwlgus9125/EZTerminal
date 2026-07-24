/**
 * Block runner — drives one block's PipelineData under the credit/window
 * protocol (architecture §3). Extracted from the Electron seam so it is testable
 * with a plain `emit` function (no MessagePortMain required).
 *
 * Responsibilities:
 *   - Emit `schema` once (declared columns when known, else inferred from row 0).
 *   - Buffer rows into a {@link ResultStore} as they are pulled, emitting running
 *     `progress {count, done}` so the renderer learns the table height — WITHOUT
 *     sending the rows themselves.
 *   - Answer `requestRows`/`setViewport` controls with `chunk {start, rows}`
 *     slices, never sending beyond the granted window.
 *   - Keep serving windows after the source is exhausted (the store persists) so
 *     the renderer can page/scroll freely; release on `dispose`.
 *
 * Cancellation is via the shared AbortSignal owned by the session; abort makes
 * the drain stop and emits `cancelled`.
 */

import type { ColumnInfo, InterpreterFrame, JsonValue, ResultRow } from '../shared/ipc';
import {
  recordToJson,
  toRowIterable,
  valueToJson,
  type PipelineData,
  type RecordValue,
} from './core';
import { AnsiHtmlStream } from './external/ansi';
import {
  ResultStore,
  type ResultStoreFileSystem,
} from './result-store';

/**
 * Rows pulled per structured-output drain step before yielding/reporting.
 * At retained-store throughput this remains well inside the cancellation
 * budget, while avoiding 20 utility→renderer progress turns for 100k rows.
 */
const DRAIN_BATCH = 50_000;
/** Yield CPU-bound/immediately-resolved row sources back to controls promptly. */
// Keep the utility-process macrotask queue responsive enough for renderer
// cancellation even when a fused mapper can drain 50k rows faster than the
// progress interval. The release p95 gate is relative to the checkpoint path,
// so keep this bound below one 60 Hz frame.
const STRUCTURED_DRAIN_SLICE_MS = 8;
/** Avoid turning time slicing into a progress-frame/IPC flood for slow streams. */
const STRUCTURED_PROGRESS_INTERVAL_MS = 250;
/** Amortize clock reads while keeping CPU-heavy row transforms bounded. */
const DRAIN_CLOCK_CHECK_ROWS = 8;
/**
 * Byte streams (external text) trickle one decoded chunk at a time and want to
 * display incrementally — batching 5000 would stall a slow/forever stream for a
 * long time before any `progress` is reported. One chunk per step keeps external
 * output live; the chunk count is small (one per stdout flush, not per char).
 */
const BYTE_DRAIN_BATCH = 1;
/** Extra rows buffered past a viewport so the next scroll is instant. */
const VIEWPORT_READ_AHEAD = 200;
/** Retry transient Windows sharing/antivirus failures without releasing quota early. */
const STORE_DISPOSE_RETRY_DELAYS_MS = [25, 100, 400] as const;

export type Emit = (frame: InterpreterFrame) => void;

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Yield to the macrotask queue so controls (requestRows/cancel) interleave the drain. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Best-effort column inference from a JSON row when the pipeline declared none. */
function inferColumnsFromRow(row: ResultRow | undefined): ColumnInfo[] {
  if (!row) return [];
  return Object.entries(row).map(([name, value]) => ({ name, type: jsonKind(value) }));
}

function jsonKind(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'table';
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'record';
    default:
      return 'string';
  }
}

export interface BlockHandle {
  /** Handle a window request (`requestRows`/`setViewport`). */
  handleControl(control: { type: 'requestRows' | 'setViewport'; start: number; count: number }): void;
  /** Stop filling, release the source. Idempotent. */
  dispose(): Promise<void>;
  /** Resolves when the drain has reached a terminal frame (end/error/cancelled). */
  readonly done: Promise<void>;
}

export interface RunBlockOptions {
  /** Narrow storage seam used to exercise physical cleanup failures. */
  readonly retentionFileSystem?: Partial<ResultStoreFileSystem>;
  /** Test seam; production uses the bounded backoff above. */
  readonly disposeRetryDelaysMs?: readonly number[];
  /** Test seam for deterministic macrotask-yield coverage. */
  readonly structuredDrainSliceMs?: number;
}

/**
 * Run a block: emit schema, fill the store + emit progress, and serve windows.
 * Returns a handle the caller wires to the control channel and disposes on close.
 */
export function runBlock(
  data: PipelineData,
  emit: Emit,
  signal: AbortSignal,
  options: RunBlockOptions = {},
): BlockHandle {
  const isByteStream = data.kind === 'byte-stream';
  const isScalar =
    data.kind === 'value' && data.value.kind !== 'table' && data.value.kind !== 'record';
  const structuredDrainSliceMs = Math.max(
    0,
    options.structuredDrainSliceMs ?? STRUCTURED_DRAIN_SLICE_MS,
  );

  // Declared columns + render shape. Scalars and external (byte-stream) output
  // render as a single-column `text` block; structured rows render as a table.
  let columns: readonly ColumnInfo[] | undefined = data.meta?.columns;
  const shape: 'table' | 'text' = isScalar || isByteStream ? 'text' : 'table';

  // The store's source: scalars become a single `{ value }` row; byte streams
  // become `{ value: <html> }` rows (ANSI → sanitized HTML, one row per decoded
  // chunk); structured input is the row stream serialized to wire (JSON) rows.
  type SourceRow = ResultRow | RecordValue;
  const structured = !isByteStream && !isScalar;
  const store = new ResultStore<SourceRow>(makeRowIterator(), {
    mapRow: structured
      ? (row) => recordToJson(row as RecordValue)
      : (row) => row as ResultRow,
    // The store also serves renderer window reads. A stop check at the producer
    // boundary prevents either a 50k background target or a 10k read-ahead
    // target from consuming a slow async source after cancellation.
    shouldStopPull: () => signal.aborted,
    fileSystem: options.retentionFileSystem,
  });

  function makeRowIterator(): AsyncIterator<SourceRow> {
    if (isByteStream) {
      // `html` marks the column so the text block injects it as HTML, not text.
      columns = [{ name: 'value', type: 'html' }];
      const bytes = (data as Extract<PipelineData, { kind: 'byte-stream' }>).bytes;
      const ansi = new AnsiHtmlStream();
      const rows = async function* (): AsyncGenerator<ResultRow> {
        for await (const chunk of bytes) {
          const html = ansi.push(chunk);
          if (html) yield { value: html };
        }
        // Flush a trailing fragment the streaming decoder was still holding.
        const tail = ansi.flush();
        if (tail) yield { value: tail };
      };
      return rows();
    }
    if (isScalar) {
      const value = (data as Extract<PipelineData, { kind: 'value' }>).value;
      columns = [{ name: 'value', type: value.kind }];
      const one = async function* (): AsyncGenerator<ResultRow> {
        yield { value: valueToJson(value) };
      };
      return one();
    }
    return toRowIterable(data)[Symbol.asyncIterator]();
  }

  // `disposed` is set ONLY by an external dispose()/close — never by the drain.
  // After the source is exhausted the store keeps its buffered rows so the
  // renderer can still page/scroll; serving must stay enabled until teardown.
  let disposed = false;
  let dataCleanupPromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;

  function runDataCleanup(): Promise<void> {
    dataCleanupPromise ??= Promise.resolve().then(async () => {
      await data.cleanup?.();
    });
    return dataCleanupPromise;
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    const operation = disposeBlock();
    disposePromise = operation;
    void operation.catch(() => {
      if (disposePromise === operation) disposePromise = null;
    });
    return operation;
  }

  async function disposeStoreWithRetry(): Promise<void> {
    const delays = options.disposeRetryDelaysMs ?? STORE_DISPOSE_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await store.dispose();
        return;
      } catch (error) {
        if (attempt >= delays.length) throw error;
        const delayMs = Math.max(0, delays[attempt] ?? 0);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  async function disposeBlock(): Promise<void> {
    disposed = true;
    // Cleanup may be what unblocks a pending iterator.next(), while store
    // disposal owns quota/file release. Start both and observe every failure so
    // one rejected cleanup never prevents the other from running.
    const results = await Promise.allSettled([
      runDataCleanup(),
      disposeStoreWithRetry(),
    ]);
    const failures = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple structured-output cleanup operations failed');
    }
  }

  // Some stream adapters release a blocked iterator.next() from their cleanup
  // hook. Cancellation must start that cleanup immediately; waiting for drive's
  // finally block would deadlock because drive cannot reach finally until the
  // pending next() settles. The shared promise keeps cleanup single-shot and the
  // rejection handler prevents an abort event from creating an unhandled promise.
  const interruptPendingRead = (): void => {
    void runDataCleanup().catch(() => undefined);
  };
  if (signal.aborted) interruptPendingRead();
  else signal.addEventListener('abort', interruptPendingRead, { once: true });

  async function drive(): Promise<void> {
    let schemaEmitted = false;
    try {
      // Schema must precede chunks; infer from row 0 only if undeclared.
      if (!columns) {
        await store.ensure(1);
        columns = inferColumnsFromRow(store.at(0));
      }
      emit({ type: 'schema', columns, shape });
      schemaEmitted = true;
      emit({ type: 'progress', count: store.count, done: store.exhausted });

      // Background drain: fill the (Node-side) store to discover the total and
      // report it via progress. No rows cross IPC here — only counts. Byte
      // streams drain one chunk at a time so external text appears incrementally.
      const drainBatch = isByteStream ? BYTE_DRAIN_BATCH : DRAIN_BATCH;
      let drainTarget = Math.min(Number.MAX_SAFE_INTEGER, store.count + drainBatch);
      let lastProgressAt = performance.now();
      while (!disposed && !signal.aborted && !store.exhausted) {
        const sliceDeadline = performance.now() + structuredDrainSliceMs;
        let rowsUntilClockCheck = 0;
        await store.ensure(
          drainTarget,
          isByteStream
            ? undefined
            : () => {
                if (rowsUntilClockCheck > 0) {
                  rowsUntilClockCheck -= 1;
                  return false;
                }
                rowsUntilClockCheck = DRAIN_CLOCK_CHECK_ROWS - 1;
                return performance.now() >= sliceDeadline;
              },
        );

        const now = performance.now();
        const reachedTarget = store.count >= drainTarget;
        if (
          isByteStream
          || reachedTarget
          || store.exhausted
          || now - lastProgressAt >= STRUCTURED_PROGRESS_INTERVAL_MS
        ) {
          emit({ type: 'progress', count: store.count, done: store.exhausted });
          lastProgressAt = now;
        }
        if (reachedTarget) {
          drainTarget = Math.min(Number.MAX_SAFE_INTEGER, store.count + drainBatch);
        }
        await yieldToEventLoop();
      }

      if (disposed) return;
      if (signal.aborted) {
        emit({ type: 'progress', count: store.count, done: true });
        emit({ type: 'cancelled' });
        return;
      }
      emit({ type: 'progress', count: store.count, done: true });
      emit({ type: 'end' });
    } catch (err) {
      if (disposed) return;
      // The progress throttle may not have published rows retained immediately
      // before cancellation/error. Commit the final count before every terminal
      // frame so the renderer never hides valid partial output.
      if (schemaEmitted) emit({ type: 'progress', count: store.count, done: true });
      if (signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        emit({ type: 'error', message: describeError(err) });
      }
    } finally {
      signal.removeEventListener('abort', interruptPendingRead);
      // Release only the underlying source (iterator + pipeline cleanup). The
      // store's buffered rows stay servable so the renderer can keep paging after
      // `end`; the block is torn down only by an explicit dispose()/close.
      await store.stopSource().catch(() => undefined);
      await runDataCleanup().catch(() => undefined);
    }
  }

  async function serveWindow(start: number, count: number, readAhead: number): Promise<void> {
    try {
      await store.forEachWindowChunk(start, count, readAhead, (window) => {
        if (disposed) return;
        emit({ type: 'chunk', start: window.start, rows: window.rows });
      });
    } catch (err) {
      if (!disposed && !signal.aborted) emit({ type: 'error', message: describeError(err) });
    }
  }

  const done = drive();

  return {
    handleControl(control): void {
      if (disposed) return;
      const readAhead = control.type === 'setViewport' ? VIEWPORT_READ_AHEAD : 0;
      void serveWindow(control.start, control.count, readAhead);
    },
    dispose(): Promise<void> {
      return dispose();
    },
    done,
  };
}
