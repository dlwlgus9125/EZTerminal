import { chromium, expect, test, type Browser } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { packagedExePath } from './paths';

const EXE = packagedExePath();

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('debug port unavailable');
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  return address.port;
}

async function connectToPackagedApp(port: number): Promise<Browser> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`packaged app CDP endpoint unavailable: ${String(lastError)}`);
}

function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
    });
  } catch {
    // The packaged diagnostic app already exited.
  }
}

function dragWithWindowsMouse(
  start: { x: number; y: number },
  target: { x: number; y: number },
): void {
  const command = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class EzPackagedMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(
    uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo
  );
}
"@
[EzPackagedMouse]::SetCursorPos(${start.x}, ${start.y}) | Out-Null
Start-Sleep -Milliseconds 120
[EzPackagedMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
for ($step = 1; $step -le 30; $step++) {
  $x = [Math]::Round(${start.x} + ((${target.x} - ${start.x}) * $step / 30))
  $y = [Math]::Round(${start.y} + ((${target.y} - ${start.y}) * $step / 30))
  [EzPackagedMouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 16
}
Start-Sleep -Milliseconds 120
[EzPackagedMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;
  execFileSync('powershell', ['-NoProfile', '-Command', command], {
    stdio: 'inherit',
  });
}

test('packaged EXE: Agent Session dragged outside with the real Windows pointer opens a window', async () => {
  test.skip(process.platform !== 'win32', 'Windows pointer regression');
  const profileDir = mkdtempSync(path.join(tmpdir(), 'ezterminal-packaged-popout-'));
  writeFileSync(
    path.join(profileDir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 1,
      startup: { mode: 'last' },
      bootIntro: false,
    }),
    'utf8',
  );
  writeFileSync(
    path.join(profileDir, 'layout.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: '2026-07-31T00:00:00.000Z',
      layout: {
        grid: {
          root: {
            type: 'branch',
            data: [{
              type: 'leaf',
              data: {
                views: ['agent-session-repro'],
                activeView: 'agent-session-repro',
                id: '1',
              },
              size: 555,
            }],
            size: 940,
          },
          width: 940,
          height: 555,
          orientation: 'VERTICAL',
        },
        panels: {
          'agent-session-repro': {
            id: 'agent-session-repro',
            title: 'EZTerminal · Codex',
            renderer: 'always',
            tabComponent: 'props.defaultTabComponent',
            contentComponent: 'agent-session',
            params: { historyId: 'codex_repro' },
          },
        },
        activeGroup: '1',
      },
    }),
    'utf8',
  );
  const port = await reservePort();
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      EZTERMINAL_USER_DATA_DIR: profileDir,
      EZTERMINAL_ALLOW_MULTIPLE_INSTANCES: '1',
      EZTERMINAL_DISABLE_UPDATE_CHECK: '1',
    },
    stdio: 'ignore',
  });
  let browser: Browser | undefined;
  try {
    browser = await connectToPackagedApp(port);
    const context = browser.contexts()[0];
    const page = context.pages().find((candidate) => (
      candidate.url() === 'https://ezterminal.invalid/index.html'
    ));
    if (!page) throw new Error('packaged renderer page missing');
    const tab = page.locator('.dv-tab').first();
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await expect(tab).toContainText('EZTerminal · Codex');
    await page.bringToFront();
    await page.evaluate(() => {
      type DragSample = {
        type: string;
        screenX: number;
        screenY: number;
      };
      const scope = globalThis as typeof globalThis & { __packagedDragSamples?: DragSample[] };
      scope.__packagedDragSamples = [];
      for (const type of ['dragstart', 'dragend']) {
        document.addEventListener(type, (event) => {
          const mouseEvent = event as MouseEvent;
          scope.__packagedDragSamples?.push({
            type,
            screenX: mouseEvent.screenX,
            screenY: mouseEvent.screenY,
          });
        }, { capture: true });
      }
    });
    const box = await tab.boundingBox();
    if (!box) throw new Error('packaged tab bounds missing');
    const metrics = await page.evaluate(() => ({
      screenX: globalThis.screenX,
      screenY: globalThis.screenY,
      outerWidth: globalThis.outerWidth,
      outerHeight: globalThis.outerHeight,
      innerWidth: globalThis.innerWidth,
      innerHeight: globalThis.innerHeight,
    }));
    const start = {
      x: Math.round(
        metrics.screenX
          + ((metrics.outerWidth - metrics.innerWidth) / 2)
          + box.x
          + (box.width / 2),
      ),
      y: Math.round(
        metrics.screenY
          + (metrics.outerHeight - metrics.innerHeight)
          + box.y
          + (box.height / 2),
      ),
    };
    const target = {
      x: Math.round(metrics.screenX + metrics.outerWidth + 120),
      y: start.y + 80,
    };

    dragWithWindowsMouse(start, target);

    const dragSamples = await page.evaluate(() => (
      (globalThis as typeof globalThis & {
        __packagedDragSamples?: Array<{ type: string; screenX: number }>;
      }).__packagedDragSamples ?? []
    ));
    expect(dragSamples.some((sample) => sample.type === 'dragstart')).toBe(true);
    expect(dragSamples.some((sample) => sample.type === 'dragend')).toBe(true);
    await expect.poll(
      () => context.pages().filter((candidate) => (
        candidate.url().includes('ez-popout=1')
      )).length,
      { timeout: 5_000 },
    ).toBe(1);
  } finally {
    await browser?.close().catch(() => undefined);
    killTree(child);
  }
});
