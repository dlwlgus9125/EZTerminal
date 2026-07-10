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
export type KillTreeFn = (pid: number) => void;

const defaultKillTree: KillTreeFn = (pid) => {
  // Matches process-runner.ts's existing killChild taskkill convention.
  try {
    nodeSpawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // taskkill unavailable — the 5s fallback timer in killOnce covers this.
  }
};

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

  // Tracks whether the child has already exited, so killOnce's taskkill
  // fallback timer (below) knows not to fire a redundant proc.kill().
  let exited = false;
  proc.onExit(() => {
    exited = true;
  });

  const killOnce = (): void => {
    try {
      // Defensive resume-then-kill (Stage C): node-pty's public onExit fires
      // from the output socket's 'close'; destroy fires 'close' even while
      // paused, but resuming first keeps any final buffered output flowing and
      // costs nothing (gate record §Q1).
      proc.resume();
    } catch {
      // Socket already gone.
    }
    // Windows + useConptyDll:true crash workaround: node-pty's own kill() path
    // for the bundled conpty.dll synchronously destroys the input socket THEN
    // calls into the native kill — a double-free-shaped sequence that reliably
    // crashes the host process with STATUS_HEAP_CORRUPTION (0xC0000374),
    // confirmed via direct reproduction 2026-07-03. Sessions that exit
    // NATURALLY (no explicit kill()) never hit this and are unaffected — the
    // native `_$onProcessExit` teardown path they use is safe. So on Windows,
    // terminate the child externally (killTree, tree-kill so the fallback batch-
    // shim's cmd.exe -> node.exe grandchild is reached too — de-sugared shims
    // spawn the target directly and have no cmd.exe grandparent) instead of calling
    // proc.kill() directly; the external kill drives the SAME safe
    // natural-exit path. `proc.kill()` is kept as a last-resort fallback if
    // onExit hasn't fired within 5s (e.g. the external kill itself failed) —
    // that path was already the pre-existing (crashing) behavior, so nothing
    // is lost by trying it only as a fallback.
    if (process.platform === 'win32') {
      killTree(proc.pid);
      setTimeout(() => {
        if (exited) return;
        try {
          proc.kill();
        } catch {
          // Already exited / handle released — nothing to do.
        }
      }, 5000);
      return;
    }
    try {
      proc.kill();
    } catch {
      // Already exited / handle released — nothing to do.
    }
  };

  if (options.signal.aborted) killOnce();
  else options.signal.addEventListener('abort', killOnce, { once: true });

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
      proc.resize(cols, rows);
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
