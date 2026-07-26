import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-layout-e2e-'));
}

const panes = (window: Page) => window.getByTestId('pane');

async function sessionIdOf(window: Page, index: number): Promise<string> {
  await expect(panes(window).nth(index)).toHaveAttribute('data-session-id', /.+/, {
    timeout: 15_000,
  });
  return (await panes(window).nth(index).getAttribute('data-session-id')) as string;
}

async function flushLayout(window: Page): Promise<void> {
  await window.evaluate(() => {
    const seam = globalThis as unknown as { __ezLayoutFlush?: () => Promise<void> };
    if (!seam.__ezLayoutFlush) throw new Error('__ezLayoutFlush seam missing');
    return seam.__ezLayoutFlush();
  });
}

async function splitFromWorkspace(window: Page, direction: 'right' | 'down'): Promise<void> {
  await window.getByTestId('btn-workspace-menu').click();
  await window.getByTestId(`btn-split-${direction}`).click();
}

async function toggleWorkspaceMenu(window: Page): Promise<void> {
  await window.getByTestId('btn-workspace-menu').click();
}

test('restart-restore: 3-pane layout comes back with ALL-NEW sessions (B1/B5)', async () => {
  const dir = tempUserData();
  const app1 = await launchApp(dir);
  const first = await app1.firstWindow();
  await expect(panes(first)).toHaveCount(1);
  await splitFromWorkspace(first, 'right');
  await splitFromWorkspace(first, 'down');
  await expect(panes(first)).toHaveCount(3);

  const before = [
    await sessionIdOf(first, 0),
    await sessionIdOf(first, 1),
    await sessionIdOf(first, 2),
  ];
  expect(new Set(before).size).toBe(3);

  const initialPrompt = (await first.getByTestId('prompt-cwd').first().textContent()) ?? '';
  await panes(first).nth(0).getByTestId('cmd-input').fill(`cd ${tmpdir()}`);
  await panes(first).nth(0).getByTestId('btn-run').click();
  await expect(panes(first).nth(0).getByTestId('prompt-cwd')).not.toHaveText(initialPrompt, {
    timeout: 15_000,
  });
  await flushLayout(first);
  await app1.close();
  expect(existsSync(path.join(dir, 'layout.json'))).toBe(true);

  const app2 = await launchApp(dir);
  const second = await app2.firstWindow();
  await expect(panes(second)).toHaveCount(3, { timeout: 15_000 });
  const after = [
    await sessionIdOf(second, 0),
    await sessionIdOf(second, 1),
    await sessionIdOf(second, 2),
  ];
  expect(new Set(after).size).toBe(3);
  for (const id of after) expect(before).not.toContain(id);
  await expect(panes(second).nth(0).getByTestId('prompt-cwd')).toHaveText(initialPrompt);
  await expect.poll(() => second.evaluate(() => {
    const seam = globalThis as unknown as { __ezSessions?: () => number };
    return seam.__ezSessions ? seam.__ezSessions() : -1;
  })).toBe(3);

  await second.getByTestId('btn-new-tab').click();
  const ids = await second.evaluate(() => {
    const seam = globalThis as unknown as { __ezDock?: { panels: Array<{ id: string }> } };
    if (!seam.__ezDock) throw new Error('__ezDock seam missing');
    return seam.__ezDock.panels.map((panel) => panel.id);
  });
  expect(ids).toContain('tab-4');

  await panes(second).nth(1).getByTestId('cmd-input').fill('gen-rows 3');
  await panes(second).nth(1).getByTestId('btn-run').click();
  await expect(panes(second).nth(1).getByTestId('result-table')).toBeVisible({ timeout: 15_000 });
  await app2.close();
});

test('presets: save/apply (fresh sessions, no leaks) and startup preset wins over last layout', async () => {
  const dir = tempUserData();
  const app = await launchApp(dir);
  const window = await app.firstWindow();
  await expect(panes(window)).toHaveCount(1);

  await splitFromWorkspace(window, 'right');
  await expect(panes(window)).toHaveCount(2);
  await toggleWorkspaceMenu(window);
  await window.getByTestId('btn-save-preset').click();
  await window.getByTestId('preset-name-input').fill('duo');
  await window.getByTestId('preset-save-confirm').click();
  await expect(window.getByTestId('preset-apply-duo')).toBeVisible();
  await toggleWorkspaceMenu(window);

  await window.getByTestId('btn-new-tab').click();
  await expect(panes(window)).toHaveCount(3);
  const before = [
    await sessionIdOf(window, 0),
    await sessionIdOf(window, 1),
    await sessionIdOf(window, 2),
  ];

  await toggleWorkspaceMenu(window);
  await window.getByTestId('preset-apply-duo').click();
  await window.getByTestId('risky-close-confirm').click();
  await expect(panes(window)).toHaveCount(2, { timeout: 15_000 });
  const after = [await sessionIdOf(window, 0), await sessionIdOf(window, 1)];
  for (const id of after) expect(before).not.toContain(id);
  await expect.poll(() => window.evaluate(() => {
    const seam = globalThis as unknown as { __ezSessions?: () => number };
    return seam.__ezSessions ? seam.__ezSessions() : -1;
  })).toBe(2);

  await toggleWorkspaceMenu(window);
  await window.getByTestId('preset-star-duo').click();
  await expect(window.getByTestId('preset-star-duo')).toHaveAttribute('aria-pressed', 'true');
  await window.getByTestId('btn-new-tab').click();
  await expect(panes(window)).toHaveCount(3);
  await flushLayout(window);
  await app.close();

  const app2 = await launchApp(dir);
  const second = await app2.firstWindow();
  await expect(panes(second)).toHaveCount(2, { timeout: 15_000 });
  await app2.close();
});
