import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { resizeWindow } from './workbench-navigation';

type App = Awaited<ReturnType<typeof launchApp>>;

/**
 * Project management is dialogs, not the old project sidebar: `+` in the top bar adds a project
 * (its folder chosen inside the dialog) and the new project's board opens.
 */

const evidence = path.resolve('artifacts/project-dialogs/e2e');
mkdirSync(evidence, { recursive: true });

/** The native folder picker answers with these folders (no OS dialog in the harness). */
async function stubFolderPicker(app: App, folders: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    const answer = async (): Promise<Electron.OpenDialogReturnValue> => ({ canceled: false, filePaths: [...paths] });
    (dialog as { showOpenDialog: unknown }).showOpenDialog = answer;
  }, folders);
}

test('+ adds a project in a dialog and shows its board', async () => {
  test.setTimeout(120_000);
  const root = createRegisteredE2eTempDir('ezterm-dialog-project-');
  const app = await launchApp();
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1600, height: 950 });
    await stubFolderPicker(app, [root]);
    const add = page.getByTestId('shell-add-project');
    await expect(add).toHaveAccessibleName('Add project');
    await add.click();

    const editor = page.getByTestId('agent-project-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('Add project');
    await expect(page.getByTestId('workbench-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('agent-project-save')).toBeDisabled();
    await page.screenshot({ path: path.join(evidence, 'add-empty.png') });

    await page.getByTestId('agent-project-add-folder').click();
    const name = path.basename(root);
    await expect(page.getByTestId('agent-project-name')).toHaveValue(name);
    await expect(editor.locator('.agent-project-roots li')).toHaveCount(1);
    await page.screenshot({ path: path.join(evidence, 'add-filled.png') });
    await page.getByTestId('agent-project-save').click();
    await expect(editor).toHaveCount(0);

    // The new project's board, with its tab selected; it stays there once the registry is read again.
    const board = page.getByTestId('shell-board');
    await expect(board.getByRole('heading', { level: 1 })).toHaveText(name);
    const tab = page.locator('[data-testid="shell-project-tab"][aria-current="page"]');
    await expect(tab).toHaveText(name);
    await page.waitForTimeout(1_500);
    await expect(board.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(add).toBeFocused();
    await page.screenshot({ path: path.join(evidence, 'added-board.png') });
  } finally {
    await app.close();
  }
});
