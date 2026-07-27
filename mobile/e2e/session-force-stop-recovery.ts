/**
 * Reproduces the mobile process-restart path for a live Codex session:
 *
 *   create on mobile -> start Codex -> force-stop Android app -> relaunch
 *   -> reconnect -> open the still-running session
 *
 * The scenario deliberately distinguishes a dead PTY from a live PTY that
 * only looks frozen because the restarted client attached without control.
 *
 * Run directly with Node's native TypeScript stripping:
 *   node mobile/e2e/session-force-stop-recovery.ts
 *   node mobile/e2e/session-force-stop-recovery.ts --offline-ms=330000
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  APK_PATH,
  APP_ID,
  MAIN_ENTRY,
  closeMobileE2eResources,
  closeWebViewDevtools,
  connectAndAuth,
  createTerminalSession,
  getVisibleXtermBufferText,
  launchDesktop,
  openHubDestination,
  runAdb,
  setTestIdTextValue,
  sleep,
  submitConnectionOnce,
  tapTestId,
  waitForTestId,
  waitForTestIdHidden,
  waitForVisibleTestIdEnabled,
} from './lib.ts';

const FAKE_CODEX = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'e2e',
  'fixtures',
  'fake-codex',
  'codex.cmd',
);
const DEFAULT_OFFLINE_MS = 2_000;
const MAX_OFFLINE_MS = 20 * 60 * 1_000;

function parseOfflineMs(): number {
  const args = process.argv.slice(2);
  const option = args.find((arg) => arg.startsWith('--offline-ms='));
  const unknown = args.find((arg) => !arg.startsWith('--offline-ms='));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (!option) return DEFAULT_OFFLINE_MS;
  const value = Number(option.slice('--offline-ms='.length));
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OFFLINE_MS) {
    throw new Error(
      `--offline-ms must be an integer from 0 through ${MAX_OFFLINE_MS}`,
    );
  }
  return value;
}

async function waitForXtermText(text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastBuffer = '';
  for (;;) {
    lastBuffer = await getVisibleXtermBufferText();
    if (lastBuffer.includes(text)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for xterm text ${JSON.stringify(text)}; `
        + `last buffer: ${JSON.stringify(lastBuffer.slice(-1_000))}`,
      );
    }
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const offlineMs = parseOfflineMs();
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop build is missing: ${MAIN_ENTRY}`);
  }
  if (!existsSync(APK_PATH)) {
    throw new Error(`Mobile debug APK is missing: ${APK_PATH}`);
  }
  if (!existsSync(FAKE_CODEX)) {
    throw new Error(`Fake Codex fixture is missing: ${FAKE_CODEX}`);
  }

  const { app, token } = await launchDesktop();

  try {
    await connectAndAuth(token);
    await createTerminalSession();

    await setTestIdTextValue('cmd-input', `${FAKE_CODEX} --xterm`);
    await tapTestId('btn-run');
    await waitForTestId('pty-block', 20_000);
    await waitForXtermText('FAKE-CODEX-READY', 20_000);
    console.log('[repro] fake Codex is running in the mobile-created session');

    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    closeWebViewDevtools();
    console.log(`[repro] Android app stopped; waiting ${offlineMs}ms before relaunch`);
    await sleep(offlineMs);
    runAdb(['logcat', '-c']);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);

    await waitForTestId('connect-screen', 45_000);
    await submitConnectionOnce();
    await openHubDestination('hub-sessions', 'session-switcher');
    await waitForTestId('session-open', 15_000);
    await tapTestId('session-open');
    await waitForTestId('mobile-session-view', 20_000);
    await waitForTestId('pty-block', 20_000);

    await waitForXtermText('FAKE-CODEX-READY', 20_000);
    console.log('[repro] terminal replay proves the original PTY survived the app restart');

    await waitForTestIdHidden('pty-control-chip', 10_000);
    await waitForVisibleTestIdEnabled('touch-key-escape', 10_000);
    console.log('[repro] restarted app automatically restored input control');

    // Prove the restored control reaches the original PTY without requiring
    // the user to find and press a separate Take control action.
    await tapTestId('touch-key-escape');
    await waitForXtermText('ESC-RECEIVED', 10_000);
    console.log('[repro] PASS: restored mobile input reached the surviving Codex PTY');
  } finally {
    try {
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch {
      // Best-effort cleanup for a disconnected emulator.
    }
    closeMobileE2eResources();
    await app.close().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
