import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import {
  APP_UPDATE_API_URL,
  AppUpdateMetadataError,
  appUpdateReleaseSummary,
  compareAppVersions,
  createInitialAppUpdateSnapshot,
  resolveGitHubLatestRelease,
  type AppUpdateErrorCode,
  type AppUpdateOpenResult,
  type AppUpdateSnapshot,
  type ResolvedAppUpdateRelease,
} from '../../src/shared/app-update';
import { MOBILE_ANDROID_VERSION_CODE, MOBILE_BUILD_INFO } from './build-info';

const CHECK_TIMEOUT_MS = 15_000;
const CHECK_CACHE_MS = 30_000;
const UPDATE_LOCATION_LABEL = 'Downloads/EZTerminal';

export interface MobileUpdateDownloadOptions {
  readonly url: string;
  readonly name: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly versionName: string;
  readonly versionCode: number;
}

export interface MobileUpdateDownloadResult {
  readonly name: string;
  readonly uri: string;
}

export interface MobileAppUpdateNativePlugin {
  downloadUpdate(options: MobileUpdateDownloadOptions): Promise<MobileUpdateDownloadResult>;
  cancelUpdateDownload(): Promise<void>;
  openDownloadedUpdate(options: {
    readonly uri: string;
  }): Promise<{ readonly status: 'opened' | 'permission-required' }>;
  addListener(
    eventName: 'updateDownloadProgress',
    listener: (progress: { readonly receivedBytes: number; readonly totalBytes: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const nativeUpdatePlugin = registerPlugin<MobileAppUpdateNativePlugin>('EZTerminalUpdate');

type SnapshotListener = (snapshot: AppUpdateSnapshot) => void;

function nativeErrorCode(error: unknown): AppUpdateErrorCode {
  const candidate = typeof error === 'object' && error !== null
    ? error as { code?: unknown }
    : null;
  switch (candidate?.code) {
    case 'INTEGRITY_MISMATCH':
      return 'INTEGRITY_MISMATCH';
    case 'PACKAGE_MISMATCH':
      return 'PACKAGE_MISMATCH';
    case 'SIGNER_MISMATCH':
      return 'SIGNER_MISMATCH';
    case 'INVALID_RELEASE':
    case 'INVALID_URL':
    case 'INVALID_SIZE':
      return 'INVALID_RELEASE';
    case 'STORAGE':
    case 'DOWNLOAD_SAVE_FAILED':
      return 'STORAGE';
    case 'HTTP':
      return 'HTTP';
    case 'DOWNLOAD_BUSY':
      return 'UNAVAILABLE';
    case 'OPEN_FAILED':
      return 'OPEN_FAILED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    default:
      return 'NETWORK';
  }
}

export interface MobileAppUpdateServiceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly nativePlugin?: MobileAppUpdateNativePlugin;
  readonly currentVersion?: string;
  readonly currentVersionCode?: number;
  readonly now?: () => number;
}

export class MobileAppUpdateService {
  private snapshot: AppUpdateSnapshot;
  private resolvedRelease: ResolvedAppUpdateRelease | null = null;
  private downloadedUri: string | null = null;
  private checkPromise: Promise<AppUpdateSnapshot> | null = null;
  private downloadPromise: Promise<AppUpdateSnapshot> | null = null;
  private checkController: AbortController | null = null;
  private downloadCancelled = false;
  private lastCheckCompletedAt = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly nativePlugin: MobileAppUpdateNativePlugin;
  private readonly currentVersionCode: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(options: MobileAppUpdateServiceOptions = {}) {
    const currentVersion = options.currentVersion ?? MOBILE_BUILD_INFO.appVersion;
    this.snapshot = createInitialAppUpdateSnapshot(currentVersion);
    this.currentVersionCode = options.currentVersionCode ?? MOBILE_ANDROID_VERSION_CODE;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.nativePlugin = options.nativePlugin ?? nativeUpdatePlugin;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): AppUpdateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private publish(snapshot: AppUpdateSnapshot): AppUpdateSnapshot {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  private error(
    stage: 'check' | 'download' | 'verify' | 'open' | 'permission',
    code: AppUpdateErrorCode,
    retryable = true,
  ): AppUpdateSnapshot {
    return this.publish({
      ...this.snapshot,
      phase: 'error',
      progress: undefined,
      error: { stage, code, retryable },
    });
  }

  check(): Promise<AppUpdateSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise) return Promise.resolve(this.snapshot);
    if (
      this.snapshot.phase !== 'error'
      && this.now() - this.lastCheckCompletedAt < CHECK_CACHE_MS
    ) return Promise.resolve(this.snapshot);

    const controller = new AbortController();
    this.checkController = controller;
    this.publish({
      ...this.snapshot,
      phase: 'checking',
      progress: undefined,
      error: undefined,
    });
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const pending = this.performCheck(controller.signal)
      .catch((error: unknown) => {
        if (this.disposed) return this.snapshot;
        if (error instanceof AppUpdateMetadataError) {
          return this.error('check', error.code);
        }
        if (controller.signal.aborted) return this.error('check', 'TIMEOUT');
        return this.error('check', 'NETWORK');
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.checkController === controller) this.checkController = null;
        if (this.checkPromise === pending) this.checkPromise = null;
      });
    this.checkPromise = pending;
    return pending;
  }

  private async performCheck(signal: AbortSignal): Promise<AppUpdateSnapshot> {
    const response = await this.fetchImpl(APP_UPDATE_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      const rateLimited = response.status === 403
        && response.headers.get('x-ratelimit-remaining') === '0';
      return this.error('check', rateLimited ? 'RATE_LIMITED' : 'HTTP');
    }
    const resolved = resolveGitHubLatestRelease(await response.json() as unknown, 'android');
    const comparison = compareAppVersions(resolved.version, this.snapshot.currentVersion);
    if (
      comparison === null
      || (comparison > 0 && (resolved.androidVersionCode ?? 0) <= this.currentVersionCode)
    ) {
      throw new AppUpdateMetadataError('INVALID_RELEASE');
    }
    const checkedAt = this.now();
    this.lastCheckCompletedAt = checkedAt;
    if (comparison <= 0) {
      this.resolvedRelease = null;
      this.downloadedUri = null;
      return this.publish({
        phase: 'current',
        currentVersion: this.snapshot.currentVersion,
        checkedAt,
        release: appUpdateReleaseSummary(resolved),
      });
    }
    this.resolvedRelease = resolved;
    return this.publish({
      phase: 'available',
      currentVersion: this.snapshot.currentVersion,
      checkedAt,
      release: appUpdateReleaseSummary(resolved),
    });
  }

  download(): Promise<AppUpdateSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.downloadPromise) return this.downloadPromise;
    const release = this.resolvedRelease;
    if (!release || release.androidVersionCode === undefined) {
      return Promise.resolve(this.error('download', 'UNAVAILABLE'));
    }
    this.downloadCancelled = false;
    this.publish({
      ...this.snapshot,
      phase: 'downloading',
      progress: {
        receivedBytes: 0,
        totalBytes: release.asset.sizeBytes,
        percent: 0,
      },
      download: undefined,
      error: undefined,
    });
    const pending = this.performDownload(release)
      .catch((error: unknown) => {
        if (this.downloadCancelled || (
          typeof error === 'object'
          && error !== null
          && (error as { code?: unknown }).code === 'CANCELLED'
        )) {
          return this.publish({
            ...this.snapshot,
            phase: 'available',
            progress: undefined,
            download: undefined,
            error: undefined,
          });
        }
        const code = nativeErrorCode(error);
        const stage = code === 'INTEGRITY_MISMATCH'
          || code === 'PACKAGE_MISMATCH'
          || code === 'SIGNER_MISMATCH'
          || code === 'INVALID_RELEASE'
          ? 'verify'
          : 'download';
        return this.error(stage, code, code !== 'SIGNER_MISMATCH');
      })
      .finally(() => {
        if (this.downloadPromise === pending) this.downloadPromise = null;
      });
    this.downloadPromise = pending;
    return pending;
  }

  private async performDownload(release: ResolvedAppUpdateRelease): Promise<AppUpdateSnapshot> {
    const progressHandle = await this.nativePlugin.addListener(
      'updateDownloadProgress',
      ({ receivedBytes, totalBytes }) => {
        if (this.snapshot.phase !== 'downloading') return;
        this.publish({
          ...this.snapshot,
          progress: {
            receivedBytes,
            totalBytes,
            percent: Math.min(100, Math.round((receivedBytes / totalBytes) * 100)),
          },
        });
      },
    );
    try {
      const downloaded = await this.nativePlugin.downloadUpdate({
        url: release.asset.downloadUrl,
        name: release.asset.name,
        expectedBytes: release.asset.sizeBytes,
        expectedSha256: release.asset.sha256,
        versionName: release.version,
        versionCode: release.androidVersionCode!,
      });
      this.downloadedUri = downloaded.uri;
      return this.publish({
        ...this.snapshot,
        phase: 'downloaded',
        progress: undefined,
        download: {
          name: downloaded.name,
          locationLabel: UPDATE_LOCATION_LABEL,
          requiresUnsignedConfirmation: false,
        },
        error: undefined,
      });
    } finally {
      await progressHandle.remove();
    }
  }

  async cancelDownload(): Promise<void> {
    if (!this.downloadPromise) return;
    this.downloadCancelled = true;
    await this.nativePlugin.cancelUpdateDownload().catch(() => undefined);
    await this.downloadPromise;
  }

  async openDownloaded(): Promise<AppUpdateOpenResult> {
    if (!this.downloadedUri || !this.snapshot.download) {
      this.error('open', 'UNAVAILABLE');
      return { ok: false, reason: 'unavailable' };
    }
    try {
      const result = await this.nativePlugin.openDownloadedUpdate({ uri: this.downloadedUri });
      if (result.status === 'permission-required') {
        this.error('permission', 'INSTALL_PERMISSION_REQUIRED');
        return { ok: false, reason: 'failed' };
      }
      this.publish({
        ...this.snapshot,
        phase: 'downloaded',
        error: undefined,
      });
      return { ok: true };
    } catch (error) {
      this.error('open', nativeErrorCode(error));
      return { ok: false, reason: 'failed' };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.checkController?.abort();
    this.downloadCancelled = true;
    if (this.downloadPromise) {
      await this.nativePlugin.cancelUpdateDownload().catch(() => undefined);
    }
    await Promise.allSettled([
      this.checkPromise ?? Promise.resolve(),
      this.downloadPromise ?? Promise.resolve(),
    ]);
    this.listeners.clear();
  }
}
