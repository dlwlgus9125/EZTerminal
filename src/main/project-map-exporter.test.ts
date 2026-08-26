import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectMapDocument,
  ProjectMapEvidence,
  ProjectMapExportRequest,
  ProjectMapSpec,
} from '../shared/project-map';
import { layoutProjectMap } from '../shared/project-map-layout';

interface MockWindowRecord {
  readonly options: Record<string, unknown>;
  loadedUrl?: string;
  captureRect?: Record<string, number>;
  destroyed: boolean;
}

const electronMock = vi.hoisted(() => ({
  windows: [] as MockWindowRecord[],
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly webContents: {
      capturePage: (rect: Record<string, number>) => Promise<{ toPNG: () => Buffer }>;
    };

    private readonly record: MockWindowRecord;

    constructor(options: Record<string, unknown>) {
      this.record = { options, destroyed: false };
      electronMock.windows.push(this.record);
      this.webContents = {
        capturePage: async (rect) => {
          this.record.captureRect = rect;
          return { toPNG: () => Buffer.from('mock-project-map-png') };
        },
      };
    }

    async loadURL(url: string): Promise<void> {
      this.record.loadedUrl = url;
    }

    isDestroyed(): boolean {
      return this.record.destroyed;
    }

    destroy(): void {
      this.record.destroyed = true;
    }
  },
}));

import { exportProjectMap } from './project-map-exporter';

const sha256 = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  summary: 'An exporter contract fixture.',
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

function request(parentDirectory: string, fingerprint = document().verification.fingerprint): ProjectMapExportRequest {
  return {
    projectId: 'project-one',
    ownerRootId: 'root-one',
    ownerWorkspaceId: 'workspace-one',
    mapId: spec.id,
    fingerprint,
    parentDirectory,
    theme: 'current',
  };
}

let directory: string;
let exportParent: string;

beforeEach(async () => {
  electronMock.windows.length = 0;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-export-'));
  exportParent = path.join(directory, 'exports');
  await fs.mkdir(exportParent);
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('exportProjectMap', () => {
  it('writes SVG, 1600x900 PNG, and a hash receipt into a new fingerprinted directory', async () => {
    const map = document();
    const result = await exportProjectMap(request(exportParent), map, 'dark');

    expect(result.ok).toBe(true);
    const canonicalExportParent = await fs.realpath(exportParent);
    expect(result.directory).toBe(path.join(
      canonicalExportParent,
      `runtime-${map.verification.fingerprint.slice(7, 19)}`,
    ));
    const svgPath = path.join(result.directory!, 'runtime.svg');
    const pngPath = path.join(result.directory!, 'runtime.png');
    const receiptPath = path.join(result.directory!, 'runtime.verification.json');
    const [svg, png, receiptText] = await Promise.all([
      fs.readFile(svgPath, 'utf8'),
      fs.readFile(pngPath),
      fs.readFile(receiptPath, 'utf8'),
    ]);
    const receipt = JSON.parse(receiptText) as {
      viewport: { width: number; height: number };
      theme: string;
      fingerprint: string;
      artifacts: Record<string, string>;
    };
    expect(svg).toContain('<svg');
    expect(receipt).toMatchObject({
      viewport: { width: 1600, height: 900 },
      theme: 'dark',
      fingerprint: map.verification.fingerprint,
      artifacts: {
        'runtime.svg': sha256(svg),
        'runtime.png': sha256(png),
      },
    });
    expect(electronMock.windows).toHaveLength(1);
    expect(electronMock.windows[0]).toMatchObject({
      options: {
        show: false,
        width: 1600,
        height: 900,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
        },
      },
      captureRect: { x: 0, y: 0, width: 1600, height: 900 },
      destroyed: true,
    });
  });

  it('refuses authoritative directories, relative paths, and mismatched approval fingerprints', async () => {
    const authoritative = path.join(directory, '.ezterminal', 'project-map', 'exports');
    const wrongFingerprint = sha256('not-approved');

    await expect(exportProjectMap(request('relative-export'), document(), 'dark')).resolves.toEqual({
      ok: false,
      error: 'invalid-export-directory',
    });
    await expect(exportProjectMap(request(authoritative), document(), 'dark')).resolves.toEqual({
      ok: false,
      error: 'invalid-export-directory',
    });
    await expect(exportProjectMap(request(exportParent, wrongFingerprint), document(), 'dark')).resolves.toEqual({
      ok: false,
      error: 'fingerprint-mismatch',
    });
    expect(electronMock.windows).toHaveLength(0);
  });

  it('never renders again or overwrites when the fingerprinted destination already exists', async () => {
    const map = document();
    const first = await exportProjectMap(request(exportParent), map, 'light');
    expect(first.ok).toBe(true);
    const receiptPath = path.join(first.directory!, 'runtime.verification.json');
    const originalReceipt = await fs.readFile(receiptPath, 'utf8');

    const second = await exportProjectMap(request(exportParent), map, 'light');

    expect(second).toEqual({ ok: false, error: 'export-destination-exists' });
    expect(electronMock.windows).toHaveLength(1);
    await expect(fs.readFile(receiptPath, 'utf8')).resolves.toBe(originalReceipt);
    await expect(fs.readdir(exportParent)).resolves.toEqual([path.basename(first.directory!)]);
  });
});
