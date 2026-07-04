import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// AC-5: npx / pnpm dlx invoke a downloaded package's binary through a cmd-shim at
// node_modules/.bin/<name>.cmd — exactly the shape npm's own shim generator
// produces, and the one buildCmdLine() double-escapes (build-cmd-line.ts
// CMD_SHIM_RE), because that shim itself re-quotes its argv through a second
// cmd.exe pass on its way to invoking node. This fixture lives at that literal
// path (e2e/fixtures/node_modules/.bin/dlx-shim.cmd) so it hits the real
// double-escape branch, not just an ordinary .cmd. Sigil-free (M2 auto-PTY) so
// the resolved shell:true path is exercised exactly like a real
// `npx <tool>` / `pnpm dlx <tool>` invocation.

const DLX_SHIM = path.resolve(__dirname, 'fixtures', 'node_modules', '.bin', 'dlx-shim.cmd');

/** Concatenated text currently rendered in the plain PTY view (M3, pre-upgrade). */
async function plainText(window: Page): Promise<string> {
  return window.getByTestId('text-output').innerText();
}

test('AC-5: a node_modules/.bin/*.cmd shim (npx/pnpm-dlx shape) runs sigil-free and round-trips input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Bare single command → auto-PTY (M2). The wrapped pty-echo.js emits no TUI
  // signal, so per M3 it stays PLAIN — proving the double-escape shim spawn path
  // works end-to-end (real PTY, real bidirectional argv) independent of render
  // mode (adaptive-render.spec.ts already covers the upgrade path separately).
  await window.getByTestId('cmd-input').fill(DLX_SHIM);
  await window.getByTestId('btn-run').click();

  const plainBlock = window.getByTestId('pty-plain-block');
  await expect(plainBlock).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('READY');

  await plainBlock.click();
  await window.keyboard.type('hi');
  await window.keyboard.press('Enter');
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('ECHO:');

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });

  await app.close();
});
