/**
 * buildCmdLine — cmd.exe command-line assembly for batch (.bat/.cmd) shim PTY
 * spawns (M1, plan §M1 / M0b gate item 1).
 *
 * node-pty's argv-array spawn path re-quotes every element itself
 * (`argsToCommandLine`, node_modules/node-pty/lib/windowsPtyAgent.js) with no
 * `windowsVerbatimArguments` escape hatch, so handing it an already-escaped batch
 * command line would double-escape. node-pty's Windows *single-string* args path
 * (node_modules/node-pty/typings/node-pty.d.ts:10-18) instead takes a pre-escaped
 * CommandLine verbatim — this module is the only place that builds that string,
 * so it is the single source of truth for batch-shim quoting safety.
 *
 * The escaping algorithm is PORTED from cross-spawn (node_modules/cross-spawn/lib/
 * parse.js + util/escape.js) — the same vetted algorithm ProcessRunner already
 * relies on for the non-PTY batch path, via cross-spawn directly. It is not
 * reinvented here: hand-rolled cmd.exe quoting is exactly the SEC-HIGH-1 /
 * CVE-2024-27980 injection trap the resolver's own docs warn about
 * (command-resolver.ts:11-16).
 */

import path from 'node:path';

// cmd.exe metacharacters that need `^`-escaping — both outside AND (per
// cross-spawn) inside the surrounding double quotes, because the whole shell
// command is itself wrapped in one more layer of quoting (`/c "..."`) that an
// outer cmd.exe pass interprets before the inner quotes take effect.
const META_CHARS_RE = /([()\][%!^"`<>&|;, *?])/g;

// A cmd-shim installed by npm under node_modules/.bin/*.cmd invokes its target
// via NodeJS, proxying arguments through cmd.exe's OWN `^`-unescaping as a
// second pass. Arguments to these shims therefore need escaping twice — same
// rule as cross-spawn's parse.js.
const CMD_SHIM_RE = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function escapeCommand(command: string): string {
  return command.replace(META_CHARS_RE, '^$1');
}

/**
 * Escape one argument for cmd.exe. Ported verbatim from cross-spawn's
 * util/escape.js (algorithm based on https://qntm.org/cmd), including the
 * backslash handling's lookahead-then-backreference shape — that shape
 * specifically avoids catastrophic regex backtracking on crafted backslash runs
 * (see moxystudio/node-cross-spawn#160).
 */
function escapeArgument(rawArg: string, doubleEscapeMetaChars: boolean): string {
  let arg = rawArg;
  // A run of backslashes immediately followed by a double quote: double the
  // backslashes and escape the quote.
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // A run of backslashes at the end of the string (which becomes the closing
  // quote's escape prefix once we quote below): double them too.
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(META_CHARS_RE, '^$1');
  if (doubleEscapeMetaChars) {
    arg = arg.replace(META_CHARS_RE, '^$1');
  }
  return arg;
}

/**
 * Build the full `/d /s /c "<shellCommand>"` command-line string for a batch
 * (.bat/.cmd) target, ready to hand to node-pty's Windows single-string `args`
 * path (paired with spawning `cmd.exe` as `file`). Matches the shape cross-spawn
 * produces for the same target — `/d` skips cmd's AutoRun registry key so a
 * hijacked AutoRun can't inject commands.
 */
export function buildCmdLine(file: string, args: readonly string[]): string {
  const doubleEscape = CMD_SHIM_RE.test(file);
  const escapedCommand = escapeCommand(path.normalize(file));
  const escapedArgs = args.map((arg) => escapeArgument(arg, doubleEscape));
  const shellCommand = [escapedCommand, ...escapedArgs].join(' ');
  return `/d /s /c "${shellCommand}"`;
}
