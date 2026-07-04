/**
 * Process listing source for the `ps` builtin (architecture §7).
 *
 * Two parsers back the same {@link ProcessInfo} row shape, dispatched on
 * `process.platform` (see {@link createProcessLister}):
 *   - {@link parseTasklistCsv} parses Windows `tasklist /fo csv /nh` (pid/name/mem
 *     plus the "Session Name" column, e.g. `Console` / `Services`).
 *   - {@link parsePosixPs} parses `ps -eo pid=,rss=,tty=,comm=` on darwin/linux.
 *     `-eo` (select-all, custom columns) and the `pid`/`rss`/`tty`/`comm` keywords
 *     are supported identically by BOTH GNU/Linux procps and BSD/macOS ps, unlike
 *     `aux`-style output whose column layout differs between the two. The `=`
 *     suffix on each column suppresses the header row on both. `tty` fills the
 *     `sessionName` slot — the closest POSIX analog to Windows' Session Name: which
 *     terminal (if any) the process is attached to, `?`/`-` for daemons.
 *
 * Both raw-output parsers are PURE (no IO), unit-tested against known samples.
 * {@link createProcessLister} takes an injectable runner and, for tests only, a
 * `platform` override, so a test can stub the command output and exercise the
 * POSIX parser even on a Windows box (real POSIX execution can't be verified here).
 *
 * SECURITY: the OS command runs with a fixed ARGS ARRAY (`execFile`, no shell
 * string) and takes no user input, so there is no shell-injection surface.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessInfo } from '../core/types';

const execFileAsync = promisify(execFile);

/** Produces the raw process-listing command text (adapter seam for tests + platforms). */
export type ProcessListRunner = () => Promise<string>;

/** Default runner: Windows `tasklist` as CSV with no header line, no shell. */
const defaultWindowsRunner: ProcessListRunner = async () => {
  const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], {
    windowsHide: true,
    // Process tables can be large on a busy machine — give the buffer headroom.
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

/** Default runner: POSIX `ps` (darwin/linux), no shell. */
const defaultPosixRunner: ProcessListRunner = async () => {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,rss=,tty=,comm='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

/**
 * Parse ONE CSV line into its fields. `tasklist /fo csv` fully quotes every field,
 * so embedded commas (`"weird,name.exe"`) and doubled quotes (`"a""b"` → `a"b`) are
 * decoded correctly rather than naively split on `,`.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    let field = '';
    if (line[i] === '"') {
      i++; // consume the opening quote
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"'; // an escaped (doubled) quote
            i += 2;
            continue;
          }
          i++; // consume the closing quote
          break;
        }
        field += ch;
        i++;
      }
      // Skip any stray characters until the next delimiter (tasklist has none).
      while (i < n && line[i] !== ',') i++;
    } else {
      while (i < n && line[i] !== ',') {
        field += line[i];
        i++;
      }
    }
    fields.push(field);
    if (i < n && line[i] === ',') i++; // consume the field separator
  }
  return fields;
}

/** Parse a memory cell like `"45,678 K"` / `"8 K"` into a plain kilobyte count. */
function parseMemoryKb(cell: string): number {
  const digits = cell.replace(/[^\d]/g, '');
  const kb = Number.parseInt(digits, 10);
  return Number.isFinite(kb) ? kb : 0;
}

/**
 * Parse `tasklist /fo csv /nh` output into {@link ProcessInfo} rows. Columns are
 * `Image Name, PID, Session Name, Session#, Mem Usage`. Lines that do not carry a
 * numeric PID are skipped (defensive against locale/format drift).
 */
export function parseTasklistCsv(csv: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    const pid = Number.parseInt(fields[1], 10);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      pid,
      name: fields[0],
      sessionName: fields[2] ?? '',
      memoryKb: fields.length >= 5 ? parseMemoryKb(fields[4]) : 0,
    });
  }
  return rows;
}

/**
 * Parse `ps -eo pid=,rss=,tty=,comm=` output into {@link ProcessInfo} rows. Columns
 * are whitespace-separated and unquoted, so `comm` (the last column, and the only
 * one that can contain spaces) is reconstructed by re-joining every token past the
 * first three (pid, rss, tty). Lines that don't start with two numeric tokens (pid,
 * rss) are skipped (defensive against odd locale/format output).
 */
export function parsePosixPs(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const pid = Number.parseInt(tokens[0], 10);
    const memoryKb = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(memoryKb)) continue;
    const name = tokens.slice(3).join(' ');
    if (!name) continue;
    rows.push({ pid, name, sessionName: tokens[2], memoryKb });
  }
  return rows;
}

/**
 * Build the `() => Promise<ProcessInfo[]>` source `ps` consumes. `run` is injectable
 * so tests stub the raw output; `platform` defaults to `process.platform` and is
 * overridable ONLY so a test can exercise the POSIX parser on a non-POSIX box (the
 * production call site never passes it). win32 keeps the exact `tasklist` path;
 * darwin/linux dispatch to the `ps` path.
 */
export function createProcessLister(
  run?: ProcessListRunner,
  platform: NodeJS.Platform = process.platform,
): () => Promise<readonly ProcessInfo[]> {
  const isWindows = platform === 'win32';
  const runner = run ?? (isWindows ? defaultWindowsRunner : defaultPosixRunner);
  const parse = isWindows ? parseTasklistCsv : parsePosixPs;
  return async () => parse(await runner());
}
