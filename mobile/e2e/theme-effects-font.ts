/**
 * theme-effects-font Wave 3 (mobile) — e2e (theme-effects-font plan M4).
 *
 * Runs against the same real desktop app + Android emulator setup as
 * `smoke.ts`/`parity.ts` (see smoke.ts's header doc for prerequisites this
 * script does NOT manage: a booted AVD, a fresh debug APK, a fresh
 * `.vite/build/main.js`, port 7420 free). Exercises the mobile-only surface
 * Wave 3 added on top of Wave 1/2's shared renderer/themes.ts +
 * renderer/theme-runtime.ts:
 *
 *  a. IMPORT — paste a valid theme mod JSON into ThemeMenu's Import
 *     textarea; the new theme appears as a selectable row and selecting it
 *     applies (logcat `[ez-e2e] theme: <id>` marker, same mechanism
 *     parity.ts's theme step already relies on).
 *  b. FONT — Settings' Font section: picking a non-default entry marks it
 *     selected live (dump-visible "✓ " prefix on that button's text).
 *  c. EFFECTS — Settings' Effects section, on the just-imported theme (which
 *     declares `effects: ['scanlines']`): the toggle is present and OFF by
 *     default (AC-E5 — mobile never inherits a theme's own declared
 *     default, unlike desktop), then toggling it on flips the prefix live.
 *  d. PERSISTENCE — two different mechanisms, deliberately NOT the same one:
 *     - Custom theme + its selection: force-stop + relaunch, then poll for
 *       the SAME boot-time `[ez-e2e] theme: <id>` marker parity.ts's own
 *       persistence check uses (main.tsx's `applyTheme(loadTheme())` fires
 *       unconditionally at boot, before any reconnect).
 *     - Font pick + effect toggle: closing Settings and reopening it
 *       (unmount/remount — MobileWorkspace conditionally renders
 *       MobileSettingsView, so this is a genuine "read persisted state back
 *       from localStorage on mount" round-trip) rather than another
 *       force-stop+relaunch. Deliberate: `connectAndAuth` (lib.ts) always
 *       reinstalls + `pm clear`s the app to start from a known-clean state,
 *       which would wipe the very localStorage this step is trying to prove
 *       survived — reconnecting after the theme's force-stop check would
 *       destroy the font/effects state before it could be checked. The
 *       lighter remount check proves the same read-path (loadFont()/
 *       loadEffectToggles() at MobileSettingsView mount) without that
 *       conflict.
 *
 * VERIFIED against a live emulator (ezpc-test, default 1080x2340 @ 420dpi):
 *  - The original draft's guess that ThemeMenu's paste `<textarea>` was a
 *    dump-reachable EditText at index 1 was WRONG — the ThemeMenu sheet is a
 *    `position:fixed` overlay, and per lib.ts's/parity.ts's own documented
 *    trap, its ENTIRE contents (textarea, rows, Import button) never appear
 *    in a uiautomator dump while open, confirmed live (a dump with the sheet
 *    open showed only the workspace header + the covered cmd-input, zero
 *    sheet nodes). So the IMPORT step below taps fixed geometry instead —
 *    exactly like parity.ts's THEME_ROW_Y does for theme selection — with
 *    every coordinate measured against this same live emulator.
 *  - `adb shell input text` mangles a raw JSON blob: the string is forwarded
 *    through the DEVICE's shell before `input text` sees it, so unescaped
 *    shell metacharacters (`{`, `}`, `"`, ...) get consumed there (a raw
 *    attempt against CUSTOM_THEME_JSON arrived as only `schemaVersion:1`).
 *    `escapeForAdbInputText` below backslash-escapes every shell-special char
 *    (plus lib.ts's existing %s-for-space convention) so the literal JSON
 *    reaches the textarea intact — verified live.
 *  - Settings' Font/Effects buttons DO render their "✓ " selection prefix as
 *    literal dump `text` (confirmed live: tapping Fira Code/Scanlines then
 *    dumping shows `✓ Fira Code`/`✓ Scanlines`) — Settings is a full view
 *    swap, not an overlay, so it's dump-visible throughout; no fix needed
 *    there.
 *
 * Run locally: `node mobile/e2e/theme-effects-font.ts`. Not run by the
 * automated test suite — like smoke.ts/parity.ts, this drives a real
 * emulator and is invoked manually / by an orchestrator.
 */
import { existsSync } from 'node:fs';
import {
  APK_PATH,
  APP_ID,
  EMULATOR_HOST_URL,
  MAIN_ENTRY,
  connectAndAuth,
  dismissKeyboard,
  fillReliably,
  launchDesktop,
  pollLogcat,
  runAdb,
  sleep,
  tap,
  waitForAnyText,
  waitForLabel,
  waitForText,
} from './lib.ts';

const CUSTOM_THEME_ID = 'e2e-neon';
const CUSTOM_THEME_NAME = 'E2E Neon';
const CUSTOM_THEME_JSON = JSON.stringify({
  schemaVersion: 1,
  id: CUSTOM_THEME_ID,
  name: CUSTOM_THEME_NAME,
  cssVars: { '--term-bg': '#0a0014', '--term-fg': '#e0c3ff' },
  xterm: { background: '#0a0014', foreground: '#e0c3ff' },
  effects: ['scanlines'],
});

/** Fixed geometry for the ThemeMenu sheet's Import controls — see this
 * file's header doc (VERIFIED section) for why dump-based lookup (waitForText/
 * fillReliably) can't reach the sheet at all. Measured live against the
 * ezpc-test emulator's DEFAULT resolution (1080x2340 @ 420dpi), same basis
 * as parity.ts's THEME_ROW_Y, with the sheet freshly opened (no prior
 * typing — the textarea grows once the JSON is in it, shifting anything
 * below, so this tap must land BEFORE typing).
 * MUST run before any `wm size`/`wm density` change (none in this file). */
const THEME_SHEET_IMPORT_TEXTAREA = { x: 540, y: 2060 };
/** Import button — measured with the textarea already holding CUSTOM_THEME_JSON
 * (multi-line, so the button sits lower than it would behind an empty/placeholder
 * textarea). */
const THEME_SHEET_IMPORT_BUTTON = { x: 138, y: 2177 };
/** The imported theme's row after Import succeeds. Built-ins occupy the first
 * 4 rows (THEME_ORDER); registered custom themes are appended after them
 * (`listThemes()`), so a single import makes it the 5th/last row. The sheet
 * is bottom-anchored (`align-items: flex-end`) with a fixed row pitch — 147px,
 * matching parity.ts's own THEME_ROW_Y spacing — so adding one row pushes the
 * whole list up by one pitch and the new row lands exactly where the last
 * built-in (Matrix) sat before the import. Verified live via the
 * `[ez-e2e] theme: e2e-neon` logcat marker after tapping this exact point. */
const THEME_SHEET_CUSTOM_ROW = { x: 540, y: 1868 };

/** `adb shell input text` forwards its argument through the DEVICE's shell
 * before `input text` ever sees it, so unescaped shell metacharacters get
 * eaten there — lib.ts's own `typeText` only handles spaces (%s), which is
 * enough for the plain URL/token/command text every OTHER script here types,
 * but not for a JSON blob full of `{`, `}`, `"`, etc. Backslash-escapes every
 * shell-special char in addition to the existing %s-for-space convention.
 * VERIFIED live: without this, `input text` of CUSTOM_THEME_JSON arrived in
 * the textarea as only `schemaVersion:1` (everything from the first `"id"`
 * onward silently dropped). */
const ADB_SHELL_SPECIAL_CHARS = new Set('\\\'"`$&|;()<>*?[]{}!#~'.split(''));
function escapeForAdbInputText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') out += '%s';
    else if (ADB_SHELL_SPECIAL_CHARS.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** Like `connectAndAuth` (lib.ts), but WITHOUT its reinstall/`pm clear`
 * prefix — see this file's header doc for why the persistence step needs a
 * clean-reconnect-free path. Only usable once the app is ALREADY on
 * ConnectScreen with existing app data intact (a force-stop+relaunch, not a
 * fresh install). */
async function reconnectWithoutClearing(token: string): Promise<void> {
  await fillReliably(0, EMULATOR_HOST_URL);
  await fillReliably(1, token);
  await dismissKeyboard();
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
      // Neither outcome showed up in time — fall through and retry the tap.
    }
    if (!connected) console.log(`[theme-e2e] connect attempt ${attempt} didn't succeed, retrying...`);
  }
  if (!connected) throw new Error('Connect kept failing after 5 attempts');
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop build missing: ${MAIN_ENTRY} — run 'pnpm package' or 'pnpm e2e' once first.`);
  }
  if (!existsSync(APK_PATH)) {
    throw new Error(`APK missing: ${APK_PATH} — build it first (see smoke.ts's header comment).`);
  }

  console.log('[theme-e2e] launching desktop app (isolated userData)...');
  const { app, token } = await launchDesktop();

  try {
    await connectAndAuth(token);
    await tap(await waitForText('+ New Session'));
    await pollLogcat('[ez-e2e] tab-active:', 10000);
    console.log('[theme-e2e] step OK: connected with a fresh tab');

    // ── a. IMPORT ────────────────────────────────────────────────────────
    // Fixed-geometry taps throughout — see this file's header doc (VERIFIED
    // section): the ThemeMenu sheet is dump-invisible in full, so none of
    // waitForText/waitForLabel/fillReliably can see inside it.
    console.log('[theme-e2e] opening the theme sheet and importing a custom theme...');
    await tap(await waitForLabel('Theme')); // opens the sheet (the button itself IS dump-visible)
    await sleep(1000); // sheet mount settle (parity.ts's selectTheme uses the same delay)
    await tap(THEME_SHEET_IMPORT_TEXTAREA);
    await sleep(600); // focus settle (fillReliably uses the same delay after its tap)
    runAdb(['shell', 'input', 'text', escapeForAdbInputText(CUSTOM_THEME_JSON)]);
    await sleep(300);
    // Dismiss the keyboard WITHOUT closing the sheet: the sheet's backdrop
    // closes on any tap outside the sheet itself (verified live — a plain
    // dismissKeyboard()-style tap-outside-the-input landed on the backdrop
    // and closed the whole sheet, losing the typed text's visibility). BACK
    // is safe here specifically because the textarea is definitely focused
    // (we just typed into it) — Android closes the IME on the first BACK
    // press before it would ever reach the Activity, unlike lib.ts's
    // dismissKeyboard doc warning for contexts with no guaranteed focus.
    runAdb(['shell', 'input', 'keyevent', '4']); // KEYCODE_BACK — closes IME only
    await sleep(1000); // keyboard-close animation settle (dismissKeyboard uses the same delay)
    await tap(THEME_SHEET_IMPORT_BUTTON);
    await sleep(500);
    console.log('[theme-e2e] step OK: import submitted (sheet is dump-invisible — verified by the next tap + logcat marker, not a direct assertion here)');

    console.log('[theme-e2e] selecting the imported theme (now the 5th/last row)...');
    await tap(THEME_SHEET_CUSTOM_ROW);
    await pollLogcat(`[ez-e2e] theme: ${CUSTOM_THEME_ID}`, 10000);
    console.log('[theme-e2e] step OK: imported theme appears in the list and applied');

    // ── b. FONT + c. EFFECTS ────────────────────────────────────────────
    console.log('[theme-e2e] opening Settings...');
    await tap(await waitForLabel('Settings'));

    console.log('[theme-e2e] checking the Scanlines toggle is present and OFF by default...');
    await waitForText('Scanlines');
    let onByDefault = true;
    try {
      await waitForText('✓ Scanlines', 2000);
    } catch {
      onByDefault = false;
    }
    if (onByDefault) throw new Error('Scanlines was ON by default on mobile settings (expected OFF, AC-E5)');
    console.log('[theme-e2e] step OK: Scanlines present and OFF by default');

    console.log('[theme-e2e] selecting a non-default font...');
    await tap(await waitForText('Fira Code'));
    await waitForText('✓ Fira Code');
    console.log('[theme-e2e] step OK: font selection reflected live');

    console.log('[theme-e2e] toggling Scanlines on...');
    await tap(await waitForText('Scanlines'));
    await waitForText('✓ Scanlines');
    console.log('[theme-e2e] step OK: Scanlines toggled on live');

    // ── d(i). FONT + EFFECTS PERSISTENCE (remount, no process kill) ─────
    console.log('[theme-e2e] closing and reopening Settings to check the localStorage round-trip...');
    await tap(await waitForLabel('Close settings'));
    await tap(await waitForLabel('Settings'));
    await waitForText('✓ Fira Code');
    await waitForText('✓ Scanlines');
    console.log('[theme-e2e] step OK: font + effect toggle survive a Settings remount');

    // ── d(ii). CUSTOM THEME PERSISTENCE (real restart) ───────────────────
    console.log('[theme-e2e] theme persistence: force-stop + relaunch...');
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    await sleep(1000);
    runAdb(['logcat', '-c']);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    // Lands on ConnectScreen after this restart — irrelevant here, only the
    // boot-time applyTheme(loadTheme()) marker matters (same as parity.ts).
    await pollLogcat(`[ez-e2e] theme: ${CUSTOM_THEME_ID}`, 15000);
    console.log('[theme-e2e] step OK: custom theme + its selection survive a real restart');

    // Reconnect (data-preserving path — see reconnectWithoutClearing's doc)
    // just to leave the app in a known state / prove it isn't wedged.
    await reconnectWithoutClearing(token);
    console.log('[theme-e2e] step OK: reconnected after restart');

    console.log('[theme-e2e] ALL STEPS PASSED');
  } finally {
    try {
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch {
      // best-effort cleanup
    }
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
