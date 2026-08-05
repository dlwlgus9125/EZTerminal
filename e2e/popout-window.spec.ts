import {
  createRegisteredE2eTempDir,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from './test';

import { launchApp } from './launch-app';

const panes = (page: Page) => page.getByTestId('pane');

async function sessionIdOf(page: Page): Promise<string> {
  await expect(panes(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(panes(page)).toHaveAttribute('data-session-id', /.+/, {
    timeout: 15_000,
  });
  return (await panes(page).getAttribute('data-session-id')) as string;
}

async function flushLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seam = globalThis as unknown as { __ezLayoutFlush?: () => Promise<void> };
    if (!seam.__ezLayoutFlush) throw new Error('__ezLayoutFlush seam missing');
    return seam.__ezLayoutFlush();
  });
}

async function addPopoutGroup(page: Page, panelId = 'tab-1'): Promise<void> {
  const opened = await page.evaluate(async (id) => {
    type EzDockPanel = { id: string };
    type EzDockApi = {
      panels: EzDockPanel[];
      addPopoutGroup(
        panel: EzDockPanel,
        options: {
          position: { left: number; top: number; width: number; height: number };
        },
      ): Promise<boolean>;
    };
    const api = (globalThis as unknown as { __ezDock?: EzDockApi }).__ezDock;
    if (!api) throw new Error('__ezDock test seam missing');
    const panel = api.panels.find((candidate) => candidate.id === id);
    if (!panel) throw new Error(`panel ${id} is missing`);
    return api.addPopoutGroup(panel, {
      position: { left: 100, top: 80, width: 820, height: 560 },
    });
  }, panelId);
  expect(opened).toBe(true);
}

async function movePanelIntoFirstPopout(
  page: Page,
  panelId: string,
  mainLayoutFrameDelayMs = 0,
): Promise<void> {
  await page.evaluate(({ id, mainLayoutFrameDelayMs: delayMs }) => {
    type EzDockGroup = { id: string };
    type EzDockPanel = {
      id: string;
      api: {
        moveTo(options: { group: EzDockGroup; position: 'center' }): void;
      };
    };
    type EzDockApi = {
      panels: EzDockPanel[];
      getPopouts(): Array<{ group: EzDockGroup }>;
    };
    const api = (globalThis as unknown as { __ezDock?: EzDockApi }).__ezDock;
    if (!api) throw new Error('__ezDock test seam missing');
    const panel = api.panels.find((candidate) => candidate.id === id);
    const popout = api.getPopouts()[0];
    if (!panel || !popout) throw new Error('expected source panel and existing popout');
    if (delayMs <= 0) {
      panel.api.moveTo({ group: popout.group, position: 'center' });
      return;
    }

    // Dockview schedules the moved `always` renderer's destination-overlay
    // positioning from the main realm. Delaying only the frame requested by
    // moveTo deterministically exercises the valid cross-window ordering where
    // two auxiliary frames run before that overlay becomes focusable.
    const originalRequestFrame = globalThis.requestAnimationFrame;
    const requestFrame = originalRequestFrame.bind(globalThis);
    globalThis.requestAnimationFrame = (callback) => globalThis.setTimeout(
      () => requestFrame(callback),
      delayMs,
    ) as unknown as number;
    try {
      panel.api.moveTo({ group: popout.group, position: 'center' });
    } finally {
      globalThis.requestAnimationFrame = originalRequestFrame;
    }
  }, { id: panelId, mainLayoutFrameDelayMs });
}

async function addAgentSessionPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    type EzDockApi = {
      addPanel(options: {
        id: string;
        component: string;
        title: string;
        renderer: 'always';
        params: { historyId: string; provider: 'codex' };
      }): void;
    };
    const api = (globalThis as unknown as { __ezDock?: EzDockApi }).__ezDock;
    if (!api) throw new Error('__ezDock test seam missing');
    api.addPanel({
      id: 'agent-session-repro',
      component: 'agent-session',
      title: 'Agent Repro',
      renderer: 'always',
      params: { historyId: 'codex_repro', provider: 'codex' },
    });
  });
}

async function dragTabOutside(
  page: Page,
  tab: Locator = page.locator('.dv-tab').first(),
): Promise<void> {
  await expect(tab).toBeVisible();
  const bounds = await tab.boundingBox();
  if (!bounds) throw new Error('tab bounds are unavailable');
  const windowMetrics = await page.evaluate(() => ({
    screenX: globalThis.screenX,
    outerWidth: globalThis.outerWidth,
  }));
  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 24, startY + 8, { steps: 8 });
  // Once CDP leaves the renderer viewport it reports the supplied x as
  // DragEvent.screenX. Exceed the native window's screen boundary so this is
  // the same outside-window decision a physical pointer produces.
  await page.mouse.move(
    windowMetrics.screenX + windowMetrics.outerWidth + 240,
    startY + 80,
    { steps: 24 },
  );
  await page.mouse.up();
}

async function waitForAuxiliaryWindow(app: ElectronApplication): Promise<Page> {
  await expect.poll(
    () => app.windows().filter((candidate) => candidate.url().includes('ez-popout=1')).length,
    { timeout: 15_000 },
  ).toBe(1);
  const auxiliary = app.windows().find((candidate) => candidate.url().includes('ez-popout=1'));
  if (!auxiliary) throw new Error('auxiliary window did not open');
  await auxiliary.waitForLoadState('domcontentloaded');
  await expect(auxiliary.getByTestId('auxiliary-shell')).toBeVisible();
  return auxiliary;
}

test('terminal tab dragged outside becomes a frameless auxiliary window with the same session', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await expect(main.getByTestId('window-controls')).toBeVisible();

  const nativeMain = await app.browserWindow(main);
  expect(await nativeMain.evaluate((window) => window.isMenuBarVisible())).toBe(false);

  const originalSessionId = await sessionIdOf(main);
  await dragTabOutside(main);
  const auxiliary = await waitForAuxiliaryWindow(app);

  await expect(main.getByTestId('pane')).toHaveCount(0);
  await expect(auxiliary.getByTestId('window-controls')).toBeVisible();
  await expect(auxiliary.getByTestId('pane')).toHaveAttribute(
    'data-session-id',
    originalSessionId,
  );

  await auxiliary.getByTestId('block-list').click({ button: 'right' });
  await expect(auxiliary.getByTestId('terminal-context-menu')).toBeVisible();
  await expect(main.getByTestId('terminal-context-menu')).toHaveCount(0);
  await auxiliary.keyboard.press('Escape');

  await Promise.all([
    auxiliary.waitForEvent('close'),
    auxiliary.getByTestId('window-close').click(),
  ]);
  await expect.poll(() => app.windows().length).toBe(1);
  await expect.poll(() => main.evaluate(() => {
    const seam = globalThis as unknown as { __ezSessions?: () => number };
    return seam.__ezSessions ? seam.__ezSessions() : -1;
  })).toBe(0);

  await app.close();
});

test('popping one terminal tab out leaves both windows keyboard-interactive', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await main.getByTestId('btn-new-tab').click();
  await expect(main.locator('.dv-tab')).toHaveCount(2);

  await dragTabOutside(main, main.locator('.dv-tab', { hasText: 'Terminal 2' }));
  const auxiliary = await waitForAuxiliaryWindow(app);
  await expect(panes(main)).toHaveCount(1);
  await expect(panes(auxiliary)).toHaveCount(1);

  const mainInput = main.getByTestId('cmd-input');
  await mainInput.click({ timeout: 5_000 });
  await expect(mainInput).toBeFocused();
  await main.keyboard.type('main-still-interactive');
  await expect(mainInput).toHaveValue('main-still-interactive');

  const auxiliaryInput = auxiliary.getByTestId('cmd-input');
  await auxiliaryInput.click();
  await expect(auxiliaryInput).toBeFocused();
  await auxiliary.keyboard.type('auxiliary-still-interactive');
  await expect(auxiliaryInput).toHaveValue('auxiliary-still-interactive');

  await expect(main.locator('.dv-render-overlay')).toHaveCount(1);
  await expect(auxiliary.locator('.dv-render-overlay')).toHaveCount(1);

  await app.close();
});

test('terminal pane moved into an existing auxiliary window receives keyboard focus', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();

  await main.getByTestId('btn-workspace-menu').click();
  await main.getByTestId('btn-split-right').click();
  await expect(panes(main)).toHaveCount(2);

  await addPopoutGroup(main, 'tab-1');
  const auxiliary = await waitForAuxiliaryWindow(app);
  await expect(panes(main)).toHaveCount(1);
  await expect(panes(auxiliary)).toHaveCount(1);

  const sourceInput = main.getByTestId('cmd-input');
  await sourceInput.focus();
  await expect(sourceInput).toBeFocused();

  await movePanelIntoFirstPopout(main, 'tab-2', 250);

  await expect(panes(main)).toHaveCount(0);
  await expect(panes(auxiliary)).toHaveCount(2);
  await expect(auxiliary.locator('[data-testid="cmd-input"]:visible')).toBeFocused();

  await app.close();
});

test('Agent Session tab dragged outside opens and safely closes an auxiliary window', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const originalSessionId = await sessionIdOf(main);
  await addAgentSessionPanel(main);
  const agentTab = main.locator('.dv-tab').filter({ hasText: 'Agent Repro' });

  await dragTabOutside(main, agentTab);
  const auxiliary = await waitForAuxiliaryWindow(app);

  await expect(main.locator('.dv-tab').filter({ hasText: 'Agent Repro' })).toHaveCount(0);
  await expect(auxiliary.locator('.dv-tab').filter({ hasText: 'Agent Repro' })).toBeVisible();
  await expect(main.getByTestId('pane')).toHaveAttribute(
    'data-session-id',
    originalSessionId,
  );

  await Promise.all([
    auxiliary.waitForEvent('close'),
    auxiliary.getByTestId('window-close').click(),
  ]);
  await expect.poll(() => app.windows().length).toBe(1);
  await expect(main.getByTestId('pane')).toHaveAttribute(
    'data-session-id',
    originalSessionId,
  );

  await app.close();
});

test('Agent Session popout layout restores into a real auxiliary window after restart', async () => {
  const userDataDir = createRegisteredE2eTempDir('ezterm-agent-popout-e2e-');
  const app1 = await launchApp(userDataDir);
  const main1 = await app1.firstWindow();
  await expect(main1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const previousMainSessionId = await sessionIdOf(main1);
  await addAgentSessionPanel(main1);
  await addPopoutGroup(main1, 'agent-session-repro');
  const auxiliary1 = await waitForAuxiliaryWindow(app1);
  await expect(
    auxiliary1.locator('.dv-tab').filter({ hasText: 'Agent Repro' }),
  ).toBeVisible();
  await expect(main1.getByTestId('pane')).toHaveAttribute(
    'data-session-id',
    previousMainSessionId,
  );
  await flushLayout(main1);
  await app1.close();

  const app2 = await launchApp(userDataDir);
  const main2 = await app2.firstWindow();
  await expect(main2.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary2 = await waitForAuxiliaryWindow(app2);

  await expect(
    auxiliary2.locator('.dv-tab').filter({ hasText: 'Agent Repro' }),
  ).toBeVisible();
  await expect(
    main2.locator('.dv-tab').filter({ hasText: 'Agent Repro' }),
  ).toHaveCount(0);
  expect(await sessionIdOf(main2)).not.toBe(previousMainSessionId);

  await app2.close();
});

test('popout layout restores into a real auxiliary window with a fresh session after restart', async () => {
  const userDataDir = createRegisteredE2eTempDir('ezterm-popout-e2e-');
  const app1 = await launchApp(userDataDir);
  const main1 = await app1.firstWindow();
  await expect(main1.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const previousSessionId = await sessionIdOf(main1);

  await addPopoutGroup(main1);
  const auxiliary1 = await waitForAuxiliaryWindow(app1);
  await expect(auxiliary1.getByTestId('pane')).toHaveAttribute(
    'data-session-id',
    previousSessionId,
  );
  await flushLayout(main1);
  await app1.close();

  const app2 = await launchApp(userDataDir);
  const main2 = await app2.firstWindow();
  await expect(main2.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary2 = await waitForAuxiliaryWindow(app2);
  const restoredSessionId = await sessionIdOf(auxiliary2);

  expect(restoredSessionId).not.toBe(previousSessionId);
  await expect(main2.getByTestId('pane')).toHaveCount(0);
  await expect.poll(() => main2.evaluate(() => {
    const seam = globalThis as unknown as { __ezSessions?: () => number };
    return seam.__ezSessions ? seam.__ezSessions() : -1;
  })).toBe(1);

  await app2.close();
});
