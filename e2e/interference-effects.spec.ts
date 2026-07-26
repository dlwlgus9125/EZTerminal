import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

test('Matrix UI composes flicker with micro-jitter and keeps the rollbar inside the viewport', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await window.getByTestId('btn-toggle-settings').click();
  await window.getByTestId('settings-category-appearance').click();
  await window.getByTestId('settings-theme-select').selectOption('matrix');

  await window.getByTestId('settings-effect-flicker').check();
  await window.getByTestId('settings-effect-micro-jitter').check();
  await window.getByTestId('settings-effect-crt-rollbar').check();

  await expect.poll(() => window.evaluate(
    () => document.documentElement.getAttribute('data-effect-flicker'),
  )).toBe('on');
  await expect.poll(() => window.evaluate(
    () => document.documentElement.getAttribute('data-effect-micro-jitter'),
  )).toBe('on');
  await expect.poll(() => window.evaluate(
    () => getComputedStyle(document.getElementById('root')!).animationName,
  )).toContain('fx-micro-jitter');
  expect(await window.evaluate(
    () => getComputedStyle(document.getElementById('root')!).animationName,
  )).toContain('fx-flicker');

  await window.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'ez-test-rollbar-pin';
    style.textContent =
      "html[data-effect-crt-rollbar='on'] body::after {" +
      'animation-delay: calc(-0.99 * var(--fx-rollbar-duration, 16.8s)) !important;' +
      'animation-play-state: paused !important;' +
      '}';
    document.head.appendChild(style);
  });
  const extent = await window.evaluate(() => {
    const element = document.scrollingElement as HTMLElement;
    return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  expect(extent.scrollHeight).toBeLessThanOrEqual(extent.clientHeight);
  await app.close();
});
