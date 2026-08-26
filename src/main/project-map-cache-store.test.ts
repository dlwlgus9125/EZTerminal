import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectMapDocument, ProjectMapEvidence, ProjectMapSpec } from '../shared/project-map';
import { layoutProjectMap } from '../shared/project-map-layout';
import { ProjectMapCacheStore } from './project-map-cache-store';

const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const evidence: ProjectMapEvidence[] = [{
  rootAlias: 'app',
  relativePath: 'src/main/main.ts',
  startLine: 1,
  endLine: 1,
  lineDigest: sha256('line'),
  claim: 'The main process owns this behavior.',
}];
const spec: ProjectMapSpec = {
  schemaVersion: 2,
  id: 'runtime',
  type: 'architecture',
  title: 'Runtime',
  summary: 'A cache-store contract fixture.',
  contentLocale: 'en',
  layoutIntent: { density: 'balanced', emphasisIds: ['renderer', 'main'] },
  chapters: [],
  groups: [{ id: 'desktop', label: 'Desktop' }],
  nodes: [
    { id: 'renderer', label: 'Renderer', kind: 'surface', group: 'desktop', rank: 0, order: 0, evidence },
    { id: 'main', label: 'Main', kind: 'service', group: 'desktop', rank: 1, order: 0, evidence },
  ],
  relations: [{
    id: 'renderer-to-main',
    from: 'renderer',
    to: 'main',
    label: 'invokes',
    kind: 'primary',
    evidence,
  }],
  mainPath: ['renderer', 'main'],
};

function document(): ProjectMapDocument {
  const layout = layoutProjectMap(spec).layout;
  return {
    collectionId: 'ezterminal',
    mapId: spec.id,
    mapPath: '.ezterminal/project-map/maps/runtime.architecture.json',
    state: 'valid',
    spec,
    layout,
    provenance: {
      kind: 'commit-pinned',
      roots: [{ rootAlias: 'app', head: 'c'.repeat(40), dirty: false }],
    },
    verification: {
      quality: 'production',
      fingerprint: sha256('fingerprint'),
      verifiedAt: '2026-08-19T00:00:00.000Z',
      manifestHash: sha256('manifest'),
      specHash: sha256('spec'),
      inputHash: sha256('input'),
      layoutHash: sha256(JSON.stringify(layout)),
      checks: [
        { name: 'schema', status: 'passed' },
        { name: 'semantics', status: 'passed' },
        { name: 'evidence', status: 'passed' },
        { name: 'inputs', status: 'passed' },
        { name: 'layout', status: 'passed' },
        { name: 'routes', status: 'passed' },
        { name: 'labels', status: 'passed' },
        { name: 'containment', status: 'passed' },
        { name: 'accessibility', status: 'passed' },
        { name: 'provenance', status: 'passed' },
      ],
      diagnostics: [],
    },
    fromLastGood: false,
  };
}

let directory: string;
let store: ProjectMapCacheStore;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-cache-'));
  store = new ProjectMapCacheStore(directory);
  await store.init();
});

afterEach(async () => {
  await store.flush();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('ProjectMapCacheStore', () => {
  it('keeps a shared content-addressed blob while another key still references it', async () => {
    await store.put('project-one', document());
    await store.put('project-two', document());
    const indexPath = path.join(directory, 'project-map-cache', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      entries: Array<{ key: string; blob: string }>;
    };
    expect(new Set(index.entries.map((entry) => entry.blob)).size).toBe(1);
    const blob = index.entries[0]?.blob;
    if (!blob) throw new Error('Expected a cache blob.');

    await (store as unknown as { removeEntry: (key: string) => Promise<void> }).removeEntry('project-one');

    await expect(fs.access(path.join(directory, 'project-map-cache', 'blobs', blob))).resolves.toBeUndefined();
    await expect(store.get('project-two')).resolves.toMatchObject({
      mapId: 'runtime',
      state: 'invalid-with-last-good',
      fromLastGood: true,
    });
  });

  it('rejects and removes a blob whose bytes no longer match its content address', async () => {
    await store.put('project-one', document());
    const indexPath = path.join(directory, 'project-map-cache', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      entries: Array<{ blob: string }>;
    };
    const blob = index.entries[0]?.blob;
    if (!blob) throw new Error('Expected a cache blob.');
    const blobPath = path.join(directory, 'project-map-cache', 'blobs', blob);
    const payload = await fs.readFile(blobPath, 'utf8');
    await fs.writeFile(blobPath, `${payload} `, 'utf8');
    await store.flush();
    store = new ProjectMapCacheStore(directory);
    await store.init();

    await expect(store.get('project-one')).resolves.toBeUndefined();
    await store.flush();
    await expect(fs.access(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a correctly content-addressed blob with injected nested metadata', async () => {
    await store.put('project-one', document());
    const indexPath = path.join(directory, 'project-map-cache', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      entries: Array<{ blob: string; bytes: number }>;
    };
    const originalBlob = index.entries[0]?.blob;
    if (!originalBlob || !index.entries[0]) throw new Error('Expected a cache blob.');
    const blobsDirectory = path.join(directory, 'project-map-cache', 'blobs');
    const envelope = JSON.parse(await fs.readFile(path.join(blobsDirectory, originalBlob), 'utf8')) as {
      document: { verification: Record<string, unknown> };
    };
    envelope.document.verification.injected = true;
    const payload = JSON.stringify(envelope);
    const injectedBlob = `${createHash('sha256').update(payload).digest('hex')}.json`;
    await fs.writeFile(path.join(blobsDirectory, injectedBlob), payload, 'utf8');
    index.entries[0].blob = injectedBlob;
    index.entries[0].bytes = Buffer.byteLength(payload);
    await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');
    await store.flush();
    store = new ProjectMapCacheStore(directory);
    await store.init();

    await expect(store.get('project-one')).resolves.toBeUndefined();
    await store.flush();
    await expect(fs.access(path.join(blobsDirectory, injectedBlob))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses stale documents instead of relabelling them as verified', async () => {
    await expect(store.put('stale', { ...document(), state: 'stale' })).rejects.toThrow(
      'Refusing to cache a non-current Project Map document.',
    );
  });
});
