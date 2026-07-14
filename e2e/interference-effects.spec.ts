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
  await window.getByTestId('settings-category-appearance').click();
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

test('Matrix keeps every moving interference effect opt-in', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  for (const id of NEW_EFFECT_IDS) {
    const toggle = window.getByTestId(`settings-effect-${id}`);
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
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
  // 100ms default burst in a 12s cycle -> f = 100/1000/12*100 = 0.83%,
  // floored to the 1% minimum — the regenerated keyframes carry it.
  await expect
    .poll(() => window.evaluate(() => document.getElementById('ez-fx-keyframes')?.textContent ?? ''))
    .toContain('1.00% { opacity: 0; }');

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

test('crt-rollbar never adds a document scrollbar — the overlay stays inside the viewport', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openMatrixSettings(window);

  // Moving effects are opt-in; enable the rollbar for this geometry guard.
  await window.getByTestId('settings-effect-crt-rollbar').check();
  await expect.poll(() => effectAttr(window, 'crt-rollbar')).toBe('on');

  // Keep burst jitter off so the only effect that could add scrollable area is
  // the rollbar overlay.
  await expect.poll(() => effectAttr(window, 'jitter-burst')).toBeNull();

  // Freeze the sweep near the END of its cycle. A negative animation-delay sets
  // the phase whichever property the sweep animates — background-position (the
  // fix, overlay pinned inset:0) OR translateY (the old oversized-box approach,
  // whose box would by now sit ~70vh below the viewport). So this guard is
  // approach-agnostic: it stays green for the viewport-pinned overlay and fails
  // if anyone reintroduces an element that translates past the viewport.
  await window.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'ez-test-rollbar-pin';
    s.textContent =
      "html[data-effect-crt-rollbar='on'] body::after {" +
      'animation-delay: calc(-0.99 * var(--fx-rollbar-duration, 16.8s)) !important;' +
      'animation-play-state: paused !important;' +
      '}';
    document.head.appendChild(s);
  });

  // The document must not become vertically scrollable: compare the semantic
  // extents directly. At fractional Windows DPR, Chromium may clamp scrollTop
  // to one physical pixel (for example 0.8 CSS px) even when these are equal.
  const extent = await window.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(extent.scrollHeight).toBeLessThanOrEqual(extent.clientHeight);

  await app.close();
});
