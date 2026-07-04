import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// Track A follow-up ②: drag layout editor. disableDnd is removed so a user can drag a
// tab to split / rearrange panes; disableFloatingGroups blocks the Shift+drag detached-
// window gesture. The load-bearing property: a MOVE re-parents the existing panel node
// (dockview never remounts it), so the pane's TerminalPane / shell session / live PTY
// survive the move. dockview's mouse drag is native HTML5 DnD, which Playwright can't
// drive reliably — so the move engine (the SAME path a drag invokes) is exercised via
// the programmatic panel.api.moveTo(...) through the window.__ezDock test seam.

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');

/** Click a dockview tab by its title text. */
async function clickTab(w: Page, title: string): Promise<void> {
  await w.locator('.dv-tab', { hasText: title }).click();
}

test('drag-layout: moving a pane preserves its live PTY session (re-parents, never remounts)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);

  // Start a live PTY in the first pane and wait for its startup output.
  await panes.nth(0).getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await panes.nth(0).getByTestId('btn-run').click();
  await expect(panes.nth(0).getByTestId('pty-block')).toBeVisible();
  await expect
    .poll(() => window.locator('.pty-block:visible .xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('READY');

  // Split right so there is a second group to move the PTY pane into.
  await window.getByTestId('btn-split-right').click();
  await expect(panes).toHaveCount(2);

  // Move the PTY panel (tab-1) into the other group (tab-2) — dockview's move engine, the
  // SAME path a mouse drag invokes. If it remounted the panel instead of re-parenting it,
  // TerminalPane's cleanup would destroySession and the PTY block would be gone.
  await window.evaluate(() => {
    // `window` here would shadow to the Playwright Page; use globalThis (=== the browser
    // window at runtime) to read the __ezDock test seam set in App.tsx onReady.
    type EzDockPanel = {
      id: string;
      group: unknown;
      api: { moveTo(opts: { group: unknown; position: string }): void };
    };
    const api = (globalThis as unknown as { __ezDock?: { panels: EzDockPanel[] } }).__ezDock;
    if (!api) throw new Error('__ezDock test seam missing');
    const pty = api.panels.find((p) => p.id === 'tab-1');
    const other = api.panels.find((p) => p.id === 'tab-2');
    if (!pty || !other) throw new Error('expected panels tab-1 and tab-2');
    pty.api.moveTo({ group: other.group, position: 'center' });
  });

  // The panels are now tabs in one group. Bring the moved PTY pane to the front and
  // assert its xterm still shows READY and the child is still running → session survived.
  await clickTab(window, 'Terminal 1');
  await expect(window.locator('[data-testid="pty-block"]:visible')).toBeVisible();
  await expect
    .poll(() => window.locator('.pty-block:visible .xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('READY');
  await expect(window.locator('[data-testid="block-status"]:visible')).toHaveText('running');

  await app.close();
});

test('drag-layout: DnD is enabled — dockview tabs are draggable', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await expect(window.getByTestId('pane')).toHaveCount(1);

  // With disableDnd removed, dockview marks its tabs draggable (drag layout editor on).
  const draggable = await window
    .locator('.dv-tab')
    .first()
    .evaluate((el) => (el as HTMLElement).draggable);
  expect(draggable).toBe(true);

  await app.close();
});
