/**
 * M6 — full desktop/mobile parity e2e (mobile-parity plan D8).
 *
 * Runs against the same real desktop app + Android emulator setup as
 * `smoke.ts` (see its header doc for prerequisites this script does NOT
 * manage: booted AVD, fresh debug APK, fresh `.vite/build/main.js`, port 17420
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
 *  - `position:fixed` overlays are unreliable in uiautomator dumps, so their
 *    interactions use WebView test ids and still dispatch real Android taps.
 *  - Streaming PTY output renders into the xterm canvas, not plain DOM text —
 *    continuity during the tab-hide test is proven by RAW `[ez-e2e] output:`
 *    marker-COUNT growth, never content matching.
 *  - Controlled values use the WebView DOM setter to avoid device-IME
 *    autocorrection; buttons, long-press, Back, and rotation stay native.
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
  type DumpNode,
  type Point,
  center,
  closeMobileE2eResources,
  connectAndAuth,
  createTerminalSession,
  dismissKeyboard,
  findDocumentsUiFileResult,
  findDocumentsUiSearchAction,
  findDocumentsUiSearchField,
  getResumedActivity,
  isPublishedEzTerminalMediaStoreDownload,
  launchDesktop,
  logcatLines,
  longPress,
  openWorkspaceMoreAction,
  parseMediaStoreDownloadUri,
  parseEzTerminalMediaStoreDownloadIds,
  pollLogcat,
  pressEnter,
  runAdb,
  setTestIdTextValue,
  sleep,
  submitConnectionOnce,
  tap,
  tapTestId,
  tapTestIdAt,
  tryDumpUi,
  typeText,
  waitForAnyNodeText,
  waitForAnyTestId,
  waitForResumedActivity,
  waitForTestId,
  waitForTestIdHidden,
  waitForVisibleTestIdEnabled,
} from './lib.ts';

const DOWNLOADS_COLLECTION_URI = 'content://media/external_primary/downloads';

function findMediaStoreDownloadIds(displayName: string): readonly string[] {
  const rows = runAdb([
    'shell',
    'content',
    'query',
    '--uri',
    DOWNLOADS_COLLECTION_URI,
    '--projection',
    '_id:_display_name:relative_path',
  ]);
  return parseEzTerminalMediaStoreDownloadIds(rows, displayName);
}

function removeMediaStoreDownload(displayName: string): void {
  for (const id of findMediaStoreDownloadIds(displayName)) {
    runAdb(['shell', 'content', 'delete', '--uri', `${DOWNLOADS_COLLECTION_URI}/${id}`]);
  }
}

function queryMediaStoreDownload(uri: string): string {
  if (!/^content:\/\/media\/(?:external|external_primary)\/downloads\/\d+$/.test(uri)) {
    throw new Error(`invalid MediaStore download URI: ${uri}`);
  }
  return runAdb([
    'shell',
    'content',
    'query',
    '--uri',
    uri,
    '--projection',
    '_id:_display_name:relative_path:is_pending',
  ]);
}

function assertMediaStoreDownload(uri: string, displayName: string): void {
  const row = queryMediaStoreDownload(uri).trim();
  if (!isPublishedEzTerminalMediaStoreDownload(row, displayName)) {
    throw new Error(`unexpected MediaStore row for ${displayName}: ${row}`);
  }
}

function deleteExactMediaStoreDownload(uri: string): void {
  // Query validates the URI before it can reach adb and independently proves
  // an item exists. API 35's `content delete` returns status 0 with empty
  // stdout, so deletion proof comes from the exact-URI post-query below.
  const before = queryMediaStoreDownload(uri).trim();
  if (before === '' || /No result found/i.test(before)) {
    throw new Error(`MediaStore row did not exist before exact deletion at ${uri}`);
  }
  runAdb(['shell', 'content', 'delete', '--uri', uri]);
  const remaining = queryMediaStoreDownload(uri).trim();
  if (remaining !== '' && !/No result found/i.test(remaining)) {
    throw new Error(`MediaStore row remained after deletion at ${uri}: ${remaining}`);
  }
}

function deviceDownloadNames(): readonly string[] {
  return runAdb(['shell', 'ls', '-1', '/sdcard/Download/EZTerminal'])
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function readDeviceFileUtf8(devicePath: string): string {
  // `adb shell cat <path>` is reparsed by the device shell and breaks on
  // valid names containing spaces/parentheses. The adb sync protocol used by
  // `pull` preserves the path as one argument and the exact file bytes.
  const directory = mkdtempSync(path.join(tmpdir(), 'ezparity-device-file-'));
  const localPath = path.join(directory, 'payload.bin');
  try {
    runAdb(['pull', devicePath, localPath]);
    return readFileSync(localPath, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForDocumentPickerNode(
  findNode: (nodes: readonly DumpNode[]) => DumpNode | undefined,
  description: string,
  timeoutMs = 15_000,
): Promise<DumpNode> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const node = findNode(tryDumpUi());
    if (node) return node;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for DocumentsUI ${description}`);
    }
    await sleep(300);
  }
}

async function searchDocumentPicker(filename: string): Promise<Point> {
  try {
    const directResult = await waitForDocumentPickerNode(
      (nodes) => findDocumentsUiFileResult(nodes, filename),
      `direct file result ${filename}`,
      2_000,
    );
    return center(directResult.bounds);
  } catch {
    // API 29 does not always refresh Recent immediately after a MediaStore
    // publish. Continue through DocumentsUI's locale-independent search.
  }

  const query = path.parse(filename).name;
  if (!/^[A-Za-z0-9]+$/.test(query)) {
    throw new Error(`DocumentsUI fixture search query must be alphanumeric: ${query}`);
  }
  let searchField = findDocumentsUiSearchField(tryDumpUi());
  if (!searchField) {
    const searchButton = await waitForDocumentPickerNode(
      findDocumentsUiSearchAction,
      'search action',
    );
    await tap(center(searchButton.bounds));
    searchField = await waitForDocumentPickerNode(findDocumentsUiSearchField, 'search field');
  }
  await tap(center(searchField.bounds));
  runAdb(['shell', 'input', 'keyevent', '123', ...Array<string>(120).fill('67')]);
  await sleep(250);
  await typeText(query);
  await waitForDocumentPickerNode(
    (nodes) => {
      const field = findDocumentsUiSearchField(nodes);
      return field?.text === query ? field : undefined;
    },
    `exact search query ${query}`,
  );
  await pressEnter();
  const result = await waitForDocumentPickerNode(
    (nodes) => findDocumentsUiFileResult(nodes, filename),
    `file result ${filename}`,
    20_000,
  );
  return center(result.bounds);
}

const THEME_TEST_ID: Record<string, string> = {
  Dark: 'dark',
  Light: 'light',
  'High Contrast': 'high-contrast',
  Matrix: 'matrix',
};

async function selectTheme(label: string): Promise<void> {
  await openWorkspaceMoreAction('more-theme', 'theme-menu');
  await tapTestId(`theme-option-${THEME_TEST_ID[label]}`);
}

/** True once a `[ez-e2e] stats:` logcat line reports at least one CPU core —
 * i.e. a real snapshot has arrived (not just the initial "측정 중…" state). */
function hasCoreCount(line: string): boolean {
  const match = line.match(/cores=(\d+)/);
  return match !== null && Number(match[1]) >= 1;
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
    await createTerminalSession();
    const tabAMarker = await pollLogcat('[ez-e2e] tab-active:', 10000);
    const tabAId = tabAMarker.split('tab-active:')[1].trim();

    console.log('[parity] running cmd /c echo alpha in tab A...');
    await setTestIdTextValue('cmd-input', 'cmd /c echo alpha');
    await tapTestId('btn-run');
    await pollLogcat('[ez-e2e] output:', 20000, (l) => l.includes('alpha'));
    console.log('[parity] step OK: tab A echo roundtrip');

    console.log('[parity] creating tab B via header New tab...');
    await tapTestId('tab-add-btn');
    const tabBMarker = await pollLogcat('[ez-e2e] tab-active:', 10000, (l) => !l.includes(tabAId));

    console.log('[parity] starting streaming ping in tab B...');
    await setTestIdTextValue('cmd-input', 'cmd /c ping localhost');
    await tapTestId('btn-run');

    console.log('[parity] switching to tab A while B streams...');
    await tapTestIdAt('tab-pill-open', 0);
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
    await tapTestIdAt('tab-pill-open', 1);
    await waitForVisibleTestIdEnabled('btn-run', 20_000);
    await setTestIdTextValue('cmd-input', 'cmd /c echo bravo2');
    await tapTestId('btn-run');
    await pollLogcat('[ez-e2e] output:', 20000, (l) => l.includes('bravo2'));
    console.log('[parity] step OK: tab B PTY survived hide/show, fresh command works');

    // ── c. STATS ─────────────────────────────────────────────────────────
    console.log('[parity] opening stats...');
    await openWorkspaceMoreAction('more-stats', 'mobile-stats-view');
    await pollLogcat('[ez-e2e] stats:', 20000, hasCoreCount);
    await pollLogcat('[ez-e2e] stats:', 30000, (l) => /conns=\d+/.test(l));
    console.log('[parity] step OK: stats cores + conns (refcount proof)');

    console.log('[parity] 캡처 tab: ack + idle status...');
    await tapTestId('stats-tab-capture');
    await tapTestId('status-packet-ack-confirm');
    await pollLogcat('[ez-e2e] packets: idle', 15000);
    console.log('[parity] step OK: packets idle (view-only, desktop not capturing)');
    await tapTestId('mobile-stats-close');

    // ── d. THEME ─────────────────────────────────────────────────────────
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
    // Run before the geometry mutations so DocumentsUI and file assertions
    // operate at the emulator's default, known-good layout.
    //
    // The app is on ConnectScreen here (the theme-persistence restart above
    // left it there) — reconnect and open a fresh tab first, since
    // MobileWorkspace's Files button only exists once >=1 tab is open.
    console.log('[parity] reconnecting for the files step...');
    await connectAndAuth(token);
    await createTerminalSession();
    await pollLogcat('[ez-e2e] tab-active:', 10000);
    console.log('[parity] step OK: reconnected with a fresh tab');

    console.log('[parity] creating desktop fixture files...');
    // Keep the picker QUERY strictly alphanumeric while retaining `.txt` so
    // MediaStore publishes a searchable text MIME on API 29/35.
    const filesFixtureDir = mkdtempSync(path.join(tmpdir(), 'ezparityfiles'));
    const readFixtureName = `parityread${Date.now()}.txt`;
    const readFixtureContent = `PARITY_READ_${Date.now()}`;
    writeFileSync(path.join(filesFixtureDir, readFixtureName), readFixtureContent, 'utf8');
    const deviceDownloadPath = `/sdcard/Download/EZTerminal/${readFixtureName}`;
    const collisionDownloadName = `${path.parse(readFixtureName).name} (1)${path.extname(readFixtureName)}`;
    const collisionDownloadPath = `/sdcard/Download/EZTerminal/${collisionDownloadName}`;
    let originalDownloadUri: string | null = null;
    let collisionDownloadUri: string | null = null;

    try {
      console.log('[parity] opening Files and navigating to the fixture dir...');
      await openWorkspaceMoreAction('more-files', 'mobile-file-view');
      // Set the controlled value exactly, then focus it before sending the
      // native Enter used by the product's path-navigation handler.
      await setTestIdTextValue('mobile-file-path-input', filesFixtureDir.replaceAll('\\', '/'));
      await tapTestId('mobile-file-path-input');
      await pressEnter();
      await dismissKeyboard();
      await sleep(800);
      await pollLogcat('[ez-e2e] files:listed', 15000, (l) => l.includes(filesFixtureDir));
      console.log('[parity] step OK: files:listed for the fixture dir');

      console.log('[parity] opening the fixture text file...');
      await tap(await waitForAnyNodeText(readFixtureName));
      await pollLogcat('[ez-e2e] files:viewer-open', 15000, (l) => l.includes(readFixtureName));
      console.log('[parity] step OK: files:viewer-open');

      console.log('[parity] downloading the fixture file to the phone...');
      await tapTestId('viewer-back');
      const fileRowPoint = await waitForAnyNodeText(readFixtureName);
      await longPress(fileRowPoint, 700); // > 500ms LongPressTracker default
      await sleep(500);
      await tapTestId('sheet-download');
      const originalDownloadLog = await pollLogcat(
        '[ez-e2e] files:download-done',
        20000,
        (line) => line.includes(readFixtureName),
      );
      originalDownloadUri = parseMediaStoreDownloadUri(originalDownloadLog);
      if (!originalDownloadUri) {
        throw new Error(`download completion omitted its MediaStore URI: ${originalDownloadLog}`);
      }
      assertMediaStoreDownload(originalDownloadUri, readFixtureName);
      console.log('[parity] step OK: files:download-done');

      const originalRows = findMediaStoreDownloadIds(readFixtureName);
      if (originalRows.length !== 1 || !deviceDownloadNames().includes(readFixtureName)) {
        throw new Error(
          `expected one indexed/raw original download; ids=${JSON.stringify(originalRows)} `
          + `files=${JSON.stringify(deviceDownloadNames())}`,
        );
      }
      const downloadedContent = readDeviceFileUtf8(deviceDownloadPath);
      if (downloadedContent !== readFixtureContent) {
        throw new Error(
          `device download content mismatch: expected ${JSON.stringify(readFixtureContent)}, got ${JSON.stringify(downloadedContent)}`,
        );
      }
      console.log('[parity] step OK: downloaded bytes confirmed in Downloads/EZTerminal');

      console.log('[parity] downloading the same file again to verify MediaStore collision naming...');
      await longPress(await waitForAnyNodeText(readFixtureName), 700);
      await sleep(500);
      await tapTestId('sheet-download');
      const collisionDownloadLog = await pollLogcat(
        '[ez-e2e] files:download-done',
        20000,
        (line) => line.includes(collisionDownloadName),
      );
      collisionDownloadUri = parseMediaStoreDownloadUri(collisionDownloadLog);
      if (!collisionDownloadUri) {
        throw new Error(`collision completion omitted its MediaStore URI: ${collisionDownloadLog}`);
      }
      assertMediaStoreDownload(collisionDownloadUri, collisionDownloadName);
      const collisionContent = readDeviceFileUtf8(collisionDownloadPath);
      if (collisionContent !== readFixtureContent) {
        throw new Error(
          `collision download mismatch: expected ${JSON.stringify(readFixtureContent)}, got ${JSON.stringify(collisionContent)}`,
        );
      }
      console.log('[parity] step OK: repeated download preserved exact bytes under a (1) name');

      // Leave exactly one same-content candidate on the phone before opening
      // DocumentsUI. Otherwise selecting the repeated `(1)` phone download
      // could still create the expected desktop `(1)` name and make this
      // roundtrip assertion pass without proving which source was picked.
      const collisionRows = findMediaStoreDownloadIds(collisionDownloadName);
      if (collisionRows.length !== 1) {
        throw new Error(`expected exactly one collision row before deletion: ${JSON.stringify(collisionRows)}`);
      }
      deleteExactMediaStoreDownload(collisionDownloadUri);
      if (
        findMediaStoreDownloadIds(collisionDownloadName).length !== 0
        || deviceDownloadNames().includes(collisionDownloadName)
      ) {
        throw new Error(`collision fixture remained after exact URI deletion: ${collisionDownloadName}`);
      }
      assertMediaStoreDownload(originalDownloadUri, readFixtureName);
      if (!deviceDownloadNames().includes(readFixtureName)) {
        throw new Error(`original picker source disappeared: ${readFixtureName}`);
      }
      console.log('[parity] step OK: picker source is unambiguous (original phone download only)');

      console.log('[parity] uploading via the system document picker (roundtrip)...');
      // VERIFIED TRAP (first live run): an `adb push`ed file is NOT
      // MediaStore-indexed, so the GET_CONTENT picker's Recent/Documents
      // views never show it (only "BROWSE FILES IN OTHER APPS" could reach
      // it, several fragile taps deep). The file the app itself just
      // DOWNLOADED via MediaStore IS indexed (it shows under
      // "Recent files" on the live emulator) — so upload THAT one back.
      // This upgrades the assertion to a full desktop→phone→desktop
      // ROUNDTRIP byte-equality check, and since the fixture dir still holds
      // the original file, it also exercises the server's collision
      // auto-rename ("name (1).ext") through a real picker upload.
      await tapTestId('mobile-file-upload-btn');
      // AOSP API 29 uses com.android.documentsui while Google API 35 uses
      // com.google.android.documentsui. Match the stable package suffix.
      await waitForResumedActivity('documentsui', 20_000);
      // Search uses stable DocumentsUI resource ids and the unique filename;
      // it does not depend on translated root labels or OEM root ordering.
      let pickerFilePoint = await searchDocumentPicker(readFixtureName);
      let pickerReturned = false;
      for (let attempt = 1; attempt <= 3 && !pickerReturned; attempt += 1) {
        await tap(pickerFilePoint);
        try {
          await waitForResumedActivity(APP_ID, 5_000);
          pickerReturned = true;
        } catch {
          const current = getResumedActivity();
          if (!current.includes('documentsui')) {
            throw new Error(`document picker left without returning to EZTerminal: ${current}`);
          }
          console.log(`[parity] picker file tap attempt ${attempt} did not dispatch; retrying...`);
          const fileResult = await waitForDocumentPickerNode(
            (nodes) => findDocumentsUiFileResult(nodes, readFixtureName),
            `file result ${readFixtureName}`,
            20_000,
          );
          pickerFilePoint = center(fileResult.bounds);
        }
      }
      if (!pickerReturned) throw new Error('document picker did not return after 3 file taps');

      const expectedUploadName = collisionDownloadName;
      await pollLogcat('[ez-e2e] files:upload-done', 20000, (l) => l.includes(expectedUploadName));
      console.log('[parity] step OK: files:upload-done (collision auto-rename observed)');

      const uploadedContent = readFileSync(path.join(filesFixtureDir, expectedUploadName), 'utf8');
      if (uploadedContent !== readFixtureContent) {
        throw new Error(
          `roundtrip content mismatch: expected ${JSON.stringify(readFixtureContent)}, got ${JSON.stringify(uploadedContent)}`,
        );
      }
      console.log('[parity] step OK: desktop→phone→desktop roundtrip bytes match exactly');

    } finally {
      try {
        removeMediaStoreDownload(readFixtureName);
        removeMediaStoreDownload(collisionDownloadName);
      } catch (error) {
        console.warn(`[parity] MediaStore fixture cleanup failed: ${String(error)}`);
      }
      rmSync(filesFixtureDir, { recursive: true, force: true });
    }

    // ── e. FOLD GEOMETRY ─────────────────────────────────────────────────
    // connectAndAuth is tolerant of re-entry (always re-establishes from a
    // known-clean state), so reconnecting here needs no precondition check.
    console.log('[parity] reconnecting for fold-geometry checks...');
    await connectAndAuth(token);
    await createTerminalSession();
    await pollLogcat('[ez-e2e] tab-active:', 10000);
    console.log('[parity] step OK: reconnected with a fresh tab');

    // A wm size/density change can briefly drop the WS: the app then falls
    // back to ConnectScreen with URL/token still prefilled (observed on the
    // API 35 emulator — a real fold keeps the process alive, but the harness
    // must tolerate the emulator's harsher behavior). If that happens, allow
    // exactly one product connection result for this geometry transition.
    const ensureWorkspace = async (): Promise<void> => {
      const state = await waitForAnyTestId(['workspace-more-btn', 'connect-submit'], 45000);
      if (state === 'connect-submit') {
        await submitConnectionOnce();
      }
      await waitForTestId('workspace-more-btn', 45000);
      await waitForTestIdHidden('mobile-reconnect-scrim', 45000);
    };

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
      await openWorkspaceMoreAction('more-stats', 'mobile-stats-view');
      await pollLogcat('[ez-e2e] stats:', 20000, hasCoreCount);
      await tapTestId('mobile-stats-close');
      console.log(`[parity] step OK: ${profile.name} geometry reachable + stats live`);
    }

    console.log('[parity] rotation smoke at main profile...');
    runAdb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    runAdb(['shell', 'settings', 'put', 'system', 'user_rotation', '1']);
    await sleep(1500);
    await ensureWorkspace();
    await waitForTestId('workspace-more-btn'); // still reachable post-rotation
    runAdb(['shell', 'settings', 'put', 'system', 'user_rotation', '0']);
    await sleep(1000);
    console.log('[parity] step OK: rotation smoke');

    console.log('[parity] ALL PASS');
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
  } finally {
    closeMobileE2eResources();
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
