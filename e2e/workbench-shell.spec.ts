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
    expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
    await expect(window.locator('.workbench-sidebar-scrim')).toBeVisible();
    expect(await window.locator('.dock-host').boundingBox()).toEqual(dockBefore);

    await window.keyboard.press('Escape');
    await expect(sidebar).toHaveCount(0);
    await expect.poll(() => explorer.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
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

test('settings exposes exactly the approved six categories', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await window.getByTestId('btn-toggle-settings').click();
    const categories = window.locator('.settings-category-button');
    await expect(categories).toHaveCount(6);
    for (const id of ['general', 'appearance', 'terminal', 'agents', 'integrations', 'about']) {
      await expect(window.getByTestId(`settings-category-${id}`)).toBeVisible();
    }

    await window.getByTestId('settings-category-appearance').click();
    await expect(window.locator('.settings-category-content')).toHaveAttribute('data-active-category', 'appearance');
    await expect(window.getByTestId('settings-theme-select')).toBeVisible();
    await expect(window.getByTestId('settings-locale')).toBeHidden();
  } finally {
    await app.close();
  }
});
