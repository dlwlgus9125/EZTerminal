/**
 * Shared interpreter contracts (architecture §5).
 *
 * Kept in one leaf module so `registry`, `evaluate`, and `builtins` can share
 * them without import cycles.
 */

import type { Command, Expression } from './ast';
import type { PipelineData, RuntimeValue } from './value';

/**
 * Durable shell-session state owned by the interpreter process (architecture §2).
 * A single ShellSession persists across command runs; each ExecutionSession builds
 * an {@link EvalContext} over it, so variables / cwd / env set by one Block are
 * visible to the next. The core depends only on this contract (it never imports
 * the process-side ShellSession implementation).
 */
export interface SessionState {
  /** Read a `$name` variable (undefined when unset). */
  getVar(name: string): RuntimeValue | undefined;
  /** Write a `$name` variable (`let`). */
  setVar(name: string, value: RuntimeValue): void;
  /** Mutate the session cwd (`cd`). Read the current cwd via {@link EvalContext.cwd}. */
  setCwd(dir: string): void;
  /** Set an env override (`$env.NAME = ...`). Read via {@link EvalContext.env}. */
  setEnv(name: string, value: string): void;
  /** Append an executed command line to the session history (`history` builtin). */
  addHistory(command: string): void;
  /** Read the session command history, oldest first (`history` builtin). */
  getHistory(): readonly string[];
}

/**
 * One running process, as surfaced by the `ps` builtin. Platform-neutral shape so a
 * cross-platform process source can drop in later behind the same seam; the Phase-1
 * source is Windows `tasklist` (see external/process-list).
 */
export interface ProcessInfo {
  readonly pid: number;
  readonly name: string;
  readonly sessionName: string;
  /** Resident memory in kilobytes (as reported by the OS process listing). */
  readonly memoryKb: number;
}

/**
 * Per-command execution context. `cwd`/`env` are LIVE reads of the durable
 * {@link SessionState} (mutated by `cd` / `$env.X = ...`), plus the cancellation
 * signal. `session` exposes variable/cwd/env writes.
 */
export interface EvalContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
  /** Durable shell session (variables + cwd/env mutation), architecture §2. */
  readonly session: SessionState;
  /**
   * Fallback for command names not in the registry: external program execution
   * (architecture §7). Wired by the interpreter process so the pure core never
   * imports child_process. When absent, an unknown command is a hard error.
   *
   * `opts.interactive` requests a full-screen PTY/TUI: the resolver returns a
   * `pty-stream` for a non-batch external program, or throws for a batch script.
   * Omitted/false keeps the non-interactive byte-stream path. A single, non-piped
   * external command is interactive by default (auto PTY routing, evaluate.ts);
   * `opts.forceXterm` (`!cmd`, Phase 3) additionally requests a forced full xterm
   * render, carried through to the `pty-stream` for the render layer to consume.
   */
  readonly resolveExternal?: (
    command: Command,
    ctx: EvalContext,
    opts?: { interactive?: boolean; forceXterm?: boolean },
  ) => PipelineData;
  /**
   * Snapshot the running processes for the `ps` builtin. Wired by the interpreter
   * process (Windows `tasklist` source) so the pure core never imports
   * child_process; injectable in tests. When absent, `ps` is a hard error.
   */
  readonly listProcesses?: () => Promise<readonly ProcessInfo[]>;
}

/** Declared input a command accepts; `any` skips the check. */
export type InputKind = 'none' | 'list-stream' | 'value' | 'byte-stream' | 'any';
export type OutputKind = 'list-stream' | 'value' | 'byte-stream';

export interface FlagDef {
  readonly name: string;
  /** Single-character short alias (without dash), e.g. `r` for `-r`. */
  readonly short?: string;
  readonly type: 'boolean' | 'string' | 'number';
  readonly description?: string;
}

export interface PositionalDef {
  readonly name: string;
  readonly required: boolean;
  /**
   * Only valid on the LAST declared positional: consumes every remaining
   * positional argument instead of capping the count (e.g. `run-script <path>
   * [args...]`, E4).
   */
  readonly variadic?: boolean;
}

/**
 * A resolved command invocation handed to a handler. Positional expressions
 * are passed RAW (un-evaluated) so streaming operators like `where` can apply
 * the predicate per row; other commands evaluate them eagerly themselves.
 * Flags are pre-resolved: boolean switches map to `true`, valued flags to a
 * RuntimeValue.
 */
export interface Invocation {
  readonly command: Command;
  readonly positionals: Expression[];
  readonly flags: ReadonlyMap<string, RuntimeValue | true>;
}

export type CommandHandler = (
  input: PipelineData,
  invocation: Invocation,
  ctx: EvalContext,
) => PipelineData;

/**
 * Declarative command definition (name, positional args, flags, declared
 * input/output kind, streaming-vs-buffering trait, handler).
 */
export interface CommandDef {
  readonly name: string;
  readonly positionals: readonly PositionalDef[];
  readonly flags: readonly FlagDef[];
  readonly inputKind: InputKind;
  readonly outputKind: OutputKind;
  /** true = streaming (per-row), false = buffering (materializes input). */
  readonly streaming: boolean;
  readonly handler: CommandHandler;
}
