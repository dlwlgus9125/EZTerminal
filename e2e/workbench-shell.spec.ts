import { enterWorkMode, toggleWorkbenchTool } from './workbench-navigation';
import { expect, test } from './test';

import { launchApp } from './launch-app';

/*
 * The Board + Desk shell (approved 2026-10-24): one top bar, the live list in
 * work mode, the project board in its place when chosen. A fresh profile has
 * no projects, so the app opens in work mode on a terminal. Below 1100px (the
 * default 1024x720 window) the live list is folded into a strip of icons.
 */

test('Board + Desk shell: top bar, layout menu and a focus-restoring overlay sidebar', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    await expect(window.getByTestId('workbench-header')).toBeVisible();
    await expect(window.locator('.workbench-body')).toHaveAttribute('data-shell-mode', 'work');
    await expect(window.getByTestId('shell-live-strip')).toBeVisible();
    await expect(window.getByTestId('shell-live-list')).toHaveCount(0);
    await expect(window.getByTestId('btn-new-tab')).toBeVisible();
    await expect(window.getByTestId('btn-command-center')).toBeVisible();
    await expect(window.getByTestId('btn-workspace-menu')).toBeVisible();
    await expect(window.getByTestId('btn-toggle-settings')).toBeVisible();
    // The old chrome is gone: no activity rail, workbench bar or status bar.
    await expect(window.locator('.activity-rail')).toHaveCount(0);
    await expect(window.locator('.workbench-bar')).toHaveCount(0);
    await expect(window.getByTestId('workbench-status-bar')).toHaveCount(0);

    const workspace = window.getByTestId('btn-workspace-menu');
    await workspace.focus();
    await workspace.press('ArrowDown');
    await expect(window.getByTestId('preset-menu')).toBeVisible();
    await expect(window.getByTestId('preset-menu').getByTestId('workbench-views')).toBeVisible();
    await expect(window.getByTestId('btn-split-right')).toBeVisible();
    await expect.poll(() => window.getByTestId('preset-menu').evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('preset-menu')).toHaveCount(0);
    await expect.poll(() => workspace.evaluate((element) => document.activeElement === element)).toBe(true);

    const explorer = window.getByTestId('btn-toggle-files');
    const dockBefore = await window.locator('.dock-host').boundingBox();
    await toggleWorkbenchTool(window, 'btn-toggle-files');

    const sidebar = window.getByTestId('workbench-sidebar');
    const dockHost = window.locator('.dock-host');
    const liveList = window.getByTestId('shell-live-strip');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-destination', 'explorer');
    expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('absolute');
    await expect(window.locator('.workbench-sidebar-scrim')).toBeVisible();
    expect(await dockHost.boundingBox()).toEqual(dockBefore);
    await expect(dockHost).toHaveAttribute('inert', '');
    await expect(liveList).not.toHaveAttribute('inert', '');

    const settings = window.getByTestId('btn-toggle-settings');
    await settings.click();
    await expect(sidebar).toHaveAttribute('data-destination', 'settings');
    await expect(window.getByTestId('settings-panel')).toBeVisible();
    await expect(window.getByTestId('file-explorer-panel')).toHaveCount(0);
    await settings.click();
    await expect(sidebar).toHaveCount(0);

    await toggleWorkbenchTool(window, 'btn-toggle-files');
    await expect(sidebar).toHaveAttribute('data-destination', 'explorer');
    await window.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect.poll(() => explorer.evaluate((element) => document.activeElement === element)).toBe(true);

    const commandCenter = window.getByTestId('btn-command-center');
    await commandCenter.click();
    await expect(window.getByTestId('quick-open-modal')).toBeVisible();
    await window.getByTestId('quick-open-row-action-open-explorer').click();
    await expect(sidebar).toBeVisible();
    await expect.poll(() => sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(dockHost).toHaveAttribute('inert', '');
    await window.keyboard.press('Shift+Tab');
    await expect.poll(() => liveList.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await window.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect.poll(() => commandCenter.evaluate((element) => document.activeElement === element)).toBe(true);

    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('the live list, scrim and overlay sidebar share one scaled geometry at 800 and 1024 pixels', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    const samples: Array<{ label: string; scrimAligned: boolean; sidebarAligned: boolean; topBarFits: boolean }> = [];

    const sampleGeometry = async (label: string): Promise<void> => {
      const list = await window.getByTestId('shell-live-strip').boundingBox();
      const scrim = await window.locator('.workbench-sidebar-scrim').boundingBox();
      const sidebar = await window.getByTestId('workbench-sidebar').boundingBox();
      expect(list).not.toBeNull();
      expect(scrim).not.toBeNull();
      expect(sidebar).not.toBeNull();
      if (!list || !scrim || !sidebar) return;
      const listEnd = list.x + list.width;
      samples.push({
        label,
        scrimAligned: Math.abs(scrim.x - listEnd) <= 1,
        sidebarAligned: Math.abs(sidebar.x - listEnd) <= 1,
        topBarFits: await window.getByTestId('workbench-header').evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      });
    };

    await window.setViewportSize({ width: 800, height: 600 });
    await toggleWorkbenchTool(window, 'btn-toggle-files');
    await window.getByTestId('btn-toggle-settings').click();
    await expect(window.getByTestId('settings-panel')).toBeVisible();
    await sampleGeometry('800x600@100');

    for (const expectedScale of [110, 120, 130, 140, 150]) {
      await window.getByTestId('settings-scale-inc').click();
      await expect(window.getByTestId('settings-scale-value')).toHaveText(`${expectedScale}%`);
    }
    await sampleGeometry('800x600@150');

    await window.setViewportSize({ width: 1024, height: 720 });
    await sampleGeometry('1024x720@150');

    for (const expectedScale of [140, 130, 120, 110, 100]) {
      await window.getByTestId('settings-scale-dec').click();
      await expect(window.getByTestId('settings-scale-value')).toHaveText(`${expectedScale}%`);
    }
    await sampleGeometry('1024x720@100');

    expect(samples).toEqual([
      { label: '800x600@100', scrimAligned: true, sidebarAligned: true, topBarFits: true },
      { label: '800x600@150', scrimAligned: true, sidebarAligned: true, topBarFits: true },
      { label: '1024x720@150', scrimAligned: true, sidebarAligned: true, topBarFits: true },
      { label: '1024x720@100', scrimAligned: true, sidebarAligned: true, topBarFits: true },
    ]);
  } finally {
    await app.close();
  }
});

test('a nested sidebar dialog keeps ownership when the wide shell becomes narrow', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => window.evaluate(
      () => matchMedia('(min-width: 1200px)').matches,
    )).toBe(true);

    await toggleWorkbenchTool(window, 'btn-toggle-files');
    const sidebar = window.getByTestId('workbench-sidebar');
    await expect(sidebar).toHaveAttribute('data-destination', 'explorer');
    const packageEntry = window.getByTestId('file-entry').filter({ hasText: 'package.json' });
    await expect(packageEntry).toBeVisible();
    await packageEntry.click({ button: 'right' });
    await window.getByTestId('ctx-delete').click();

    const dialog = window.getByTestId('delete-confirm');
    const backdrop = dialog.locator('xpath=..');
    await expect(dialog).toBeVisible();
    await expect(backdrop).not.toHaveAttribute('inert', '');

    await window.setViewportSize({ width: 1024, height: 720 });
    await expect(sidebar).toHaveAttribute('aria-modal', 'true');
    await expect(backdrop).not.toHaveAttribute('inert', '');
    await expect(backdrop).not.toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => dialog.evaluate(
      (element) => element.contains(document.activeElement),
    )).toBe(true);
    await expect.poll(() => window.locator('.dock-host').evaluate(
      (element) => element.closest('[inert]') !== null,
    )).toBe(true);

    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(sidebar).toBeVisible();
    await expect(window.locator('.dock-host')).toHaveAttribute('inert', '');
    await expect.poll(() => sidebar.evaluate(
      (element) => element.contains(document.activeElement),
    )).toBe(true);
    await expect.poll(() => window.getByTestId('shell-live-strip').evaluate(
      (element) => element.closest('[inert]') === null,
    )).toBe(true);

    await window.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect(window.locator('.dock-host')).not.toHaveAttribute('inert', '');
  } finally {
    await app.close();
  }
});

test('wide shell reflows once, switches destinations in place, and resizes by keyboard', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => window.evaluate(() => matchMedia('(min-width: 1200px)').matches)).toBe(true);

    const dockBefore = await window.locator('.dock-host').boundingBox();
    await toggleWorkbenchTool(window, 'btn-toggle-stats');
    const sidebar = window.getByTestId('workbench-sidebar');
    await expect(sidebar).toHaveAttribute('data-destination', 'monitor');
    expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('relative');
    expect(await window.locator('.workbench-sidebar-scrim').evaluate((element) => getComputedStyle(element).display))
      .toBe('none');

    const dockAfter = await window.locator('.dock-host').boundingBox();
    expect(dockAfter?.x).toBeGreaterThan(dockBefore?.x ?? 0);
    expect(dockAfter?.width).toBeLessThan(dockBefore?.width ?? Number.POSITIVE_INFINITY);

    await toggleWorkbenchTool(window, 'rail-remote');
    await expect(window.getByTestId('workbench-sidebar')).toHaveCount(1);
    await expect(sidebar).toHaveAttribute('data-destination', 'remote');
    await expect(window.getByTestId('remote-panel')).toBeVisible();

    const resizer = window.getByTestId('sidebar-resizer');
    const widthBefore = Number(await resizer.getAttribute('aria-valuenow'));
    await resizer.focus();
    await resizer.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(widthBefore + 8));
  } finally {
    await app.close();
  }
});

test('the folded strip opens the full list over the dock and closes it after a choice', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await enterWorkMode(window);
    await window.getByTestId('shell-strip-unfold').click();
    const overlay = window.getByTestId('shell-live-overlay');
    await expect(overlay.getByTestId('shell-live-list')).toBeVisible();
    // The strip keeps the ids; the opened list does not repeat them.
    await expect(window.getByTestId('btn-new-tab')).toHaveCount(1);
    await overlay.getByTestId('shell-live-new-terminal').click();
    await expect(overlay).toHaveCount(0);
    await expect(window.getByTestId('pane')).toHaveCount(2);
    await window.getByTestId('shell-strip-unfold').click();
    await expect(overlay).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    // From 1100px the full list stands in place of the strip.
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect(window.getByTestId('shell-live-list')).toBeVisible();
    await expect(window.getByTestId('shell-live-strip')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Ctrl+` brings a terminal forward and goes back; the board hides the dock without unmounting it', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await enterWorkMode(window);
    const body = window.locator('.workbench-body');
    const terminalPane = window.getByTestId('pane').first();
    await expect(terminalPane).toBeVisible();

    // The board takes the dock's place; the terminal stays mounted under it.
    await window.getByTestId('shell-back-to-board').click();
    await expect(body).toHaveAttribute('data-shell-mode', 'board');
    await expect(window.getByTestId('shell-board')).toBeVisible();
    await expect(window.locator('.dock-host')).toHaveAttribute('inert', '');
    await expect(window.getByTestId('pane')).toHaveCount(1);

    await window.keyboard.press('Control+Backquote');
    await expect(body).toHaveAttribute('data-shell-mode', 'work');
    await expect(terminalPane).toBeVisible();
    // Again: back where it came from.
    await window.keyboard.press('Control+Backquote');
    await expect(body).toHaveAttribute('data-shell-mode', 'board');
  } finally {
    await app.close();
  }
});

test('focus or scrollIntoView inside a panel never scrolls the shell itself', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    // Hidden dockview panels and tall panel content overflow the dock host; the shell
    // must clip that overflow rather than become programmatically scrollable.
    const scrolled = await window.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.workbench-body')!;
      const tall = document.createElement('div');
      tall.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:4000px';
      body.appendChild(tall);
      body.scrollTop = 300;
      tall.scrollIntoView({ block: 'end' });
      const result = body.scrollTop;
      tall.remove();
      return result;
    });
    expect(scrolled).toBe(0);
  } finally {
    await app.close();
  }
});
