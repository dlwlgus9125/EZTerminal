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
 * Shared helpers (adb wrapper, uiautomator dump/parse, tap/type/fill,
 * launchDesktop/connectAndAuth, logcat polling) live in `./lib.ts` (M6, mobile-
 * parity plan D8) — see that file's doc comments for the empirical traps
 * behind each one (coordinates are NEVER hardcoded there either, for the same
 * reasons documented originally in this file: the on-screen keyboard is a
 * SEPARATE system overlay that covers whatever WebView content sits under it,
 * and ConnectScreen's fields reflow slightly as error text appears/disappears
 * — dumpUi() always re-dumps the CURRENT UI tree before every interaction).
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
import { existsSync, unlinkSync } from 'node:fs';
import {
  APK_PATH,
  APP_ID,
  DUMP_LOCAL_PATH,
  MAIN_ENTRY,
  connectAndAuth,
  dismissKeyboard,
  fillReliably,
  launchDesktop,
  pollLogcat,
  runAdb,
  tap,
  waitForText,
} from './lib.ts';

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
  const { app, token } = await launchDesktop();
  console.log('[smoke] real remote token acquired:', token.slice(0, 8) + '…');

  try {
    await connectAndAuth(token);

    console.log('[smoke] creating a session...');
    await tap(await waitForText('New terminal'));

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
    const hit = await pollLogcat('[ez-e2e] output:', 20000, (l) => l.includes('hello'));
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
