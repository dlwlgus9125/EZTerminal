import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  APP_UPDATE_API_URL,
  APP_UPDATE_MANIFEST_MAX_BYTES,
  APP_UPDATE_WINDOWS_MAX_BYTES,
  AppUpdateMetadataError,
  appUpdateReleaseSummary,
  compareAppVersions,
  createInitialAppUpdateSnapshot,
  parseWindowsReleaseManifest,
  resolveGitHubLatestRelease,
  type AppUpdateError,
  type AppUpdateErrorCode,
  type AppUpdateOpenResult,
  type AppUpdateSnapshot,
  type ResolvedAppUpdateRelease,
  type WindowsAuthenticodeRequirement,
} from '../shared/app-update';
import {
  UpdateHttpError,
  type UpdateHttpClient,
  type UpdateHttpResult,
} from './app-update-network';
import {
  verifyWindowsAuthenticode,
  type WindowsAuthenticodeVerification,
} from './windows-authenticode';

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const CHECK_CACHE_MS = 30_000;
const PROGRESS_EMIT_INTERVAL_MS = 100;
const UPDATE_LOCATION_LABEL = 'Downloads/EZTerminal';

export interface AppUpdateServiceOptions {
  readonly currentVersion: string;
  readonly resolveDownloadsDirectory: () => string;
  readonly http: UpdateHttpClient;
  readonly openPath: (filePath: string) => Promise<string>;
  readonly verifyWindowsAuthenticode?: (
    filePath: string,
  ) => Promise<WindowsAuthenticodeVerification>;
  readonly now?: () => number;
}

type SnapshotListener = (snapshot: AppUpdateSnapshot) => void;

class AppUpdateServiceError extends Error {
  constructor(readonly code: Extract<
    AppUpdateErrorCode,
    'HTTP' | 'INTEGRITY_MISMATCH' | 'SIGNATURE_INVALID' | 'STORAGE'
  >) {
    super(code);
    this.name = 'AppUpdateServiceError';
  }
}

function headerValue(
  headers: Readonly<Record<string, string | readonly string[]>>,
  key: string,
): string | undefined {
  const value = headers[key];
  return typeof value === 'string' ? value : value?.[0];
}

function errorCodeOf(error: unknown): AppUpdateErrorCode {
  if (error instanceof AppUpdateServiceError) return error.code;
  if (error instanceof AppUpdateMetadataError) return error.code;
  if (error instanceof UpdateHttpError) {
    if (error.code === 'TIMEOUT') return 'TIMEOUT';
    if (error.code === 'TOO_LARGE' || error.code === 'INVALID_REDIRECT') return 'INVALID_RELEASE';
    return 'NETWORK';
  }
  return 'NETWORK';
}

async function hashFile(filePath: string): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += bytes.length;
      hash.update(bytes);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function removeFileQuietly(filePath: string | null): Promise<void> {
  if (!filePath) return;
  await rm(filePath, { force: true }).catch(() => undefined);
}

function waitForWriteStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('close', resolve);
    stream.once('error', reject);
  });
}

function waitForStreamClose(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => stream.once('close', resolve));
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new AppUpdateMetadataError('INVALID_RELEASE');
  }
}

export class AppUpdateService {
  private snapshot: AppUpdateSnapshot;
  private resolvedRelease: ResolvedAppUpdateRelease | null = null;
  private windowsAuthenticodeRequirement: WindowsAuthenticodeRequirement | null = null;
  private downloadedPath: string | null = null;
  private partialPath: string | null = null;
  private checkPromise: Promise<AppUpdateSnapshot> | null = null;
  private downloadPromise: Promise<AppUpdateSnapshot> | null = null;
  private checkController: AbortController | null = null;
  private downloadController: AbortController | null = null;
  private downloadCancelled = false;
  private lastCheckCompletedAt = Number.NEGATIVE_INFINITY;
  private disposed = false;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly now: () => number;
  private readonly verifyAuthenticode: (
    filePath: string,
  ) => Promise<WindowsAuthenticodeVerification>;

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.snapshot = createInitialAppUpdateSnapshot(options.currentVersion);
    this.now = options.now ?? Date.now;
    this.verifyAuthenticode = options.verifyWindowsAuthenticode ?? verifyWindowsAuthenticode;
  }

  getSnapshot(): AppUpdateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(snapshot: AppUpdateSnapshot): AppUpdateSnapshot {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer push failure must not destabilize the update state machine.
      }
    }
    return snapshot;
  }

  private publishError(
    stage: AppUpdateError['stage'],
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

  private async assertExpectedAuthenticode(filePath: string): Promise<void> {
    const expected = this.windowsAuthenticodeRequirement;
    if (!expected || expected.status !== 'Valid') return;
    let actual: WindowsAuthenticodeVerification;
    try {
      actual = await this.verifyAuthenticode(filePath);
    } catch {
      throw new AppUpdateServiceError('SIGNATURE_INVALID');
    }
    if (
      actual.status !== 'Valid'
      || actual.publisher !== expected.publisher
      || (expected.timestampRequired && !actual.timestamped)
      || actual.signerCertificateSha256 !== expected.signerCertificateSha256
      || actual.timestampCertificateSha256 !== expected.timestampCertificateSha256
    ) throw new AppUpdateServiceError('SIGNATURE_INVALID');
  }

  private async readBuffer(
    url: string,
    maximumBytes: number,
    controller: AbortController,
  ): Promise<{ readonly result: UpdateHttpResult; readonly body: Buffer }> {
    const chunks: Buffer[] = [];
    const result = await this.options.http.get(url, {
      signal: controller.signal,
      maximumBytes,
      idleTimeoutMs: CHECK_TIMEOUT_MS,
      onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
    });
    return { result, body: Buffer.concat(chunks) };
  }

  check(): Promise<AppUpdateSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise) return Promise.resolve(this.snapshot);
    if (
      this.snapshot.phase !== 'error'
      && this.now() - this.lastCheckCompletedAt < CHECK_CACHE_MS
    ) {
      return Promise.resolve(this.snapshot);
    }

    const controller = new AbortController();
    this.checkController = controller;
    this.publish({
      ...this.snapshot,
      phase: 'checking',
      progress: undefined,
      error: undefined,
    });
    const pending = this.performCheck(controller)
      .catch((error: unknown) => {
        if (this.disposed || (error instanceof UpdateHttpError && error.code === 'ABORTED')) {
          return this.snapshot;
        }
        return this.publishError('check', errorCodeOf(error));
      })
      .finally(() => {
        if (this.checkController === controller) this.checkController = null;
        if (this.checkPromise === pending) this.checkPromise = null;
      });
    this.checkPromise = pending;
    return pending;
  }

  private async performCheck(controller: AbortController): Promise<AppUpdateSnapshot> {
    const latestResponse = await this.readBuffer(APP_UPDATE_API_URL, APP_UPDATE_MANIFEST_MAX_BYTES, controller);
    if (latestResponse.result.statusCode !== 200) {
      const rateLimited = latestResponse.result.statusCode === 403
        && headerValue(latestResponse.result.headers, 'x-ratelimit-remaining') === '0';
      return this.publishError('check', rateLimited ? 'RATE_LIMITED' : 'HTTP');
    }
    const resolved = resolveGitHubLatestRelease(parseJson(latestResponse.body), 'windows');
    const comparison = compareAppVersions(resolved.version, this.options.currentVersion);
    if (comparison === null) throw new AppUpdateMetadataError('INVALID_RELEASE');

    const checkedAt = this.now();
    this.lastCheckCompletedAt = checkedAt;
    if (comparison <= 0) {
      this.resolvedRelease = null;
      this.windowsAuthenticodeRequirement = null;
      this.downloadedPath = null;
      return this.publish({
        phase: 'current',
        currentVersion: this.options.currentVersion,
        checkedAt,
        release: appUpdateReleaseSummary(resolved),
      });
    }

    if (!resolved.manifest) throw new AppUpdateMetadataError('INVALID_RELEASE');
    const manifestResponse = await this.readBuffer(
      resolved.manifest.downloadUrl,
      APP_UPDATE_MANIFEST_MAX_BYTES,
      controller,
    );
    if (manifestResponse.result.statusCode !== 200) return this.publishError('check', 'HTTP');
    const manifestSha256 = createHash('sha256').update(manifestResponse.body).digest('hex');
    if (
      manifestResponse.body.length !== resolved.manifest.sizeBytes
      || manifestSha256 !== resolved.manifest.sha256
    ) {
      return this.publishError('verify', 'INTEGRITY_MISMATCH', false);
    }
    const authenticode = parseWindowsReleaseManifest(parseJson(manifestResponse.body), resolved);
    this.resolvedRelease = resolved;
    this.windowsAuthenticodeRequirement = authenticode;
    return this.publish({
      phase: 'available',
      currentVersion: this.options.currentVersion,
      checkedAt,
      release: appUpdateReleaseSummary(resolved, authenticode.status),
    });
  }

  download(): Promise<AppUpdateSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.downloadPromise) return this.downloadPromise;
    const release = this.resolvedRelease;
    if (!release || compareAppVersions(release.version, this.options.currentVersion) !== 1) {
      return Promise.resolve(this.publishError('download', 'UNAVAILABLE'));
    }

    const controller = new AbortController();
    this.downloadController = controller;
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
    const pending = this.performDownload(release, controller)
      .catch((error: unknown) => {
        if (this.downloadCancelled || (error instanceof UpdateHttpError && error.code === 'ABORTED')) {
          return this.publish({
            ...this.snapshot,
            phase: 'available',
            progress: undefined,
            download: undefined,
            error: undefined,
          });
        }
        const code = errorCodeOf(error);
        return this.publishError(
          code === 'INVALID_RELEASE'
            || code === 'INTEGRITY_MISMATCH'
            || code === 'SIGNATURE_INVALID'
            ? 'verify'
            : 'download',
          code === 'NETWORK' && !(error instanceof UpdateHttpError) ? 'STORAGE' : code,
          code !== 'INTEGRITY_MISMATCH' && code !== 'SIGNATURE_INVALID',
        );
      })
      .finally(() => {
        if (this.downloadController === controller) this.downloadController = null;
        if (this.downloadPromise === pending) this.downloadPromise = null;
      });
    this.downloadPromise = pending;
    return pending;
  }

  private async verifiedExistingPath(
    release: ResolvedAppUpdateRelease,
    downloadsDirectory: string,
  ): Promise<string | null> {
    const basePath = path.join(
      downloadsDirectory,
      `EZTerminal-Setup-${release.version}.exe`,
    );
    try {
      const existing = await hashFile(basePath);
      if (
        existing.sizeBytes === release.asset.sizeBytes
        && existing.sha256 === release.asset.sha256
      ) {
        try {
          await this.assertExpectedAuthenticode(basePath);
          return basePath;
        } catch (error) {
          await removeFileQuietly(basePath);
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof AppUpdateServiceError) throw error;
      // A missing or unreadable candidate is handled by selecting a free name.
    }
    return null;
  }

  private async allocateDownloadPath(
    release: ResolvedAppUpdateRelease,
    downloadsDirectory: string,
  ): Promise<string> {
    const baseName = `EZTerminal-Setup-${release.version}.exe`;
    for (let collisionIndex = 0; collisionIndex < 1_000; collisionIndex += 1) {
      const name = collisionIndex === 0
        ? baseName
        : `EZTerminal-Setup-${release.version} (${collisionIndex}).exe`;
      const candidate = path.join(downloadsDirectory, name);
      try {
        await stat(candidate);
      } catch {
        return candidate;
      }
    }
    throw new Error('Unable to allocate an update download path');
  }

  private async performDownload(
    release: ResolvedAppUpdateRelease,
    controller: AbortController,
  ): Promise<AppUpdateSnapshot> {
    const downloadsDirectory = this.options.resolveDownloadsDirectory();
    await mkdir(downloadsDirectory, { recursive: true });
    const existingPath = await this.verifiedExistingPath(release, downloadsDirectory);
    if (existingPath) return this.publishDownloaded(existingPath);

    const targetPath = await this.allocateDownloadPath(release, downloadsDirectory);
    const partialPath = `${targetPath}.${randomUUID()}.part`;
    this.partialPath = partialPath;
    const writeStream = createWriteStream(partialPath, { flags: 'wx' });
    const writeFinished = waitForWriteStream(writeStream);
    const hash = createHash('sha256');
    let receivedBytes = 0;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    let streamFailure: unknown = null;
    writeStream.once('error', (error) => {
      streamFailure = error;
      controller.abort();
    });

    try {
      const result = await this.options.http.get(release.asset.downloadUrl, {
        signal: controller.signal,
        maximumBytes: APP_UPDATE_WINDOWS_MAX_BYTES,
        idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
        onChunk: (chunk) => {
          receivedBytes += chunk.length;
          hash.update(chunk);
          writeStream.write(chunk);
          const now = this.now();
          if (
            now - lastProgressAt >= PROGRESS_EMIT_INTERVAL_MS
            || receivedBytes === release.asset.sizeBytes
          ) {
            lastProgressAt = now;
            this.publish({
              ...this.snapshot,
              phase: 'downloading',
              progress: {
                receivedBytes,
                totalBytes: release.asset.sizeBytes,
                percent: Math.min(100, Math.round((receivedBytes / release.asset.sizeBytes) * 100)),
              },
              error: undefined,
            });
          }
        },
      });
      if (streamFailure) throw streamFailure;
      writeStream.end();
      await writeFinished;
      if (result.statusCode !== 200) throw new AppUpdateServiceError('HTTP');
      const declaredLength = headerValue(result.headers, 'content-length');
      if (
        receivedBytes !== release.asset.sizeBytes
        || result.receivedBytes !== receivedBytes
        || (declaredLength !== undefined && Number(declaredLength) !== release.asset.sizeBytes)
        || hash.digest('hex') !== release.asset.sha256
      ) {
        throw new AppUpdateMetadataError('INVALID_RELEASE');
      }
      await rename(partialPath, targetPath);
      this.partialPath = null;
      try {
        await this.assertExpectedAuthenticode(targetPath);
      } catch (error) {
        await removeFileQuietly(targetPath);
        throw error;
      }
      return this.publishDownloaded(targetPath);
    } catch (error) {
      if (!writeStream.destroyed) writeStream.destroy();
      await waitForStreamClose(writeStream);
      await writeFinished.catch(() => undefined);
      await removeFileQuietly(partialPath);
      this.partialPath = null;
      if (error instanceof AppUpdateMetadataError) {
        throw new AppUpdateServiceError('INTEGRITY_MISMATCH');
      }
      throw error;
    }
  }

  private publishDownloaded(downloadedPath: string): AppUpdateSnapshot {
    this.downloadedPath = downloadedPath;
    return this.publish({
      ...this.snapshot,
      phase: 'downloaded',
      progress: undefined,
      download: {
        name: path.basename(downloadedPath),
        locationLabel: UPDATE_LOCATION_LABEL,
        requiresUnsignedConfirmation:
          this.snapshot.release?.windowsAuthenticode !== 'Valid',
      },
      error: undefined,
    });
  }

  async cancelDownload(): Promise<void> {
    if (!this.downloadPromise) return;
    this.downloadCancelled = true;
    this.downloadController?.abort();
    await this.downloadPromise;
  }

  async openDownloadedUpdate(acknowledgeUnsigned: boolean): Promise<AppUpdateOpenResult> {
    const release = this.resolvedRelease;
    const downloadedPath = this.downloadedPath;
    if (!release || !downloadedPath || !this.snapshot.download) {
      this.publishError('open', 'UNAVAILABLE');
      return { ok: false, reason: 'unavailable' };
    }
    if (this.snapshot.download.requiresUnsignedConfirmation && !acknowledgeUnsigned) {
      return { ok: false, reason: 'unsigned-confirmation-required' };
    }
    try {
      const verified = await hashFile(downloadedPath);
      if (
        verified.sizeBytes !== release.asset.sizeBytes
        || verified.sha256 !== release.asset.sha256
      ) {
        await removeFileQuietly(downloadedPath);
        this.downloadedPath = null;
        this.publishError('verify', 'INTEGRITY_MISMATCH', false);
        return { ok: false, reason: 'failed' };
      }
      try {
        await this.assertExpectedAuthenticode(downloadedPath);
      } catch {
        await removeFileQuietly(downloadedPath);
        this.downloadedPath = null;
        this.publishError('verify', 'SIGNATURE_INVALID', false);
        return { ok: false, reason: 'failed' };
      }
      const error = await this.options.openPath(downloadedPath);
      if (error) {
        this.publishError('open', 'OPEN_FAILED');
        return { ok: false, reason: 'failed' };
      }
      this.publish({
        ...this.snapshot,
        phase: 'downloaded',
        error: undefined,
      });
      return { ok: true };
    } catch {
      this.publishError('open', 'OPEN_FAILED');
      return { ok: false, reason: 'failed' };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.checkController?.abort();
    this.downloadCancelled = true;
    this.downloadController?.abort();
    await Promise.allSettled([
      this.checkPromise ?? Promise.resolve(),
      this.downloadPromise ?? Promise.resolve(),
    ]);
    await removeFileQuietly(this.partialPath);
    this.partialPath = null;
    this.listeners.clear();
  }
}
