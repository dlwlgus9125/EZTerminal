/**
 * CommandResolver — Windows-first executable resolution (architecture §7).
 *
 * Resolves a bare command name (`node`, `git`, `mytool`) to a concrete launch
 * spec using PATH + PATHEXT, honoring Windows realities:
 *   - PATHEXT decides which extension wins (`.EXE` before `.CMD`, etc.) and in
 *     what order, so `node` finds `node.exe` without the user typing `.exe`.
 *   - `.bat` / `.cmd` scripts CANNOT be spawned directly (Node throws EINVAL and
 *     direct spawning is a documented security hazard) — they must run through the
 *     command interpreter. The resolver returns the RAW resolved script path and
 *     flags it `shell: true`; the ProcessRunner spawns it via `cross-spawn`, which
 *     applies the `cmd.exe` wrapping AND correct per-argument `^`-escaping. Hand-
 *     rolling `cmd.exe /d /s /c <file> <userArgs>` here would inject on
 *     `& | < > ^ "` (SEC-HIGH-1) and bypass Node's CVE-2024-27980 mitigation.
 *   - `.exe` / `.com` are spawned directly with an args array (never a shell
 *     string), so there is no shell-quoting/injection surface.
 *
 * Resolution is synchronous (`existsSync`-style probes) — it is cheap and lets a
 * not-found command surface as a clean error. Spawning is the side effect, done
 * later by the ProcessRunner (kept behind the same external/ boundary so the
 * whole edge can be swapped for node-pty in phase 2).
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export type EnvLike = Record<string, string | undefined>;

/** A concrete process launch: the executable to spawn + the full argv. */
export interface LaunchSpec {
  /** File to spawn: the resolved `.exe`/`.com`, or the raw `.bat`/`.cmd` path. */
  readonly file: string;
  /** The user's args, UNESCAPED — cross-spawn quotes them for shell targets. */
  readonly args: string[];
  /**
   * True for `.bat`/`.cmd` targets. They run under `cmd.exe`, but the wrapping and
   * per-arg escaping are delegated to cross-spawn in the ProcessRunner (SEC-HIGH-1).
   * Shell targets also need a child-TREE kill on cancel — killing only `cmd.exe`
   * would orphan its grandchildren on Windows (SEC-LOW-6).
   */
  readonly shell: boolean;
}

/** Windows default when PATHEXT is unset (same order as cmd.exe). */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Case-insensitive env lookup — `{...process.env}` loses Windows' case folding. */
export function envGet(env: EnvLike, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class CommandResolver {
  constructor(private readonly env: EnvLike) {}

  private pathext(): string[] {
    return (envGet(this.env, 'PATHEXT') ?? DEFAULT_PATHEXT)
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  /**
   * Resolve `name` + `userArgs` into a launch spec, or null if the executable is
   * not found on PATH (so the caller can surface a clean "command not found").
   */
  resolve(name: string, userArgs: readonly string[]): LaunchSpec | null {
    const resolvedPath = this.resolvePath(name);
    if (!resolvedPath) return null;
    return this.toLaunchSpec(resolvedPath, userArgs);
  }

  private toLaunchSpec(file: string, userArgs: readonly string[]): LaunchSpec {
    const ext = extname(file).toLowerCase();
    const isBatch = ext === '.bat' || ext === '.cmd';
    // Batch scripts run via the command interpreter — never spawned directly. We
    // hand the RAW resolved path + the user's args (unescaped) to the ProcessRunner,
    // which spawns through cross-spawn; cross-spawn applies the `cmd.exe /d /s /c`
    // wrapping AND escapes every arg (`& | < > ^ "`) so a malicious arg can't inject
    // a second command (SEC-HIGH-1). Native `.exe`/`.com` spawn directly with an
    // args array (no shell string) — no quoting/injection surface.
    return { file, args: [...userArgs], shell: isBatch };
  }

  private resolvePath(name: string): string | null {
    const pathext = this.pathext();
    const hasExt = extname(name) !== '';

    // An explicit path (absolute or containing a separator) is probed directly.
    if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
      return this.probe(name, pathext, hasExt);
    }

    for (const dir of (envGet(this.env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
      const hit = this.probe(join(dir, name), pathext, hasExt);
      if (hit) return hit;
    }
    return null;
  }

  /** Probe one base path: by PATHEXT candidates (extensionless) or directly. */
  private probe(base: string, pathext: string[], hasExt: boolean): string | null {
    if (hasExt) return fileExists(base) ? base : null;
    for (const ext of pathext) {
      const candidate = base + ext;
      if (fileExists(candidate)) return candidate;
    }
    // Fall back to an extensionless executable (POSIX-style) if present.
    return fileExists(base) ? base : null;
  }
}
