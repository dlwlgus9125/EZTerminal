import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectMapDocument,
  ProjectMapManifest,
  ProjectMapRootBinding,
  ProjectMapSpec,
} from '../shared/project-map';
import type { ProjectTextResult } from '../shared/project-workspace';
import type { ProjectMapBindingStore } from './project-map-binding-store';
import type { ProjectMapCacheStore } from './project-map-cache-store';
import type { ProjectMapApprovalStore } from './project-map-approval-store';
import type { ProjectMapJobStore } from './project-map-job-store';
import {
  digestProjectMapEvidenceLines,
  digestProjectMapInputs,
  ProjectMapService,
} from './project-map-service';
import type { ProjectWorkspaceService } from './project-workspace-service';
import type { GitRunner } from './worktree-service';

const request = {
  projectId: 'project-1',
  ownerRootId: 'root-1',
  ownerWorkspaceId: 'workspace-1',
} as const;
const binding: ProjectMapRootBinding = {
  rootAlias: 'app',
  rootId: request.ownerRootId,
  workspaceId: request.ownerWorkspaceId,
};

function version(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function fixture(input = 'export const input = 1;\n', evidenceSource = 'header\nexport const authority = true;\nfooter\n') {
  const evidenceDigest = digestProjectMapEvidenceLines(evidenceSource, 2, 2)!;
  const spec: ProjectMapSpec = {
    schemaVersion: 2,
    id: 'runtime',
    type: 'architecture',
    title: 'Runtime',
    summary: 'A small verified architecture map.',
    contentLocale: 'en',
    layoutIntent: { density: 'balanced', emphasisIds: ['renderer', 'main'] },
    chapters: [{
      id: 'request-path',
      title: 'Request path',
      summary: 'Follow the request.',
      focusIds: ['renderer', 'main'],
    }],
    groups: [{ id: 'desktop', label: 'Desktop' }],
    nodes: [
      {
        id: 'renderer',
        label: 'Renderer',
        kind: 'surface',
        group: 'desktop',
        rank: 0,
        order: 0,
        evidence: [{
          rootAlias: 'app',
          relativePath: 'src/evidence.ts',
          startLine: 2,
          endLine: 2,
          lineDigest: evidenceDigest,
          claim: 'The source declares the authority.',
        }],
      },
      {
        id: 'main',
        label: 'Main',
        kind: 'service',
        group: 'desktop',
        rank: 1,
        order: 0,
        evidence: [{
          rootAlias: 'app',
          relativePath: 'src/evidence.ts',
          startLine: 2,
          endLine: 2,
          lineDigest: evidenceDigest,
          claim: 'The source declares the authority.',
        }],
      },
    ],
    relations: [{
      id: 'renderer-to-main',
      from: 'renderer',
      to: 'main',
      label: 'typed call',
      kind: 'primary',
      evidence: [{
        rootAlias: 'app',
        relativePath: 'src/evidence.ts',
        startLine: 2,
        endLine: 2,
        lineDigest: evidenceDigest,
        claim: 'The source declares the authority.',
      }],
    }],
    mainPath: ['renderer', 'main'],
  };
  const inputHash = digestProjectMapInputs([{
    rootAlias: 'app',
    relativePath: 'src/input.ts',
    version: version(input),
  }]);
  const manifest: ProjectMapManifest = {
    schemaVersion: 2,
    collectionId: 'test-collection',
    ownerRootAlias: 'app',
    overviewMapId: 'runtime',
    roots: [{ alias: 'app', label: 'Application' }],
    maps: [{
      id: 'runtime',
      type: 'architecture',
      path: 'maps/runtime.architecture.json',
      authoritativeInputs: [{ rootAlias: 'app', relativePath: 'src/input.ts' }],
      review: { inputDigest: inputHash, decision: 'map-updated' },
    }],
  };
  return { input, evidenceSource, spec, manifest };
}

class FakeWorkspace {
  readonly files = new Map<string, string>();

  constructor(readonly rootPath: string) {}

  async readText(value: unknown): Promise<ProjectTextResult> {
    const relativePath = (value as { readonly relativePath?: string }).relativePath;
    if (!relativePath || !this.files.has(relativePath)) return { ok: false, error: 'not-found' };
    const content = this.files.get(relativePath)!;
    return {
      ok: true,
      file: {
        relativePath,
        content,
        version: version(content),
        byteLength: Buffer.byteLength(content),
        language: 'typescript',
        sensitive: false,
      },
    };
  }

  async resolveProjectPath(value: unknown) {
    const relativePath = (value as { readonly relativePath?: string }).relativePath ?? '';
    return {
      ok: true as const,
      value: {
        absolutePath: relativePath ? path.join(this.rootPath, ...relativePath.split('/')) : this.rootPath,
      },
    };
  }
}

let tempRoot: string;
let workspace: FakeWorkspace;
let bindings: readonly ProjectMapRootBinding[];
let cacheValue: ProjectMapDocument | undefined;
let cache: {
  readonly get: ReturnType<typeof vi.fn>;
  readonly put: ReturnType<typeof vi.fn>;
};
let gitStatus: string;

function service(): ProjectMapService {
  const bindingStore = {
    get: vi.fn(async () => bindings),
    set: vi.fn(async (_request, next: readonly ProjectMapRootBinding[]) => {
      bindings = next;
      return next;
    }),
  } as unknown as ProjectMapBindingStore;
  cache = {
    get: vi.fn(async () => cacheValue),
    put: vi.fn(async () => undefined),
  };
  const git = {
    run: vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args.includes('--show-toplevel')) return `${tempRoot}\n`;
      if (args.at(-1) === 'HEAD') return `${'c'.repeat(40)}\n`;
      if (args.includes('status')) return gitStatus;
      throw new Error('Unexpected git command');
    }),
  } as unknown as GitRunner;
  return new ProjectMapService(
    workspace as unknown as ProjectWorkspaceService,
    bindingStore,
    cache as unknown as ProjectMapCacheStore,
    git,
  );
}

function serviceWithApproval(): ProjectMapService {
  const maps = service();
  const internals = maps as unknown as {
    approvalStore?: ProjectMapApprovalStore;
    jobStore?: ProjectMapJobStore;
  };
  let approval: { readonly mapId: string; readonly fingerprint: string; readonly approvedAt: string } | undefined;
  Object.defineProperty(internals, 'approvalStore', {
    configurable: true,
    value: {
      get: vi.fn(() => approval),
      approve: vi.fn(async (_request, mapId: string, fingerprint: string) => {
        approval = { mapId, fingerprint, approvedAt: '2026-08-20T00:00:00.000Z' };
        return approval;
      }),
    } as unknown as ProjectMapApprovalStore,
  });
  Object.defineProperty(internals, 'jobStore', {
    configurable: true,
    value: { activeFor: vi.fn(() => undefined) } as unknown as ProjectMapJobStore,
  });
  return maps;
}

function installFixture(values = fixture()): void {
  workspace.files.set('.ezterminal/project-map/manifest.json', JSON.stringify(values.manifest));
  workspace.files.set('.ezterminal/project-map/maps/runtime.architecture.json', JSON.stringify(values.spec));
  workspace.files.set('src/input.ts', values.input);
  workspace.files.set('src/evidence.ts', values.evidenceSource);
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-'));
  workspace = new FakeWorkspace(tempRoot);
  bindings = [binding];
  cacheValue = undefined;
  gitStatus = '';
  installFixture();
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ProjectMapService', () => {
  it('normalizes evidence line endings without inventing a trailing newline', () => {
    expect(digestProjectMapEvidenceLines('one\r\ntwo\rthree\n', 1, 3)).toBe(
      `sha256:${createHash('sha256').update('one\ntwo\nthree').digest('hex')}`,
    );
  });

  it('returns and caches only a fully verified deterministic map', async () => {
    const maps = service();
    const result = await maps.read({ ...request, mapId: 'runtime' });
    maps.close();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.map.state).toBe('valid');
    expect(result.map.provenance.kind).toBe('commit-pinned');
    expect(result.map.verification.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(cache.put).toHaveBeenCalledWith(expect.any(String), result.map);
  });

  it('marks a semantically valid map stale when an authoritative input changes', async () => {
    workspace.files.set('src/input.ts', 'export const input = 2;\n');
    const maps = service();
    const result = await maps.read(request);
    maps.close();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.map.state).toBe('stale');
    expect(result.map.verification.diagnostics.map((item) => item.code)).toContain('inputs.review-required');
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('never renders invalid current evidence and returns the last-good cache separately', async () => {
    const validService = service();
    const valid = await validService.read(request);
    validService.close();
    if (!valid.ok) throw new Error(valid.error);
    cacheValue = valid.map;
    workspace.files.set('src/evidence.ts', 'header\nexport const authority = false;\nfooter\n');

    const maps = service();
    const result = await maps.read(request);
    maps.close();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid evidence');
    expect(result.state).toBe('invalid-with-last-good');
    expect(result.diagnostics.map((item) => item.code)).toContain('evidence.digest-mismatch');
    expect(result.lastGood?.fromLastGood).toBe(true);
    expect(result.lastGood?.spec).toEqual(valid.map.spec);
  });

  it('isolates last-good entries by the complete logical-root binding set', async () => {
    const maps = service();
    const valid = await maps.read(request);
    if (!valid.ok) throw new Error(valid.error);
    const cachedKey = cache.put.mock.calls[0]?.[0] as string | undefined;
    if (!cachedKey) throw new Error('Expected a cache key.');
    cacheValue = valid.map;
    cache.get.mockImplementation(async (key: string) => key === cachedKey ? cacheValue : undefined);
    bindings = [
      binding,
      { rootAlias: 'other', rootId: 'root-2', workspaceId: 'workspace-2' },
    ];

    const rebound = await maps.read(request);
    maps.close();

    expect(rebound.ok).toBe(false);
    if (rebound.ok) throw new Error('Expected invalid bindings.');
    expect(rebound.state).toBe('binding-required');
    expect(rebound.lastGood).toBeUndefined();
    expect(cache.get.mock.calls.at(-1)?.[0]).not.toBe(cachedKey);
  });

  it('requires explicit bindings and records dirty relevant paths as a worktree snapshot', async () => {
    bindings = [];
    let maps = service();
    const unbound = await maps.read(request);
    maps.close();
    expect(unbound.ok).toBe(false);
    if (unbound.ok) throw new Error('Expected binding requirement');
    expect(unbound.state).toBe('binding-required');

    bindings = [binding];
    gitStatus = ' M src/input.ts\u0000';
    maps = service();
    const dirty = await maps.read(request);
    maps.close();
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) throw new Error(dirty.error);
    expect(dirty.map.provenance.kind).toBe('worktree-snapshot');
    expect(dirty.map.provenance.roots[0]?.snapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('returns the verified collection state after saving bindings', async () => {
    bindings = [];
    const maps = service();
    const result = await maps.setBindings({ ...request, bindings: [binding] });
    maps.close();

    expect(result.ok).toBe(true);
    expect(result.collection.state).toBe('valid');
    expect(result.collection.bindings).toEqual([binding]);
    expect(cache.put).toHaveBeenCalledTimes(2);
  });

  it('previews a Production candidate and locks the approved display to an exact fingerprint', async () => {
    const maps = serviceWithApproval();
    const opened = await maps.open({ ...request, mapId: 'runtime' }, true);
    expect(opened.ok).toBe(true);
    expect(opened.snapshot.displaySource).toBe('candidate-preview');
    const candidate = opened.snapshot.candidate;
    if (!candidate) throw new Error('Expected a verified candidate.');

    const approved = await maps.approve({
      ...request,
      mapId: 'runtime',
      fingerprint: candidate.verification.fingerprint,
    });
    maps.close();

    expect(approved.ok).toBe(true);
    expect(approved.snapshot.displaySource).toBe('approved');
    expect(approved.snapshot.approval?.fingerprint).toBe(candidate.verification.fingerprint);
    expect(approved.snapshot.map?.verification.fingerprint).toBe(candidate.verification.fingerprint);
  });

  it('coalesces concurrent first-open Production verification', async () => {
    const maps = service();
    const read = vi.spyOn(maps, 'read');

    const [first, second] = await Promise.all([
      maps.open({ ...request, mapId: 'runtime' }),
      maps.open({ ...request, mapId: 'runtime' }),
    ]);
    maps.close();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
