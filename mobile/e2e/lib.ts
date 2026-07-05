/**
 * mobile/e2e/lib.ts — shared Android-emulator e2e helpers (mobile-parity plan
 * M6, D8). Extracted out of `smoke.ts` (M3) plus the M2/M4 and M3/M5
 * orchestrator verification scripts (`.scratch-verify-m2m4.ts` /
 * `.scratch-verify-m3m5.ts`, both temporary and removed once this file
 * landed) — every helper here was battle-tested against the real Android
 * emulator across those milestones. `smoke.ts` and `parity.ts` both import
 * from here; neither duplicates a helper.
 *
 * See `smoke.ts`'s header doc for the general emulator/adb setup story
 * (prerequisites this file does NOT manage: a booted AVD, a fresh debug APK,
 * a fresh `.vite/build/main.js`, port 7420 free).
 *
 * Run directly via `node <file>.ts` (Node's native TS type-stripping, no
 * ts-node/tsx) — relative imports MUST carry the explicit `.ts` extension
 * (verified: Node's ESM resolver does not probe extensions), which is why
 * `smoke.ts`/`parity.ts` import this file as `./lib.ts`, not `./lib`.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
export const APK_PATH = path.join(
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
export const APP_ID = 'com.ezterminal.remote';
export const REMOTE_PORT = 7420;
// 10.0.2.2 is the Android emulator's fixed alias for the HOST machine's localhost.
export const EMULATOR_HOST_URL = `ws://10.0.2.2:${REMOTE_PORT}`;
const DUMP_DEVICE_PATH = '/sdcard/ez_e2e_dump.xml';
export const DUMP_LOCAL_PATH = path.join(import.meta.dirname, '.ez_e2e_dump.xml');

const ANDROID_HOME = process.env.ANDROID_HOME ?? String.raw`C:\Users\dlwlg\AppData\Local\Android\Sdk`;
const ADB_BIN = path.join(ANDROID_HOME, 'platform-tools', 'adb.exe');

// ── Device targeting ─────────────────────────────────────────────────────
// A wireless-debugging phone can show up in `adb devices` alongside the
// emulator, so every adb call needs an explicit `-s <serial>` once more than
// one device is attached. Resolved LAZILY (only on the first real adb call,
// never at module-import time — importing this file for a syntax check must
// never spawn adb) and memoized for the life of the process. Honors
// `ANDROID_SERIAL` if set; otherwise auto-picks the sole attached device, or
// prefers an `emulator-*` serial when several are attached.
let deviceSerial: string | undefined | null = null; // null = not yet resolved

function resolveDeviceSerial(): string | undefined {
  if (deviceSerial !== null) return deviceSerial;
  if (process.env.ANDROID_SERIAL) {
    deviceSerial = process.env.ANDROID_SERIAL;
    return deviceSerial;
  }
  const raw = spawnSync(ADB_BIN, ['devices'], { encoding: 'utf8' }).stdout ?? '';
  const devices = raw
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial);
  deviceSerial =
    devices.length <= 1 ? devices[0] : (devices.find((d) => d.startsWith('emulator-')) ?? devices[0]);
  return deviceSerial;
}

/** Runs `adb <args>` via spawnSync (argv array, never a shell string) and
 * returns stdout. Throws with stderr included if adb itself reports failure. */
export function runAdb(args: string[]): string {
  const serial = resolveDeviceSerial();
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  const result = spawnSync(ADB_BIN, fullArgs, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`adb ${fullArgs.join(' ')} failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Like {@link runAdb}, but returns raw stdout bytes (e.g. a PNG from
 * `exec-out screencap -p`). */
export function runAdbBinary(args: string[]): Buffer {
  const serial = resolveDeviceSerial();
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  const result = spawnSync(ADB_BIN, fullArgs, { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`adb ${fullArgs.join(' ')} failed (exit ${String(result.status)})`);
  }
  return result.stdout;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One `uiautomator dump` node's parsed fields (only what these scripts need). */
export interface DumpNode {
  readonly text: string;
  /** `content-desc` attribute — an aria-label sometimes surfaces here, but on
   * this WebView build it more often surfaces as `text` instead (see
   * {@link waitForLabel}'s doc comment) — callers that care match both. */
  readonly desc: string;
  readonly className: string;
  readonly clickable: boolean;
  readonly bounds: readonly [number, number, number, number];
}

export function parseDump(xml: string): DumpNode[] {
  const nodes: DumpNode[] = [];
  for (const m of xml.matchAll(/<node\b[^>]*\/?>/g)) {
    const tag = m[0];
    const text = tag.match(/text="([^"]*)"/)?.[1] ?? '';
    const desc = tag.match(/content-desc="([^"]*)"/)?.[1] ?? '';
    const className = tag.match(/class="([^"]*)"/)?.[1] ?? '';
    const clickable = /clickable="true"/.test(tag);
    const boundsMatch = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsMatch) continue;
    const [, x1, y1, x2, y2] = boundsMatch;
    nodes.push({ text, desc, className, clickable, bounds: [Number(x1), Number(y1), Number(x2), Number(y2)] });
  }
  return nodes;
}

/** Re-dumps the CURRENT UI — never cached, since the WebView's a11y tree
 * changes on every interaction. `uiautomator dump` occasionally fails
 * transiently (observed exit 137) right after `am start`, before the
 * Activity/WebView has fully attached — callers that poll (waitForText/
 * waitForEditText/...) go through {@link tryDumpUi} so a failed dump reads as
 * "not ready yet" and retries, rather than propagating as fatal. */
export function dumpUi(): DumpNode[] {
  runAdb(['shell', 'uiautomator', 'dump', DUMP_DEVICE_PATH]);
  runAdb(['pull', DUMP_DEVICE_PATH, DUMP_LOCAL_PATH]);
  return parseDump(readFileSync(DUMP_LOCAL_PATH, 'utf8'));
}

export function tryDumpUi(): DumpNode[] {
  try {
    return dumpUi();
  } catch {
    return [];
  }
}

export function center(bounds: readonly [number, number, number, number]): Point {
  const [x1, y1, x2, y2] = bounds;
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

export async function tap(p: Point): Promise<void> {
  runAdb(['shell', 'input', 'tap', String(p.x), String(p.y)]);
  await sleep(400);
}

export async function typeText(text: string): Promise<void> {
  runAdb(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  await sleep(400);
}

/** Poll `uiautomator dump` until a clickable node with `text` appears (cold
 * starts, connect/session round trips, etc. all vary in timing — a fixed
 * sleep either wastes time or races a slow one). */
export async function waitForText(text: string, timeoutMs = 15000): Promise<Point> {
  const start = Date.now();
  let lastNodes: DumpNode[] = [];
  for (;;) {
    const nodes = tryDumpUi();
    if (nodes.length > 0) lastNodes = nodes;
    const match = nodes.find((n) => n.text === text && n.clickable);
    if (match) return center(match.bounds);
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for clickable text "${text}". Current texts: ${JSON.stringify(lastNodes.map((n) => n.text).filter(Boolean))}`,
      );
    }
    await sleep(500);
  }
}

/** Like {@link waitForText}, but matches EITHER `text` OR `content-desc` —
 * VERIFIED TRAP: an icon-only button's `aria-label` surfaces as the dump
 * node's `text` (not `content-desc`) on this WebView build, but matching
 * either survives whichever mapping actually applies. Also VERIFIED TRAP:
 * `position:fixed` overlays (the ThemeMenu sheet, the sheet variant of
 * SessionSwitcher, any backdrop) never appear in a uiautomator dump at all
 * even while visually open — this only ever finds in-flow, dump-visible
 * nodes (e.g. the header buttons that OPEN those overlays), never their
 * contents once open. */
export async function waitForLabel(label: string, timeoutMs = 15000): Promise<Point> {
  const start = Date.now();
  let lastNodes: DumpNode[] = [];
  for (;;) {
    const nodes = tryDumpUi();
    if (nodes.length > 0) lastNodes = nodes;
    const match = nodes.find((n) => (n.text === label || n.desc === label) && n.clickable);
    if (match) return center(match.bounds);
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for label "${label}". Current texts: ${JSON.stringify(lastNodes.map((n) => n.text || n.desc).filter(Boolean))}`,
      );
    }
    await sleep(500);
  }
}

/** Like {@link waitForText}, but returns as soon as ANY of several outcomes
 * appears (e.g. success text vs. a failure banner) rather than only knowing
 * one specific text ever showed up. */
export async function waitForAnyText(texts: readonly string[], timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const nodes = tryDumpUi();
    const found = texts.find((text) => nodes.some((n) => n.text === text));
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for any of ${JSON.stringify(texts)}. Current texts: ${JSON.stringify(nodes.map((n) => n.text).filter(Boolean))}`,
      );
    }
    await sleep(500);
  }
}

/** Same idea as {@link waitForText}, for the Nth `android.widget.EditText` on
 * screen (0-indexed) — ConnectScreen's URL/token fields have no distinguishing
 * text (placeholder text isn't reflected in `text=`, and the token field is
 * always masked visually), so position-in-dump is the only handle. */
export async function waitForEditText(index: number, timeoutMs = 15000): Promise<Point> {
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

/** Tap the Nth EditText and type `text`, VERIFYING via a fresh dump that the
 * field actually received it, retrying the whole tap+type cycle otherwise.
 * Needed because the WebView's touch dispatch can still be warming up even
 * once uiautomator's accessibility tree reports the element as present — a
 * tap can land with no visible focus/keyboard at all, so the following
 * `input text` has nothing focused to receive it and is silently dropped.
 * Password fields are NOT masked in the accessibility tree's `text` attribute
 * (only visually), so a plain equality check works for every field this
 * touches, including the token field. */
export async function fillReliably(index: number, text: string, maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const p = await waitForEditText(index);
    await tap(p);
    await sleep(600);
    await typeText(text);
    await sleep(300);
    const editTexts = tryDumpUi().filter((n) => n.className === 'android.widget.EditText');
    const current = editTexts[index]?.text ?? '';
    if (current === text) return;
    console.log(
      `[e2e] fill attempt ${attempt} for field ${index} didn't take (got ${JSON.stringify(current)}), retrying...`,
    );
  }
  throw new Error(`Failed to fill EditText ${index} with "${text}" after ${maxAttempts} attempts`);
}

/** Tap a point known to be outside any input (the title text) to close the
 * soft keyboard. NEVER use KEYCODE_BACK for this — with no field focused it
 * exits the Activity instead of just dismissing the keyboard. The extra
 * settle time is deliberate: the keyboard-close animation resizes the
 * WebView, and a dump/tap issued before it finishes computes stale bounds. */
export async function dismissKeyboard(): Promise<void> {
  await tap({ x: 500, y: 700 });
  await sleep(1000);
}

export function logcatLines(substr: string): string[] {
  return runAdb(['logcat', '-d'])
    .split('\n')
    .filter((l) => l.includes(substr));
}

/** Polls logcat until a line containing `substr` (optionally further matching
 * `filter`) appears, or throws after `timeoutMs` (dumping recent `[ez-e2e]`
 * lines for diagnosis first). */
export async function pollLogcat(
  substr: string,
  timeoutMs: number,
  filter?: (line: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(1000);
    const hit = logcatLines(substr).find((l) => (filter ? filter(l) : true));
    if (hit) return hit;
    if (Date.now() > deadline) {
      console.error(`[e2e] recent [ez-e2e] lines:\n${logcatLines('[ez-e2e]').slice(-25).join('\n')}`);
      throw new Error(`logcat marker not found in ${timeoutMs}ms: ${substr}`);
    }
  }
}

/** Launches the REAL desktop app (isolated userData dir, same pattern as root
 * `e2e/launch-app.ts`) and returns it along with its real persisted remote
 * token. `getRemoteToken()` (M4) mints+persists on first call — no need to
 * wait for a WS client to connect first (the WS-triggered mint path only
 * fires on first `auth`). */
export async function launchDesktop(): Promise<{ app: ElectronApplication; token: string }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.EZTERMINAL_USER_DATA_DIR = userDataDir;
  const app = await electron.launch({ args: [MAIN_ENTRY], env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const token: string = await win.evaluate(() => window.ezterminal.getRemoteToken());
  return { app, token };
}

/**
 * Drives the phone from a cold/unknown app state into the authed
 * MobileWorkspace: installs the debug APK fresh, clears any stale app data,
 * launches the Activity, fills the connect form with `EMULATOR_HOST_URL` +
 * `token`, and retries tapping `Connect` until `'+ New Session'` shows (a
 * first attempt sometimes races App.tsx's 6s CONNECT_TIMEOUT_MS on a
 * just-booted app — a bare retry succeeds once whatever warmup cost caused
 * the miss is already paid).
 *
 * Idempotent / tolerant of re-entry: safe to call again at any point in a
 * test (e.g. after a force-stop+restart mid-run) since it always
 * re-establishes from a known-clean state (fresh install + `pm clear`) rather
 * than assuming one.
 */
export async function connectAndAuth(token: string): Promise<void> {
  console.log('[e2e] installing APK (fresh app data)...');
  runAdb(['install', '-r', APK_PATH]);
  runAdb(['shell', 'pm', 'clear', APP_ID]); // drop any stale localStorage from a previous run

  console.log('[e2e] clearing logcat and launching app...');
  runAdb(['logcat', '-c']);
  runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);

  console.log('[e2e] filling connect form...');
  await fillReliably(0, EMULATOR_HOST_URL);
  await fillReliably(1, token);
  await dismissKeyboard();

  console.log('[e2e] connecting...');
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
    if (!connected) console.log(`[e2e] connect attempt ${attempt} didn't succeed, retrying...`);
  }
  if (!connected) throw new Error('Connect kept failing after 5 attempts');
}
