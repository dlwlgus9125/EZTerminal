import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

test('narrow status panel isolates focus and restores terminal use without reflow', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1024, height: 720 });
  await expect.poll(() => window.evaluate(
    () => matchMedia('(max-width: 1199px)').matches,
  )).toBe(true);

  const panel = window.getByTestId('status-panel');
  const sidebar = window.getByTestId('workbench-sidebar');
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
  await expect(sidebar).toHaveAttribute('role', 'dialog');
  await expect(sidebar).toHaveAttribute('aria-modal', 'true');
  await expect(window.locator('.dock-host')).toHaveAttribute('inert', '');
  expect(await pane.boundingBox()).toEqual(before);

  await window.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(window.locator('.dock-host')).not.toHaveAttribute('inert', '');
  await expect(toggle).toBeFocused();
  expect(await pane.boundingBox()).toEqual(before);

  const input = window.getByTestId('cmd-input');
  await input.fill('cd C:\\Windows');
  await input.press('Enter');
  await expect(window.getByTestId('prompt-cwd')).toHaveAttribute('title', 'C:\\Windows', {
    timeout: 10_000,
  });

  await app.close();
});
