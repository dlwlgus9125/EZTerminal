import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  WORKSPACE_FILE_INDEX_CACHE_TTL_MS,
  WORKSPACE_FILE_INDEX_MAX_FILES,
  WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS,
  WORKSPACE_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearchService,
  walkWorkspaceIndex,
  type WorkspaceIndexProvider,
  type WorkspaceIndexProviderResult,
} from './workspace-file-search-service';

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-workspace-search-'));
}

function abortingDeferredProvider(): {
  provider: WorkspaceIndexProvider;
  resolve: (result: WorkspaceIndexProviderResult) => void;
} {
  let resolvePromise: (result: WorkspaceIndexProviderResult) => void = () => undefined;
  const provider: WorkspaceIndexProvider = vi.fn((_root, _limit, signal) =>
    new Promise<WorkspaceIndexProviderResult>((resolve, reject) => {
      resolvePromise = resolve;
      signal.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    }),
  );
  return { provider, resolve: (result) => resolvePromise(result) };
}

describe('WorkspaceFileSearchService', () => {
  it('does not index until the query contains non-whitespace text', async () => {
    const provider = vi.fn<WorkspaceIndexProvider>();
    const service = new WorkspaceFileSearchService({ gitIndexProvider: provider });

    await expect(service.search({ requestId: 'empty', root: makeRoot(), query: '   ' })).resolves.toMatchObject({
      ok: true,
      matches: [],
      source: null,
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('ranks filename matches ahead of path and fuzzy matches', async () => {
    const provider = vi.fn<WorkspaceIndexProvider>().mockResolvedValue({
      relativePaths: [
        'docs/build-notes.md',
        'src/build.ts',
        'build.ts',
        'src/bundle-index-loader.ts',
        'build.ts',
        '../outside.txt',
      ],
      truncated: false,
    });
    const service = new WorkspaceFileSearchService({ gitIndexProvider: provider });

    const result = await service.search({ requestId: 'rank', root: makeRoot(), query: 'build' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('git');
    expect(result.matches.map((match) => match.relativePath)).toEqual([
      'build.ts',
      'src/build.ts',
      'docs/build-notes.md',
      'src/bundle-index-loader.ts',
    ]);
    expect(provider).toHaveBeenCalledWith(expect.any(String), WORKSPACE_FILE_INDEX_MAX_FILES, expect.any(AbortSignal));
  });

  it('falls back to the walker when git indexing fails', async () => {
    const git = vi.fn<WorkspaceIndexProvider>().mockRejectedValue(new Error('not a git repository'));
    const walk = vi.fn<WorkspaceIndexProvider>().mockResolvedValue({
      relativePaths: ['src/index.ts'],
      truncated: false,
    });
    const service = new WorkspaceFileSearchService({ gitIndexProvider: git, walkIndexProvider: walk });

    await expect(service.search({ requestId: 'fallback', root: makeRoot(), query: 'index' })).resolves.toMatchObject({
      ok: true,
      source: 'walk',
      matches: [{ relativePath: 'src/index.ts', basename: 'index.ts' }],
    });
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it('shares a ten-second root cache, expires it, and invalidates it explicitly', async () => {
    let now = 1_000;
    const provider = vi.fn<WorkspaceIndexProvider>().mockResolvedValue({
      relativePaths: ['src/index.ts'],
      truncated: false,
    });
    const root = makeRoot();
    const service = new WorkspaceFileSearchService({ gitIndexProvider: provider, now: () => now });

    const first = await service.search({ requestId: '1', root, query: 'index' });
    const second = await service.search({ requestId: '2', root, query: 'index' });
    expect(first.ok && !first.cacheHit).toBe(true);
    expect(second.ok && second.cacheHit).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);

    now += WORKSPACE_FILE_INDEX_CACHE_TTL_MS + 1;
    const expired = await service.search({ requestId: '3', root, query: 'index' });
    expect(expired.ok && !expired.cacheHit).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);

    service.invalidate(root);
    const invalidated = await service.search({ requestId: '4', root, query: 'index' });
    expect(invalidated.ok && invalidated.indexRevision).toBe('0:1');
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('cancels a request by id without publishing the late index result', async () => {
    const deferred = abortingDeferredProvider();
    const service = new WorkspaceFileSearchService({ gitIndexProvider: deferred.provider });
    const pending = service.search({ requestId: 'cancel-me', root: makeRoot(), query: 'file' });
    await vi.waitFor(() => expect(deferred.provider).toHaveBeenCalledTimes(1));

    service.cancel('cancel-me');

    await expect(pending).resolves.toEqual({
      ok: false,
      requestId: 'cancel-me',
      error: 'cancelled',
      message: 'search cancelled',
    });
    deferred.resolve({ relativePaths: ['file.txt'], truncated: false });
    service.dispose();
  });

  it('invalidating an in-flight generation retries and returns only the new index', async () => {
    const first = abortingDeferredProvider();
    const provider = vi
      .fn<WorkspaceIndexProvider>()
      .mockImplementationOnce(first.provider)
      .mockResolvedValueOnce({ relativePaths: ['new-file.txt'], truncated: false });
    const root = makeRoot();
    const service = new WorkspaceFileSearchService({ gitIndexProvider: provider });
    const pending = service.search({ requestId: 'stale', root, query: 'file' });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    service.invalidate(root);

    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      indexRevision: '0:1',
      matches: [{ relativePath: 'new-file.txt' }],
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('bounds query and result sizes and reports provider truncation', async () => {
    const provider = vi.fn<WorkspaceIndexProvider>().mockResolvedValue({
      relativePaths: Array.from({ length: 300 }, (_, index) => `file-${String(index).padStart(3, '0')}.txt`),
      truncated: true,
    });
    const service = new WorkspaceFileSearchService({ gitIndexProvider: provider });
    const root = makeRoot();

    await expect(
      service.search({ requestId: 'too-long', root, query: 'x'.repeat(WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS + 1) }),
    ).resolves.toMatchObject({ ok: false, error: 'invalid-query' });
    const result = await service.search({ requestId: 'bounded', root, query: 'file' });
    expect(result.ok && result.matches).toHaveLength(WORKSPACE_FILE_SEARCH_MAX_RESULTS);
    expect(result.ok && result.indexTruncated).toBe(true);
  });

  it('returns stable failures for invalid roots and disposal', async () => {
    const service = new WorkspaceFileSearchService({
      gitIndexProvider: vi.fn<WorkspaceIndexProvider>().mockResolvedValue({ relativePaths: [], truncated: false }),
    });
    await expect(
      service.search({ requestId: 'bad-root', root: path.join(makeRoot(), 'missing'), query: 'x' }),
    ).resolves.toMatchObject({ ok: false, error: 'invalid-root' });

    service.dispose();
    await expect(service.search({ requestId: 'disposed', root: makeRoot(), query: 'x' })).resolves.toMatchObject({
      ok: false,
      error: 'disposed',
    });
  });
});

describe('walkWorkspaceIndex', () => {
  it('walks asynchronously without entering ignored directories or symlinks', async () => {
    const root = makeRoot();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};', 'utf8');
    for (const skipped of ['.git', 'node_modules', 'dist', 'out', 'build', '.cache']) {
      await fs.mkdir(path.join(root, skipped), { recursive: true });
      await fs.writeFile(path.join(root, skipped, 'hidden.ts'), '', 'utf8');
    }
    try {
      await fs.symlink(path.join(root, 'src'), path.join(root, 'src-link'), 'junction');
    } catch {
      // Symlink creation can require Windows Developer Mode; ignored dirs still
      // exercise the traversal boundary on locked-down CI hosts.
    }

    const result = await walkWorkspaceIndex(root, WORKSPACE_FILE_INDEX_MAX_FILES, new AbortController().signal);

    expect(result).toEqual({ relativePaths: [path.join('src', 'index.ts')], truncated: false });
  });

  it('stops at the supplied index cap', async () => {
    const root = makeRoot();
    await Promise.all(Array.from({ length: 4 }, (_, index) => fs.writeFile(path.join(root, `${index}.txt`), '')));

    await expect(walkWorkspaceIndex(root, 2, new AbortController().signal)).resolves.toMatchObject({
      relativePaths: expect.any(Array),
      truncated: true,
    });
  });
});

