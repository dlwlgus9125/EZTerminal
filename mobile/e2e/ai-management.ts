/**
 * Android emulator e2e — Settings › AI on the phone manages the connected PC's AI extensions.
 *
 *  1. The AI category opens the PC's Codex plugins, marketplaces, MCP servers and skills, shows the
 *     installed program version, and offers no program update (that stays on the PC).
 *  2. A plugin installed from the phone lands in the PC's settings (the fake Codex state file) and
 *     appears on the PC's own AI management screen.
 *
 * The PC runs the fake Codex from e2e/fixtures/fake-codex, so no real provider or account is used.
 * Prerequisites as smoke.ts (booted AVD, fresh debug APK built in e2e mode, `.vite/build/main.js`).
 * Run: node --experimental-strip-types mobile/e2e/ai-management.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APP_ID, ROOT, SHELL_ROOT_TEST_ID, closeMobileE2eResources, connectAndAuth, evaluateWebView, launchDesktop,
  openShellDestination, runAdb, runAdbBinary, sleep, tapTestId, waitForTestId,
} from './lib.ts';

const artifactDir = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/ai-management/android');
const FAKE_CODEX_DIR = path.join(ROOT, 'e2e', 'fixtures', 'fake-codex');

async function waitFor(label: string, expression: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await evaluateWebView<boolean>(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(200);
  }
}
const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((node) => node.getBoundingClientRect().width > 0)`;
async function shot(name: string): Promise<void> { await writeFile(path.join(artifactDir, name), runAdbBinary(['exec-out', 'screencap', '-p'])); }

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const state = registry.createTempDir('ezterm-ai-android-');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'ezterminal-e2e-codex-version.txt'), '0.153.4', 'utf8');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: [] };
  const checks = report.checks as string[];
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    report.androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
    desktop = await launchDesktop({ env: { [pathKey]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[pathKey] ?? ''}`, TMPDIR: state } });
    const enabled = await desktop.window.evaluate(async () => {
      const inspection = await window.ezterminal.inspectDaemonProvider('codex');
      if (!inspection.ok) return inspection.message;
      const { probe, reviewDigest } = inspection.value;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshot = await window.ezterminal.getDaemonSnapshot();
        const commandId = `android-ai-enable-${attempt}`;
        const receipt = await window.ezterminal.sendDaemonCommand({
          protocolVersion: 12, commandId, idempotencyKey: commandId, expectedRevision: snapshot!.revision, issuedAt: new Date().toISOString(),
          principal: { kind: 'desktop', id: 'android-ai-management' }, type: 'provider.enable',
          payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
            executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest },
        } as never);
        if (receipt.ok) return 'ok';
        if (receipt.error.code !== 'revision-conflict') return receipt.error.message;
      }
      return 'revision conflicts';
    });
    assert.equal(enabled, 'ok', `the fake Codex is enabled on the PC: ${enabled}`);

    await connectAndAuth(desktop.token);
    await waitForTestId(SHELL_ROOT_TEST_ID, 45_000);
    await openShellDestination('more-settings', 'mobile-settings-view');
    await tapTestId('settings-category-ai');
    await waitForTestId('agent-management', 20_000);
    await tapTestId('agent-management-tab-codex');
    await waitFor('the Codex plugins', visible('[data-testid="agent-plugins-codex"]'));
    const text = await evaluateWebView<string>('document.querySelector(\'[data-testid="agent-management-codex"]\').innerText');
    assert.ok(text.includes('0.153.4'), 'the PC program version is shown');
    assert.ok(text.includes('fixture-market'), 'the PC marketplace is listed');
    assert.equal(await evaluateWebView<number>('document.querySelectorAll(\'[data-testid^="agent-program-update"]\').length'), 0, 'no program update on the phone');
    await shot('1-ai-codex.png');
    checks.push('the AI category shows the PC version, marketplace and plugins, and no program update');

    // Install from the phone; the PC's settings change and its own screen lists the plugin.
    await tapTestId('agent-plugins-browse-codex');
    await waitFor('the plugin browser', visible('[data-testid="agent-plugin-entry-fixture-lint@fixture-market"]'));
    await shot('2-ai-browse.png');
    await tapTestId('agent-plugin-install-fixture-lint@fixture-market');
    await waitFor('the install confirmation', visible('[data-testid="agent-plugin-install-confirm"]'));
    await shot('3-ai-install-confirm.png');
    await tapTestId('agent-plugin-install-confirm');
    // Plain ES2018: the expression runs inside Android 10's WebView 74 (no optional chaining).
    await waitFor('the installed badge', `(function () { var row = document.querySelector('[data-testid="agent-plugin-entry-fixture-lint@fixture-market"]');
      return !!row && (row.innerText.indexOf('Installed') >= 0 || row.innerText.indexOf('설치됨') >= 0); })()`, 60_000);
    const installed = JSON.parse(readFileSync(path.join(state, 'ezterminal-e2e-codex-extensions.json'), 'utf8')) as { installed: Record<string, boolean> };
    assert.equal(installed.installed['fixture-lint@fixture-market'], true, 'the PC settings hold the plugin');
    checks.push('a plugin installed from the phone is written to the PC settings');

    await desktop.window.getByTestId('btn-toggle-settings').click();
    await desktop.window.getByTestId('settings-category-agents').click();
    await desktop.window.getByTestId('agent-management-settings').locator('summary').first().click();
    await desktop.window.getByTestId('agent-management-tab-codex').click();
    await desktop.window.getByTestId('agent-plugin-fixture-lint@fixture-market').waitFor({ timeout: 30_000 });
    await desktop.window.screenshot({ path: path.join(artifactDir, '4-pc-after-phone-install.png') });
    checks.push('the PC screen lists the plugin the phone installed');
    report.status = 'passed';
    console.log(`[ai-management] PASS ${checks.length} checks on API ${String(report.androidApi)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    try { await shot('failure.png'); } catch { /* keep the original failure */ }
    try { report.text = await evaluateWebView<string>('document.body.innerText'); } catch { /* WebView unavailable */ }
    throw error;
  } finally {
    try { runAdb(['shell', 'am', 'force-stop', APP_ID]); } catch { /* best effort */ }
    closeMobileE2eResources();
    try { await desktop?.dispose(); } catch { /* best effort */ }
    try { await registry.disposeAll(); } catch { /* best effort */ }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifactDir, `ai-management-api${String(report.androidApi ?? 'unknown')}.json`), JSON.stringify(report, null, 2));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
