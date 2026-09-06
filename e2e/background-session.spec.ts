import path from 'node:path';

import { expect, test } from './test';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');

/**
 * "Keep running" has to mean the session survives AND stays reachable. A pane
 * that closes while leaving an unreachable PTY behind is a leak wearing a
 * feature's clothing, so this covers both halves in one flow.
 */
test('keeping a risky pane running leaves its session reclaimable', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.locator('[data-testid="cmd-input"]:visible').fill(`!node ${ECHO_FIXTURE}`);
  await window.locator('[data-testid="btn-run"]:visible').click();
  const pty = window.locator('[data-testid="pty-block"]:visible');
  await expect(pty).toBeVisible();
  await expect.poll(() => readXtermBuffer(pty), { timeout: 15_000 }).toContain('READY');

  const sessionId = await window.getByTestId('pane').getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();

  // The tab closes only its view, even with a live run.
  await window.locator('.ez-dock .dv-tab .dv-default-tab-action').first().click();
  const dialog = window.getByTestId('risky-close-dialog');
  await expect(dialog).toHaveCount(0);
  await expect(window.getByTestId('pane')).toHaveCount(0);

  // The session outlived its pane.
  const live = await window.evaluate(async () => {
    const api = (globalThis as unknown as {
      ezterminal: { listSessions: () => Promise<readonly { sessionId: string }[]> };
    }).ezterminal;
    return (await api.listSessions()).map((session) => session.sessionId);
  });
  expect(live).toContain(sessionId);

  // And the Command Center hands it back rather than stranding it.
  // The header search field opens the full Command Center; Ctrl+Shift+P opens
  // its commands-only mode, which does not list panes or sessions.
  await window.getByTestId('btn-command-center').click();
  await expect(window.getByTestId('quick-open-modal')).toBeVisible();
  const reclaim = window.getByTestId(`quick-open-row-background-session-${sessionId}`);
  await expect(reclaim).toBeVisible();
  await reclaim.click();

  await expect(window.getByTestId('pane')).toHaveCount(1);
  await expect(window.getByTestId('pane')).toHaveAttribute('data-session-id', sessionId!);
  await expect.poll(() => readXtermBuffer(window.locator('[data-testid="pty-block"]:visible')), { timeout: 15_000 }).toContain('READY');
  await window.locator('[data-testid="pty-block"]:visible').click();
  await window.keyboard.type('after-reopen');
  await window.keyboard.press('Enter');
  await expect.poll(() => readXtermBuffer(window.locator('[data-testid="pty-block"]:visible')), { timeout: 15_000 }).toContain('ECHO:');
  await app.close();
});

test('closing and reopening a completed terminal restores output, draft, and custom tab title', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId('cmd-input')).toBeVisible();
  await window.getByTestId('cmd-input').fill('gen-rows 3');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block-status')).toHaveText('done');
  await window.getByTestId('cmd-input').fill('unfinished command');
  const sessionId = await window.getByTestId('pane').getAttribute('data-session-id');
  await window.locator('.agent-aware-tab').dblclick();
  await window.getByTestId('workspace-tab-rename').fill('Saved output');
  await window.getByTestId('workspace-tab-rename').press('Enter');
  await window.locator('.dv-default-tab-action').first().click();
  await expect(window.getByTestId('pane')).toHaveCount(0);
  await window.getByTestId('btn-command-center').click();
  await window.getByTestId(`quick-open-row-background-session-${sessionId}`).click();
  await expect(window.getByRole('tab', { name: 'Saved output', exact: true })).toBeVisible();
  await expect(window.getByTestId('pane')).toHaveAttribute('data-session-id', sessionId!);
  await expect(window.getByTestId('result-table')).toContainText('row-3');
  await expect(window.getByTestId('cmd-input')).toHaveValue('unfinished command');
  await expect(window.getByTestId('btn-run')).toBeEnabled();
  await app.close();
});
