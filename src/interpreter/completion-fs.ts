/**
 * The real filesystem behind Tab completion: a folder's entries and the
 * executables on PATH, read asynchronously within a time budget so a slow or
 * huge folder never stalls the interpreter (its event loop serves every
 * terminal session).
 */

import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CompletionEntry, CompletionSource } from './core/complete';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
export const COMPLETION_BUDGET_MS = 300;
export const COMPLETION_MAX_ENTRIES = 2_000;
const PATH_FOLDER_MAX_ENTRIES = 5_000;
const PATH_CACHE_MS = 60_000;

type Environment = Readonly<Record<string, string | undefined>>;

function envValue(env: Environment, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

export function executableExtensions(env: Environment): string[] {
  return (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').map((ext) => ext.trim().toLowerCase()).filter(Boolean);
}

/** Up to `maxEntries` entries of a folder; a link or junction counts as a folder when it points at one. */
export async function listCompletionDirectory(
  folder: string,
  deadline: number,
  maxEntries = COMPLETION_MAX_ENTRIES,
): Promise<CompletionEntry[] | null> {
  const entries: CompletionEntry[] = [];
  try {
    const handle = await opendir(folder);
    for await (const entry of handle) {
      if (entries.length >= maxEntries || Date.now() > deadline) break;
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { directory = (await stat(path.join(folder, entry.name))).isDirectory(); } catch { /* A broken link is a file. */ }
      }
      entries.push({ name: entry.name, directory });
    }
  } catch {
    return null;
  }
  return entries;
}

const pathCache = new Map<string, { readonly at: number; readonly names: readonly string[] }>();

/** Executable names on PATH (extension removed), remembered for a minute per PATH and PATHEXT. */
export async function listPathExecutables(env: Environment, deadline: number, now: () => number = Date.now): Promise<readonly string[]> {
  const pathValue = envValue(env, 'PATH') ?? '';
  const extensions = executableExtensions(env);
  const key = `${pathValue}\0${extensions.join(';')}`;
  const cached = pathCache.get(key);
  if (cached && now() - cached.at < PATH_CACHE_MS) return cached.names;
  const seen = new Set<string>();
  const names: string[] = [];
  let complete = true;
  for (const folder of pathValue.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)) {
    if (Date.now() > deadline) { complete = false; break; }
    // Network folders on PATH can stall; they are skipped.
    if (folder.startsWith('\\\\') || folder.startsWith('//')) continue;
    const entries = await listCompletionDirectory(folder, deadline, PATH_FOLDER_MAX_ENTRIES);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.directory) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.includes(ext)) continue;
      const name = entry.name.slice(0, entry.name.length - ext.length);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  if (complete) {
    pathCache.clear();
    pathCache.set(key, { at: now(), names });
  }
  return names;
}

/** The completion source for one session: its folder, its environment, the builtin names. */
export function completionSource(input: {
  readonly cwd: string;
  readonly env: Environment;
  readonly builtins: readonly string[];
  readonly budgetMs?: number;
}): CompletionSource {
  const deadline = Date.now() + (input.budgetMs ?? COMPLETION_BUDGET_MS);
  return {
    cwd: input.cwd,
    builtins: input.builtins,
    executableExtensions: executableExtensions(input.env),
    listDirectory: (absolute) => listCompletionDirectory(absolute, deadline),
    pathExecutables: () => listPathExecutables(input.env, deadline),
  };
}
