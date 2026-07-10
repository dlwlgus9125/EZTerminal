/**
 * shim-resolver — de-sugar an npm `.cmd`/`.bat` shim to its direct-spawn target.
 *
 * `claude`/`codex` are npm global shims (`cmd-shim`-generated batch files) that
 * `external-command.ts` currently runs as `cmd.exe /d /s /c "claude.cmd …"`
 * (command-resolver.ts's `shell: true` path). That puts `cmd.exe` in the
 * ConPTY console process group, so Ctrl+C (`\x03`) fires a group
 * `CTRL_C_EVENT` that kills the whole tree — including the agent process
 * itself — instead of a clean, cancellable interrupt.
 *
 * npm's shim generator emits two shapes on the final launch line (verified
 * against real installed shims — `%APPDATA%\npm\claude.cmd`,
 * `%APPDATA%\npm\codex.cmd`, `node_modules\.bin\eslint.CMD`):
 *   - **direct form**: `"%dp0%\<path>\target.exe"   %*` — spawn the `.exe` directly.
 *   - **node form**: an `IF EXIST "%dp0%\node.exe"` / `_prog` block, then
 *     `"%_prog%"  "%dp0%\<path>\cli.js" %*` — spawn `node.exe` directly with
 *     the absolute script path prepended.
 * This module recognizes only those two shapes and de-sugars them to a direct
 * spawn target, so the caller can skip `cmd.exe` entirely. Anything it doesn't
 * confidently recognize (yarn-classic, npx/`pnpm dlx` resolver shims, or any
 * other batch logic) returns `null` — the caller keeps the existing cmd.exe
 * fallback rather than risk mis-parsing a shim it doesn't understand.
 */

import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';

import { CommandResolver, type EnvLike } from './command-resolver';

export interface ShimTarget {
  /** Absolute path to spawn directly: node.exe (node form) or the target .exe (direct form). */
  readonly file: string;
  /** Args to PREPEND before the user's args. node form: [absolute cli path]. direct form: []. */
  readonly prefixArgs: readonly string[];
}

// The node-form launch line always pairs TWO adjacent quoted tokens before
// `%*`: the node program (`%_prog%`, or a literal `...\node.exe` path — the
// `[\\/]` anchor requires "node.exe" to be its own path segment, so a target
// like `notnode.exe` can't false-match) and the script target (`.js`/`.mjs`/
// `.cjs`, or an extensionless `\run` — npm cmd-shim's convention for an
// extensionless entry-point file). Matching that pair — rather than trying to
// model every IF/ELSE branch a given npm version emits — is what lets the
// same regex cover both the `_prog`-variable shim shape (codex.cmd) and the
// plain-`node.exe`-check shape (node_modules/.bin/*.cmd).
const NODE_FORM_RE =
  /"(?:%_prog%|[^"]*?[\\/]node\.exe)"\s+"([^"]+(?:\.(?:m?js|cjs)|[\\/]run))"\s+%\*/i;

// Direct form has a single quoted target immediately followed by `%*` — no
// second quoted token, which is what distinguishes it from node form's
// node.exe token (that one is always followed by ANOTHER quoted token, not
// `%*` directly).
const DIRECT_FORM_RE = /"([^"]+\.(?:exe|com))"\s+%\*/i;

// `%dp0%` (a SET variable, closed by a trailing `%`) and `%~dp0` (the `%~dp0`
// batch parameter-modifier syntax, which has NO trailing `%`) are both used by
// real shims (codex.cmd vs. eslint.CMD respectively) — order matters so the
// `%dp0%` alt doesn't shadow itself into a dangling `%`.
const DP0_RE = /%dp0%|%~dp0/gi;

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Expand `%dp0%`/`%~dp0%` to the shim's own directory, then collapse `..`. */
function expandDp0(macroPath: string, dp0: string): string {
  return normalize(macroPath.replace(DP0_RE, dp0));
}

/**
 * De-sugar a resolved .cmd/.bat npm shim to its underlying direct-spawn target so
 * the agent runs WITHOUT a cmd.exe wrapper (…why: Ctrl+C tree-kill, see module doc).
 * Returns null for anything not confidently recognized → caller keeps the cmd.exe
 * fallback.
 */
export function resolveShimTarget(
  shimPath: string,
  env: EnvLike,
  readFile?: (p: string) => string,
  resolver?: CommandResolver,
  exists?: (p: string) => boolean,
): ShimTarget | null {
  const ext = extname(shimPath).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return null;

  const read = readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const checkExists = exists ?? fileExists;
  let text: string;
  try {
    text = read(shimPath);
  } catch {
    return null;
  }

  const dp0 = dirname(shimPath);

  const nodeMatch = NODE_FORM_RE.exec(text);
  if (nodeMatch) {
    const target = expandDp0(nodeMatch[1], dp0);
    const localNode = join(dp0, 'node.exe');
    if (checkExists(localNode)) {
      return { file: localNode, prefixArgs: [target] };
    }
    // Otherwise defer to whatever `node` resolves to on PATH — same as the
    // shim's own ELSE branch. If PATH itself resolves `node` to ANOTHER shim
    // (shell: true), we'd be back to square one, so that's an unconfident
    // result → null.
    const res = resolver ?? new CommandResolver(env);
    const spec = res.resolve('node', []);
    if (!spec || spec.shell) return null;
    return { file: spec.file, prefixArgs: [target] };
  }

  const directMatch = DIRECT_FORM_RE.exec(text);
  if (directMatch) {
    const target = expandDp0(directMatch[1], dp0);
    // A real npm shim's %dp0%-expanded target is always absolute; anything
    // else is unconfident (and, left unchecked, would spawn cwd-relative) →
    // null. Likewise a mis-installed target (existence check) falls back to
    // the caller's cmd.exe path instead of erroring on spawn.
    if (!isAbsolute(target)) return null;
    if (!checkExists(target)) return null;
    return { file: target, prefixArgs: [] };
  }

  return null;
}
