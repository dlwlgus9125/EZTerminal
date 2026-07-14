import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  WorktreeAction,
  WorktreeErrorCode,
  WorktreeFailure,
  WorktreeInfo,
  WorktreeRequest,
  WorktreeRequestOrigin,
  WorktreeResult,
} from '../shared/worktree';
import { AsyncMutationGate, type MutationGate } from './async-mutation-gate';
import {
  SessionWorktreeGuard,
  type SessionRunIdentity,
} from './session-worktree-guard';

const REGISTRY_SCHEMA_VERSION = 1 as const;
const REGISTRY_FILE = 'worktrees.json';
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type ExecFileLike = typeof execFile;

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | string | null,
    options?: ErrorOptions,
  ) {
    super('git command failed', options);
  }
}

/** Bounded, non-interactive, argv-only Git CLI runner. */
export class GitRunner {
  constructor(private readonly execute: ExecFileLike = execFile) {}

  run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const options: ExecFileOptionsWithStringEncoding = {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        signal,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '0',
          LC_ALL: 'C',
        },
      };
      this.execute('git', [...args], options, (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          reject(new GitCommandError(args, String(stderr).slice(0, GIT_MAX_BUFFER), code, { cause: error }));
          return;
        }
        resolve(String(stdout));
      });
    });
  }
}

interface RegistryEntry {
  readonly worktreeId: string;
  readonly repoId: string;
  readonly path: string;
  readonly gitDir: string;
  readonly managedRoot: string;
  readonly createdAt: string;
}

interface RegistryFile {
  readonly schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  readonly entries: readonly RegistryEntry[];
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<Record<keyof RegistryEntry, unknown>>;
  return (
    typeof item.worktreeId === 'string' && item.worktreeId.length > 0 &&
    typeof item.repoId === 'string' && item.repoId.length > 0 &&
    typeof item.path === 'string' && path.isAbsolute(item.path) &&
    typeof item.gitDir === 'string' && path.isAbsolute(item.gitDir) &&
    typeof item.managedRoot === 'string' && path.isAbsolute(item.managedRoot) &&
    typeof item.createdAt === 'string'
  );
}

function parseRegistry(value: unknown): RegistryEntry[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as { schemaVersion?: unknown; entries?: unknown };
  if (file.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(file.entries)) return null;
  if (!file.entries.every(isRegistryEntry)) return null;
  return [...file.entries];
}

class WorktreeRegistryStore {
  private readonly filePath: string;
  private entries: RegistryEntry[] = [];
  private ready = false;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, REGISTRY_FILE);
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.unlink(`${this.filePath}.tmp`).catch(() => undefined);
    try {
      const parsed = parseRegistry(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown);
      if (!parsed) {
        await this.quarantine();
      } else {
        this.entries = parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await this.quarantine();
    }
    this.ready = true;
  }

  list(repoId: string): readonly RegistryEntry[] {
    return this.entries.filter((entry) => entry.repoId === repoId);
  }

  async add(entry: RegistryEntry): Promise<void> {
    const next = [...this.entries.filter((item) => item.worktreeId !== entry.worktreeId), entry];
    await this.save(next);
    this.entries = next;
  }

  async remove(worktreeId: string): Promise<void> {
    const next = this.entries.filter((entry) => entry.worktreeId !== worktreeId);
    await this.save(next);
    this.entries = next;
  }

  private async save(entries: readonly RegistryEntry[]): Promise<void> {
    const data: RegistryFile = { schemaVersion: REGISTRY_SCHEMA_VERSION, entries: [...entries] };
    const tmp = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'w' });
      try {
        await fs.rename(tmp, this.filePath);
      } catch {
        await fs.rename(tmp, this.filePath);
      }
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  private async quarantine(): Promise<void> {
    const quarantine = `${this.filePath}.corrupt`;
    await fs.unlink(quarantine).catch(() => undefined);
    try {
      await fs.rename(this.filePath, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.entries = [];
  }
}

interface PorcelainWorktree {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

type MutablePorcelainWorktree = { -readonly [K in keyof PorcelainWorktree]?: PorcelainWorktree[K] };

/** Parse `git worktree list --porcelain -z` without path quoting ambiguity. */
export function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  const result: PorcelainWorktree[] = [];
  let current: MutablePorcelainWorktree | null = null;
  const finish = (): void => {
    if (!current?.path) {
      current = null;
      return;
    }
    result.push({
      path: current.path,
      head: current.head ?? '',
      branch: current.branch ?? '',
      bare: current.bare ?? false,
      detached: current.detached ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
    });
    current = null;
  };

  for (const field of output.split('\0')) {
    if (field === '') {
      finish();
      continue;
    }
    if (field.startsWith('worktree ')) {
      finish();
      current = { path: field.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch ')) current.branch = field.slice('branch refs/heads/'.length);
    else if (field === 'bare') current.bare = true;
    else if (field === 'detached') current.detached = true;
    else if (field === 'locked' || field.startsWith('locked ')) current.locked = true;
    else if (field === 'prunable' || field.startsWith('prunable ')) current.prunable = true;
  }
  finish();
  return result;
}

interface ResolvedRepo {
  readonly repoId: string;
  readonly currentRoot: string;
  readonly commonDir: string;
  readonly mainPath: string;
  readonly rawWorktrees: readonly PorcelainWorktree[];
}

class WorktreeServiceError extends Error {
  constructor(readonly code: WorktreeErrorCode, message: string) {
    super(message);
  }
}

function shortHash(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(a: string, b: string): boolean {
  return comparisonPath(a) === comparisonPath(b);
}

function isStrictlyContained(root: string, candidate: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function lstatIfPresent(value: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Resolve symlinks in the nearest existing ancestor of a prospective path. */
async function canonicalProspective(value: string): Promise<string> {
  let cursor = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    const stat = await lstatIfPresent(cursor);
    if (stat) {
      const base = await fs.realpath(cursor);
      return path.resolve(base, ...tail);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new WorktreeServiceError('IO_ERROR', `No existing ancestor for ${value}`);
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function safeGitMessage(error: GitCommandError): string {
  const line = error.stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  return line ? `Git failed: ${line.slice(0, 300)}` : 'Git failed without an error message.';
}

function failure(action: WorktreeAction, error: WorktreeErrorCode, message: string, worktree?: WorktreeInfo): WorktreeFailure {
  return { ok: false, action, error, message, ...(worktree ? { worktree } : {}) };
}

export interface WorktreeServiceOptions {
  readonly userDataDir: string;
  readonly gitRunner?: GitRunner;
  readonly newId?: () => string;
  readonly now?: () => Date;
  readonly getSessionCwds?: () => readonly string[];
  readonly mutationGate?: MutationGate;
  readonly runGuard?: SessionWorktreeGuard;
}

export class WorktreeService {
  private readonly git: GitRunner;
  private readonly registry: WorktreeRegistryStore;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly getSessionCwds: () => readonly string[];
  private readonly mutationGate: MutationGate;
  private readonly runGuard: SessionWorktreeGuard;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: WorktreeServiceOptions) {
    this.git = options.gitRunner ?? new GitRunner();
    this.registry = new WorktreeRegistryStore(options.userDataDir);
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.getSessionCwds = options.getSessionCwds ?? (() => []);
    this.mutationGate = options.mutationGate ?? new AsyncMutationGate();
    this.runGuard = options.runGuard ?? new SessionWorktreeGuard();
  }

  async init(): Promise<void> {
    await this.registry.init();
  }

  execute(
    request: WorktreeRequest,
    origin: WorktreeRequestOrigin,
    signal?: AbortSignal,
    initiatingRun?: SessionRunIdentity,
  ): Promise<WorktreeResult> {
    const action = request.action;
    const operation = this.operationChain.then(async () => {
      try {
        await this.registry.init();
        if (origin === 'mobile' && (action === 'create' || action === 'remove')) {
          return failure(action, 'MOBILE_READ_ONLY', `worktree ${action} is available on desktop only.`);
        }
        switch (request.action) {
          case 'list':
            return { ok: true, action, worktrees: await this.listInternal(request.cwd, signal) } as const;
          case 'create':
            return await this.createInternal(request, signal);
          case 'open':
            return await this.openInternal(request.cwd, request.worktreeId, signal);
          case 'remove':
            return await this.removeInternal(request.cwd, request.worktreeId, signal, initiatingRun);
        }
      } catch (error) {
        if (error instanceof WorktreeServiceError) return failure(action, error.code, error.message);
        if (error instanceof GitCommandError) return failure(action, 'GIT_FAILED', safeGitMessage(error));
        return failure(action, 'IO_ERROR', error instanceof Error ? error.message : 'Worktree operation failed.');
      }
    });
    this.operationChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async resolveRepo(cwd: string, signal?: AbortSignal): Promise<ResolvedRepo> {
    let currentRootText: string;
    let commonDirText: string;
    let rawWorktrees: PorcelainWorktree[];
    try {
      [currentRootText, commonDirText, rawWorktrees] = await Promise.all([
        this.git.run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'], signal),
        this.git.run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
        this.git.run(cwd, ['worktree', 'list', '--porcelain', '-z'], signal).then(parseWorktreePorcelain),
      ]);
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw new WorktreeServiceError('NOT_A_GIT_REPOSITORY', 'The current directory is not inside a Git worktree.');
      }
      throw error;
    }
    if (rawWorktrees.length === 0 || rawWorktrees[0].bare) {
      throw new WorktreeServiceError('NOT_A_GIT_REPOSITORY', 'Bare repositories are not supported.');
    }
    const currentRoot = await fs.realpath(currentRootText.trim());
    const commonDir = await fs.realpath(commonDirText.trim());
    const mainPath = await fs.realpath(rawWorktrees[0].path);
    return {
      repoId: `repo-${shortHash(commonDir)}`,
      currentRoot,
      commonDir,
      mainPath,
      rawWorktrees,
    };
  }

  private async listInternal(cwd: string, signal?: AbortSignal): Promise<WorktreeInfo[]> {
    const repo = await this.resolveRepo(cwd, signal);
    const registryEntries = this.registry.list(repo.repoId);
    const infos: WorktreeInfo[] = [];
    for (const raw of repo.rawWorktrees) {
      signal?.throwIfAborted();
      const canonicalPath = await canonicalProspective(raw.path);
      let gitDir = '';
      if (await lstatIfPresent(canonicalPath)) {
        try {
          gitDir = await fs.realpath((await this.git.run(canonicalPath, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal)).trim());
        } catch {
          gitDir = '';
        }
      }
      const entry = registryEntries.find((candidate) =>
        samePath(candidate.path, canonicalPath) && gitDir !== '' && samePath(candidate.gitDir, gitDir),
      );
      const managed = Boolean(
        entry &&
        isStrictlyContained(entry.managedRoot, canonicalPath) &&
        !samePath(canonicalPath, repo.mainPath) &&
        !isStrictlyContained(repo.mainPath, canonicalPath),
      );
      const main = samePath(canonicalPath, repo.mainPath);
      infos.push({
        worktreeId: managed && entry ? entry.worktreeId : `${main ? 'main' : 'external'}-${shortHash(repo.repoId, canonicalPath, gitDir)}`,
        repoId: repo.repoId,
        path: canonicalPath,
        branch: raw.detached ? '(detached)' : raw.branch,
        head: raw.head,
        main,
        locked: raw.locked,
        managed,
        prunable: raw.prunable,
      });
    }
    return infos;
  }

  private async createInternal(
    request: Extract<WorktreeRequest, { action: 'create' }>,
    signal?: AbortSignal,
  ): Promise<WorktreeResult> {
    const branch = request.branch.trim();
    if (!branch || branch.length > 255 || branch.startsWith('-') || branch.includes('\0')) {
      throw new WorktreeServiceError('INVALID_BRANCH', 'Branch name is empty or unsafe.');
    }
    const repo = await this.resolveRepo(request.cwd, signal);
    try {
      await this.git.run(repo.mainPath, ['check-ref-format', '--branch', branch], signal);
    } catch (error) {
      if (error instanceof GitCommandError) throw new WorktreeServiceError('INVALID_BRANCH', `Invalid branch name: ${branch}`);
      throw error;
    }

    const status = await this.git.run(repo.currentRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal);
    if (status.length > 0 && !request.allowDirtyBase) {
      throw new WorktreeServiceError('BASE_DIRTY', 'The current worktree is dirty; commit/stash it or pass --allow-dirty-base.');
    }

    const base = request.base?.trim() || 'HEAD';
    if (base.length > 1024 || base.startsWith('-') || base.includes('\0')) {
      throw new WorktreeServiceError('INVALID_BASE', 'Base ref is empty or unsafe.');
    }
    let commit: string;
    try {
      commit = (await this.git.run(repo.currentRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], signal)).trim();
    } catch (error) {
      if (error instanceof GitCommandError) throw new WorktreeServiceError('INVALID_BASE', `Base ref does not resolve to a commit: ${base}`);
      throw error;
    }

    const defaultRoot = path.join(path.dirname(repo.mainPath), '.ezterminal-worktrees', path.basename(repo.mainPath));
    const requestedRoot = request.root?.trim();
    if (requestedRoot && !path.isAbsolute(requestedRoot)) {
      throw new WorktreeServiceError('UNSAFE_ROOT', '--root must be an absolute path outside every registered worktree.');
    }
    const root = await canonicalProspective(requestedRoot || defaultRoot);
    const slug = branch.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'worktree';
    const worktreeId = this.newId();
    const target = await canonicalProspective(path.join(root, `${slug}-${worktreeId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 8)}`));

    for (const registered of repo.rawWorktrees) {
      const registeredPath = await canonicalProspective(registered.path);
      if (samePath(target, registeredPath) || isStrictlyContained(registeredPath, target)) {
        throw new WorktreeServiceError('UNSAFE_ROOT', 'The target must be outside every registered Git worktree.');
      }
    }
    if (!isStrictlyContained(root, target)) {
      throw new WorktreeServiceError('UNSAFE_ROOT', 'The generated worktree escaped the selected root.');
    }
    if (await lstatIfPresent(target)) throw new WorktreeServiceError('TARGET_EXISTS', `Target already exists: ${target}`);

    await fs.mkdir(root, { recursive: true });
    const canonicalRoot = await fs.realpath(root);
    const recheckedTarget = await canonicalProspective(target);
    if (!isStrictlyContained(canonicalRoot, recheckedTarget)) {
      throw new WorktreeServiceError('UNSAFE_ROOT', 'The selected root resolves through a link to an unsafe location.');
    }

    await this.git.run(repo.mainPath, ['worktree', 'add', '-b', branch, recheckedTarget, commit], signal);
    const currentInfos = await this.listInternal(repo.mainPath, signal);
    const createdRaw = currentInfos.find((item) => samePath(item.path, recheckedTarget));
    if (!createdRaw) throw new WorktreeServiceError('GIT_FAILED', 'Git created no registered worktree at the expected path.');
    const gitDir = await fs.realpath((await this.git.run(recheckedTarget, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal)).trim());
    const entry: RegistryEntry = {
      worktreeId,
      repoId: repo.repoId,
      path: recheckedTarget,
      gitDir,
      managedRoot: canonicalRoot,
      createdAt: this.now().toISOString(),
    };
    try {
      await this.registry.add(entry);
    } catch {
      // Persistence failed before the in-memory registry commit. Return the
      // same deterministic external id that list now exposes, so a subsequent
      // remove request reaches the explicit unmanaged guard rather than
      // masquerading as a missing worktree.
      const unmanagedInfo: WorktreeInfo = { ...createdRaw, managed: false };
      return failure('create', 'REGISTRY_WRITE_FAILED', `Worktree was created at ${recheckedTarget}, but EZTerminal ownership was not saved. It will not be auto-removed.`, unmanagedInfo);
    }
    const infos = await this.listInternal(repo.mainPath, signal);
    const opened = infos.find((item) => item.worktreeId === worktreeId);
    if (!opened) throw new WorktreeServiceError('REGISTRY_WRITE_FAILED', 'The created worktree could not be reconciled with its registry entry.');
    return { ok: true, action: 'create', worktrees: infos, opened };
  }

  private async openInternal(cwd: string, worktreeId: string, signal?: AbortSignal): Promise<WorktreeResult> {
    const infos = await this.listInternal(cwd, signal);
    const opened = infos.find((item) => item.worktreeId === worktreeId);
    if (!opened || opened.prunable || !(await lstatIfPresent(opened.path))) {
      throw new WorktreeServiceError('WORKTREE_NOT_FOUND', `Worktree not found: ${worktreeId}`);
    }
    return { ok: true, action: 'open', worktrees: infos, opened };
  }

  private async assertWorktreeNotInUse(targetPath: string): Promise<void> {
    for (const sessionCwd of this.getSessionCwds()) {
      try {
        const canonicalSessionCwd = await canonicalProspective(sessionCwd);
        if (samePath(targetPath, canonicalSessionCwd)
          || isStrictlyContained(targetPath, canonicalSessionCwd)) {
          throw new WorktreeServiceError(
            'WORKTREE_IN_USE',
            'Close every session using this worktree before removing it.',
          );
        }
      } catch (error) {
        if (error instanceof WorktreeServiceError) throw error;
        // A stale/nonexistent session cwd cannot be using this live worktree.
      }
    }
  }

  private assertNoConflictingActiveRun(initiatingRun?: SessionRunIdentity): void {
    if (!this.runGuard.hasConflictingActiveRun(initiatingRun)) return;
    throw new WorktreeServiceError(
      'WORKTREE_IN_USE',
      'Wait for other terminal commands to finish before removing a worktree.',
    );
  }

  private async removeInternal(
    cwd: string,
    worktreeId: string,
    signal?: AbortSignal,
    initiatingRun?: SessionRunIdentity,
  ): Promise<WorktreeResult> {
    const repo = await this.resolveRepo(cwd, signal);
    let infos = await this.listInternal(cwd, signal);
    let target = infos.find((item) => item.worktreeId === worktreeId);
    if (!target) throw new WorktreeServiceError('WORKTREE_NOT_FOUND', `Worktree not found: ${worktreeId}`);
    if (target.main) throw new WorktreeServiceError('MAIN_WORKTREE', 'The main worktree cannot be removed.');
    if (!target.managed) throw new WorktreeServiceError('WORKTREE_UNMANAGED', 'Only worktrees created and registered by EZTerminal can be removed.');
    if (target.locked) throw new WorktreeServiceError('WORKTREE_LOCKED', 'Unlock the Git worktree before removing it.');
    if (target.prunable || !(await lstatIfPresent(target.path))) {
      throw new WorktreeServiceError('WORKTREE_NOT_FOUND', 'The worktree directory is missing or prunable.');
    }

    const entry = this.registry.list(repo.repoId).find((item) => item.worktreeId === worktreeId);
    if (!entry || !samePath(entry.path, target.path) || !isStrictlyContained(entry.managedRoot, target.path)) {
      throw new WorktreeServiceError('WORKTREE_UNMANAGED', 'The worktree failed its managed-root boundary check.');
    }
    const targetGitDir = await fs.realpath((await this.git.run(target.path, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal)).trim());
    if (!samePath(entry.gitDir, targetGitDir)) {
      throw new WorktreeServiceError('WORKTREE_UNMANAGED', 'The worktree Git identity no longer matches its EZTerminal registration.');
    }

    this.assertNoConflictingActiveRun(initiatingRun);
    await this.assertWorktreeNotInUse(target.path);

    const dirty = await this.git.run(target.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal);
    if (dirty.length > 0) throw new WorktreeServiceError('WORKTREE_DIRTY', 'Commit, stash, or delete worktree changes before removing it.');

    // Reconcile immediately before the destructive Git command to close races.
    infos = await this.listInternal(cwd, signal);
    target = infos.find((item) => item.worktreeId === worktreeId);
    if (!target || !target.managed) throw new WorktreeServiceError('WORKTREE_UNMANAGED', 'Worktree registration changed during removal.');
    if (target.locked) throw new WorktreeServiceError('WORKTREE_LOCKED', 'The worktree was locked during removal.');
    const dirtyRecheck = await this.git.run(target.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal);
    if (dirtyRecheck.length > 0) throw new WorktreeServiceError('WORKTREE_DIRTY', 'The worktree became dirty during removal.');
    // Session creation and the destructive Git command share one main-owned
    // gate. If create wins, its authoritative session-directory entry is
    // visible to this final recheck; if remove wins, create cannot post until
    // Git has finished removing the worktree.
    await this.mutationGate.runExclusive(async () => {
      await this.runGuard.withRemovalBarrier(async () => {
        signal?.throwIfAborted();
        this.assertNoConflictingActiveRun(initiatingRun);
        await this.assertWorktreeNotInUse(target.path);
        // Deliberately no --force and no filesystem deletion fallback.
        await this.git.run(repo.mainPath, ['worktree', 'remove', target.path], signal);
      });
    });
    const remaining = await this.listInternal(repo.mainPath, signal);
    if (remaining.some((item) => samePath(item.path, target!.path))) {
      throw new WorktreeServiceError('GIT_FAILED', 'Git still reports the worktree after remove returned.');
    }
    try {
      await this.registry.remove(worktreeId);
    } catch {
      return failure('remove', 'REGISTRY_WRITE_FAILED', 'Git removed the worktree, but the EZTerminal registry update failed.');
    }
    return { ok: true, action: 'remove', worktrees: remaining };
  }
}
