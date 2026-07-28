import { test, expect } from './test';
import path from 'node:path';

import { launchApp } from './launch-app';

function fixturePath(name: string): string {
  return path.resolve(__dirname, 'fixtures', name).replace(/\\/g, '/');
}

test('run-script: ez.run(...) pipeline result feeds back as transformed rows', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill(`run-script "${fixturePath('script-pipeline.js')}"`);
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 15_000 });
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
  await expect(window.getByTestId('block-status')).toHaveText('running');

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 5_000 });

  await input.fill('gen-rows 2');
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });
  await app.close();
});
