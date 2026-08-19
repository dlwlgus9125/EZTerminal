import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { readXtermBuffer } from './xterm-buffer';

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');

function seedAgentProject(userDataDir: string, projectRoot: string): void {
  writeFileSync(
    path.join(userDataDir, 'agent-projects.json'),
    JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'agent-activity-lifecycle-fixture',
        name: 'Agent activity lifecycle fixture',
        primaryRoot: projectRoot,
        additionalRoots: [],
        pinned: true,
        origin: 'terminal',
        lastActiveAt: 1_787_110_400_000,
        createdAt: 1_787_110_400_000,
        updatedAt: 1_787_110_400_000,
      }],
    }),
    'utf8',
  );
}

function pathEnvironment(): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path')
    ?? 'PATH';
  return {
    [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`,
  };
}

test('terminating an Agent terminal session removes its activity and focus target', async () => {
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-agent-activity-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-agent-activity-data-');
  seedAgentProject(userDataDir, projectRoot);

  const app = await launchApp(userDataDir, pathEnvironment());
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const projectId = await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items[0]?.projectId);
  expect(projectId).toBeTruthy();

  await window.getByTestId('btn-toggle-agents').click();
  await window.getByTestId(`agent-project-new-chat-${projectId!}`).click();
  const picker = window.getByTestId('agent-launch-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('agent-launch-agent').selectOption('codex');
  await picker.getByTestId('agent-launch-submit').click();
  await expect(picker).toHaveCount(0);

  const pane = window.locator('[data-testid="pane"]:visible');
  const terminal = pane.getByTestId('pty-block');
  await expect(terminal).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readXtermBuffer(terminal), { timeout: 15_000 })
    .toContain('FAKE-CODEX-READY');
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect(window.getByTestId('agent-focus')).toHaveCount(1, { timeout: 15_000 });

  await window.locator('.ez-dock .dv-tab.dv-active-tab .dv-default-tab-action').click();
  const dialog = window.getByTestId('risky-close-dialog');
  await expect(dialog).toBeVisible();
  await window.getByTestId('risky-close-confirm').click();
  await expect(dialog).toHaveCount(0);

  await expect(window.locator(`[data-testid="pane"][data-session-id="${sessionId!}"]`))
    .toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => window.evaluate(async (removedSessionId) =>
    (await globalThis.window.ezterminal.listSessions())
      .some((session) => session.sessionId === removedSessionId), sessionId!), { timeout: 15_000 })
    .toBe(false);
  await expect(window.getByTestId('agent-row')).toHaveCount(0, { timeout: 15_000 });
  await expect(window.getByTestId('agent-focus')).toHaveCount(0);

  await app.close();
});
