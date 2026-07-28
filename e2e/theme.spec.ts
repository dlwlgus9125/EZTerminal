import {
  createRegisteredE2eTempDir,
  test,
  expect,
  type Page,
} from './test';

import { launchApp } from './launch-app';

// Built-in themes live in Settings > Appearance. Matrix is the boot default;
// selecting a theme applies immediately and persists across relaunches.

function tempUserData(): string {
  return createRegisteredE2eTempDir('ezterm-theme-e2e-');
}

async function openThemeSettings(page: Page) {
  await expect(page.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await page.getByTestId('btn-toggle-settings').click();
  await page.getByTestId('settings-category-appearance').click();
  return page.getByTestId('settings-theme-select');
}

test('theme selection applies immediately and persists across relaunch', async () => {
  const dir = tempUserData();

  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  const select = await openThemeSettings(w1);
  await expect(select).toHaveValue('matrix');
  // The label reflects React state, which now boots as 'matrix' BEFORE the
  // async getTheme() round-trip sets data-theme — wait for the attribute so
  // the --term-bg read below sees matrix values, not the pre-boot defaults.
  await expect
    .poll(() => w1.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('matrix');

  const matrixBg = await w1.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
  );

  await select.selectOption('dark');
  await expect(select).toHaveValue('dark');
  await expect
    .poll(() => w1.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('dark');

  // A CSS var actually changed under the new attribute, not just the label.
  const darkBg = await w1.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(),
  );
  expect(darkBg).not.toBe(matrixBg);

  await app1.close();

  // Relaunch with the SAME userData dir — the persisted (non-default) choice
  // must survive, not fall back to the matrix boot default.
  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  const persistedSelect = await openThemeSettings(w2);
  await expect(persistedSelect).toHaveValue('dark', { timeout: 15_000 });
  await expect
    .poll(() => w2.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('dark');
  await app2.close();
});
