import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

// M5: full-screen TUI round-trip in real Electron. `!node <fixture>` launches an
// interactive program inside an xterm `pty` block; we assert output renders, typed
// input round-trips back through the PTY, and Cancel kills it (status `cancelled`).
// (In dev, electron-forge auto-rebuilds node-pty for the Electron ABI.)

const ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.js');
const ECHO_CMD_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-echo.cmd');

/** Concatenated text currently rendered in the xterm grid (post-upgrade). */
async function terminalText(window: Page): Promise<string> {
  return readXtermBuffer(window.getByTestId('pty-block'));
}

/** Concatenated text currently rendered in the plain PTY view (M3, pre-upgrade). */
async function plainText(window: Page): Promise<string> {
  return window.getByTestId('text-output').innerText();
}

test('PTY: `!node <fixture>` runs an interactive program in an xterm block and round-trips input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`!node ${ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  // The xterm-backed pty block mounts and the program's startup output appears.
  const ptyBlock = window.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect(window.getByTestId('block-status')).toHaveText('running');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('READY');

  // Type into the focused terminal; the fixture echoes it back via the PTY.
  await ptyBlock.click();
  await window.keyboard.type('hi');
  await window.keyboard.press('Enter');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('ECHO:');

  // Cancel kills the PTY child → status flips to cancelled (not done).
  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });

  await app.close();
});

test('PTY: `!fixture.cmd` (M1 batch shim) runs an interactive program in an xterm block and round-trips input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`!${ECHO_CMD_FIXTURE}`);
  await window.getByTestId('btn-run').click();

  // The batch shim spawns via cmd.exe + buildCmdLine (M1) into the same xterm pty
  // block as a non-batch program.
  const ptyBlock = window.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect(window.getByTestId('block-status')).toHaveText('running');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('READY');

  // Type into the focused terminal; the fixture echoes it back via the PTY.
  await ptyBlock.click();
  await window.keyboard.type('hi');
  await window.keyboard.press('Enter');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('ECHO:');

  // Cancel tree-kills cmd.exe + its node child (M1: batch runs under cmd.exe).
  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });

  await app.close();
});

test('PTY: a non-batch external WITHOUT `!` auto-routes to PTY execution, rendered PLAIN (M2 routing + M3 adaptive render)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // No `!` needed — a bare single-stage external command is ALWAYS interactive
  // PTY execution (M2). `node --version` emits no TUI signal (M0a measurement:
  // an instant plain exit, like `git --version`), so render stays plain — a
  // text-like block with live input wiring, not an xterm mount (M3).
  await window.getByTestId('cmd-input').fill('node --version');
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-plain-block')).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toMatch(/v?\d+\.\d+\.\d+/);
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

// ── AC-3: node REPL — sigil-free, machine-verifiable input/output round trip ────
// M0a measured ZERO high-confidence TUI signals from node/python REPLs — the real
// observed path is PLAIN render (not an xterm upgrade), with input wired via the
// minimal keyset (M3, B-R4). This asserts that actual path, not an assumed one.

test('AC-3: bare `node` REPL auto-routes to PTY, rendered PLAIN — prompt, evaluate, exit via plain input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('node');
  await window.getByTestId('btn-run').click();

  const plainBlock = window.getByTestId('pty-plain-block');
  await expect(plainBlock).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  // Node's REPL prompt appears (raw-mode, real TTY behavior — no sigil needed).
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('>');

  // Evaluate an expression through the plain-mode input path (B-R4 minimal
  // keyset), which now routes through cmd-input (M1 focus retention) instead
  // of the output view.
  await window.getByTestId('cmd-input').click();
  await window.keyboard.type('21 + 21');
  await window.keyboard.press('Enter');
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('42');

  // Exit the REPL — the PTY child exits normally (status flips to done, not cancelled).
  await window.keyboard.type('.exit');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0); // never upgraded, per M0a

  await app.close();
});

// ── AC-4: git flow — sigil-free, local repo fixture (machine path) ──────────────
// M0a measured ZERO signals for `git log` with no pager configured (this box) —
// stays plain, per the same "assert the observed path" discipline as AC-3.

test('AC-4: bare `git log` in a local repo auto-routes to PTY, rendered PLAIN, and shows the commit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-git-'));
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  run(['init']);
  run(['config', 'user.email', 'ezterm-e2e@example.com']);
  run(['config', 'user.name', 'EZTerminal E2E']);
  // Avoid an interactive pager — this test asserts the auto-PTY routing + output,
  // not the pager UX (M5's manual checklist covers the full git flow).
  run(['config', 'core.pager', 'cat']);
  writeFileSync(path.join(dir, 'marker.txt'), 'hello');
  run(['add', 'marker.txt']);
  run(['commit', '-m', 'ezterm-e2e-marker-commit']);

  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const dirArg = dir.replace(/\\/g, '/');
  await window.getByTestId('cmd-input').fill(`cd "${dirArg}"`);
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  await window.getByTestId('cmd-input').fill('git log');
  await window.getByTestId('btn-run').click();

  // Scoped to the LATEST block: the prior `cd` also produced a `text-output`
  // (its confirmation is a `text`-shape block, same testid as the plain PTY
  // view's output) — window-wide getByTestId would be ambiguous with 2+ blocks.
  const gitBlock = window.getByTestId('block').last();
  await expect(gitBlock.getByTestId('pty-plain-block')).toBeVisible();
  await expect(gitBlock.getByTestId('pty-block')).toHaveCount(0);
  await expect
    .poll(() => gitBlock.getByTestId('text-output').innerText(), { timeout: 15_000 })
    .toContain('ezterm-e2e-marker-commit');
  await expect(gitBlock.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});
