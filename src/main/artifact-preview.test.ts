import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactPreviewRegistry,
  artifactResponseHeaders,
  handleArtifactRequest,
  isAllowedSubframeUrl,
} from './artifact-preview';

let root: string;
let site: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ez-artifact-'));
  site = path.join(root, 'site');
  outside = path.join(root, 'outside');
  mkdirSync(path.join(site, 'assets'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(site, 'report.html'), '<!doctype html><script>document.body.textContent="hi"</script>');
  writeFileSync(path.join(site, 'assets', 'style.css'), 'body{}');
  writeFileSync(path.join(site, '..notes.txt'), 'dots in the name are fine');
  writeFileSync(path.join(site, 'secret.env'), 'TOKEN=1');
  writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  writeFileSync(path.join(root, 'paper.pdf'), '%PDF-1.4\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function url(token: string, rest: string): string {
  return `ezartifact://${token}/${rest}`;
}

describe('artifact preview grants', () => {
  it('grants an HTML page and serves it and its own folder\'s assets', async () => {
    const registry = new ArtifactPreviewRegistry();
    const grant = await registry.grant(path.join(site, 'report.html'), 'html');
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.url).toBe(url(grant.token, 'report.html'));
    expect(grant.token).toMatch(/^[0-9a-f]{32}$/u);
    await expect(registry.resolve(grant.url)).resolves.toMatchObject({ ok: true, mime: 'text/html; charset=utf-8' });
    await expect(registry.resolve(url(grant.token, 'assets/style.css'))).resolves.toMatchObject({ ok: true, mime: 'text/css; charset=utf-8' });
    await expect(registry.resolve(url(grant.token, '..notes.txt'))).resolves.toMatchObject({ ok: true });
  });

  it('refuses anything outside the granted folder, however it is spelled', async () => {
    const registry = new ArtifactPreviewRegistry();
    const grant = await registry.grant(path.join(site, 'report.html'), 'html');
    if (!grant.ok) throw new Error(grant.error);
    for (const rest of ['../outside/secret.txt', '%2e%2e/outside/secret.txt', '..%2foutside%2fsecret.txt', '..%5coutside%5csecret.txt',
      'assets/%2e%2e/%2e%2e/outside/secret.txt', 'C:%5cWindows%5cwin.ini', '%00', 'assets', '']) {
      expect((await registry.resolve(url(grant.token, rest))).ok, rest).toBe(false);
    }
    // A file type outside the allow-list is never served.
    expect((await registry.resolve(url(grant.token, 'secret.env'))).ok).toBe(false);
  });

  it('refuses a link inside the folder that resolves outside it', async () => {
    const registry = new ArtifactPreviewRegistry();
    try {
      symlinkSync(outside, path.join(site, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // The platform does not let this account create links.
    }
    writeFileSync(path.join(outside, 'page.html'), '<p>outside</p>');
    const grant = await registry.grant(path.join(site, 'report.html'), 'html');
    if (!grant.ok) throw new Error(grant.error);
    expect((await registry.resolve(url(grant.token, 'escape/page.html'))).ok).toBe(false);
  });

  it('a PDF grant is exactly one file', async () => {
    const registry = new ArtifactPreviewRegistry();
    const grant = await registry.grant(path.join(root, 'paper.pdf'), 'pdf');
    if (!grant.ok) throw new Error(grant.error);
    await expect(registry.resolve(grant.url)).resolves.toMatchObject({ ok: true, mime: 'application/pdf', kind: 'pdf' });
    expect((await registry.resolve(url(grant.token, 'site/report.html'))).ok).toBe(false);
    expect((await registry.resolve(url(grant.token, 'other.pdf'))).ok).toBe(false);
  });

  it('refuses network shares, devices, relative paths, wrong kinds and missing files', async () => {
    const registry = new ArtifactPreviewRegistry();
    for (const [file, kind] of [['\\\\attacker\\share\\x.html', 'html'], ['//attacker/share/x.html', 'html'], ['\\\\?\\C:\\x.html', 'html'],
      ['site/report.html', 'html'], [path.join(site, 'report.html'), 'pdf'], [path.join(site, 'missing.html'), 'html'],
      [path.join(site, 'secret.env'), 'html'], [path.join(site, 'report.html'), 'exe'], [42, 'html']] as const) {
      expect((await registry.grant(file, kind)).ok, String(file)).toBe(false);
    }
    expect(registry.size).toBe(0);
  });

  it('forgets unused grants, keeps at most 32, and revokes on request', async () => {
    let now = 0;
    const registry = new ArtifactPreviewRegistry({ now: () => now });
    const first = await registry.grant(path.join(site, 'report.html'), 'html');
    if (!first.ok) throw new Error(first.error);
    registry.revoke(first.token);
    expect((await registry.resolve(first.url)).ok).toBe(false);
    const idle = await registry.grant(path.join(site, 'report.html'), 'html');
    if (!idle.ok) throw new Error(idle.error);
    now += 31 * 60_000;
    expect((await registry.resolve(idle.url)).ok).toBe(false);
    for (let index = 0; index < 40; index += 1) await registry.grant(path.join(site, 'report.html'), 'html');
    expect(registry.size).toBe(32);
  });
});

describe('artifact preview responses', () => {
  it('sandboxes pages and assets to their own grant with no network; PDFs keep the viewer', () => {
    const html = artifactResponseHeaders('a'.repeat(32), 'html', 'text/html; charset=utf-8');
    expect(html['Content-Security-Policy']).toContain('sandbox allow-scripts;');
    expect(html['Content-Security-Policy']).toContain("connect-src 'none'");
    expect(html['Content-Security-Policy']).toContain(`script-src 'unsafe-inline' ezartifact://${'a'.repeat(32)}`);
    expect(html['Content-Security-Policy']).not.toMatch(/allow-same-origin|allow-popups|allow-forms|allow-top-navigation/u);
    expect(html).toMatchObject({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    const pdf = artifactResponseHeaders('a'.repeat(32), 'pdf', 'application/pdf');
    expect(pdf['Content-Security-Policy']).toBeUndefined();
    expect(pdf['X-Content-Type-Options']).toBe('nosniff');
  });

  it('serves GET and HEAD only, with the sandbox header', async () => {
    const registry = new ArtifactPreviewRegistry();
    const grant = await registry.grant(path.join(site, 'report.html'), 'html');
    if (!grant.ok) throw new Error(grant.error);
    const ok = await handleArtifactRequest(registry, new Request(grant.url));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(await ok.text()).toContain('document.body');
    expect((await handleArtifactRequest(registry, new Request(grant.url, { method: 'HEAD' }))).status).toBe(200);
    expect((await handleArtifactRequest(registry, new Request(grant.url, { method: 'POST', body: 'x' }))).status).toBe(405);
    expect((await handleArtifactRequest(registry, new Request(url(grant.token, '../outside/secret.txt')))).status).toBeGreaterThanOrEqual(400);
    expect((await handleArtifactRequest(registry, new Request(url('b'.repeat(32), 'report.html')))).status).toBe(404);
  });

  it('subframes may only navigate to previews', () => {
    expect(isAllowedSubframeUrl('ezartifact://abc/report.html')).toBe(true);
    expect(isAllowedSubframeUrl('about:blank')).toBe(true);
    expect(isAllowedSubframeUrl('https://example.com/')).toBe(false);
    expect(isAllowedSubframeUrl('file:///C:/secret.txt')).toBe(false);
    expect(isAllowedSubframeUrl('javascript:alert(1)')).toBe(false);
    // Chromium's built-in PDF viewer, and no other extension.
    expect(isAllowedSubframeUrl('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/f5505884-484c-4ac6-b45c-7c0c8a7a866f')).toBe(true);
    expect(isAllowedSubframeUrl('chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html')).toBe(false);
  });
});
