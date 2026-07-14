import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { areBuildArtifactsFresh, buildArtifactPaths, buildInputPaths } from '../e2e/build-freshness';

const tempDirs: string[] = [];

function tempFile(name: string, modifiedAt: Date): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterminal-build-freshness-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, name);
  utimesSync(file, modifiedAt, modifiedAt);
  return file;
}

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterminal-build-manifest-'));
  tempDirs.push(dir);
  return dir;
}

function writeTreeFile(root: string, relativePath: string, modifiedAt: Date, contents = relativePath): string {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  utimesSync(file, modifiedAt, modifiedAt);
  return file;
}

function relativePaths(root: string, files: readonly string[]): string[] {
  return files.map((file) => path.relative(root, file).replaceAll('\\', '/'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe('E2E build freshness', () => {
  it('rejects existing artifacts when a renderer input is newer', () => {
    const artifact = tempFile('renderer.js', new Date('2026-07-14T01:00:00Z'));
    const source = tempFile('BrandMark.tsx', new Date('2026-07-14T02:00:00Z'));

    expect(areBuildArtifactsFresh([artifact], [source])).toBe(false);
  });

  it('accepts artifacts only when every required artifact is newer than every input', () => {
    const main = tempFile('main.js', new Date('2026-07-14T03:00:00Z'));
    const renderer = tempFile('renderer.js', new Date('2026-07-14T03:00:00Z'));
    const source = tempFile('App.tsx', new Date('2026-07-14T02:00:00Z'));

    expect(areBuildArtifactsFresh([main, renderer], [source])).toBe(true);
    expect(areBuildArtifactsFresh([main, path.join(tmpdir(), 'missing-renderer.js')], [source])).toBe(false);
  });

  it('wires every Forge entry, Vite config, and referenced renderer asset into freshness', () => {
    const root = tempRoot();
    const inputTime = new Date('2026-07-14T02:00:00Z');
    const artifactTime = new Date('2026-07-14T03:00:00Z');
    const requiredInputs = [
      'forge.config.ts',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'vite.interpreter.config.ts',
      'vite.main.config.ts',
      'vite.packet-capture.config.ts',
      'vite.preload.config.ts',
      'vite.renderer.config.ts',
      'vite.script-host.config.ts',
    ];
    const requiredNodeArtifacts = [
      '.vite/build/main.js',
      '.vite/build/preload.js',
      '.vite/build/interpreter-process.js',
      '.vite/build/script-host.js',
      '.vite/build/packet-capture-host.js',
    ];
    for (const input of requiredInputs) writeTreeFile(root, input, inputTime);
    writeTreeFile(root, 'src/renderer/App.tsx', inputTime);
    for (const artifact of requiredNodeArtifacts) writeTreeFile(root, artifact, artifactTime);
    writeTreeFile(
      root,
      '.vite/renderer/main_window/index.html',
      artifactTime,
      '<script type="module" src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css">',
    );
    writeTreeFile(root, '.vite/renderer/main_window/assets/index.js', artifactTime, 'export {};');
    writeTreeFile(
      root,
      '.vite/renderer/main_window/assets/index.css',
      artifactTime,
      '@font-face { src: url("./brand.woff2") format("woff2"); }',
    );
    const font = writeTreeFile(root, '.vite/renderer/main_window/assets/brand.woff2', artifactTime);

    const inputs = buildInputPaths(root);
    const artifacts = buildArtifactPaths(root);
    expect(relativePaths(root, inputs)).toEqual(expect.arrayContaining([...requiredInputs, 'src/renderer/App.tsx']));
    expect(relativePaths(root, artifacts)).toEqual(
      expect.arrayContaining([
        ...requiredNodeArtifacts,
        '.vite/renderer/main_window/index.html',
        '.vite/renderer/main_window/assets/index.js',
        '.vite/renderer/main_window/assets/index.css',
        '.vite/renderer/main_window/assets/brand.woff2',
      ]),
    );
    expect(areBuildArtifactsFresh(artifacts, inputs)).toBe(true);

    rmSync(font);
    const artifactsWithMissingFont = buildArtifactPaths(root);
    expect(relativePaths(root, artifactsWithMissingFont)).toContain(
      '.vite/renderer/main_window/assets/brand.woff2',
    );
    expect(areBuildArtifactsFresh(artifactsWithMissingFont, inputs)).toBe(false);

    writeTreeFile(root, '.vite/renderer/main_window/assets/brand.woff2', artifactTime);
    rmSync(path.join(root, 'vite.packet-capture.config.ts'));
    const inputsWithMissingConfig = buildInputPaths(root);
    expect(relativePaths(root, inputsWithMissingConfig)).toContain('vite.packet-capture.config.ts');
    expect(areBuildArtifactsFresh(buildArtifactPaths(root), inputsWithMissingConfig)).toBe(false);
  });
});
