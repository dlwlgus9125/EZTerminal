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

test('the board opens project settings and a new worktree as dialogs, and files as the project-files sidebar', async () => {
  test.setTimeout(120_000);
  const root = createRegisteredE2eTempDir('ezterm-dialog-board-');
  const app = await launchApp();
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1600, height: 950 });
    const saved = await page.evaluate((primaryRoot) => window.ezterminal.saveAgentProject({
      name: 'Board dialogs', primaryRoot, additionalRoots: [], pinned: true,
    }), root);
    if (!saved.ok) throw new Error(saved.reason);
    const tab = page.locator(`[data-testid="shell-project-tab"][data-project="${saved.project.projectId}"]`);
    await expect(tab).toBeVisible({ timeout: 70_000 });
    await tab.click();
    const board = page.getByTestId('shell-board');
    await expect(board.getByRole('heading', { level: 1 })).toHaveText('Board dialogs');

    // 프로젝트 설정: the editor alone, nothing behind it.
    const settings = board.getByRole('button', { name: 'Project settings', exact: true });
    await settings.click();
    const editor = page.getByTestId('agent-project-editor');
    await expect(editor).toContainText('Edit project');
    await expect(page.getByTestId('agent-project-name')).toHaveValue('Board dialogs');
    await expect(page.getByTestId('workbench-sidebar')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, 'board-settings.png') });
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(settings).toBeFocused();

    // 워크트리: the new-worktree dialog, nothing behind it.
    await board.getByRole('button', { name: 'Worktree', exact: true }).click();
    await expect(page.getByTestId('new-worktree-dialog')).toBeVisible();
    await expect(page.getByTestId('workbench-sidebar')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('new-worktree-dialog')).toHaveCount(0);

    // 파일: the project's files in the sidebar, with no project list behind a back button.
    await board.getByRole('button', { name: 'Files', exact: true }).click();
    const sidebar = page.getByTestId('workbench-sidebar');
    await expect(sidebar).toHaveAttribute('data-destination', 'agents');
    await expect(sidebar).toContainText('Project files');
    await expect(sidebar.getByTestId('project-workspace-panel')).toContainText('Board dialogs');
    await expect(page.getByTestId('project-workspace-back')).toHaveCount(0);
    await expect(page.getByTestId('agent-projects')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, 'board-files.png') });
  } finally {
    await app.close();
  }
});
