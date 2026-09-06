import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('new-session header preserves the Command Center pointer target with native window controls', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: {
      getWindowState: async () => ({ maximized: false, fullscreen: false }),
      performWindowAction: async () => undefined,
      onWindowStateChanged: () => () => undefined,
    } });
  });
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto('/iframe.html?id=compositions-app-header--effects-off&viewMode=story', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-story-ready', /compositions-app-header--effects-off/u, { timeout: 60000 });
  await expect(page.getByTestId('btn-new-session')).toBeVisible();
  await expect(page.getByTestId('window-controls')).toBeVisible();
  await page.getByTestId('btn-command-center').click({ trial: true, timeout: 2000 });
  for (const width of [800, 1024, 1200, 1440]) {
    for (const scale of [100, 150]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(`/iframe.html?id=compositions-app-header--effects-off&viewMode=story&globals=uiScale:${scale}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-story-ready', new RegExp(`\\|${scale}$`, 'u'), { timeout: 60000 });
      for (const id of ['btn-new-session', 'btn-new-tab', 'btn-command-center', 'btn-workspace-menu', 'btn-toggle-agents']) await page.getByTestId(id).click({ trial: true, timeout: 2000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

for (const [width, height, locale] of [[1440, 900, 'en'], [800, 600, 'ko'], [390, 844, 'ko']] as const) {
  test(`new-session choices stay accessible at ${width} in ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const globals = encodeURIComponent(`theme:dark;locale:${locale};density:adaptive;uiScale:100`);
    await page.goto(`/iframe.html?id=sessions-new-session--conversation&viewMode=story&globals=${globals}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-story-ready', `sessions-new-session--conversation|dark|${locale}|adaptive|100`, { timeout: 60000 });
    await expect(page.getByTestId('new-session-draft')).toBeVisible();
    await expect(page.getByTestId('new-session-terminal')).toHaveText(locale === 'ko' ? '터미널' : 'Terminal');
    await page.getByTestId('new-session-terminal').click();
    await expect(page.getByTestId('new-session-open-terminal')).toBeEnabled();
    await page.getByTestId('new-session-open-terminal').click({ trial: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('terminal-choice.png'), animations: 'disabled' });
    await testInfo.attach('terminal-choice', { path: testInfo.outputPath('terminal-choice.png'), contentType: 'image/png' });
    const results = await new AxeBuilder({ page }).include('#storybook-root').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
    await page.getByTestId('new-session-agent').click();
    await page.screenshot({ path: testInfo.outputPath('agent-conversation.png'), animations: 'disabled' });
    await page.getByTestId('new-session-cli').click();
    await expect(page.getByTestId('session-cli-launcher')).toBeVisible();
    await expect(page.getByTestId('new-session-project')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('new-session-workspace')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('agent-cli.png'), animations: 'disabled' });
  });
}
