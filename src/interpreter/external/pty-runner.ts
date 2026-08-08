/**
 * PtyRunner — the node-pty edge for full-screen TUI programs (Phase 2).
 *
 * This is the PARALLEL of ProcessRunner for interactive programs. ProcessRunner's
 * `SpawnFn`/`runProcess` model assumes two separate `Readable`s (stdout+stderr)
 * with pause/resume flow control; a node-pty `IPty` is a single merged `onData`
 * stream plus `write`/`resize`/`kill` and NO `Readable`/stderr — a different shape
 * entirely, so it gets its own seam rather than being forced behind `SpawnFn`.
 *
 * The only place `node-pty` is imported. It adapts `IPty` to the core's pure
 * {@link PtyHandle} type so the interpreter core stays free of the native edge.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import * as pty from 'node-pty';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';

import type { PtyHandle } from '../core/value';

/**
 * Args passed to node-pty's spawn. node-pty's argv-array path re-quotes every
 * element itself (`argsToCommandLine`, node_modules/node-pty/lib/windowsPtyAgent.js)
 * with no `windowsVerbatimArguments` escape hatch, so a pre-escaped batch command
 * line (see build-cmd-line.ts) must go through node-pty's separate Windows
 * *single-string* args path instead (node-pty.d.ts:10-18) — handing it through the
 * array path would double-escape. A plain `string | readonly string[]` union
 * would be unsafe here (the default spawner below spreads with `[...args]`, which
 * would shred a command-line string into one-character argv), so this is a
 * discriminated union instead — every call site and fake must pick a branch.
 */
export type PtyArgs =
  | { readonly kind: 'argv'; readonly argv: readonly string[] }
  | { readonly kind: 'commandLine'; readonly commandLine: string };

export function ptyArgv(argv: readonly string[]): PtyArgs {
  return { kind: 'argv', argv };
}

export function ptyCommandLine(commandLine: string): PtyArgs {
  return { kind: 'commandLine', commandLine };
}

/** The spawn primitive (Adapter seam): injectable so tests use a fake IPty. */
export type PtySpawnFn = (
  file: string,
  args: PtyArgs,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

const defaultPtySpawn: PtySpawnFn = (file, args, options) =>
  pty.spawn(file, args.kind === 'argv' ? [...args.argv] : args.commandLine, options);

/** Terminate a process tree by PID from OUTSIDE node-pty (Adapter seam: fakeable
 * in tests, which must never shell out to a real OS kill command). See the
 * `killOnce` comment in {@link runPty} for why this exists on Windows. */
export type KillTreeFn = (pid: number) => void | Promise<void>;

const defaultKillTree: KillTreeFn = (pid) => new Promise<void>((resolve) => {
  // Matches process-runner.ts's existing killChild taskkill convention.
  try {
    const killer = nodeSpawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(resolve, 2_000);
    timer.unref?.();
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    killer.once('error', finish);
    killer.once('close', finish);
  } catch {
    // taskkill unavailable — killOnce falls back to node-pty directly.
    resolve();
  }
});

export interface RunPtyOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
  readonly cols: number;
  readonly rows: number;
}

/** Coerce node-pty's data payload to bytes. With `encoding: null` it is already a
 * Buffer; guard the string case (default encoding) for safety. */
function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

/**
 * Spawn an interactive program in a pseudo-terminal and adapt it to {@link PtyHandle}.
 *
 * - `encoding: null` → raw bytes from `onData` (byte-correct across partial UTF-8
 *   and escape sequences; xterm.js consumes the bytes directly).
 * - Cancellation reuses the existing AbortController seam: `signal` abort → kill,
 *   so no new cancel wiring is needed in the ExecutionSession.
 * - `handleFlowControl` is intentionally NOT enabled: it would intercept XOFF/XON
 *   (Ctrl+S / Ctrl+Q) keystrokes meant for the child (e.g. editors). Firehose
 *   backpressure is a tracked follow-up.
 */
export function runPty(
  file: string,
  args: PtyArgs,
  options: RunPtyOptions,
  spawn: PtySpawnFn = defaultPtySpawn,
  killTree: KillTreeFn = defaultKillTree,
): PtyHandle {
  // node-pty needs a string-valued env; drop undefined holes (same discipline as
  // process-runner). cwd/env come live from the session context.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) env[key] = value;
  }

  const proc = spawn(file, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
    encoding: null,
    // EXPERIMENTAL (node-pty): use the conpty.dll/OpenConsole.exe bundled with
    // node-pty instead of the OS-installed ConPTY. No-op on non-Windows.
    useConptyDll: true,
  });

  // node-pty's WindowsTerminal installs one output-socket `error` listener and
  // deliberately rethrows non-EIO errors when the consumer has not installed a
  // second listener. On Node 24 + bundled ConPTY, a naturally exiting child can
  // surface `write EAGAIN` during pipe teardown. Without this public-runtime
  // listener that recoverable race terminates the entire shared interpreter
  // utility process before node-pty's subsequent `close`/`onExit` event arrives.
  // `IPty` omits EventEmitter methods from its declaration, but every node-pty
  // Terminal implementation exposes `on` at runtime (Terminal.prototype.on).
  const errorAwareProc = proc as IPty & {
    on?: (eventName: string, listener: (error: NodeJS.ErrnoException) => void) => void;
    _agent?: {
      inSocket?: {
        on?: (eventName: string, listener: (error: NodeJS.ErrnoException) => void) => void;
      };
    };
  };
  const handleTerminalSocketError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EAGAIN' || error.code === 'EIO') return;
    console.error(`[pty] terminal socket error: ${error.code ?? error.name}`);
  };
  errorAwareProc.on?.('error', handleTerminalSocketError);
  // node-pty exposes only the ConPTY output socket through Terminal.on(); its
  // private input socket can emit the same asynchronous EAGAIN after a final
  // focus/input write. Guard it at the dependency boundary as well. Optional
  // access keeps this safe if a future node-pty release changes the internals.
  errorAwareProc._agent?.inSocket?.on?.('error', handleTerminalSocketError);

  // Tracks whether the child has already exited, so killOnce's taskkill
  // fallback timer (below) knows not to fire a redundant proc.kill().
  let exited = false;
  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  proc.onExit(() => {
    exited = true;
    resolveExited();
  });

  let killPromise: Promise<void> | null = null;
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return exited;
  };
  const killOnce = (): Promise<void> => {
    if (exited) return Promise.resolve();
    if (killPromise) return killPromise;
    killPromise = (async () => {
      try {
        // Resume before kill so final buffered output can reach the exit path.
        proc.resume();
      } catch {
        // Socket already gone.
      }
      // Bundled ConPTY can corrupt the host heap in node-pty's direct kill path.
      // External tree termination drives the safe natural-exit path instead.
      if (process.platform === 'win32') {
        try {
          await killTree(proc.pid);
        } catch {
          // Fall through to the last-resort node-pty kill.
        }
        if (!(await waitForExit(1_000))) {
          try {
            proc.kill();
          } catch {
            // Already exited / handle released — nothing to do.
          }
          await waitForExit(1_000);
        }
        return;
      }
      try {
        proc.kill();
      } catch {
        // Already exited / handle released — nothing to do.
      }
      await waitForExit(1_000);
    })();
    return killPromise;
  };

  if (options.signal.aborted) void killOnce();
  else options.signal.addEventListener('abort', () => { void killOnce(); }, { once: true });

  return {
    onData(listener) {
      // Typed as string by node-pty, but `encoding: null` delivers Buffer.
      proc.onData((d) => listener(toBytes(d as unknown as string | Uint8Array)));
    },
    onExit(listener) {
      proc.onExit(({ exitCode }) => listener(exitCode));
    },
    write(data) {
      proc.write(data);
    },
    resize(cols, rows) {
      try {
        proc.resize(cols, rows);
      } catch (error) {
        // Bundled ConPTY can mark the native agent exited just before its
        // public onExit event reaches us. A late xterm fit/ResizeObserver call
        // in that window is a harmless stale resize, not an interpreter-fatal
        // programming error.
        if (
          exited
          || (error instanceof Error
            && error.message === 'Cannot resize a pty that has already exited')
        ) {
          return;
        }
        throw error;
      }
    },
    pause() {
      proc.pause();
    },
    resume() {
      proc.resume();
    },
    kill: killOnce,
  };
}
