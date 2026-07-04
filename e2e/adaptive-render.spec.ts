import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// M3: adaptive render — execution is always PTY (M2); render branches on the
// interpreter's TuiSignalDetector (pty-session.ts). All fixtures here are
// sigil-free (no `!`) so the auto-detection itself is what's under test; see
// pty.spec.ts for the `!cmd` forceXterm path (unaffected by M3).
//
// Fixtures are derived from the M0a measurement spike
// (.omc/research/pty-signal-measurements.md) — the ink/ratatui trigger burst is
// copied verbatim from the real claude/codex captures (§4/§7); the others match
// the OBSERVED PATH for their category (npm/pnpm-style progress, line-oriented
// prompts, large plain output: all measured to trigger NOTHING and must stay
// plain).
//
// M3 FINDING (not in M0a — no captured command used alt-screen), SUPERSEDED
// (scroll-fixer useConptyDll experiment): with the OS-installed ConPTY (old
// Windows 10 builds), a real ConPTY probe showed `ESC[?1049h` was INTERCEPTED
// and never forwarded downstream — it substituted its own clear+redraw
// sequence instead, so the block stayed plain. Now that pty-runner.ts spawns
// with `useConptyDll: true` (node-pty's bundled, current conpty.dll/
// OpenConsole.exe, adopted as the fix for the tail-only scrollback bug — see
// docs/release/cli-parity-manual-checklist.md), `?1049h` IS forwarded and the
// block upgrades to xterm immediately, verified below. This does not affect
// AC-1/AC-2: both confirmed claude and codex trigger via bracketed-paste/focus-
// tracking instead (see the ink-style test below), which IS observed reaching
// the detector.

const ALT_SCREEN_FIXTURE = path.resolve(__dirname, 'fixtures', 'alt-screen.js');
const INK_BURST_FIXTURE = path.resolve(__dirname, 'fixtures', 'ink-trigger-burst.js');
const NPM_STYLE_FIXTURE = path.resolve(__dirname, 'fixtures', 'npm-style-progress.js');
const LARGE_OUTPUT_FIXTURE = path.resolve(__dirname, 'fixtures', 'large-plain-output.js');
const LINE_PROMPT_FIXTURE = path.resolve(__dirname, 'fixtures', 'line-prompt.js');
// M5 AC-1/AC-2 automated path: same ink-style trigger burst as INK_BURST_FIXTURE,
// but wrapped in a .cmd shim and invoked WITHOUT an extension — this is the
// specific chain a bare `claude`/`codex` invocation exercises that the test
// above does not: CommandResolver's PATHEXT probe (not a direct .js path), M1's
// batch-shim PTY spawn (cmd.exe + buildCmdLine), and M3's upgrade detector, all
// sigil-free. Real claude/codex auth+TUI remain a manual check (AC-1/AC-2 are
// dualized per the plan — see docs/release/cli-parity-manual-checklist.md).
const INK_CMD_SHIM = path.resolve(__dirname, 'fixtures', 'ink-cmd-shim');

/** Concatenated text currently rendered in the xterm grid (post-upgrade). */
async function terminalText(window: Page): Promise<string> {
  return window.locator('.pty-block .xterm-rows').innerText();
}

/** Concatenated text currently rendered in the plain PTY view (pre-upgrade). */
async function plainText(window: Page): Promise<string> {
  return window.getByTestId('text-output').innerText();
}

test('adaptive render: a program requesting alt-screen upgrades to xterm — bundled conpty.dll forwards ?1049h', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${ALT_SCREEN_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  // See the file-header note: with useConptyDll:true the DEC private-mode set
  // for alt-screen IS forwarded downstream, so the detector sees it and the
  // block upgrades to xterm (locking in this real, verified platform behavior).
  await expect(window.getByTestId('pty-block')).toBeVisible();
  await expect(window.getByTestId('pty-plain-block')).toHaveCount(0);
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('ALT-SCREEN-READY');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

test('adaptive render: real ink-style (claude) trigger burst upgrades to xterm — AC-1 machine path', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${INK_BURST_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-block')).toBeVisible();
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('INK-STYLE-READY');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

test('adaptive render: long-running plain progress (npm/pnpm-style) stays plain — never upgrades (B-R1)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${NPM_STYLE_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-plain-block')).toBeVisible();
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('installing');
  await expect(window.getByTestId('pty-block')).toHaveCount(0); // no upgrade mid-run

  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('done');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0); // still never upgraded

  await app.close();
});

test('adaptive render: large plain output (>1MB) completes without an ack deadlock (M3 B2)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${LARGE_OUTPUT_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-plain-block')).toBeVisible();
  await expect
    .poll(() => plainText(window), { timeout: 20_000 })
    .toContain('LARGE-OUTPUT-DONE');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 20_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0);

  await app.close();
});

test('adaptive render: line-oriented prompt — typed echo + Backspace edit round trip in plain mode', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${LINE_PROMPT_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const plainBlock = window.getByTestId('pty-plain-block');
  await expect(plainBlock).toBeVisible();
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('name:');

  // Type "abx", then Backspace the trailing 'x' — the fixture echoes its own
  // buffer back verbatim on Enter, so the SERVER-side buffer content (not the
  // plain view's own append-only rendering of the raw \b\x20\b bytes) is what
  // actually proves Backspace reached the PTY and was applied.
  await plainBlock.click();
  await window.keyboard.type('abx');
  await window.keyboard.press('Backspace');
  await window.keyboard.press('Enter');

  await expect.poll(() => plainText(window), { timeout: 10_000 }).toContain('HELLO ab');
  const finalText = await plainText(window);
  expect(finalText).not.toContain('HELLO abx');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0);

  await app.close();
});

test('AC-1/AC-2 automated path: sigil-free .cmd shim resolves via PATHEXT, spawns PTY (M1), upgrades to xterm (M3)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // No `!`, no `.cmd` extension typed — CommandResolver must find ink-cmd-shim.cmd
  // via PATHEXT probing on its own, exactly as a bare `claude`/`codex` would.
  await window.getByTestId('cmd-input').fill(INK_CMD_SHIM);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-block')).toBeVisible();
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('INK-STYLE-READY');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

test('adaptive render: Ctrl+C reaches the PTY child through the plain input path', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`node ${LINE_PROMPT_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  const plainBlock = window.getByTestId('pty-plain-block');
  await expect(plainBlock).toBeVisible();
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('name:');

  await plainBlock.click();
  await window.keyboard.press('Control+c');

  await expect.poll(() => plainText(window), { timeout: 10_000 }).toContain('SIGINT');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0);

  await app.close();
});
