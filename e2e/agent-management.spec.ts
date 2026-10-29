import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand, type DaemonCommandReceipt } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test, type Page } from './test';
import { resizeWindow } from './workbench-navigation';

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidenceDirectory = path.resolve('artifacts/ai-management/e2e');
mkdirSync(evidenceDirectory, { recursive: true });

function fakeCodexEnvironment(stateDirectory: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: stateDirectory };
}

/** The same review-then-enable the Chat in app card performs, sent straight to the daemon. */
async function enableCodex(window: Page): Promise<void> {
  const inspection = await window.evaluate(() => globalThis.window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  let receipt: DaemonCommandReceipt | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authority = await window.evaluate(() => globalThis.window.ezterminal.getDaemonSnapshot());
    const commandId = `e2e-ai-management-enable-${attempt}`;
    receipt = await window.evaluate((command) => globalThis.window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId, idempotencyKey: commandId, expectedRevision: authority!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-ai-management' }, type: 'provider.enable',
      payload: {
        providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol,
        executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv,
        environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest,
      },
    }));
    if (receipt.ok || receipt.error.code !== 'revision-conflict') break;
  }
  expect(receipt?.ok, `Codex enable receipt: ${JSON.stringify(receipt)}`).toBe(true);
}

function fixtureState(stateDirectory: string): { installed: Record<string, boolean>; skills: Record<string, boolean>; marketplaces: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(stateDirectory, 'ezterminal-e2e-codex-extensions.json'), 'utf8'));
}

test('AI management browses, installs, switches and removes Codex plugins, marketplaces and skills', async ({ browserName }, testInfo) => {
  void browserName;
  const stateDirectory = createRegisteredE2eTempDir('ezterm-ai-management-e2e-');
  writeFileSync(path.join(stateDirectory, 'ezterminal-e2e-codex-version.txt'), '0.153.4', 'utf8');
  const app = await launchApp(stateDirectory, fakeCodexEnvironment(stateDirectory));
  const window = await app.firstWindow();
  try {
    await resizeWindow(window, { width: 1440, height: 1000 });
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    await enableCodex(window);

    await window.getByTestId('btn-toggle-settings').click();
    await window.getByTestId('settings-category-agents').click();
    await window.getByTestId('agent-management-settings').locator('summary').first().click();
    // Claude is not in use in this profile: the screen points to where it is turned on.
    await expect(window.getByTestId('agent-management-not-enabled')).toContainText('Chat in app');
    await window.getByTestId('agent-management-tab-codex').click();
    const panel = window.getByTestId('agent-management-codex');
    const plugins = panel.getByTestId('agent-plugins-codex');
    await expect(plugins).toContainText('No plugins installed');
    await expect(panel.getByTestId('agent-marketplace-fixture-market')).toBeVisible();

    // Browse and install with a confirmation.
    await plugins.getByTestId('agent-plugins-browse-codex').click();
    const browser = window.getByTestId('agent-plugin-browser');
    await expect(browser).toContainText('fixture-docs');
    await browser.getByTestId('agent-plugin-search').fill('lint');
    await expect(browser.getByTestId('agent-plugin-entry-fixture-docs@fixture-market')).toHaveCount(0);
    await browser.getByTestId('agent-plugin-install-fixture-lint@fixture-market').click();
    await expect(browser.getByTestId('agent-plugin-install-panel')).toContainText('Codex plugins install for the whole PC');
    await browser.getByTestId('agent-plugin-install-confirm').click();
    await expect(browser.getByTestId('agent-plugin-entry-fixture-lint@fixture-market')).toContainText('Installed');
    await window.screenshot({ path: path.join(evidenceDirectory, 'browse-installed.png') });
    await window.keyboard.press('Escape');
    await expect(browser).toHaveCount(0);
    const row = plugins.getByTestId('agent-plugin-fixture-lint@fixture-market');
    await expect(row).toBeVisible();
    expect(fixtureState(stateDirectory).installed).toEqual({ 'fixture-lint@fixture-market': true });

    // Turn it off, then remove it after the danger confirmation.
    await row.getByRole('switch').click();
    await expect.poll(() => fixtureState(stateDirectory).installed['fixture-lint@fixture-market']).toBe(false);
    await expect(row.getByRole('switch')).not.toBeChecked();
    await row.getByRole('button', { name: 'Remove fixture-lint' }).click();
    const removeDialog = window.getByTestId('agent-management-remove-dialog');
    // The footer's Cancel (not the header close icon) takes focus, so Enter never removes.
    await expect(removeDialog.getByRole('contentinfo').getByRole('button', { name: 'Cancel' })).toBeFocused();
    await removeDialog.getByTestId('agent-management-remove-confirm').click();
    await expect(row).toHaveCount(0);
    expect(fixtureState(stateDirectory).installed).toEqual({});

    // Add a marketplace, then turn a skill off.
    await panel.getByTestId('agent-marketplace-add-disclosure').locator('summary').click();
    await panel.getByTestId('agent-marketplace-source').fill('https://example.com/extra-market.git');
    await panel.getByTestId('agent-marketplace-add').click();
    await expect(panel.getByTestId('agent-marketplace-extra-market')).toBeVisible();
    const skills = panel.getByTestId('agent-skills-codex');
    await skills.locator('summary').click();
    await skills.getByRole('switch', { name: 'Use fixture-review' }).click();
    await expect.poll(() => fixtureState(stateDirectory).skills['C:\\fixture\\skills\\review\\SKILL.md']).toBe(false);
    await window.screenshot({ path: path.join(evidenceDirectory, 'codex-after-changes.png'), fullPage: true });
  } catch (error) {
    await window.screenshot({ path: path.join(evidenceDirectory, 'failure.png') });
    await testInfo.attach('failure', { path: path.join(evidenceDirectory, 'failure.png'), contentType: 'image/png' });
    throw error;
  } finally {
    await app.close();
  }
});

test('AI management updates a Codex npm install once the terminal using it closes', async ({ browserName }, testInfo) => {
  void browserName;
  const stateDirectory = createRegisteredE2eTempDir('ezterm-ai-update-e2e-');
  // A global npm prefix holding the fake Codex shim and the fake npm, first on PATH.
  const prefix = path.join(stateDirectory, 'npm-prefix');
  mkdirSync(path.join(prefix, 'node_modules', '@openai', 'codex'), { recursive: true });
  writeFileSync(path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), '{"name":"@openai/codex"}', 'utf8');
  for (const file of ['codex.cmd', 'codex-fixture.js']) copyFileSync(path.join(FAKE_CODEX_DIR, file), path.join(prefix, file));
  for (const file of ['npm.cmd', 'npm-fixture.js']) copyFileSync(path.resolve(__dirname, 'fixtures', 'fake-npm', file), path.join(prefix, file));
  writeFileSync(path.join(stateDirectory, 'ezterminal-e2e-codex-version.txt'), '0.153.4', 'utf8');
  writeFileSync(path.join(stateDirectory, 'ezterminal-e2e-codex-latest.txt'), '0.165.0', 'utf8');
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(stateDirectory, { [key]: `${prefix}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: stateDirectory });
  const window = await app.firstWindow();
  try {
    await resizeWindow(window, { width: 1440, height: 1000 });
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    await enableCodex(window);

    // Codex running in a terminal tab holds the program open.
    const input = window.getByTestId('cmd-input');
    await input.fill('codex');
    await input.press('Enter');
    await expect.poll(() => window.getByTestId('block').last().getByTestId('text-output').innerText(), { timeout: 15_000 }).toContain('FAKE-CODEX-READY');

    await window.getByTestId('btn-toggle-settings').click();
    await window.getByTestId('settings-category-agents').click();
    await window.getByTestId('agent-management-settings').locator('summary').first().click();
    await window.getByTestId('agent-management-tab-codex').click();
    const program = window.getByTestId('agent-program-codex');
    await expect(program).toContainText('Version 0.165.0 available');
    await expect(window.getByTestId('agent-program-running-codex')).toContainText('Terminal tab');
    await expect(window.getByTestId('agent-program-update-codex')).toBeDisabled();
    await window.screenshot({ path: path.join(evidenceDirectory, 'update-blocked.png') });

    // Closing it lets the update through; the provider stays usable on the new version.
    await window.getByTestId('btn-cancel').click();
    await expect(window.getByTestId('block').last().getByTestId('block-status')).not.toHaveText('running');
    await window.getByTestId('agent-program-check-codex').click();
    await expect(window.getByTestId('agent-program-running-codex')).toHaveCount(0);
    await window.getByTestId('agent-program-update-codex').click();
    await window.getByTestId('agent-program-update-confirm').click();
    await expect(program).toContainText('Codex was updated to 0.165.0', { timeout: 60_000 });
    await expect(program).toContainText('Up to date');
    expect(readFileSync(path.join(stateDirectory, 'ezterminal-e2e-npm-installs.txt'), 'utf8').trim()).toBe('@openai/codex@0.165.0');
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.ezterminal.getDaemonSnapshot()))
      ?.providers.find((provider) => provider.id === 'codex')).toMatchObject({ enabled: true, health: 'ready', executableVersion: '0.165.0' });
    await window.screenshot({ path: path.join(evidenceDirectory, 'update-done.png') });
  } catch (error) {
    await window.screenshot({ path: path.join(evidenceDirectory, 'update-failure.png') });
    await testInfo.attach('update-failure', { path: path.join(evidenceDirectory, 'update-failure.png'), contentType: 'image/png' });
    throw error;
  } finally {
    await app.close();
  }
});
