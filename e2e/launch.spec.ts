import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './launch-app';

async function renderedRowIndices(window: Page): Promise<number[]> {
  return window
    .locator('[data-testid="table-row"]')
    .evaluateAll((elements) => elements.map((element) => Number(element.getAttribute('data-row-index'))));
}

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
  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});

test('pipeline: gen-rows 5 | where n > 2 | sort-by n renders a table block', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window.getByTestId('cmd-input').fill('gen-rows 5 | where n > 2 | sort-by n');
  await window.getByTestId('btn-run').click();

  const table = window.getByTestId('result-table');
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(window.getByTestId('table-header').filter({ hasText: 'n' }).first()).toBeVisible();
  await expect(window.getByTestId('table-header').filter({ hasText: 'name' })).toBeVisible();
  await expect(table).toContainText('row-3');
  await expect(table).toContainText('row-5');
  await expect(table).not.toContainText('row-2');
  await expect(window.getByTestId('row-count')).toHaveText('3');
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 10_000 });
  await app.close();
});

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
  await expect(window.getByTestId('row-count')).toHaveText('100000', { timeout: 15_000 });
  await expect(window.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });
  await expect(table).toContainText('row-1', { timeout: 10_000 });
  await expect(async () => {
    expect(await window.getByTestId('table-row').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });

  const renderedCount = await window.getByTestId('table-row').count();
  expect(renderedCount).toBeGreaterThan(0);
  expect(renderedCount).toBeLessThan(200);
  expect(Math.min(...(await renderedRowIndices(window)))).toBeLessThan(50);

  await window.locator('[data-testid="table-scroll"]').evaluate((element) => {
    (element as HTMLElement).scrollTop = 12_000;
  });
  await expect
    .poll(async () => Math.min(...(await renderedRowIndices(window))), { timeout: 10_000 })
    .toBeGreaterThan(100);
  expect(await window.getByTestId('table-row').count()).toBeLessThan(200);

  await window.getByTestId('block-toggle').click();
  await expect(window.getByTestId('result-table')).toHaveCount(0);
  await window.getByTestId('block-toggle').click();
  await expect(window.getByTestId('result-table')).toBeVisible();

  await app.close();
  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});

test('cancel: a long-running EXTERNAL process stops with cancelled status + no more output', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  await window
    .getByTestId('cmd-input')
    .fill(`node -e "setInterval(() => process.stdout.write('tick'), 50)"`);
  await window.getByTestId('btn-run').click();

  await expect(window.getByTestId('pty-plain-block')).toBeVisible();
  await expect(window.getByTestId('pty-block')).toHaveCount(0);
  await expect.poll(() => plainText(window), { timeout: 15_000 }).toContain('tick');
  await expect(window.getByTestId('block-status')).toHaveText('running');

  await window.getByTestId('block-cancel').click();
  await expect(window.getByTestId('block-status')).toHaveText('cancelled', { timeout: 15_000 });
  await window.waitForTimeout(500);
  const settled = await plainText(window);
  await window.waitForTimeout(800);
  expect(await plainText(window)).toBe(settled);
  await app.close();
});

test('history: ↑/↓ recall prior commands in the input + `history` lists them as a table', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  const input = window.getByTestId('cmd-input');

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

  await input.fill('');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('gen-rows 2');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('gen-rows 1');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('gen-rows 2');

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

test('auto-scroll: the block list follows new output to the bottom on each command', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const input = window.getByTestId('cmd-input');
  const list = window.getByTestId('block-list');
  for (let i = 1; i <= 4; i += 1) {
    await input.fill(`gen-rows ${i}`);
    await window.getByTestId('btn-run').click();
    await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText(
      'done',
      { timeout: 10_000 },
    );
  }

  expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect
    .poll(async () => list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight), {
      timeout: 10_000,
    })
    .toBeLessThan(8);
  await app.close();
});
