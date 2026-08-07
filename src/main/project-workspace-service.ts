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
  isSensitiveProjectPath,
  languageForProjectPath,
  type ProjectDirectoryEntry,
  type ProjectDirectoryResult,
  type ProjectPathRequest,
  type ProjectRootDescriptor,
  type ProjectSearchMatch,
  type ProjectSearchRequest,
  type ProjectSearchResult,
  type ProjectTextResult,
  type ProjectWorkspaceDescriptorResult,
  type ProjectWorkspaceAccessRequest,
  type ProjectWorkspaceAccessResult,
  type ProjectWorkspaceError,
  type ProjectWorkspaceLocationDescriptor,
} from '../shared/project-workspace';
import type { WorktreeResult } from '../shared/worktree';
import type { AgentProjectRecord, AgentProjectStore } from './agent-project-store';
import type { ProjectWorkspaceAccessStore } from './project-workspace-access-store';

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

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
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

export interface ProjectWorkspaceServiceOptions {
  readonly listWorktrees?: (cwd: string) => Promise<WorktreeResult>;
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
    const allRoots = [project.primaryRoot, ...project.additionalRoots];
    const roots = allRoots.map((rootPath, index) => ({
      rootId: rootIdForPath(rootPath),
      name: path.basename(rootPath) || rootPath,
      displayPath: rootPath,
      primary: index === 0,
    }));
    return {
      ok: true,
      project: {
        projectId,
        name: project.name,
        roots,
        workspaces: roots.map(rootWorkspace),
      },
    };
  }

  /** Enrich the synchronous registered-root descriptor with local Git
   * worktrees. Failure to inspect Git never makes ordinary project files
   * disappear; the registered-root workspace remains available. */
  async describeProjectWorkspaces(projectId: unknown): Promise<ProjectWorkspaceDescriptorResult> {
    const described = this.describeProject(projectId);
    if (!described.ok || !this.options.listWorktrees) return described;
    const workspaces: ProjectWorkspaceLocationDescriptor[] = [];
    for (const root of described.project.roots) {
      const listed = await this.options.listWorktrees(root.displayPath).catch(() => null);
      if (!listed?.ok || listed.worktrees.length === 0) {
        workspaces.push(rootWorkspace(root));
        continue;
      }
      const main = listed.worktrees.find((worktree) => worktree.main);
      if (!main) {
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
        workspaces.push(rootWorkspace(root));
        continue;
      }
      const rootWithinMain = path.relative(mainCanonical, registeredCanonical);
      if (rootWithinMain === '..'
        || rootWithinMain.startsWith(`..${path.sep}`)
        || path.isAbsolute(rootWithinMain)) {
        workspaces.push(rootWorkspace(root));
        continue;
      }
      for (const worktree of listed.worktrees) {
        if (worktree.prunable) continue;
        let canonicalWorktree: string;
        let contentPath: string;
        try {
          canonicalWorktree = await fs.realpath(worktree.path);
          contentPath = await fs.realpath(path.join(canonicalWorktree, rootWithinMain));
          const relative = path.relative(canonicalWorktree, contentPath);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          if (!(await fs.stat(contentPath)).isDirectory()) continue;
        } catch {
          continue;
        }
        const identity = {
          projectId: described.project.projectId,
          rootId: root.rootId,
          workspaceId: worktree.worktreeId,
          repositoryId: worktree.repoId,
          canonicalPath: canonicalWorktree,
        };
        const kind = worktree.main ? 'main' : worktree.managed ? 'managed' : 'external';
        const granted = kind !== 'external' || this.options.accessStore?.isApproved(identity) === true;
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
    }
    return { ok: true, project: { ...described.project, workspaces } };
  }

  async approveWorkspace(value: unknown): Promise<ProjectWorkspaceAccessResult> {
    if (!this.isAccessRequest(value) || !this.options.accessStore) {
      return { ok: false, error: 'invalid-request' };
    }
    const described = await this.describeProjectWorkspaces(value.projectId);
    if (!described.ok) return described;
    const workspace = described.project.workspaces?.find((candidate) =>
      candidate.rootId === value.rootId && candidate.workspaceId === value.workspaceId);
    if (!workspace) return { ok: false, error: 'workspace-not-found' };
    if (workspace.kind !== 'external') return { ok: true, workspace };
    if (!workspace.repositoryId) return { ok: false, error: 'workspace-not-found' };
    const listed = await this.options.listWorktrees?.(
      described.project.roots.find((root) => root.rootId === value.rootId)?.displayPath ?? '',
    ).catch(() => null);
    const worktree = listed?.ok
      ? listed.worktrees.find((candidate) => candidate.worktreeId === value.workspaceId)
      : undefined;
    if (!worktree || worktree.managed || worktree.main || worktree.repoId !== workspace.repositoryId) {
      return { ok: false, error: 'workspace-not-found' };
    }
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(worktree.path);
    } catch {
      return { ok: false, error: 'not-found' };
    }
    await this.options.accessStore.approve({
      projectId: value.projectId,
      rootId: value.rootId,
      workspaceId: value.workspaceId,
      repositoryId: worktree.repoId,
      canonicalPath,
    });
    const refreshed = await this.describeProjectWorkspaces(value.projectId);
    const approved = refreshed.ok
      ? refreshed.project.workspaces?.find((candidate) =>
        candidate.rootId === value.rootId && candidate.workspaceId === value.workspaceId)
      : undefined;
    return approved ? { ok: true, workspace: approved } : { ok: false, error: 'workspace-not-found' };
  }

  async revokeWorkspace(value: unknown): Promise<boolean> {
    if (!this.isAccessRequest(value) || !this.options.accessStore) return false;
    await this.options.accessStore.revoke(value.projectId, value.rootId, value.workspaceId);
    return true;
  }

  revokeProjectAccess(projectId: string): Promise<void> {
    return this.options.accessStore?.revoke(projectId) ?? Promise.resolve();
  }

  /**
   * Resolve a PTY/provider absolute path back into the same opaque project
   * document identity used by tree navigation. Only registered, currently
   * granted workspaces participate; an external worktree is never approved as
   * a side effect of following a link.
   */
  async resolveAbsoluteProjectPath(value: unknown): Promise<
    | {
        readonly ok: true;
        readonly request: ProjectPathRequest & { readonly workspaceId: string };
      }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
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
      const described = await this.describeProjectWorkspaces(projectId);
      if (!described.ok) continue;
      const rootsById = new Map(described.project.roots.map((root) => [root.rootId, root]));
      const workspaces = [...(described.project.workspaces ?? described.project.roots.map(rootWorkspace))]
        .sort((left, right) => right.displayPath.length - left.displayPath.length);
      for (const workspace of workspaces) {
        if (!rootsById.has(workspace.rootId)) continue;
        const relative = path.relative(path.resolve(workspace.displayPath), absolutePath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        if (workspace.access === 'authorization-required') {
          return { ok: false, error: 'authorization-required' };
        }
        if (workspace.access !== 'granted') return { ok: false, error: 'workspace-not-found' };
        const relativePath = relative ? relative.split(path.sep).join('/') : '';
        const resolved = await this.resolveProjectPath({
          projectId,
          rootId: workspace.rootId,
          workspaceId: workspace.workspaceId,
          relativePath,
        });
        if (!resolved.ok) return resolved;
        return {
          ok: true,
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
      ? await this.describeProjectWorkspaces(request.projectId)
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

  async resolveProjectPath(request: ProjectPathRequest): Promise<
    | { readonly ok: true; readonly value: ResolvedPath }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    return this.resolvePathRequest(request);
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

  private async resolvePathRequest(request: unknown): Promise<
    | { readonly ok: true; readonly value: ResolvedPath }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    if (!this.isPathRequest(request)) return { ok: false, error: 'invalid-request' };
    const relativePath = safeRelativePath(request.relativePath);
    if (relativePath === null) return { ok: false, error: 'path-outside-root' };
    const root = await this.resolveRoot(request.projectId, request.rootId, request.workspaceId);
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

  private async resolveRoot(projectId: string, rootId: string, workspaceId?: string): Promise<
    | { readonly ok: true; readonly value: ResolvedProjectRoot }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
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
      const described = await this.describeProjectWorkspaces(projectId);
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
    const rootPath = workspace.displayPath;
    try {
      const rootStat = await fs.lstat(rootPath);
      if (rootStat.isSymbolicLink()) return { ok: false, error: 'symlink-not-supported' };
      if (!rootStat.isDirectory()) return { ok: false, error: 'not-a-directory' };
      const actualRoot = await fs.realpath(rootPath);
      if (pathKey(actualRoot) !== pathKey(rootPath)) {
        return { ok: false, error: 'symlink-not-supported' };
      }
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
