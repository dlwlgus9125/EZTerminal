import type { DockviewApi, IDockviewPanel, AddPanelOptions } from 'dockview-react';
import type { DockPanelPlacementIntent } from '../src/renderer/dock-window-coordinator';
type DockPanelOptions = Omit<AddPanelOptions, 'position' | 'floating'>;
type R7Window = { __ezDock: DockviewApi; __r7OriginalPanel: IDockviewPanel; __r7OriginalId: string; __ezAddDockPanel: (options: DockPanelOptions, placement: DockPanelPlacementIntent) => unknown; __ezLayoutFlush: () => Promise<void> };
import { expect, test } from './test';
import { launchApp } from './launch-app';

test('workspaces keep live panels, independent split groups and durable membership', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    const bars = page.getByTestId('workbench-views');
    // Board + Desk: work sets live in the work-mode layout menu.
    const openViews = async (): Promise<void> => {
      if (!await bars.isVisible()) await page.getByTestId('btn-workspace-menu').click();
      await expect(bars).toBeVisible();
    };
    await openViews();
    // The view bar can render before the first panel is added; on a slow runner panels[0] was undefined.
    await expect.poll(() => page.evaluate(() => (window as unknown as Partial<R7Window>).__ezDock?.panels.length ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() => {
      const dock = (window as unknown as R7Window).__ezDock;
      const panel = dock.panels[0];
      (window as unknown as R7Window).__r7OriginalPanel = panel;
      (window as unknown as R7Window).__r7OriginalId = panel.id;
    });
    await bars.getByRole('button', { name: 'New workspace', exact: true }).click();
    await expect(bars.getByRole('tab')).toHaveCount(2);
    await page.evaluate(() => (window as unknown as R7Window).__ezAddDockPanel({ id: 'r7-terminal', component: 'terminal', title: 'R7 terminal', renderer: 'always', params: { lastSurface: 'terminal' } }, { kind: 'main-tab' }));
    await expect.poll(() => page.evaluate(() => (window as unknown as R7Window).__ezDock.getPanel('r7-terminal')!.group.api.isVisible)).toBe(true);
    await bars.getByRole('tab').first().click();
    expect(await page.evaluate(() => {
      const dock = (window as unknown as R7Window).__ezDock;
      return dock.getPanel((window as unknown as R7Window).__r7OriginalId) === (window as unknown as R7Window).__r7OriginalPanel
        && dock.getPanel((window as unknown as R7Window).__r7OriginalId)!.group.api.isVisible
        && !dock.getPanel('r7-terminal')!.group.api.isVisible;
    })).toBe(true);
    await bars.getByRole('tab').nth(1).click();
    await page.evaluate(() => (window as unknown as R7Window).__ezAddDockPanel({ id: 'r7-second', component: 'terminal', title: 'Second terminal', renderer: 'always', params: { lastSurface: 'terminal' } }, { kind: 'split', referencePanelId: 'r7-terminal', direction: 'below' }));
    expect(await page.evaluate(() => (window as unknown as R7Window).__ezDock.getPanel('r7-terminal')!.group.id !== (window as unknown as R7Window).__ezDock.getPanel('r7-second')!.group.id)).toBe(true);
    await page.evaluate(() => (window as unknown as R7Window).__ezDock.getPanel('r7-second')!.group.api.setSize({ height: 240 }));
    const height = await page.evaluate(() => (window as unknown as R7Window).__ezDock.getPanel('r7-second')!.group.api.height);
    await bars.getByRole('tab').first().click();
    await bars.getByRole('tab').nth(1).click();
    expect(Math.abs(await page.evaluate(() => (window as unknown as R7Window).__ezDock.getPanel('r7-second')!.group.api.height) - height)).toBeLessThan(3);
    await page.screenshot({ path: 'artifacts/conversation-r7/electron-split-workspace.png' });
    expect(await page.evaluate(() => (window as unknown as R7Window).__ezDock.getPanel('r7-terminal')!.group.id !== (window as unknown as R7Window).__ezDock.getPanel('r7-second')!.group.id)).toBe(true);
    await page.evaluate(() => (window as unknown as R7Window).__ezLayoutFlush());
    await page.reload();
    await openViews();
    await expect(page.getByTestId('workbench-views').getByRole('tab')).toHaveCount(2);
    await page.getByTestId('workbench-views').getByRole('button', { name: /Close workspace/ }).nth(1).click();
    await expect(page.getByTestId('workbench-views').getByRole('tab')).toHaveCount(1);
    expect(await page.evaluate(() => !!(window as unknown as R7Window).__ezDock.getPanel('r7-terminal') && !!(window as unknown as R7Window).__ezDock.getPanel('r7-second'))).toBe(true);
  } finally { await app.close(); }
});

