import { promises as fs } from 'node:fs';
import path from 'node:path';

import { GitCommandError, type GitRunner } from './worktree-service';

/** What a work folder must hold for nothing of a person's to be lost when it goes. */
export interface DisposableExpectation {
  /** The commit HEAD must be at (an attempt's base, a validated result, ...). */
  readonly head: string;
  /** The tree the index must equal (the result commit, or the HEAD commit when there is none). */
  readonly tree: string;
  /** A commit HEAD may already be detached at (a cleanup that stopped after detaching). */
  readonly detachedAt?: string;
  /** The shared ref that keeps the run's result once the folder is gone: it must still name exactly this commit. */
  readonly keptRef?: { readonly name: string; readonly commit: string };
}
/** Why a folder stays, for screens to word (`reason` is the host's own English). */
export type KeepCode = 'head-moved' | 'git-in-progress' | 'sparse' | 'unchecked-entries' | 'submodule' | 'nested-repository' | 'untracked' | 'changed' | 'staged-differs' | 'lfs' | 'filter' | 'result-mismatch' | 'unchecked';
export type Disposability = { readonly disposable: true } | { readonly disposable: false; readonly code: KeepCode; readonly reason: string };

/** No pager, no hooks, no fsmonitor, no optional index writes: the check changes nothing. */
const SAFE = ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false'] as const;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock'] as const;
/** Past this many entries the folder is not walked for nested repositories (and stays). */
const WALK_LIMIT = 100_000;

/**
 * Whether a work folder may be removed without losing anything that is not kept by Git: every condition must hold,
 * and any check that fails, times out or is cut short keeps the folder. Ignored files count as a person's files (an
 * `.env`, notes): any file Git does not track keeps it. So does Git work in progress, a sparse checkout, index entries
 * whose changes Git would not see (skip-worktree, assume-unchanged), a submodule or nested repository, and Git LFS
 * (its content is not kept by the commits alone). Reads only.
 */
export async function judgeDisposable(git: Pick<GitRunner, 'run'>, folder: string, expected: DisposableExpectation): Promise<Disposability> {
  const run = (args: readonly string[]) => git.run(folder, [...SAFE, ...args]);
  const keep = (code: KeepCode, reason: string): Disposability => ({ disposable: false, code, reason });
  try {
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (head !== expected.head && head !== expected.detachedAt) return keep('head-moved', 'Its HEAD is not where this run left it.');
    for (const name of IN_PROGRESS) {
      if (await exists((await run(['rev-parse', '--path-format=absolute', '--git-path', name])).trim())) return keep('git-in-progress', `Git work is in progress there (${name}).`);
    }
    if ((await run(['config', '--bool', '--default', 'false', 'core.sparseCheckout'])).trim() !== 'false') return keep('sparse', 'It is a sparse checkout.');
    if ((await run(['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some(line => line[0] !== 'H')) return keep('unchecked-entries', 'Some files are set so that Git does not check them.');
    if ((await run(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).some(line => line.startsWith('160000 '))) return keep('submodule', 'It has a submodule.');
    // Untracked and ignored alike (no exclude rules): any file Git does not keep.
    if ((await run(['ls-files', '--others', '-z'])).length > 0) return keep('untracked', 'It has files Git does not keep (untracked or ignored).');
    // Git never lists a .git inside a tracked folder: a repository of the person's own there would go with the folder.
    const nested = await nestedRepository(folder);
    if (nested !== false) return nested === 'unchecked' ? keep('unchecked', 'It is too large to check.') : keep('nested-repository', 'It holds a Git repository of its own.');
    if (await usesLfs(run, [...new Set([expected.head, expected.tree, ...(expected.detachedAt ? [expected.detachedAt] : [])])])) return keep('lfs', 'It uses Git LFS.');
    // A file with any filter (set or named: filter=mydriver) makes Git run that program to compare or remove it.
    if (await filtered(run)) return keep('filter', 'Git runs a filter program on some of its files.');
    if (await differs(run, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--'])) return keep('changed', 'It has changes not added to Git.');
    if (await differs(run, ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', expected.tree, '--'])) return keep('staged-differs', 'Its staged files are not exactly this run’s result.');
    if (expected.keptRef) {
      const kept = await run(['rev-parse', '--verify', '--quiet', expected.keptRef.name]).then(value => value.trim(), (error: unknown) => {
        if (error instanceof GitCommandError && error.exitCode === 1) return '';
        throw error;
      });
      if (kept !== expected.keptRef.commit) return keep('result-mismatch', 'Its kept result does not match its record.');
    }
    return { disposable: true };
  } catch {
    return keep('unchecked', 'It could not be checked.');
  }
}

/** `--quiet` diffs exit 1 when they differ; anything else is an error (and keeps the folder). */
async function differs(run: (args: readonly string[]) => Promise<string>, args: readonly string[]): Promise<boolean> {
  try { await run(args); return false; } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return true;
    throw error;
  }
}

/** Whether any folder below the top holds a `.git` (links are not followed); 'unchecked' past WALK_LIMIT entries. */
async function nestedRepository(folder: string): Promise<boolean | 'unchecked'> {
  const pending = [folder];
  let seen = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++seen > WALK_LIMIT) return 'unchecked';
      if (entry.name.toLowerCase() === '.git') { if (directory !== folder) return true; continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(directory, entry.name));
    }
  }
  return false;
}

/**
 * Git LFS anywhere it could apply: attributes in these commits' trees, the effective attributes of the index (the
 * repository's, the person's own and the system's), any attributes file naming the LFS filter, or LFS storage set to
 * a folder of its own.
 */
async function usesLfs(run: (args: readonly string[]) => Promise<string>, commits: readonly string[]): Promise<boolean> {
  if ((await run(['ls-files', '-z', '--', ':(attr:filter=lfs)'])).length > 0) return true;
  if (await optional(run, ['config', '--get', 'lfs.storage'])) return true;
  for (const commit of commits) {
    try {
      if ((await run(['grep', '-I', '-l', '--no-color', '-e', 'filter=lfs', commit, '--', ':(glob)**/.gitattributes'])).trim()) return true;
    } catch (error) {
      if (!(error instanceof GitCommandError && error.exitCode === 1)) throw error;
    }
  }
  const local = (await run(['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'])).trim();
  // Where Git itself reads the person's and the system's attributes (core.attributesFile, else the XDG default).
  const global = (await run(['var', 'GIT_ATTR_GLOBAL'])).trim();
  const system = (await run(['var', 'GIT_ATTR_SYSTEM'])).trim();
  for (const file of [local, global, system].filter(Boolean)) {
    const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (text.includes('filter=lfs')) return true;
  }
  return false;
}

/** Whether any tracked file has the filter attribute set or named: every file is either unspecified or explicitly unset otherwise. */
async function filtered(run: (args: readonly string[]) => Promise<string>): Promise<boolean> {
  const count = async (pathspec?: string) => (await run(['ls-files', '-z', ...(pathspec ? ['--', pathspec] : [])])).split('\0').filter(Boolean).length;
  return await count() !== await count(':(attr:!filter)') + await count(':(attr:-filter)');
}

/** A value that may be unset (exit 1 = unset; anything else is an error). */
async function optional(run: (args: readonly string[]) => Promise<string>, args: readonly string[]): Promise<string> {
  try { return (await run(args)).trim(); } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return '';
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
