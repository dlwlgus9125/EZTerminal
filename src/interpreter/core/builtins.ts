/**
 * Phase-1 builtin commands + the default registry.
 *
 * Streaming-vs-buffering trait (architecture §4) is declared per command:
 *   - `ls`        — SOURCE, streams directory entries (lazy per-entry stat).
 *   - `where`     — STREAMING filter (per-row predicate, no buffering).
 *   - `sort-by`   — BUFFERING: materializes the whole input before emitting.
 *   - `gen-rows`  — SOURCE, lazily emits N synthetic rows.
 *   - `cd`        — mutates the durable session cwd (validated, not process.chdir).
 *
 * Cancellation: every row loop calls `ctx.signal.throwIfAborted()` so an abort
 * stops the stream promptly; async-generator `finally` handles cleanup.
 */

import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import type { Expression } from './ast';
import { EvalError } from './errors';
import { evalExpression } from './evaluate';
import { CommandRegistry } from './registry';
import type { CommandDef, EvalContext, Invocation } from './types';
import {
  compareForSort,
  datetimeValue,
  filesizeValue,
  listStreamData,
  numberValue,
  recordValue,
  scriptStreamData,
  sshStreamData,
  stringValue,
  toRowIterable,
  valueData,
} from './value';
import type { PipelineData, RecordValue, RuntimeValue } from './value';

// ── arg helpers ────────────────────────────────────────────────────────────────

function expectIdentifierName(expr: Expression, commandName: string): string {
  if (expr.type !== 'identifier') {
    throw new EvalError(`${commandName} expects a column name`, expr.span);
  }
  return expr.name;
}

function expectNumber(value: RuntimeValue, what: string): number {
  if (value.kind !== 'number') {
    throw new EvalError(`${what} must be a number, got ${value.kind}`);
  }
  return value.value;
}

// ── ls (source, streaming) ──────────────────────────────────────────────────────

const LS_COLUMNS = [
  { name: 'name', type: 'string' as const },
  { name: 'size', type: 'filesize' as const },
  { name: 'type', type: 'string' as const },
  { name: 'modified', type: 'datetime' as const },
];

function entryType(entry: { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }): string {
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  return 'other';
}

function lsHandler(_input: PipelineData, _inv: Invocation, ctx: EvalContext): PipelineData {
  async function* rows(): AsyncGenerator<RecordValue> {
    const entries = await readdir(ctx.cwd, { withFileTypes: true });
    for (const entry of entries) {
      ctx.signal.throwIfAborted();
      const full = join(ctx.cwd, entry.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await stat(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // Unreadable entry (permissions / broken symlink): report it with
        // zeroed metadata rather than aborting the whole listing.
      }
      yield recordValue({
        name: stringValue(entry.name),
        size: filesizeValue(size),
        type: stringValue(entryType(entry)),
        modified: datetimeValue(mtimeMs),
      });
    }
  }
  return listStreamData(rows(), { columns: LS_COLUMNS });
}

// ── where (streaming filter) ────────────────────────────────────────────────────

function whereHandler(input: PipelineData, inv: Invocation, ctx: EvalContext): PipelineData {
  const predicate = inv.positionals[0];
  const source = toRowIterable(input);
  async function* rows(): AsyncGenerator<RecordValue> {
    for await (const row of source) {
      ctx.signal.throwIfAborted();
      const result = evalExpression(predicate, row, ctx);
      if (result.kind !== 'bool') {
        throw new EvalError('where predicate must evaluate to a boolean');
      }
      if (result.value) yield row;
    }
  }
  return listStreamData(rows(), input.meta);
}

// ── sort-by (buffering) ──────────────────────────────────────────────────────────

function sortByHandler(input: PipelineData, inv: Invocation, ctx: EvalContext): PipelineData {
  const column = expectIdentifierName(inv.positionals[0], 'sort-by');
  const reverse = inv.flags.get('reverse') === true;
  const source = toRowIterable(input);
  async function* rows(): AsyncGenerator<RecordValue> {
    // BUFFERING: drain the entire input before emitting anything.
    const buffer: RecordValue[] = [];
    for await (const row of source) {
      ctx.signal.throwIfAborted();
      buffer.push(row);
    }
    buffer.sort((a, b) => {
      const av = a.fields[column];
      const bv = b.fields[column];
      if (av === undefined || bv === undefined) return 0;
      return compareForSort(av, bv);
    });
    if (reverse) buffer.reverse();
    for (const row of buffer) {
      ctx.signal.throwIfAborted();
      yield row;
    }
  }
  return listStreamData(rows(), input.meta);
}

// ── gen-rows (source, lazy) ──────────────────────────────────────────────────────

const GEN_ROWS_COLUMNS = [
  { name: 'n', type: 'number' as const },
  { name: 'name', type: 'string' as const },
];

function genRowsHandler(_input: PipelineData, inv: Invocation, ctx: EvalContext): PipelineData {
  const countValue = evalExpression(inv.positionals[0], null, ctx);
  const parsed = z
    .number()
    .int()
    .nonnegative()
    .safeParse(expectNumber(countValue, 'gen-rows count'));
  if (!parsed.success) {
    throw new EvalError(`gen-rows: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const count = parsed.data;
  async function* rows(): AsyncGenerator<RecordValue> {
    for (let i = 1; i <= count; i++) {
      ctx.signal.throwIfAborted();
      yield recordValue({ n: numberValue(i), name: stringValue(`row-${i}`) });
    }
  }
  return listStreamData(rows(), { columns: GEN_ROWS_COLUMNS });
}

// ── history (source, reads the session history) ─────────────────────────────────

const HISTORY_COLUMNS = [
  { name: 'index', type: 'number' as const },
  { name: 'command', type: 'string' as const },
];

/**
 * `history` — emit the session's command history as a structured table
 * (`{ index, command }`), so it is pipeable (`history | where command == "ls"`).
 * The list is snapshotted at dispatch so a slow consumer sees a stable result.
 */
function historyHandler(_input: PipelineData, _inv: Invocation, ctx: EvalContext): PipelineData {
  const entries = [...ctx.session.getHistory()];
  async function* rows(): AsyncGenerator<RecordValue> {
    for (let i = 0; i < entries.length; i++) {
      ctx.signal.throwIfAborted();
      yield recordValue({ index: numberValue(i + 1), command: stringValue(entries[i]) });
    }
  }
  return listStreamData(rows(), { columns: HISTORY_COLUMNS });
}

// ── ps (source, snapshots running processes) ────────────────────────────────────

const PS_COLUMNS = [
  { name: 'pid', type: 'number' as const },
  { name: 'name', type: 'string' as const },
  { name: 'sessionName', type: 'string' as const },
  { name: 'memory', type: 'filesize' as const },
];

/**
 * `ps` — list running processes as a structured table (`{ pid, name, ... }`), so it
 * is pipeable (`ps | where name == "node.exe"`, `ps | sort-by pid`). The process
 * source is injected via `ctx.listProcesses` (Windows `tasklist` in production) so
 * the pure core never imports child_process and tests can stub it deterministically.
 */
function psHandler(_input: PipelineData, _inv: Invocation, ctx: EvalContext): PipelineData {
  if (!ctx.listProcesses) {
    throw new EvalError('ps is not available in this context');
  }
  const listProcesses = ctx.listProcesses;
  async function* rows(): AsyncGenerator<RecordValue> {
    const processes = await listProcesses();
    for (const proc of processes) {
      ctx.signal.throwIfAborted();
      yield recordValue({
        pid: numberValue(proc.pid),
        name: stringValue(proc.name),
        sessionName: stringValue(proc.sessionName),
        memory: filesizeValue(proc.memoryKb * 1024),
      });
    }
  }
  return listStreamData(rows(), { columns: PS_COLUMNS });
}

// ── cd (source, mutates session cwd) ──────────────────────────────────────────────

/** Resolve a `cd` path argument to its literal string (bare word / string / $var / $env). */
function cdPathArg(expr: Expression | undefined, ctx: EvalContext): string {
  if (!expr) return homedir(); // `cd` with no arg → home directory
  switch (expr.type) {
    case 'identifier':
      return expr.name; // bare path word: child, .., -, src/sub
    case 'string':
      return expr.value;
    case 'variable': {
      const value = ctx.session.getVar(expr.name);
      if (value === undefined) throw new EvalError(`undefined variable: $${expr.name}`, expr.span);
      if (value.kind !== 'string') {
        throw new EvalError(`cd: $${expr.name} is not a string path`, expr.span);
      }
      return value.value;
    }
    case 'env': {
      const raw = ctx.env[expr.name];
      if (raw === undefined) throw new EvalError(`cd: $env.${expr.name} is not set`, expr.span);
      return raw;
    }
    default:
      throw new EvalError('cd expects a path', expr.span);
  }
}

/**
 * `cd <path>` — resolve against the session cwd, validate it is an existing
 * directory, then mutate the session cwd (NOT process.chdir). `cd` with no arg
 * goes home; `cd -` returns to the previous dir (tracked via the OLDPWD env
 * override). Validation is synchronous so the mutation happens at evaluate time,
 * before any later command in the same line reads the cwd.
 */
function cdHandler(_input: PipelineData, inv: Invocation, ctx: EvalContext): PipelineData {
  const raw = cdPathArg(inv.positionals[0], ctx);
  let dest: string;
  if (raw === '-') {
    const previous = ctx.env['OLDPWD'];
    if (previous === undefined) throw new EvalError('cd: OLDPWD not set');
    dest = previous;
  } else {
    dest = resolve(ctx.cwd, raw);
  }

  let info;
  try {
    info = statSync(dest);
  } catch {
    throw new EvalError(`cd: no such file or directory: ${raw}`);
  }
  if (!info.isDirectory()) throw new EvalError(`cd: not a directory: ${raw}`);

  const from = ctx.cwd;
  ctx.session.setCwd(dest);
  ctx.session.setEnv('OLDPWD', from);
  return valueData(stringValue(dest));
}

// ── shared bare-word argument resolution (run-script E4, ssh-connect E5) ─────────

/**
 * Resolve a positional/flag-value expression (a script path/arg, or an
 * `ssh-connect user@host`) to its literal string. Mirrors `cdPathArg`: bare
 * words are literal text (not column references), so this does NOT go through
 * `evalExpression` (which rejects identifiers outside row scope). `label`
 * prefixes error messages with the calling builtin's name.
 */
function bareArgValue(expr: Expression, ctx: EvalContext, label: string): string {
  switch (expr.type) {
    case 'identifier':
      return expr.name;
    case 'string':
      return expr.value;
    case 'number':
      return String(expr.value);
    case 'bool':
      return String(expr.value);
    case 'filesize':
      return String(expr.bytes);
    case 'null':
      return 'null';
    case 'variable': {
      const value = ctx.session.getVar(expr.name);
      if (value === undefined) throw new EvalError(`undefined variable: $${expr.name}`, expr.span);
      switch (value.kind) {
        case 'null':
          return 'null';
        case 'bool':
          return String(value.value);
        case 'number':
          return String(value.value);
        case 'string':
          return value.value;
        case 'filesize':
          return String(value.bytes);
        case 'datetime':
          return new Date(value.epochMs).toISOString();
        default:
          throw new EvalError(`${label}: $${expr.name} is a ${value.kind}, not a valid argument`, expr.span);
      }
    }
    case 'env': {
      const raw = ctx.env[expr.name];
      if (raw === undefined) throw new EvalError(`${label}: $env.${expr.name} is not set`, expr.span);
      return raw;
    }
    case 'binary':
      throw new EvalError(`${label}: comparison expressions are not valid arguments`, expr.span);
  }
}

// ── run-script (E4, resolved by runScriptSession — see script-runner.ts) ─────────

/**
 * `run-script <path> [args...]` — resolves the path against the session cwd
 * and returns a `ScriptStreamData` marker. The actual spawn/run/collect
 * happens in `runScriptSession` (interpreter layer), which the ExecutionSession
 * routes to based on `data.kind` — this handler stays synchronous like every
 * other builtin.
 */
function runScriptHandler(_input: PipelineData, inv: Invocation, ctx: EvalContext): PipelineData {
  const [pathExpr, ...argExprs] = inv.positionals;
  const rawPath = bareArgValue(pathExpr, ctx, 'run-script');
  if (!/\.(m?js)$/i.test(rawPath)) {
    throw new EvalError('run-script: only .js/.mjs scripts are supported (v1)');
  }
  const scriptPath = resolve(ctx.cwd, rawPath);
  const args = argExprs.map((expr) => bareArgValue(expr, ctx, 'run-script'));
  return scriptStreamData(scriptPath, args);
}

// ── ssh-connect (E5, resolved by runSshSession — see ssh-session.ts) ─────────────

/** Default SSH port when `--port` is omitted. */
const DEFAULT_SSH_PORT = 22;

/**
 * `ssh-connect user@host [--key <path>] [--port <n>]` — parses the target and
 * returns an `SshStreamData` marker. The actual connect/auth/shell lifecycle
 * happens in `runSshSession` (interpreter layer): TOFU host-key verification
 * and credential prompts precede a `schema{pty}` that behaves exactly like a
 * local `!cmd` PTY block once the shell channel is up (design §1/§7 B1).
 */
function sshConnectHandler(_input: PipelineData, inv: Invocation, ctx: EvalContext): PipelineData {
  const [targetExpr] = inv.positionals;
  const target = bareArgValue(targetExpr, ctx, 'ssh-connect');
  const at = target.indexOf('@');
  if (at <= 0 || at === target.length - 1) {
    throw new EvalError(`ssh-connect: expected user@host, got '${target}'`, targetExpr.span);
  }
  const user = target.slice(0, at);
  const host = target.slice(at + 1);

  const keyFlag = inv.flags.get('key');
  const keyPath = keyFlag === undefined ? undefined : requireStringFlag(keyFlag, 'key');

  const portFlag = inv.flags.get('port');
  let port = DEFAULT_SSH_PORT;
  if (portFlag !== undefined) {
    if (portFlag === true || portFlag.kind !== 'number' || !Number.isInteger(portFlag.value) || portFlag.value < 1 || portFlag.value > 65535) {
      throw new EvalError('ssh-connect: --port must be an integer between 1 and 65535');
    }
    port = portFlag.value;
  }

  return sshStreamData(host, port, user, keyPath);
}

/** Narrow a resolved flag value to a non-empty string, or raise a clear error. */
function requireStringFlag(value: RuntimeValue | true, name: string): string {
  if (value === true || value.kind !== 'string') {
    throw new EvalError(`ssh-connect: --${name} must be a string`);
  }
  return value.value;
}

// ── definitions + registry ───────────────────────────────────────────────────────

export const BUILTIN_DEFS: readonly CommandDef[] = [
  {
    name: 'ls',
    positionals: [],
    flags: [],
    inputKind: 'none',
    outputKind: 'list-stream',
    streaming: true,
    handler: lsHandler,
  },
  {
    name: 'where',
    positionals: [{ name: 'predicate', required: true }],
    flags: [],
    inputKind: 'list-stream',
    outputKind: 'list-stream',
    streaming: true,
    handler: whereHandler,
  },
  {
    name: 'sort-by',
    positionals: [{ name: 'column', required: true }],
    flags: [{ name: 'reverse', short: 'r', type: 'boolean', description: 'sort in descending order' }],
    inputKind: 'list-stream',
    outputKind: 'list-stream',
    streaming: false,
    handler: sortByHandler,
  },
  {
    name: 'gen-rows',
    positionals: [{ name: 'count', required: true }],
    flags: [],
    inputKind: 'none',
    outputKind: 'list-stream',
    streaming: true,
    handler: genRowsHandler,
  },
  {
    name: 'cd',
    positionals: [{ name: 'path', required: false }],
    flags: [],
    inputKind: 'none',
    outputKind: 'value',
    streaming: true,
    handler: cdHandler,
  },
  {
    name: 'history',
    positionals: [],
    flags: [],
    inputKind: 'none',
    outputKind: 'list-stream',
    streaming: true,
    handler: historyHandler,
  },
  {
    name: 'ps',
    positionals: [],
    flags: [],
    inputKind: 'none',
    outputKind: 'list-stream',
    streaming: true,
    handler: psHandler,
  },
  {
    name: 'run-script',
    // outputKind is genuinely dynamic (table or text, decided by the script's
    // return value) — 'value' is a documentation placeholder; nothing reads it.
    positionals: [
      { name: 'path', required: true },
      { name: 'args', required: false, variadic: true },
    ],
    flags: [],
    inputKind: 'none',
    outputKind: 'value',
    streaming: true,
    handler: runScriptHandler,
  },
  {
    name: 'ssh-connect',
    // outputKind is a documentation placeholder (like run-script) — the real
    // shape is decided by runSshSession (schema{pty} once the channel is up).
    positionals: [{ name: 'target', required: true }],
    flags: [
      { name: 'key', type: 'string', description: 'path to a private key file' },
      { name: 'port', type: 'number', description: 'SSH port (default 22)' },
    ],
    inputKind: 'none',
    outputKind: 'value',
    streaming: true,
    handler: sshConnectHandler,
  },
];

/** Build a registry pre-populated with the Phase-1 builtins. */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const def of BUILTIN_DEFS) registry.register(def);
  return registry;
}
