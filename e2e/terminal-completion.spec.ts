import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

/**
 * I3: Tab on the terminal's prompt line completes paths and commands, answered
 * by the session's own interpreter. One match fills in; several fill their
 * shared part and open a list. With nothing to complete Tab moves focus, and a
 * running program gets Tab itself.
 */

function quoted(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\')}"`;
}

test('Tab completes files, folders and PATH commands; Tab on an empty line moves focus', async () => {
  test.setTimeout(180_000);
  const work = createRegisteredE2eTempDir('ezterm-complete-work-');
  mkdirSync(path.join(work, 'alpha-folder'));
  mkdirSync(path.join(work, 'my folder'));
  writeFileSync(path.join(work, 'alpine.txt'), 'alpine\n');
  writeFileSync(path.join(work, 'beta.txt'), 'beta\n');
  const bin = createRegisteredE2eTempDir('ezterm-complete-bin-');
  writeFileSync(path.join(bin, 'ezfakecmd.cmd'), '@echo ezfakecmd\r\n');
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(undefined, { [key]: `${bin}${path.delimiter}${process.env[key] ?? ''}` });
  const page = await app.firstWindow();
  try {
    const pane = page.locator('[data-testid="pane"]:visible').first();
    const input = pane.getByTestId('cmd-input');
    await expect(input).toBeEnabled();
    await expect(pane.getByTestId('term-dock')).toContainText('Tab');
    await input.fill(`cd ${quoted(work)}`);
    await input.press('Enter');
    await expect(pane.getByTestId('block').last()).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

    // One match fills in, with a space after a file.
    await input.fill('cat be');
    await input.press('Tab');
    await expect(input).toHaveValue('cat beta.txt ');

    // Several: the shared part goes in and the list opens; the arrows pick, Enter takes.
    await input.fill('cat al');
    await input.press('Tab');
    await expect(input).toHaveValue('cat alp');
    const list = pane.getByTestId('terminal-completion');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('terminal-completion-option')).toHaveText(['alpha-folder\\', 'alpine.txt']);
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: path.resolve('artifacts/ux2/terminal/e2e/terminal-completion.png') });
    await input.press('ArrowDown');
    await expect(list.getByRole('option', { selected: true })).toHaveText('alpine.txt');
    await input.press('Enter');
    await expect(input).toHaveValue('cat alpine.txt ');
    await expect(list).toHaveCount(0);

    // Esc closes the list and keeps the line.
    await input.fill('cat al');
    await input.press('Tab');
    await expect(list).toBeVisible();
    await input.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(input).toHaveValue('cat alp');

    // After `cd` only folders.
    await input.fill('cd al');
    await input.press('Tab');
    await expect(input).toHaveValue('cd alpha-folder\\');

    // A folder with a space comes back quoted and closed: the line runs as it stands.
    await input.fill('cd my');
    await input.press('Tab');
    await expect(input).toHaveValue('cd "my folder\\\\"');
    await input.press('Enter');
    await expect(pane.getByTestId('block').last()).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(pane.getByTestId('prompt-cwd')).toHaveAttribute('title', /my folder\\?$/u);
    await input.fill(`cd ${quoted(work)}`);
    await input.press('Enter');
    await expect(pane.getByTestId('block').last()).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

    // The command position: executables on PATH, without their extension.
    await input.fill('ezfakec');
    await input.press('Tab');
    await expect(input).toHaveValue('ezfakecmd ');

    // Nothing to complete: Tab moves focus on, as everywhere else.
    await input.fill('');
    await input.press('Tab');
    await expect(input).not.toBeFocused();
  } finally {
    await app.close();
  }
});

test('a running program gets Tab itself', async () => {
  test.setTimeout(120_000);
  // A program that prints what it reads, so the Tab byte shows.
  const work = createRegisteredE2eTempDir('ezterm-complete-program-');
  const program = path.join(work, 'tab-echo.js');
  writeFileSync(program, [
    "process.stdout.write('READY\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { process.stdout.write('GOT:' + JSON.stringify(d) + '\\n'); if (d.includes('q')) process.exit(0); });",
  ].join('\n'));
  const app = await launchApp();
  const page = await app.firstWindow();
  try {
    const pane = page.locator('[data-testid="pane"]:visible').first();
    const input = pane.getByTestId('cmd-input');
    await expect(input).toBeEnabled();
    await input.fill(`node ${quoted(program)}`);
    await input.press('Enter');
    await expect(pane.getByTestId('pty-plain-block')).toBeVisible();
    const output = (): Promise<string> => pane.getByTestId('text-output').last().innerText();
    await expect.poll(output, { timeout: 15_000 }).toContain('READY');
    await input.click();
    await page.keyboard.type('ab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(output, { timeout: 15_000 }).toContain('GOT:"ab\\t');
    await expect(pane.getByTestId('terminal-completion')).toHaveCount(0);
    await page.keyboard.type('q');
    await page.keyboard.press('Enter');
    await expect(pane.getByTestId('block').last()).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  } finally {
    await app.close();
  }
});
