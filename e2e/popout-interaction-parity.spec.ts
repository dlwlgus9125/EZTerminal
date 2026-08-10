import path from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from './test';
import { launchApp } from './launch-app';

const LINE_PROMPT = path.resolve(__dirname, 'fixtures', 'line-prompt.js');
const FAKE_CODEX = path.resolve(__dirname, 'fixtures', 'fake-codex', 'codex');
const INTERNAL_PATHS_MIME = 'application/x-ezterminal-paths';

async function popOutPanel(main: Page, app: ElectronApplication, panelId = 'tab-1'): Promise<Page> {
  await expect.poll(() => main.getByTestId('pane').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await main.waitForFunction((id) => {
    const api = (globalThis as unknown as {
      __ezDock?: { panels: Array<{ id: string }> };
    }).__ezDock;
    return api?.panels.some((candidate) => candidate.id === id) ?? false;
  }, panelId);
  const opened = await main.evaluate(async (id) => {
    type DockPanel = { id: string };
    type DockApi = {
      panels: DockPanel[];
      addPopoutGroup(
        panel: DockPanel,
        options: { position: { left: number; top: number; width: number; height: number } },
      ): Promise<boolean>;
    };
    const api = (globalThis as unknown as { __ezDock?: DockApi }).__ezDock;
    const panel = api?.panels.find((candidate) => candidate.id === id);
    if (!api || !panel) throw new Error(`panel ${id} is missing`);
    return api.addPopoutGroup(panel, {
      position: { left: 100, top: 80, width: 820, height: 560 },
    });
  }, panelId);
  expect(opened).toBe(true);
  await expect.poll(
    () => app.windows().filter((candidate) => candidate.url().includes('ez-popout=1')).length,
    { timeout: 15_000 },
  ).toBe(1);
  const auxiliary = app.windows().find((candidate) => candidate.url().includes('ez-popout=1'));
  if (!auxiliary) throw new Error('auxiliary window did not open');
  await auxiliary.getByTestId('auxiliary-shell').waitFor({ state: 'visible' });
  await auxiliary.bringToFront();
  return auxiliary;
}

async function selectContentsAndOpenMenu(element: Locator): Promise<void> {
  await element.evaluate((target) => {
    const selection = target.ownerDocument.defaultView?.getSelection();
    const range = target.ownerDocument.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new target.ownerDocument.defaultView!.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
}

test('popout structured output context Copy uses the popout selection', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);

  const input = auxiliary.locator('[data-testid="cmd-input"]:visible');
  await input.fill('gen-rows 1');
  await auxiliary.locator('[data-testid="btn-run"]:visible').click();
  await expect(auxiliary.getByTestId('block-status').last()).toHaveText('done', { timeout: 10_000 });
  const command = auxiliary.getByTestId('block-command').last();
  await selectContentsAndOpenMenu(command);

  const copy = auxiliary.getByTestId('term-ctx-copy');
  await expect(copy).toBeEnabled();
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await copy.click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('gen-rows 1');
  await app.close();
});

test('popout composer context Copy and Ctrl+K keep their terminal semantics', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);
  const input = auxiliary.locator('[data-testid="cmd-input"]:visible');
  await input.fill('alpha beta');
  await input.evaluate((target) => {
    const composer = target as HTMLInputElement;
    composer.setSelectionRange(0, 5);
    const rect = composer.getBoundingClientRect();
    composer.dispatchEvent(new composer.ownerDocument.defaultView!.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await app.evaluate(({ clipboard }) => clipboard.clear());
  const copy = auxiliary.getByTestId('term-ctx-copy');
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('alpha');

  await input.focus();
  await auxiliary.keyboard.press('Control+k');
  await expect(auxiliary.getByTestId('quick-open-modal')).toHaveCount(0);
  await expect(main.getByTestId('quick-open-modal')).toHaveCount(0);
  await app.close();
});

test('selected plain PTY output in a popout is copied without sending SIGINT', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);

  const input = auxiliary.locator('[data-testid="cmd-input"]:visible');
  await input.fill(`node ${LINE_PROMPT}`);
  await auxiliary.locator('[data-testid="btn-run"]:visible').click();
  const output = auxiliary.locator('[data-testid="text-output"]:visible').last();
  await expect.poll(() => output.innerText(), { timeout: 15_000 }).toContain('name: ');
  await input.focus();
  await output.evaluate((target) => {
    const selection = target.ownerDocument.defaultView?.getSelection();
    const range = target.ownerDocument.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await app.evaluate(({ clipboard }) => clipboard.clear());

  await auxiliary.keyboard.press('Control+c');

  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('name: ');
  await expect(output).not.toContainText('SIGINT');
  await expect(auxiliary.getByTestId('block-status').last()).toHaveText('running');
  await auxiliary.getByTestId('block-cancel').click();
  await app.close();
});

test('Quick Command Escape is handled by the popout window', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);

  await auxiliary.getByTestId('quick-command-toggle').click();
  const popover = auxiliary.getByTestId('quick-command-popover');
  await expect(popover).toBeVisible();
  await auxiliary.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await app.close();
});

test('Command Center invoked from a popout is rendered and focused there', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);

  await auxiliary.locator('[data-testid="cmd-input"]:visible').click();
  await auxiliary.keyboard.press('Control+Shift+p');

  await expect(auxiliary.getByTestId('quick-open-modal')).toBeVisible();
  await expect(auxiliary.locator('.quick-open-input')).toBeFocused();
  await expect(main.getByTestId('quick-open-modal')).toHaveCount(0);
  await auxiliary.keyboard.press('Escape');
  await expect(auxiliary.getByTestId('quick-open-modal')).toHaveCount(0);
  await expect(auxiliary.locator('[data-testid="cmd-input"]:visible')).toBeFocused();
  await app.close();
});

test('terminal safety toast stays in the popout', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);

  const input = auxiliary.locator('[data-testid="cmd-input"]:visible');
  await input.fill(FAKE_CODEX);
  await auxiliary.locator('[data-testid="btn-run"]:visible').click();
  const output = auxiliary.locator('[data-testid="text-output"]:visible').last();
  await expect.poll(() => output.innerText(), { timeout: 15_000 }).toContain('FAKE-CODEX-READY');
  await input.click();
  await auxiliary.keyboard.press('Control+c');
  await expect(auxiliary.locator('.ez-ui-toast')).toHaveCount(1);
  await expect(main.locator('.ez-ui-toast')).toHaveCount(0);
  await auxiliary.getByTestId('block-cancel').click();
  await app.close();
});

test('terminal paste warning stays in the popout and restores its composer', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);
  const input = auxiliary.locator('[data-testid="cmd-input"]:visible');
  await input.fill(`node ${LINE_PROMPT}`);
  await auxiliary.locator('[data-testid="btn-run"]:visible').click();
  const output = auxiliary.locator('[data-testid="text-output"]:visible').last();
  await expect.poll(() => output.innerText(), { timeout: 15_000 }).toContain('name: ');
  await input.click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('first\nsecond'));

  await auxiliary.keyboard.press('Control+v');

  const warning = auxiliary.getByTestId('terminal-paste-warning-dialog');
  await expect(warning).toBeVisible();
  await expect(main.getByTestId('terminal-paste-warning-dialog')).toHaveCount(0);
  await expect(auxiliary.getByTestId('terminal-paste-warning-cancel')).toBeFocused();
  await auxiliary.keyboard.press('Escape');
  await expect(warning).toHaveCount(0);
  await expect(input).toBeFocused();
  await auxiliary.getByTestId('block-cancel').click();
  await app.close();
});

test('file drag overlay and path insertion stay in the popout', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);
  const input = auxiliary.locator('[data-testid="cmd-input"]:visible');
  await input.click();
  const droppedPath = 'C:\\Temp\\alpha file.txt';

  await auxiliary.evaluate(({ mime, droppedPath: value }) => {
    const transfer = new DataTransfer();
    transfer.setData(mime, JSON.stringify([value]));
    window.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { mime: INTERNAL_PATHS_MIME, droppedPath });

  await expect(auxiliary.getByTestId('file-drop-overlay')).toBeVisible();
  await expect(main.getByTestId('file-drop-overlay')).toHaveCount(0);
  await auxiliary.evaluate(({ mime, droppedPath: value }) => {
    const transfer = new DataTransfer();
    transfer.setData(mime, JSON.stringify([value]));
    window.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { mime: INTERNAL_PATHS_MIME, droppedPath });
  await expect(input).toHaveValue(/alpha file\.txt/u);
  await expect(auxiliary.getByTestId('file-drop-overlay')).toHaveCount(0);
  await app.close();
});

test('Ctrl+Tab previews and commits the recent panel from a popout', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await main.getByTestId('btn-new-tab').click();
  await expect(main.locator('.dv-tab')).toHaveCount(2);
  const auxiliary = await popOutPanel(main, app, 'tab-2');
  await auxiliary.locator('[data-testid="cmd-input"]:visible').click();
  await expect.poll(() => main.evaluate(() => {
    const api = (globalThis as unknown as { __ezDock?: { activePanel?: { id: string } } }).__ezDock;
    return api?.activePanel?.id ?? null;
  })).toBe('tab-2');

  await auxiliary.keyboard.down('Control');
  await auxiliary.keyboard.press('Tab');
  const switcher = auxiliary.getByTestId('recent-panel-switcher');
  await expect(switcher).toBeVisible();
  await expect(main.getByTestId('recent-panel-switcher')).toHaveCount(0);
  await auxiliary.keyboard.up('Control');
  await expect(switcher).toHaveCount(0);
  await expect.poll(() => main.evaluate(() => {
    const api = (globalThis as unknown as { __ezDock?: { activePanel?: { id: string } } }).__ezDock;
    return api?.activePanel?.id ?? null;
  })).toBe('tab-1');
  await app.close();
});

test('a main-owned Project Editor opened from the active popout stays in the main grid', async () => {
  const app = await launchApp();
  const main = await app.firstWindow();
  await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const auxiliary = await popOutPanel(main, app);
  await auxiliary.locator('[data-testid="cmd-input"]:visible').click();

  await main.evaluate(() => {
    type DockApi = {
      addPanel(options: {
        id: string;
        component: string;
        title: string;
        params: Record<string, unknown>;
      }): void;
    };
    const api = (globalThis as unknown as { __ezDock?: DockApi }).__ezDock;
    if (!api) throw new Error('__ezDock test seam missing');
    api.addPanel({
      id: 'project-editor-popout-invariant',
      component: 'project-editor',
      title: 'app.ts',
      params: {
        projectId: 'e2e-project',
        rootId: 'e2e-root',
        workspaceId: 'e2e-root',
        relativePath: 'src/app.ts',
        lens: { kind: 'current' },
      },
    });
  });

  await expect(main.getByTestId('project-editor-panel')).toBeVisible({ timeout: 15_000 });
  await expect(auxiliary.getByTestId('project-editor-panel')).toHaveCount(0);
  await expect.poll(() => main.evaluate(() => {
    type DockApi = {
      getPanel(id: string): { api: { location: { type: string } } } | undefined;
    };
    const api = (globalThis as unknown as { __ezDock?: DockApi }).__ezDock;
    return api?.getPanel('project-editor-popout-invariant')?.api.location.type ?? null;
  })).toBe('grid');
  await app.close();
});
