import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { packagedExePath } from './paths';

// Track A ③ packaged delta: layout persistence in the REAL fused exe. The dev
// e2e already proves the full UI restore on identical bundles; what only the
// packaged app can prove is (a) the EZTERMINAL_USER_DATA_DIR seam is honored
// before 'ready', (b) the main-process store reads/writes/quarantines under
// asar+fuses. UI can't be driven here (inspector fuse off — see
// packaged-smoke.spec.ts), so both facts are asserted from the filesystem and
// the app's own boot logs.

const EXE = packagedExePath();

function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

function launchWithUserData(dir: string): { child: ChildProcess; text: () => string } {
  const env: NodeJS.ProcessEnv = { ...process.env, EZTERMINAL_USER_DATA_DIR: dir };
  const child = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (buf += d.toString()));
  return { child, text: () => buf };
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

test('packaged EXE: corrupt layout.json in the seamed userData is quarantined', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-packaged-layout-'));
  writeFileSync(path.join(dir, 'layout.json'), '{ not json at all', 'utf8');

  const { child, text } = launchWithUserData(dir);
  try {
    await waitFor(() => text().includes('[main] EZTerminal main process ready'), 30_000, 'main ready');
    // The renderer's startup load hits the corrupt file → store renames it.
    await waitFor(
      () => existsSync(path.join(dir, 'layout.json.corrupt')),
      30_000,
      'layout.json quarantined to .corrupt',
    );
    expect(existsSync(path.join(dir, 'layout.json'))).toBe(false);
    // App survived the fallback (no crash exit).
    expect(child.exitCode).toBeNull();
  } finally {
    killTree(child.pid);
  }
});

test('packaged EXE: a valid persisted layout is accepted (no quarantine)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-packaged-layout-'));
  writeFileSync(
    path.join(dir, 'layout.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: '2026-07-02T00:00:00.000Z',
      layout: {
        grid: {
          root: {
            type: 'branch',
            data: [
              {
                type: 'leaf',
                data: { views: ['tab-1'], activeView: 'tab-1', id: '1' },
                size: 800,
              },
            ],
          },
          width: 800,
          height: 600,
          orientation: 'HORIZONTAL',
        },
        panels: {
          'tab-1': { id: 'tab-1', contentComponent: 'terminal', title: 'Terminal 1', renderer: 'always' },
        },
        activeGroup: '1',
      },
    }),
    'utf8',
  );

  const { child, text } = launchWithUserData(dir);
  try {
    await waitFor(() => text().includes('[main] renderer finished loading'), 30_000, 'renderer loaded');
    // Settle: the renderer's restore ran (create-session log lines flow on run;
    // here absence of quarantine is the observable acceptance signal).
    await new Promise((r) => setTimeout(r, 2_000));
    expect(existsSync(path.join(dir, 'layout.json.corrupt'))).toBe(false);
    expect(existsSync(path.join(dir, 'layout.json'))).toBe(true);
    expect(child.exitCode).toBeNull();
  } finally {
    killTree(child.pid);
  }
});
