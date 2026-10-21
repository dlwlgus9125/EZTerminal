import { expect, test } from './test';

for (const viewport of [{ width: 1024, height: 720 }, { width: 1440, height: 900 }]) {
  test(`Tools menu remains actionable above the open sidebar at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const globals = encodeURIComponent('theme:dark;locale:en;density:adaptive;uiScale:100');
    await page.goto(`/iframe.html?id=compositions-workbench-shell--tools-navigation&viewMode=story&globals=${globals}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-story-ready', 'compositions-workbench-shell--tools-navigation|dark|en|adaptive|100', { timeout: 60_000 });
    const sidebar = page.getByTestId('workbench-sidebar');
    await expect(sidebar).toHaveAttribute('data-destination', 'explorer');
    const tools = page.getByTestId('rail-tools');
    await tools.click();
    await expect(page.getByRole('menu', { name: 'Tools' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('tools-menu-open.png') });

    // A normal pointer click must reach the menu over the existing panel.
    await page.getByTestId('btn-toggle-stats').click({ timeout: 3_000 });
    await expect(sidebar).toHaveAttribute('data-destination', 'monitor');
    await expect(tools).toBeFocused();

    await tools.press('ArrowDown');
    await expect(page.getByTestId('btn-toggle-stats')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Tools' })).toHaveCount(0);
    await expect(sidebar).toHaveAttribute('data-destination', 'monitor');
    await expect(tools).toBeFocused();

    await tools.click();
    await page.getByTestId('btn-toggle-stats').click({ timeout: 3_000 });
    await expect(sidebar).toHaveCount(0);
    await expect(tools).toBeFocused();
  });
}
