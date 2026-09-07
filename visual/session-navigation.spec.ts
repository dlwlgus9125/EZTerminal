import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const width of [800, 1024, 1200, 1440]) {
  for (const scale of [100, 150]) {
    test(`terminal-first header keeps every action reachable at ${width} / ${scale}%`, async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: {
          getWindowState: async () => ({ maximized: false, fullscreen: false }),
          performWindowAction: async () => undefined,
          onWindowStateChanged: () => () => undefined,
        } });
      });
      await page.setViewportSize({ width, height: 720 });
      const globals = encodeURIComponent(`theme:dark;locale:en;density:adaptive;uiScale:${scale}`);
      await page.goto(`/iframe.html?id=compositions-app-header--effects-off&viewMode=story&globals=${globals}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-story-ready', `compositions-app-header--effects-off|dark|en|adaptive|${scale}`, { timeout: 60000 });
      await expect(page.getByTestId('btn-new-tab')).toHaveText('New Terminal');
      await expect(page.getByTestId('window-controls')).toBeVisible();
      for (const id of ['btn-new-session', 'btn-new-tab', 'btn-command-center', 'btn-workspace-menu', 'btn-toggle-agents']) await page.getByTestId(id).click({ trial: true, timeout: 2000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

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
    await page.getByTestId('session-cli-launcher').selectOption('codex-cli');
    await expect(page.getByTestId('session-cli-model')).toHaveValue('default');
    await page.getByTestId('session-cli-model').selectOption('custom');
    await expect(page.getByTestId('session-cli-start')).toBeDisabled();
    await page.getByTestId('session-cli-model-name').fill('my-model');
    await expect(page.getByTestId('session-cli-start')).toBeEnabled();
    await page.getByTestId('session-cli-start').click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath('terminal-cli-model.png'), animations: 'disabled' });
    await page.getByTestId('new-session-agent').click();
    await expect(page.getByTestId('new-session-cli')).toHaveCount(0);
    await expect(page.getByTestId('structured-agent-draft').getByRole('textbox')).toHaveCount(0);
    await expect(page.getByTestId('structured-agent-model')).not.toBeVisible();
    await expect(page.getByTestId('structured-agent-create')).toBeEnabled();
    await page.getByTestId('structured-agent-create').click({ trial: true });
    await expect(page.getByTestId('new-session-project')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('new-session-workspace')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('agent-create.png'), animations: 'disabled' });
    const agentResults = await new AxeBuilder({ page }).include('#storybook-root').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(agentResults.violations).toEqual([]);
  });
}

for (const [width, locale] of [[1440, 'en'], [390, 'ko']] as const) {
  test(`terminal-first settings stay compact at ${width} in ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const globals = encodeURIComponent(`theme:dark;locale:${locale};density:adaptive;uiScale:100`);
    await page.goto(`/iframe.html?id=settings-agents--overview&viewMode=story&globals=${globals}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-story-ready', `settings-agents--overview|dark|${locale}|adaptive|100`, { timeout: 60000 });
    await expect(page.getByTestId('agent-integration-codex')).toBeVisible();
    await expect(page.getByTestId('structured-provider-codex')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('settings.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const result = await new AxeBuilder({ page }).include('#storybook-root').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations).toEqual([]);
  });
}
