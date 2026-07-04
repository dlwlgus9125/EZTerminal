/**
 * Local ambient types for `cross-spawn` (it ships no `.d.ts` and `@types/cross-spawn`
 * is not installed). cross-spawn's default export is a drop-in for
 * `child_process.spawn` with correct Windows `.bat`/`.cmd` argument quoting
 * (SEC-HIGH-1) — same signature, returns a real ChildProcess.
 */
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';

  function spawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;

  export = spawn;
}
