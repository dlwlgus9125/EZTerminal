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
  type ProjectTextValidationRequest,
  type ProjectTextValidationResult,
  type ProjectWorkspaceDescriptorResult,
  type ProjectWorkspaceError,
} from '../shared/project-workspace';
import type { AgentProjectRecord, AgentProjectStore } from './agent-project-store';

const MAX_RELATIVE_PATH_LENGTH = 4096;
const SEARCH_READ_CONCURRENCY = 8;

interface ResolvedProjectRoot {
  readonly project: AgentProjectRecord;
  readonly descriptor: ProjectRootDescriptor;
  readonly rootPath: string;
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
  constructor(private readonly projects: AgentProjectStore) {}

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
    return {
      ok: true,
      project: {
        projectId,
        name: project.name,
        roots: allRoots.map((rootPath, index) => ({
          rootId: rootIdForPath(rootPath),
          name: path.basename(rootPath) || rootPath,
          displayPath: rootPath,
          primary: index === 0,
        })),
      },
    };
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

  async validateText(request: unknown): Promise<ProjectTextValidationResult> {
    if (!this.isValidationRequest(request)) return { ok: false, error: 'invalid-request' };
    const result = await this.readText(request);
    if (!result.ok) return result;
    if (result.file.version !== request.version) return { ok: false, error: 'stale' };
    const lineCount = result.file.content.length === 0
      ? 1
      : result.file.content.split(/\r\n|\r|\n/).length;
    if (
      request.startLine < 1
      || request.endLine < request.startLine
      || request.endLine > lineCount
    ) {
      return { ok: false, error: 'stale' };
    }
    return {
      ok: true,
      currentVersion: result.file.version,
      lineCount,
      sensitive: result.file.sensitive,
    };
  }

  async search(request: unknown, signal?: AbortSignal): Promise<ProjectSearchResult> {
    if (!this.isSearchRequest(request)) return { ok: false, error: 'invalid-request' };
    const described = this.describeProject(request.projectId);
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
      const rootResolution = await this.resolveRoot(request.projectId, root.rootId);
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
    const root = await this.resolveRoot(request.projectId, request.rootId);
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

  private async resolveRoot(projectId: string, rootId: string): Promise<
    | { readonly ok: true; readonly value: ResolvedProjectRoot }
    | { readonly ok: false; readonly error: ProjectWorkspaceError }
  > {
    const project = this.projects.list().find((candidate) =>
      rootIdForPath(candidate.primaryRoot) === projectId);
    if (!project) return { ok: false, error: 'project-not-found' };
    const rootPaths = [project.primaryRoot, ...project.additionalRoots];
    const index = rootPaths.findIndex((candidate) => rootIdForPath(candidate) === rootId);
    if (index < 0) return { ok: false, error: 'root-not-found' };
    const rootPath = rootPaths[index]!;
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
          name: path.basename(rootPath) || rootPath,
          displayPath: rootPath,
          primary: index === 0,
        },
        rootPath,
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
      && typeof request.relativePath === 'string';
  }

  private isValidationRequest(value: unknown): value is ProjectTextValidationRequest {
    if (!this.isPathRequest(value)) return false;
    const request = value as Partial<ProjectTextValidationRequest>;
    return typeof request.version === 'string'
      && /^[a-f0-9]{64}$/.test(request.version)
      && Number.isInteger(request.startLine)
      && Number.isInteger(request.endLine);
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
      && typeof request.query === 'string'
      && request.query.trim().length > 0
      && request.query.length <= PROJECT_SEARCH_MAX_QUERY
      && (request.mode === 'files' || request.mode === 'content')
      && (request.caseSensitive === undefined || typeof request.caseSensitive === 'boolean');
  }
}

class ProjectWorkspaceResolutionError extends Error {
  constructor(readonly code: ProjectWorkspaceError) {
    super(code);
  }
}
