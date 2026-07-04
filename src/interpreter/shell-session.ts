/**
 * ShellSession — the durable, utilityProcess-side shell state (architecture §2).
 *
 * ONE ShellSession is created at interpreter-process bootstrap and lives for the
 * app lifetime. It owns the things that must PERSIST across command runs:
 *   - `cwd`        — the current directory (mutated by `cd`, never `process.chdir`)
 *   - env overrides — `$env.NAME = ...` writes, merged over `process.env` on read
 *   - variables    — `let x = ...` writes, read back as `$x`
 *
 * Each command run creates a per-command {@link EvalContext} via {@link createContext};
 * the context's `cwd`/`env` are LIVE getters over this session, so state set by
 * one Block is visible to the next. (ExecutionSession is per-command OVER this.)
 */

import type { EvalContext, ProcessInfo, RuntimeValue, SessionState } from './core';

export class ShellSession implements SessionState {
  private currentCwd: string;
  private readonly envOverrides = new Map<string, string>();
  private readonly variables = new Map<string, RuntimeValue>();
  /** Executed command lines, oldest first — the authoritative session history. */
  private readonly commandHistory: string[] = [];

  constructor(cwd: string = process.cwd()) {
    this.currentCwd = cwd;
  }

  /** The session's current working directory (mutated by `cd`). */
  get cwd(): string {
    return this.currentCwd;
  }

  /** The session env: overrides merged over the live process env. */
  get env(): Record<string, string | undefined> {
    if (this.envOverrides.size === 0) return process.env;
    const merged: Record<string, string | undefined> = { ...process.env };
    for (const [name, value] of this.envOverrides) merged[name] = value;
    return merged;
  }

  getVar(name: string): RuntimeValue | undefined {
    return this.variables.get(name);
  }

  setVar(name: string, value: RuntimeValue): void {
    this.variables.set(name, value);
  }

  setCwd(dir: string): void {
    this.currentCwd = dir;
  }

  setEnv(name: string, value: string): void {
    this.envOverrides.set(name, value);
  }

  /** Append an executed command line to the session history (`history` builtin). */
  addHistory(command: string): void {
    this.commandHistory.push(command);
  }

  /** The session command history, oldest first (`history` builtin). */
  getHistory(): readonly string[] {
    return this.commandHistory;
  }

  /**
   * Build a per-command EvalContext whose `cwd`/`env` read this session live (so a
   * `cd` / `$env.X = ...` earlier in the same line, or in a prior run, is visible).
   */
  createContext(
    signal: AbortSignal,
    resolveExternal?: EvalContext['resolveExternal'],
    listProcesses?: () => Promise<readonly ProcessInfo[]>,
  ): EvalContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    return {
      get cwd(): string {
        return session.cwd;
      },
      get env(): Record<string, string | undefined> {
        return session.env;
      },
      signal,
      session,
      resolveExternal,
      listProcesses,
    };
  }
}
