import path from 'node:path';

import {
  APP_RENDERER_ENTRY_PATH,
  APP_RENDERER_ORIGIN,
  packagedRendererUrl,
} from '../shared/desktop-window';

export interface RendererEntryUrls {
  readonly main: string;
  readonly auxiliary: string;
}

export function rendererEntryUrls(devServerUrl: string | undefined): RendererEntryUrls {
  if (!devServerUrl) {
    return {
      main: packagedRendererUrl(false),
      auxiliary: packagedRendererUrl(true),
    };
  }
  const main = new URL(devServerUrl);
  const auxiliary = new URL(main.href);
  auxiliary.search = '?ez-popout=1';
  auxiliary.hash = '';
  return { main: main.href, auxiliary: auxiliary.href };
}

/**
 * Resolve an internal renderer request without allowing URL-encoded traversal
 * or access outside Vite's renderer output directory.
 */
export function resolveRendererAssetPath(
  rendererRoot: string,
  requestUrl: string,
  method: string,
): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  // WHATWG URL parsing normalizes encoded dot segments before exposing
  // `pathname`, so reject them from the raw URL before parsing.
  if (/%2e/i.test(requestUrl) || /[\\]/.test(requestUrl)) return null;

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.origin !== APP_RENDERER_ORIGIN || url.username || url.password || url.port) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '/') pathname = APP_RENDERER_ENTRY_PATH;

  const root = path.resolve(rendererRoot);
  const candidate = path.resolve(root, `.${pathname.replaceAll('/', path.sep)}`);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

export function isAuxiliaryRendererUrl(url: string, expectedUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const expected = new URL(expectedUrl);
    return (
      candidate.origin === expected.origin
      && candidate.pathname === expected.pathname
      && candidate.search === expected.search
      && candidate.hash === ''
    );
  } catch {
    return false;
  }
}
