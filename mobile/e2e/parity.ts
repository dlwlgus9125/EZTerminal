/**
 * M6 — full desktop/mobile parity e2e (mobile-parity plan D8).
 *
 * Runs against the same real desktop app + Android emulator setup as
 * `smoke.ts` (see its header doc for prerequisites this script does NOT
 * manage: booted AVD, fresh debug APK, fresh `.vite/build/main.js`, port 7420
 * free) but exercises the FULL surface built across M1-M6 in one pass:
 *
 *  b. Multi-session TABS — create tab A, run a command, create tab B via the
 *     header's quick-add, start a STREAMING command in B, switch to A while
 *     B is hidden, prove B's PTY kept producing output (keep-alive), switch
 *     back to B and run a fresh command (proves the port survived the hide).
 *  c. STATS — cores/conns markers (conns proves the M1 refcount works from a
 *     remote-only subscriber), then the 캡처 (packet) tab's view-only `idle`
 *     status (desktop isn't capturing — no Npcap dependency here).
 *  d. THEME — cycle all 4 themes (logcat marker per theme), then a
 *     force-stop+relaunch persistence check (boot-time `applyTheme(loadTheme())`
 *     re-logs the last selection).
 *  e. FOLD GEOMETRY — `wm size`/`wm density` to simulate the Fold7's cover
 *     and main screens, asserting the workspace stays reachable and stats
 *     still arrive at each; a small rotation smoke test at the main profile.
 *
 * KNOWN TRAPS baked into this flow (see lib.ts for the code-level detail):
 *  - `position:fixed` overlays (ThemeMenu sheet, SessionSwitcher sheet
 *    variant, backdrops) NEVER show up in a uiautomator dump even while
 *    visually open — every assertion here uses in-flow nodes or logcat
 *    markers, never a dump of an open overlay's contents.
 *  - The theme sheet's option rows are tapped by fixed geometry measured at
 *    the emulator's DEFAULT resolution (1080x2340 @ 420dpi) — this is why
 *    step (d) runs strictly BEFORE step (e)'s `wm size`/`wm density` calls.
 *  - Streaming PTY output renders into the xterm canvas, not plain DOM text —
 *    continuity during the tab-hide test is proven by RAW `[ez-e2e] output:`
 *    marker-COUNT growth, never content matching.
 *  - `ping localhost` (no dots/dashes): adb-`input text`-typed `.`/`-` have
 *    been observed reaching cmd.exe mangled even though the EditText's own
 *    verification read back correctly.
 *
 * Run locally: `node mobile/e2e/parity.ts` (see package.json's `e2e:parity`
 * script). Not run by the automated test suite — like smoke.ts, this drives a
 * real emulator and is invoked manually / by an orchestrator.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APK_PATH,
  APP_ID,
  DUMP_LOCAL_PATH,
  MAIN_ENTRY,
  center,
  connectAndAuth,
  dismissKeyboard,
  fillReliably,
  launchDesktop,
  logcatLines,
  longPress,
  pollLogcat,
  pressEnter,
  runAdb,
  sleep,
  tap,
  tryDumpUi,
  waitForAnyNodeText,
  waitForLabel,
  waitForText,
} from './lib.ts';

/** Bottom-anchored geometry for the ThemeMenu sheet's option rows, measured
 * on the emulator's DEFAULT resolution (1080x2340 @ 420dpi) — see lib.ts's
 * `waitForLabel` doc for why the sheet itself can't be dump-located. MUST run
 * before any `wm size`/`wm density` change (the row coords don't survive a
 * geometry change). */
const THEME_ROW_Y: Record<string, number> = {
  Dark: 1727,
  Light: 1874,
  'High Contrast': 2021,
  Matrix: 2168,
};

async function selectTheme(label: string): Promise<void> {
  await tap(await waitForLabel('Theme')); // opens the sheet (the button itself IS dump-visible)
  await sleep(1000); // sheet mount settle
  await tap({ x: 540, y: THEME_ROW_Y[label] });
  await sleep(400);
}

/**
 * Estimated (UNVERIFIED — no live emulator was available while writing this
 * step; see the files-step comment below) device-pixel Y for the "Download
 * to phone" row in MobileFileView's file-row long-press action sheet, at the
 * emulator's DEFAULT resolution (1080x2340 @ 420dpi, same basis as
 * THEME_ROW_Y above). The sheet backdrop is `position:fixed`, so — per this
 * file's own documented trap — it NEVER appears in a uiautomator dump; there
 * is no dump-based way to find its rows, the exact reason THEME_ROW_Y exists
 * for the theme sheet.
 *
 * Derivation (CSS px -> device px, scale factor 420/160 = 2.625;
 * mobile.css's `.mobile-file-sheet`/`.mobile-file-sheet-item`):
 *   sheet padding: 8px top + 8px bottom; item gap: 4px; each item: min-height
 *   44px + 10px top/bottom padding =~ 64px.
 *   A FILE row's sheet has 8 items, in this fixed order: 0 Copy path,
 *   1 Copy name, 2 Refresh, 3 New folder, 4 Rename, 5 Delete, 6 Paste path
 *   into input, 7 Download to phone (LAST).
 *   Sheet height (CSS) =~ 8 + 8*64 + 7*4 + 8 = 556px -> ~1459 device px.
 *   Sheet top (device) =~ 2340 - 1459 = 881.
 *   "Download to phone" (item 7) center (device) =~
 *     881 + (8 + 7*(64+4) + 64/2) * 2.625 =~ 2251.
 *
 * ACTION REQUIRED on the first manual run: if the tap misses, screenshot
 * mid-sheet (`runAdbBinary(['exec-out', 'screencap', '-p'])`, exported from
 * lib.ts) and correct this constant — treat it exactly like THEME_ROW_Y,
 * just not yet measured against a live device.
 */
const DOWNLOAD_ACTION_ROW_Y_ESTIMATE = 2251;

/** True once a `[ez-e2e] stats:` logcat line reports at least one CPU core —
 * i.e. a real snapshot has arrived (not just the initial "측정 중…" state). */
function hasCoreCount(line: string): boolean {
  const match = line.match(/cores=(\d+)/);
  return match !== null && Number(match[1]) >= 1;
}

/** Finds the tab-strip's pill buttons via geometry (top of screen, non-empty
 * text, excluding the `+`/`New tab` add button) — used to pre-capture pill
 * coordinates BEFORE starting a streaming command, since every uiautomator
 * dump costs 1-3s and the streaming window is short. */
function findTabPills(): ReturnType<typeof tryDumpUi> {
  return tryDumpUi().filter(
    (n) => n.clickable && n.bounds[1] < 300 && n.text !== '' && n.text !== '+' && n.desc !== 'New tab',
  );
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop build missing: ${MAIN_ENTRY} — run 'pnpm package' or 'pnpm e2e' once first.`);
  }
  if (!existsSync(APK_PATH)) {
    throw new Error(`APK missing: ${APK_PATH} — build it first (see smoke.ts's header comment).`);
  }

  console.log('[parity] launching desktop app (isolated userData)...');
  const { app, token } = await launchDesktop();

  try {
    await connectAndAuth(token);
    console.log('[parity] step OK: connected');

    // ── b. TABS ──────────────────────────────────────────────────────────
    console.log('[parity] creating tab A...');
    await tap(await waitForText('+ New Session'));
    const tabAMarker = await pollLogcat('[ez-e2e] tab-active:', 10000);
    const tabAId = tabAMarker.split('tab-active:')[1].trim();

    console.log('[parity] running cmd /c echo alpha in tab A...');
    await fillReliably(0, 'cmd /c echo alpha');
    await dismissKeyboard();
    await tap(await waitForText('Run'));
    await pollLogcat('[ez-e2e] output:', 20000, (l) => l.includes('alpha'));
    console.log('[parity] step OK: tab A echo roundtrip');

    console.log('[parity] creating tab B via header New tab...');
    await tap(await waitForLabel('New tab'));
    const tabBMarker = await pollLogcat('[ez-e2e] tab-active:', 10000, (l) => !l.includes(tabAId));
    const tabBId = tabBMarker.split('tab-active:')[1].trim();

    // Pre-capture pill coords BEFORE Run — each uiautomator dump costs 1-3s,
    // and `ping localhost` only streams a few seconds (default 4 pings).
    const pillsBefore = findTabPills();
    if (pillsBefore.length < 2) {
      throw new Error(`expected >=2 tab pills, saw ${JSON.stringify(pillsBefore.map((p) => p.text))}`);
    }
    console.log('[parity] starting streaming ping in tab B...');
    await fillReliably(0, 'cmd /c ping localhost');
    await dismissKeyboard();
    await tap(await waitForText('Run'));

    console.log('[parity] switching to tab A while B streams (pre-captured pill tap)...');
    await tap(center(pillsBefore[0].bounds));
    await pollLogcat('[ez-e2e] tab-active:', 8000, (l) => l.includes(tabAId) && l > tabBMarker);

    // Continuity = RAW output-marker count keeps growing while B is hidden —
    // content matching is impossible for a streaming PTY block (it renders
    // into the xterm canvas; the plain text-output node is whitespace-only),
    // but every incoming frame still mutates the hidden tab's DOM and fires
    // its MutationObserver. Tab A is idle, so any growth is attributable to
    // hidden tab B alone.
    const before = logcatLines('[ez-e2e] output:').length;
    await sleep(3500);
    const after = logcatLines('[ez-e2e] output:').length;
    if (after <= before) throw new Error('hidden tab B stopped streaming (keep-alive broken)');
    console.log(`[parity] step OK: keep-alive (${before} -> ${after} output markers while B hidden)`);

    console.log('[parity] switching back to tab B, running echo bravo2...');
    const pillsAfter = findTabPills();
    await tap(center(pillsAfter[1].bounds));
    await sleep(1000);
    await fillReliably(0, 'cmd /c echo bravo2');
    await dismissKeyboard();
    await tap(await waitForText('Run'));
    await pollLogcat('[ez-e2e] output:', 20000, (l) => l.includes('bravo2'));
    console.log('[parity] step OK: tab B PTY survived hide/show, fresh command works');

    // ── c. STATS ─────────────────────────────────────────────────────────
    console.log('[parity] opening stats...');
    await tap(await waitForLabel('Stats'));
    await pollLogcat('[ez-e2e] stats:', 20000, hasCoreCount);
    await pollLogcat('[ez-e2e] stats:', 30000, (l) => /conns=\d+/.test(l));
    console.log('[parity] step OK: stats cores + conns (refcount proof)');

    console.log('[parity] 캡처 tab: ack + idle status...');
    await tap(await waitForText('캡처'));
    await tap(await waitForText('확인'));
    await pollLogcat('[ez-e2e] packets: idle', 15000);
    console.log('[parity] step OK: packets idle (view-only, desktop not capturing)');
    await tap(await waitForLabel('Close stats'));

    // ── d. THEME (default resolution ONLY — see THEME_ROW_Y's doc) ──────
    console.log('[parity] cycling themes...');
    for (const [label, marker] of [
      ['Matrix', 'matrix'],
      ['Light', 'light'],
      ['High Contrast', 'high-contrast'],
      ['Dark', 'dark'],
    ] as const) {
      await selectTheme(label);
      await pollLogcat(`[ez-e2e] theme: ${marker}`, 10000);
      console.log(`[parity] step OK: theme ${marker}`);
    }

    console.log('[parity] theme persistence: select Matrix, force-stop, relaunch...');
    await selectTheme('Matrix');
    await pollLogcat('[ez-e2e] theme: matrix', 10000);
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    await sleep(1000);
    runAdb(['logcat', '-c']);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    // The app lands on ConnectScreen after this restart (auto-reconnect may
    // or may not beat this poll — irrelevant here; only the boot-time
    // applyTheme(loadTheme()) marker matters).
    await pollLogcat('[ez-e2e] theme: matrix', 15000);
    console.log('[parity] step OK: theme persistence across restart');

    // ── f. FILES (file-explorer plan, M6) ───────────────────────────────
    // MUST run strictly BEFORE step (e)'s `wm size`/`wm density` calls — a
    // hard repo constraint, same reason THEME_ROW_Y-style fixed-geometry
    // taps break after a resolution change (DOWNLOAD_ACTION_ROW_Y_ESTIMATE
    // below is exactly that kind of fixed-geometry tap).
    //
    // The app is on ConnectScreen here (the theme-persistence restart above
    // left it there) — reconnect and open a fresh tab first, since
    // MobileWorkspace's Files button only exists once >=1 tab is open.
    //
    // TWO assumptions in this step have NO prior track record in this
    // codebase's scripts (no live emulator was available while writing it —
    // this is a MANUAL gate, see this repo's M6 plan):
    //   1. `pressEnter()` (lib.ts) — every other flow here submits via an
    //      explicit button; the file path bar has none.
    //   2. `waitForAnyNodeText` (lib.ts) for the file ROWS themselves —
    //      MobileFileView's `.mobile-file-row` is a plain `<div onClick>`,
    //      not a `<button>` like every other tap target in these scripts
    //      (confirmed by reading TabStrip.tsx: its pills ARE real buttons).
    //   3. DOWNLOAD_ACTION_ROW_Y_ESTIMATE (above) is a computed, not
    //      measured, coordinate — the action sheet is a `position:fixed`
    //      overlay, so it's dump-invisible the same way the ThemeMenu sheet
    //      is (THEME_ROW_Y's rows WERE measured against a live emulator;
    //      this one could not be).
    // If any of these prove wrong on the first manual run, fix them here —
    // the rest of the step (fixture creation, marker polling, byte-exact
    // upload/download verification) does not depend on which one broke.
    console.log('[parity] reconnecting for the files step...');
    await connectAndAuth(token);
    await tap(await waitForText('+ New Session'));
    await pollLogcat('[ez-e2e] tab-active:', 10000);
    console.log('[parity] step OK: reconnected with a fresh tab');

    console.log('[parity] creating desktop fixture files...');
    // Letters/digits only in both the dir prefix and file names — VERIFIED
    // TRAP (this file's header doc): adb-typed `.`/`-` have been observed
    // reaching cmd.exe mangled even when the EditText's own read-back looked
    // correct. `mkdtempSync`'s own random suffix is already alphanumeric.
    const filesFixtureDir = mkdtempSync(path.join(tmpdir(), 'ezparityfiles'));
    const readFixtureName = 'parityreadtxt.txt';
    const readFixtureContent = `PARITY_READ_${Date.now()}`;
    writeFileSync(path.join(filesFixtureDir, readFixtureName), readFixtureContent, 'utf8');
    // Pre-clean device-side leftovers from any earlier ABORTED run — the
    // success-path cleanup below never ran then, and a Documents file left by
    // a previous install is owned by that install's UID, so this run's fresh
    // install dies with EACCES/FILE_NOTCREATED trying to write the same name
    // (VERIFIED on the live emulator). rm makes the step idempotent.
    runAdb(['shell', 'rm', '-f', `/sdcard/Documents/${readFixtureName}`]);

    try {
      console.log('[parity] opening Files and navigating to the fixture dir...');
      await tap(await waitForLabel('Files'));
      // VERIFIED TRAP (first live run): adb `input text` swallows backslashes
      // outright (same mangling class as the `.`/`-` note above), so the
      // Windows path can never pass fillReliably's exact read-back check.
      // Type the forward-slash form instead — Windows fs accepts it, and
      // main's `path.resolve` canonicalizes the reply (and the `files:listed`
      // marker below) back to the backslash form.
      await fillReliably(0, filesFixtureDir.replaceAll('\\', '/'));
      await pressEnter();
      await sleep(800);
      await pollLogcat('[ez-e2e] files:listed', 15000, (l) => l.includes(filesFixtureDir));
      console.log('[parity] step OK: files:listed for the fixture dir');

      console.log('[parity] opening the fixture text file...');
      await tap(await waitForAnyNodeText(readFixtureName));
      await pollLogcat('[ez-e2e] files:viewer-open', 15000, (l) => l.includes(readFixtureName));
      console.log('[parity] step OK: files:viewer-open');

      console.log('[parity] downloading the fixture file to the phone...');
      await tap(await waitForText('‹ Back'));
      const fileRowPoint = await waitForAnyNodeText(readFixtureName);
      await longPress(fileRowPoint, 700); // > 500ms LongPressTracker default
      await sleep(500);
      await tap({ x: 540, y: DOWNLOAD_ACTION_ROW_Y_ESTIMATE });
      await pollLogcat('[ez-e2e] files:download-done', 20000, (l) => l.includes(readFixtureName));
      console.log('[parity] step OK: files:download-done');

      const documentsLs = runAdb(['shell', 'ls', '/sdcard/Documents']);
      if (!documentsLs.includes(readFixtureName)) {
        throw new Error(`downloaded file not found in /sdcard/Documents: ${documentsLs}`);
      }
      console.log('[parity] step OK: downloaded file confirmed in /sdcard/Documents');

      console.log('[parity] uploading via the system document picker (roundtrip)...');
      // VERIFIED TRAP (first live run): an `adb push`ed file is NOT
      // MediaStore-indexed, so the GET_CONTENT picker's Recent/Documents
      // views never show it (only "BROWSE FILES IN OTHER APPS" could reach
      // it, several fragile taps deep). The file the app itself just
      // DOWNLOADED via the Filesystem plugin IS indexed (it showed under
      // "Recent files" on the live emulator) — so upload THAT one back.
      // This upgrades the assertion to a full desktop→phone→desktop
      // ROUNDTRIP byte-equality check, and since the fixture dir still holds
      // the original file, it also exercises the server's collision
      // auto-rename ("name (1).ext") through a real picker upload.
      await tap(await waitForLabel('Upload'));
      await sleep(1500); // picker activity launch (native Activity, not WebView)
      await tap(await waitForAnyNodeText(readFixtureName, 20000));

      const expectedUploadName = 'parityreadtxt (1).txt';
      await pollLogcat('[ez-e2e] files:upload-done', 20000, (l) => l.includes(expectedUploadName));
      console.log('[parity] step OK: files:upload-done (collision auto-rename observed)');

      const uploadedContent = readFileSync(path.join(filesFixtureDir, expectedUploadName), 'utf8');
      if (uploadedContent !== readFixtureContent) {
        throw new Error(
          `roundtrip content mismatch: expected ${JSON.stringify(readFixtureContent)}, got ${JSON.stringify(uploadedContent)}`,
        );
      }
      console.log('[parity] step OK: desktop→phone→desktop roundtrip bytes match exactly');

      runAdb(['shell', 'rm', '-f', `/sdcard/Documents/${readFixtureName}`]);
    } finally {
      rmSync(filesFixtureDir, { recursive: true, force: true });
    }

    // ── e. FOLD GEOMETRY ─────────────────────────────────────────────────
    // connectAndAuth is tolerant of re-entry (always re-establishes from a
    // known-clean state), so reconnecting here needs no precondition check.
    console.log('[parity] reconnecting for fold-geometry checks...');
    await connectAndAuth(token);
    await tap(await waitForText('+ New Session'));
    await pollLogcat('[ez-e2e] tab-active:', 10000);
    console.log('[parity] step OK: reconnected with a fresh tab');

    // A wm size/density change can briefly drop the WS: the app then falls
    // back to ConnectScreen with URL/token still prefilled (observed on the
    // API 35 emulator — a real fold keeps the process alive, but the harness
    // must tolerate the emulator's harsher behavior). Recover by re-tapping
    // Connect and reopening a tab until the workspace ('Stats') is reachable.
    async function ensureWorkspace(): Promise<void> {
      const deadline = Date.now() + 45000;
      for (;;) {
        const nodes = tryDumpUi();
        const find = (label: string) =>
          nodes.find((n) => (n.text === label || n.desc === label) && n.clickable);
        if (find('Stats')) return;
        const newSession = find('+ New Session');
        if (newSession) {
          await tap(center(newSession.bounds));
          await sleep(800);
          continue;
        }
        const connect = find('Connect');
        if (connect) {
          await tap(center(connect.bounds));
          await sleep(1500);
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`workspace not reachable after geometry change. Texts: ${JSON.stringify(nodes.map((n) => n.text || n.desc).filter(Boolean))}`);
        }
        await sleep(700);
      }
    }

    const profiles = [
      { name: 'cover', size: '1080x2520', density: '420' },
      { name: 'main', size: '2184x1968', density: '372' },
    ] as const;
    for (const profile of profiles) {
      console.log(`[parity] fold geometry: ${profile.name} (${profile.size} @ ${profile.density}dpi)...`);
      runAdb(['shell', 'wm', 'size', profile.size]);
      runAdb(['shell', 'wm', 'density', profile.density]);
      await sleep(1500); // let the WebView re-layout at the new geometry
      await ensureWorkspace(); // survive a possible WS drop + ConnectScreen fallback
      // Tapping 'Stats' both proves the workspace UI (header + tab strip)
      // survived the geometry change AND opens the stats view for the marker
      // poll below — a broken layout would make this wait time out.
      await tap(await waitForLabel('Stats'));
      await pollLogcat('[ez-e2e] stats:', 20000, hasCoreCount);
      await tap(await waitForLabel('Close stats'));
      console.log(`[parity] step OK: ${profile.name} geometry reachable + stats live`);
    }

    console.log('[parity] rotation smoke at main profile...');
    runAdb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    runAdb(['shell', 'settings', 'put', 'system', 'user_rotation', '1']);
    await sleep(1500);
    await ensureWorkspace();
    await waitForLabel('Stats'); // still reachable post-rotation
    runAdb(['shell', 'settings', 'put', 'system', 'user_rotation', '0']);
    await sleep(1000);
    console.log('[parity] step OK: rotation smoke');

    console.log('[parity] ALL PASS');
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
  } finally {
    try {
      runAdb(['shell', 'wm', 'size', 'reset']);
      runAdb(['shell', 'wm', 'density', 'reset']);
      runAdb(['shell', 'settings', 'put', 'system', 'user_rotation', '0']);
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch {
      // best-effort — device state cleanup, not fatal if it fails
    }
    await app.close();
    try {
      unlinkSync(DUMP_LOCAL_PATH);
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch((err: unknown) => {
  console.error('[parity] ERROR:', err);
  process.exitCode = 1;
});
