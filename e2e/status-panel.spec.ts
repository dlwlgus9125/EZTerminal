import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

test('status panel is a non-interfering overlay that toggles without reflow', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const panel = window.getByTestId('status-panel');
  const toggle = window.getByTestId('btn-toggle-stats');
  const pane = window.getByTestId('pane');
  await expect(panel).toHaveCount(0);
  await expect(pane).toBeVisible();

  let before: { x: number; y: number; width: number; height: number } | null = null;
  await expect(async () => {
    const first = await pane.boundingBox();
    await window.waitForTimeout(150);
    const second = await pane.boundingBox();
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    before = second;
  }).toPass({ timeout: 10_000 });

  await toggle.click();
  await expect(panel).toBeVisible();
  expect(await pane.boundingBox()).toEqual(before);

  const input = window.getByTestId('cmd-input');
  await input.fill('cd C:\\Windows');
  await input.press('Enter');
  await expect(window.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  await toggle.click();
  await expect(panel).toHaveCount(0);
  expect(await pane.boundingBox()).toEqual(before);
  await app.close();
});
