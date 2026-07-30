import { describe, expect, it } from 'vitest';

import {
  AppUpdateMetadataError,
  appUpdateReleaseSummary,
  compareAppVersions,
  isAllowedGitHubReleaseAssetUrl,
  parseWindowsReleaseManifest,
  resolveGitHubLatestRelease,
} from './app-update';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function asset(name: string, size = 1024): Record<string, unknown> {
  return {
    name,
    size,
    digest: DIGEST,
    browser_download_url:
      `https://github.com/dlwlgus9125/EZTerminal/releases/download/v1.2.3/${name}`,
  };
}

function release(assets: readonly unknown[]): Record<string, unknown> {
  return {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.3',
    published_at: '2026-07-30T00:00:00Z',
    html_url: 'https://github.com/dlwlgus9125/EZTerminal/releases/tag/v1.2.3',
    assets,
  };
}

describe('app update release contract', () => {
  it('compares strict numeric app versions', () => {
    expect(compareAppVersions('1.2.3', '1.2.2')).toBe(1);
    expect(compareAppVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareAppVersions('1.2.3', '2.0.0')).toBe(-1);
    expect(compareAppVersions('1.2', '1.2.0')).toBeNull();
    expect(compareAppVersions('1.2.3-beta.1', '1.2.3')).toBeNull();
  });

  it('selects the Windows setup and verified manifest', () => {
    const resolved = resolveGitHubLatestRelease(release([
      asset('EZTerminal-Setup.exe', 110_000_000),
      asset('release-manifest.json', 20_000),
    ]), 'windows');
    const status = parseWindowsReleaseManifest({
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
    }, resolved);

    expect(resolved.asset.name).toBe('EZTerminal-Setup.exe');
    expect(resolved.asset.sha256).toBe('a'.repeat(64));
    expect(appUpdateReleaseSummary(resolved, status).windowsAuthenticode).toBe('NotSigned');
  });

  it('extracts the Android version code from the exact versioned APK', () => {
    const resolved = resolveGitHubLatestRelease(release([
      asset('EZTerminal-Android-1.2.3-vc44.apk', 8_000_000),
    ]), 'android');
    expect(resolved.androidVersionCode).toBe(44);
    expect(resolved.asset.name).toBe('EZTerminal-Android-1.2.3-vc44.apk');
  });

  it.each([
    { draft: true },
    { prerelease: true },
    { tag_name: 'v1.2.3-beta.1' },
    { html_url: 'https://example.com/release' },
  ])('rejects a non-stable or foreign release: %o', (patch) => {
    expect(() => resolveGitHubLatestRelease({
      ...release([asset('EZTerminal-Android-1.2.3-vc44.apk')]),
      ...patch,
    }, 'android')).toThrow(AppUpdateMetadataError);
  });

  it('rejects missing, duplicate, malformed, or oversized assets', () => {
    expect(() => resolveGitHubLatestRelease(release([]), 'android')).toThrowError(
      expect.objectContaining({ code: 'NO_COMPATIBLE_ASSET' }),
    );
    expect(() => resolveGitHubLatestRelease(release([
      asset('EZTerminal-Android-1.2.3-vc44.apk'),
      asset('EZTerminal-Android-1.2.3-vc45.apk'),
    ]), 'android')).toThrowError(expect.objectContaining({ code: 'NO_COMPATIBLE_ASSET' }));
    expect(() => resolveGitHubLatestRelease(release([{
      ...asset('EZTerminal-Android-1.2.3-vc44.apk'),
      digest: null,
    }]), 'android')).toThrowError(expect.objectContaining({ code: 'INVALID_RELEASE' }));
    expect(() => resolveGitHubLatestRelease(release([
      asset('EZTerminal-Android-1.2.3-vc44.apk', 101 * 1_048_576),
    ]), 'android')).toThrowError(expect.objectContaining({ code: 'INVALID_RELEASE' }));
  });

  it('only accepts the exact HTTPS GitHub release asset path', () => {
    expect(isAllowedGitHubReleaseAssetUrl(
      'https://github.com/dlwlgus9125/EZTerminal/releases/download/v1.2.3/EZTerminal-Setup.exe',
      '1.2.3',
      'EZTerminal-Setup.exe',
    )).toBe(true);
    expect(isAllowedGitHubReleaseAssetUrl(
      'http://github.com/dlwlgus9125/EZTerminal/releases/download/v1.2.3/EZTerminal-Setup.exe',
      '1.2.3',
      'EZTerminal-Setup.exe',
    )).toBe(false);
    expect(isAllowedGitHubReleaseAssetUrl(
      'https://evil.example/EZTerminal-Setup.exe',
      '1.2.3',
      'EZTerminal-Setup.exe',
    )).toBe(false);
  });
});
