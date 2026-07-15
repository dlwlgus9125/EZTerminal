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
 *  - ThemeMenu is a `position:fixed` overlay, so native accessibility dumps
 *    do not reliably expose its descendants. Import and selection therefore
 *    use WebView test-id helpers, including an exact textarea value check and
 *    an explicit post-import success/error outcome.
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
  createTerminalSession,
  getTestIdTextContent,
  launchDesktop,
  openWorkspaceMoreAction,
  pollLogcat,
  runAdb,
  setTestIdTextValue,
  sleep,
  submitConnectionOnce,
  tapTestId,
  waitForAnyTestId,
  waitForTestId,
  waitForTestIdAttribute,
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

/** Like `connectAndAuth` (lib.ts), but WITHOUT its reinstall/`pm clear`
 * prefix — see this file's header doc for why the persistence step needs a
 * clean-reconnect-free path. Only usable once the app is ALREADY on
 * ConnectScreen with existing app data intact (a force-stop+relaunch, not a
 * fresh install). */
async function reconnectWithoutClearing(token: string): Promise<void> {
  await waitForTestId('connect-screen', 45_000);
  await setTestIdTextValue('connect-url', EMULATOR_HOST_URL);
  await setTestIdTextValue('connect-token', token);
  await submitConnectionOnce();
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
    await createTerminalSession();
    await pollLogcat('[ez-e2e] tab-active:', 10000);
    console.log('[theme-e2e] step OK: connected with a fresh tab');

    // ── a. IMPORT ────────────────────────────────────────────────────────
    // ThemeMenu's fixed overlay is unreliable in native accessibility dumps,
    // so use the WebView test-id path for every import interaction.
    console.log('[theme-e2e] opening the theme sheet and importing a custom theme...');
    await openWorkspaceMoreAction('more-theme', 'theme-menu');
    await setTestIdTextValue('theme-menu-import-textarea', CUSTOM_THEME_JSON);
    await tapTestId('theme-menu-import-btn');
    const importOutcome = await waitForAnyTestId(
      [`theme-option-${CUSTOM_THEME_ID}`, 'theme-menu-import-error'],
      10_000,
    );
    if (importOutcome === 'theme-menu-import-error') {
      throw new Error(
        `custom theme import was rejected: ${String(await getTestIdTextContent('theme-menu-import-error'))}`,
      );
    }
    console.log('[theme-e2e] step OK: exact JSON imported and custom theme row rendered');

    console.log('[theme-e2e] selecting the imported theme...');
    await tapTestId(`theme-option-${CUSTOM_THEME_ID}`);
    await pollLogcat(`[ez-e2e] theme: ${CUSTOM_THEME_ID}`, 10000);
    console.log('[theme-e2e] step OK: imported theme appears in the list and applied');

    // ── b. FONT + c. EFFECTS ────────────────────────────────────────────
    console.log('[theme-e2e] opening Settings...');
    await openWorkspaceMoreAction('more-settings', 'mobile-settings-view');

    console.log('[theme-e2e] checking the Scanlines toggle is present and OFF by default...');
    await waitForTestId('settings-effect-scanlines');
    await waitForTestIdAttribute('settings-effect-scanlines', 'aria-pressed', 'false');
    console.log('[theme-e2e] step OK: Scanlines present and OFF by default');

    console.log('[theme-e2e] selecting a non-default font...');
    await tapTestId('settings-font-fira-code');
    await waitForTestIdAttribute('settings-font-fira-code', 'aria-pressed', 'true');
    console.log('[theme-e2e] step OK: font selection reflected live');

    console.log('[theme-e2e] toggling Scanlines on...');
    await tapTestId('settings-effect-scanlines');
    await waitForTestIdAttribute('settings-effect-scanlines', 'aria-pressed', 'true');
    console.log('[theme-e2e] step OK: Scanlines toggled on live');

    // ── d(i). FONT + EFFECTS PERSISTENCE (remount, no process kill) ─────
    console.log('[theme-e2e] closing and reopening Settings to check the localStorage round-trip...');
    await tapTestId('mobile-settings-close');
    await openWorkspaceMoreAction('more-settings', 'mobile-settings-view');
    await waitForTestIdAttribute('settings-font-fira-code', 'aria-pressed', 'true');
    await waitForTestIdAttribute('settings-effect-scanlines', 'aria-pressed', 'true');
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
