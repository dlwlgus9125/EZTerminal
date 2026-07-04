import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

/** Read the absolute row indices currently mounted in the DOM (virtualized rows). */
async function renderedRowIndices(window: Page): Promise<number[]> {
  return window
    .locator('[data-testid="table-row"]')
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-row-index'))));
}

/** Concatenated text currently rendered in the plain PTY view (M3, pre-upgrade). */
async function plainText(window: Page): Promise<string> {
  return window.getByTestId('text-output').innerText();
}

test('app launches and renders EZTerminal with no console errors', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  const consoleErrors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  window.on('pageerror', (error) => consoleErrors.push(error.message));

  await expect(window.locator('#root')).toBeVisible();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await app.close();

  expect(
    consoleErrors,
    `unexpected console errors:\n${consoleErrors.join('\n')}`,
  ).toEqual([]);
});

// ── T6: structured pipelines now render as Blocks with a virtualized table ──────
// (T1–T4 covered the same pipelines as a JSON dump; the data path is unchanged.)

test('pipeline: gen-rows 5 | where n > 2 | sort-by n renders a table block', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('gen-rows 5 | where n > 2 | sort-by n');
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 10_000 });

  // Column headers come from the schema frame.
  await expect(window.getByTestId('table-header').filter({ hasText: 'n' }).first()).toBeVisible();
  await expect(window.getByTestId('table-header').filter({ hasText: 'name' })).toBeVisible();

  // Surviving rows (n > 2) ascending; filtered rows must not appear.
  await expect(table).toContainText('row-3');
  await expect(table).toContainText('row-5');
  await expect(table).not.toContainText('row-2');

  await expect(window.getByTestId('row-count')).toHaveText('3');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});

test('pipeline: ls renders a table block with file columns', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('ls');
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 10_000 });

  for (const col of ['name', 'size', 'type', 'modified']) {
    await expect(window.getByTestId('table-header').filter({ hasText: col }).first()).toBeVisible();
  }

  // The launch cwd is never empty, so at least one row renders.
  await expect(async () => {
    expect(await window.getByTestId('table-row').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });

  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});

// ── T5 + T6: the load-bearing demo — gen-rows 100000 in a virtualized table ─────

test('gen-rows 100000 renders a virtualized table (windowed, smooth, total 100000)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  const consoleErrors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  window.on('pageerror', (error) => consoleErrors.push(error.message));

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('gen-rows 100000');
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 15_000 });

  // The full row total is reported (without shipping 100k rows to the renderer).
  await expect(window.getByTestId('row-count')).toHaveText('100000', { timeout: 15_000 });
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  // The top window loaded its real data.
  await expect(table).toContainText('row-1', { timeout: 10_000 });

  // VIRTUALIZATION: only a tiny window of the 100000 rows is in the DOM.
  await expect(async () => {
    expect(await window.getByTestId('table-row').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });

  const renderedCount = await window.getByTestId('table-row').count();
  expect(renderedCount).toBeGreaterThan(0);
  expect(renderedCount).toBeLessThan(200); // far smaller than 100000

  const before = await renderedRowIndices(window);
  expect(Math.min(...before)).toBeLessThan(50); // starts at the top

  // SCROLL changes which rows are mounted (windowed paging via requestRows/setViewport).
  await window.locator('[data-testid="table-scroll"]').evaluate((el) => {
    (el as HTMLElement).scrollTop = 12_000;
  });

  await expect
    .poll(async () => Math.min(...(await renderedRowIndices(window))), { timeout: 10_000 })
    .toBeGreaterThan(100);

  // Still windowed after scrolling — no flood.
  expect(await window.getByTestId('table-row').count()).toBeLessThan(200);

  // Collapse/expand toggles output visibility.
  await window.getByTestId('block-toggle').click();
  await expect(window.getByTestId('result-table')).toHaveCount(0);
  await window.getByTestId('block-toggle').click();
  await expect(window.getByTestId('result-table')).toBeVisible();

  await app.close();

  expect(
    consoleErrors,
    `unexpected console errors:\n${consoleErrors.join('\n')}`,
  ).toEqual([]);
});

// ── T7: external program execution auto-routes to PTY, rendered adaptively (M2+M3) ──

test('external: node --version auto-routes to PTY execution, rendered PLAIN (no TUI signal)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  const consoleErrors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  window.on('pageerror', (error) => consoleErrors.push(error.message));

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('node --version');
  await window.getByTestId('btn-run').click();

  // A bare single-stage external command is ALWAYS interactive PTY execution now
  // (M2). `node --version` emits no TUI signal (M0a measurement), so it renders
  // PLAIN — a text-like block with live input wiring, not an xterm mount (M3).
  await expect(window.getByTestId('pty-plain-block')).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toMatch(/v?\d+\.\d+\.\d+/);
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(window.getByTestId('result-table')).toHaveCount(0); // external ≠ table

  await app.close();

  expect(
    consoleErrors,
    `unexpected console errors:\n${consoleErrors.join('\n')}`,
  ).toEqual([]);
});

// ── T8: cancellation — external process AND builtin stream ──────────────────────

test('cancel: a long-running EXTERNAL process stops with cancelled status + no more output', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Runs forever (until killed): writes 'tick' every 50ms. No newline in the JS
  // source — our shell string lexer would decode "\n" to a real LF, which is an
  // illegal newline inside a JS string literal and would crash node on startup.
  await window
    .getByTestId('cmd-input')
    .fill(`node -e "setInterval(() => process.stdout.write('tick'), 50)"`);
  await window.getByTestId('btn-run').click();

  // Auto-routed to PTY execution (M2), rendered PLAIN (a `setInterval` writer
  // emits no TUI signal — M3 adaptive render). It is genuinely producing output
  // and still running.
  await expect(window.getByTestId('pty-plain-block')).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('tick');
  await expect(window.getByTestId('block-status')).toHaveText('running');

  // Cancel via the per-block control.
  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });

  // After cancel the child is killed: output stops growing (no more ticks).
  await window.waitForTimeout(500); // settle any already-buffered rows
  const settled = await plainText(window);
  await window.waitForTimeout(800);
  expect(await plainText(window)).toBe(settled);

  await app.close();
});

test('cancel: a long-running BUILTIN stream stops early with cancelled status', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // 100M rows — the background drain is still in progress (cancellable mid-flight).
  await window.getByTestId('cmd-input').fill('gen-rows 100000000');
  await window.getByTestId('btn-run').click();

  // Some rows have been counted and it is still running.
  await expect(window.getByTestId('block-status')).toHaveText('running');
  await expect
    .poll(async () => Number((await window.getByTestId('row-count').textContent()) ?? '0'), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });

  // It stopped early: nowhere near the full 100,000,000, and the count is frozen.
  const stopped = Number((await window.getByTestId('row-count').textContent()) ?? '0');
  expect(stopped).toBeGreaterThan(0);
  expect(stopped).toBeLessThan(100_000_000);
  await window.waitForTimeout(700);
  expect(Number((await window.getByTestId('row-count').textContent()) ?? '0')).toBe(stopped);

  await app.close();
});

// ── AC#4: persistent session — variables ($x) across runs ────────────────────────

test('variables: `let threshold = 2` then `gen-rows 5 | where n > $threshold` → 3,4,5', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Run 1: define a session variable (a confirmation text block, then done).
  await window.getByTestId('cmd-input').fill('let threshold = 2');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  // Run 2 (same window → same durable session): the variable resolves in `where`.
  await window.getByTestId('cmd-input').fill('gen-rows 5 | where n > $threshold');
  await window.getByTestId('btn-run').click();

  const block = window.getByTestId('block').last();
  const table = block.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 10_000 });

  // n > 2 → exactly rows 3,4,5; the filtered rows never appear.
  await expect(block.getByTestId('row-count')).toHaveText('3', { timeout: 10_000 });
  await expect(table).toContainText('row-3');
  await expect(table).toContainText('row-5');
  await expect(table).not.toContainText('row-2');
  await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});

// ── AC#4: persistent session — cd changes the cwd a later ls reflects ────────────

test('cd: `cd <dir>` then `ls` reflects the new directory (vs a prior ls)', async () => {
  // A throwaway directory with a uniquely-named marker file, created before launch.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ezterm-e2e-cd-'));
  const marker = 'ezterminal-cd-marker.txt';
  writeFileSync(path.join(tmp, marker), 'hello');
  // Forward slashes are valid path separators on Windows and avoid the shell
  // string lexer's backslash-escape handling (e.g. `\t` → TAB) on a quoted path.
  const tmpArg = tmp.replace(/\\/g, '/');

  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  // Run 1: ls of the launch cwd — it must NOT contain our unique marker.
  await window.getByTestId('cmd-input').fill('ls');
  await window.getByTestId('btn-run').click();
  const firstLs = window.getByTestId('block').last();
  await expect(firstLs.getByTestId('result-table')).toBeVisible({ timeout: 10_000 });
  await expect(firstLs.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });
  await expect(firstLs.getByTestId('result-table')).not.toContainText(marker);

  // Run 2: cd into the temp dir — mutates the durable session cwd.
  await window.getByTestId('cmd-input').fill(`cd "${tmpArg}"`);
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  // The live input prompt now reflects the NEW cwd (terminal-style `cd`): the
  // unique temp-dir name appears in the prompt path.
  await expect(window.getByTestId('prompt-cwd')).toContainText(path.basename(tmp), {
    timeout: 10_000,
  });

  // Run 3: ls now reflects the NEW cwd → it lists the marker file.
  await window.getByTestId('cmd-input').fill('ls');
  await window.getByTestId('btn-run').click();
  const secondLs = window.getByTestId('block').last();
  await expect(secondLs.getByTestId('result-table')).toBeVisible({ timeout: 10_000 });
  await expect(secondLs.getByTestId('result-table')).toContainText(marker, { timeout: 10_000 });
  await expect(secondLs.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});

// ── AC#4-B: command history — ↑/↓ input recall + the `history` builtin ────────────

test('history: ↑/↓ recall prior commands in the input + `history` lists them as a table', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');

  // Submit two distinct commands so the recall order is unambiguous.
  await input.fill('gen-rows 1');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  await input.fill('gen-rows 2');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  // ↑ recalls the newest, ↑ again the one before, ↓ steps forward again.
  await input.fill('');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('gen-rows 2');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('gen-rows 1');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('gen-rows 2');

  // The `history` builtin renders the prior commands as a structured table block.
  await input.fill('history');
  await window.getByTestId('btn-run').click();

  const historyBlock = window.getByTestId('block').last();
  const table = historyBlock.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(historyBlock.getByTestId('table-header').filter({ hasText: 'index' }).first()).toBeVisible();
  await expect(historyBlock.getByTestId('table-header').filter({ hasText: 'command' }).first()).toBeVisible();
  await expect(table).toContainText('gen-rows 1');
  await expect(table).toContainText('gen-rows 2');
  await expect(historyBlock.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });

  await app.close();
});

// ── AC#4-B: `ps` builtin — running processes as a structured table ───────────────

test('ps: `ps` renders a process table with pid/name columns and ≥1 row', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('ps');
  await window.getByTestId('btn-run').click();

  const block = window.getByTestId('block').last();
  const table = block.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 15_000 });

  await expect(block.getByTestId('table-header').filter({ hasText: 'pid' }).first()).toBeVisible();
  await expect(block.getByTestId('table-header').filter({ hasText: 'name' }).first()).toBeVisible();

  // The OS process table is never empty (this very app is in it).
  await expect(async () => {
    expect(await block.getByTestId('table-row').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });

  await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

// ── terminal-feel: the block list auto-scrolls to follow new output ───────────────

test('auto-scroll: the block list follows new output to the bottom on each command', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');
  const list = window.getByTestId('block-list');

  // Run several commands so the stacked blocks overflow the list's viewport.
  for (let i = 1; i <= 4; i++) {
    await input.fill(`gen-rows ${i}`);
    await window.getByTestId('btn-run').click();
    await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText(
      'done',
      { timeout: 10_000 },
    );
  }

  // The content genuinely overflowed (otherwise the assertion would be vacuous) and
  // the view scrolled away from the top.
  expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // The view is pinned to the bottom, following the newest block (terminal-style).
  await expect
    .poll(async () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 10_000,
    })
    .toBeLessThan(8);

  await app.close();
});
