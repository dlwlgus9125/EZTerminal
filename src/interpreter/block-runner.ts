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
import { recordToJson, toRowIterable, valueToJson, type PipelineData } from './core';
import { AnsiHtmlStream } from './external/ansi';
import { ResultStore } from './result-store';

/** Rows pulled per background-drain step before yielding + reporting progress. */
const DRAIN_BATCH = 5_000;
/**
 * Byte streams (external text) trickle one decoded chunk at a time and want to
 * display incrementally — batching 5000 would stall a slow/forever stream for a
 * long time before any `progress` is reported. One chunk per step keeps external
 * output live; the chunk count is small (one per stdout flush, not per char).
 */
const BYTE_DRAIN_BATCH = 1;
/** Extra rows buffered past a viewport so the next scroll is instant. */
const VIEWPORT_READ_AHEAD = 200;

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

/**
 * Run a block: emit schema, fill the store + emit progress, and serve windows.
 * Returns a handle the caller wires to the control channel and disposes on close.
 */
export function runBlock(data: PipelineData, emit: Emit, signal: AbortSignal): BlockHandle {
  const isByteStream = data.kind === 'byte-stream';
  const isScalar =
    data.kind === 'value' && data.value.kind !== 'table' && data.value.kind !== 'record';

  // Declared columns + render shape. Scalars and external (byte-stream) output
  // render as a single-column `text` block; structured rows render as a table.
  let columns: readonly ColumnInfo[] | undefined = data.meta?.columns;
  const shape: 'table' | 'text' = isScalar || isByteStream ? 'text' : 'table';

  // The store's source: scalars become a single `{ value }` row; byte streams
  // become `{ value: <html> }` rows (ANSI → sanitized HTML, one row per decoded
  // chunk); structured input is the row stream serialized to wire (JSON) rows.
  const store = new ResultStore(makeRowIterator());

  function makeRowIterator(): AsyncIterator<ResultRow> {
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
    const source = toRowIterable(data);
    const rows = async function* (): AsyncGenerator<ResultRow> {
      for await (const record of source) yield recordToJson(record);
    };
    return rows();
  }

  // `disposed` is set ONLY by an external dispose()/close — never by the drain.
  // After the source is exhausted the store keeps its buffered rows so the
  // renderer can still page/scroll; serving must stay enabled until teardown.
  let disposed = false;
  let dataCleaned = false;

  async function runDataCleanup(): Promise<void> {
    if (dataCleaned) return;
    dataCleaned = true;
    await data.cleanup?.();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await store.dispose();
    await runDataCleanup();
  }

  async function drive(): Promise<void> {
    try {
      // Schema must precede chunks; infer from row 0 only if undeclared.
      if (!columns) {
        await store.ensure(1);
        columns = inferColumnsFromRow(store.at(0));
      }
      emit({ type: 'schema', columns, shape });
      emit({ type: 'progress', count: store.count, done: store.exhausted });

      // Background drain: fill the (Node-side) store to discover the total and
      // report it via progress. No rows cross IPC here — only counts. Byte
      // streams drain one chunk at a time so external text appears incrementally.
      const drainBatch = isByteStream ? BYTE_DRAIN_BATCH : DRAIN_BATCH;
      while (!disposed && !signal.aborted && !store.exhausted) {
        await store.ensure(store.count + drainBatch);
        emit({ type: 'progress', count: store.count, done: store.exhausted });
        await yieldToEventLoop();
      }

      if (disposed) return;
      if (signal.aborted) {
        emit({ type: 'cancelled' });
        return;
      }
      emit({ type: 'progress', count: store.count, done: true });
      emit({ type: 'end' });
    } catch (err) {
      if (disposed) return;
      if (signal.aborted) emit({ type: 'cancelled' });
      else emit({ type: 'error', message: describeError(err) });
    } finally {
      // Release only the underlying source (iterator + pipeline cleanup). The
      // store's buffered rows stay servable so the renderer can keep paging after
      // `end`; the block is torn down only by an explicit dispose()/close.
      await store.dispose().catch(() => undefined);
      await runDataCleanup().catch(() => undefined);
    }
  }

  async function serveWindow(start: number, count: number, readAhead: number): Promise<void> {
    try {
      const window = await store.getWindow(start, count, readAhead);
      if (disposed) return;
      emit({ type: 'chunk', start: window.start, rows: window.rows });
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
