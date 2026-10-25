import { expect, type Page } from './test';

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

/**
 * Resizes the window and waits until the page has the new width: the shell (SidebarShell reads matchMedia) docks or
 * overlays its sidebar by width, and on a slow runner the next click could land while the old layout still holds.
 */
export async function resizeWindow(page: Page, size: { readonly width: number; readonly height: number }): Promise<void> {
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
}
