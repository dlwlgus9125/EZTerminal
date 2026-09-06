import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(signingMode = 'unsigned'): { root: string; sha: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ezt-local-installers-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'release'));
  for (const name of ['build-local-release-candidate.ps1', 'stage-local-installers.ps1', 'resolve-windows-signing-mode.mjs']) {
    cpSync(path.resolve('scripts', name), path.join(root, 'scripts', name));
  }
  // No signing implementation or secret exists in this boundary fixture.
  writeFileSync(path.join(root, 'scripts/invoke-ephemeral-signing-process.ps1'), '');
  writeFileSync(path.join(root, 'release/version.json'), JSON.stringify({
    schemaVersion: 1, version: '1.0.49', androidVersionCode: 70,
    validationProfile: 'functional-hotfix', windowsSigningMode: signingMode,
  }));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Installer Test', '-c', 'user.email=installer@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  return { root, sha: git('rev-parse', 'HEAD').trim() };
}

function invoke(root: string, script: string, args: string[] = [], extra: Record<string, string> = {}): string {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, EZ_OUT_DIR: '', EZTERMINAL_RUN_RELEASE_PERFORMANCE: '', EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC: '', ...extra },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe.skipIf(process.platform !== 'win32')('local installer safety boundaries', () => {
  it('refuses uncommitted source before builds or secret access', () => {
    const { root } = fixture();
    writeFileSync(path.join(root, 'uncommitted.txt'), 'pending');
    expect(invoke(root, 'build-local-release-candidate.ps1', ['-InstallersOnly'])).toContain('candidate worktree is not clean');
  }, 30_000);

  it.each(['EZTERMINAL_RUN_RELEASE_PERFORMANCE', 'EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC', 'EZ_OUT_DIR'])('refuses inherited %s before building', (name) => {
    const { root } = fixture();
    expect(invoke(root, 'build-local-release-candidate.ps1', ['-InstallersOnly'], { [name]: '1' })).toContain(`refuse inherited ${name}`);
  }, 30_000);

  it('does not downgrade a signed Windows policy', () => {
    const { root } = fixture('signpath');
    expect(invoke(root, 'build-local-release-candidate.ps1', ['-InstallersOnly'])).toContain('protected release workflow');
  }, 30_000);

  it('keeps the default full RC path separate', () => {
    const { root } = fixture();
    expect(invoke(root, 'build-local-release-candidate.ps1')).toContain('requires a valid full release contract');
  }, 30_000);

  it('rejects SignPath configuration for an unsigned local build', () => {
    const { root } = fixture();
    expect(invoke(root, 'build-local-release-candidate.ps1', ['-InstallersOnly'], { SIGNPATH_PROJECT_SLUG: 'boundary-fixture' })).toContain('SignPath configuration is present');
  }, 30_000);

  it('refuses staging a different source commit', () => {
    const { root } = fixture();
    expect(invoke(root, 'stage-local-installers.ps1', ['-ExpectedCommit', 'a'.repeat(40)])).toContain('source HEAD changed');
  }, 30_000);

  it('refuses staging a dirty source tree', () => {
    const { root, sha } = fixture();
    writeFileSync(path.join(root, 'uncommitted.txt'), 'pending');
    expect(invoke(root, 'stage-local-installers.ps1', ['-ExpectedCommit', sha])).toContain('require a clean source tree');
  }, 30_000);
});

it('labels local receipts as publication-ineligible and reuses protected signing', () => {
  const builder = readFileSync('scripts/build-local-release-candidate.ps1', 'utf8');
  const stage = readFileSync('scripts/stage-local-installers.ps1', 'utf8');
  expect(builder).toContain('Invoke-SignedAndroidReleaseBuild');
  expect(builder).toContain('Invoke-EphemeralSigningProcess');
  expect(builder).toContain('$env:VITE_BUILD_SHA = $sha');
  expect(stage).toContain('publicationEligible = $false');
  expect(stage).toContain("fullReleaseValidation = 'not-certified-by-this-receipt'");
  expect(stage).not.toContain('stage-release-artifacts.ps1');
  expect(stage).not.toContain('Remove-Item');
});
