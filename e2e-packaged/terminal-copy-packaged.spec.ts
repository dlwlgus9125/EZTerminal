import { expect, test } from '@playwright/test';

import { launchPackagedRenderer } from './packaged-renderer';

test('packaged EXE: split terminal Copy reaches the main OS clipboard boundary', async () => {
  test.skip(process.platform !== 'win32', 'Windows packaged clipboard regression');
  const session = await launchPackagedRenderer('ezterminal-packaged-copy-');
  const { page } = session;
  try {
    await expect(page.getByRole('heading', { name: 'EZTerminal' })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('btn-workspace-menu').click();
    await page.getByTestId('btn-split-right').click();
    const panes = page.getByTestId('pane');
    await expect(panes).toHaveCount(2);
    const splitPane = panes.nth(1);
    await splitPane.getByTestId('cmd-input').fill('gen-rows 1');
    await splitPane.getByTestId('btn-run').click();
    await expect(splitPane.getByTestId('block-status').last()).toHaveAttribute('data-status', 'done', {
      timeout: 10_000,
    });
    const output = splitPane.getByTestId('block-command').last();
    const selectedText = await output.evaluate((target) => {
      const selection = target.ownerDocument.defaultView?.getSelection();
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? '';
    });
    expect(selectedText).toBe('gen-rows 1');
    await page.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __ezRejectedClipboardWrites?: string[];
      };
      scope.__ezRejectedClipboardWrites = [];
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          scope.__ezRejectedClipboardWrites?.push(text);
          throw new DOMException('Renderer clipboard writes are unavailable.', 'NotAllowedError');
        },
      });
    });
    await output.evaluate((target) => {
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 8,
        clientY: rect.top + 8,
      }));
    });
    await page.getByTestId('term-ctx-copy').click();

    await expect.poll(() => page.evaluate(async () => (
      (await window.ezterminalDesktop!.readTerminalClipboard()).text
    ))).toBe(selectedText);
    await expect(page.locator('.ez-ui-toast').filter({
      hasText: /Copied to clipboard|클립보드에 복사했습니다/u,
    }))
      .toBeVisible();
    expect(await page.evaluate(() => (
      (globalThis as typeof globalThis & { __ezRejectedClipboardWrites?: string[] })
        .__ezRejectedClipboardWrites ?? []
    ))).toEqual([]);
  } finally {
    await session.close();
  }
});
