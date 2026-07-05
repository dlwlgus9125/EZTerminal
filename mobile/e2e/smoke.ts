/**
 * M3 — Android emulator e2e smoke test.
 *
 * Boots the REAL desktop app (electron.launch, isolated userData dir — same
 * pattern as e2e/launch-app.ts) so its remote-bridge (src/main/remote-bridge.ts)
 * is genuinely live, reads its real persisted token via the same
 * `getRemoteToken()` API the desktop pairing panel (M4) uses, installs+launches
 * the mobile debug APK on a running Android emulator, drives the UI via `adb
 * shell input` (no Appium — element positions are found dynamically via
 * `uiautomator dump`'s accessibility tree, which DOES expose the WebView's DOM
 * as native-looking nodes with real screen-pixel `bounds`), and verifies
 * `echo hello`'s output reached the phone by grepping logcat for the
 * `[ez-e2e]` marker MobileSessionView.tsx's test-only MutationObserver hook
 * logs (see its comment for why: the WebView's DOM isn't otherwise
 * introspectable from outside without Appium, but console.log IS forwarded to
 * logcat).
 *
 * Coordinates are NEVER hardcoded — a hardcoded-pixel-coordinate first draft of
 * this script repeatedly mis-tapped fields during development because (a) the
 * on-screen keyboard is a SEPARATE system overlay that visually + physically
 * covers whatever WebView content sits under it (a tap there hits the
 * keyboard, not the button underneath — you must dismiss the keyboard by
 * tapping a neutral area first, never BACK, which exits the app instead) and
 * (b) ConnectScreen's fields reflow slightly as error text appears/disappears.
 * `dumpUi()` re-dumps the CURRENT UI tree before every interaction instead.
 *
 * Two real, non-test-only bugs were found and fixed getting this to pass —
 * see mobile/capacitor.config.ts (androidScheme:'http', mixed-content) and
 * mobile/android/app/src/main/AndroidManifest.xml (usesCleartextTraffic,
 * Android's Network Security Config blocking plain ws:// by default) — plus a
 * real desktop-side bug: `ws` bundled into main.js crashed parsing the first
 * real WS frame (see vite.main.config.ts's `external: ['ws']` comment).
 *
 * Prerequisites this script does NOT manage (too heavy/slow to do per-run):
 *  - An AVD must already exist and be BOOTED (`adb devices` shows a `device`).
 *  - `mobile/android/app/build/outputs/apk/debug/app-debug.apk` must be fresh
 *    (`pnpm run build && npx cap sync android && cd android && ./gradlew assembleDebug`).
 *  - `.vite/build/main.js` (+ interpreter-process.js/script-host.js) must exist
 *    (`pnpm package`, or just run `pnpm e2e` once — its globalSetup builds them).
 *  - No OTHER desktop app instance (a manual `pnpm start`, a leftover process
 *    from a previous interrupted run of THIS script, etc.) may already be
 *    bound to port 7420. This script's own try/finally always calls
 *    `app.close()`, so back-to-back clean runs are fine — but a prior run
 *    that was killed externally (Ctrl-C, a crashed shell) leaves an orphaned
 *    Electron process holding the port. Symptom if this happens: main.log
 *    shows `EADDRINUSE: address already in use 0.0.0.0:7420` and the phone's
 *    Connect keeps silently timing out (it's actually talking to the STALE
 *    instance, whose token doesn't match the fresh one this run fetched).
 *    Fix: close any stray EZTerminal window before running this script.
 *
 * Run locally: `node mobile/e2e/smoke.ts` (Node's native TS type-stripping —
 * no ts-node/tsx needed; see package.json's `e2e:smoke` script).
 */
import { mkdtempSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const APK_PATH = path.join(
  ROOT,
  'mobile',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);
const APP_ID = 'com.ezterminal.remote';
const REMOTE_PORT = 7420;
// 10.0.2.2 is the Android emulator's fixed alias for the HOST machine's localhost.
const EMULATOR_HOST_URL = `ws://10.0.2.2:${REMOTE_PORT}`;
const DUMP_DEVICE_PATH = '/sdcard/ez_e2e_dump.xml';
const DUMP_LOCAL_PATH = path.join(import.meta.dirname, '.ez_e2e_dump.xml');

const ANDROID_HOME = process.env.ANDROID_HOME ?? String.raw`C:\Users\dlwlg\AppData\Local\Android\Sdk`;
const ADB_BIN = path.join(ANDROID_HOME, 'platform-tools', 'adb.exe');

/** Runs `adb <args>` via spawnSync (argv array, never a shell string) and
 * returns stdout. Throws with stderr included if adb itself reports failure. */
function runAdb(args: string[]): string {
  const result = spawnSync(ADB_BIN, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One `uiautomator dump` node's parsed fields (only what this script needs). */
interface DumpNode {
  readonly text: string;
  readonly className: string;
  readonly clickable: boolean;
  readonly bounds: readonly [number, number, number, number];
}

function parseDump(xml: string): DumpNode[] {
  const nodes: DumpNode[] = [];
  const nodeRe = /<node\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const tag = m[0];
    const text = /text="([^"]*)"/.exec(tag)?.[1] ?? '';
    const className = /class="([^"]*)"/.exec(tag)?.[1] ?? '';
    const clickable = /clickable="true"/.test(tag);
    const boundsMatch = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!boundsMatch) continue;
    const [, x1, y1, x2, y2] = boundsMatch;
    nodes.push({ text, className, clickable, bounds: [Number(x1), Number(y1), Number(x2), Number(y2)] });
  }
  return nodes;
}

/** Re-dumps the CURRENT UI (see header comment on why this can never be cached).
 * `uiautomator dump` occasionally fails transiently (observed exit 137) right
 * after `am start`, before the Activity/WebView has fully attached — callers
 * that poll (waitForText/waitForEditText) treat a failed dump as "not ready
 * yet" and retry rather than propagating it as fatal. */
function dumpUi(): DumpNode[] {
  runAdb(['shell', 'uiautomator', 'dump', DUMP_DEVICE_PATH]);
  runAdb(['pull', DUMP_DEVICE_PATH, DUMP_LOCAL_PATH]);
  return parseDump(readFileSync(DUMP_LOCAL_PATH, 'utf8'));
}

function tryDumpUi(): DumpNode[] {
  try {
    return dumpUi();
  } catch {
    return [];
  }
}

function center(bounds: readonly [number, number, number, number]): Point {
  const [x1, y1, x2, y2] = bounds;
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

async function tap(p: Point): Promise<void> {
  runAdb(['shell', 'input', 'tap', String(p.x), String(p.y)]);
  await sleep(400);
}

async function typeText(text: string): Promise<void> {
  runAdb(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  await sleep(400);
}

/** Tap the Nth EditText and type `text`, VERIFYING via a fresh dump that the
 * field actually received it, retrying the whole tap+type cycle otherwise.
 * Needed because the WebView's touch dispatch can still be warming up even
 * once uiautomator's accessibility tree reports the element as present —
 * observed directly (a debug screenshot): the tap lands with no visible
 * focus/keyboard at all, so the following `input text` has nothing focused
 * to receive it and is silently dropped. A verify-and-retry loop is robust
 * to this regardless of how slow any given cold start happens to be, unlike
 * a longer fixed delay (which just moves the race, it doesn't remove it).
 * Password fields are NOT masked in the accessibility tree's `text`
 * attribute (only visually), so a plain equality check works for every
 * field this script fills, including the token field. */
async function fillReliably(index: number, text: string, maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const p = await waitForEditText(index);
    await tap(p);
    await sleep(600);
    await typeText(text);
    await sleep(300);
    const editTexts = tryDumpUi().filter((n) => n.className === 'android.widget.EditText');
    const current = editTexts[index]?.text ?? '';
    if (current === text) return;
    console.log(`[smoke] fill attempt ${attempt} for field ${index} didn't take (got ${JSON.stringify(current)}), retrying...`);
  }
  throw new Error(`Failed to fill EditText ${index} with "${text}" after ${maxAttempts} attempts`);
}

/** Tap a point known to be outside any input (the title text) to close the
 * soft keyboard. NEVER use KEYCODE_BACK for this — with no field focused it
 * exits the Activity instead of just dismissing the keyboard. The extra
 * settle time is deliberate: the keyboard-close animation resizes the
 * WebView, and a dump/tap issued before it finishes computes stale bounds. */
async function dismissKeyboard(): Promise<void> {
  await tap({ x: 500, y: 700 });
  await sleep(1000);
}

/** Poll `uiautomator dump` until a clickable node with `text` appears (cold
 * starts after `pm clear`, and the connect/session round trips, vary in
 * timing — a fixed sleep either wastes time or races a slow one). */
async function waitForText(text: string, timeoutMs = 15000): Promise<Point> {
  const start = Date.now();
  let lastNodes: DumpNode[] = [];
  for (;;) {
    const nodes = tryDumpUi();
    if (nodes.length > 0) lastNodes = nodes;
    const match = nodes.find((n) => n.text === text && n.clickable);
    if (match) return center(match.bounds);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for clickable text "${text}". Current texts: ${JSON.stringify(lastNodes.map((n) => n.text).filter(Boolean))}`);
    }
    await sleep(500);
  }
}

/** Like {@link waitForText}, but returns as soon as ANY of several outcomes
 * appears (e.g. success text vs. a failure banner) rather than only knowing
 * one specific text ever showed up. */
async function waitForAnyText(texts: readonly string[], timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const nodes = tryDumpUi();
    const found = texts.find((text) => nodes.some((n) => n.text === text));
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for any of ${JSON.stringify(texts)}. Current texts: ${JSON.stringify(nodes.map((n) => n.text).filter(Boolean))}`);
    }
    await sleep(500);
  }
}

/** Same idea as {@link waitForText}, for the Nth `android.widget.EditText` on screen
 * (0-indexed) — ConnectScreen's URL/token fields have no distinguishing text
 * (placeholder text isn't reflected in `text=`, and the token field is
 * always masked visually), so position-in-dump is the only handle. */
async function waitForEditText(index: number, timeoutMs = 15000): Promise<Point> {
  const start = Date.now();
  for (;;) {
    const editTexts = tryDumpUi().filter((n) => n.className === 'android.widget.EditText');
    if (editTexts[index]) return center(editTexts[index].bounds);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for EditText at index ${index} (found ${editTexts.length})`);
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop build missing: ${MAIN_ENTRY} — run 'pnpm package' or 'pnpm e2e' once first.`);
  }
  if (!existsSync(APK_PATH)) {
    throw new Error(`APK missing: ${APK_PATH} — build it first (see this file's header comment).`);
  }
  const devices = runAdb(['devices']);
  if (!/\bdevice\b/.test(devices.split('\n').slice(1).join('\n'))) {
    throw new Error(`No booted Android device/emulator found. 'adb devices' returned:\n${devices}`);
  }

  console.log('[smoke] launching desktop app (isolated userData)...');
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ezterm-m3-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.EZTERMINAL_USER_DATA_DIR = userDataDir;
  const app = await electron.launch({ args: [MAIN_ENTRY], env });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    // getRemoteToken() (M4) calls remoteTokenStore.getToken() directly, which
    // mints+persists on first call — no need to wait for a WS client to
    // connect first (the WS-triggered mint path only fires on first `auth`).
    const token: string = await win.evaluate(() => window.ezterminal.getRemoteToken());
    console.log('[smoke] real remote token acquired:', token.slice(0, 8) + '…');

    console.log('[smoke] installing APK (fresh app data)...');
    runAdb(['install', '-r', APK_PATH]);
    runAdb(['shell', 'pm', 'clear', APP_ID]); // drop any stale localStorage from a previous run

    console.log('[smoke] clearing logcat and launching app...');
    runAdb(['logcat', '-c']);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);

    console.log('[smoke] filling connect form...');
    // The FIRST tap after a cold launch is unreliable even once uiautomator's
    // accessibility tree reports the element: the WebView's OWN touch
    // dispatch can still be warming up (observed: the tap lands with no
    // visible focus/keyboard at all, and the following `input text` has
    // nothing focused to receive it, so it's silently dropped). A retry loop
    // that re-verifies the field actually shows the typed text — not just a
    // longer fixed delay — is what makes this robust regardless of how slow
    // any given cold start is.
    await fillReliably(0, EMULATOR_HOST_URL);
    await fillReliably(1, token);
    await dismissKeyboard();

    // A first Connect attempt sometimes hits App.tsx's 6s CONNECT_TIMEOUT_MS
    // race (the WS/auth round trip on a JUST-booted app can be slower than
    // that on a first attempt) and lands on "Connection failed" — a bare
    // retry (tap Connect again) succeeds because whatever warmup cost caused
    // the first miss is already paid. Poll for either outcome and retry the
    // tap on failure rather than assuming success after one attempt.
    console.log('[smoke] connecting...');
    let connected = false;
    for (let attempt = 1; attempt <= 5 && !connected; attempt++) {
      await tap(await waitForText('Connect'));
      try {
        const outcome = await waitForAnyText(
          ['+ New Session', 'Connection failed — check the URL and token.'],
          10000,
        );
        connected = outcome === '+ New Session';
      } catch {
        // Neither outcome showed up in time (e.g. the tap itself didn't
        // register) — fall through and retry the tap.
      }
      if (!connected) console.log(`[smoke] connect attempt ${attempt} didn't succeed, retrying...`);
    }
    if (!connected) throw new Error('Connect kept failing after 5 attempts');

    console.log('[smoke] creating a session...');
    await tap(await waitForText('+ New Session'));

    console.log('[smoke] running cmd /c echo hello...');
    // NOTE: `echo` is NOT a command in EZTerminal's structured shell — there is
    // no `echo` builtin (see interpreter/core/builtins.ts: ls/where/sort-by/
    // gen-rows/cd/history/ps/run-script/ssh-connect) and `echo` is a cmd.exe
    // internal, not a standalone `echo.exe` on PATH. A bare `echo hello` returns
    // an `error` frame ("command not found: echo") and never produces output —
    // so it can never satisfy this assertion. Invoke cmd.exe explicitly so the
    // external-command PTY path actually emits "hello" (verified end-to-end
    // against the real bridge: the pty-data stream carries "hello\r\n").
    await fillReliably(0, 'cmd /c echo hello'); // cmd-input (only EditText on MobileSessionView)
    await dismissKeyboard();
    await tap(await waitForText('Run'));

    console.log('[smoke] polling logcat for [ez-e2e] output containing "hello"...');
    // cmd.exe PTY spawn + output render can take a few seconds on a cold
    // emulator — poll rather than assume a single fixed delay is enough.
    let log = '';
    let hit: string | undefined;
    const deadline = Date.now() + 20000;
    do {
      await sleep(1000);
      log = runAdb(['logcat', '-d']);
      hit = log
        .split('\n')
        .filter((l) => l.includes('[ez-e2e] output:'))
        .find((l) => l.includes('hello'));
    } while (!hit && Date.now() < deadline);
    if (!hit) {
      console.error('[smoke] FAILED — no matching [ez-e2e] logcat line found. Recent [ez-e2e] lines:');
      console.error(log.split('\n').filter((l) => l.includes('[ez-e2e]')).slice(-20).join('\n'));
      throw new Error('cmd /c echo hello output not observed on the emulator');
    }
    console.log('[smoke] PASS —', hit.trim());

    console.log('[smoke] tearing down (destroy session, stop app)...');
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
  } finally {
    await app.close();
    try {
      unlinkSync(DUMP_LOCAL_PATH);
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch((err: unknown) => {
  console.error('[smoke] ERROR:', err);
  process.exitCode = 1;
});
