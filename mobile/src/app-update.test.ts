import { describe, expect, it, vi } from 'vitest';

import type { MobileAppUpdateNativePlugin } from './app-update';
import { MobileAppUpdateService } from './app-update';

const SHA256 = 'b'.repeat(64);

function latestRelease(version = '1.2.3', versionCode = 44): Record<string, unknown> {
  const name = `EZTerminal-Android-${version}-vc${versionCode}.apk`;
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    published_at: '2026-07-30T00:00:00Z',
    html_url: `https://github.com/dlwlgus9125/EZTerminal/releases/tag/v${version}`,
    assets: [{
      name,
      size: 8_000_000,
      digest: `sha256:${SHA256}`,
      browser_download_url:
        `https://github.com/dlwlgus9125/EZTerminal/releases/download/v${version}/${name}`,
    }],
  };
}

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function nativePlugin(
  overrides: Partial<MobileAppUpdateNativePlugin> = {},
): MobileAppUpdateNativePlugin {
  return {
    downloadUpdate: vi.fn(async () => ({
      name: 'EZTerminal-Android-1.2.3-vc44.apk',
      uri: 'content://downloads/44',
    })),
    cancelUpdateDownload: vi.fn(async () => undefined),
    openDownloadedUpdate: vi.fn(async () => ({ status: 'opened' as const })),
    addListener: vi.fn(async () => ({
      remove: vi.fn(async () => undefined),
    })),
    ...overrides,
  };
}

describe('MobileAppUpdateService', () => {
  it('reports a stable newer GitHub Release and coalesces concurrent checks', async () => {
    const fetchMock = vi.fn(async () => response(latestRelease()));
    const service = new MobileAppUpdateService({
      fetch: fetchMock as typeof fetch,
      nativePlugin: nativePlugin(),
      currentVersion: '1.0.0',
      currentVersionCode: 1,
      now: () => 100_000,
    });

    const [first, second] = await Promise.all([service.check(), service.check()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.phase).toBe('available');
    expect(second.release?.version).toBe('1.2.3');
  });

  it('rejects a semantic update whose Android version code does not increase', async () => {
    const service = new MobileAppUpdateService({
      fetch: vi.fn(async () => response(latestRelease('1.2.3', 44))) as typeof fetch,
      nativePlugin: nativePlugin(),
      currentVersion: '1.0.0',
      currentVersionCode: 44,
    });
    expect((await service.check()).error?.code).toBe('INVALID_RELEASE');
  });

  it('surfaces GitHub rate limiting separately', async () => {
    const service = new MobileAppUpdateService({
      fetch: vi.fn(async () => response({}, 403, {
        'x-ratelimit-remaining': '0',
      })) as typeof fetch,
      nativePlugin: nativePlugin(),
      currentVersion: '1.0.0',
      currentVersionCode: 1,
    });
    expect((await service.check()).error?.code).toBe('RATE_LIMITED');
  });

  it('downloads through the native plugin and handles install permission', async () => {
    let progressListener:
      | ((progress: { readonly receivedBytes: number; readonly totalBytes: number }) => void)
      | undefined;
    const plugin = nativePlugin({
      addListener: vi.fn(async (_eventName, listener) => {
        progressListener = listener;
        return { remove: vi.fn(async () => undefined) };
      }),
      downloadUpdate: vi.fn(async (options) => {
        progressListener?.({
          receivedBytes: options.expectedBytes,
          totalBytes: options.expectedBytes,
        });
        return { name: options.name, uri: 'content://downloads/44' };
      }),
      openDownloadedUpdate: vi.fn(async () => ({ status: 'permission-required' as const })),
    });
    const service = new MobileAppUpdateService({
      fetch: vi.fn(async () => response(latestRelease())) as typeof fetch,
      nativePlugin: plugin,
      currentVersion: '1.0.0',
      currentVersionCode: 1,
    });

    await service.check();
    const downloaded = await service.download();
    expect(downloaded.phase).toBe('downloaded');
    expect(downloaded.download?.locationLabel).toBe('Downloads/EZTerminal');
    expect(plugin.downloadUpdate).toHaveBeenCalledWith(expect.objectContaining({
      expectedSha256: SHA256,
      versionCode: 44,
    }));

    await service.openDownloaded();
    expect(service.getSnapshot().error?.code).toBe('INSTALL_PERMISSION_REQUIRED');
    expect(service.getSnapshot().download?.name).toContain('1.2.3');
  });
});
