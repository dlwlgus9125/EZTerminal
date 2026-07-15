import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

// v0.2.0 M6: dockview's built-in tab-strip overflow (D3/M3) — a narrow window
// with many tabs clips the `.dv-tabs-container` strip and shows the built-in
// "N hidden" chip (`.dv-tabs-overflow-dropdown-default`), which M3 themed
// (previously unstyled, so effectively invisible — the actual cause of "tabs
// get clipped and lost"). Also proves App.tsx's onDidActivePanelChange
// scrollIntoView nudge (M3) actually keeps the active tab inside the visible
// strip once it's activated via the __ezDock seam (the same call a click on
// an overflow-dropdown entry makes — see drag-layout.spec.ts for the seam).

test('tab overflow: narrow window with many tabs shows the overflow chip and scrolls the active tab into view', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setBounds({ width: 800, height: 600 });
  });

  // 1 default pane + 13 new tabs = 14, enough to overflow at the supported
  // 800x600 minimum window while keeping the responsive contract realistic.
  for (let i = 0; i < 13; i++) {
    await window.getByTestId('btn-new-tab').click();
  }
  await expect(window.getByTestId('pane')).toHaveCount(14);

  const tabsContainer = window.locator('.ez-dock .dv-tabs-container');
  await expect
    .poll(() => tabsContainer.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);

  await expect(window.locator('.ez-dock .dv-tabs-overflow-dropdown-default')).toBeVisible();

  // tab-1 (the very first tab) is now scrolled out of view, since each new
  // tab became active in turn. Activate it via the same dockview API a click
  // on the overflow dropdown's entry would use, and confirm the app's
  // scrollIntoView nudge actually brings it back inside the strip's viewport.
  await window.evaluate(() => {
    type EzDockPanel = { id: string; api: { setActive(): void } };
    const dock = (globalThis as unknown as { __ezDock?: { panels: EzDockPanel[] } }).__ezDock;
    if (!dock) throw new Error('__ezDock test seam missing');
    const first = dock.panels.find((p) => p.id === 'tab-1');
    if (!first) throw new Error('expected panel tab-1');
    first.api.setActive();
  });

  await expect
    .poll(async () => {
      const tabRect = await window.locator('.ez-dock .dv-tab.dv-active-tab').boundingBox();
      const containerRect = await tabsContainer.boundingBox();
      if (!tabRect || !containerRect) return false;
      return (
        tabRect.x >= containerRect.x - 2 &&
        tabRect.x + tabRect.width <= containerRect.x + containerRect.width + 2
      );
    })
    .toBe(true);

  await app.close();
});
