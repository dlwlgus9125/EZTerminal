import {
  createRegisteredE2eTempDir,
  expect,
  test,
  type Page,
} from './test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';

let fixtureDir: string;

test.beforeEach(() => {
  fixtureDir = createRegisteredE2eTempDir('ezterm-e2e-files-');
  writeFileSync(path.join(fixtureDir, 'plain.txt'), 'hello file explorer\n');
  writeFileSync(path.join(fixtureDir, 'app.test.ts'), 'export const tested = true;\n');
  writeFileSync(path.join(fixtureDir, 'package.json'), '{}\n');
  writeFileSync(path.join(fixtureDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(path.join(fixtureDir, '.dotfile'), 'dotfile contents\n');
  mkdirSync(path.join(fixtureDir, 'subdir'));
  writeFileSync(path.join(fixtureDir, 'subdir', 'nested.txt'), 'nested\n');
});

async function openDrawerAtFixture(window: Page): Promise<void> {
  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(fixtureDir);
  await pathInput.press('Enter');
  await expect(window.getByTestId('file-entry').filter({ hasText: 'subdir' })).toBeVisible();
}

test('file explorer browses folders-first, includes dotfiles, and previews text', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId('file-explorer-panel')).toHaveCount(0);
  await openDrawerAtFixture(window);

  const names = await window.locator('[data-testid="file-entry"] .file-entry-name').allInnerTexts();
  expect(names[0]).toBe('subdir');
  expect(names).toContain('.dotfile');
  await expect(window.getByTestId('file-entry').filter({ hasText: 'subdir' })
    .locator('[data-icon="folder"]')).toBeVisible();
  await expect(window.getByTestId('file-entry').filter({ hasText: 'app.test.ts' })
    .locator('[data-icon="test"]')).toBeVisible();
  await expect(window.getByTestId('file-entry').filter({ hasText: 'package.json' })
    .locator('[data-icon="package"]')).toBeVisible();
  await expect(window.getByTestId('file-entry').filter({ hasText: 'logo.svg' })
    .locator('[data-icon="image"]')).toBeVisible();

  await window.getByTestId('file-entry').filter({ hasText: 'plain.txt' }).click();
  await expect(window.getByTestId('file-viewer-overlay')).toBeVisible();
  await expect(window.getByTestId('viewer-content')).toHaveText('hello file explorer\n');
  await window.getByTestId('viewer-close').click();
  await expect(window.getByTestId('file-viewer-overlay')).toHaveCount(0);

  await window.getByTestId('btn-toggle-files').click();
  await expect(window.getByTestId('file-explorer-panel')).toHaveCount(0);
  await app.close();
});

test('file explorer completes a create, rename, and delete lifecycle', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await openDrawerAtFixture(window);

  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-new-folder').click();
  await window.getByTestId('new-folder-input').fill('e2e-before-rename');
  await window.getByTestId('new-folder-input').press('Enter');
  const original = window.getByTestId('file-entry').filter({ hasText: 'e2e-before-rename' });
  await expect(original).toBeVisible();

  await original.click({ button: 'right' });
  await window.getByTestId('ctx-rename').click();
  await window.getByTestId('rename-input').fill('e2e-delete-me');
  await window.getByTestId('rename-input').press('Enter');
  const renamed = window.getByTestId('file-entry').filter({ hasText: 'e2e-delete-me' });
  await expect(renamed).toBeVisible();
  await expect(original).toHaveCount(0);

  await renamed.click({ button: 'right' });
  await window.getByTestId('ctx-delete').click();
  await expect(window.getByTestId('delete-confirm')).toBeVisible();
  await window.getByTestId('delete-confirm-yes').click();
  await expect(renamed).toHaveCount(0);
  await app.close();
});

test('file explorer opens a terminal whose session starts in the selected directory', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(1);
  await openDrawerAtFixture(window);

  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1).getByTestId('prompt-cwd')).toHaveAttribute('title', fixtureDir, {
    timeout: 10_000,
  });
  await app.close();
});
