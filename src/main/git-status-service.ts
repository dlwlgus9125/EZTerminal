import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  EMPTY_GIT_DIRECTORY_STATUS,
  UNAVAILABLE_GIT_DIRECTORY_STATUS,
  type GitChangeKind,
  type GitDiffOmission,
  type GitDiffOmissionReason,
  type GitDiffResult,
  type GitDirectoryStatus,
  type GitFileChange,
} from '../shared/git-status';
import { GitCommandError, GitRunner } from './worktree-service';

/** Repository answers remain cheap enough for UI use and bounded over IPC. */
const MAX_CHANGES = 2_000;
const MAX_DIFF_CHARS = 200_000;
const MAX_DIRECTORY_CHARS = 8_192;
const MAX_UNTRACKED_FILE_BYTES = 200_000;
const MAX_OMISSIONS = 2_000;
const CACHE_TTL_MS = 2_000;
const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_READ_MAX_BUFFER = 512 * 1024;
const MAX_GIT_PROCESSES = 4;
const MAX_FILTER_DRIVERS = 128;
const MAX_FILTER_OVERRIDE_CHARS = 16_000;
const FILTER_COMMAND_PATTERN = '^filter\\..*\\.(clean|process)$';

/** These options keep read-only queries from invoking user helpers or taking
 * optional repository locks. `--no-ext-diff`/`--no-textconv` are repeated on
 * every diff command because those are command-specific rather than global. */
const SAFE_GIT_PREFIX = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
] as const;

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('Git query aborted');
  error.name = 'AbortError';
  return error;
}

interface GateWaiter {
  readonly signal?: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort?: () => void;
}

/** A module-wide process gate. Several windows/connections may share one
 * service or create their own, but together they still spawn at most four Git
 * readers. */
class GitProcessGate {
  private active = 0;
  private readonly waiting: GateWaiter[] = [];

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < MAX_GIT_PROCESSES) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = signal
        ? (): void => {
            const index = this.waiting.indexOf(waiter);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(abortReason(signal));
          }
        : undefined;
      const waiter: GateWaiter = { signal, resolve, reject, ...(onAbort ? { onAbort } : {}) };
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.active -= 1;
      while (this.waiting.length > 0) {
        const waiter = this.waiting.shift()!;
        if (waiter.signal?.aborted) {
          waiter.reject(abortReason(waiter.signal));
          continue;
        }
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
        this.active += 1;
        waiter.resolve(this.releaseOnce());
        break;
      }
    };
  }
}

const GIT_PROCESS_GATE = new GitProcessGate();

/** `git status --porcelain=v1` status letters, in the order Git prints them. */
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

interface ParsedPorcelain {
  readonly branch?: string;
  readonly changes: Map<string, GitChangeKind>;
}

/** `-z --branch` starts with one branch record. Change records use an extra
 * NUL field for a rename source path. */
function parsePorcelain(stdout: string): ParsedPorcelain {
  const fields = stdout.split('\0');
  const changes = new Map<string, GitChangeKind>();
  let branch: string | undefined;
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i] ?? '';
    if (!record) continue;
    if (record.startsWith('## ')) {
      const raw = record.slice(3);
      if (raw.startsWith('No commits yet on ')) branch = raw.slice('No commits yet on '.length);
      else if (raw.startsWith('Initial commit on ')) branch = raw.slice('Initial commit on '.length);
      else if (raw !== 'HEAD (no branch)') branch = raw.split('...')[0]?.trim() || undefined;
      continue;
    }
    if (record.length < 4) continue;
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    const filePath = record.slice(3);
    const kind = kindFor(index, worktree);
    if (kind === 'renamed') i += 1;
    changes.set(filePath, kind);
  }
  return { ...(branch ? { branch } : {}), changes };
}

/** `--numstat -z` prints `added\tremoved\tpath\0`; a rename has an empty path
 * followed by old and new path records. Binary counts are deliberately absent. */
function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const fields = stdout.split('\0');
  const stats = new Map<string, { added: number; removed: number }>();
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    let filePath = parts[2] ?? '';
    if (filePath === '') {
      filePath = fields[i + 2] ?? '';
      i += 2;
    }
    if (!filePath || parts[0] === '-' || parts[1] === '-') continue;
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    stats.set(filePath, { added, removed });
  }
  return stats;
}

function mergeStats(
  first: Map<string, { added: number; removed: number }>,
  second: Map<string, { added: number; removed: number }>,
): Map<string, { added: number; removed: number }> {
  const merged = new Map(first);
  for (const [filePath, value] of second) {
    const previous = merged.get(filePath);
    merged.set(filePath, {
      added: (previous?.added ?? 0) + value.added,
      removed: (previous?.removed ?? 0) + value.removed,
    });
  }
  return merged;
}

function withinPrefix(repoPath: string, prefix: string): string | null {
  if (prefix === '') return repoPath;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

function isNotRepositoryError(error: unknown): boolean {
  return error instanceof GitCommandError
    && /not a git repository|not inside (?:a )?work tree|outside repository/iu.test(error.stderr);
}

function isStdoutLimit(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError
    && error.exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    && error.cause instanceof Error
    && /stdout.*maxBuffer/iu.test(error.cause.message);
}

function safeRepositoryPath(root: string, repoPath: string): string | null {
  if (!repoPath || path.isAbsolute(repoPath) || repoPath.includes('\0')) return null;
  const candidate = path.resolve(root, ...repoPath.split('/'));
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

type FileStats = Awaited<ReturnType<typeof fs.stat>>;

function sameFileIdentity(first: FileStats, second: FileStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameFileSnapshot(first: FileStats, second: FileStats): boolean {
  return sameFileIdentity(first, second)
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs;
}

function quotedDiffPath(prefix: 'a' | 'b', repoPath: string): string {
  return JSON.stringify(`${prefix}/${repoPath}`);
}

function untrackedPatch(repoPath: string, text: string): string {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const terminalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (terminalNewline) lines.pop();
  const count = lines.length === 1 && lines[0] === '' ? 0 : lines.length;
  const body = count === 0 ? '' : `${lines.map((line) => `+${line}`).join('\n')}\n`;
  const noNewline = count > 0 && !terminalNewline ? '\\ No newline at end of file\n' : '';
  return [
    `diff --git ${quotedDiffPath('a', repoPath)} ${quotedDiffPath('b', repoPath)}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${quotedDiffPath('b', repoPath)}`,
    `@@ -0,0 +1,${count} @@`,
    `${body}${noNewline}`,
  ].join('\n');
}

interface CacheEntry {
  readonly at: number;
  readonly value: Promise<GitDirectoryStatus>;
}

interface ReadUntrackedResult {
  readonly text?: string;
  readonly omission?: GitDiffOmissionReason;
}

interface BoundedGitOutput {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Read-only Git working-tree queries.
 *
 * The module hides argv hardening, process bounds, cancellation, repository
 * state parsing, untracked-file inspection, and output budgets. Callers get an
 * explicit availability/result shape and never have to infer "clean" from a
 * failed command.
 */
export class GitStatusService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly git: GitRunner = new GitRunner(execFile, {
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxBuffer: GIT_READ_MAX_BUFFER,
    }),
    private readonly now: () => number = Date.now,
  ) {}

  async getStatus(directory: string, signal?: AbortSignal): Promise<GitDirectoryStatus> {
    const resolved = await this.resolveDirectory(directory, signal);
    if (!resolved) return UNAVAILABLE_GIT_DIRECTORY_STATUS;

    if (!signal) {
      const cached = this.cache.get(resolved);
      if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.value;
      const value = this.readStatus(resolved).catch((error: unknown) =>
        isNotRepositoryError(error) ? EMPTY_GIT_DIRECTORY_STATUS : UNAVAILABLE_GIT_DIRECTORY_STATUS);
      this.cache.set(resolved, { at: this.now(), value });
      this.evictStale();
      return value;
    }

    try {
      return await this.readStatus(resolved, signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      return isNotRepositoryError(error) ? EMPTY_GIT_DIRECTORY_STATUS : UNAVAILABLE_GIT_DIRECTORY_STATUS;
    }
  }

  /** Return staged, unstaged, and readable untracked changes under one strict
   * character budget. Omitted files remain visible as structured metadata. */
  async getDiff(directory: string, signal?: AbortSignal): Promise<GitDiffResult> {
    const resolved = await this.resolveDirectory(directory, signal);
    if (!resolved) return { ok: false, error: 'invalid-path' };
    try {
      const inside = (await this.runGit(resolved, ['rev-parse', '--is-inside-work-tree'], signal)).trim();
      if (inside !== 'true') return { ok: false, error: 'not-a-repository' };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return { ok: false, error: isNotRepositoryError(error) ? 'not-a-repository' : 'git-failed' };
    }

    try {
      const filterOverrides = await this.readFilterOverrides(resolved, signal);
      const [rootText, prefix, staged, unstaged, untrackedText] = await this.runConcurrentGit([
        (batchSignal) =>
          this.runGit(resolved, ['rev-parse', '--show-toplevel'], batchSignal, filterOverrides),
        (batchSignal) =>
          this.runGit(resolved, ['rev-parse', '--show-prefix'], batchSignal, filterOverrides)
            .then((value) => value.trim()),
        (batchSignal) =>
          this.runDiffGit(
            resolved,
            ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--', '.'],
            batchSignal,
            filterOverrides,
          ),
        (batchSignal) =>
          this.runDiffGit(
            resolved,
            ['diff', '--no-ext-diff', '--no-textconv', '--', '.'],
            batchSignal,
            filterOverrides,
          ),
        (batchSignal) =>
          this.runGit(
            resolved,
            ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
            batchSignal,
            filterOverrides,
          ),
      ] as const, signal);
      const root = await fs.realpath(rootText.trim());
      signal?.throwIfAborted();
      const omissions: GitDiffOmission[] = [];
      let text = '';
      let truncated = staged.truncated || unstaged.truncated;

      const append = (piece: string): boolean => {
        if (!piece) return true;
        const separator = text.length === 0 ? '' : '\n';
        const available = MAX_DIFF_CHARS - text.length;
        const combined = `${separator}${piece}`;
        if (combined.length <= available) {
          text += combined;
          return true;
        }
        text += combined.slice(0, Math.max(0, available));
        truncated = true;
        return false;
      };

      const stagedComplete = append(
        staged.text.trimEnd() ? `## Staged changes\n${staged.text.trimEnd()}\n` : '',
      );
      const unstagedComplete = stagedComplete
        && append(unstaged.text.trimEnd() ? `## Unstaged changes\n${unstaged.text.trimEnd()}\n` : '');
      const untracked = untrackedText
        .split('\0')
        .filter(Boolean)
        .map((repoPath) => ({ repoPath, relative: withinPrefix(repoPath, prefix) }))
        .filter((entry): entry is { repoPath: string; relative: string } =>
          entry.relative !== null && entry.relative.length > 0);

      for (let index = 0; index < untracked.length; index += 1) {
        const { repoPath, relative } = untracked[index]!;
        if (index >= MAX_OMISSIONS) {
          truncated = true;
          break;
        }
        if (!unstagedComplete || text.length >= MAX_DIFF_CHARS) {
          omissions.push({ path: relative, reason: 'budget-exhausted' });
          truncated = true;
          continue;
        }
        signal?.throwIfAborted();
        const read = await this.readUntracked(root, repoPath, signal);
        if (read.omission) {
          omissions.push({ path: relative, reason: read.omission });
          truncated = true;
          continue;
        }
        const patch = untrackedPatch(relative, read.text ?? '');
        if (!append(`## Untracked file\n${patch}`)) {
          omissions.push({ path: relative, reason: 'budget-exhausted' });
        }
      }

      return { ok: true, text, truncated, omissions };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return { ok: false, error: 'git-failed' };
    }
  }

  private async resolveDirectory(directory: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if (
      typeof directory !== 'string'
      || directory.trim().length === 0
      || directory.length > MAX_DIRECTORY_CHARS
      || directory.includes('\0')
    ) {
      return null;
    }
    const resolved = path.resolve(directory);
    try {
      const stats = await fs.stat(resolved);
      signal?.throwIfAborted();
      return stats.isDirectory() ? resolved : null;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return null;
    }
  }

  private async readStatus(directory: string, signal?: AbortSignal): Promise<GitDirectoryStatus> {
    const inside = (await this.runGit(directory, ['rev-parse', '--is-inside-work-tree'], signal)).trim();
    if (inside !== 'true') return EMPTY_GIT_DIRECTORY_STATUS;
    const filterOverrides = await this.readFilterOverrides(directory, signal);
    const [prefixText, porcelainText, stagedText, unstagedText] = await this.runConcurrentGit([
      (batchSignal) =>
        this.runGit(directory, ['rev-parse', '--show-prefix'], batchSignal, filterOverrides),
      (batchSignal) =>
        this.runGit(
          directory,
          ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal', '--', '.'],
          batchSignal,
          filterOverrides,
        ),
      (batchSignal) =>
        this.runGit(
          directory,
          ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--cached', '--', '.'],
          batchSignal,
          filterOverrides,
        ),
      (batchSignal) =>
        this.runGit(
          directory,
          ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--', '.'],
          batchSignal,
          filterOverrides,
        ),
    ] as const, signal);
    signal?.throwIfAborted();
    const prefix = prefixText.trim();
    const parsed = parsePorcelain(porcelainText);
    const stats = mergeStats(parseNumstat(stagedText), parseNumstat(unstagedText));
    const changes: GitFileChange[] = [];
    let truncated = false;
    for (const [repoPath, kind] of parsed.changes) {
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
    return {
      availability: 'ready',
      tracked: true,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      changes,
      truncated,
    };
  }

  private async readUntracked(
    root: string,
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<ReadUntrackedResult> {
    signal?.throwIfAborted();
    const absolute = safeRepositoryPath(root, repoPath);
    if (!absolute) return { omission: 'unsupported' };
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      const initial = await fs.lstat(absolute);
      signal?.throwIfAborted();
      if (initial.isSymbolicLink()) return { omission: 'symlink' };
      if (!initial.isFile()) return { omission: 'unsupported' };
      const real = await fs.realpath(absolute);
      signal?.throwIfAborted();
      const relative = path.relative(root, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return { omission: 'symlink' };
      }
      handle = await fs.open(real, 'r');
      signal?.throwIfAborted();
      const current = await handle.stat();
      if (!current.isFile()) return { omission: 'unsupported' };
      // The path may have been replaced between lstat/realpath/open. Read only
      // the exact inode/file-id we inspected before opening; a swapped link or
      // file is retried on the next user request instead of followed now.
      if (current.dev !== initial.dev || current.ino !== initial.ino) {
        return { omission: 'read-failed' };
      }
      if (current.size > MAX_UNTRACKED_FILE_BYTES) return { omission: 'too-large' };
      const buffer = Buffer.alloc(current.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      signal?.throwIfAborted();
      if (bytesRead > MAX_UNTRACKED_FILE_BYTES) return { omission: 'too-large' };
      const afterRead = await handle.stat();
      const finalPath = await fs.lstat(absolute);
      signal?.throwIfAborted();
      if (
        bytesRead !== current.size
        || finalPath.isSymbolicLink()
        || !finalPath.isFile()
        || !sameFileSnapshot(current, afterRead)
        || !sameFileSnapshot(current, finalPath)
      ) {
        return { omission: 'read-failed' };
      }
      const body = buffer.subarray(0, bytesRead);
      if (body.includes(0)) return { omission: 'binary' };
      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(body) };
      } catch {
        return { omission: 'binary' };
      }
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      return { omission: 'read-failed' };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readFilterOverrides(
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    let output: string;
    try {
      output = await this.runGit(
        directory,
        ['config', '--null', '--name-only', '--get-regexp', FILTER_COMMAND_PATTERN],
        signal,
      );
    } catch (error) {
      // `git config --get-regexp` uses exit 1, with no diagnostic, for a
      // successful lookup that found no matching keys.
      if (error instanceof GitCommandError && error.exitCode === 1 && error.stderr.trim() === '') {
        return [];
      }
      throw error;
    }

    const drivers = new Set<string>();
    for (const key of output.split('\0').filter(Boolean)) {
      const suffix = key.endsWith('.clean')
        ? '.clean'
        : key.endsWith('.process')
          ? '.process'
          : null;
      if (!suffix || !key.startsWith('filter.')) continue;
      const driver = key.slice(0, -suffix.length);
      if (
        driver.length <= 'filter.'.length
        || driver.includes('=')
        || driver.includes('\0')
        || driver.length > 1_024
      ) {
        throw new Error('Unsafe Git filter configuration key');
      }
      drivers.add(driver);
      if (drivers.size > MAX_FILTER_DRIVERS) {
        throw new Error('Too many Git filter drivers');
      }
    }

    const overrides = [...drivers].flatMap((driver) => [
      '-c',
      `${driver}.clean=`,
      '-c',
      `${driver}.process=`,
      '-c',
      `${driver}.required=false`,
    ]);
    if (overrides.reduce((total, value) => total + value.length + 1, 0) > MAX_FILTER_OVERRIDE_CHARS) {
      throw new Error('Git filter overrides exceed the safe argument budget');
    }
    return overrides;
  }

  private runGit(
    directory: string,
    args: readonly string[],
    signal?: AbortSignal,
    configOverrides: readonly string[] = [],
  ): Promise<string> {
    return GIT_PROCESS_GATE.run(async () => {
      try {
        return await this.git.run(
          directory,
          [...SAFE_GIT_PREFIX, ...configOverrides, ...args],
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      }
    }, signal);
  }

  private async runConcurrentGit<T extends readonly unknown[]>(
    operations: { readonly [K in keyof T]: (signal: AbortSignal) => Promise<T[K]> },
    callerSignal?: AbortSignal,
  ): Promise<T> {
    callerSignal?.throwIfAborted();
    const batchAbort = new AbortController();
    const batchSignal = callerSignal
      ? AbortSignal.any([callerSignal, batchAbort.signal])
      : batchAbort.signal;
    const failures: Array<{ readonly reason: unknown }> = [];

    const pending = operations.map(async (operation) => {
      try {
        return await operation(batchSignal);
      } catch (error) {
        if (failures.length === 0) {
          failures.push({ reason: error });
          batchAbort.abort(error);
        }
        throw error;
      }
    });
    const settled = await Promise.allSettled(pending);
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    if (failures.length > 0) throw failures[0]!.reason;

    return settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    }) as unknown as T;
  }

  private async runDiffGit(
    directory: string,
    args: readonly string[],
    signal?: AbortSignal,
    configOverrides: readonly string[] = [],
  ): Promise<BoundedGitOutput> {
    try {
      return {
        text: await this.runGit(directory, args, signal, configOverrides),
        truncated: false,
      };
    } catch (error) {
      if (!isStdoutLimit(error)) throw error;
      return { text: error.partialStdout, truncated: true };
    }
  }

  private evictStale(): void {
    const cutoff = this.now() - CACHE_TTL_MS;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) this.cache.delete(key);
    }
  }
}
