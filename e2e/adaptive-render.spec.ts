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
  // Plain-mode input now routes through cmd-input (M1 focus retention) — it
  // stays enabled/focused through the run, so click it, not the output view.
  await window.getByTestId('cmd-input').click();
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

  // Plain-mode input routes through cmd-input now (M1) — click it, not the
  // output view.
  await window.getByTestId('cmd-input').click();
  await window.keyboard.press('Control+c');

  await expect.poll(() => plainText(window), { timeout: 10_000 }).toContain('SIGINT');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0);

  await app.close();
});

// ── M1: focus retention (composer stays the single input surface) ───────────

test('AC-1 focus retention: cmd-input keeps focus through a plain run and is immediately retypable, no click needed', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const cmdInput = window.getByTestId('cmd-input');
  await cmdInput.click();
  await cmdInput.fill('echo hi');
  // Enter (not a Run-button click) is the real flow this fixes: cmd-input
  // already has focus from typing, and it is no longer disabled for the
  // duration of the run (M1 — disabled is activeTakeover-gated, not
  // activeRunning-gated), so focus is never yanked away mid-run.
  await cmdInput.press('Enter');

  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(cmdInput).toBeFocused();

  // Immediately typeable with no click in between — proves focus was never
  // lost (not merely re-focused afterward, PtyBlock.tsx's exit-focus effect).
  await window.keyboard.press('Control+a');
  await window.keyboard.type('echo again');
  await expect(cmdInput).toHaveValue('echo again');

  await app.close();
});

test('mode-key-map guard: Arrow/Enter mean history-recall+run when idle, PTY input while a plain run is active', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const cmdInput = window.getByTestId('cmd-input');

  // Idle baseline: run one throwaway command so ArrowUp has history to recall.
  await cmdInput.fill('echo idle-marker');
  await cmdInput.press('Enter');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await cmdInput.fill('');
  await cmdInput.press('ArrowUp');
  await expect(cmdInput).toHaveValue('echo idle-marker'); // idle: Arrow recalls history

  // Start a plain PTY run and wait for its input prompt. Scoped to the LATEST
  // block: the idle run above left its own (finished) `text-output`/
  // `block-status` in the DOM, so an unscoped lookup would be ambiguous
  // under Playwright's strict mode (mirrors pty.spec.ts's AC-4 pattern).
  await cmdInput.fill(`node ${LINE_PROMPT_FIXTURE}`);
  await cmdInput.press('Enter');
  const runBlock = window.getByTestId('block').last();
  const plainBlock = runBlock.getByTestId('pty-plain-block');
  await expect(plainBlock).toBeVisible();
  await expect
    .poll(() => runBlock.getByTestId('text-output').innerText(), { timeout: 15_000 })
    .toContain('name:');

  // activePlainPty: ArrowUp does NOT recall history into the composer — the
  // mode-key-map guard suspends history/Enter-run while a plain PTY run owns
  // the composer's keystrokes.
  const beforeArrow = await cmdInput.inputValue();
  await window.keyboard.press('ArrowUp');
  await expect(cmdInput).toHaveValue(beforeArrow); // unchanged — not history recall

  // Enter goes to the PTY as '\r' (not a new run) — the fixture echoes the
  // typed name back on Enter, which only happens if Enter reached the PTY.
  await window.keyboard.type('bob');
  await window.keyboard.press('Enter');
  await expect
    .poll(() => runBlock.getByTestId('text-output').innerText(), { timeout: 10_000 })
    .toContain('HELLO bob');
  await expect(runBlock.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});
