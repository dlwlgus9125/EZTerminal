import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { startNewConversation } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { resizeWindow } from './workbench-navigation';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>['firstWindow']>>;

/**
 * I3: the terminal's prompt line switches to the AI input with Ctrl+. — the last
 * conversation's own message box, sharing its draft with the conversation's tab,
 * with the last finished block attached as a chip. The message (and the output)
 * reaches the AI (fake Codex); the terminal stays where it was.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidence = path.resolve('artifacts/ux2/terminal/e2e');

function fakeCodexEnvironment(profile: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: profile };
}

async function enableCodex(page: Page): Promise<void> {
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const id = `e2e-terminal-ai-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-terminal-ai' }, type: 'provider.enable',
      payload: {
        providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
        executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames,
        capabilities: probe.capabilities, reviewDigest,
      },
    }));
    if (receipt.ok) return;
    if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
  }
}

function lastCodexInput(profile: string): string {
  const file = path.join(profile, 'ezterminal-e2e-codex-last-input.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('Ctrl+. sends a question and the last output to the last conversation, sharing its draft', async () => {
  test.setTimeout(240_000);
  const profile = createRegisteredE2eTempDir('ezterm-terminal-ai-profile-');
  const root = createRegisteredE2eTempDir('ezterm-terminal-ai-root-');
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1600, height: 950 });
    await expect(page.getByTestId('cmd-input').first()).toBeVisible();
    const saved = await page.evaluate((primaryRoot) => window.ezterminal.saveAgentProject({
      name: 'Terminal AI', primaryRoot, additionalRoots: [], pinned: false,
    }), root);
    if (!saved.ok) throw new Error(saved.reason);
    await enableCodex(page);
    await expect.poll(async () => (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces.length ?? 0,
      { timeout: 15_000 }).toBeGreaterThan(0);

    // A conversation, looked at last.
    const draft = await startNewConversation(page);
    const firstBox = draft.getByTestId('structured-agent-composer-input');
    await firstBox.click();
    await firstBox.fill('Hello from the conversation.');
    await firstBox.press('Enter');
    await expect(page.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
    const session = page.locator('[data-testid="structured-agent-session"]:not([data-presentation])').first();
    const sessionId = (await session.getAttribute('data-session-id'))!;
    await expect.poll(async () => (await page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.turns
      .filter((turn) => turn.sessionId === id).every((turn) => turn.state === 'completed'), sessionId)), { timeout: 30_000 }).toBe(true);
    const title = (await page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.sessions.find((item) => item.id === id)?.title, sessionId)) ?? '';

    // The terminal: run a command.
    await page.keyboard.press('Control+Backquote');
    const pane = page.locator('[data-testid="pane"]:visible').first();
    const shell = pane.getByTestId('cmd-input');
    await expect(shell).toBeFocused();
    await shell.fill('echo ez-terminal-ai');
    await shell.press('Enter');
    await expect(pane.getByTestId('block').last()).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(pane.getByTestId('block').last().getByTestId('block-time')).not.toHaveText('');

    // Ctrl+. — the last conversation's own box, with the block attached.
    await shell.press('Control+Period');
    const dock = pane.getByTestId('term-dock');
    await expect(dock).toHaveAttribute('data-mode', 'ai');
    await expect(pane.getByTestId('terminal-mode-ai')).toHaveAttribute('aria-pressed', 'true');
    const ai = pane.getByTestId('terminal-ai');
    const box = ai.getByTestId('structured-agent-composer-input');
    await expect(box).toBeFocused();
    await expect(pane.getByTestId('terminal-ai-target')).toContainText(title);
    const chip = ai.getByTestId('terminal-ai-chip');
    await expect(chip).toHaveCount(1);
    await chip.locator('summary').click();
    await expect(ai.getByTestId('terminal-ai-chip-preview')).toContainText('$ echo ez-terminal-ai');
    await expect(ai.getByTestId('terminal-ai-chip-preview')).toContainText('ez-terminal-ai');
    // The same draft as the conversation's tab: typed here, there too.
    await box.fill('What did the command print?');
    const tabBox = session.getByTestId('structured-agent-composer-input');
    await expect(tabBox).toHaveValue('What did the command print?');
    await page.screenshot({ path: path.join(evidence, 'terminal-ai-mode.png') });

    // Send: the AI gets the question and the output; the terminal stays in AI mode; both boxes clear.
    await box.press('Enter');
    await expect(page.getByTestId('terminal-ai-open-conversation')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => lastCodexInput(profile), { timeout: 30_000 }).toContain('What did the command print?');
    expect(lastCodexInput(profile)).toContain('ez-terminal-ai');
    await expect(dock).toHaveAttribute('data-mode', 'ai');
    await expect(box).toHaveValue('');
    await expect(tabBox).toHaveValue('');
    await expect(ai.getByTestId('terminal-ai-chip')).toHaveCount(0);

    // Ctrl+. back to the shell; the same block is not attached again next time.
    await box.press('Control+Period');
    await expect(dock).toHaveAttribute('data-mode', 'shell');
    await expect(shell).toBeFocused();
    await shell.press('Control+Period');
    await expect(dock).toHaveAttribute('data-mode', 'ai');
    await expect(ai.getByTestId('terminal-ai-chip')).toHaveCount(0);

    // A block's menu attaches it on purpose.
    await pane.getByTestId('block').last().hover();
    await pane.getByTestId('block').last().getByTestId('block-menu').click();
    await page.getByTestId('block-send-to-ai').click();
    await expect(ai.getByTestId('terminal-ai-chip')).toHaveCount(1);
    await ai.getByTestId('terminal-ai-chip-remove').click();
    await expect(ai.getByTestId('terminal-ai-chip')).toHaveCount(0);

    // The note's "Open conversation" opens the conversation's tab.
    await page.getByTestId('terminal-ai-open-conversation').first().click();
    await expect(session).toBeVisible();
  } finally {
    await app.close();
  }
});
