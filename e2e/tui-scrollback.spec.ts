import { test, expect } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// Regression lock (scroll-fixer investigation — see .omc/research or session
// handoff for the full diagnostic writeup): a user reported "can't scroll up
// inside a TUI takeover xterm to see earlier output." Root-caused to the
// specific TUI program (claude's ink renderer redraws its whole screen via
// absolute cursor positioning confined to the CURRENT terminal row count, and
// never transmits content once it scrolls out of that window — verified via
// direct ConPTY byte capture, not fixable from the renderer side: those bytes
// never reach xterm at all). EZTerminal's OWN wiring (xterm.js mount, CSS,
// wheel handling) was proven correct for the case that IS ours to guarantee —
// real scrollback bytes that DID arrive over the PTY — via the two cases below.
// These lock that guarantee against a future CSS/PtyBlock regression.

const SCROLLBACK_FIXTURE = path.resolve(__dirname, 'fixtures', 'ink-trigger-scrollback.js');
const STREAMING_FIXTURE = path.resolve(__dirname, 'fixtures', 'ink-trigger-streaming.js');

test('tui-scrollback: wheel-up over a takeover xterm reveals earlier scrollback content', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${SCROLLBACK_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const pane = window.getByTestId('pane');
  await expect(pane).toHaveClass(/pane--tui-takeover/);
  const ptyBlock = window.getByTestId('pty-block');
  const rows = window.locator('.pty-block .xterm-rows');
  await expect.poll(() => rows.innerText(), { timeout: 15_000 }).toContain('BOTTOM-MARKER');

  const box = await ptyBlock.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < 15; i++) {
    // eslint-disable-next-line no-await-in-loop
    await window.mouse.wheel(0, -300);
  }

  // Scrolled away from the bottom: BOTTOM-MARKER is no longer the visible tail,
  // and earlier numbered lines are now on screen.
  await expect.poll(() => rows.innerText(), { timeout: 5_000 }).not.toContain('BOTTOM-MARKER');
  await expect(rows).toContainText(/LINE-\d{3}/);

  await window.getByTestId('block-cancel').click();
  await app.close();
});

test('tui-scrollback: a scrolled-up view is not yanked back to the bottom by continued streaming output', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${STREAMING_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const pane = window.getByTestId('pane');
  await expect(pane).toHaveClass(/pane--tui-takeover/);
  const ptyBlock = window.getByTestId('pty-block');
  const rows = window.locator('.pty-block .xterm-rows');
  await expect.poll(() => rows.innerText(), { timeout: 15_000 }).toContain('LINE-060');

  const box = await ptyBlock.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < 15; i++) {
    // eslint-disable-next-line no-await-in-loop
    await window.mouse.wheel(0, -300);
  }
  const scrolledTopLine = (await rows.innerText()).split('\n')[0];

  // The fixture keeps streaming new lines every 150ms; a naive "always follow
  // new output" implementation would snap back to the bottom here.
  await window.waitForTimeout(1500);
  const topLineAfterMoreStreaming = (await rows.innerText()).split('\n')[0];
  expect(topLineAfterMoreStreaming).toBe(scrolledTopLine);

  await window.getByTestId('block-cancel').click();
  await app.close();
});
