import type { Page } from './test';

/**
 * Board + Desk (2.0): the tools sit in the live list's tool row, which shows in
 * work mode. From the board, Ctrl+` enters work mode first (a terminal comes
 * forward; the tool then opens beside it).
 */
export async function enterWorkMode(page: Page): Promise<void> {
  const body = page.locator('.workbench-body');
  if ((await body.getAttribute('data-shell-mode')) === 'work') return;
  await page.keyboard.press('Control+Backquote');
  await page.locator('.workbench-body[data-shell-mode="work"]').waitFor();
}

export async function toggleWorkbenchTool(
  page: Page,
  destinationTestId: 'btn-toggle-files' | 'btn-toggle-stats' | 'rail-remote' | 'btn-toggle-openclaw',
): Promise<void> {
  await enterWorkMode(page);
  await page.getByTestId(destinationTestId).click();
}
