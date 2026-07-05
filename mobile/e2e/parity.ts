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
import { existsSync, unlinkSync } from 'node:fs';
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
  pollLogcat,
  runAdb,
  sleep,
  tap,
  tryDumpUi,
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
