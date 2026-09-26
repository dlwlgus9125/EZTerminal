import { test, expect } from './test';

import { launchApp } from './launch-app';

test('Matrix UI composes flicker with micro-jitter and keeps the rollbar inside the viewport', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1_200, height: 655 });
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
  )).not.toContain('fx-flicker');
  expect(await window.evaluate(
    () => getComputedStyle(document.getElementById('root')!).opacity,
  )).toBe('1');
  expect(await window.evaluate(() => {
    const overlay = document.getElementById('ez-fx-flicker')!;
    const style = getComputedStyle(overlay);
    return {
      sibling: overlay.parentElement === document.body,
      animation: style.animationName,
      pointerEvents: style.pointerEvents,
    };
  })).toEqual({ sibling: true, animation: 'fx-flicker', pointerEvents: 'none' });

  // A stuck animation, or an out-of-range CSS parameter, cannot paint an
  // opaque black rectangle. This asserts the browser's computed paint alpha.
  const boundedColor = await window.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--fx-flicker-min');
    root.style.setProperty('--fx-flicker-min', '-10');
    const color = getComputedStyle(document.getElementById('ez-fx-flicker')!).backgroundColor;
    root.style.setProperty('--fx-flicker-min', previous);
    return color;
  });
  expect(boundedColor).toBe('rgba(0, 0, 0, 0.4)');

  await window.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'ez-test-rollbar-pin';
    style.textContent =
      "html[data-effect-crt-rollbar='on'] body::after {" +
      'animation-delay: calc(-0.99 * var(--fx-rollbar-duration, 16.8s)) !important;' +
      'animation-play-state: paused !important;' +
      '}' +
      "html[data-effect-micro-jitter='on'][data-effect-flicker='on'] #root {" +
      'animation: none !important;' +
      'transform: translate(0, var(--fx-micro-amp, 1px)) !important;' +
      '}';
    document.head.appendChild(style);
  });
  const extent = await window.evaluate(() => {
    const element = document.scrollingElement as HTMLElement;
    return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  expect(extent.scrollHeight).toBeLessThanOrEqual(extent.clientHeight);
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await expect(window.locator('#ez-fx-flicker')).toHaveCount(0);
  await app.close();
});
