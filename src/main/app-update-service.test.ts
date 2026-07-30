import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  UpdateHttpClient,
  UpdateHttpRequest,
  UpdateHttpResult,
} from './app-update-network';
import { UpdateHttpError } from './app-update-network';
import { AppUpdateService } from './app-update-service';

type ResponseFactory = (
  options: UpdateHttpRequest,
) => Promise<{ readonly statusCode?: number; readonly body: Buffer; readonly headers?: Record<string, string> }>;

class FakeHttpClient implements UpdateHttpClient {
  readonly calls: string[] = [];

  constructor(private readonly responses: ReadonlyMap<string, ResponseFactory>) {}

  async get(url: string, options: UpdateHttpRequest): Promise<UpdateHttpResult> {
    this.calls.push(url);
    const factory = this.responses.get(url);
    if (!factory) throw new Error(`unexpected URL: ${url}`);
    const response = await factory(options);
    if (response.body.length > 0) options.onChunk(response.body);
    return {
      statusCode: response.statusCode ?? 200,
      headers: response.headers ?? { 'content-length': String(response.body.length) },
      receivedBytes: response.body.length,
    };
  }
}

const API_URL = 'https://api.github.com/repos/dlwlgus9125/EZTerminal/releases/latest';
const SETUP_URL =
  'https://github.com/dlwlgus9125/EZTerminal/releases/download/v1.2.3/EZTerminal-Setup.exe';
const MANIFEST_URL =
  'https://github.com/dlwlgus9125/EZTerminal/releases/download/v1.2.3/release-manifest.json';
const temporaryDirectories: string[] = [];

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function fixture(
  setupBody = Buffer.from('verified setup bytes'),
  downloadedBody = setupBody,
): {
  readonly http: FakeHttpClient;
  readonly manifestBody: Buffer;
} {
  const manifestBody = Buffer.from(JSON.stringify({
    appVersion: '1.2.3',
    artifactStage: 'release',
    publicationEligible: true,
    evidenceCompleteness: 'complete',
    embeddedBuildShaVerified: true,
    artifacts: ['EZTerminal-Setup.exe'],
    windowsAuthenticode: {
      expected: 'NotSigned',
      app: 'NotSigned',
      setup: 'NotSigned',
    },
  }));
  const latestBody = Buffer.from(JSON.stringify({
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.3',
    published_at: '2026-07-30T00:00:00Z',
    html_url: 'https://github.com/dlwlgus9125/EZTerminal/releases/tag/v1.2.3',
    assets: [
      {
        name: 'EZTerminal-Setup.exe',
        size: setupBody.length,
        digest: `sha256:${sha256(setupBody)}`,
        browser_download_url: SETUP_URL,
      },
      {
        name: 'release-manifest.json',
        size: manifestBody.length,
        digest: `sha256:${sha256(manifestBody)}`,
        browser_download_url: MANIFEST_URL,
      },
    ],
  }));
  return {
    manifestBody,
    http: new FakeHttpClient(new Map([
      [API_URL, async () => ({ body: latestBody })],
      [MANIFEST_URL, async () => ({ body: manifestBody })],
      [SETUP_URL, async () => ({ body: downloadedBody })],
    ])),
  };
}

async function temporaryDownloadDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ezterminal-update-test-'));
  temporaryDirectories.push(root);
  return path.join(root, 'Downloads', 'EZTerminal');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('AppUpdateService', () => {
  it('coalesces checks and validates the release manifest before offering an update', async () => {
    const { http } = fixture();
    const downloadsDirectory = await temporaryDownloadDirectory();
    const resolveDownloadsDirectory = vi.fn(() => downloadsDirectory);
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      resolveDownloadsDirectory,
      http,
      openPath: vi.fn(async () => ''),
      now: () => 100_000,
    });

    const [first, second] = await Promise.all([service.check(), service.check()]);
    expect(first.phase).toBe('available');
    expect(second.release?.windowsAuthenticode).toBe('NotSigned');
    expect(http.calls).toEqual([API_URL, MANIFEST_URL]);
    expect(resolveDownloadsDirectory).not.toHaveBeenCalled();
  });

  it('downloads, verifies, and requires unsigned acknowledgement before opening', async () => {
    const { http } = fixture();
    const openPath = vi.fn(async () => '');
    const downloadsDirectory = await temporaryDownloadDirectory();
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      resolveDownloadsDirectory: () => downloadsDirectory,
      http,
      openPath,
    });

    await service.check();
    const downloaded = await service.download();
    expect(downloaded.phase).toBe('downloaded');
    expect(downloaded.download?.name).toBe('EZTerminal-Setup-1.2.3.exe');
    expect(await service.openDownloadedUpdate(false)).toEqual({
      ok: false,
      reason: 'unsigned-confirmation-required',
    });
    expect(openPath).not.toHaveBeenCalled();
    expect(await service.openDownloadedUpdate(true)).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(await readdir(downloadsDirectory)).toEqual(['EZTerminal-Setup-1.2.3.exe']);
  });

  it('removes a mismatched download and blocks opening it', async () => {
    const { http } = fixture(
      Buffer.from('expected setup bytes'),
      Buffer.from('tampered setup bytes!'),
    );
    const downloadsDirectory = await temporaryDownloadDirectory();
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      resolveDownloadsDirectory: () => downloadsDirectory,
      http,
      openPath: vi.fn(async () => ''),
    });

    await service.check();
    const result = await service.download();
    expect(result.phase).toBe('error');
    expect(result.error).toEqual(expect.objectContaining({
      stage: 'verify',
      code: 'INTEGRITY_MISMATCH',
      retryable: false,
    }));
    expect(await readdir(downloadsDirectory)).toEqual([]);
  });

  it('returns to available after a user cancellation and cleans partial files', async () => {
    const base = fixture();
    const http: UpdateHttpClient = {
      get: (url, options) => {
        if (url !== SETUP_URL) return base.http.get(url, options);
        return new Promise((_resolve, reject) => {
          if (options.signal.aborted) {
            reject(new UpdateHttpError('ABORTED'));
            return;
          }
          options.signal.addEventListener(
            'abort',
            () => reject(new UpdateHttpError('ABORTED')),
            { once: true },
          );
        });
      },
    };
    const downloadsDirectory = await temporaryDownloadDirectory();
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      resolveDownloadsDirectory: () => downloadsDirectory,
      http,
      openPath: vi.fn(async () => ''),
    });

    await service.check();
    const pending = service.download();
    await service.cancelDownload();
    expect((await pending).phase).toBe('available');
    expect(await readdir(downloadsDirectory)).toEqual([]);
  });

  it('reports an unavailable Downloads location only when downloading', async () => {
    const { http } = fixture();
    const service = new AppUpdateService({
      currentVersion: '1.0.0',
      resolveDownloadsDirectory: () => {
        throw new Error('Downloads is unavailable');
      },
      http,
      openPath: vi.fn(async () => ''),
    });

    expect((await service.check()).phase).toBe('available');
    const result = await service.download();
    expect(result.phase).toBe('error');
    expect(result.error).toEqual(expect.objectContaining({
      stage: 'download',
      code: 'STORAGE',
    }));
  });
});
