import { chromium, type Browser, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { packagedExePath } from './paths';

export interface PackagedRendererSession {
  readonly browser: Browser;
  readonly child: ChildProcess;
  readonly page: Page;
  close(): Promise<void>;
}

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

async function waitForRendererPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 20_000;
  let observedUrls: string[] = [];
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    observedUrls = pages.map((page) => page.url());
    const renderer = pages.find((page) => page.url() === 'https://ezterminal.invalid/index.html');
    if (renderer) return renderer;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `packaged renderer page unavailable; observed URLs: ${JSON.stringify(observedUrls)}`,
  );
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } catch {
    // The diagnostic app already exited.
  }
}

/** Launches the production binary with an isolated profile and attaches only
 * through Chromium's debugging protocol. No source checkout renderer is used. */
export async function launchPackagedRenderer(profilePrefix: string): Promise<PackagedRendererSession> {
  const profileDir = mkdtempSync(path.join(tmpdir(), profilePrefix));
  const port = await reservePort();
  const child = spawn(packagedExePath(), [`--remote-debugging-port=${port}`], {
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
    const page = await waitForRendererPage(browser);
    return {
      browser,
      child,
      page,
      close: async () => {
        await browser?.close().catch(() => undefined);
        killTree(child);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    killTree(child);
    throw error;
  }
}
