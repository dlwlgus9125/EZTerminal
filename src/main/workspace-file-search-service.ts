import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  WORKSPACE_FILE_INDEX_CACHE_TTL_MS,
  WORKSPACE_FILE_INDEX_MAX_FILES,
  WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS,
  WORKSPACE_FILE_SEARCH_MAX_RESULTS,
  type WorkspaceFileIndexSource,
  type WorkspaceFileMatch,
  type WorkspaceFileSearchRequest,
  type WorkspaceFileSearchResult,
} from '../shared/workspace-search';

export {
  WORKSPACE_FILE_SEARCH_DEBOUNCE_MS,
  WORKSPACE_FILE_INDEX_CACHE_TTL_MS,
  WORKSPACE_FILE_INDEX_MAX_FILES,
  WORKSPACE_FILE_SEARCH_MAX_RESULTS,
  WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS,
} from '../shared/workspace-search';
export type {
  WorkspaceFileIndexSource,
  WorkspaceFileMatch,
  WorkspaceFileSearchRequest,
  WorkspaceFileSearchSuccess,
  WorkspaceFileSearchErrorCode,
  WorkspaceFileSearchFailure,
  WorkspaceFileSearchResult,
} from '../shared/workspace-search';

const MAX_GIT_PATH_BYTES = 256 * 1024;
const MAX_GIT_STDERR_BYTES = 8 * 1024;
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.cache']);


export interface WorkspaceIndexProviderResult {
  readonly relativePaths: readonly string[];
  readonly truncated: boolean;
}

export type WorkspaceIndexProvider = (
  root: string,
  limit: number,
  signal: AbortSignal,
) => Promise<WorkspaceIndexProviderResult>;

export interface WorkspaceFileSearchServiceOptions {
  readonly now?: () => number;
  readonly gitIndexProvider?: WorkspaceIndexProvider;
  readonly walkIndexProvider?: WorkspaceIndexProvider;
}

interface IndexEntry {
  readonly relativePaths: readonly string[];
  readonly source: WorkspaceFileIndexSource;
  readonly truncated: boolean;
  readonly expiresAt: number;
  readonly revision: string;
}

interface IndexBuild {
  readonly revision: string;
  readonly controller: AbortController;
  readonly promise: Promise<IndexEntry>;
}

class InvalidWorkspaceRootError extends Error {
  constructor() {
    super('workspace root is not an accessible directory');
    this.name = 'InvalidWorkspaceRootError';
  }
}

function abortError(): Error {
  const error = new Error('operation cancelled');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function cacheKey(root: string): string {
  return process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root;
}

function normalizeRelativePath(relativePath: string): string | null {
  if (relativePath === '' || relativePath.includes('\0') || path.isAbsolute(relativePath)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) return null;
  const normalized = process.platform === 'win32' ? relativePath.replace(/\\/g, '/') : relativePath;
  if (normalized.split('/').includes('..')) return null;
  const withoutDotPrefix = normalized.replace(/^\.\//, '');
  return withoutDotPrefix === '' ? null : withoutDotPrefix;
}

function normalizeProviderResult(result: WorkspaceIndexProviderResult): WorkspaceIndexProviderResult {
  const seen = new Set<string>();
  const relativePaths: string[] = [];
  let truncated = result.truncated;
  for (const rawPath of result.relativePaths) {
    const normalized = normalizeRelativePath(rawPath);
    if (normalized === null || seen.has(normalized)) continue;
    if (relativePaths.length >= WORKSPACE_FILE_INDEX_MAX_FILES) {
      truncated = true;
      break;
    }
    seen.add(normalized);
    relativePaths.push(normalized);
  }
  relativePaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { relativePaths, truncated };
}

/** Default Git provider: exact NUL-delimited command from the Quick Open contract. */
export function gitWorkspaceIndex(
  root: string,
  limit: number,
  signal: AbortSignal,
): Promise<WorkspaceIndexProviderResult> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
        {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      reject(error);
      return;
    }

    const relativePaths: string[] = [];
    let pending = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ relativePaths, truncated });
    };
    const onAbort = (): void => {
      child.kill();
      fail(abortError());
    };

    const acceptPath = (bytes: Buffer): void => {
      if (bytes.length === 0) return;
      if (relativePaths.length >= limit) {
        truncated = true;
        child.kill();
        return;
      }
      relativePaths.push(bytes.toString('utf8'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || truncated) return;
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const separator = pending.indexOf(0);
        if (separator < 0) break;
        acceptPath(pending.subarray(0, separator));
        pending = pending.subarray(separator + 1);
        if (truncated) break;
      }
      if (!truncated && pending.length > MAX_GIT_PATH_BYTES) {
        child.kill();
        fail(new Error('git returned an overlong path'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_GIT_STDERR_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_GIT_STDERR_BYTES);
      }
    });
    child.once('error', fail);
    child.once('close', (code) => {
      if (settled) return;
      if (truncated) {
        succeed();
        return;
      }
      if (code !== 0) {
        const detail = stderr.toString('utf8').trim();
        fail(new Error(detail ? `git ls-files failed: ${detail}` : 'git ls-files failed'));
        return;
      }
      if (pending.length > 0) acceptPath(pending);
      succeed();
    });

    if (signal.aborted) onAbort();
  });
}

/** Async fallback walker. Directory symlinks (and other symlinks) are never followed. */
export async function walkWorkspaceIndex(
  root: string,
  limit: number,
  signal: AbortSignal,
): Promise<WorkspaceIndexProviderResult> {
  const relativePaths: string[] = [];
  const directories = [''];

  while (directories.length > 0) {
    throwIfAborted(signal);
    const relativeDir = directories.pop() ?? '';
    const absoluteDir = relativeDir === '' ? root : path.join(root, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const childDirectories: string[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      const relativePath = relativeDir === '' ? entry.name : path.join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase('en-US'))) {
          childDirectories.push(relativePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (relativePaths.length >= limit) {
        return { relativePaths, truncated: true };
      }
      relativePaths.push(relativePath);
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      directories.push(childDirectories[index]);
    }
  }

  return { relativePaths, truncated: false };
}

function basename(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? relativePath : relativePath.slice(slash + 1);
}

function subsequenceScore(text: string, query: string): number | null {
  let cursor = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (const character of query) {
    const found = text.indexOf(character, cursor);
    if (found < 0) return null;
    if (first < 0) first = found;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    cursor = found + 1;
  }
  return first + gaps * 2;
}

function pathScore(relativePath: string, query: string): number | null {
  const normalizedPath = relativePath.toLocaleLowerCase('en-US');
  const name = basename(relativePath).toLocaleLowerCase('en-US');
  if (name === query) return 0;
  if (name.startsWith(query)) return 10 + name.length - query.length;
  if (normalizedPath.startsWith(query)) return 30 + normalizedPath.length - query.length;
  const nameContains = name.indexOf(query);
  if (nameContains >= 0) return 50 + nameContains * 2 + name.length - query.length;
  const pathContains = normalizedPath.indexOf(query);
  if (pathContains >= 0) return 80 + pathContains + normalizedPath.length - query.length;
  const fuzzy = subsequenceScore(normalizedPath, query);
  return fuzzy === null ? null : 120 + fuzzy + normalizedPath.length;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Bounded, cached workspace filename search for desktop Quick Open.
 *
 * The caller owns the 120ms UI debounce. Each call is independently
 * cancellable by requestId, and invalidate(root) aborts/discards an in-flight
 * index so a file mutation can never publish the stale generation afterward.
 */
export class WorkspaceFileSearchService {
  private readonly now: () => number;
  private readonly gitIndexProvider: WorkspaceIndexProvider;
  private readonly walkIndexProvider: WorkspaceIndexProvider;
  private readonly cache = new Map<string, IndexEntry>();
  private readonly builds = new Map<string, IndexBuild>();
  private readonly requests = new Map<string, AbortController>();
  private readonly rootGenerations = new Map<string, number>();
  private globalGeneration = 0;
  private disposed = false;

  constructor(options: WorkspaceFileSearchServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.gitIndexProvider = options.gitIndexProvider ?? gitWorkspaceIndex;
    this.walkIndexProvider = options.walkIndexProvider ?? walkWorkspaceIndex;
  }

  async search(request: WorkspaceFileSearchRequest): Promise<WorkspaceFileSearchResult> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (this.disposed) return { ok: false, requestId, error: 'disposed', message: 'search service is disposed' };
    if (
      requestId.length < 1
      || requestId.length > 128
      || typeof request?.root !== 'string'
      || request.root.trim().length === 0
    ) {
      return { ok: false, requestId, error: 'invalid-request', message: 'invalid search request' };
    }
    if (typeof request?.query !== 'string' || request.query.length > WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS) {
      return {
        ok: false,
        requestId,
        error: 'invalid-query',
        message: `query must be at most ${WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS} characters`,
      };
    }

    const root = path.resolve(request.root);
    const query = request.query.trim().toLocaleLowerCase('en-US');
    const controller = new AbortController();
    this.requests.get(requestId)?.abort();
    this.requests.set(requestId, controller);
    const externalAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', externalAbort, { once: true });
    if (request.signal?.aborted) controller.abort();

    try {
      if (query.length === 0) {
        return {
          ok: true,
          requestId,
          root,
          query: request.query,
          matches: [],
          source: null,
          indexedFiles: 0,
          indexTruncated: false,
          cacheHit: false,
          indexRevision: this.revision(cacheKey(root)),
        };
      }

      for (;;) {
        throwIfAborted(controller.signal);
        const { entry, cacheHit } = await this.getIndex(root, controller.signal);
        const scored: Array<WorkspaceFileMatch & { score: number }> = [];
        for (let index = 0; index < entry.relativePaths.length; index += 1) {
          if (index % 256 === 0) throwIfAborted(controller.signal);
          const relativePath = entry.relativePaths[index];
          const score = pathScore(relativePath, query);
          if (score !== null) scored.push({ relativePath, basename: basename(relativePath), score });
        }
        scored.sort((a, b) =>
          a.score - b.score
          || a.relativePath.length - b.relativePath.length
          || a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' }),
        );

        const key = cacheKey(root);
        if (entry.revision !== this.revision(key)) continue;
        return {
          ok: true,
          requestId,
          root,
          query: request.query,
          matches: scored.slice(0, WORKSPACE_FILE_SEARCH_MAX_RESULTS).map((match) => ({
            relativePath: match.relativePath,
            basename: match.basename,
          })),
          source: entry.source,
          indexedFiles: entry.relativePaths.length,
          indexTruncated: entry.truncated,
          cacheHit,
          indexRevision: entry.revision,
        };
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return { ok: false, requestId, error: 'cancelled', message: 'search cancelled' };
      }
      if (error instanceof InvalidWorkspaceRootError) {
        return { ok: false, requestId, error: 'invalid-root', message: error.message };
      }
      return { ok: false, requestId, error: 'index-failed', message: 'workspace file index failed' };
    } finally {
      request.signal?.removeEventListener('abort', externalAbort);
      if (this.requests.get(requestId) === controller) this.requests.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    this.requests.get(requestId)?.abort();
  }

  /** Invalidate one active cwd after a mutation, or every cached root when omitted. */
  invalidate(root?: string): void {
    if (root === undefined) {
      this.globalGeneration += 1;
      this.cache.clear();
      for (const build of this.builds.values()) build.controller.abort();
      this.builds.clear();
      return;
    }
    const key = cacheKey(path.resolve(root));
    this.rootGenerations.set(key, (this.rootGenerations.get(key) ?? 0) + 1);
    this.cache.delete(key);
    this.builds.get(key)?.controller.abort();
    this.builds.delete(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.requests.values()) controller.abort();
    for (const build of this.builds.values()) build.controller.abort();
    this.requests.clear();
    this.builds.clear();
    this.cache.clear();
  }

  private revision(key: string): string {
    return `${this.globalGeneration}:${this.rootGenerations.get(key) ?? 0}`;
  }

  private async getIndex(root: string, requestSignal: AbortSignal): Promise<{ entry: IndexEntry; cacheHit: boolean }> {
    const key = cacheKey(root);
    for (;;) {
      throwIfAborted(requestSignal);
      const revision = this.revision(key);
      const cached = this.cache.get(key);
      if (cached && cached.revision === revision && cached.expiresAt > this.now()) {
        return { entry: cached, cacheHit: true };
      }

      let build = this.builds.get(key);
      if (!build || build.revision !== revision) {
        build?.controller.abort();
        const controller = new AbortController();
        const promise = this.buildIndex(root, revision, controller.signal);
        build = { revision, controller, promise };
        this.builds.set(key, build);
        const ownedBuild = build;
        promise.then(
          () => {
            if (this.builds.get(key) === ownedBuild) this.builds.delete(key);
          },
          () => {
            if (this.builds.get(key) === ownedBuild) this.builds.delete(key);
          },
        );
      }

      try {
        const entry = await awaitWithSignal(build.promise, requestSignal);
        if (revision !== this.revision(key)) continue;
        return { entry, cacheHit: false };
      } catch (error) {
        if (requestSignal.aborted) throw error;
        if (revision !== this.revision(key)) continue;
        throw error;
      }
    }
  }

  private async buildIndex(root: string, revision: string, signal: AbortSignal): Promise<IndexEntry> {
    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      throw new InvalidWorkspaceRootError();
    }
    if (!stat.isDirectory()) throw new InvalidWorkspaceRootError();
    throwIfAborted(signal);

    let source: WorkspaceFileIndexSource = 'git';
    let providerResult: WorkspaceIndexProviderResult;
    try {
      providerResult = await this.gitIndexProvider(root, WORKSPACE_FILE_INDEX_MAX_FILES, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      source = 'walk';
      providerResult = await this.walkIndexProvider(root, WORKSPACE_FILE_INDEX_MAX_FILES, signal);
    }
    throwIfAborted(signal);
    const normalized = normalizeProviderResult(providerResult);
    const entry: IndexEntry = {
      relativePaths: normalized.relativePaths,
      source,
      truncated: normalized.truncated,
      expiresAt: this.now() + WORKSPACE_FILE_INDEX_CACHE_TTL_MS,
      revision,
    };
    if (revision === this.revision(cacheKey(root))) this.cache.set(cacheKey(root), entry);
    return entry;
  }
}
