import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  EMPTY_GIT_DIRECTORY_STATUS,
  type GitChangeKind,
  type GitDiffResult,
  type GitDirectoryStatus,
  type GitFileChange,
} from '../shared/git-status';
import { GitRunner } from './worktree-service';

/** A directory listing is a handful of rows; a repository-wide answer is not
 * worth carrying. Past this the caller is told the list is partial. */
const MAX_CHANGES = 2000;
/** A diff is read by a human before approving. Past this they are scrolling,
 * not reading, and the IPC payload stops being cheap. */
const MAX_DIFF_CHARS = 200_000;
/** Long enough that a re-render or a second panel does not re-run git, short
 * enough that a file saved in another window shows up on the next look. */
const CACHE_TTL_MS = 2_000;

/** `git status --porcelain=v1` status letters, in the order git prints them. */
function kindFor(index: string, worktree: string): GitChangeKind {
  if (index === '?' && worktree === '?') return 'untracked';
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) {
    return 'conflicted';
  }
  const letters = `${index}${worktree}`;
  if (letters.includes('R')) return 'renamed';
  if (letters.includes('A')) return 'added';
  if (letters.includes('D')) return 'deleted';
  return 'modified';
}

/** `-z` output is NUL-terminated records; a rename record is followed by one
 * extra NUL-terminated field holding the original path. */
function parsePorcelain(stdout: string): Map<string, GitChangeKind> {
  const fields = stdout.split('\0');
  const changes = new Map<string, GitChangeKind>();
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record || record.length < 4) continue;
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    const filePath = record.slice(3);
    const kind = kindFor(index, worktree);
    // The rename's source path is a separate record; consume it so it is not
    // read as a change of its own.
    if (kind === 'renamed') i += 1;
    changes.set(filePath, kind);
  }
  return changes;
}

/** `--numstat -z` prints `added\tremoved\tpath\0`, and for a rename prints an
 * empty path followed by two more NUL-terminated fields (old, new). */
function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const fields = stdout.split('\0');
  const stats = new Map<string, { added: number; removed: number }>();
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    let filePath = parts[2] ?? '';
    if (filePath === '') {
      // Rename: the real destination is two records ahead.
      filePath = fields[i + 2] ?? '';
      i += 2;
    }
    if (!filePath) continue;
    // A binary file prints `-` for both counts, which is not a line count.
    stats.set(filePath, {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    });
  }
  return stats;
}

function withinPrefix(repoPath: string, prefix: string): string | null {
  if (prefix === '') return repoPath;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

interface CacheEntry {
  readonly at: number;
  readonly value: Promise<GitDirectoryStatus>;
}

/**
 * Read-only Git working-tree queries.
 *
 * Deliberately separate from `WorktreeService`: that one mutates a registry
 * and guards sessions, this one only ever reads and is safe to call on every
 * directory listing. It shares the same argv-only, non-interactive `GitRunner`,
 * so neither can be talked into a shell.
 */
export class GitStatusService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly git: GitRunner = new GitRunner(),
    private readonly now: () => number = Date.now,
  ) {}

  async getStatus(directory: string): Promise<GitDirectoryStatus> {
    const resolved = await this.resolveDirectory(directory);
    if (!resolved) return EMPTY_GIT_DIRECTORY_STATUS;

    const cached = this.cache.get(resolved);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const value = this.readStatus(resolved).catch(() => EMPTY_GIT_DIRECTORY_STATUS);
    this.cache.set(resolved, { at: this.now(), value });
    this.evictStale();
    return value;
  }

  /** The agent's accumulated working-tree changes — what a reviewer actually
   * wants to see before answering "may I". */
  async getDiff(directory: string): Promise<GitDiffResult> {
    const resolved = await this.resolveDirectory(directory);
    if (!resolved) return { ok: false, error: 'invalid-path' };
    try {
      await this.git.run(resolved, ['rev-parse', '--is-inside-work-tree']);
    } catch {
      return { ok: false, error: 'not-a-repository' };
    }
    try {
      const text = await this.git.run(resolved, ['diff', 'HEAD', '--', '.']);
      if (text.length <= MAX_DIFF_CHARS) return { ok: true, text, truncated: false };
      return { ok: true, text: text.slice(0, MAX_DIFF_CHARS), truncated: true };
    } catch {
      return { ok: false, error: 'git-failed' };
    }
  }

  private async resolveDirectory(directory: string): Promise<string | null> {
    if (typeof directory !== 'string' || directory.trim().length === 0) return null;
    const resolved = path.resolve(directory);
    try {
      const stats = await fs.stat(resolved);
      return stats.isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  private async readStatus(directory: string): Promise<GitDirectoryStatus> {
    let prefix: string;
    try {
      prefix = (await this.git.run(directory, ['rev-parse', '--show-prefix'])).trim();
    } catch {
      return EMPTY_GIT_DIRECTORY_STATUS;
    }

    const branchRaw = await this.git
      .run(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])
      .then((value) => value.trim())
      .catch(() => '');
    // A fresh repository with no commits reports `HEAD`, and so does a detached
    // checkout. Neither is a branch name worth showing.
    const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : undefined;

    const [porcelain, numstat] = await Promise.all([
      this.git.run(directory, ['status', '--porcelain=v1', '-z', '--', '.']).catch(() => ''),
      this.git.run(directory, ['diff', '--numstat', '-z', 'HEAD', '--', '.']).catch(() => ''),
    ]);

    const kinds = parsePorcelain(porcelain);
    const stats = parseNumstat(numstat);
    const changes: GitFileChange[] = [];
    let truncated = false;
    for (const [repoPath, kind] of kinds) {
      const relative = withinPrefix(repoPath, prefix);
      if (relative === null || relative === '') continue;
      if (changes.length >= MAX_CHANGES) {
        truncated = true;
        break;
      }
      const stat = stats.get(repoPath);
      changes.push({
        path: relative,
        kind,
        ...(stat ? { added: stat.added, removed: stat.removed } : {}),
      });
    }
    return { tracked: true, ...(branch ? { branch } : {}), changes, truncated };
  }

  private evictStale(): void {
    const cutoff = this.now() - CACHE_TTL_MS;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) this.cache.delete(key);
    }
  }
}
