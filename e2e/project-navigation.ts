import type { Locator, Page } from '@playwright/test';

import { expect } from './test';

/**
 * Ways into a project in the Board + Desk shell, now that projects are managed in dialogs
 * (`+` adds one, 모든 프로젝트 lists them all) rather than in the old project sidebar.
 */

/** 모든 프로젝트 in the top bar: every project, with open, pin and a ⋯ per row. */
export async function openAllProjects(page: Page): Promise<Locator> {
  await page.getByTestId('shell-all-projects').click();
  const dialog = page.getByTestId('all-projects-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** A project's board, chosen from 모든 프로젝트. */
export async function openProjectBoard(page: Page, projectId: string): Promise<void> {
  const dialog = await openAllProjects(page);
  await dialog.getByTestId(`all-projects-open-${projectId}`).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('shell-board')).toBeVisible();
}

/** A project's flow tab at its items (subprojects and conversations), opened with the board's 새 흐름. */
export async function openProjectItems(page: Page, projectId: string): Promise<Locator> {
  await openProjectBoard(page, projectId);
  await page.getByTestId('shell-board-new-flow').click();
  const workspace = page.getByTestId('workflow-workspace');
  await expect(workspace).toBeVisible();
  return workspace;
}

/**
 * A new conversation draft tab from the work list's +, as the old sidebar's 새 대화 opened it.
 * On the board, Ctrl+` first goes to work mode (to the existing terminal, without a new tab).
 */
export async function startNewConversation(page: Page): Promise<Locator> {
  const add = page.getByTestId('btn-new-session');
  if (!await add.isVisible()) {
    await page.keyboard.press('Control+Backquote');
    await expect(add).toBeVisible();
  }
  await add.click();
  const draft = page.getByTestId('conversation-start');
  await expect(draft).toBeVisible();
  return draft;
}

/** A project's ⋯ in 모든 프로젝트, then one of its actions (Edit project, CLI history, Delete project). */
export async function manageProject(page: Page, projectName: string, action: string | RegExp): Promise<void> {
  const dialog = await openAllProjects(page);
  const name = projectName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  await dialog.getByRole('button', { name: new RegExp(`^(Manage ${name}|${name} 관리)$`, 'u') }).click();
  await page.getByRole('menuitem', typeof action === 'string' ? { name: action, exact: true } : { name: action }).click();
}
