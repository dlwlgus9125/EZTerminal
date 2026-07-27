import path from 'node:path';

import { expect, test } from '@playwright/test';

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

  // A live run must be confirmed before the pane goes anywhere.
  await window.locator('.ez-dock .dv-tab .dv-default-tab-action').first().click();
  const dialog = window.getByTestId('risky-close-dialog');
  await expect(dialog).toBeVisible();

  await window.getByTestId('risky-close-alternate').click();
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
  await app.close();
});
