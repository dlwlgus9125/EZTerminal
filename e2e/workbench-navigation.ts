import type { Page } from './test';

/** Production r6 groups auxiliary destinations under the stable Tools trigger. */
export async function toggleWorkbenchTool(
  page: Page,
  destinationTestId: 'btn-toggle-files' | 'btn-toggle-stats' | 'rail-remote' | 'btn-toggle-openclaw',
): Promise<void> {
  await page.getByTestId('rail-tools').click();
  await page.getByTestId(destinationTestId).click();
}
