/**
 * Value model + PipelineData (architecture §4 / §5).
 *
 * Runtime values are a *discriminated* union (a `kind` tag), never a loose
 * union — every consumer switches on `kind`. The minimal Phase-1 vocabulary is:
 *   null | bool | number | string | filesize | datetime | record | table
 * where `table` is a materialized list of records.
 *
 * PipelineData is the unit that flows command -> command:
 *   - `value`       — a fully materialized RuntimeValue
 *   - `list-stream` — an AsyncIterable<RecordValue> (lazy structured rows)
 *   - `byte-stream` — an AsyncIterable<Uint8Array> (external / IO / text edge)
 * Each carries optional column metadata + an optional cleanup hook.
 *
 * Filesize literals (`100mb`, `1.5gb`) are parsed here and compared by byte
 * count. Phase-1 uses 1024-based multipliers (kb = 1024, mb = 1024^2, ...).
 */

import type { SshForwardAction } from '../../shared/ssh-forward';
import { EvalError } from './errors';

// ── JSON wire shape (what gets serialized into chunk frames) ───────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

/** Column metadata: a name + the value `kind` of that column. */
export interface ColumnSchema {
  readonly name: string;
  readonly type: ValueKind;
}

// ── Runtime values (discriminated union) ───────────────────────────────────────

export type ValueKind =
  | 'null'
  | 'bool'
  | 'number'
  | 'string'
  | 'filesize'
  | 'datetime'
  | 'record'
  | 'table';

export interface NullValue {
  readonly kind: 'null';
}
export interface BoolValue {
  readonly kind: 'bool';
  readonly value: boolean;
}
export interface NumberValue {
  readonly kind: 'number';
  readonly value: number;
}
export interface StringValue {
  readonly kind: 'string';
  readonly value: string;
}
/** A byte count with filesize semantics (sortable / comparable by bytes). */
export interface FilesizeValue {
  readonly kind: 'filesize';
  readonly bytes: number;
}
export interface DatetimeValue {
  readonly kind: 'datetime';
  readonly epochMs: number;
}
export interface RecordValue {
  readonly kind: 'record';
  /** Insertion order defines column order. */
  readonly fields: Record<string, RuntimeValue>;
}
export interface TableValue {
  readonly kind: 'table';
  readonly rows: RecordValue[];
}

export type ScalarValue =
  | NullValue
  | BoolValue
  | NumberValue
  | StringValue
  | FilesizeValue
  | DatetimeValue;

export type RuntimeValue = ScalarValue | RecordValue | TableValue;

// ── Constructors ───────────────────────────────────────────────────────────────

export const nullValue: NullValue = { kind: 'null' };
export const boolValue = (value: boolean): BoolValue => ({ kind: 'bool', value });
export const numberValue = (value: number): NumberValue => ({ kind: 'number', value });
export const stringValue = (value: string): StringValue => ({ kind: 'string', value });
export const filesizeValue = (bytes: number): FilesizeValue => ({ kind: 'filesize', bytes });
export const datetimeValue = (epochMs: number): DatetimeValue => ({ kind: 'datetime', epochMs });
export const recordValue = (fields: Record<string, RuntimeValue>): RecordValue => ({
  kind: 'record',
  fields,
});

// ── Filesize literal parsing + units ───────────────────────────────────────────

const FILESIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
  // explicit binary aliases (same 1024-based values in Phase 1)
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export const FILESIZE_UNIT_PATTERN = 'b|kb|mb|gb|tb|pb|kib|mib|gib|tib';

/** True when `unit` (case-insensitive) is a known filesize unit. */
export function isFilesizeUnit(unit: string): boolean {
  return unit.toLowerCase() in FILESIZE_UNITS;
}

/**
 * Parse a filesize literal like `100mb` or `1.5gb` into a byte count.
 * Returns null when the text is not a valid filesize literal.
 */
export function parseFilesize(text: string): number | null {
  const match = text.match(
    new RegExp(`^([0-9]+(?:\\.[0-9]+)?)(${FILESIZE_UNIT_PATTERN})$`, 'i'),
  );
  if (!match) return null;
  const magnitude = Number.parseFloat(match[1]);
  const factor = FILESIZE_UNITS[match[2].toLowerCase()];
  return Math.round(magnitude * factor);
}

/** Compute bytes for an already-split number + unit (used by the lexer). */
export function filesizeBytes(magnitude: number, unit: string): number {
  const factor = FILESIZE_UNITS[unit.toLowerCase()];
  if (factor === undefined) {
    throw new EvalError(`unknown size unit: ${unit}`);
  }
  return Math.round(magnitude * factor);
}

// ── Comparison (for `where` predicates) ────────────────────────────────────────

export type ComparisonOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

/** Numeric magnitude of an orderable scalar, or null if not orderable. */
function orderableMagnitude(value: RuntimeValue): number | null {
  switch (value.kind) {
    case 'number':
      return value.value;
    case 'filesize':
      return value.bytes;
    case 'datetime':
      return value.epochMs;
    default:
      return null;
  }
}

/** Loose scalar equality: same kind compares by value, mixed kinds are unequal. */
function scalarEquals(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'null':
      return true;
    case 'bool':
      return a.value === (b as BoolValue).value;
    case 'number':
      return a.value === (b as NumberValue).value;
    case 'string':
      return a.value === (b as StringValue).value;
    case 'filesize':
      return a.bytes === (b as FilesizeValue).bytes;
    case 'datetime':
      return a.epochMs === (b as DatetimeValue).epochMs;
    default:
      return false;
  }
}

/**
 * Evaluate a comparison between two runtime values. Ordering operators require
 * both operands to be orderable (number/filesize/datetime); `==` / `!=` work
 * across all scalars. Incompatible operands raise an EvalError.
 */
export function compareValues(a: RuntimeValue, b: RuntimeValue, op: ComparisonOp): boolean {
  if (op === '==') return scalarEquals(a, b);
  if (op === '!=') return !scalarEquals(a, b);

  const left = orderableMagnitude(a);
  const right = orderableMagnitude(b);
  if (left === null || right === null || a.kind !== b.kind) {
    throw new EvalError(`cannot compare ${a.kind} ${op} ${b.kind}`);
  }
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
}

/**
 * Total order used by `sort-by`. Same-kind values compare naturally; mixed
 * kinds are ordered by kind name so the sort is always total and never throws.
 */
export function compareForSort(a: RuntimeValue, b: RuntimeValue): number {
  if (a.kind === b.kind) {
    const left = orderableMagnitude(a);
    const right = orderableMagnitude(b);
    if (left !== null && right !== null) return left < right ? -1 : left > right ? 1 : 0;
    if (a.kind === 'string') {
      return a.value.localeCompare((b as StringValue).value);
    }
    if (a.kind === 'bool') {
      return Number(a.value) - Number((b as BoolValue).value);
    }
    return 0; // null / record / table: treat as equal
  }
  return a.kind < b.kind ? -1 : 1;
}

// ── JSON serialization (RuntimeValue -> wire shape) ────────────────────────────

export function valueToJson(value: RuntimeValue): JsonValue {
  switch (value.kind) {
    case 'null':
      return null;
    case 'bool':
      return value.value;
    case 'number':
      return value.value;
    case 'string':
      return value.value;
    case 'filesize':
      return value.bytes;
    case 'datetime':
      return new Date(value.epochMs).toISOString();
    case 'record':
      return recordToJson(value);
    case 'table':
      return value.rows.map(recordToJson);
  }
}

export function recordToJson(record: RecordValue): JsonRecord {
  const out: JsonRecord = {};
  const fields = record.fields;
  for (const key in fields) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      out[key] = valueToJson(fields[key]);
    }
  }
  return out;
}

/** Infer column metadata from a record's fields (first-row inference, §5). */
export function inferColumns(record: RecordValue): ColumnSchema[] {
  return Object.entries(record.fields).map(([name, value]) => ({ name, type: value.kind }));
}

// ── PipelineData ───────────────────────────────────────────────────────────────

export interface PipelineMeta {
  /** Declared/known column metadata, when available without peeking rows. */
  readonly columns?: ColumnSchema[];
}

type CleanupHook = () => void | Promise<void>;

export interface ValueData {
  readonly kind: 'value';
  readonly value: RuntimeValue;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}
export interface ListStreamData {
  readonly kind: 'list-stream';
  readonly rows: AsyncIterable<RecordValue>;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}
export interface ByteStreamData {
  readonly kind: 'byte-stream';
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}

/**
 * A live pseudo-terminal handle (Phase 2 TUI). Declared in the pure core as a
 * TYPE ONLY — `node-pty` is never imported here. `external/pty-runner.ts` adapts
 * node-pty's `IPty` to this interface so the core stays free of the native edge.
 */
export interface PtyHandle {
  /** Subscribe to raw PTY output bytes (node-pty's natural flush-sized chunks). */
  onData(listener: (bytes: Uint8Array) => void): void;
  /** Called once when the PTY child exits normally. */
  onExit(listener: (exitCode: number) => void): void;
  /** Write input (keystrokes / pasted text) to the PTY child's stdin. */
  write(data: string): void;
  /** Resize the PTY grid (the ConPTY equivalent of SIGWINCH). */
  resize(cols: number, rows: number): void;
  /**
   * Stop reading PTY output (backpressure, Stage C): the output pipe buffers
   * fill and the child blocks on write. Input (`write`) is unaffected — a
   * separate socket — so the user can still type/Ctrl+C while paused.
   */
  pause(): void;
  /** Resume reading PTY output after {@link pause}. */
  resume(): void;
  /** Kill the PTY child and release handles. Idempotent at the call site. */
  kill(): void;
}

/**
 * A full-screen interactive program (Phase 2 TUI). Unlike the other arms this is
 * NOT a row/byte source for the pipeline — it is a bidirectional terminal. It is
 * driven by {@link runPtySession} (not the ResultStore/window machinery) and the
 * renderer renders it with xterm.js. The PTY is spawned lazily at the renderer's
 * initial size so the grid matches the visible block.
 */
export interface PtyStreamData {
  readonly kind: 'pty-stream';
  readonly spawn: (cols: number, rows: number) => PtyHandle;
  /**
   * True for `!cmd` (force xterm) — a render hint for the adaptive-render layer
   * (Phase 3): mount xterm immediately instead of the default plain/adaptive
   * detection. Unset for the auto-routed (sigil-free) PTY default.
   */
  readonly forceXterm?: boolean;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}

/**
 * A `run-script` invocation (E4). Unlike the other arms this is NOT resolved
 * here or in block-runner — it is picked up by `runScriptSession` (the
 * interpreter layer), which spawns a script-host utilityProcess via the main
 * broker, drives the script to completion, and then feeds the resulting
 * rows/text through the ordinary `runBlock` path. Declared here purely as a
 * PipelineData variant (no spawn closure, unlike PtyStreamData) because
 * spawning requires an IPC round-trip through main (C1/C2) that the pure core
 * has no business owning — `scriptPath`/`args` are plain data.
 */
export interface ScriptStreamData {
  readonly kind: 'script-stream';
  readonly scriptPath: string;
  readonly args: readonly string[];
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}

/**
 * An `ssh-connect` invocation (E5). Like {@link ScriptStreamData} this is NOT
 * resolved here or in block-runner — it is picked up by `runSshSession` (the
 * interpreter layer), which owns the whole ssh2 connection lifecycle: TOFU
 * host-key verification + credential prompts (pre-channel, via `ssh-prompt`
 * frames) and, once the shell channel is up, the same live-terminal contract
 * as {@link PtyStreamData} (`schema{pty}` + `pty-data` + byte-ack backpressure).
 * Declared here purely as a PipelineData variant (plain data, no spawn
 * closure) because connecting requires an async main round-trip (known_hosts)
 * the pure core has no business owning.
 */
/** A fully specified legacy/direct `user@host` connection. `targetKind` is
 * optional so older in-flight values remain structurally compatible. */
export interface DirectSshStreamData {
  readonly kind: 'ssh-stream';
  readonly targetKind?: 'direct';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly keyPath?: string;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}

/** A bare OpenSSH config alias, resolved immediately before connecting. */
export interface SshAliasStreamData {
  readonly kind: 'ssh-stream';
  readonly targetKind: 'alias';
  readonly alias: string;
  readonly portOverride?: number;
  readonly keyPathOverride?: string;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}

export type SshStreamData = DirectSshStreamData | SshAliasStreamData;

/** A main-owned local-forward operation, resolved asynchronously by the
 * interpreter process after pure builtin evaluation. */
export interface SshForwardCommandData {
  readonly kind: 'ssh-forward-command';
  readonly request: SshForwardAction;
  readonly meta?: PipelineMeta;
  readonly cleanup?: CleanupHook;
}

export type PipelineData =
  | ValueData
  | ListStreamData
  | ByteStreamData
  | PtyStreamData
  | ScriptStreamData
  | SshStreamData
  | SshForwardCommandData;

export function scriptStreamData(scriptPath: string, args: readonly string[]): ScriptStreamData {
  return { kind: 'script-stream', scriptPath, args };
}

export function sshStreamData(host: string, port: number, user: string, keyPath?: string): DirectSshStreamData {
  return { kind: 'ssh-stream', host, port, user, keyPath };
}

export function sshAliasStreamData(
  alias: string,
  portOverride?: number,
  keyPathOverride?: string,
): SshAliasStreamData {
  return { kind: 'ssh-stream', targetKind: 'alias', alias, portOverride, keyPathOverride };
}

export function sshForwardCommandData(request: SshForwardAction): SshForwardCommandData {
  return { kind: 'ssh-forward-command', request };
}

export function listStreamData(
  rows: AsyncIterable<RecordValue>,
  meta?: PipelineMeta,
  cleanup?: CleanupHook,
): ListStreamData {
  return { kind: 'list-stream', rows, meta, cleanup };
}

export function valueData(value: RuntimeValue, meta?: PipelineMeta): ValueData {
  return { kind: 'value', value, meta };
}

export function byteStreamData(
  bytes: AsyncIterable<Uint8Array>,
  meta?: PipelineMeta,
  cleanup?: CleanupHook,
): ByteStreamData {
  return { kind: 'byte-stream', bytes, meta, cleanup };
}

export function ptyStreamData(
  spawn: (cols: number, rows: number) => PtyHandle,
  forceXterm?: boolean,
  meta?: PipelineMeta,
  cleanup?: CleanupHook,
): PtyStreamData {
  return { kind: 'pty-stream', spawn, forceXterm, meta, cleanup };
}

/** An empty list stream — the initial input for a pipeline's first command. */
export function emptyListStream(): ListStreamData {
  const rows: AsyncIterable<RecordValue> = {
    [Symbol.asyncIterator](): AsyncIterator<RecordValue> {
      return { next: () => Promise.resolve({ done: true, value: undefined }) };
    },
  };
  return listStreamData(rows);
}

/**
 * Adapt any PipelineData into an AsyncIterable of records so streaming
 * operators (`where`, `sort-by`) can consume uniformly. Scalar values raise
 * an EvalError — they are not row sources.
 */
export function toRowIterable(data: PipelineData): AsyncIterable<RecordValue> {
  if (data.kind === 'list-stream') return data.rows;
  if (data.kind === 'value') {
    const value = data.value;
    if (value.kind === 'table') {
      const rows = value.rows;
      return (async function* () {
        for (const row of rows) yield row;
      })();
    }
    if (value.kind === 'record') {
      const row = value;
      return (async function* () {
        yield row;
      })();
    }
    throw new EvalError(`expected a table or record input, got ${value.kind}`);
  }
  if (data.kind === 'pty-stream') {
    throw new EvalError('a PTY/TUI session cannot be consumed as rows');
  }
  if (data.kind === 'script-stream') {
    throw new EvalError('a run-script result cannot be piped as rows directly (v1)');
  }
  if (data.kind === 'ssh-forward-command') {
    throw new EvalError('an SSH forward operation cannot be piped as rows directly');
  }
  if (data.kind === 'ssh-stream') {
    throw new EvalError('an ssh-connect session cannot be consumed as rows');
  }
  throw new EvalError('byte streams cannot be consumed as rows');
}
