import { promises as fs } from 'node:fs';

import { GitCommandError, type GitRunner } from './worktree-service';

/** What a work folder must hold for nothing of a person's to be lost when it goes. */
export interface DisposableExpectation {
  /** The commit HEAD must be at (an attempt's base, a validated result, ...). */
  readonly head: string;
  /** The tree the index must equal (the result commit, or the HEAD commit when there is none). */
  readonly tree: string;
  /** A commit HEAD may already be detached at (a cleanup that stopped after detaching). */
  readonly detachedAt?: string;
}
export type Disposability = { readonly disposable: true } | { readonly disposable: false; readonly reason: string };

/** No pager, no hooks, no fsmonitor, no optional index writes: the check changes nothing. */
const SAFE = ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false'] as const;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock'] as const;

/**
 * Whether a work folder may be removed without losing anything that is not kept by Git: every condition must hold,
 * and any check that fails, times out or is cut short keeps the folder. Ignored files count as a person's files (an
 * `.env`, notes): any file Git does not track keeps it. So does Git work in progress, a sparse checkout, index entries
 * whose changes Git would not see (skip-worktree, assume-unchanged), a submodule or nested repository, and Git LFS
 * (its content is not kept by the commits alone). Reads only.
 */
export async function judgeDisposable(git: Pick<GitRunner, 'run'>, folder: string, expected: DisposableExpectation): Promise<Disposability> {
  const run = (args: readonly string[]) => git.run(folder, [...SAFE, ...args]);
  const keep = (reason: string): Disposability => ({ disposable: false, reason });
  try {
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (head !== expected.head && head !== expected.detachedAt) return keep('Its HEAD is not where this run left it.');
    for (const name of IN_PROGRESS) {
      if (await exists((await run(['rev-parse', '--path-format=absolute', '--git-path', name])).trim())) return keep(`Git work is in progress there (${name}).`);
    }
    if ((await run(['config', '--bool', '--default', 'false', 'core.sparseCheckout'])).trim() !== 'false') return keep('It is a sparse checkout.');
    if ((await run(['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some(line => line[0] !== 'H')) return keep('Some files are set so that Git does not check them.');
    if ((await run(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).some(line => line.startsWith('160000 '))) return keep('It has a submodule.');
    // Untracked and ignored alike (no exclude rules): any file Git does not keep.
    if ((await run(['ls-files', '--others', '-z'])).length > 0) return keep('It has files Git does not keep (untracked or ignored).');
    if (await differs(run, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--'])) return keep('It has changes not added to Git.');
    if (await differs(run, ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', expected.tree, '--'])) return keep('Its staged files are not exactly this run’s result.');
    if (await usesLfs(run, [...new Set([expected.head, expected.tree, ...(expected.detachedAt ? [expected.detachedAt] : [])])])) return keep('It uses Git LFS.');
    return { disposable: true };
  } catch {
    return keep('It could not be checked.');
  }
}

/** `--quiet` diffs exit 1 when they differ; anything else is an error (and keeps the folder). */
async function differs(run: (args: readonly string[]) => Promise<string>, args: readonly string[]): Promise<boolean> {
  try { await run(args); return false; } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return true;
    throw error;
  }
}

/** Git LFS named by any attributes in these commits' trees, the repository's own attributes or the user's attributes file. */
async function usesLfs(run: (args: readonly string[]) => Promise<string>, commits: readonly string[]): Promise<boolean> {
  for (const commit of commits) {
    try {
      if ((await run(['grep', '-I', '-l', '--no-color', '-e', 'filter=lfs', commit, '--', ':(glob)**/.gitattributes'])).trim()) return true;
    } catch (error) {
      if (!(error instanceof GitCommandError && error.exitCode === 1)) throw error;
    }
  }
  const local = (await run(['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'])).trim();
  let global = '';
  try { global = (await run(['config', '--path', '--get', 'core.attributesFile'])).trim(); } catch (error) {
    if (!(error instanceof GitCommandError && error.exitCode === 1)) throw error;
  }
  for (const file of [local, global].filter(Boolean)) {
    const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (text.includes('filter=lfs')) return true;
  }
  return false;
}

async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
