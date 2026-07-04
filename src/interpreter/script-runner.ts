/**
 * Script-session runner — the `run-script` (E4) analogue of {@link runPtySession}.
 *
 * A `script-stream` is not a row/byte source in itself: it names a script file
 * to run in a SEPARATE script-host utilityProcess (main-forked, C1/C2 — the
 * interpreter cannot fork one itself). This driver:
 *   - asks the caller-supplied {@link SpawnHost} to stand one up (a broker
 *     round-trip through main under the hood, abstracted away so this module
 *     never touches Electron and is testable with a fake {@link HostChannel},
 *     mirroring pty-session.ts's fake {@link import('./core').PtyHandle}),
 *   - serially answers the host's `ez.run(...)` requests by running
 *     `evaluate(parse(cmd), ctx)` INLINE against the same session `ctx` (C3 —
 *     shares cwd/env/vars + inherits the cancellation signal, no nested
 *     foreground run / no deadlock), enforcing the 100k-row cap incrementally
 *     (B4 — the cap only fails THAT ez.run call, not the whole script),
 *   - accumulates `script-print` (stdout+stderr, merged) up to a combined 8MB
 *     cap (B4 — exceeding it is fatal: kill the host + hard error),
 *   - and on `script-done`/`script-error`, kills the host (one-shot: one run =
 *     one host) and either hands the resolved rows/text to the ordinary
 *     {@link runBlock} (reusing its schema/paging machinery — v1 has no live
 *     row streaming, the script runs to completion before anything renders)
 *     or emits `error`/`cancelled` directly.
 *
 * Cancellation (B2): EVERY wait — the spawn round-trip, each in-flight ez.run —
 * races against `signal`/the host closing, via the one-shot `settled` guard
 * below (same shape as pty-session's). A spawn that resolves AFTER we already
 * settled is killed on arrival instead of leaking a zombie utilityProcess.
 */

import type { ResultRow } from '../shared/ipc';
import { describeError, runBlock, type BlockHandle, type Emit } from './block-runner';
import {
  EvalError,
  boolValue,
  evaluate,
  nullValue,
  numberValue,
  parse,
  recordToJson,
  recordValue,
  stringValue,
  toRowIterable,
  valueData,
  valueToJson,
  listStreamData,
} from './core';
import type { EvalContext, JsonRecord, JsonValue, PipelineData, RecordValue, RuntimeValue, ScriptStreamData } from './core';

/** Rows collected from a single `ez.run()` beyond this are rejected (design §6, B4). */
export const EZ_RUN_ROWS_CAP = 100_000;
/** Combined stdout+stderr text beyond this kills the host (design §6, B4). */
export const SCRIPT_PRINT_CAP_BYTES = 8 * 1024 * 1024;

// ── host RPC protocol (interpreter <-> script-host, over a dedicated port) ───────

export interface EzRunRequestMsg {
  readonly type: 'ez-run';
  readonly id: string;
  readonly command: string;
}
export interface ScriptPrintMsg {
  readonly type: 'script-print';
  readonly text: string;
}
export interface ScriptDoneMsg {
  /** Present + JSON-cloneable array-of-objects = table path; absent = text path (collected script-print). */
  readonly type: 'script-done';
  readonly rows?: readonly ResultRow[];
}
export interface ScriptErrorMsg {
  readonly type: 'script-error';
  readonly message: string;
}
export type HostToInterpreterMsg = EzRunRequestMsg | ScriptPrintMsg | ScriptDoneMsg | ScriptErrorMsg;

export interface EzRunResultMsg {
  readonly type: 'ez-run-result';
  readonly id: string;
  readonly rows?: readonly ResultRow[];
  readonly error?: string;
}
export type InterpreterToHostMsg = EzRunResultMsg;

/**
 * The RPC channel to a live script-host, abstracted so this module never
 * touches `MessagePortMain` directly — production wraps a real port
 * (interpreter-process.ts), tests use a fake (mirrors pty-session.test.ts's
 * fake PtyHandle).
 */
export interface HostChannel {
  onMessage(listener: (msg: HostToInterpreterMsg) => void): void;
  /** Fires ONCE when the host is gone — port closed or the utilityProcess exited. */
  onClosed(listener: () => void): void;
  postMessage(msg: InterpreterToHostMsg): void;
  /** Ask the broker to kill the host. Idempotent; safe to call after close. */
  kill(): void;
}

/** Spawn a script-host for one `run-script` invocation; rejects on broker/spawn failure. */
export type SpawnHost = (
  scriptPath: string,
  args: readonly string[],
  cwd: string,
) => Promise<HostChannel>;

export interface ScriptSession {
  /** Route a paging control to the post-completion table/text block, once one exists. */
  handleControl(control: { type: 'requestRows' | 'setViewport'; start: number; count: number }): void;
  /** Tear down: kill the host / dispose the block if still running. Idempotent. */
  dispose(): void;
}

// ── JSON (wire) -> RuntimeValue, for feeding script-done rows through runBlock ────

function jsonToRuntimeValue(value: JsonValue): RuntimeValue {
  if (value === null) return nullValue;
  if (typeof value === 'boolean') return boolValue(value);
  if (typeof value === 'number') return numberValue(value);
  if (typeof value === 'string') return stringValue(value);
  if (Array.isArray(value)) {
    // v1 has no "array of scalars" RuntimeValue kind; a plain-object array
    // becomes a nested table, anything else is preserved as a JSON string.
    if (value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      return { kind: 'table', rows: value.map((v) => jsonRowToRecord(v as JsonRecord)) };
    }
    return stringValue(JSON.stringify(value));
  }
  return jsonRowToRecord(value as JsonRecord);
}

function jsonRowToRecord(row: JsonRecord): RecordValue {
  const fields: Record<string, RuntimeValue> = {};
  for (const [key, val] of Object.entries(row)) fields[key] = jsonToRuntimeValue(val);
  return recordValue(fields);
}

function jsonRowsToRecords(rows: readonly ResultRow[]): AsyncIterable<RecordValue> {
  return (async function* (): AsyncGenerator<RecordValue> {
    for (const row of rows) yield jsonRowToRecord(row);
  })();
}

// ── the runner ────────────────────────────────────────────────────────────────

export function runScriptSession(
  data: ScriptStreamData,
  ctx: EvalContext,
  emit: Emit,
  signal: AbortSignal,
  spawnHost: SpawnHost,
): ScriptSession {
  let settled = false;
  let channel: HostChannel | null = null;
  let blockHandle: BlockHandle | null = null;
  let printBytes = 0;
  const printChunks: string[] = [];
  // ez.run serialization (B3): a FIFO chain so at most one inline evaluate runs
  // at a time even if the script fires concurrent (unawaited) ez.run() calls.
  let queue: Promise<void> = Promise.resolve();

  function settleCancelled(): void {
    if (settled) return;
    settled = true;
    channel?.kill();
    emit({ type: 'cancelled' });
  }

  function settleError(message: string): void {
    if (settled) return;
    settled = true;
    channel?.kill();
    emit({ type: 'error', message });
  }

  function settleDone(rows: readonly ResultRow[] | undefined): void {
    if (settled) return;
    settled = true;
    channel?.kill();
    const finalData: PipelineData = rows
      ? listStreamData(jsonRowsToRecords(rows))
      : valueData(stringValue(printChunks.join('')));
    blockHandle = runBlock(finalData, emit, signal);
  }

  async function collectRows(result: PipelineData): Promise<ResultRow[]> {
    const rows: ResultRow[] = [];
    for await (const record of toRowIterable(result)) {
      signal.throwIfAborted();
      if (rows.length >= EZ_RUN_ROWS_CAP) {
        throw new EvalError(`ez.run: result exceeds the ${EZ_RUN_ROWS_CAP.toLocaleString()}-row cap`);
      }
      rows.push(recordToJson(record));
    }
    return rows;
  }

  async function processEzRun(ch: HostChannel, msg: EzRunRequestMsg): Promise<void> {
    if (settled) return; // the session ended while this request sat in the queue
    try {
      signal.throwIfAborted();
      const statement = parse(msg.command);
      const result = evaluate(statement, ctx);
      let rows: ResultRow[];
      switch (result.kind) {
        case 'list-stream':
          rows = await collectRows(result);
          break;
        case 'value':
          rows =
            result.value.kind === 'table' || result.value.kind === 'record'
              ? await collectRows(result)
              : [{ value: valueToJson(result.value) }];
          break;
        case 'pty-stream':
          throw new EvalError("ez.run: '!' interactive commands are not supported");
        case 'byte-stream':
          throw new EvalError('ez.run: external (byte-stream) commands are not supported as rows');
        case 'script-stream':
          throw new EvalError('ez.run: nested run-script is not supported');
        case 'ssh-stream':
          throw new EvalError("ez.run: 'ssh-connect' sessions are not supported as rows");
      }
      if (!settled) ch.postMessage({ type: 'ez-run-result', id: msg.id, rows });
    } catch (err) {
      if (!settled) ch.postMessage({ type: 'ez-run-result', id: msg.id, error: describeError(err) });
    }
  }

  function appendPrint(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (printBytes + bytes > SCRIPT_PRINT_CAP_BYTES) {
      settleError(
        `run-script: combined stdout/stderr exceeded the ${(SCRIPT_PRINT_CAP_BYTES / (1024 * 1024)).toFixed(0)}MB cap`,
      );
      return;
    }
    printBytes += bytes;
    printChunks.push(text);
  }

  function wireChannel(ch: HostChannel): void {
    channel = ch;
    ch.onClosed(() => {
      if (settled) return;
      settleError('run-script: script host exited unexpectedly');
    });
    ch.onMessage((msg) => {
      if (settled) return;
      switch (msg.type) {
        case 'ez-run':
          queue = queue.then(() => processEzRun(ch, msg));
          break;
        case 'script-print':
          appendPrint(msg.text);
          break;
        case 'script-done':
          settleDone(msg.rows);
          break;
        case 'script-error':
          settleError(msg.message);
          break;
      }
    });
  }

  function start(): void {
    const spawnPromise = spawnHost(data.scriptPath, data.args, ctx.cwd);
    // Always attach this — if we settle (e.g. abort) before the spawn resolves,
    // the eventually-spawned host must still be killed, not leaked (B2).
    spawnPromise.then(
      (ch) => {
        if (settled) ch.kill();
        else wireChannel(ch);
      },
      (err: unknown) => {
        if (!settled) settleError(`run-script: failed to start script host: ${describeError(err)}`);
      },
    );
  }

  if (signal.aborted) {
    settleCancelled();
  } else {
    start();
    signal.addEventListener('abort', () => settleCancelled(), { once: true });
  }

  return {
    handleControl(control): void {
      blockHandle?.handleControl(control);
    },
    dispose(): void {
      if (settled) {
        void blockHandle?.dispose();
        return;
      }
      settled = true;
      channel?.kill();
    },
  };
}
