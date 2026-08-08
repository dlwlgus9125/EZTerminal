import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import {
  createRegisteredE2eTempDir,
  expect,
  test,
  type ElectronApplication,
} from './test';

interface ProcessTreeInfo {
  readonly root: number;
  readonly child: number;
  readonly grandchild: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessTree(fixtureDir: string): ProcessTreeInfo | null {
  const rootPath = path.join(fixtureDir, 'root.json');
  const childPath = path.join(fixtureDir, 'child.json');
  if (!existsSync(rootPath) || !existsSync(childPath)) return null;
  try {
    const root = JSON.parse(readFileSync(rootPath, 'utf8')) as { root: number };
    const child = JSON.parse(readFileSync(childPath, 'utf8')) as {
      child: number;
      grandchild: number;
    };
    if (![root.root, child.child, child.grandchild].every((pid) => Number.isInteger(pid) && pid > 0)) {
      return null;
    }
    return { root: root.root, child: child.child, grandchild: child.grandchild };
  } catch {
    return null;
  }
}

function cleanupExactTree(info: ProcessTreeInfo | null): void {
  if (!info) return;
  for (const pid of [info.root, info.child, info.grandchild]) {
    if (!isAlive(pid)) continue;
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // A sibling cleanup may already have removed this exact descendant.
    }
  }
}

function writeProcessTreeFixture(fixtureDir: string): string {
  const scriptPath = path.join(fixtureDir, 'process-tree.cjs');
  writeFileSync(scriptPath, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const [mode, fixtureDir] = process.argv.slice(2);
if (mode === 'root') {
  spawn(process.execPath, [__filename, 'child', fixtureDir], {
    stdio: 'ignore',
    windowsHide: true,
  });
  writeFileSync(path.join(fixtureDir, 'root.json'), JSON.stringify({ root: process.pid }));
} else if (mode === 'child') {
  const grandchild = spawn(process.execPath, [__filename, 'grandchild', fixtureDir], {
    stdio: 'ignore',
    windowsHide: true,
  });
  writeFileSync(path.join(fixtureDir, 'child.json'), JSON.stringify({
    child: process.pid,
    grandchild: grandchild.pid,
  }));
}
setInterval(() => {}, 1_000);
`, 'utf8');
  return scriptPath;
}

async function startNestedProcessTree(
  app: ElectronApplication,
  fixtureDir: string,
): Promise<ProcessTreeInfo> {
  const scriptPath = writeProcessTreeFixture(fixtureDir);
  const window = await app.firstWindow();
  const portableScriptPath = scriptPath.replaceAll('\\', '/');
  const portableFixtureDir = fixtureDir.replaceAll('\\', '/');
  await window.getByTestId('cmd-input').fill(
    `node "${portableScriptPath}" root "${portableFixtureDir}"`,
  );
  await window.getByTestId('btn-run').click();

  await expect.poll(() => readProcessTree(fixtureDir), { timeout: 15_000 }).not.toBeNull();
  const info = readProcessTree(fixtureDir);
  expect(info).not.toBeNull();
  expect([info!.root, info!.child, info!.grandchild].every(isAlive)).toBe(true);
  return info!;
}

async function expectTreeExited(info: ProcessTreeInfo): Promise<void> {
  await expect.poll(
    () => [info.root, info.child, info.grandchild].filter(isAlive),
    { timeout: 10_000 },
  ).toEqual([]);
}

test('graceful app quit drains an external child and grandchild', async () => {
  test.skip(process.platform !== 'win32', 'Windows Job Objects are the ownership primitive under test');
  const fixtureDir = createRegisteredE2eTempDir('ezterm-process-tree-');
  const app = await launchApp();
  let info: ProcessTreeInfo | null = null;
  try {
    info = await startNestedProcessTree(app, fixtureDir);

    await app.close();

    await expectTreeExited(info);
  } finally {
    cleanupExactTree(info);
  }
});

test('Windows guardian removes an external child and grandchild when main exits abruptly', async () => {
  test.skip(process.platform !== 'win32', 'Windows Job Objects are the ownership primitive under test');
  const fixtureDir = createRegisteredE2eTempDir('ezterm-process-tree-');

  const app = await launchApp();
  let info: ProcessTreeInfo | null = null;
  try {
    info = await startNestedProcessTree(app, fixtureDir);

    // Playwright may put a short-lived launcher above Electron, so app.process()
    // is not guaranteed to be the Job Object owner. Read the PID from the real
    // Electron main context and terminate that exact process.
    const mainPid = await app.evaluate(() => process.pid);
    expect(process.kill(mainPid, 'SIGKILL')).toBe(true);
    await expect.poll(() => isAlive(mainPid), { timeout: 10_000 }).toBe(false);

    await expectTreeExited(info);
  } finally {
    cleanupExactTree(info);
  }
});
