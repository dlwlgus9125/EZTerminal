import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// AC-4 (git commit leg): pty.spec.ts covers bare `git log`; this covers bare
// `git commit` with no `-m`, which spawns an interactive editor and BLOCKS until
// it exits — a materially different code path (a real child-process wait, not
// just static output) than `git log`. $env.GIT_EDITOR points at a fixture editor
// (git-editor.js) that plays the "user edits, saves, quits" role without a real
// terminal UI, so this stays CI-automatable; a real editor's actual TUI/keybinds
// remain a manual check (docs/release/cli-parity-manual-checklist.md).

const GIT_EDITOR_FIXTURE = path.resolve(__dirname, 'fixtures', 'git-editor.js').replace(/\\/g, '/');

test('AC-4: bare `git commit` (no -m) auto-routes to PTY, waits on $GIT_EDITOR, and completes the commit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-git-commit-'));
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  run(['init']);
  run(['config', 'user.email', 'ezterm-e2e@example.com']);
  run(['config', 'user.name', 'EZTerminal E2E']);
  run(['config', 'core.pager', 'cat']);
  writeFileSync(path.join(dir, 'marker.txt'), 'hello');
  run(['add', 'marker.txt']);

  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const dirArg = dir.replace(/\\/g, '/');
  await window.getByTestId('cmd-input').fill(`cd "${dirArg}"`);
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  await window.getByTestId('cmd-input').fill(`$env.GIT_EDITOR = "node ${GIT_EDITOR_FIXTURE}"`);
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('block').last().getByTestId('block-status')).toHaveText('done', {
    timeout: 10_000,
  });

  // Bare, sigil-free single command → auto-PTY (M2). git spawns the fixture
  // editor and BLOCKS on it — proving the PTY path genuinely waits for a child
  // process rather than just capturing static output.
  await window.getByTestId('cmd-input').fill('git commit');
  await window.getByTestId('btn-run').click();

  const commitBlock = window.getByTestId('block').last();
  await expect(commitBlock.getByTestId('pty-plain-block')).toBeVisible();
  await expect(commitBlock.getByTestId('pty-block')).toHaveCount(0);
  await expect
    .poll(() => commitBlock.getByTestId('text-output').innerText(), { timeout: 15_000 })
    .toContain('ezterm-e2e-editor-commit');
  await expect(commitBlock.getByTestId('block-status')).toHaveText('done', { timeout: 15_000 });

  // The commit actually landed (not just editor output rendered) — verified
  // from OUTSIDE the app, against the real repo on disk.
  const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' });
  expect(log).toContain('ezterm-e2e-editor-commit');

  await app.close();
});
