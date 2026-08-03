export const APP_UPDATE_OWNER = 'dlwlgus9125' as const;
export const APP_UPDATE_REPOSITORY = 'EZTerminal' as const;
export const APP_UPDATE_API_URL =
  `https://api.github.com/repos/${APP_UPDATE_OWNER}/${APP_UPDATE_REPOSITORY}/releases/latest` as const;

export const APP_UPDATE_WINDOWS_MAX_BYTES = 512 * 1_048_576;
export const APP_UPDATE_ANDROID_MAX_BYTES = 100 * 1_048_576;
export const APP_UPDATE_MANIFEST_MAX_BYTES = 1_048_576;
export const APP_UPDATE_WINDOWS_PUBLISHER = 'SignPath Foundation' as const;

export type AppUpdatePlatform = 'windows' | 'android';
export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';
export type AppUpdateErrorStage = 'check' | 'download' | 'verify' | 'open' | 'permission';
export type AppUpdateErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'HTTP'
  | 'INVALID_RELEASE'
  | 'NO_COMPATIBLE_ASSET'
  | 'STORAGE'
  | 'INTEGRITY_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'PACKAGE_MISMATCH'
  | 'SIGNER_MISMATCH'
  | 'OPEN_FAILED'
  | 'INSTALL_PERMISSION_REQUIRED'
  | 'UNAVAILABLE';

export interface AppUpdateError {
  readonly stage: AppUpdateErrorStage;
  readonly code: AppUpdateErrorCode;
  readonly retryable: boolean;
}

export interface AppUpdateReleaseSummary {
  readonly version: string;
  readonly publishedAt: string;
  readonly sizeBytes: number;
  readonly assetName: string;
  readonly androidVersionCode?: number;
  readonly windowsAuthenticode?: WindowsAuthenticodeStatus;
}

export interface AppUpdateProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export interface AppUpdateDownloadInfo {
  readonly name: string;
  /** A user-facing location such as `Downloads/EZTerminal`, never an absolute path. */
  readonly locationLabel: string;
  readonly requiresUnsignedConfirmation: boolean;
}

export interface AppUpdateSnapshot {
  readonly phase: AppUpdatePhase;
  readonly currentVersion: string;
  readonly checkedAt: number | null;
  readonly release?: AppUpdateReleaseSummary;
  readonly progress?: AppUpdateProgress;
  readonly download?: AppUpdateDownloadInfo;
  readonly error?: AppUpdateError;
}

export type AppUpdateOpenResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason: 'unsigned-confirmation-required' | 'unavailable' | 'failed';
  };

export interface ResolvedAppUpdateAsset {
  readonly name: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
  readonly sha256: string;
}

export interface ResolvedAppUpdateRelease {
  readonly version: string;
  readonly publishedAt: string;
  readonly htmlUrl: string;
  readonly asset: ResolvedAppUpdateAsset;
  readonly manifest?: ResolvedAppUpdateAsset;
  readonly androidVersionCode?: number;
}

export type WindowsAuthenticodeStatus = 'Valid' | 'NotSigned';

export interface WindowsAuthenticodeRequirement {
  readonly status: WindowsAuthenticodeStatus;
  readonly publisher: string | null;
  readonly timestampRequired: boolean;
  readonly signerCertificateSha256: string | null;
  readonly timestampCertificateSha256: string | null;
}

export class AppUpdateMetadataError extends Error {
  constructor(readonly code: Extract<AppUpdateErrorCode, 'INVALID_RELEASE' | 'NO_COMPATIBLE_ASSET'>) {
    super(code);
    this.name = 'AppUpdateMetadataError';
  }
}

function metadataError(
  code: Extract<AppUpdateErrorCode, 'INVALID_RELEASE' | 'NO_COMPATIBLE_ASSET'> = 'INVALID_RELEASE',
): never {
  throw new AppUpdateMetadataError(code);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseVersionParts(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  return parts as unknown as readonly [number, number, number];
}

export function compareAppVersions(left: string, right: string): number | null {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function isAppUpdateAvailable(snapshot: AppUpdateSnapshot): boolean {
  return Boolean(
    snapshot.release
    && compareAppVersions(snapshot.release.version, snapshot.currentVersion) === 1,
  );
}

export function createInitialAppUpdateSnapshot(currentVersion: string): AppUpdateSnapshot {
  return {
    phase: 'idle',
    currentVersion,
    checkedAt: null,
  };
}

function parseDigest(value: unknown): string {
  if (typeof value !== 'string') metadataError();
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value);
  if (!match) metadataError();
  return match[1].toLowerCase();
}

function expectedReleasePath(version: string, assetName: string): string {
  return `/${APP_UPDATE_OWNER}/${APP_UPDATE_REPOSITORY}/releases/download/v${version}/${assetName}`;
}

export function isAllowedGitHubReleaseAssetUrl(
  rawUrl: string,
  version: string,
  assetName: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.port !== ''
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) return false;
    return decodeURIComponent(url.pathname) === expectedReleasePath(version, assetName);
  } catch {
    return false;
  }
}

function parseAsset(
  value: unknown,
  version: string,
  maximumBytes: number,
): ResolvedAppUpdateAsset {
  const asset = recordOf(value);
  if (!asset) metadataError();
  const name = asset.name;
  const sizeBytes = asset.size;
  const downloadUrl = asset.browser_download_url;
  if (
    typeof name !== 'string'
    || name.length === 0
    || typeof sizeBytes !== 'number'
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
    || sizeBytes > maximumBytes
    || typeof downloadUrl !== 'string'
    || !isAllowedGitHubReleaseAssetUrl(downloadUrl, version, name)
  ) metadataError();
  return {
    name,
    sizeBytes,
    downloadUrl,
    sha256: parseDigest(asset.digest),
  };
}

function selectUniqueAsset(
  assets: readonly unknown[],
  predicate: (name: string) => boolean,
  version: string,
  maximumBytes: number,
): ResolvedAppUpdateAsset {
  const matches = assets.filter((value) => {
    const asset = recordOf(value);
    return asset !== null && typeof asset.name === 'string' && predicate(asset.name);
  });
  if (matches.length !== 1) metadataError('NO_COMPATIBLE_ASSET');
  return parseAsset(matches[0], version, maximumBytes);
}

export function resolveGitHubLatestRelease(
  payload: unknown,
  platform: AppUpdatePlatform,
): ResolvedAppUpdateRelease {
  const release = recordOf(payload);
  if (!release || release.draft !== false || release.prerelease !== false) metadataError();
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) metadataError();
  const version = release.tag_name.slice(1);
  if (!parseVersionParts(version)) metadataError();
  const publishedAt = release.published_at;
  if (
    typeof publishedAt !== 'string'
    || !Number.isFinite(Date.parse(publishedAt))
    || typeof release.html_url !== 'string'
    || release.html_url !== `https://github.com/${APP_UPDATE_OWNER}/${APP_UPDATE_REPOSITORY}/releases/tag/v${version}`
    || !Array.isArray(release.assets)
  ) metadataError();

  if (platform === 'windows') {
    const asset = selectUniqueAsset(
      release.assets,
      (name) => name === 'EZTerminal-Setup.exe',
      version,
      APP_UPDATE_WINDOWS_MAX_BYTES,
    );
    const manifest = selectUniqueAsset(
      release.assets,
      (name) => name === 'release-manifest.json',
      version,
      APP_UPDATE_MANIFEST_MAX_BYTES,
    );
    return {
      version,
      publishedAt,
      htmlUrl: release.html_url,
      asset,
      manifest,
    };
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assetNamePattern = new RegExp(`^EZTerminal-Android-${escapedVersion}-vc([1-9]\\d*)\\.apk$`);
  const asset = selectUniqueAsset(
    release.assets,
    (name) => assetNamePattern.test(name),
    version,
    APP_UPDATE_ANDROID_MAX_BYTES,
  );
  const versionCodeMatch = assetNamePattern.exec(asset.name);
  const androidVersionCode = Number(versionCodeMatch?.[1]);
  if (!Number.isSafeInteger(androidVersionCode) || androidVersionCode < 1) metadataError();
  return {
    version,
    publishedAt,
    htmlUrl: release.html_url,
    asset,
    androidVersionCode,
  };
}

function validSigningRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value);
}

interface SignedWindowsComponent {
  readonly sha256: string;
  readonly publisher: string;
  readonly signerCertificateSha256: string;
  readonly timestampCertificateSha256: string;
}

function parseSignedWindowsComponent(value: unknown): SignedWindowsComponent {
  const component = recordOf(value);
  if (
    !component
    || component.status !== 'Valid'
    || typeof component.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(component.sha256)
    || typeof component.publisher !== 'string'
    || typeof component.signerCertificateSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(component.signerCertificateSha256)
    || component.timestamped !== true
    || typeof component.timestampCertificateSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(component.timestampCertificateSha256)
  ) metadataError();
  return {
    sha256: component.sha256.toLowerCase(),
    publisher: component.publisher,
    signerCertificateSha256: component.signerCertificateSha256.toLowerCase(),
    timestampCertificateSha256: component.timestampCertificateSha256.toLowerCase(),
  };
}

export function parseWindowsReleaseManifest(
  payload: unknown,
  release: ResolvedAppUpdateRelease,
): WindowsAuthenticodeRequirement {
  const manifest = recordOf(payload);
  const authenticode = recordOf(manifest?.windowsAuthenticode);
  if (
    !manifest
    || manifest.appVersion !== release.version
    || manifest.artifactStage !== 'release'
    || manifest.publicationEligible !== true
    || manifest.evidenceCompleteness !== 'complete'
    || manifest.embeddedBuildShaVerified !== true
    || !Array.isArray(manifest.artifacts)
    || !manifest.artifacts.includes(release.asset.name)
    || !authenticode
    || (authenticode.expected !== 'Valid' && authenticode.expected !== 'NotSigned')
    || authenticode.setup !== authenticode.expected
  ) metadataError();

  if (authenticode.expected === 'NotSigned') {
    if (authenticode.app !== 'NotSigned') metadataError();
    return {
      status: 'NotSigned',
      publisher: null,
      timestampRequired: false,
      signerCertificateSha256: null,
      timestampCertificateSha256: null,
    };
  }

  const signingRequestIds = recordOf(authenticode.signingRequestIds);
  const components = recordOf(authenticode.components);
  if (
    authenticode.publisher !== APP_UPDATE_WINDOWS_PUBLISHER
    || authenticode.timestampRequired !== true
    || authenticode.app !== 'Valid'
    || authenticode.remoteHost !== 'Valid'
    || authenticode.uninstaller !== 'Valid'
    || !signingRequestIds
    || !validSigningRequestId(signingRequestIds.payload)
    || !validSigningRequestId(signingRequestIds.installer)
    || !components
  ) metadataError();

  const app = parseSignedWindowsComponent(components.app);
  const remoteHost = parseSignedWindowsComponent(components.remoteHost);
  const uninstaller = parseSignedWindowsComponent(components.uninstaller);
  const setup = parseSignedWindowsComponent(components.setup);
  if (
    app.publisher !== APP_UPDATE_WINDOWS_PUBLISHER
    || remoteHost.publisher !== APP_UPDATE_WINDOWS_PUBLISHER
    || uninstaller.publisher !== APP_UPDATE_WINDOWS_PUBLISHER
    || setup.publisher !== APP_UPDATE_WINDOWS_PUBLISHER
    || setup.sha256 !== release.asset.sha256
  ) metadataError();
  return {
    status: 'Valid',
    publisher: setup.publisher,
    timestampRequired: true,
    signerCertificateSha256: setup.signerCertificateSha256,
    timestampCertificateSha256: setup.timestampCertificateSha256,
  };
}

export function appUpdateReleaseSummary(
  release: ResolvedAppUpdateRelease,
  windowsAuthenticode?: WindowsAuthenticodeStatus,
): AppUpdateReleaseSummary {
  return {
    version: release.version,
    publishedAt: release.publishedAt,
    sizeBytes: release.asset.sizeBytes,
    assetName: release.asset.name,
    ...(release.androidVersionCode === undefined
      ? {}
      : { androidVersionCode: release.androidVersionCode }),
    ...(windowsAuthenticode === undefined
      ? {}
      : { windowsAuthenticode }),
  };
}
