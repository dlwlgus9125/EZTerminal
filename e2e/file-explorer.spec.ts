import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// file-explorer plan, M1: the desktop left-edge drawer + read-only text viewer.
// One shared read-only fixture tree for every test in this file (created once —
// nothing here mutates it, so sharing is safe, unlike launchApp's per-test
// isolated userData dir which every test still gets its own).

let fixtureDir: string;

test.beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-files-'));
  writeFileSync(path.join(fixtureDir, 'plain.txt'), 'hello file explorer\n');
  writeFileSync(path.join(fixtureDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  writeFileSync(path.join(fixtureDir, '.dotfile'), 'dotfile contents\n');
  mkdirSync(path.join(fixtureDir, 'subdir'));
  writeFileSync(path.join(fixtureDir, 'subdir', 'nested.txt'), 'nested\n');
  writeFileSync(path.join(fixtureDir, 'big.txt'), 'a'.repeat(1_100_000));
});

test('toggle button opens and closes the drawer (file-list visible)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const panel = window.getByTestId('file-explorer-panel');
  const toggle = window.getByTestId('btn-toggle-files');

  await expect(panel).toHaveCount(0);

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(window.getByTestId('file-list')).toBeVisible();

  await toggle.click();
  await expect(panel).toHaveCount(0);

  await app.close();
});

test('typing the fixture path lists entries folders-first, dotfiles included', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-files').click();

  const pathInput = window.getByTestId('file-path-input');
  // Wait out the initial best-effort home-dir load before overwriting the
  // input — otherwise its async completion can clobber what we're about to type.
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');

  await expect(window.getByTestId('file-entry').filter({ hasText: 'subdir' })).toBeVisible();
  const names = await window.locator('[data-testid="file-entry"] .file-entry-name').allInnerTexts();
  expect(names.indexOf('subdir')).toBe(0); // the only dir — folders sort first
  expect(names).toContain('.dotfile');

  await app.close();
});

test('clicking a text file opens the read-only viewer with its content', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-files').click();

  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');

  await window.getByTestId('file-entry').filter({ hasText: 'plain.txt' }).click();
  await expect(window.getByTestId('file-viewer-overlay')).toBeVisible();
  await expect(window.getByTestId('viewer-content')).toHaveText('hello file explorer\n');

  await app.close();
});

test('clicking a binary file shows a notice instead of opening the viewer', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-files').click();

  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');

  await window.getByTestId('file-entry').filter({ hasText: 'binary.bin' }).click();
  await expect(window.getByTestId('file-binary-notice')).toBeVisible();
  await expect(window.getByTestId('file-viewer-overlay')).toHaveCount(0);

  await app.close();
});

test('a file over 1MiB opens the viewer with a truncated banner', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-files').click();

  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');

  await window.getByTestId('file-entry').filter({ hasText: 'big.txt' }).click();
  await expect(window.getByTestId('file-viewer-overlay')).toBeVisible();
  await expect(window.getByTestId('viewer-truncated')).toBeVisible();

  await app.close();
});

test('Up navigates to the parent directory (fixture dir shows up as an entry)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId('btn-toggle-files').click();

  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');
  await expect(window.getByTestId('file-entry').filter({ hasText: 'subdir' })).toBeVisible();

  await window.getByTestId('file-up').click();

  const fixtureBaseName = path.basename(fixtureDir);
  await expect(window.getByTestId('file-entry').filter({ hasText: fixtureBaseName })).toBeVisible();

  await app.close();
});

// file-explorer plan, M2: custom right-click context menu (NOT Electron's native
// Menu) + the mutations/terminal-integration it drives. `openDrawerAtFixture` only
// backs the tests below — the M1 tests above stay untouched, each with its own
// inline open+navigate steps.

/** Opens the drawer and navigates it to the shared `fixtureDir` (M2 setup only). */
async function openDrawerAtFixture(window: Page): Promise<void> {
  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');
}

test('right-click a file entry opens a context menu with the expected items', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);

  await window.getByTestId('file-entry').filter({ hasText: 'plain.txt' }).click({ button: 'right' });
  const menu = window.getByTestId('file-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('ctx-copy-path')).toBeVisible();
  await expect(menu.getByTestId('ctx-copy-name')).toBeVisible();
  await expect(menu.getByTestId('ctx-paste-path')).toBeVisible();
  await expect(menu.getByTestId('ctx-open-app')).toBeVisible();
  await expect(menu.getByTestId('ctx-reveal')).toBeVisible();
  await expect(menu.getByTestId('ctx-rename')).toBeVisible();
  await expect(menu.getByTestId('ctx-delete')).toBeVisible();

  await app.close();
});

test('ctx-new-folder creates a folder that appears in the listing', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);
  await expect(window.getByTestId('file-entry').filter({ hasText: 'subdir' })).toBeVisible();

  // Right-click the list background (below all rows), not a specific entry.
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-new-folder').click();
  await window.getByTestId('new-folder-input').fill('e2e-new-folder');
  await window.getByTestId('new-folder-input').press('Enter');

  await expect(window.getByTestId('file-entry').filter({ hasText: 'e2e-new-folder' })).toBeVisible();

  await app.close();
});

test('ctx-rename renames an entry, which then appears under its new name', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);

  // A throwaway folder to rename, isolated from the shared read-only fixtures above.
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-new-folder').click();
  await window.getByTestId('new-folder-input').fill('e2e-before-rename');
  await window.getByTestId('new-folder-input').press('Enter');
  const target = window.getByTestId('file-entry').filter({ hasText: 'e2e-before-rename' });
  await expect(target).toBeVisible();

  await target.click({ button: 'right' });
  await window.getByTestId('ctx-rename').click();
  await window.getByTestId('rename-input').fill('e2e-after-rename');
  await window.getByTestId('rename-input').press('Enter');

  await expect(window.getByTestId('file-entry').filter({ hasText: 'e2e-after-rename' })).toBeVisible();
  await expect(window.getByTestId('file-entry').filter({ hasText: 'e2e-before-rename' })).toHaveCount(0);

  await app.close();
});

test('ctx-delete opens a confirm overlay; confirming removes the entry from the listing', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);

  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-new-folder').click();
  await window.getByTestId('new-folder-input').fill('e2e-delete-me');
  await window.getByTestId('new-folder-input').press('Enter');
  const target = window.getByTestId('file-entry').filter({ hasText: 'e2e-delete-me' });
  await expect(target).toBeVisible();

  await target.click({ button: 'right' });
  await window.getByTestId('ctx-delete').click();
  await expect(window.getByTestId('delete-confirm')).toBeVisible();
  await window.getByTestId('delete-confirm-yes').click();

  await expect(window.getByTestId('file-entry').filter({ hasText: 'e2e-delete-me' })).toHaveCount(0);

  await app.close();
});

test('ctx-copy-path writes the entry\'s full path to the clipboard', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);

  await window.getByTestId('file-entry').filter({ hasText: 'plain.txt' }).click({ button: 'right' });
  await window.getByTestId('ctx-copy-path').click();

  const expectedPath = path.join(fixtureDir, 'plain.txt');
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(expectedPath);

  await app.close();
});

test('ctx-open-terminal opens a new terminal pane whose session starts at that directory', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1); // fresh launch starts with exactly one pane

  await openDrawerAtFixture(window);
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();

  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1).getByTestId('prompt-cwd')).toHaveAttribute('title', fixtureDir, {
    timeout: 10_000,
  });

  await app.close();
});

test('ctx-paste-path inserts the entry\'s full path into the active terminal input', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);

  await window.getByTestId('file-entry').filter({ hasText: 'plain.txt' }).click({ button: 'right' });
  await window.getByTestId('ctx-paste-path').click();

  const expectedPath = path.join(fixtureDir, 'plain.txt');
  await expect(window.getByTestId('cmd-input')).toHaveValue(expectedPath);

  await app.close();
});
