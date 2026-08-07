import { createHash } from 'node:crypto';

import {
  hasSensitiveProjectContent,
  isSensitiveProjectPath,
  languageForProjectPath,
  type ProjectDirectoryEntry,
  type ProjectDocumentComparison,
  type ProjectDocumentDirectoryEntry,
  type ProjectDocumentDirectoryResult,
  type ProjectDocumentId,
  type ProjectDocumentIdentity,
  type ProjectDocumentLens,
  type ProjectDocumentSnapshot,
  type ProjectDocumentSnapshotResult,
  type ProjectDocumentTargetResult,
  type ProjectPathRequest,
  type ProjectReviewChange,
  type ProjectReviewFileResult,
  type ProjectReviewIndexResult,
  type ProjectTextResult,
  type ProjectTextSnapshot,
  type ProjectWorkspaceError,
} from '../shared/project-workspace';
import type { ProjectReviewService } from './project-review-service';
import type { ProjectWorkspaceService } from './project-workspace-service';

const MAX_ID_LENGTH = 128;
const MAX_LOCATION = 10_000_000;

interface ResolvedRequest {
  readonly document: ProjectDocumentIdentity;
  readonly request: ProjectPathRequest & { readonly workspaceId: string };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validLocation(value: unknown): value is number | undefined {
  return value === undefined
    || (Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_LOCATION);
}

function normalizeLens(value: unknown): ProjectDocumentLens | null {
  if (value === undefined) return { kind: 'current' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const lens = value as Partial<ProjectDocumentLens>;
  if (lens.kind === 'current' && Object.keys(lens).length === 1) return { kind: 'current' };
  if (lens.kind === 'agent-turn'
    && validId(lens.historyId)
    && validId(lens.turnId)
    && lens.turnId !== 'latest') {
    return { kind: 'agent-turn', historyId: lens.historyId, turnId: lens.turnId };
  }
  return null;
}

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function joinProjectPath(...parts: readonly string[]): string {
  return parts.filter(Boolean).join('/');
}

function parentProjectPath(relativePath: string): string | null {
  if (!relativePath) return null;
  const separator = relativePath.lastIndexOf('/');
  return separator < 0 ? '' : relativePath.slice(0, separator);
}

function toTextSnapshot(relativePath: string, content: string, sensitive: boolean): ProjectTextSnapshot {
  const bytes = Buffer.from(content, 'utf8');
  return {
    relativePath,
    content,
    version: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    language: languageForProjectPath(relativePath),
    sensitive: sensitive
      || isSensitiveProjectPath(relativePath)
      || hasSensitiveProjectContent(content),
  };
}

function currentSnapshot(
  resolved: ResolvedRequest,
  lens: ProjectDocumentLens,
  current: Extract<ProjectTextResult, { readonly ok: true }>['file'],
  extras: Pick<ProjectDocumentSnapshot, 'comparisonError' | 'coverageNotice'> = {},
): ProjectDocumentSnapshot {
  return {
    document: resolved.document,
    lens,
    current,
    state: 'text',
    revision: current.version,
    ...extras,
  };
}

/**
 * Main-owned facade for project navigation. It is intentionally deeper than
 * the renderer-facing operations: canonical identity, repository discovery,
 * Git/provider selection and full-file hydration are one atomic call surface.
 */
export class ProjectDocumentService {
  constructor(
    private readonly workspace: ProjectWorkspaceService,
    private readonly review: ProjectReviewService,
  ) {}

  async resolveTarget(value: unknown): Promise<ProjectDocumentTargetResult> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'invalid-request' };
    }
    const target = value as {
      readonly kind?: unknown;
      readonly projectId?: unknown;
      readonly rootId?: unknown;
      readonly workspaceId?: unknown;
      readonly relativePath?: unknown;
      readonly absolutePath?: unknown;
      readonly lens?: unknown;
      readonly line?: unknown;
      readonly column?: unknown;
    };
    const lens = normalizeLens(target.lens);
    if (!lens || !validLocation(target.line) || !validLocation(target.column)) {
      return { ok: false, error: 'invalid-request' };
    }
    let resolved: ResolvedRequest | { readonly error: ProjectWorkspaceError };
    if (target.kind === 'project-path') {
      if (!validId(target.projectId)
        || !validId(target.rootId)
        || (target.workspaceId !== undefined && !validId(target.workspaceId))
        || typeof target.relativePath !== 'string') {
        return { ok: false, error: 'invalid-request' };
      }
      resolved = await this.resolvePath({
        projectId: target.projectId,
        rootId: target.rootId,
        ...(typeof target.workspaceId === 'string' ? { workspaceId: target.workspaceId } : {}),
        relativePath: target.relativePath,
      });
    } else if (target.kind === 'absolute-path') {
      if ((target.projectId !== undefined && !validId(target.projectId))
        || typeof target.absolutePath !== 'string') {
        return { ok: false, error: 'invalid-request' };
      }
      const absolute = await this.workspace.resolveAbsoluteProjectPath({
        ...(typeof target.projectId === 'string' ? { projectId: target.projectId } : {}),
        absolutePath: target.absolutePath,
      });
      resolved = absolute.ok ? await this.resolvePath(absolute.request) : { error: absolute.error };
    } else {
      return { ok: false, error: 'invalid-request' };
    }
    if ('error' in resolved) return { ok: false, error: resolved.error };
    return {
      ok: true,
      target: {
        document: resolved.document,
        lens,
        ...(typeof target.line === 'number' ? { line: target.line } : {}),
        ...(typeof target.column === 'number' ? { column: target.column } : {}),
      },
    };
  }

  async listDirectory(value: unknown): Promise<ProjectDocumentDirectoryResult> {
    const resolved = await this.resolvePath(value);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    const listed = await this.workspace.listDirectory(resolved.request);
    if (!listed.ok && listed.error !== 'not-found') return listed;

    const located = await this.review.locateRepository(resolved.request);
    if (!located.ok) {
      return listed.ok
        ? this.plainDirectory(
            resolved,
            listed.entries,
            listed.parent,
            located.error === 'not-a-repository' ? undefined : located.error,
          )
        : { ok: false, error: listed.error };
    }
    const index = await this.review.getIndex({
      projectId: resolved.request.projectId,
      rootId: resolved.request.rootId,
      workspaceId: resolved.request.workspaceId,
      ...(located.target.repositoryRelativePath
        ? { repositoryRelativePath: located.target.repositoryRelativePath }
        : {}),
      sourceSelection: { kind: 'working-tree' },
    });
    if (!index.ok) {
      return listed.ok
        ? this.plainDirectory(resolved, listed.entries, listed.parent, index.error)
        : { ok: false, error: listed.error };
    }
    const entries = this.mergeDirectoryEntries(
      resolved,
      listed.ok ? listed.entries : [],
      located.target.repositoryRelativePath,
      located.target.relativePath,
      index.changes,
    );
    if (!listed.ok && entries.length === 0) return { ok: false, error: listed.error };
    return {
      ok: true,
      directory: resolved.document,
      parent: listed.ok ? listed.parent : parentProjectPath(resolved.request.relativePath),
      entries,
      statusRevision: index.revision,
    };
  }

  async readDocument(value: unknown): Promise<ProjectDocumentSnapshotResult> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'invalid-request' };
    }
    const request = value as { readonly document?: unknown; readonly lens?: unknown };
    const lens = normalizeLens(request.lens);
    if (!lens || typeof request.document !== 'object' || request.document === null || Array.isArray(request.document)) {
      return { ok: false, error: 'invalid-request' };
    }
    const resolved = await this.resolvePath(request.document);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    const located = await this.review.locateRepository(resolved.request);
    if (!located.ok) {
      if (lens.kind === 'agent-turn') {
        return this.readComparedDocument(
          resolved,
          lens,
          '',
          resolved.request.relativePath,
        );
      }
      const current = await this.workspace.readText(resolved.request);
      return current.ok
        ? {
            ok: true,
            snapshot: currentSnapshot(
              resolved,
              lens,
              current.file,
              located.error === 'not-a-repository' ? {} : { comparisonError: located.error },
            ),
          }
        : { ok: false, error: current.error, document: resolved.document };
    }
    return this.readComparedDocument(
      resolved,
      lens,
      located.target.repositoryRelativePath,
      located.target.relativePath,
    );
  }

  private async readComparedDocument(
    resolved: ResolvedRequest,
    lens: ProjectDocumentLens,
    repositoryRelativePath: string,
    reviewRelativePath: string,
  ): Promise<ProjectDocumentSnapshotResult> {
    const index = await this.review.getIndex({
      projectId: resolved.request.projectId,
      rootId: resolved.request.rootId,
      workspaceId: resolved.request.workspaceId,
      ...(repositoryRelativePath ? { repositoryRelativePath } : {}),
      sourceSelection: lens.kind === 'current'
        ? { kind: 'working-tree' }
        : { kind: 'agent-turn', historyId: lens.historyId, turnId: lens.turnId },
    });
    if (!index.ok) {
      const latest = await this.workspace.readText(resolved.request);
      return latest.ok
        ? {
            ok: true,
            snapshot: currentSnapshot(resolved, lens, latest.file, {
              comparisonError: index.error,
              ...(index.coverageNotice ? { coverageNotice: index.coverageNotice } : {}),
            }),
          }
        : { ok: false, error: latest.error, document: resolved.document };
    }
    const change = index.changes.find((candidate) =>
      comparablePath(candidate.relativePath) === comparablePath(reviewRelativePath))
      ?? index.changes.find((candidate) => candidate.kind === 'renamed'
        && candidate.previousRelativePath !== undefined
        && comparablePath(candidate.previousRelativePath) === comparablePath(reviewRelativePath));
    if (!change) {
      const latest = await this.workspace.readText(resolved.request);
      return latest.ok
        ? {
            ok: true,
            snapshot: currentSnapshot(
              resolved,
              lens,
              latest.file,
              lens.kind === 'agent-turn' ? { comparisonError: 'not-found' } : {},
            ),
          }
        : { ok: false, error: latest.error, document: resolved.document };
    }
    const reviewed = await this.review.getFile({
      projectId: resolved.request.projectId,
      rootId: resolved.request.rootId,
      workspaceId: resolved.request.workspaceId,
      ...(repositoryRelativePath ? { repositoryRelativePath } : {}),
      sourceSelection: lens.kind === 'current'
        ? { kind: 'working-tree' }
        : { kind: 'agent-turn', historyId: lens.historyId, turnId: lens.turnId },
      relativePath: change.relativePath,
      revision: index.revision,
    });
    if (!reviewed.ok) {
      const latest = await this.workspace.readText(resolved.request);
      return latest.ok
        ? {
            ok: true,
            snapshot: currentSnapshot(resolved, lens, latest.file, {
              comparisonError: reviewed.error,
              ...(index.coverageNotice ? { coverageNotice: index.coverageNotice } : {}),
            }),
          }
        : { ok: false, error: reviewed.error, document: resolved.document };
    }
    if (reviewed.binary) return { ok: false, error: 'binary', document: resolved.document };
    const openedPreviousRename = change.kind === 'renamed'
      && change.previousRelativePath !== undefined
      && comparablePath(change.previousRelativePath) === comparablePath(reviewRelativePath);
    const displayedChange: ProjectReviewChange = openedPreviousRename
      ? {
          ...change,
          relativePath: reviewRelativePath,
          kind: 'deleted',
          additions: 0,
        }
      : change;
    const displayedReview = openedPreviousRename && reviewed.view.kind === 'full-diff'
      ? {
          ...reviewed,
          relativePath: reviewRelativePath,
          modifiedPath: reviewRelativePath,
          view: {
            ...reviewed.view,
            modified: '',
          },
        }
      : openedPreviousRename && reviewed.view.kind === 'current-with-record'
        ? {
            ...reviewed,
            relativePath: reviewRelativePath,
            modifiedPath: reviewRelativePath,
            view: { kind: 'record-only' as const, sections: reviewed.view.sections },
          }
        : reviewed;
    return {
      ok: true,
      snapshot: this.comparedSnapshot(
        resolved,
        lens,
        index,
        displayedChange,
        displayedReview,
        repositoryRelativePath,
      ),
    };
  }

  private comparedSnapshot(
    resolved: ResolvedRequest,
    lens: ProjectDocumentLens,
    index: Extract<ProjectReviewIndexResult, { readonly ok: true }>,
    change: ProjectReviewChange,
    reviewed: Extract<ProjectReviewFileResult, { readonly ok: true; readonly binary: false }>,
    repositoryRelativePath = '',
  ): ProjectDocumentSnapshot {
    const comparison: ProjectDocumentComparison = {
      lens,
      source: index.source,
      title: index.title,
      ...(index.repositoryName ? { repositoryName: index.repositoryName } : {}),
      language: reviewed.language,
      revision: index.revision,
      change,
      originalPath: joinProjectPath(repositoryRelativePath, reviewed.originalPath),
      modifiedPath: joinProjectPath(repositoryRelativePath, reviewed.modifiedPath),
      view: reviewed.view,
      ...(index.coverageNotice ? { coverageNotice: index.coverageNotice } : {}),
    };
    let current: ProjectTextSnapshot | null;
    let state: ProjectDocumentSnapshot['state'];
    if (reviewed.view.kind === 'current-with-record') {
      current = toTextSnapshot(resolved.request.relativePath, reviewed.view.current, reviewed.sensitive);
      state = 'text';
    } else if (change.kind === 'deleted') {
      current = null;
      state = 'deleted';
    } else if (reviewed.view.kind === 'full-diff') {
      current = toTextSnapshot(resolved.request.relativePath, reviewed.view.modified, reviewed.sensitive);
      state = 'text';
    } else {
      current = null;
      state = 'record-only';
    }
    return {
      document: resolved.document,
      lens,
      current,
      state,
      revision: index.revision,
      comparison,
      ...(index.coverageNotice ? { coverageNotice: index.coverageNotice } : {}),
    };
  }

  private async resolvePath(value: unknown): Promise<ResolvedRequest | { readonly error: ProjectWorkspaceError }> {
    const resolved = await this.workspace.resolveProjectPath(value as ProjectPathRequest);
    if (!resolved.ok) return { error: resolved.error };
    const id: ProjectDocumentId = {
      projectId: (value as ProjectPathRequest).projectId,
      rootId: resolved.value.descriptor.rootId,
      workspaceId: resolved.value.workspace.workspaceId,
      relativePath: resolved.value.relativePath,
    };
    return {
      document: this.identity(id),
      request: id,
    };
  }

  private identity(id: ProjectDocumentId): ProjectDocumentIdentity {
    const relativeKey = comparablePath(id.relativePath);
    const key = createHash('sha256')
      .update(`${id.projectId}\0${id.rootId}\0${id.workspaceId}\0${relativeKey}`)
      .digest('hex');
    return { id, key: `project-document:${key}` };
  }

  private plainDirectory(
    resolved: ResolvedRequest,
    entries: readonly ProjectDirectoryEntry[],
    parent: string | null,
    statusError?: ProjectWorkspaceError,
  ): ProjectDocumentDirectoryResult {
    return {
      ok: true,
      directory: resolved.document,
      parent,
      entries: entries.map((entry) => ({
        ...entry,
        document: this.identity({ ...resolved.request, relativePath: entry.relativePath }),
      })),
      ...(statusError ? { statusError } : {}),
    };
  }

  private mergeDirectoryEntries(
    resolved: ResolvedRequest,
    diskEntries: readonly ProjectDirectoryEntry[],
    repositoryRelativePath: string,
    directoryRepositoryPath: string,
    changes: readonly ProjectReviewChange[],
  ): readonly ProjectDocumentDirectoryEntry[] {
    const entries = new Map<string, ProjectDocumentDirectoryEntry>();
    for (const entry of diskEntries) {
      entries.set(comparablePath(entry.relativePath), {
        ...entry,
        document: this.identity({ ...resolved.request, relativePath: entry.relativePath }),
      });
    }
    const prefix = directoryRepositoryPath ? `${directoryRepositoryPath}/` : '';
    for (const change of changes) {
      if (change.kind === 'renamed' && change.previousRelativePath) {
        const comparablePrevious = comparablePath(change.previousRelativePath);
        const comparablePrefix = comparablePath(prefix);
        if (!prefix || comparablePrevious.startsWith(comparablePrefix)) {
          const previousRemainder = prefix
            ? change.previousRelativePath.slice(prefix.length)
            : change.previousRelativePath;
          const previousSeparator = previousRemainder.indexOf('/');
          const previousChildName = previousSeparator < 0
            ? previousRemainder
            : previousRemainder.slice(0, previousSeparator);
          if (previousChildName) {
            const previousChildPath = joinProjectPath(
              repositoryRelativePath,
              directoryRepositoryPath,
              previousChildName,
            );
            const previousKey = comparablePath(previousChildPath);
            if (!entries.has(previousKey)) {
              entries.set(previousKey, {
                name: previousChildName,
                relativePath: previousChildPath,
                kind: previousSeparator < 0 ? 'file' : 'directory',
                size: 0,
                mtimeMs: 0,
                sensitive: isSensitiveProjectPath(previousChildPath),
                document: this.identity({ ...resolved.request, relativePath: previousChildPath }),
                virtual: true,
                ...(previousSeparator < 0 ? {
                  status: 'renamed' as const,
                  additions: 0,
                  deletions: change.deletions,
                  renamedToRelativePath: joinProjectPath(repositoryRelativePath, change.relativePath),
                } : {}),
              });
            }
          }
        }
      }
      const comparableChange = comparablePath(change.relativePath);
      const comparablePrefix = comparablePath(prefix);
      if (prefix && !comparableChange.startsWith(comparablePrefix)) continue;
      const remainder = prefix ? change.relativePath.slice(prefix.length) : change.relativePath;
      if (!remainder) continue;
      const separator = remainder.indexOf('/');
      const childName = separator < 0 ? remainder : remainder.slice(0, separator);
      const childRelativePath = joinProjectPath(
        repositoryRelativePath,
        directoryRepositoryPath,
        childName,
      );
      const key = comparablePath(childRelativePath);
      const existing = entries.get(key);
      if (separator >= 0) {
        if (!existing) {
          entries.set(key, {
            name: childName,
            relativePath: childRelativePath,
            kind: 'directory',
            size: 0,
            mtimeMs: 0,
            sensitive: isSensitiveProjectPath(childRelativePath),
            document: this.identity({ ...resolved.request, relativePath: childRelativePath }),
            virtual: true,
          });
        }
        continue;
      }
      const previousRelativePath = change.previousRelativePath
        ? joinProjectPath(repositoryRelativePath, change.previousRelativePath)
        : undefined;
      entries.set(key, {
        ...(existing ?? {
          name: childName,
          relativePath: childRelativePath,
          kind: 'file' as const,
          size: 0,
          mtimeMs: 0,
          sensitive: isSensitiveProjectPath(childRelativePath),
          document: this.identity({ ...resolved.request, relativePath: childRelativePath }),
          virtual: true,
        }),
        status: change.kind,
        additions: change.additions,
        deletions: change.deletions,
        ...(previousRelativePath ? { previousRelativePath } : {}),
      });
    }
    return [...entries.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
    });
  }
}
