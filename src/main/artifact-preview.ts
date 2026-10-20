import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactGrantResult, ArtifactPreviewKind } from '../shared/artifact-preview';

/**
 * Isolated previews of files an AI made (HTML pages, PDFs) for the Results tab.
 *
 * The renderer asks for a preview of one file; main answers with an
 * `ezartifact://<token>/<name>` URL. The token is random, maps to exactly one
 * folder (HTML: the page's folder, so its own css/js/images load) or one file
 * (PDF), expires when unused, and is revoked when the preview closes. Every
 * response is sandboxed by its own CSP: scripts run in an opaque origin with no
 * access to the app, no network, no forms, popups, navigation or downloads.
 * Paths never cross back to the renderer, and nothing outside the granted
 * folder can be read: `..`, encoded separators, network shares, devices and
 * links that resolve elsewhere are refused.
 */

export const ARTIFACT_SCHEME = 'ezartifact';
export const ARTIFACT_SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, stream: true });

export type { ArtifactGrantResult, ArtifactPreviewKind } from '../shared/artifact-preview';

const MAX_GRANTS = 32;
const IDLE_MS = 30 * 60_000;
const HTML_MAX_BYTES = 5 * 1_048_576;
const ASSET_MAX_BYTES = 20 * 1_048_576;
const TOKEN = /^[0-9a-f]{32}$/u;

/** The only file types a preview serves; anything else is not found. */
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
});

interface Grant {
  readonly kind: ArtifactPreviewKind;
  /** HTML: the page's real folder. PDF: the real file itself. */
  readonly root: string;
  lastUsed: number;
}

export interface ArtifactPreviewRegistryOptions {
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

function extensionOf(file: string): string {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** `\\server\share`, `//server`, `\\?\…`, `\\.\…`: never opened for a preview. */
function isNetworkOrDevicePath(value: string): boolean {
  return /^[\\/]{2}/u.test(value);
}

export class ArtifactPreviewRegistry {
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly pathApi: typeof path.win32;

  public constructor(options: ArtifactPreviewRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pathApi = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  }

  public get size(): number {
    return this.grants.size;
  }

  /** Allows previewing one HTML page (with its folder's assets) or one PDF. */
  public async grant(filePath: unknown, kind: unknown): Promise<ArtifactGrantResult> {
    if (kind !== 'html' && kind !== 'pdf') return { ok: false, error: 'unsupported' };
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4_096 || filePath.includes('\0')
      || isNetworkOrDevicePath(filePath) || !this.pathApi.isAbsolute(filePath)) {
      return { ok: false, error: 'invalid-path' };
    }
    const extension = extensionOf(filePath);
    if (kind === 'html' ? extension !== 'html' && extension !== 'htm' : extension !== 'pdf') return { ok: false, error: 'unsupported' };
    let real: string;
    try {
      real = await realpath(filePath);
      if (isNetworkOrDevicePath(real)) return { ok: false, error: 'invalid-path' };
      const info = await stat(real);
      if (!info.isFile()) return { ok: false, error: 'not-found' };
      if (info.size > (kind === 'html' ? HTML_MAX_BYTES : ASSET_MAX_BYTES)) return { ok: false, error: 'too-large' };
    } catch {
      return { ok: false, error: 'not-found' };
    }
    this.expire();
    while (this.grants.size >= MAX_GRANTS) {
      const oldest = [...this.grants.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!oldest) break;
      this.grants.delete(oldest[0]);
    }
    const token = randomBytes(16).toString('hex');
    this.grants.set(token, { kind, root: kind === 'html' ? this.pathApi.dirname(real) : real, lastUsed: this.now() });
    return { ok: true, token, url: `${ARTIFACT_SCHEME}://${token}/${encodeURIComponent(this.pathApi.basename(real))}` };
  }

  public revoke(token: unknown): void {
    if (typeof token === 'string') this.grants.delete(token);
  }

  public kindOf(token: string): ArtifactPreviewKind | undefined {
    return this.grants.get(token)?.kind;
  }

  /** The real file a preview URL names, if it stays inside its grant. */
  public async resolve(url: string): Promise<{ readonly ok: true; readonly file: string; readonly mime: string; readonly token: string; readonly kind: ArtifactPreviewKind } | { readonly ok: false; readonly status: 400 | 404 }> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, status: 400 }; }
    if (parsed.protocol !== `${ARTIFACT_SCHEME}:` || parsed.username || parsed.password || parsed.port) return { ok: false, status: 400 };
    const token = parsed.hostname;
    if (!TOKEN.test(token)) return { ok: false, status: 404 };
    this.expire();
    const grant = this.grants.get(token);
    if (!grant) return { ok: false, status: 404 };
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    const decoded: string[] = [];
    for (const segment of segments) {
      let value: string;
      try { value = decodeURIComponent(segment); } catch { return { ok: false, status: 400 }; }
      if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0') || value.includes(':')) {
        return { ok: false, status: 400 };
      }
      decoded.push(value);
    }
    if (decoded.length === 0) return { ok: false, status: 404 };
    let candidate: string;
    if (grant.kind === 'pdf') {
      // A PDF grant is exactly one file: only its own name resolves.
      if (decoded.length !== 1 || decoded[0] !== this.pathApi.basename(grant.root)) return { ok: false, status: 404 };
      candidate = grant.root;
    } else {
      candidate = this.pathApi.join(grant.root, ...decoded);
    }
    let real: string;
    try { real = await realpath(candidate); } catch { return { ok: false, status: 404 }; }
    if (grant.kind === 'html' && !this.inside(grant.root, real)) return { ok: false, status: 404 };
    if (grant.kind === 'pdf' && real !== grant.root) return { ok: false, status: 404 };
    const mime = MIME_TYPES[extensionOf(real)];
    if (!mime) return { ok: false, status: 404 };
    grant.lastUsed = this.now();
    return { ok: true, file: real, mime, token, kind: grant.kind };
  }

  private inside(root: string, target: string): boolean {
    const relative = this.pathApi.relative(root, target);
    return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${this.pathApi.sep}`) && !this.pathApi.isAbsolute(relative);
  }

  private expire(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) if (now - grant.lastUsed > IDLE_MS) this.grants.delete(token);
  }
}

/**
 * Response headers: the page and its assets run sandboxed (scripts only, opaque
 * origin) and may load nothing but files from their own grant. A PDF is shown
 * by Chromium's viewer, which a sandbox directive would disable.
 */
export function artifactResponseHeaders(token: string, kind: ArtifactPreviewKind, mime: string): Record<string, string> {
  const self = `${ARTIFACT_SCHEME}://${token}`;
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (kind === 'html') {
    headers['Content-Security-Policy'] = [
      'sandbox allow-scripts',
      "default-src 'none'",
      `script-src 'unsafe-inline' ${self}`,
      `style-src 'unsafe-inline' ${self}`,
      `img-src ${self} data: blob:`,
      `font-src ${self} data:`,
      `media-src ${self} blob:`,
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; ');
  }
  return headers;
}

/** `protocol.handle` callback for the preview scheme. */
export async function handleArtifactRequest(registry: ArtifactPreviewRegistry, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const resolved = await registry.resolve(request.url);
  if (!resolved.ok) return new Response(resolved.status === 400 ? 'Bad request' : 'Not found', { status: resolved.status, headers: { 'Cache-Control': 'no-store' } });
  try {
    const info = await stat(resolved.file);
    const limit = resolved.mime.startsWith('text/html') ? HTML_MAX_BYTES : ASSET_MAX_BYTES;
    if (!info.isFile() || info.size > limit) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const headers = artifactResponseHeaders(resolved.token, resolved.kind, resolved.mime);
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(info.size) } });
    const body = await readFile(resolved.file);
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** Chromium's built-in PDF viewer (a fixed internal extension id) draws a previewed PDF in its own frames. */
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

/** Main-process Electron registration seam: subframes may only navigate to previews (and the PDF viewer). */
export function isAllowedSubframeUrl(url: string): boolean {
  return url.startsWith(`${ARTIFACT_SCHEME}://`) || url.startsWith(PDF_VIEWER_ORIGIN) || url === 'about:blank' || url === 'about:srcdoc';
}
