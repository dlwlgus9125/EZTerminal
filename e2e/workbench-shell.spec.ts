import { expect, test } from '@playwright/test';

import { launchApp } from './launch-app';

test('desktop shell has four header zones and a focus-restoring overlay sidebar', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    await expect(window.locator('.workbench-header > .workbench-header-zone')).toHaveCount(4);
    await expect(window.getByTestId('btn-new-tab')).toBeVisible();
    await expect(window.getByTestId('btn-command-center')).toBeVisible();
    await expect(window.getByTestId('btn-workspace-menu')).toBeVisible();
    await expect(window.getByTestId('btn-toggle-agents')).toBeVisible();
    await expect(window.locator('.app-head')).toHaveCount(0);

    const workspace = window.getByTestId('btn-workspace-menu');
    await workspace.focus();
    await workspace.press('ArrowDown');
    await expect(window.getByTestId('preset-menu')).toBeVisible();
    await expect.poll(() => window.getByTestId('btn-split-right').evaluate((element) => document.activeElement === element))
      .toBe(true);
    await window.keyboard.press('ArrowDown');
    await expect.poll(() => window.getByTestId('btn-split-down').evaluate((element) => document.activeElement === element))
      .toBe(true);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('preset-menu')).toHaveCount(0);
    await expect.poll(() => workspace.evaluate((element) => document.activeElement === element)).toBe(true);

    const explorer = window.getByTestId('btn-toggle-files');
    const dockBefore = await window.locator('.dock-host').boundingBox();
    await explorer.click();

    const sidebar = window.getByTestId('workbench-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-destination', 'explorer');
    expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('absolute');
    await expect(window.locator('.workbench-sidebar-scrim')).toBeVisible();
    expect(await window.locator('.dock-host').boundingBox()).toEqual(dockBefore);

    await window.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect.poll(() => explorer.evaluate((element) => document.activeElement === element)).toBe(true);

    const commandCenter = window.getByTestId('btn-command-center');
    await commandCenter.click();
    await expect(window.getByTestId('quick-open-modal')).toBeVisible();
    await window.getByTestId('quick-open-row-action-open-explorer').click();
    await expect(sidebar).toBeVisible();
    await expect.poll(() => sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(window.locator('.dock-host')).toHaveAttribute('inert', '');
    await window.keyboard.press('Shift+Tab');
    await expect.poll(() => sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await window.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect.poll(() => commandCenter.evaluate((element) => document.activeElement === element)).toBe(true);

    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('narrow rail, scrim, and sidebar share one scaled geometry at 800 and 1024 pixels', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    const samples: Array<{
      label: string;
      scrimAligned: boolean;
      sidebarAligned: boolean;
      railContainsButton: boolean;
    }> = [];

    const sampleGeometry = async (label: string): Promise<void> => {
      const rail = await window.locator('.activity-rail').boundingBox();
      const railButton = await window.getByTestId('btn-toggle-files').boundingBox();
      const scrim = await window.locator('.workbench-sidebar-scrim').boundingBox();
      const sidebar = await window.getByTestId('workbench-sidebar').boundingBox();
      expect(rail).not.toBeNull();
      expect(railButton).not.toBeNull();
      expect(scrim).not.toBeNull();
      expect(sidebar).not.toBeNull();
      if (!rail || !railButton || !scrim || !sidebar) return;

      const railEnd = rail.x + rail.width;
      samples.push({
        label,
        scrimAligned: Math.abs(scrim.x - railEnd) <= 1,
        sidebarAligned: Math.abs(sidebar.x - railEnd) <= 1,
        railContainsButton:
          railButton.x >= rail.x
          && railButton.x + railButton.width <= railEnd,
      });
    };

    await window.setViewportSize({ width: 800, height: 600 });
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
      { label: '800x600@100', scrimAligned: true, sidebarAligned: true, railContainsButton: true },
      { label: '800x600@150', scrimAligned: true, sidebarAligned: true, railContainsButton: true },
      { label: '1024x720@150', scrimAligned: true, sidebarAligned: true, railContainsButton: true },
      { label: '1024x720@100', scrimAligned: true, sidebarAligned: true, railContainsButton: true },
    ]);
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
    await window.getByTestId('btn-toggle-stats').click();
    const sidebar = window.getByTestId('workbench-sidebar');
    await expect(sidebar).toHaveAttribute('data-destination', 'monitor');
    expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('relative');
    expect(await window.locator('.workbench-sidebar-scrim').evaluate((element) => getComputedStyle(element).display))
      .toBe('none');

    const dockAfter = await window.locator('.dock-host').boundingBox();
    expect(dockAfter?.x).toBeGreaterThan(dockBefore?.x ?? 0);
    expect(dockAfter?.width).toBeLessThan(dockBefore?.width ?? Number.POSITIVE_INFINITY);

    await window.getByTestId('rail-remote').click();
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
