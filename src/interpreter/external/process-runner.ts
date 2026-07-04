/**
 * ProcessRunner — spawns an external program and exposes its merged stdout+stderr
 * as a cancellable ByteStream (architecture §7 / §2).
 *
 * Design points:
 *   - The spawn primitive is injected (`SpawnFn`) — the Adapter seam. Phase 1 uses
 *     Node `child_process.spawn`; phase 2 can drop in a node-pty-backed spawner
 *     with the same shape without touching callers.
 *   - stdout + stderr are merged, in arrival order, into a single
 *     `AsyncIterable<Uint8Array>` (the `byte-stream` PipelineData edge).
 *   - Cancellation goes through the session AbortSignal: it is passed to `spawn`
 *     (Node kills the child on abort) AND wired through `addAbortSignal` on each
 *     stdio stream (so reads unblock promptly). The byte iterator's `finally`
 *     also kills the child if the consumer stops early — so no process leaks.
 *   - Spawn failures (ENOENT, …) surface by REJECTING the byte stream; `exit`
 *     never rejects, so an unconsumed `exit` promise can't crash the process.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { addAbortSignal } from 'node:stream';
import type { Readable } from 'node:stream';
import crossSpawn from 'cross-spawn';

/** The spawn primitive (Adapter seam): swap child_process for node-pty later. */
export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Default spawner: cross-spawn. It is a drop-in for child_process.spawn that fixes
 * Windows `.bat`/`.cmd` execution — it wraps them in `cmd.exe` and `^`-escapes every
 * argument, so a user arg containing `& | < > ^ "` is passed literally and can NOT
 * inject a second command (SEC-HIGH-1; it is the same spawner npm/npx use).
 */
const defaultSpawn: SpawnFn = (file, args, options) => crossSpawn(file, args, options);

/** Pending decoded chunks before we pause the source; resume once it drains below. */
const HIGH_WATER = 64;
const LOW_WATER = 16;

export interface RunOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
  /**
   * Batch (`.bat`/`.cmd`) targets run under `cmd.exe`; killing only `cmd.exe`
   * orphans its grandchildren on Windows. When true, cancel kills the whole child
   * TREE (`taskkill /T /F`) instead of just the direct child (SEC-LOW-6).
   */
  readonly killTree?: boolean;
}

export interface ProcessExit {
  /** Exit code, or null when the child was terminated by a signal (e.g. kill). */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningProcess {
  /** Merged stdout+stderr as a cancellable byte stream. */
  readonly bytes: AsyncIterable<Uint8Array>;
  /** OS process id (undefined if the OS never created the process). */
  readonly pid: number | undefined;
  /** Resolves once the child has exited. Never rejects (errors flow via `bytes`). */
  readonly exit: Promise<ProcessExit>;
}

/**
 * Spawn `file args` and stream its merged output. Iterating `bytes` drives the
 * read; the child is killed on abort or early iterator return.
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: RunOptions,
  spawn: SpawnFn = defaultSpawn,
): RunningProcess {
  // SECURITY (SEC-HIGH-1): do NOT add `shell: true` to these options. cross-spawn
  // detects a `.bat`/`.cmd` target and `^`-escapes every arg ONLY on its non-shell
  // path; passing `shell: true` makes cross-spawn's parse() short-circuit and skip
  // all escaping, reintroducing the command-injection vuln. Batch wrapping is already
  // handled by cross-spawn here — there is nothing to "fix" by enabling a shell.
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    windowsHide: true,
    // AC-8: close stdin explicitly (array form, NOT the 'ignore' shorthand — the
    // shorthand also closes stdout/stderr, breaking the capture below). A left-open
    // stdin pipe never delivers EOF, so a child that reads stdin (e.g. piped into a
    // builtin) would hang forever waiting for input it will never receive.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Kill the child on cancel/early-exit. Batch targets run under cmd.exe, so a plain
  // child.kill() (or the spawn `signal` option) only ends cmd.exe and orphans its
  // grandchildren on Windows — kill the whole TREE for them instead (SEC-LOW-6).
  const killChild = (): void => {
    if (options.killTree && process.platform === 'win32' && child.pid != null) {
      try {
        nodeSpawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
        return;
      } catch {
        // taskkill unavailable — fall through to a direct kill.
      }
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };

  // The spawn `signal` option already kills the direct child on abort; for batch
  // targets we additionally tear down the tree so no grandchild process leaks.
  if (options.killTree) {
    if (options.signal.aborted) killChild();
    else options.signal.addEventListener('abort', () => killChild(), { once: true });
  }

  let exited = false;
  let exitInfo: ProcessExit = { code: null, signal: null };
  let resolveExit!: (info: ProcessExit) => void;
  const exit = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  let spawnError: Error | null = null;
  const chunks: Uint8Array[] = [];
  let notify: (() => void) | null = null;
  const wake = (): void => {
    const n = notify;
    notify = null;
    n?.();
  };

  let paused = false;
  const streams: Readable[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    // Destroy the stream promptly on abort so a blocked read unblocks.
    addAbortSignal(options.signal, stream);
    streams.push(stream);
    stream.on('data', (chunk: Buffer) => {
      chunks.push(new Uint8Array(chunk));
      // Backpressure: if the consumer falls behind, pause the source so unread
      // chunks don't buffer unbounded (a fast/forever producer would otherwise
      // grow memory without limit). The iterator resumes once it drains (CODE-M1).
      if (!paused && chunks.length >= HIGH_WATER) {
        paused = true;
        for (const s of streams) s.pause();
      }
      wake();
    });
  }

  let endedStreams = 0;
  for (const stream of streams) {
    const markEnded = (): void => {
      endedStreams += 1;
      wake();
    };
    stream.on('end', markEnded);
    // addAbortSignal destroys with an AbortError on cancel; treat as end so the
    // 'error' is handled (an unhandled stream 'error' would crash the process).
    stream.on('error', markEnded);
  }

  child.on('error', (err: Error) => {
    exited = true;
    resolveExit(exitInfo);
    // The `signal` spawn option emits an AbortError here when cancelled — that is
    // a kill notification, not a spawn failure, so don't surface it as a stream
    // error (the block reports `cancelled`). Real failures (ENOENT, …) do throw.
    if (!options.signal.aborted) spawnError = err;
    wake();
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exited = true;
    exitInfo = { code, signal };
    resolveExit(exitInfo);
    wake();
  };
  child.on('exit', onExit);
  child.on('close', () => {
    exited = true;
    resolveExit(exitInfo);
    wake();
  });

  const done = (): boolean =>
    chunks.length === 0 && exited && endedStreams >= streams.length;

  async function* bytes(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        if (chunks.length) {
          const chunk = chunks.shift() as Uint8Array;
          // Drained below the low-water mark — let the paused source flow again.
          if (paused && chunks.length <= LOW_WATER) {
            paused = false;
            for (const s of streams) s.resume();
          }
          yield chunk;
          continue;
        }
        if (spawnError) throw spawnError;
        if (done()) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
          // Re-check synchronously: an event may have fired between the checks
          // above and registering `notify` (closes the lost-wakeup race).
          if (chunks.length || spawnError || done()) {
            notify = null;
            resolve();
          }
        });
      }
    } finally {
      // If the consumer stopped early (dispose/cancel) and the child is still
      // alive, kill it — no lingering process (tree-kill for batch targets).
      if (!exited) killChild();
    }
  }

  return { bytes: bytes(), pid: child.pid, exit };
}
