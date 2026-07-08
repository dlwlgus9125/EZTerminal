import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './launch-app';

// crt-interference M2: the four parameterized CRT-interference effects
// (jitter-burst / micro-jitter / static-noise / upgraded flicker) — toggle
// wiring, param-slider → CSS-var/keyframes plumbing, and the flicker
// decoupling + micro-jitter composition rules. Motion LOOKS are covered by
// the phase-frozen visual-verification pass (M4), not asserted here.

const NEW_EFFECT_IDS = ['jitter-burst', 'micro-jitter', 'static-noise', 'flicker'] as const;

async function openMatrixSettings(window: Page): Promise<void> {
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await window.getByTestId('btn-toggle-settings').click();
  await window.getByTestId('settings-theme-select').selectOption('matrix');
}

function effectAttr(window: Page, id: string): Promise<string | null> {
  return window.evaluate((eid) => document.documentElement.getAttribute(`data-effect-${eid}`), id);
}

/** Set a React-controlled range input (Playwright fill() rejects type=range):
 * the native value setter + a bubbling 'input' event is what React's onChange
 * actually listens for. */
async function setSlider(window: Page, testId: string, value: number): Promise<void> {
  await window.evaluate(
    ({ testId: tid, value: v }) => {
      const el = document.querySelector<HTMLInputElement>(`[data-testid="${tid}"]`);
      if (!el) throw new Error(`slider ${tid} not found`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    { testId, value },
  );
}

test('Matrix declares all four interference effects, strictly opt-in (toggles unchecked, no data-effect attrs)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  for (const id of NEW_EFFECT_IDS) {
    const toggle = window.getByTestId(`settings-effect-${id}`);
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked(); // defaultOn:false — opt-in on desktop too
    expect(await effectAttr(window, id)).toBeNull();
    // each parameterized effect exposes its slider group beneath the toggle
    await expect(window.getByTestId(`settings-fx-${id}-params`)).toBeVisible();
  }

  await app.close();
});

test('each interference toggle flips its data-effect attribute on and off', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  for (const id of NEW_EFFECT_IDS) {
    const toggle = window.getByTestId(`settings-effect-${id}`);
    await toggle.check();
    await expect.poll(() => effectAttr(window, id)).toBe('on');
    await toggle.uncheck();
    await expect.poll(() => effectAttr(window, id)).toBeNull();
  }

  await app.close();
});

test('the burst period slider rewrites --fx-burst-period and regenerates #ez-fx-keyframes', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  // boot applies the default params, so the generated block already exists
  await expect
    .poll(() => window.evaluate(() => document.getElementById('ez-fx-keyframes')?.textContent ?? ''))
    .toContain('@keyframes fx-jitter-burst');

  await window.getByTestId('settings-effect-jitter-burst').check();
  await setSlider(window, 'settings-fx-jitter-burst-period', 12);

  await expect
    .poll(() =>
      window.evaluate(() => document.documentElement.style.getPropertyValue('--fx-burst-period')),
    )
    .toBe('12s');
  // 250ms default burst in a 12s cycle -> window f = 250/1000/12*100 = 2.08%
  // — the regenerated keyframes carry the recomputed stop.
  await expect
    .poll(() => window.evaluate(() => document.getElementById('ez-fx-keyframes')?.textContent ?? ''))
    .toContain('2.08%');

  await app.close();
});

test('upgraded flicker runs standalone with scanlines OFF (decoupled from the old scanlines-bound stub)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  await window.getByTestId('settings-effect-scanlines').uncheck();
  await expect.poll(() => effectAttr(window, 'scanlines')).toBeNull();

  await window.getByTestId('settings-effect-flicker').check();
  await expect.poll(() => effectAttr(window, 'flicker')).toBe('on');
  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.getElementById('root')!).animationName),
    )
    .toContain('fx-flicker');

  await app.close();
});

test('micro-jitter and flicker compose on #root (both animations listed, neither drops the other)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  await window.getByTestId('settings-effect-micro-jitter').check();
  await window.getByTestId('settings-effect-flicker').check();

  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.getElementById('root')!).animationName),
    )
    .toContain('fx-micro-jitter');
  expect(
    await window.evaluate(() => getComputedStyle(document.getElementById('root')!).animationName),
  ).toContain('fx-flicker');

  await app.close();
});
