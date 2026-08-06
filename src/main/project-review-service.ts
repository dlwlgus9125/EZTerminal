import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PROJECT_TEXT_MAX_BYTES,
  hasSensitiveProjectContent,
  hasProjectPathControlCharacters,
  isSensitiveProjectPath,
  languageForProjectPath,
  type ProjectChangeKind,
  type ProjectPathRequest,
  type ProjectReviewChange,
  type ProjectReviewFileRequest,
  type ProjectReviewFileResult,
  type ProjectReviewIndexResult,
  type ProjectReviewRequest,
  type ProjectReviewTargetResult,
  type ProjectWorkspaceError,
} from '../shared/project-workspace';
import type { ProviderFileChangeRecord, ProviderFileChangeSet } from './agent-history-provider';
import type { AgentHistoryService } from './agent-history-service';
import {
  recordedProviderSections,
  rehydrateProviderChanges,
} from './provider-change-rehydrator';
import type { ProjectWorkspaceService } from './project-workspace-service';
import { GitCommandError, GitRunner } from './worktree-service';

const MAX_REVIEW_FILES = 2_000;
const MAX_REVIEW_CACHE_ENTRIES = 16;
const MAX_REVIEW_CACHE_BYTES = 8 * 1024 * 1024;
const REVIEW_CACHE_TTL_MS = 5 * 60_000;
const MAX_FILTER_DRIVERS = 128;
const FILTER_COMMAND_PATTERN = '^filter\\..*\\.(clean|process)$';
const SAFE_GIT_PREFIX = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const;

interface GitReviewContext {
  readonly rootPath: string;
  readonly prefix: string;
  readonly scope: 'working-tree' | 'staged' | 'branch';
  readonly headCommit?: string;
  readonly baseCommit?: string;
  readonly revision: string;
  readonly changes: readonly InternalChange[];
  readonly filterOverrides: readonly string[];
}

interface InternalChange extends ProjectReviewChange {
  readonly repoPath: string;
  readonly previousRepoPath?: string;
  readonly workingIdentity?: string;
}

interface ProviderReviewCache {
  readonly key: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly canRehydrate: boolean;
  readonly mapped: ReadonlyMap<string, CachedProviderFile>;
}

interface CachedProviderFile {
  readonly records: readonly ProviderFileChangeRecord[];
  readonly previousRelativePath?: string;
}

function asRequest(value: unknown): ProjectReviewRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const request = value as Partial<ProjectReviewRequest>;
  const repositoryRelativePath = request.repositoryRelativePath === undefined || request.repositoryRelativePath === ''
    ? ''
    : normalizeRepoPath(request.repositoryRelativePath);
  if (
    typeof request.projectId !== 'string'
    || request.projectId.length < 1
    || request.projectId.length > 128
    || typeof request.rootId !== 'string'
    || request.rootId.length < 1
    || request.rootId.length > 128
    || !['last-turn', 'working-tree', 'staged', 'branch'].includes(request.scope ?? '')
    || repositoryRelativePath === null
    || (request.historyId !== undefined
      && (typeof request.historyId !== 'string' || request.historyId.length < 1 || request.historyId.length > 128))
    || (request.reviewTurnId !== undefined
      && (typeof request.reviewTurnId !== 'string' || request.reviewTurnId.length < 1 || request.reviewTurnId.length > 128))
    || (request.baseRef !== undefined
      && (typeof request.baseRef !== 'string' || !isSafeRef(request.baseRef)))
  ) {
    return null;
  }
  return {
    ...request as ProjectReviewRequest,
    ...(repositoryRelativePath ? { repositoryRelativePath } : { repositoryRelativePath: undefined }),
  };
}

function isSafeRef(value: string): boolean {
  return value.length > 0
    && value.length <= 200
    && !value.startsWith('-')
    && !value.includes('\0')
    && !value.includes('..')
    && /^[A-Za-z0-9_./-]+$/u.test(value);
}

function normalizeRepoPath(value: string): string | null {
  if (!value || hasProjectPathControlCharacters(value) || path.isAbsolute(value)) return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//u, '');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return normalized;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function relativePathInside(rootPath: string, candidatePath: string): string | null {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return normalizeRepoPath(relative);
}

function relativeWithinPrefix(repoPath: string, prefix: string): string | null {
  const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/u, '');
  if (!normalizedPrefix) return repoPath;
  const boundary = `${normalizedPrefix}/`;
  const comparablePath = process.platform === 'win32' ? repoPath.toLocaleLowerCase('en-US') : repoPath;
  const comparableBoundary = process.platform === 'win32'
    ? boundary.toLocaleLowerCase('en-US')
    : boundary;
  if (!comparablePath.startsWith(comparableBoundary)) return null;
  return repoPath.slice(boundary.length) || null;
}

function kindFromStatus(status: string): ProjectChangeKind {
  if (status.includes('R')) return 'renamed';
  if (status.includes('A') || status === '??') return 'added';
  if (status.includes('D')) return 'deleted';
  return 'modified';
}

function parseNameStatusZ(output: string, prefix: string): InternalChange[] {
  const fields = output.split('\0');
  const changes: InternalChange[] = [];
  for (let index = 0; index < fields.length && changes.length < MAX_REVIEW_FILES; index += 1) {
    const status = fields[index];
    if (!status) continue;
    const repoPath = normalizeRepoPath(fields[index + 1] ?? '');
    index += 1;
    if (!repoPath) continue;
    let previousRepoPath: string | undefined;
    let targetRepoPath = repoPath;
    if (status.startsWith('R') || status.startsWith('C')) {
      const renamed = normalizeRepoPath(fields[index + 1] ?? '');
      index += 1;
      if (!renamed) continue;
      previousRepoPath = repoPath;
      targetRepoPath = renamed;
    }
    const relativePath = relativeWithinPrefix(targetRepoPath, prefix);
    if (!relativePath) continue;
    const previousRelativePath = previousRepoPath
      ? relativeWithinPrefix(previousRepoPath, prefix) ?? undefined
      : undefined;
    changes.push({
      relativePath,
      ...(previousRelativePath ? { previousRelativePath } : {}),
      kind: kindFromStatus(status),
      additions: 0,
      deletions: 0,
      binary: false,
      repoPath: targetRepoPath,
      ...(previousRepoPath ? { previousRepoPath } : {}),
    });
  }
  return changes;
}

function parsePorcelainZ(output: string, prefix: string): InternalChange[] {
  const fields = output.split('\0');
  const changes: InternalChange[] = [];
  for (let index = 0; index < fields.length && changes.length < MAX_REVIEW_FILES; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const repoPath = normalizeRepoPath(field.slice(3));
    if (!repoPath) continue;
    let previousRepoPath: string | undefined;
    if (status.includes('R') || status.includes('C')) {
      const previous = normalizeRepoPath(fields[index + 1] ?? '');
      index += 1;
      if (previous) previousRepoPath = previous;
    }
    const relativePath = relativeWithinPrefix(repoPath, prefix);
    if (!relativePath) continue;
    const previousRelativePath = previousRepoPath
      ? relativeWithinPrefix(previousRepoPath, prefix) ?? undefined
      : undefined;
    changes.push({
      relativePath,
      ...(previousRelativePath ? { previousRelativePath } : {}),
      kind: kindFromStatus(status),
      additions: 0,
      deletions: 0,
      binary: false,
      repoPath,
      ...(previousRepoPath ? { previousRepoPath } : {}),
    });
  }
  return changes;
}

function parseNumstatZ(output: string, prefix: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    let repoPath = parts[2] ?? '';
    if (!repoPath) {
      repoPath = fields[index + 2] ?? '';
      index += 2;
    }
    const normalized = normalizeRepoPath(repoPath);
    if (!normalized) continue;
    const relativePath = relativeWithinPrefix(normalized, prefix);
    if (!relativePath) continue;
    const binary = parts[0] === '-' || parts[1] === '-';
    stats.set(relativePath, {
      additions: binary ? 0 : Number.parseInt(parts[0] ?? '0', 10) || 0,
      deletions: binary ? 0 : Number.parseInt(parts[1] ?? '0', 10) || 0,
      binary,
    });
  }
  return stats;
}

function withStats(
  changes: readonly InternalChange[],
  stats: ReadonlyMap<string, { additions: number; deletions: number; binary: boolean }>,
): readonly InternalChange[] {
  return changes.map((change) => ({ ...change, ...(stats.get(change.relativePath) ?? {}) }));
}

function publicChange(change: InternalChange): ProjectReviewChange {
  return {
    relativePath: change.relativePath,
    ...(change.previousRelativePath ? { previousRelativePath: change.previousRelativePath } : {}),
    kind: change.kind,
    additions: change.additions,
    deletions: change.deletions,
    binary: change.binary,
  };
}

function countTextChanges(original: string, modified: string): { additions: number; deletions: number } {
  const originalLines = original ? original.split(/\r\n|\r|\n/u).length : 0;
  const modifiedLines = modified ? modified.split(/\r\n|\r|\n/u).length : 0;
  return { additions: modifiedLines, deletions: originalLines };
}

function countPatch(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

/** Build bounded hunk views when a provider records a patch but not full blobs. */
function modelsFromPatch(diff: string): { original: string; modified: string } {
  const original: string[] = [];
  const modified: string[] = [];
  for (const line of diff.replaceAll('\r\n', '\n').split('\n')) {
    if (/^(?:diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/u.test(line)) continue;
    if (line.startsWith('@@')) {
      original.push(line);
      modified.push(line);
    } else if (line.startsWith('-')) {
      original.push(line.slice(1));
    } else if (line.startsWith('+')) {
      modified.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      original.push(line.slice(1));
      modified.push(line.slice(1));
    }
  }
  return { original: original.join('\n'), modified: modified.join('\n') };
}

function modelsFromProviderRecords(
  records: readonly ProviderFileChangeRecord[],
): { original: string; modified: string } {
  const models = records.map((record) => record.diff
    ? modelsFromPatch(record.diff)
    : { original: record.original ?? '', modified: record.modified ?? '' });
  return models.reduce((combined, model, index) => {
    if (index === 0) return model;
    const separator = `@@ recorded change ${String(index + 1)} @@`;
    return {
      original: `${combined.original}\n${separator}\n${model.original}`,
      modified: `${combined.modified}\n${separator}\n${model.modified}`,
    };
  }, { original: '', modified: '' });
}

function combinedProviderKind(
  current: ProjectChangeKind,
  next: ProjectChangeKind,
): ProjectChangeKind {
  if (next === 'deleted') return 'deleted';
  if (current === 'added') return 'added';
  if (current === 'renamed' || next === 'renamed') return 'renamed';
  return next;
}

function isNotRepository(error: unknown): boolean {
  return error instanceof GitCommandError && /not a git repository|not inside .*work tree/iu.test(error.stderr);
}

export class ProjectReviewService {
  private readonly git = new GitRunner(execFile, { timeoutMs: 10_000, maxBuffer: 2 * 1024 * 1024 });
  private readonly providerCache = new Map<string, ProviderReviewCache>();

  constructor(
    private readonly workspace: ProjectWorkspaceService,
    private readonly history: AgentHistoryService,
  ) {}

  async locateFile(value: unknown, signal?: AbortSignal): Promise<ProjectReviewTargetResult> {
    const resolved = await this.workspace.resolveProjectPath(value as ProjectPathRequest);
    if (!resolved.ok) return resolved;
    const request = value as ProjectPathRequest;
    try {
      const before = await fs.lstat(resolved.value.absolutePath);
      if (before.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!before.isFile()) return { ok: false, error: 'not-a-file' };
      const actualFile = await fs.realpath(resolved.value.absolutePath);
      if (pathKey(actualFile) !== pathKey(resolved.value.absolutePath)) {
        return { ok: false, error: 'symlink-not-supported' };
      }
      if (relativePathInside(resolved.value.rootPath, actualFile) === null) {
        return { ok: false, error: 'path-outside-root' };
      }

      const discovered = (await this.runGit(
        path.dirname(actualFile),
        ['rev-parse', '--show-toplevel'],
        signal,
      )).trim();
      if (!discovered) return { ok: false, error: 'not-a-repository' };
      const repositoryPath = path.resolve(discovered);
      const repositoryStat = await fs.lstat(repositoryPath);
      if (repositoryStat.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!repositoryStat.isDirectory()) return { ok: false, error: 'not-a-directory' };
      const actualRepository = await fs.realpath(repositoryPath);
      if (pathKey(actualRepository) !== pathKey(repositoryPath)) {
        return { ok: false, error: 'symlink-not-supported' };
      }
      const repositoryRelativePath = relativePathInside(resolved.value.rootPath, actualRepository);
      if (repositoryRelativePath === null) return { ok: false, error: 'path-outside-root' };
      const relativePath = relativePathInside(actualRepository, actualFile);
      if (!relativePath) return { ok: false, error: 'not-a-file' };

      return {
        ok: true,
        target: {
          projectId: request.projectId,
          rootId: request.rootId,
          repositoryRelativePath,
          repositoryName: path.basename(actualRepository) || actualRepository,
          relativePath,
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return { ok: false, error: 'not-found' };
      return { ok: false, error: this.gitError(error) };
    }
  }

  async getIndex(value: unknown, signal?: AbortSignal): Promise<ProjectReviewIndexResult> {
    const request = asRequest(value);
    if (!request) return { ok: false, error: 'invalid-request' };
    if (request.scope === 'last-turn') return this.getLastTurnIndex(request);
    const context = await this.gitContext(request, signal);
    if (!context.ok) return context;
    const scopeTitle = request.scope === 'working-tree'
      ? 'Working tree'
      : request.scope === 'staged'
        ? 'Staged changes'
        : `Branch from ${request.baseRef ?? 'main'}`;
    const repositoryName = path.basename(context.value.rootPath) || context.value.rootPath;
    return {
      ok: true,
      scope: request.scope,
      source: 'git',
      title: request.repositoryRelativePath ? `${repositoryName} · ${scopeTitle}` : scopeTitle,
      repositoryName,
      revision: context.value.revision,
      changes: context.value.changes.map(publicChange),
      ...(request.scope === 'branch' ? { baseRef: request.baseRef ?? 'main' } : {}),
    };
  }

  async getFile(value: unknown, signal?: AbortSignal): Promise<ProjectReviewFileResult> {
    const request = this.asFileRequest(value);
    if (!request) return { ok: false, error: 'invalid-request' };
    if (request.scope === 'last-turn') return this.getLastTurnFile(request);
    const context = await this.gitContext(request, signal);
    if (!context.ok) return context;
    if (context.value.revision !== request.revision) return { ok: false, error: 'stale' };
    const change = context.value.changes.find((candidate) => candidate.relativePath === request.relativePath);
    if (!change) return { ok: false, error: 'stale' };

    try {
      const originalRepoPath = change.previousRepoPath ?? change.repoPath;
      let original = '';
      let modified = '';
      if (request.scope === 'working-tree') {
        if (change.kind !== 'added') {
          if (!context.value.headCommit) return { ok: false, error: 'stale' };
          original = await this.readGitBlob(
            context.value.rootPath,
            context.value.headCommit,
            originalRepoPath,
            context.value.filterOverrides,
            signal,
          );
        }
        if (change.kind !== 'deleted') {
          const current = await this.workspace.readText({
            projectId: request.projectId,
            rootId: request.rootId,
            relativePath: request.repositoryRelativePath
              ? `${request.repositoryRelativePath}/${request.relativePath}`
              : request.relativePath,
          });
          if (!current.ok) {
            if (current.error === 'binary') return this.binaryFile(change);
            return current;
          }
          modified = current.file.content;
          const afterIdentity = await this.workingFileIdentity(
            context.value.rootPath,
            request.relativePath,
          );
          if (afterIdentity !== change.workingIdentity) return { ok: false, error: 'stale' };
        }
      } else if (request.scope === 'staged') {
        if (change.kind !== 'added') {
          if (!context.value.headCommit) return { ok: false, error: 'stale' };
          original = await this.readGitBlob(
            context.value.rootPath,
            context.value.headCommit,
            originalRepoPath,
            context.value.filterOverrides,
            signal,
          );
        }
        if (change.kind !== 'deleted') {
          const beforeObject = await this.readIndexObjectId(
            context.value.rootPath,
            change.repoPath,
            context.value.filterOverrides,
            signal,
          );
          modified = await this.readIndexBlob(
            context.value.rootPath,
            change.repoPath,
            context.value.filterOverrides,
            signal,
          );
          const afterObject = await this.readIndexObjectId(
            context.value.rootPath,
            change.repoPath,
            context.value.filterOverrides,
            signal,
          );
          if (beforeObject !== afterObject) return { ok: false, error: 'stale' };
        }
      } else {
        if (change.kind !== 'added') {
          original = await this.readGitBlob(context.value.rootPath, context.value.baseCommit!, originalRepoPath, context.value.filterOverrides, signal);
        }
        if (change.kind !== 'deleted') {
          if (!context.value.headCommit) return { ok: false, error: 'stale' };
          modified = await this.readGitBlob(
            context.value.rootPath,
            context.value.headCommit,
            change.repoPath,
            context.value.filterOverrides,
            signal,
          );
        }
      }
      if (original.includes('\0') || modified.includes('\0')) return this.binaryFile(change);
      if (Buffer.byteLength(original) > PROJECT_TEXT_MAX_BYTES || Buffer.byteLength(modified) > PROJECT_TEXT_MAX_BYTES) {
        return { ok: false, error: 'too-large' };
      }
      return {
        ok: true,
        relativePath: change.relativePath,
        originalPath: change.previousRelativePath ?? change.relativePath,
        modifiedPath: change.relativePath,
        language: languageForProjectPath(change.relativePath),
        binary: false,
        view: {
          kind: 'full-diff',
          coverage: 'full-file',
          original,
          modified,
        },
        sensitive: isSensitiveProjectPath(change.relativePath)
          || hasSensitiveProjectContent(original)
          || hasSensitiveProjectContent(modified),
      };
    } catch (error) {
      return { ok: false, error: this.gitError(error) };
    }
  }

  private async getLastTurnIndex(request: ProjectReviewRequest): Promise<ProjectReviewIndexResult> {
    if (!request.historyId) {
      return {
        ok: false,
        error: 'unsupported',
        fallbackScope: 'working-tree',
        coverageNotice: 'No completed structured provider turn is linked to this panel. Showing the working tree avoids false attribution.',
      };
    }
    let changeSet: ProviderFileChangeSet | null;
    try {
      changeSet = await this.history.readFileChanges(request.historyId, request.reviewTurnId);
    } catch {
      changeSet = null;
    }
    if (!changeSet) {
      return {
        ok: false,
        error: 'unsupported',
        fallbackScope: 'working-tree',
        coverageNotice: request.reviewTurnId
          ? 'The provider did not expose a completed structured change record for the selected turn. These files are not attributed to that turn.'
          : 'The provider did not expose a latest completed structured change record. These files are not attributed to the agent.',
      };
    }
    const root = await this.workspace.resolveProjectPath({
      projectId: request.projectId,
      rootId: request.rootId,
      relativePath: '',
    });
    if (!root.ok) return root;
    const mapped = new Map<string, CachedProviderFile>();
    const summaries = new Map<string, ProjectReviewChange>();
    let cachedBytes = 0;
    let providerTruncated = false;
    for (const providerChange of changeSet.changes) {
      const changeBytes = Buffer.byteLength(providerChange.diff ?? '')
        + Buffer.byteLength(providerChange.original ?? '')
        + Buffer.byteLength(providerChange.modified ?? '');
      if (cachedBytes + changeBytes > MAX_REVIEW_CACHE_BYTES) {
        providerTruncated = true;
        break;
      }
      const projectRelativePath = this.providerRelativePath(providerChange.path, root.value.rootPath);
      const relativePath = projectRelativePath
        ? relativeWithinPrefix(projectRelativePath, request.repositoryRelativePath ?? '')
        : null;
      if (!relativePath) continue;
      const previousProjectRelativePath = providerChange.previousPath
        ? this.providerRelativePath(providerChange.previousPath, root.value.rootPath)
        : null;
      const previousRelativePath = previousProjectRelativePath
        ? relativeWithinPrefix(previousProjectRelativePath, request.repositoryRelativePath ?? '') ?? undefined
        : undefined;
      const counts = providerChange.diff
        ? countPatch(providerChange.diff)
        : countTextChanges(providerChange.original ?? '', providerChange.modified ?? '');
      const cached = mapped.get(relativePath);
      const summary = summaries.get(relativePath);
      if (cached && summary) {
        mapped.set(relativePath, {
          records: [...cached.records, providerChange],
          ...(cached.previousRelativePath || previousRelativePath
            ? { previousRelativePath: cached.previousRelativePath ?? previousRelativePath }
            : {}),
        });
        summaries.set(relativePath, {
          ...summary,
          kind: combinedProviderKind(summary.kind, providerChange.kind),
          additions: summary.additions + counts.additions,
          deletions: summary.deletions + counts.deletions,
        });
      } else {
        if (mapped.size >= MAX_REVIEW_FILES) {
          providerTruncated = true;
          break;
        }
        mapped.set(relativePath, {
          records: [providerChange],
          ...(previousRelativePath ? { previousRelativePath } : {}),
        });
        summaries.set(relativePath, {
          relativePath,
          ...(previousRelativePath ? { previousRelativePath } : {}),
          kind: providerChange.kind,
          ...counts,
          binary: false,
        });
      }
      cachedBytes += changeBytes;
    }
    const changes = [...summaries.values()];
    const revision = createHash('sha256')
      .update(`${request.historyId}\0${request.reviewTurnId ?? ''}\0${changeSet.turnId}\0${JSON.stringify(changes)}`)
      .digest('hex');
    this.cacheProviderReview({
      key: this.providerKey(request, revision),
      createdAt: Date.now(),
      bytes: cachedBytes,
      canRehydrate: !providerTruncated,
      mapped,
    });
    return {
      ok: true,
      scope: request.scope,
      source: changeSet.provider,
      title: request.reviewTurnId ? 'Selected completed turn' : 'Last completed turn',
      revision,
      changes,
      coverageNotice: `${changeSet.provider === 'claude'
        ? 'Claude attribution includes successful Edit, Write, and NotebookEdit tool pairs. Exact edits use verified current-file context; other records appear alongside the complete current file when it is available.'
        : `Codex attribution includes structured fileChange records from the ${request.reviewTurnId ? 'selected' : 'latest'} completed turn only. Exact patches use verified current-file context; other records appear alongside the complete current file when it is available.`}${providerTruncated ? ' The bounded review cache omitted later records.' : ''}`,
    };
  }

  private async getLastTurnFile(request: ProjectReviewFileRequest): Promise<ProjectReviewFileResult> {
    let cache = this.providerCache.get(this.providerKey(request, request.revision));
    if (!cache || Date.now() - cache.createdAt > REVIEW_CACHE_TTL_MS) {
      const index = await this.getLastTurnIndex(request);
      if (!index.ok) return index;
      if (index.revision !== request.revision) return { ok: false, error: 'stale' };
      cache = this.providerCache.get(this.providerKey(request, request.revision));
    }
    const cached = cache?.mapped.get(request.relativePath);
    if (!cached) return { ok: false, error: 'stale' };
    const fragmentModels = modelsFromProviderRecords(cached.records);
    const current = await this.workspace.readText({
      projectId: request.projectId,
      rootId: request.rootId,
      relativePath: request.repositoryRelativePath
        ? `${request.repositoryRelativePath}/${request.relativePath}`
        : request.relativePath,
    });
    const sections = recordedProviderSections(current.ok ? current.file.content : undefined, cached.records);
    const recordedBytes = sections.reduce((total, section) => total
      + section.lines.reduce((lineTotal, line) => lineTotal + Buffer.byteLength(line.text) + 1, 0), 0);
    if (recordedBytes > PROJECT_TEXT_MAX_BYTES) return { ok: false, error: 'too-large' };
    let view: Extract<ProjectReviewFileResult, { readonly ok: true; readonly binary: false }>['view'];
    if (current.ok) {
      if (cache?.canRehydrate) {
        const rehydrated = rehydrateProviderChanges(current.file.content, cached.records);
        if (rehydrated.ok
          && Buffer.byteLength(rehydrated.original) <= PROJECT_TEXT_MAX_BYTES
          && Buffer.byteLength(rehydrated.modified) <= PROJECT_TEXT_MAX_BYTES) {
          view = {
            kind: 'full-diff',
            coverage: 'current-context',
            original: rehydrated.original,
            modified: rehydrated.modified,
          };
        } else {
          view = { kind: 'current-with-record', current: current.file.content, sections };
        }
      } else {
        view = { kind: 'current-with-record', current: current.file.content, sections };
      }
    } else {
      if (current.error === 'binary') {
        return {
          ok: true,
          relativePath: request.relativePath,
          originalPath: cached.previousRelativePath ?? request.relativePath,
          modifiedPath: request.relativePath,
          binary: true,
          sensitive: isSensitiveProjectPath(request.relativePath),
        };
      }
      if (current.error === 'too-large') return current;
      view = { kind: 'record-only', sections };
    }
    return {
      ok: true,
      relativePath: request.relativePath,
      originalPath: cached.previousRelativePath ?? request.relativePath,
      modifiedPath: request.relativePath,
      language: languageForProjectPath(request.relativePath),
      binary: false,
      view,
      sensitive: isSensitiveProjectPath(request.relativePath)
        || hasSensitiveProjectContent(fragmentModels.original)
        || hasSensitiveProjectContent(fragmentModels.modified)
        || (current.ok && hasSensitiveProjectContent(current.file.content)),
    };
  }

  private async gitContext(request: ProjectReviewRequest, signal?: AbortSignal): Promise<
    | { readonly ok: true; readonly value: GitReviewContext }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    if (request.scope === 'last-turn') return { ok: false, error: 'invalid-request' };
    const scope = request.scope;
    const root = await this.workspace.resolveProjectPath({
      projectId: request.projectId,
      rootId: request.rootId,
      relativePath: request.repositoryRelativePath ?? '',
    });
    if (!root.ok) return root;
    try {
      const reviewRootPath = root.value.absolutePath;
      const inside = (await this.runGit(reviewRootPath, ['rev-parse', '--is-inside-work-tree'], signal)).trim();
      if (inside !== 'true') return { ok: false, error: 'not-a-repository' };
      if (request.repositoryRelativePath) {
        const topLevel = (await this.runGit(reviewRootPath, ['rev-parse', '--show-toplevel'], signal)).trim();
        const actualTopLevel = await fs.realpath(path.resolve(topLevel));
        const actualReviewRoot = await fs.realpath(reviewRootPath);
        if (pathKey(actualTopLevel) !== pathKey(actualReviewRoot)) {
          return { ok: false, error: 'not-a-repository' };
        }
      }
      const prefix = (await this.runGit(reviewRootPath, ['rev-parse', '--show-prefix'], signal)).trim();
      const filterOverrides = await this.readFilterOverrides(reviewRootPath, signal);
      const safeRun = (args: readonly string[]): Promise<string> =>
        this.runGit(reviewRootPath, [...filterOverrides, ...args], signal);
      const headCommit = await safeRun(['rev-parse', '--verify', 'HEAD'])
        .then((output) => output.trim())
        .catch(() => undefined);
      let names = '';
      let numstat = '';
      let objectEvidence = '';
      let baseCommit: string | undefined;
      if (scope === 'working-tree') {
        names = await safeRun(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
        if (headCommit) {
          [numstat, objectEvidence] = await Promise.all([
            safeRun(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', headCommit, '--', '.']),
            safeRun(['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--abbrev=64', headCommit, '--', '.']),
          ]);
        }
      } else if (scope === 'staged') {
        const baseArgs = headCommit ? ['--cached', headCommit] : ['--cached'];
        [names, numstat, objectEvidence] = await Promise.all([
          safeRun(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', ...baseArgs, '--', '.']),
          safeRun(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', ...baseArgs, '--', '.']),
          safeRun(['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--abbrev=64', ...baseArgs, '--', '.']),
        ]);
      } else {
        if (!headCommit) return { ok: false, error: 'git-failed' };
        const baseRef = request.baseRef ?? 'main';
        const verified = (await safeRun(['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
        baseCommit = (await safeRun(['merge-base', verified, headCommit])).trim();
        [names, numstat] = await Promise.all([
          safeRun(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', baseCommit, headCommit, '--', '.']),
          safeRun(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', baseCommit, headCommit, '--', '.']),
        ]);
      }
      const rawChanges = scope === 'working-tree'
        ? parsePorcelainZ(names, prefix)
        : parseNameStatusZ(names, prefix);
      const stats = parseNumstatZ(numstat, prefix);
      let changes = withStats(rawChanges, stats);
      if (scope === 'working-tree') {
        changes = await this.captureWorkingIdentities(reviewRootPath, changes);
      }
      const workingEvidence = changes
        .map((change) => `${change.relativePath}\0${change.workingIdentity ?? ''}`)
        .join('\0');
      const revision = createHash('sha256')
        .update(`${scope}\0${baseCommit ?? ''}\0${headCommit ?? 'unborn'}\0${names}\0${numstat}\0${objectEvidence}\0${workingEvidence}`)
        .digest('hex');
      return {
        ok: true,
        value: {
          rootPath: reviewRootPath,
          prefix,
          scope,
          ...(headCommit ? { headCommit } : {}),
          ...(baseCommit ? { baseCommit } : {}),
          revision,
          changes,
          filterOverrides,
        },
      };
    } catch (error) {
      return { ok: false, error: this.gitError(error) };
    }
  }

  private runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    return this.git.run(cwd, [...SAFE_GIT_PREFIX, ...args], signal);
  }

  private async captureWorkingIdentities(
    rootPath: string,
    changes: readonly InternalChange[],
  ): Promise<readonly InternalChange[]> {
    return Promise.all(changes.map(async (change) => {
      if (change.kind === 'deleted') return change;
      return {
        ...change,
        workingIdentity: await this.workingFileIdentity(rootPath, change.relativePath),
      };
    }));
  }

  private async workingFileIdentity(rootPath: string, relativePath: string): Promise<string> {
    try {
      const stat = await fs.lstat(path.join(rootPath, ...relativePath.split('/')), { bigint: true });
      return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
        .map(String)
        .join(':');
    } catch (error) {
      return `missing:${String((error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown')}`;
    }
  }

  private readGitBlob(
    cwd: string,
    revision: string,
    repoPath: string,
    filterOverrides: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.runGit(cwd, [...filterOverrides, 'show', '--no-textconv', `${revision}:${repoPath}`], signal);
  }

  private readIndexBlob(
    cwd: string,
    repoPath: string,
    filterOverrides: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.runGit(cwd, [...filterOverrides, 'show', '--no-textconv', `:${repoPath}`], signal);
  }

  private readIndexObjectId(
    cwd: string,
    repoPath: string,
    filterOverrides: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.runGit(
      cwd,
      [...filterOverrides, 'rev-parse', '--verify', `:${repoPath}`],
      signal,
    ).then((output) => output.trim());
  }

  private async readFilterOverrides(cwd: string, signal?: AbortSignal): Promise<readonly string[]> {
    let output: string;
    try {
      output = await this.runGit(
        cwd,
        ['config', '--null', '--name-only', '--get-regexp', FILTER_COMMAND_PATTERN],
        signal,
      );
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1 && error.stderr.trim() === '') return [];
      throw error;
    }
    const drivers = new Set<string>();
    for (const key of output.split('\0').filter(Boolean)) {
      const suffix = key.endsWith('.clean') ? '.clean' : key.endsWith('.process') ? '.process' : null;
      if (!suffix || !key.startsWith('filter.')) continue;
      const driver = key.slice(0, -suffix.length);
      if (driver.length <= 'filter.'.length || driver.includes('=') || driver.length > 1024) {
        throw new Error('Unsafe Git filter configuration key');
      }
      drivers.add(driver);
      if (drivers.size > MAX_FILTER_DRIVERS) throw new Error('Too many Git filter drivers');
    }
    return [...drivers].flatMap((driver) => [
      '-c', `${driver}.clean=`,
      '-c', `${driver}.process=`,
      '-c', `${driver}.required=false`,
    ]);
  }

  private providerRelativePath(providerPath: string, rootPath: string): string | null {
    const candidate = path.isAbsolute(providerPath)
      ? path.normalize(providerPath)
      : path.resolve(rootPath, providerPath);
    const relative = path.relative(rootPath, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    return normalizeRepoPath(relative);
  }

  private providerKey(request: ProjectReviewRequest, revision: string): string {
    return `${request.projectId}\0${request.rootId}\0${request.repositoryRelativePath ?? ''}\0${request.historyId ?? ''}\0${request.reviewTurnId ?? ''}\0${revision}`;
  }

  private cacheProviderReview(entry: ProviderReviewCache): void {
    this.providerCache.delete(entry.key);
    this.providerCache.set(entry.key, entry);
    let bytes = [...this.providerCache.values()].reduce((sum, cached) => sum + cached.bytes, 0);
    while (this.providerCache.size > MAX_REVIEW_CACHE_ENTRIES || bytes > MAX_REVIEW_CACHE_BYTES) {
      const oldestKey = this.providerCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.providerCache.get(oldestKey);
      this.providerCache.delete(oldestKey);
      bytes -= oldest?.bytes ?? 0;
    }
  }

  private binaryFile(change: ProjectReviewChange): ProjectReviewFileResult {
    return {
      ok: true,
      relativePath: change.relativePath,
      originalPath: change.previousRelativePath ?? change.relativePath,
      modifiedPath: change.relativePath,
      binary: true,
      sensitive: isSensitiveProjectPath(change.relativePath),
    };
  }

  private gitError(error: unknown): ProjectWorkspaceError {
    return isNotRepository(error) ? 'not-a-repository' : 'git-failed';
  }

  private asFileRequest(value: unknown): ProjectReviewFileRequest | null {
    const request = asRequest(value);
    if (!request || typeof value !== 'object' || value === null) return null;
    const candidate = value as Partial<ProjectReviewFileRequest>;
    const relativePath = typeof candidate.relativePath === 'string'
      ? normalizeRepoPath(candidate.relativePath)
      : null;
    if (!relativePath || typeof candidate.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.revision)) {
      return null;
    }
    return { ...request, relativePath, revision: candidate.revision };
  }
}
