import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isAuxiliaryRendererUrl,
  rendererEntryUrls,
  resolveRendererAssetPath,
} from './app-renderer-protocol';
import { packagedRendererUrl } from '../shared/desktop-window';

describe('rendererEntryUrls', () => {
  it('uses the internal secure origin in production', () => {
    expect(rendererEntryUrls(undefined)).toEqual({
      main: packagedRendererUrl(false),
      auxiliary: packagedRendererUrl(true),
    });
  });

  it('keeps the Vite origin and adds only the auxiliary marker in development', () => {
    expect(rendererEntryUrls('http://localhost:5173/')).toEqual({
      main: 'http://localhost:5173/',
      auxiliary: 'http://localhost:5173/?ez-popout=1',
    });
  });
});

describe('resolveRendererAssetPath', () => {
  const root = path.resolve('C:/app/renderer/main_window');

  it('resolves only safe GET/HEAD files below the renderer root', () => {
    expect(resolveRendererAssetPath(root, packagedRendererUrl(), 'GET')).toBe(
      path.join(root, 'index.html'),
    );
    expect(
      resolveRendererAssetPath(root, 'https://ezterminal.invalid/assets/app.js', 'HEAD'),
    ).toBe(path.join(root, 'assets', 'app.js'));
  });

  it('rejects traversal, foreign origins, directories, and mutating methods', () => {
    expect(resolveRendererAssetPath(root, 'https://ezterminal.invalid/%2e%2e/secret', 'GET')).toBeNull();
    expect(resolveRendererAssetPath(root, 'https://evil.invalid/index.html', 'GET')).toBeNull();
    expect(resolveRendererAssetPath(root, 'https://ezterminal.invalid/', 'POST')).toBeNull();
  });
});

describe('isAuxiliaryRendererUrl', () => {
  it('accepts only the exact auxiliary entry document', () => {
    const auxiliary = packagedRendererUrl(true);
    expect(isAuxiliaryRendererUrl(auxiliary, auxiliary)).toBe(true);
    expect(isAuxiliaryRendererUrl(packagedRendererUrl(false), auxiliary)).toBe(false);
    expect(isAuxiliaryRendererUrl(`${auxiliary}&extra=1`, auxiliary)).toBe(false);
    expect(isAuxiliaryRendererUrl('https://evil.invalid/index.html?ez-popout=1', auxiliary)).toBe(false);
  });
});
