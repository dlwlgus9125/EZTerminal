/**
 * External-command dispatch (architecture §7).
 *
 * When a command name is NOT a builtin, the interpreter routes it here. This
 * module reconstructs the argument vector from the parsed command, resolves the
 * executable (CommandResolver), runs it (ProcessRunner), and hands back a
 * `byte-stream` PipelineData. The block-runner streams that as a `text` block —
 * builtins stay structured tables, external programs are text.
 *
 * `createExternalResolver()` returns the `resolveExternal` hook the EvalContext
 * carries, so the pure interpreter core never imports child_process: the
 * process edge stays behind this external/ boundary.
 */

import type { Command, Expression } from '../core/ast';
import { EvalError } from '../core/errors';
import type { EvalContext } from '../core/types';
import { byteStreamData, ptyStreamData } from '../core/value';
import type { PipelineData } from '../core/value';
import { buildCmdLine } from './build-cmd-line';
import { CommandResolver, envGet } from './command-resolver';
import { runProcess, type SpawnFn } from './process-runner';
import { runPty, ptyArgv, ptyCommandLine, type PtySpawnFn } from './pty-runner';

/** ANSI red, used to surface a non-zero exit code in the streamed output. */
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** Render one parsed argument expression back to a raw external argv string. */
function exprToArg(expr: Expression, commandName: string): string {
  switch (expr.type) {
    case 'string':
      return expr.value;
    case 'number':
      return String(expr.value);
    case 'identifier':
      return expr.name;
    case 'bool':
      return String(expr.value);
    case 'null':
      return 'null';
    case 'filesize':
      return String(expr.bytes);
    case 'variable':
    case 'env':
      // Variable/env references in external argv are a later increment; resolving
      // them needs the eval context the bare reconstruction path does not carry.
      throw new EvalError(
        `variable references are not yet supported as arguments to '${commandName}'`,
        expr.span,
      );
    case 'binary':
      throw new EvalError(
        `comparison expressions are not valid arguments to '${commandName}'`,
        expr.span,
      );
  }
}

/**
 * Reconstruct the external argv from a parsed command. Positionals map to their
 * literal text; flags map to `--name` / `-name` followed by their value (if any).
 */
export function commandToArgv(command: Command): string[] {
  const argv: string[] = [];
  for (const arg of command.args) {
    if (arg.kind === 'positional') {
      argv.push(exprToArg(arg.expr, command.name));
    } else {
      argv.push((arg.short ? '-' : '--') + arg.name);
      if (arg.value) argv.push(exprToArg(arg.value, command.name));
    }
  }
  return argv;
}

/**
 * Build the `resolveExternal` hook. Spawning is lazy — it happens when the
 * returned byte stream is first iterated (or, for PTY, when the renderer spawns
 * at its initial size), so `evaluate()` stays synchronous and cancellable.
 * `spawn` / `ptySpawn` are injectable for tests (the Adapter seams).
 */
export function createExternalResolver(
  spawn?: SpawnFn,
  ptySpawn?: PtySpawnFn,
): (
  command: Command,
  ctx: EvalContext,
  opts?: { interactive?: boolean; forceXterm?: boolean },
) => PipelineData {
  return function resolveExternal(
    command: Command,
    ctx: EvalContext,
    opts?: { interactive?: boolean; forceXterm?: boolean },
  ): PipelineData {
    const userArgs = commandToArgv(command);

    // Interactive (auto-routed for a bare single command, or `!cmd` forceXterm) →
    // full-screen PTY/TUI. Resolve eagerly so a not-found target surfaces
    // synchronously; hand back a lazily-spawned pty-stream.
    if (opts?.interactive) {
      const resolver = new CommandResolver(ctx.env);
      const spec = resolver.resolve(command.name, userArgs);
      if (!spec) {
        throw new EvalError(`command not found: ${command.name}`, command.nameSpan);
      }
      if (spec.shell) {
        // M1: batch (.bat/.cmd) shim PTY spawn. node-pty's argv-array path has no
        // cross-spawn-equivalent escaping (SEC-HIGH-1), so this goes through
        // node-pty's Windows single-string args path instead — cmd.exe as `file`,
        // a pre-escaped command line built by buildCmdLine() (ported from
        // cross-spawn's own vetted algorithm) as `args`.
        const comspecName = envGet(ctx.env, 'ComSpec') ?? 'cmd.exe';
        const cmdSpec = resolver.resolve(comspecName, []);
        if (!cmdSpec) {
          throw new EvalError(`cmd.exe not found (ComSpec='${comspecName}')`, command.nameSpan);
        }
        return ptyStreamData(
          (cols, rows) =>
            runPty(
              cmdSpec.file,
              ptyCommandLine(buildCmdLine(spec.file, spec.args)),
              { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal, cols, rows },
              ptySpawn,
            ),
          opts.forceXterm,
        );
      }
      return ptyStreamData(
        (cols, rows) =>
          runPty(
            spec.file,
            ptyArgv(spec.args),
            { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal, cols, rows },
            ptySpawn,
          ),
        opts.forceXterm,
      );
    }

    async function* bytes(): AsyncGenerator<Uint8Array> {
      const resolver = new CommandResolver(ctx.env);
      const spec = resolver.resolve(command.name, userArgs);
      if (!spec) {
        throw new EvalError(`command not found: ${command.name}`, command.nameSpan);
      }

      const proc = runProcess(
        spec.file,
        spec.args,
        { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal, killTree: spec.shell },
        spawn,
      );

      for await (const chunk of proc.bytes) {
        yield chunk;
      }

      // A non-zero exit still shows its output; surface the code as a final line.
      // (Skipped on cancel — the block reports `cancelled`, not an exit code.)
      if (ctx.signal.aborted) return;
      const { code } = await proc.exit;
      if (code !== null && code !== 0) {
        yield new TextEncoder().encode(`\n${RED}[process exited with code ${code}]${RESET}\n`);
      }
    }

    return byteStreamData(bytes());
  };
}
