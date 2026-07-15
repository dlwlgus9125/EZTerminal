import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const verifier = path.resolve('scripts/verify-mobile-webview74.mjs');
const temporaryRoots: string[] = [];
const marker = '__EZTERMINAL_WEBVIEW74_COMPAT_V1__';
const readyMarker = '__EZTERMINAL_WEBVIEW74_BOOTSTRAP_READY__';
const failureMessage = 'WebView compatibility bootstrap did not complete';
const postconditionMessage = 'WebView compatibility postcondition failed:';
const features = [
  'Object.hasOwn',
  'Element.replaceChildren',
  'WeakRef',
  'AggregateError',
  'Blob.text',
  'Blob.arrayBuffer',
  'File.text',
  'File.arrayBuffer',
  'Array.prototype.at',
  'String.prototype.at',
  'crypto.randomUUID',
  'HTMLElement.inert',
];
const fallbackImplementationMarkers = [
  'WeakRef target must be an object',
  'FileReader returned an invalid',
  'Blob read failed',
  'Array.prototype.at called on null or undefined',
  'ezterminal-webview74-inert',
];

function createOutput({
  advertisedFeatures = features,
  emittedImplementationMarkers = fallbackImplementationMarkers,
  staticImports = [],
  entrySource,
}: {
  readonly advertisedFeatures?: readonly string[];
  readonly emittedImplementationMarkers?: readonly string[];
  readonly staticImports?: readonly string[];
  readonly entrySource?: string;
} = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ezterminal-webview74-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  mkdirSync(path.join(root, '.vite'), { recursive: true });
  writeFileSync(
    path.join(root, 'index.html'),
    '<script crossorigin type="module" src="/assets/index.js"></script>',
  );
  writeFileSync(
    path.join(root, 'assets', 'index.js'),
    entrySource
      ?? `globalThis.__compatFeatures=${JSON.stringify(advertisedFeatures)};`
        + `globalThis[${JSON.stringify(marker)}]=${JSON.stringify(advertisedFeatures.join(','))};`
        + `globalThis.__fallbackBodies=${JSON.stringify(emittedImplementationMarkers.join(','))};`
        + `globalThis.__postcondition=${JSON.stringify(postconditionMessage)};`
        + `if(!globalThis[${JSON.stringify(marker)}])throw new Error(${JSON.stringify(failureMessage)});`
        + `globalThis[${JSON.stringify(readyMarker)}]=true;import("./main.js")`,
  );
  // A custom `.at()` method used to make the old regex-only verifier reject a
  // compatible bundle. It is now accepted because the bootstrap contract
  // supplies Array/String fallbacks before this chunk is evaluated.
  writeFileSync(path.join(root, 'assets', 'main.js'), 'router.at("/health");new WeakRef(window);node.replaceChildren()');
  writeFileSync(
    path.join(root, '.vite', 'manifest.json'),
    JSON.stringify({
      'index.html': {
        file: 'assets/index.js',
        name: 'index',
        src: 'index.html',
        isEntry: true,
        imports: staticImports,
        dynamicImports: ['_main.js'],
      },
      '_main.js': {
        file: 'assets/main.js',
        name: 'main',
        isDynamicEntry: true,
        imports: ['index.html'],
      },
    }),
  );
  return root;
}

function verify(root: string) {
  return spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' });
}

describe('WebView 74 build verifier', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('accepts managed runtime APIs and does not reject an arbitrary .at() method', () => {
    const result = verify(createOutput());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WebView 74 compatibility verified');
  });

  it('rejects a bundle whose compatibility signature omits a required fallback', () => {
    const result = verify(createOutput({
      advertisedFeatures: features.filter((feature) => feature !== 'WeakRef'),
    }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('complete, ordered compatibility feature contract');
  });

  it('rejects advertised contracts when fallback implementation bodies are absent', () => {
    const result = verify(createOutput({ emittedImplementationMarkers: [] }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('emitted fallback implementations');
    expect(result.stderr).toContain('WeakRef target must be an object');
  });

  it('rejects fallback bodies without the complete runtime postcondition', () => {
    const result = verify(createOutput({
      entrySource: `globalThis.__compatFeatures=${JSON.stringify(features)};`
        + `globalThis[${JSON.stringify(marker)}]=${JSON.stringify(features.join(','))};`
        + `globalThis.__fallbackBodies=${JSON.stringify(fallbackImplementationMarkers.join(','))};`
        + `if(!globalThis[${JSON.stringify(marker)}])throw new Error(${JSON.stringify(failureMessage)});`
        + `globalThis[${JSON.stringify(readyMarker)}]=true;import("./main.js")`,
    }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('runtime fallback postcondition');
  });

  it('rejects a static application dependency before the compatibility boundary', () => {
    const result = verify(createOutput({ staticImports: ['_main.js'] }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('static dependency');
  });

  it('rejects a bundle that advertises features without a completed installer contract', () => {
    const result = verify(createOutput({
      entrySource: `globalThis[${JSON.stringify(marker)}]=${JSON.stringify(features.join(','))};`
        + `globalThis.__postcondition=${JSON.stringify(postconditionMessage)};import("./main.js")`,
    }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('completion guard');
  });

  it('rejects an application import emitted before installer completion', () => {
    const signature = `${marker}:${features.join(',')}`;
    const result = verify(createOutput({
      entrySource: `globalThis[${JSON.stringify(marker)}]=${JSON.stringify(signature)};`
        + `globalThis.__postcondition=${JSON.stringify(postconditionMessage)};import("./main.js");`
        + `if(!globalThis[${JSON.stringify(marker)}])throw new Error(${JSON.stringify(failureMessage)});`
        + `globalThis[${JSON.stringify(readyMarker)}]=true`,
    }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must execute before the dynamic application import');
  });
});
