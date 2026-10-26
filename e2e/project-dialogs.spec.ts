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

test('모든 프로젝트 lists every project: open, pin, edit, CLI history and delete, one dialog at a time', async () => {
  test.setTimeout(120_000);
  const roots = [createRegisteredE2eTempDir('ezterm-list-a-'), createRegisteredE2eTempDir('ezterm-list-b-')];
  const app = await launchApp();
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1600, height: 950 });
    const ids: string[] = [];
    for (const [index, primaryRoot] of roots.entries()) {
      const saved = await page.evaluate(([root, name]) => window.ezterminal.saveAgentProject({ name, primaryRoot: root, additionalRoots: [], pinned: false }),
        [primaryRoot, `List project ${index + 1}`] as const);
      if (!saved.ok) throw new Error(saved.reason);
      ids.push(saved.project.projectId);
    }
    const all = page.getByTestId('shell-all-projects');
    await expect(all).toHaveAccessibleName('All projects');
    await all.click();
    const dialog = page.getByTestId('all-projects-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('workbench-sidebar')).toHaveCount(0);
    await expect(dialog.getByTestId(`all-projects-open-${ids[0]}`)).toContainText('List project 1');
    await expect(dialog.getByTestId(`all-projects-open-${ids[1]}`)).toContainText('List project 2');
    await page.screenshot({ path: path.join(evidence, 'all-projects.png') });

    // Pin: the project leads the list and gets a top-bar tab.
    await dialog.getByTestId(`all-projects-pin-${ids[1]}`).click();
    await expect(dialog.getByRole('button', { name: 'Unpin project: List project 2' })).toBeVisible();
    await expect(page.locator(`[data-testid="shell-project-tab"][data-project="${ids[1]}"]`)).toBeVisible();

    // Edit from the list goes back to the list; Escape there closes it and focus returns to the button.
    await dialog.getByRole('button', { name: 'Manage List project 1' }).click();
    await page.getByRole('menuitem', { name: 'Edit project' }).click();
    const editor = page.getByTestId('agent-project-editor');
    await expect(editor).toContainText('Edit project');
    await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(editor).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(all).toBeFocused();

    // CLI 기록: the history dialog on that project's CLI records.
    await all.click();
    await dialog.getByRole('button', { name: 'Manage List project 1' }).click();
    await page.getByRole('menuitem', { name: 'CLI history' }).click();
    const history = page.getByTestId('conversation-history-dialog');
    await expect(history).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(history.getByRole('combobox', { name: 'Source' })).toHaveValue('native');
    await expect(history.getByRole('combobox', { name: 'Project' })).toHaveValue(ids[0]!);
    await page.keyboard.press('Escape');
    await expect(history).toHaveCount(0);

    // Delete from the list goes back to it, without that project.
    await all.click();
    await dialog.getByRole('button', { name: 'Manage List project 1' }).click();
    await page.getByRole('menuitem', { name: 'Delete project' }).click();
    const remove = page.getByTestId('agent-project-delete');
    await expect(remove).toBeVisible();
    await remove.getByRole('button', { name: 'Delete project' }).click();
    await expect(remove).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`all-projects-open-${ids[0]}`)).toHaveCount(0);

    // Opening a project shows its board.
    await dialog.getByTestId(`all-projects-open-${ids[1]}`).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('shell-board').getByRole('heading', { level: 1 })).toHaveText('List project 2');
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
