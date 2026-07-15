import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// B-M5: shared-fate diagnostics. ONE utilityProcess backs every session — when
// it dies, every pane latches dead (existing behavior) and the app-level crash
// banner must appear, pointing at the local error log main.ts appended to.
// The interpreter is killed from OUTSIDE (OS-level), exactly like a real crash.

test('interpreter crash: the shell recovers in place and records the exit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-crash-e2e-'));
  const app = await launchApp(dir);
  const w = await app.firstWindow();

  // A live session proves the interpreter is up before we murder it.
  await expect(w.getByTestId('pane')).toHaveCount(1);
  await expect(w.getByTestId('pane').first()).toHaveAttribute('data-session-id', /.+/, {
    timeout: 15_000,
  });
  const sessionId = await w.getByTestId('pane').first().getAttribute('data-session-id');

  // Kill the interpreter utilityProcess (`--utility-sub-type=node`) the way a
  // real crash would take it down. Searched across ALL DESCENDANTS of the
  // launched process — depending on how Playwright spawned Electron, the main
  // process may be a child rather than the root pid. The kill count is echoed
  // and asserted so a silent no-match can never fake a pass.
  const mainPid = app.process().pid;
  const killed = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$all = Get-CimInstance Win32_Process; ` +
        `$tree = @(${mainPid}); ` +
        `do { $kids = @($all | Where-Object { $tree -contains $_.ParentProcessId -and $tree -notcontains $_.ProcessId }); $tree += $kids.ProcessId } while ($kids.Count -gt 0); ` +
        `$targets = @($all | Where-Object { $tree -contains $_.ProcessId -and $_.CommandLine -match '--utility-sub-type=node' }); ` +
        `$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; ` +
        `Write-Output $targets.Count`,
    ],
    { encoding: 'utf8' },
  ).trim();
  expect(Number(killed)).toBeGreaterThan(0);

  // The incident remains visible and locally diagnosable while the supervisor
  // restores the same session identity and re-enables keyboard input.
  await expect(w.getByTestId('crash-banner')).toBeVisible({ timeout: 15_000 });
  await expect(w.getByTestId('crash-banner')).toContainText('main.log');
  await expect(w.getByTestId('pane').first()).toHaveAttribute('data-session-id', sessionId!);
  await expect(w.getByTestId('cmd-input')).toBeEnabled({ timeout: 15_000 });

  await w.getByTestId('cmd-input').click();
  await w.keyboard.type('gen-rows 1');
  await w.keyboard.press('Enter');
  await expect(w.getByTestId('block-status').last()).toHaveText('done', { timeout: 15_000 });

  // The local log recorded the event (B-M5 evidence trail).
  const logFile = path.join(dir, 'logs', 'main.log');
  await expect
    .poll(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('interpreter exited'), {
      timeout: 10_000,
    })
    .toBe(true);

  // Banner is dismissible (non-modal).
  await w.getByTestId('crash-banner-dismiss').click();
  await expect(w.getByTestId('crash-banner')).toHaveCount(0);

  await app.close();
});
