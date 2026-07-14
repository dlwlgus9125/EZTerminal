import { test, expect } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

// Terminal-feel pass T1: while a pane's active block is a RUNNING xterm `pty`
// (auto-upgraded OR `!cmd`-forced), it takes over the pane like a real terminal
// handing the screen to a full-screen program — sibling blocks and the pinned
// cmd-input are hidden (CSS only, never unmounted: TerminalPane.tsx's
// `activeTakeover` + index.css's `.pane--tui-takeover`) and the running block
// fills the pane's remaining height. Released the moment the block leaves
// 'running', handing focus back to cmd-input (PtyBlock.tsx's PtyXtermView,
// mirroring PtyPlainView's existing exit-focus pattern).

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
const INK_LONGLIVED_FIXTURE = path.resolve(__dirname, 'fixtures', 'ink-trigger-longlived.js');

test('tui-takeover: a forced-xterm (`!cmd`) block takes over the pane while running, and releases on exit', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // A prior (finished) block, to prove the takeover hides SIBLING blocks too,
  // not just cmd-input.
  await window.getByTestId('cmd-input').fill('node --version');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  const priorBlock = window.getByTestId('block').first();
  await expect(priorBlock).toBeVisible();

  await window.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  // Scoped to the LATEST block: a second `block-status` now exists (the prior,
  // finished one, still in the DOM though hidden), so an unscoped lookup would
  // be ambiguous under Playwright's strict mode.
  const runningBlock = window.getByTestId('block').last();
  const pane = window.getByTestId('pane');
  await expect(pane).toHaveClass(/pane--tui-takeover/);
  const ptyBlock = window.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect
    .poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 })
    .toContain('READY');

  // The prior block and the pinned prompt are hidden — still in the DOM (CSS
  // only), not unmounted.
  await expect(priorBlock).toBeHidden();
  const cmdInput = window.getByTestId('cmd-input');
  await expect(cmdInput).toBeHidden();
  await expect(priorBlock).toHaveCount(1);
  await expect(cmdInput).toHaveCount(1);

  // The takeover block fills the pane's remaining height (well beyond its
  // normal 360px docked size).
  const paneBox = await pane.boundingBox();
  const ptyBlockBox = await ptyBlock.boundingBox();
  expect(paneBox).not.toBeNull();
  expect(ptyBlockBox).not.toBeNull();
  expect(ptyBlockBox!.height).toBeGreaterThan(paneBox!.height * 0.7);

  // Exit: Cancel kills the child -> status flips to cancelled -> takeover releases.
  await runningBlock.getByTestId('block-cancel').click();
  await expect(runningBlock.getByTestId('block-status')).toHaveText('cancelled', {
    timeout: 15_000,
  });

  await expect(pane).not.toHaveClass(/pane--tui-takeover/);
  await expect(priorBlock).toBeVisible();
  await expect(cmdInput).toBeVisible();
  await expect(cmdInput).toBeFocused();

  await app.close();
});

test('tui-takeover: a sigil-free auto-upgrade (ink-style trigger) also takes over the pane while running', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Long-lived variant of the ink-style trigger burst (stays alive via
  // setInterval instead of exiting ~300ms after the burst, like
  // ink-trigger-burst.js does) — gives a deterministic "still running, still
  // upgraded" window to assert against, instead of racing a fixed timeout.
  await window.getByTestId('cmd-input').fill(`node ${INK_LONGLIVED_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const pane = window.getByTestId('pane');
  await expect(pane).toHaveClass(/pane--tui-takeover/);
  await expect
    .poll(() => readXtermBuffer(window.getByTestId('pty-block')), { timeout: 15_000 })
    .toContain('INK-STYLE-READY');
  await expect(window.getByTestId('block-status')).toHaveText('running');

  // Exit: Cancel kills the child -> status flips to cancelled -> takeover releases.
  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });

  await expect(pane).not.toHaveClass(/pane--tui-takeover/);
  const cmdInput = window.getByTestId('cmd-input');
  await expect(cmdInput).toBeVisible();
  await expect(cmdInput).toBeFocused();

  await app.close();
});
