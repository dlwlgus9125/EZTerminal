import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PROJECT_SEARCH_MAX_BYTES,
  PROJECT_SEARCH_MAX_FILES,
  PROJECT_SEARCH_MAX_QUERY,
  PROJECT_SEARCH_MAX_RESULTS,
  PROJECT_SEARCH_TIMEOUT_MS,
  PROJECT_TEXT_MAX_BYTES,
  hasSensitiveProjectContent,
  hasProjectPathControlCharacters,
  isProjectSessionTarget,
  isSensitiveProjectPath,
  languageForProjectPath,
  type ProjectDirectoryEntry,
  type ProjectDirectoryResult,
  type ProjectPathRequest,
  type ProjectRootDescriptor,
  type ProjectSearchMatch,
  type ProjectSearchRequest,
  type ProjectSearchResult,
  type ProjectTerminalDirectoryResult,
  type ProjectSessionTarget,
  type ProjectTextResult,
  type ProjectWorkspaceDescriptorResult,
  type ProjectWorkspaceDescriptor,
  type ProjectWorkspaceDiscovery,
  type ProjectWorkspaceAccessRequest,
  type ProjectWorkspaceAccessResult,
  type ProjectWorkspaceError,
  type ProjectWorkspaceLocationDescriptor,
} from '../shared/project-workspace';
import type { WorktreeResult } from '../shared/worktree';
import type { AgentProjectRecord, AgentProjectStore } from './agent-project-store';
import type {
  ProjectWorkspaceAccessIdentity,
  ProjectWorkspaceAccessIntent,
  ProjectWorkspaceAccessStore,
  ProjectWorkspaceApprovalIntent,
  ProjectWorkspaceRevocationIntent,
} from './project-workspace-access-store';

const MAX_RELATIVE_PATH_LENGTH = 4096;
const SEARCH_READ_CONCURRENCY = 8;

interface ResolvedProjectRoot {
  readonly project: AgentProjectRecord;
  readonly descriptor: ProjectRootDescriptor;
  readonly rootPath: string;
  readonly workspace: ProjectWorkspaceLocationDescriptor;
}

interface ResolvedPath extends ResolvedProjectRoot {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export type ProjectSessionTargetResolution =
  | {
      readonly ok: true;
      readonly target: ProjectSessionTarget;
      readonly projectName: string;
      readonly cwd: string;
      readonly roots: readonly string[];
      /** Persistence-store id, kept in main only. */
      readonly storedProjectId: string;
    }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export type ProjectTerminalDirectoryContextResult =
  | (Extract<ProjectTerminalDirectoryResult, { readonly ok: true }> & {
      /** Exact descriptor captured by the successful path authorization. */
      readonly project: ProjectWorkspaceDescriptor;
    })
  | Extract<ProjectTerminalDirectoryResult, { readonly ok: false }>;

export type ProjectWorkspaceRevocationPreparation =
  | { readonly ok: true; readonly request: ProjectWorkspaceAccessRequest }
  | { readonly ok: false };

export type ProjectWorkspaceApprovalContextResult =
  | (Extract<ProjectWorkspaceAccessResult, { readonly ok: true }> & {
      /** Exact post-approval descriptor; avoids weaker rediscovery in main. */
      readonly project: ProjectWorkspaceDescriptor;
    })
  | Extract<ProjectWorkspaceAccessResult, { readonly ok: false }>;

export type ProjectWorkspaceApprovalIntentResult =
  | (Extract<ProjectWorkspaceApprovalContextResult, { readonly ok: true }> & {
      readonly intent: ProjectWorkspaceApprovalIntent;
    })
  | Extract<ProjectWorkspaceAccessResult, { readonly ok: false }>;

export type ProjectWorkspaceRevocationIntentResult =
  | {
      readonly ok: true;
      readonly intent: ProjectWorkspaceRevocationIntent;
      readonly request: ProjectWorkspaceAccessRequest;
    }
  | { readonly ok: false };

export type ProjectWorkspaceAccessRecoveryResult =
  | Extract<ProjectWorkspaceApprovalIntentResult, { readonly ok: true }>
  | Extract<ProjectWorkspaceRevocationIntentResult, { readonly ok: true }>
  | {
      readonly ok: false;
      readonly intent: ProjectWorkspaceAccessIntent;
      readonly error: ProjectWorkspaceError;
    };

interface ExactExternalWorkspaceContext {
  readonly identity: ProjectWorkspaceAccessIdentity;
  readonly workspace: ProjectWorkspaceLocationDescriptor;
  readonly project: ProjectWorkspaceDescriptor;
}

interface WorkspaceEnrichmentOptions {
  readonly worktreesByRootId?: ReadonlyMap<
    string,
    Extract<WorktreeResult, { readonly ok: true }>
  >;
  readonly provisionalAccess?: ProjectWorkspaceAccessIdentity;
  readonly signal?: AbortSignal;
}

type ExactExternalWorkspaceContextResult =
  | { readonly ok: true; readonly value: ExactExternalWorkspaceContext }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function sameWorkspaceAccessIdentity(
  left: ProjectWorkspaceAccessIdentity,
  right: ProjectWorkspaceAccessIdentity,
): boolean {
  return left.projectId === right.projectId
    && left.rootId === right.rootId
    && left.workspaceId === right.workspaceId
    && left.repositoryId === right.repositoryId
    && pathKey(left.canonicalPath) === pathKey(right.canonicalPath);
}

function sameWorkspaceAccessIntent(
  left: ProjectWorkspaceAccessIntent,
  right: ProjectWorkspaceAccessIntent,
): boolean {
  return left.kind === right.kind
    && left.createdAt === right.createdAt
    && sameWorkspaceAccessIdentity(left.identity, right.identity);
}

function absoluteRelativePath(rootPath: string, absolutePath: string): string | null {
  const relative = path.relative(path.resolve(rootPath), absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative ? relative.split(path.sep).join('/') : '';
}

function rootIdForPath(rootPath: string): string {
  return createHash('sha256').update(pathKey(rootPath)).digest('hex').slice(0, 24);
}

function rootWorkspace(root: ProjectRootDescriptor): ProjectWorkspaceLocationDescriptor {
  return {
    workspaceId: root.rootId,
    rootId: root.rootId,
    name: root.name,
    displayPath: root.displayPath,
    kind: 'root',
    access: 'granted',
  };
}

/** Build the stable renderer-facing descriptor for one persisted Project.
 * Keeping this translation public lets main clean up the exact previous root
 * identities after an edit without rediscovering them from the replacement. */
export function projectWorkspaceDescriptorForProject(
  project: Pick<AgentProjectRecord, 'projectId' | 'name' | 'primaryRoot' | 'additionalRoots'>,
): ProjectWorkspaceDescriptor {
  const allRoots = [project.primaryRoot, ...project.additionalRoots];
  const roots = allRoots.map((rootPath, index) => ({
    rootId: rootIdForPath(rootPath),
    name: path.basename(rootPath) || rootPath,
    displayPath: rootPath,
    primary: index === 0,
  }));
  return {
    projectId: rootIdForPath(project.primaryRoot),
    name: project.name,
    roots,
    workspaces: roots.map(rootWorkspace),
  };
}

export interface ProjectWorkspaceServiceOptions {
  readonly listWorktrees?: (cwd: string, signal?: AbortSignal) => Promise<WorktreeResult>;
  readonly accessStore?: ProjectWorkspaceAccessStore;
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_RELATIVE_PATH_LENGTH || hasProjectPathControlCharacters(value)) {
    return null;
  }
  if (value === '') return '';
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  // A colon inside a Windows path segment addresses an NTFS alternate data
  // stream. ADS names are not emitted by directory enumeration and must not be
  // an IPC-only escape hatch into content the project tree cannot represent.
  if (process.platform === 'win32' && segments.some((segment) => segment.includes(':'))) return null;
  return segments.join('/');
}

function classifyFsError(error: unknown): ProjectWorkspaceError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'not-found';
  return 'io-error';
}

function classifyWorktreeFailure(
  error: Extract<WorktreeResult, { readonly ok: false }>['error'],
): ProjectWorkspaceError {
  if (error === 'NOT_A_GIT_REPOSITORY') return 'not-a-repository';
  if (error === 'GIT_FAILED') return 'git-failed';
  return 'io-error';
}

function isRetryableWorkspaceDiscoveryError(error: ProjectWorkspaceError): boolean {
  return error === 'not-a-repository' || error === 'git-failed' || error === 'io-error';
}

function isBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function fileVersion(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameIdentity(
  first: { readonly dev: number | bigint; readonly ino: number | bigint },
  second: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  // Some Windows filesystems report ino=0. In that case realpath + the open
  // handle checks still provide the identity barrier and we avoid a false fail.
  if (Number(first.ino) === 0 || Number(second.ino) === 0) return true;
  return first.dev === second.dev && first.ino === second.ino;
}

function sameSnapshot(
  first: { readonly dev: number | bigint; readonly ino: number | bigint; readonly mtimeMs: number; readonly ctimeMs: number },
  second: { readonly dev: number | bigint; readonly ino: number | bigint; readonly mtimeMs: number; readonly ctimeMs: number },
): boolean {
  return sameIdentity(first, second)
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs;
}

export class ProjectWorkspaceService {
  constructor(
    private readonly projects: AgentProjectStore,
    private readonly options: ProjectWorkspaceServiceOptions = {},
  ) {}

  describeProject(projectId: unknown): ProjectWorkspaceDescriptorResult {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128) {
      return { ok: false, error: 'invalid-request' };
    }
    // Renderer-facing Agent Project ids are opaque, root-derived ids from
    // AgentHistoryService. Stored ids may differ for migrated projects, so the
    // project workbench must use the same public identity rather than leaking
    // or depending on the persistence-layer id.
    const project = this.projects.list().find((candidate) =>
      rootIdForPath(candidate.primaryRoot) === projectId);
    if (!project) return { ok: false, error: 'project-not-found' };
    return { ok: true, project: projectWorkspaceDescriptorForProject(project) };
  }

  /** Resolve an explicit project terminal target immediately before launch. */
  async resolveSessionTarget(target: unknown): Promise<ProjectSessionTargetResolution> {
    if (!isProjectSessionTarget(target)) return { ok: false, error: 'invalid-request' };
    const described = this.describeProject(target.projectId);
    if (!described.ok) return described;
    const rootId = target.rootId
      ?? described.project.roots.find((root) => root.primary)?.rootId
      ?? described.project.roots[0]?.rootId;
    if (!rootId) return { ok: false, error: 'root-not-found' };
    const root = await this.resolveRoot(target.projectId, rootId, target.workspaceId);
    if (!root.ok) return root;
    const configuredRoots = [root.value.project.primaryRoot, ...root.value.project.additionalRoots];
    const selectedRegisteredRoot = root.value.descriptor.displayPath;
    const roots = [
      root.value.rootPath,
      ...configuredRoots.filter((candidate) => pathKey(candidate) !== pathKey(selectedRegisteredRoot)),
    ];
    return {
      ok: true,
      target: {
        projectId: target.projectId,
        ...(target.rootId && target.workspaceId
          ? { rootId: target.rootId, workspaceId: target.workspaceId }
          : {}),
      },
      projectName: root.value.project.name,
      cwd: root.value.rootPath,
      roots,
      storedProjectId: root.value.project.projectId,
    };
  }

  /**
   * Resolve File Explorer's presentation path to one exact project workspace
   * root. Physical aliases are interpreted here in main; descendants and
   * unavailable workspaces deliberately remain ordinary cwd terminals.
   */
  async resolveTerminalDirectory(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ProjectTerminalDirectoryResult> {
    const resolved = await this.resolveTerminalDirectoryContext(value, signal);
    if (!resolved.ok) return resolved;
    return { ok: true, projectSession: resolved.projectSession };
  }

  /** Main-only launch context. The descriptor is deliberately captured from
   * the same successful resolution so daemon synchronization never performs a
   * weaker second worktree discovery.
   */
  async resolveTerminalDirectoryContext(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ProjectTerminalDirectoryContextResult> {
    signal?.throwIfAborted();
    if (typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || typeof (value as { readonly projectId?: unknown }).projectId !== 'string') {
      return { ok: false, error: 'invalid-request' };
    }
    const resolved = await this.resolveAbsoluteProjectPath(value, signal);
    if (!resolved.ok) return resolved;
    signal?.throwIfAborted();
    if (resolved.request.relativePath !== '') {
      return { ok: false, error: 'not-workspace-root' };
    }
    const described = this.describeProject(resolved.request.projectId);
    if (!described.ok) return described;
    return {
      ok: true,
      project: resolved.project,
      projectSession: {
        projectId: resolved.request.projectId,
        rootId: resolved.request.rootId,
        workspaceId: resolved.request.workspaceId,
        projectName: described.project.name,
        titleMode: 'generated',
      },
    };
  }

  /** Enrich the synchronous registered-root descriptor with local Git
   * worktrees. Failure to inspect Git never makes ordinary project files
   * disappear; the registered-root workspace remains available. */
  async describeProjectWorkspaces(
    projectId: unknown,
    signal?: AbortSignal,
  ): Promise<ProjectWorkspaceDescriptorResult> {
    signal?.throwIfAborted();
    const described = this.describeProject(projectId);
    return described.ok ? this.enrichProjectWorkspaces(described.project, { signal }) : described;
  }

  /** Describe a validated-but-not-yet-committed Project save candidate. This
   * is the preflight half of main's fail-closed cross-store transition. */
  describePreparedProjectWorkspaces(
    project: Pick<AgentProjectRecord, 'projectId' | 'name' | 'primaryRoot' | 'additionalRoots'>,
    signal?: AbortSignal,
  ): Promise<ProjectWorkspaceDescriptorResult> {
    signal?.throwIfAborted();
    return this.enrichProjectWorkspaces(projectWorkspaceDescriptorForProject(project), { signal });
  }

  private async enrichProjectWorkspaces(
    project: ProjectWorkspaceDescriptor,
    options: WorkspaceEnrichmentOptions = {},
  ): Promise<ProjectWorkspaceDescriptorResult> {
    options.signal?.throwIfAborted();
    if (!this.options.listWorktrees) {
      return {
        ok: true,
        project: {
          ...project,
          workspaceDiscovery: {
            roots: project.roots.map((root) => ({
              rootId: root.rootId,
              status: 'unavailable',
              error: 'unsupported',
            })),
          },
        },
      };
    }
    const workspaces: ProjectWorkspaceLocationDescriptor[] = [];
    const discoveryRoots: ProjectWorkspaceDiscovery['roots'][number][] = [];
    for (const root of project.roots) {
      options.signal?.throwIfAborted();
      let listed: WorktreeResult;
      const prepared = options.worktreesByRootId?.get(root.rootId);
      if (prepared) {
        listed = prepared;
      } else {
        try {
          listed = await this.options.listWorktrees(root.displayPath, options.signal);
        } catch {
          options.signal?.throwIfAborted();
          discoveryRoots.push({ rootId: root.rootId, status: 'unavailable', error: 'io-error' });
          workspaces.push(rootWorkspace(root));
          continue;
        }
      }
      options.signal?.throwIfAborted();
      if (!listed.ok) {
        const classified = classifyWorktreeFailure(listed.error);
        discoveryRoots.push({
          rootId: root.rootId,
          status: 'unavailable',
          error: classified === 'not-a-repository' || classified === 'git-failed'
            ? classified
            : 'io-error',
        });
        workspaces.push(rootWorkspace(root));
        continue;
      }
      if (listed.worktrees.length === 0) {
        discoveryRoots.push({ rootId: root.rootId, status: 'complete' });
        workspaces.push(rootWorkspace(root));
        continue;
      }
      const main = listed.worktrees.find((worktree) => worktree.main);
      if (!main) {
        discoveryRoots.push({ rootId: root.rootId, status: 'complete' });
        workspaces.push(rootWorkspace(root));
        continue;
      }
      let mainCanonical: string;
      let registeredCanonical: string;
      try {
        [mainCanonical, registeredCanonical] = await Promise.all([
          fs.realpath(main.path),
          fs.realpath(root.displayPath),
        ]);
      } catch {
        options.signal?.throwIfAborted();
        discoveryRoots.push({ rootId: root.rootId, status: 'unavailable', error: 'io-error' });
        workspaces.push(rootWorkspace(root));
        continue;
      }
      options.signal?.throwIfAborted();
      const rootWithinMain = path.relative(mainCanonical, registeredCanonical);
      if (rootWithinMain === '..'
        || rootWithinMain.startsWith(`..${path.sep}`)
        || path.isAbsolute(rootWithinMain)) {
        discoveryRoots.push({ rootId: root.rootId, status: 'complete' });
        workspaces.push(rootWorkspace(root));
        continue;
      }
      let rootDiscoveryError: 'io-error' | undefined;
      for (const worktree of listed.worktrees) {
        options.signal?.throwIfAborted();
        if (worktree.prunable) continue;
        let canonicalWorktree: string;
        let contentPath: string;
        try {
          canonicalWorktree = await fs.realpath(worktree.path);
          contentPath = await fs.realpath(path.join(canonicalWorktree, rootWithinMain));
          const relative = path.relative(canonicalWorktree, contentPath);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          if (!(await fs.stat(contentPath)).isDirectory()) continue;
        } catch (error) {
          options.signal?.throwIfAborted();
          if (classifyFsError(error) !== 'not-found') rootDiscoveryError = 'io-error';
          continue;
        }
        options.signal?.throwIfAborted();
        const identity = {
          projectId: project.projectId,
          rootId: root.rootId,
          workspaceId: worktree.worktreeId,
          repositoryId: worktree.repoId,
          canonicalPath: canonicalWorktree,
        };
        const kind = worktree.main ? 'main' : worktree.managed ? 'managed' : 'external';
        const granted = kind !== 'external'
          || this.options.accessStore?.isApproved(identity) === true
          || (options.provisionalAccess !== undefined
            && sameWorkspaceAccessIdentity(identity, options.provisionalAccess));
        workspaces.push({
          workspaceId: worktree.worktreeId,
          rootId: root.rootId,
          name: worktree.main
            ? `${root.name} (main)`
            : worktree.branch || path.basename(canonicalWorktree),
          displayPath: contentPath,
          kind,
          access: granted ? 'granted' : 'authorization-required',
          branch: worktree.branch,
          head: worktree.head,
          repositoryId: worktree.repoId,
          locked: worktree.locked,
        });
      }
      if (!workspaces.some((workspace) => workspace.rootId === root.rootId)) {
        workspaces.push(rootWorkspace(root));
      }
      discoveryRoots.push(rootDiscoveryError
        ? { rootId: root.rootId, status: 'unavailable', error: rootDiscoveryError }
        : { rootId: root.rootId, status: 'complete' });
    }
    options.signal?.throwIfAborted();
    return {
      ok: true,
      project: {
        ...project,
        workspaces,
        workspaceDiscovery: { roots: discoveryRoots },
      },
    };
  }

  /** Rediscover one external Workspace and bind its consent transaction to the
   * repository id plus canonical worktree root observed in the same listing.
   * A provisional descriptor is returned for the caller's daemon transition;
   * it does not make accessStore.isApproved true.
   */
  private async resolveExactExternalWorkspace(
    request: ProjectWorkspaceAccessRequest,
    expectedIdentity?: ProjectWorkspaceAccessIdentity,
    signal?: AbortSignal,
  ): Promise<ExactExternalWorkspaceContextResult> {
    signal?.throwIfAborted();
    const described = this.describeProject(request.projectId);
    if (!described.ok) return described;
    const root = described.project.roots.find((candidate) => candidate.rootId === request.rootId);
    if (!root || !this.options.listWorktrees) {
      return { ok: false, error: 'workspace-not-found' };
    }
    if (request.workspaceId === root.rootId) return { ok: false, error: 'invalid-request' };
    let listed: WorktreeResult;
    try {
      listed = await this.options.listWorktrees(root.displayPath, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, error: classifyFsError(error) };
    }
    signal?.throwIfAborted();
    if (!listed.ok) return { ok: false, error: classifyWorktreeFailure(listed.error) };
    const worktree = listed.worktrees.find((candidate) => candidate.worktreeId === request.workspaceId);
    if (!worktree || worktree.prunable) {
      return { ok: false, error: 'workspace-not-found' };
    }
    if (worktree.managed || worktree.main) return { ok: false, error: 'invalid-request' };
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(worktree.path);
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, error: classifyFsError(error) };
    }
    signal?.throwIfAborted();
    const identity: ProjectWorkspaceAccessIdentity = {
      projectId: request.projectId,
      rootId: request.rootId,
      workspaceId: request.workspaceId,
      repositoryId: worktree.repoId,
      canonicalPath,
    };
    if (expectedIdentity && !sameWorkspaceAccessIdentity(identity, expectedIdentity)) {
      return { ok: false, error: 'workspace-not-found' };
    }
    const enriched = await this.enrichProjectWorkspaces(described.project, {
      worktreesByRootId: new Map([[root.rootId, listed]]),
      provisionalAccess: identity,
      signal,
    });
    signal?.throwIfAborted();
    if (!enriched.ok) return enriched;
    const workspace = enriched.project.workspaces?.find((candidate) => (
      candidate.rootId === request.rootId
      && candidate.workspaceId === request.workspaceId
      && candidate.kind === 'external'
      && candidate.repositoryId === identity.repositoryId
      && candidate.access === 'granted'
    ));
    return workspace
      ? { ok: true, value: { identity, workspace, project: enriched.project } }
      : { ok: false, error: 'workspace-not-found' };
  }

  async approveWorkspace(value: unknown): Promise<ProjectWorkspaceAccessResult> {
    const approved = await this.approveWorkspaceContext(value);
    return approved.ok
      ? { ok: true, workspace: approved.workspace }
      : approved;
  }

  async approveWorkspaceContext(value: unknown): Promise<ProjectWorkspaceApprovalContextResult> {
    const begun = await this.beginWorkspaceApproval(value);
    if (!begun.ok) return begun;
    if (!await this.commitWorkspaceApproval(begun.intent)) {
      return { ok: false, error: 'io-error' };
    }
    return { ok: true, workspace: begun.workspace, project: begun.project };
  }

  async beginWorkspaceApproval(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ProjectWorkspaceApprovalIntentResult> {
    signal?.throwIfAborted();
    if (!this.isAccessRequest(value) || !this.options.accessStore) {
      return { ok: false, error: 'invalid-request' };
    }
    const resolved = await this.resolveExactExternalWorkspace(value, undefined, signal);
    if (!resolved.ok) return resolved;
    signal?.throwIfAborted();
    const intent = await this.options.accessStore.beginApproval(resolved.value.identity);
    signal?.throwIfAborted();
    return {
      ok: true,
      intent,
      workspace: resolved.value.workspace,
      project: resolved.value.project,
    };
  }

  commitWorkspaceApproval(intent: ProjectWorkspaceAccessIntent): Promise<boolean> {
    return this.options.accessStore?.commitApproval(intent) ?? Promise.resolve(false);
  }

  /** Clear a revalidation-failed approval only when its persisted transaction
   * token still matches. Revoke recovery must remain pending and fail closed.
   */
  discardWorkspaceAccessIntent(intent: ProjectWorkspaceAccessIntent): Promise<boolean> {
    return this.options.accessStore?.discardApproval(intent) ?? Promise.resolve(false);
  }

  async revokeWorkspace(value: unknown): Promise<boolean> {
    const begun = await this.beginWorkspaceRevocation(value);
    if (!begun.ok) return false;
    return this.commitWorkspaceRevocation(begun.intent);
  }

  async beginWorkspaceRevocation(value: unknown): Promise<ProjectWorkspaceRevocationIntentResult> {
    if (!this.isAccessRequest(value) || !this.options.accessStore) return { ok: false };
    const intent = await this.options.accessStore.beginRevocation(value);
    if (!intent) return { ok: false };
    return {
      ok: true,
      intent,
      request: {
        projectId: value.projectId,
        rootId: value.rootId,
        workspaceId: value.workspaceId,
      },
    };
  }

  /** Validate that a revoke request names a previously persisted external
   * Workspace grant before main archives its matching daemon capability.
   */
  prepareWorkspaceRevocation(value: unknown): ProjectWorkspaceRevocationPreparation {
    if (!this.isAccessRequest(value)
      || !this.options.accessStore?.hasApproval(value)) {
      return { ok: false };
    }
    return {
      ok: true,
      request: {
        projectId: value.projectId,
        rootId: value.rootId,
        workspaceId: value.workspaceId,
      },
    };
  }

  /** Complete a journaled revoke after daemon archival. The request overload
   * preserves the pre-journal main wiring until startup recovery is connected.
   */
  async commitWorkspaceRevocation(
    request: ProjectWorkspaceAccessRequest | ProjectWorkspaceAccessIntent,
  ): Promise<boolean> {
    if (!this.options.accessStore) throw new Error('Project Workspace access store is unavailable.');
    if ('kind' in request) return this.options.accessStore.commitRevocation(request);
    await this.options.accessStore.revoke(request.projectId, request.rootId, request.workspaceId);
    return true;
  }

  listPendingWorkspaceAccess(): readonly ProjectWorkspaceAccessIntent[] {
    return this.options.accessStore?.listPendingIntents() ?? [];
  }

  async recoverWorkspaceAccessIntent(
    candidate: ProjectWorkspaceAccessIntent,
    signal?: AbortSignal,
  ): Promise<ProjectWorkspaceAccessRecoveryResult> {
    signal?.throwIfAborted();
    const intent = this.options.accessStore?.listPendingIntents().find((pending) => (
      sameWorkspaceAccessIntent(pending, candidate)
    ));
    if (!intent) return { ok: false, intent: candidate, error: 'invalid-request' };
    if (intent.kind === 'revoke') {
      return {
        ok: true,
        intent,
        request: {
          projectId: intent.identity.projectId,
          rootId: intent.identity.rootId,
          workspaceId: intent.identity.workspaceId,
        },
      };
    }
    const resolved = await this.resolveExactExternalWorkspace({
      projectId: intent.identity.projectId,
      rootId: intent.identity.rootId,
      workspaceId: intent.identity.workspaceId,
    }, intent.identity, signal);
    signal?.throwIfAborted();
    if (!resolved.ok && isRetryableWorkspaceDiscoveryError(resolved.error)) {
      throw new ProjectWorkspaceResolutionError(resolved.error);
    }
    return resolved.ok
      ? {
          ok: true,
          intent,
          workspace: resolved.value.workspace,
          project: resolved.value.project,
        }
      : { ok: false, intent, error: resolved.error };
  }

  async recoverPendingWorkspaceAccess(
    signal?: AbortSignal,
  ): Promise<readonly ProjectWorkspaceAccessRecoveryResult[]> {
    signal?.throwIfAborted();
    const recovered: ProjectWorkspaceAccessRecoveryResult[] = [];
    for (const intent of this.listPendingWorkspaceAccess()) {
      const result = await this.recoverWorkspaceAccessIntent(intent, signal);
      signal?.throwIfAborted();
      recovered.push(result);
    }
    signal?.throwIfAborted();
    return recovered;
  }

  revokeProjectAccess(projectId: string): Promise<void> {
    return this.options.accessStore?.revoke(projectId) ?? Promise.resolve();
  }

  revokeProjectRootAccess(projectId: string, rootId: string): Promise<void> {
    return this.options.accessStore?.revoke(projectId, rootId) ?? Promise.resolve();
  }

  /**
   * Resolve a PTY/provider absolute path back into the same opaque project
   * document identity used by tree navigation. Only registered, currently
   * granted workspaces participate; an external worktree is never approved as
   * a side effect of following a link.
   */
  async resolveAbsoluteProjectPath(value: unknown, signal?: AbortSignal): Promise<
    | {
        readonly ok: true;
        readonly request: ProjectPathRequest & { readonly workspaceId: string };
        readonly project: ProjectWorkspaceDescriptor;
      }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    signal?.throwIfAborted();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'invalid-request' };
    }
    const candidate = value as { readonly projectId?: unknown; readonly absolutePath?: unknown };
    if ((candidate.projectId !== undefined
      && (typeof candidate.projectId !== 'string'
        || candidate.projectId.length < 1
        || candidate.projectId.length > 128))
      || typeof candidate.absolutePath !== 'string'
      || candidate.absolutePath.length < 1
      || candidate.absolutePath.length > 32_768
      || hasProjectPathControlCharacters(candidate.absolutePath)
      || !path.isAbsolute(candidate.absolutePath)) {
      return { ok: false, error: 'invalid-request' };
    }
    const absolutePath = path.resolve(candidate.absolutePath);
    const projectIds = typeof candidate.projectId === 'string'
      ? [candidate.projectId]
      : this.projects.list().map((project) => rootIdForPath(project.primaryRoot));
    for (const projectId of projectIds) {
      signal?.throwIfAborted();
      const described = await this.describeProjectWorkspaces(projectId, signal);
      if (!described.ok) continue;
      const rootsById = new Map(described.project.roots.map((root) => [root.rootId, root]));
      const workspaces = [...(described.project.workspaces ?? described.project.roots.map(rootWorkspace))]
        .sort((left, right) => right.displayPath.length - left.displayPath.length);
      for (const workspace of workspaces) {
        signal?.throwIfAborted();
        if (!rootsById.has(workspace.rootId)) continue;
        const lexicalRelativePath = absoluteRelativePath(workspace.displayPath, absolutePath);
        if (workspace.access === 'authorization-required') {
          if (lexicalRelativePath !== null) return { ok: false, error: 'authorization-required' };
          continue;
        }
        if (workspace.access !== 'granted') {
          if (lexicalRelativePath !== null) return { ok: false, error: 'workspace-not-found' };
          continue;
        }
        const root = await this.resolveRoot(
          projectId,
          workspace.rootId,
          workspace.workspaceId,
          signal,
        );
        signal?.throwIfAborted();
        if (!root.ok) {
          if (lexicalRelativePath !== null) return root;
          continue;
        }
        const relativePath = lexicalRelativePath
          ?? await this.relativePathFromRootAlias(root.value.rootPath, absolutePath);
        signal?.throwIfAborted();
        if (relativePath === null) continue;
        const resolved = await this.resolveProjectPath({
          projectId,
          rootId: workspace.rootId,
          workspaceId: workspace.workspaceId,
          relativePath,
        }, signal);
        signal?.throwIfAborted();
        if (!resolved.ok) return resolved;
        const workspaces = [...(described.project.workspaces ?? [])];
        const selectedIndex = workspaces.findIndex((candidate) => (
          candidate.rootId === resolved.value.workspace.rootId
          && candidate.workspaceId === resolved.value.workspace.workspaceId
        ));
        const selectedWorkspace = {
          ...resolved.value.workspace,
          displayPath: resolved.value.rootPath,
        };
        if (selectedIndex >= 0) {
          workspaces[selectedIndex] = selectedWorkspace;
        } else {
          workspaces.push(selectedWorkspace);
        }
        return {
          ok: true,
          project: { ...described.project, workspaces },
          request: {
            projectId,
            rootId: workspace.rootId,
            workspaceId: resolved.value.workspace.workspaceId,
            relativePath: resolved.value.relativePath,
          },
        };
      }
    }
    return { ok: false, error: 'path-outside-root' };
  }

  private async relativePathFromRootAlias(rootPath: string, absolutePath: string): Promise<string | null> {
    let current = absolutePath;
    for (;;) {
      try {
        const before = await fs.lstat(current);
        if (!before.isSymbolicLink() && before.isDirectory()) {
          const actual = await fs.realpath(current);
          const after = await fs.lstat(current);
          if (!after.isSymbolicLink()
            && after.isDirectory()
            && sameIdentity(before, after)
            && pathKey(actual) === pathKey(rootPath)) {
            return absoluteRelativePath(current, absolutePath);
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  async listDirectory(request: unknown): Promise<ProjectDirectoryResult> {
    const resolved = await this.resolvePathRequest(request);
    if (!resolved.ok) return resolved;
    try {
      const directoryStat = await fs.lstat(resolved.value.absolutePath);
      if (directoryStat.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!directoryStat.isDirectory()) return { ok: false, error: 'not-a-directory' };
      await this.assertRealpathInsideRoot(resolved.value);
      const dirents = await fs.readdir(resolved.value.absolutePath, { withFileTypes: true });
      const directoryAfter = await fs.lstat(resolved.value.absolutePath);
      await this.assertRealpathInsideRoot(resolved.value);
      if (directoryAfter.isSymbolicLink() || !sameSnapshot(directoryStat, directoryAfter)) {
        return { ok: false, error: 'stale' };
      }
      const entries: ProjectDirectoryEntry[] = [];
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue;
        const childRelativePath = resolved.value.relativePath
          ? `${resolved.value.relativePath}/${dirent.name}`
          : dirent.name;
        const childPath = path.join(resolved.value.absolutePath, dirent.name);
        let stat;
        try {
          stat = await fs.lstat(childPath);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
        entries.push({
          name: dirent.name,
          relativePath: childRelativePath,
          kind: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sensitive: isSensitiveProjectPath(childRelativePath),
        });
      }
      entries.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
      });
      const parent = resolved.value.relativePath.includes('/')
        ? resolved.value.relativePath.slice(0, resolved.value.relativePath.lastIndexOf('/'))
        : resolved.value.relativePath ? '' : null;
      return { ok: true, relativePath: resolved.value.relativePath, parent, entries };
    } catch (error) {
      return { ok: false, error: classifyFsError(error) };
    }
  }

  async readText(request: unknown): Promise<ProjectTextResult> {
    const resolved = await this.resolvePathRequest(request);
    if (!resolved.ok) return resolved;
    return this.readResolvedText(resolved.value);
  }

  async search(request: unknown, signal?: AbortSignal): Promise<ProjectSearchResult> {
    if (!this.isSearchRequest(request)) return { ok: false, error: 'invalid-request' };
    const described = request.workspaceId
      ? await this.describeProjectWorkspaces(request.projectId, signal)
      : this.describeProject(request.projectId);
    if (!described.ok) return described;
    const selectedRoots = request.rootId
      ? described.project.roots.filter((root) => root.rootId === request.rootId)
      : described.project.roots;
    if (selectedRoots.length === 0) return { ok: false, error: 'root-not-found' };

    const deadline = Date.now() + PROJECT_SEARCH_TIMEOUT_MS;
    const query = request.caseSensitive ? request.query : request.query.toLocaleLowerCase('en-US');
    const matches: ProjectSearchMatch[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let discoveredEntries = 0;
    let truncated = false;

    for (const root of selectedRoots) {
      const rootResolution = await this.resolveRoot(
        request.projectId,
        root.rootId,
        request.workspaceId,
        signal,
      );
      if (!rootResolution.ok) return rootResolution;
      const pendingDirectories: Array<{ absolutePath: string; relativePath: string }> = [{
        absolutePath: rootResolution.value.rootPath,
        relativePath: '',
      }];
      const pendingFiles: Array<{ absolutePath: string; relativePath: string; size: number }> = [];

      while (pendingDirectories.length > 0) {
        if (signal?.aborted || Date.now() > deadline) {
          truncated = true;
          break;
        }
        const current = pendingDirectories.shift()!;
        let dirents;
        try {
          const resolvedDirectory: ResolvedPath = {
            ...rootResolution.value,
            absolutePath: current.absolutePath,
            relativePath: current.relativePath,
          };
          await this.assertNoSymlinkComponents(resolvedDirectory);
          await this.assertRealpathInsideRoot(resolvedDirectory);
          const directoryBefore = await fs.lstat(current.absolutePath);
          if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) continue;
          dirents = await fs.readdir(current.absolutePath, { withFileTypes: true });
          const directoryAfter = await fs.lstat(current.absolutePath);
          await this.assertRealpathInsideRoot(resolvedDirectory);
          if (directoryAfter.isSymbolicLink() || !sameSnapshot(directoryBefore, directoryAfter)) continue;
        } catch {
          continue;
        }
        for (const dirent of dirents) {
          discoveredEntries += 1;
          if (
            discoveredEntries > PROJECT_SEARCH_MAX_FILES * 2
            || signal?.aborted
            || Date.now() > deadline
          ) {
            truncated = true;
            break;
          }
          if (dirent.isSymbolicLink() || dirent.name === '.git') continue;
          const relativePath = current.relativePath
            ? `${current.relativePath}/${dirent.name}`
            : dirent.name;
          const absolutePath = path.join(current.absolutePath, dirent.name);
          if (dirent.isDirectory()) {
            pendingDirectories.push({ absolutePath, relativePath });
            continue;
          }
          if (!dirent.isFile()) continue;
          scannedFiles += 1;
          if (scannedFiles > PROJECT_SEARCH_MAX_FILES) {
            truncated = true;
            break;
          }
          if (request.mode === 'files') {
            const haystack = request.caseSensitive
              ? relativePath
              : relativePath.toLocaleLowerCase('en-US');
            if (haystack.includes(query)) {
              matches.push({
                rootId: root.rootId,
                relativePath,
                sensitive: isSensitiveProjectPath(relativePath),
              });
            }
          } else {
            let stat;
            try {
              stat = await fs.lstat(absolutePath);
            } catch {
              continue;
            }
            if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= PROJECT_TEXT_MAX_BYTES) {
              pendingFiles.push({ absolutePath, relativePath, size: stat.size });
            }
          }
          if (matches.length >= PROJECT_SEARCH_MAX_RESULTS) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }

      if (request.mode === 'content' && !truncated) {
        for (let index = 0; index < pendingFiles.length; index += SEARCH_READ_CONCURRENCY) {
          if (signal?.aborted || Date.now() > deadline) {
            truncated = true;
            break;
          }
          const batch = pendingFiles.slice(index, index + SEARCH_READ_CONCURRENCY);
          const batchMatches = await Promise.all(batch.map(async (file): Promise<ProjectSearchMatch[]> => {
            if (scannedBytes + file.size > PROJECT_SEARCH_MAX_BYTES) {
              truncated = true;
              return [];
            }
            scannedBytes += file.size;
            const read = await this.readText({
              projectId: request.projectId,
              rootId: root.rootId,
              ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
              relativePath: file.relativePath,
            });
            if (!read.ok) return [];
            scannedBytes += read.file.byteLength - file.size;
            if (scannedBytes > PROJECT_SEARCH_MAX_BYTES) {
              truncated = true;
              return [];
            }
            const content = read.file.content;
            const sensitive = read.file.sensitive;
            const found: ProjectSearchMatch[] = [];
            for (const [lineIndex, line] of content.split(/\r\n|\r|\n/).entries()) {
              const haystack = request.caseSensitive ? line : line.toLocaleLowerCase('en-US');
              const column = haystack.indexOf(query);
              if (column < 0) continue;
              found.push({
                rootId: root.rootId,
                relativePath: file.relativePath,
                line: lineIndex + 1,
                column: column + 1,
                preview: sensitive ? '[sensitive content hidden]' : line.trim().slice(0, 240),
                sensitive,
              });
              if (found.length >= PROJECT_SEARCH_MAX_RESULTS) break;
            }
            return found;
          }));
          for (const found of batchMatches) {
            matches.push(...found.slice(0, PROJECT_SEARCH_MAX_RESULTS - matches.length));
            if (matches.length >= PROJECT_SEARCH_MAX_RESULTS) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
      }
      if (truncated) break;
    }

    return { ok: true, matches, truncated, scannedFiles, scannedBytes };
  }

  async resolveProjectPath(request: ProjectPathRequest, signal?: AbortSignal): Promise<
    | { readonly ok: true; readonly value: ResolvedPath }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    return this.resolvePathRequest(request, signal);
  }

  private async readResolvedText(resolved: ResolvedPath): Promise<ProjectTextResult> {
    let handle: fs.FileHandle | undefined;
    try {
      await this.assertNoSymlinkComponents(resolved);
      const before = await fs.lstat(resolved.absolutePath);
      if (before.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!before.isFile()) return { ok: false, error: 'not-a-file' };
      if (before.size > PROJECT_TEXT_MAX_BYTES) return { ok: false, error: 'too-large' };
      await this.assertRealpathInsideRoot(resolved);
      handle = await fs.open(resolved.absolutePath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || !sameSnapshot(before, opened)) return { ok: false, error: 'stale' };
      const bytes = Buffer.alloc(Math.min(PROJECT_TEXT_MAX_BYTES + 1, opened.size + 1));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > PROJECT_TEXT_MAX_BYTES) return { ok: false, error: 'too-large' };
      const after = await fs.lstat(resolved.absolutePath);
      if (after.isSymbolicLink() || !sameSnapshot(opened, after)) return { ok: false, error: 'stale' };
      const contentBytes = bytes.subarray(0, bytesRead);
      if (isBinary(contentBytes)) return { ok: false, error: 'binary' };
      const content = contentBytes.toString('utf8');
      return {
        ok: true,
        file: {
          relativePath: resolved.relativePath,
          content,
          version: fileVersion(contentBytes),
          byteLength: bytesRead,
          language: languageForProjectPath(resolved.relativePath),
          sensitive: isSensitiveProjectPath(resolved.relativePath)
            || hasSensitiveProjectContent(content),
        },
      };
    } catch (error) {
      const classified = error instanceof ProjectWorkspaceResolutionError
        ? error.code
        : classifyFsError(error);
      return { ok: false, error: classified };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async resolvePathRequest(request: unknown, signal?: AbortSignal): Promise<
    | { readonly ok: true; readonly value: ResolvedPath }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    signal?.throwIfAborted();
    if (!this.isPathRequest(request)) return { ok: false, error: 'invalid-request' };
    const relativePath = safeRelativePath(request.relativePath);
    if (relativePath === null) return { ok: false, error: 'path-outside-root' };
    const root = await this.resolveRoot(
      request.projectId,
      request.rootId,
      request.workspaceId,
      signal,
    );
    signal?.throwIfAborted();
    if (!root.ok) return root;
    const absolutePath = relativePath
      ? path.join(root.value.rootPath, ...relativePath.split('/'))
      : root.value.rootPath;
    const relativeCheck = path.relative(root.value.rootPath, absolutePath);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      return { ok: false, error: 'path-outside-root' };
    }
    return { ok: true, value: { ...root.value, relativePath, absolutePath } };
  }

  private async resolveRoot(
    projectId: string,
    rootId: string,
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: ResolvedProjectRoot }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    signal?.throwIfAborted();
    const project = this.projects.list().find((candidate) =>
      rootIdForPath(candidate.primaryRoot) === projectId);
    if (!project) return { ok: false, error: 'project-not-found' };
    const rootPaths = [project.primaryRoot, ...project.additionalRoots];
    const index = rootPaths.findIndex((candidate) => rootIdForPath(candidate) === rootId);
    if (index < 0) return { ok: false, error: 'root-not-found' };
    const registeredRootPath = rootPaths[index]!;
    let workspace = rootWorkspace({
      rootId,
      name: path.basename(registeredRootPath) || registeredRootPath,
      displayPath: registeredRootPath,
      primary: index === 0,
    });
    if (workspaceId && workspaceId !== rootId) {
      const described = await this.describeProjectWorkspaces(projectId, signal);
      signal?.throwIfAborted();
      if (!described.ok) return described;
      const selected = described.project.workspaces?.find((candidate) =>
        candidate.rootId === rootId && candidate.workspaceId === workspaceId);
      if (!selected) return { ok: false, error: 'workspace-not-found' };
      if (selected.access === 'authorization-required') {
        return { ok: false, error: 'authorization-required' };
      }
      if (selected.access !== 'granted') return { ok: false, error: 'workspace-not-found' };
      workspace = selected;
    }
    const requestedRootPath = workspace.displayPath;
    let rootPath = requestedRootPath;
    try {
      const rootStat = await fs.lstat(requestedRootPath);
      if (rootStat.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!rootStat.isDirectory()) return { ok: false, error: 'not-a-directory' };
      const actualParent = await fs.realpath(path.dirname(requestedRootPath));
      const actualRoot = await fs.realpath(requestedRootPath);
      const expectedRoot = path.join(actualParent, path.basename(requestedRootPath));
      if (pathKey(actualRoot) !== pathKey(expectedRoot)) {
        return { ok: false, error: 'symlink-not-supported' };
      }
      const rootAfter = await fs.lstat(requestedRootPath);
      if (rootAfter.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!rootAfter.isDirectory()) return { ok: false, error: 'not-a-directory' };
      if (!sameIdentity(rootStat, rootAfter)) return { ok: false, error: 'stale' };
      // Ancestors may legitimately be junctions (for example GitHub Actions'
      // workspace and temporary directories). Use the canonical regular root
      // internally so only links below the registered boundary are rejected.
      rootPath = actualRoot;
    } catch (error) {
      return { ok: false, error: classifyFsError(error) };
    }
    return {
      ok: true,
      value: {
        project,
        descriptor: {
          rootId,
          name: path.basename(registeredRootPath) || registeredRootPath,
          displayPath: registeredRootPath,
          primary: index === 0,
        },
        rootPath,
        workspace,
      },
    };
  }

  private async assertNoSymlinkComponents(resolved: ResolvedPath): Promise<void> {
    let current = resolved.rootPath;
    for (const segment of resolved.relativePath ? resolved.relativePath.split('/') : []) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new ProjectWorkspaceResolutionError('symlink-not-supported');
    }
  }

  private async assertRealpathInsideRoot(resolved: ResolvedPath): Promise<void> {
    const actual = await fs.realpath(resolved.absolutePath);
    const relative = path.relative(resolved.rootPath, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ProjectWorkspaceResolutionError('path-outside-root');
    }
    if (pathKey(actual) !== pathKey(resolved.absolutePath)) {
      throw new ProjectWorkspaceResolutionError('symlink-not-supported');
    }
  }

  private isPathRequest(value: unknown): value is ProjectPathRequest {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const request = value as Partial<ProjectPathRequest>;
    return typeof request.projectId === 'string'
      && request.projectId.length > 0
      && request.projectId.length <= 128
      && typeof request.rootId === 'string'
      && request.rootId.length > 0
      && request.rootId.length <= 128
      && (request.workspaceId === undefined
        || (typeof request.workspaceId === 'string'
          && request.workspaceId.length > 0
          && request.workspaceId.length <= 128))
      && typeof request.relativePath === 'string';
  }

  private isSearchRequest(value: unknown): value is ProjectSearchRequest {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const request = value as Partial<ProjectSearchRequest>;
    return typeof request.requestId === 'string'
      && request.requestId.length > 0
      && request.requestId.length <= 128
      && typeof request.projectId === 'string'
      && request.projectId.length > 0
      && request.projectId.length <= 128
      && (request.rootId === undefined
        || (typeof request.rootId === 'string' && request.rootId.length > 0 && request.rootId.length <= 128))
      && (request.workspaceId === undefined
        || (typeof request.workspaceId === 'string'
          && request.workspaceId.length > 0
          && request.workspaceId.length <= 128))
      && typeof request.query === 'string'
      && request.query.trim().length > 0
      && request.query.length <= PROJECT_SEARCH_MAX_QUERY
      && (request.mode === 'files' || request.mode === 'content')
      && (request.caseSensitive === undefined || typeof request.caseSensitive === 'boolean');
  }

  private isAccessRequest(value: unknown): value is ProjectWorkspaceAccessRequest {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const request = value as Partial<ProjectWorkspaceAccessRequest>;
    return typeof request.projectId === 'string'
      && request.projectId.length > 0
      && request.projectId.length <= 128
      && typeof request.rootId === 'string'
      && request.rootId.length > 0
      && request.rootId.length <= 128
      && typeof request.workspaceId === 'string'
      && request.workspaceId.length > 0
      && request.workspaceId.length <= 128;
  }
}

class ProjectWorkspaceResolutionError extends Error {
  constructor(readonly code: ProjectWorkspaceError) {
    super(code);
  }
}
