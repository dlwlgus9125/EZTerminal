import { GitCommandError, GitRunner } from './worktree-service';

/**
 * Where a worktree workspace stands, for the project tree:
 * `review` — uncommitted changes, or commits its base does not have yet;
 * `done` — its work is merged into the base (a merge commit has it as a parent);
 * neither — a fresh worktree with nothing in it yet.
 */
export interface WorkspaceWorktreeStatus {
  readonly workspaceId: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly merged: boolean;
  readonly status?: 'review' | 'done';
}

export interface WorkspaceWorktreeTarget {
  readonly workspaceId: string;
  /** The worktree's own checkout. */
  readonly rootPath: string;
  /** The project's main checkout, where the base branch lives. */
  readonly mainRoot: string;
}

export type WorkspaceWorktreeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'dirty-worktree' | 'dirty-main' | 'nothing-to-merge' | 'conflict' | 'not-a-branch' | 'git-failed'; readonly message: string };

const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/u;
const MERGE_SCAN_DEPTH = 300;

/**
 * User-initiated work on a worktree workspace: read where it stands, commit
 * its changes, and merge it into the branch the main checkout has out. Every
 * step is a person's explicit action; nothing here runs on an agent's behalf.
 */
export class WorkspaceWorktreeService {
  constructor(private readonly git: Pick<GitRunner, 'run'> = new GitRunner()) {}

  async status(target: WorkspaceWorktreeTarget, signal?: AbortSignal): Promise<WorkspaceWorktreeStatus> {
    const branch = await this.currentBranch(target.rootPath, signal);
    const baseBranch = await this.currentBranch(target.mainRoot, signal);
    const dirty = (await this.git.run(target.rootPath, ['status', '--porcelain'], signal)).trim().length > 0;
    if (!branch || !baseBranch || branch === baseBranch) {
      return { workspaceId: target.workspaceId, ...(branch ? { branch } : {}), ...(baseBranch ? { baseBranch } : {}), dirty, ahead: 0, merged: false, ...(dirty ? { status: 'review' as const } : {}) };
    }
    const ahead = Number.parseInt((await this.git.run(target.mainRoot, ['rev-list', '--count', `${baseBranch}..${branch}`], signal)).trim(), 10) || 0;
    const tip = (await this.git.run(target.mainRoot, ['rev-parse', '--verify', `${branch}^{commit}`], signal)).trim();
    const merges = await this.git.run(target.mainRoot, ['rev-list', '--merges', '--parents', `--max-count=${String(MERGE_SCAN_DEPTH)}`, baseBranch], signal);
    // Merged through a merge commit: the base has the branch tip as a non-first parent.
    const merged = ahead === 0 && merges.split(/\r?\n/u).some((line) => line.split(' ').slice(2).includes(tip));
    const status = dirty || ahead > 0 ? 'review' as const : merged ? 'done' as const : undefined;
    return { workspaceId: target.workspaceId, branch, baseBranch, dirty, ahead, merged, ...(status ? { status } : {}) };
  }

  /** Commits everything in the worktree (the person reviewed it first). */
  async commit(target: WorkspaceWorktreeTarget, message: string, signal?: AbortSignal): Promise<WorkspaceWorktreeResult<{ readonly commit: string }>> {
    const subject = message.trim();
    if (!subject || subject.length > 2_000) return { ok: false, reason: 'git-failed', message: 'Write a commit message.' };
    try {
      await this.git.run(target.rootPath, ['add', '--all'], signal);
      await this.git.run(target.rootPath, ['commit', '--no-verify', '-m', subject], signal);
      const commit = (await this.git.run(target.rootPath, ['rev-parse', 'HEAD'], signal)).trim();
      return { ok: true, value: { commit } };
    } catch (error) {
      return { ok: false, reason: 'git-failed', message: gitMessage(error) };
    }
  }

  /**
   * Merges the worktree's branch into the main checkout's branch with a merge
   * commit. Both checkouts must be clean; a conflict is aborted and reported,
   * so the main checkout is never left half-merged.
   */
  async merge(target: WorkspaceWorktreeTarget, signal?: AbortSignal): Promise<WorkspaceWorktreeResult<{ readonly into: string; readonly commit: string }>> {
    const branch = await this.currentBranch(target.rootPath, signal);
    const baseBranch = await this.currentBranch(target.mainRoot, signal);
    if (!branch || !baseBranch || !SAFE_BRANCH.test(branch) || !SAFE_BRANCH.test(baseBranch) || branch === baseBranch) {
      return { ok: false, reason: 'not-a-branch', message: 'Both checkouts must be on named branches.' };
    }
    if ((await this.git.run(target.rootPath, ['status', '--porcelain'], signal)).trim()) {
      return { ok: false, reason: 'dirty-worktree', message: 'Commit the worktree’s changes before merging.' };
    }
    if ((await this.git.run(target.mainRoot, ['status', '--porcelain', '--untracked-files=no'], signal)).trim()) {
      return { ok: false, reason: 'dirty-main', message: `The main checkout (${baseBranch}) has uncommitted changes. Commit or stash them first.` };
    }
    const ahead = Number.parseInt((await this.git.run(target.mainRoot, ['rev-list', '--count', `${baseBranch}..${branch}`], signal)).trim(), 10) || 0;
    if (ahead === 0) return { ok: false, reason: 'nothing-to-merge', message: `${branch} has nothing ${baseBranch} does not already have.` };
    try {
      await this.git.run(target.mainRoot, ['merge', '--no-ff', '--no-edit', '--', branch], signal);
    } catch (error) {
      await this.git.run(target.mainRoot, ['merge', '--abort'], signal).catch(() => undefined);
      return { ok: false, reason: 'conflict', message: `Merging ${branch} into ${baseBranch} conflicts; nothing was changed. ${gitMessage(error)}`.trim() };
    }
    const commit = (await this.git.run(target.mainRoot, ['rev-parse', 'HEAD'], signal)).trim();
    return { ok: true, value: { into: baseBranch, commit } };
  }

  /** Deletes a branch that is fully merged (git refuses otherwise); its worktree must already be gone. */
  async deleteMergedBranch(mainRoot: string, branch: string, signal?: AbortSignal): Promise<{ readonly deleted: boolean; readonly message?: string }> {
    if (!SAFE_BRANCH.test(branch)) return { deleted: false, message: 'The branch is not a plain local branch name.' };
    try {
      await this.git.run(mainRoot, ['branch', '-d', branch], signal);
      return { deleted: true };
    } catch (error) {
      return { deleted: false, message: gitMessage(error) };
    }
  }

  private async currentBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const name = (await this.git.run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim();
      return name || undefined;
    } catch {
      return undefined;
    }
  }
}

export function gitMessage(error: unknown): string {
  if (error instanceof GitCommandError) return error.message.split(/\r?\n/u).slice(0, 3).join(' ').slice(0, 500);
  return error instanceof Error ? error.message.slice(0, 500) : 'Git failed.';
}
