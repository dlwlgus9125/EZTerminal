import { test, expect } from '@playwright/test';
import path from 'node:path';

import { launchApp } from './launch-app';

// E4: `run-script <path>` — a script's default export decides the block shape
// (v1: rows array -> table, else -> merged stdout+stderr text). Because the
// interpreter forwards backslash escapes in a quoted string literal (e.g. `\t`
// -> TAB), fixture paths are normalized to forward slashes before quoting,
// matching the existing `cd` e2e convention (launch.spec.ts).
function fixturePath(name: string): string {
  return path.resolve(__dirname, 'fixtures', name).replace(/\\/g, '/');
}

test('run-script: a plain-object array default export renders a table block', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`run-script "${fixturePath('script-rows.js')}"`);
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId('row-count')).toHaveText('3', { timeout: 15_000 });
  await expect(table).toContainText('alpha');
  await expect(table).toContainText('gamma');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

test('run-script: no default export renders stdout+stderr merged as a text block', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`run-script "${fixturePath('script-text.js')}"`);
  await window.getByTestId('btn-run').click();

  const out = window.getByTestId('text-output');
  await expect(out).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(out).toContainText('hello from stdout');
  await expect(out).toContainText('hello from stderr');
  await expect(window.getByTestId('result-table')).toHaveCount(0);

  await app.close();
});

test('run-script: ez.run(...) pipeline result feeds back as transformed rows', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`run-script "${fixturePath('script-pipeline.js')}"`);
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 15_000 });
  // gen-rows 5 | where n > 2 -> n=3,4,5; doubled = 6,8,10.
  await expect(window.getByTestId('row-count')).toHaveText('3', { timeout: 15_000 });
  await expect(window.getByTestId('table-header').filter({ hasText: 'doubled' }).first()).toBeVisible();
  await expect(table).toContainText('6');
  await expect(table).toContainText('10');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  await app.close();
});

test('run-script: cancelling an infinite script kills the host — status cancelled, pane still usable', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');
  await input.fill(`run-script "${fixturePath('script-infinite.js')}"`);
  await window.getByTestId('btn-run').click();

  // v1 has no live streaming (script runs to completion before anything
  // renders), so the block shows the generic pending state while running —
  // there is nothing else to assert until it settles.
  await expect(window.getByTestId('block-status')).toHaveText('running');

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 5_000 });

  // No zombie: a follow-up command in the SAME pane still runs fine afterward.
  await input.fill('gen-rows 2');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  await app.close();
});

test('run-script: a throwing default export renders an error block', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`run-script "${fixturePath('script-error.js')}"`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('block-status')).toHaveText('error', { timeout: 15_000 });
  await expect(window.getByTestId('block-error')).toContainText('deliberate script failure');

  await app.close();
});
