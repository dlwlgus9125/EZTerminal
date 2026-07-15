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
import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { WebSocket, type RawData } from 'ws';

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
export const REMOTE_PORT = Number(process.env.EZTERMINAL_REMOTE_PORT) || 17420;
export const OPENCLAW_PROXY_PORT = Number(process.env.EZTERMINAL_OPENCLAW_PROXY_PORT) || 17421;

export function resolveAndroidHostUrl(
  configured = process.env.EZTERMINAL_MOBILE_E2E_HOST_URL,
): string {
  const candidate = configured?.trim() || `ws://10.0.2.2:${REMOTE_PORT}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`EZTERMINAL_MOBILE_E2E_HOST_URL is not a valid URL: ${JSON.stringify(candidate)}`);
  }
  if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !parsed.hostname || !parsed.port) {
    throw new Error('EZTERMINAL_MOBILE_E2E_HOST_URL must be an explicit ws:// or wss:// host and port');
  }
  return parsed.href.replace(/\/$/, '');
}

// 10.0.2.2 is the emulator default. A physical RC uses adb reverse and
// explicitly overrides this with ws://127.0.0.1:<port>.
export const EMULATOR_HOST_URL = resolveAndroidHostUrl();
const DUMP_DEVICE_PATH = '/sdcard/ez_e2e_dump.xml';
export const DUMP_LOCAL_PATH = path.join(import.meta.dirname, '.ez_e2e_dump.xml');

const ANDROID_HOME =
  process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
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
 * returns stdout. Throws with stderr included if adb itself reports failure.
 * `maxBuffer` matches {@link runAdbBinary}'s 32MiB override — Node's 1MiB
 * default overflows on a long parity run's `logcat -d` (observed crashing a
 * real gate run once the log had accumulated past it). */
export function runAdb(args: string[]): string {
  const serial = resolveDeviceSerial();
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  const result = spawnSync(ADB_BIN, fullArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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

/** Returns Android's current resumed-activity record across API levels that
 * report `topResumedActivity`, `mResumedActivity`, or `ResumedActivity`. */
export function parseResumedActivity(output: string): string {
  return output
    .split(/\r?\n/)
    .find((line) => /(?:topResumedActivity|mResumedActivity|\bResumedActivity)\s*[:=]/.test(line))
    ?.trim() ?? '';
}

export function getResumedActivity(): string {
  const output = runAdb(['shell', 'dumpsys', 'activity', 'activities']);
  return parseResumedActivity(output);
}

export async function waitForResumedActivity(
  packageFragment: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let current = '';
  for (;;) {
    current = getResumedActivity();
    if (current.includes(packageFragment)) return current;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for resumed activity containing ${JSON.stringify(packageFragment)}; `
        + `current=${JSON.stringify(current)}`,
      );
    }
    await sleep(300);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type DeviceBounds = readonly [number, number, number, number];

export interface WebViewViewportMetrics {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
}

/** Resolves the physical WebView content rectangle from ActivityManager's
 * native View hierarchy without Accessibility or UIAutomator. View bounds are
 * parent-relative, so ancestor offsets are accumulated until the Capacitor
 * WebView. CDP's viewport and DPR reject stale hierarchy records after
 * rotation or Fold size/density overrides. */
export function parseWebViewDeviceBounds(
  activityDump: string,
  metrics: WebViewViewportMetrics,
): DeviceBounds | null {
  const { viewportWidth, viewportHeight, devicePixelRatio } = metrics;
  if (
    !Number.isFinite(viewportWidth)
    || !Number.isFinite(viewportHeight)
    || !Number.isFinite(devicePixelRatio)
    || viewportWidth <= 0
    || viewportHeight <= 0
    || devicePixelRatio <= 0
  ) {
    return null;
  }

  const expectedWidth = viewportWidth * devicePixelRatio;
  const expectedHeight = viewportHeight * devicePixelRatio;
  // CSS viewport dimensions are integral on the supported WebViews, so their
  // DPR product may differ from a physical edge by roughly one device pixel.
  const axisTolerance = Math.max(4, devicePixelRatio * 2);

  const candidates: DeviceBounds[] = [];
  let inViewHierarchy = false;
  const ancestors: Array<{
    readonly indent: number;
    readonly absoluteLeft: number;
    readonly absoluteTop: number;
  }> = [];

  for (const line of activityDump.split(/\r?\n/)) {
    if (/^\s*View Hierarchy:\s*$/.test(line)) {
      inViewHierarchy = true;
      ancestors.length = 0;
      continue;
    }
    if (!inViewHierarchy) continue;

    const boundsMatch = line.match(
      /(?:^|\s)(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?=\s|[}\[]|$)/,
    );
    if (!boundsMatch) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (ancestors.at(-1) && ancestors.at(-1)!.indent >= indent) {
      ancestors.pop();
    }
    const localLeft = Number(boundsMatch[1]);
    const localTop = Number(boundsMatch[2]);
    const localRight = Number(boundsMatch[3]);
    const localBottom = Number(boundsMatch[4]);
    const parent = ancestors.at(-1);
    const absoluteLeft = (parent?.absoluteLeft ?? 0) + localLeft;
    const absoluteTop = (parent?.absoluteTop ?? 0) + localTop;
    const absoluteRight = absoluteLeft + localRight - localLeft;
    const absoluteBottom = absoluteTop + localBottom - localTop;
    ancestors.push({ indent, absoluteLeft, absoluteTop });

    if (
      line.includes('com.getcapacitor.CapacitorWebView')
      && absoluteRight > absoluteLeft
      && absoluteBottom > absoluteTop
    ) {
      candidates.push([absoluteLeft, absoluteTop, absoluteRight, absoluteBottom]);
    }
  }

  return candidates
    .map((bounds) => {
      const [left, top, right, bottom] = bounds;
      const widthError = Math.abs((right - left) - expectedWidth);
      const heightError = Math.abs((bottom - top) - expectedHeight);
      return { bounds, widthError, heightError };
    })
    .filter(({ widthError, heightError }) => (
      widthError <= axisTolerance && heightError <= axisTolerance
    ))
    .sort((left, right) => (
      left.widthError + left.heightError - right.widthError - right.heightError
    ))[0]?.bounds ?? null;
}

export function mapWebViewPointToDevice(
  point: Point,
  bounds: DeviceBounds,
  metrics: Pick<WebViewViewportMetrics, 'viewportWidth' | 'viewportHeight'>,
): Point {
  const { viewportWidth, viewportHeight } = metrics;
  if (
    !Number.isFinite(viewportWidth)
    || !Number.isFinite(viewportHeight)
    || viewportWidth <= 0
    || viewportHeight <= 0
  ) {
    throw new Error('WebView viewport dimensions must be positive finite numbers');
  }
  const [left, top, right, bottom] = bounds;
  return {
    x: Math.round(left + point.x * ((right - left) / viewportWidth)),
    y: Math.round(top + point.y * ((bottom - top) / viewportHeight)),
  };
}

/** One `uiautomator dump` node's parsed fields (only what these scripts need). */
export interface DumpNode {
  readonly text: string;
  /** `content-desc` attribute — an aria-label sometimes surfaces here, but on
   * this WebView build it more often surfaces as `text` instead (see
   * {@link waitForLabel}'s doc comment) — callers that care match both. */
  readonly desc: string;
  readonly resourceId: string;
  readonly packageName: string;
  readonly className: string;
  readonly clickable: boolean;
  readonly bounds: readonly [number, number, number, number];
}

function isDocumentsUiNode(node: DumpNode): boolean {
  return node.packageName.toLowerCase().includes('documentsui');
}

export function findDocumentsUiSearchAction(nodes: readonly DumpNode[]): DumpNode | undefined {
  return nodes.find((node) => (
    isDocumentsUiNode(node)
    && node.resourceId.endsWith(':id/option_menu_search')
    && node.clickable
  ));
}

export function findDocumentsUiSearchField(nodes: readonly DumpNode[]): DumpNode | undefined {
  return nodes.find((node) => (
    isDocumentsUiNode(node)
    && node.resourceId.endsWith(':id/search_src_text')
    && (
      node.className === 'android.widget.EditText'
      || node.className === 'android.widget.AutoCompleteTextView'
    )
  ));
}

/** Selects the native document title, never SearchView's same-text query
 * field. DocumentsUI exposes file titles as a TextView/android:id/title on
 * both the AOSP API 29 and Google API 35 implementations. */
export function findDocumentsUiFileResult(
  nodes: readonly DumpNode[],
  filename: string,
): DumpNode | undefined {
  return nodes.find((node) => (
    isDocumentsUiNode(node)
    && node.text === filename
    && node.className === 'android.widget.TextView'
    && (node.resourceId === 'android:id/title' || node.resourceId.endsWith(':id/title'))
  ));
}

export function parseMediaStoreDownloadUri(line: string): string | null {
  return line.match(/content:\/\/media\/(?:external|external_primary)\/downloads\/\d+/)?.[0] ?? null;
}

function escapeE2ERegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mediaStoreDisplayNamePattern(displayName: string): RegExp {
  return new RegExp(
    `(?:^|[\\s,])_display_name=${escapeE2ERegExp(displayName)}(?:,|\\s*$)`,
  );
}

const EZTERMINAL_MEDIASTORE_PATH = /(?:^|[\s,])relative_path=Download\/EZTerminal\/?(?:,|\s*$)/;

/** Parses both API 29 and API 35 `adb shell content query` field order and
 * CRLF variants. This is only test-fixture cleanup/verification data; exact
 * mutation still uses the item URI emitted by the product. */
export function parseEzTerminalMediaStoreDownloadIds(
  output: string,
  displayName: string,
): readonly string[] {
  const expectedName = mediaStoreDisplayNamePattern(displayName);
  const ids: string[] = [];
  for (const row of output.split(/\r?\n/)) {
    if (!expectedName.test(row) || !EZTERMINAL_MEDIASTORE_PATH.test(row)) continue;
    const id = /(?:^|[\s,])_id=(\d+)(?:,|\s*$)/.exec(row)?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

export function isPublishedEzTerminalMediaStoreDownload(
  output: string,
  displayName: string,
): boolean {
  const row = output.trim();
  return mediaStoreDisplayNamePattern(displayName).test(row)
    && EZTERMINAL_MEDIASTORE_PATH.test(row)
    && /(?:^|[\s,])is_pending=0(?:,|\s*$)/.test(row);
}

export function parseDump(xml: string): DumpNode[] {
  const nodes: DumpNode[] = [];
  for (const m of xml.matchAll(/<node\b[^>]*\/?>/g)) {
    const tag = m[0];
    const text = tag.match(/text="([^"]*)"/)?.[1] ?? '';
    const desc = tag.match(/content-desc="([^"]*)"/)?.[1] ?? '';
    const resourceId = tag.match(/resource-id="([^"]*)"/)?.[1] ?? '';
    const packageName = tag.match(/package="([^"]*)"/)?.[1] ?? '';
    const className = tag.match(/class="([^"]*)"/)?.[1] ?? '';
    const clickable = /clickable="true"/.test(tag);
    const boundsMatch = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsMatch) continue;
    const [, x1, y1, x2, y2] = boundsMatch;
    nodes.push({
      text,
      desc,
      resourceId,
      packageName,
      className,
      clickable,
      bounds: [Number(x1), Number(y1), Number(x2), Number(y2)],
    });
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

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface CdpPendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let webViewCdp: WebSocket | null = null;
let webViewCdpRequestId = 0;
let webViewForwardPort: number | null = null;
let webViewDeviceGeometry: {
  readonly bounds: DeviceBounds;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
} | null = null;
const webViewCdpPending = new Map<number, CdpPendingRequest>();

function resetWebViewCdp(error?: Error): void {
  const socket = webViewCdp;
  webViewCdp = null;
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  for (const pending of webViewCdpPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error ?? new Error('Android WebView DevTools connection closed'));
  }
  webViewCdpPending.clear();
  webViewDeviceGeometry = null;
  if (webViewForwardPort !== null) {
    try {
      runAdb(['forward', '--remove', `tcp:${webViewForwardPort}`]);
    } catch {
      // The device may already be gone during best-effort E2E cleanup.
    }
    webViewForwardPort = null;
  }
}

/** Releases the page-level DevTools client so a completed Node E2E process
 * can exit cleanly. The adb forward itself owns no Node event-loop resources. */
export function closeWebViewDevtools(): void {
  resetWebViewCdp();
}

async function resolveWebViewCdp(): Promise<WebSocket> {
  if (webViewCdp?.readyState === WebSocket.OPEN) return webViewCdp;
  resetWebViewCdp();
  const sockets = runAdb(['shell', 'cat', '/proc/net/unix']);
  const socketNames = [...new Set(
    [...sockets.matchAll(/@(webview_devtools_remote(?:_\d+)?)/g)].map((match) => match[1]),
  )].reverse();
  if (socketNames.length === 0) {
    throw new Error('Android WebView DevTools socket is not available (use a debug APK)');
  }

  let port = 0;
  let target: CdpTarget | undefined;
  let discoveryError: unknown;
  for (const socketName of socketNames) {
    const forwarded = runAdb(['forward', 'tcp:0', `localabstract:${socketName}`]).trim();
    const candidatePort = Number(forwarded);
    if (!Number.isSafeInteger(candidatePort) || candidatePort <= 0) {
      discoveryError = new Error(`adb did not allocate a WebView DevTools port: ${JSON.stringify(forwarded)}`);
      continue;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${candidatePort}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`target discovery failed (${response.status})`);
      const targets = await response.json() as CdpTarget[];
      const candidateTarget = targets.find(
        (candidate) => candidate.type === 'page' && candidate.url?.startsWith('http://localhost'),
      );
      if (!candidateTarget?.webSocketDebuggerUrl) throw new Error('target is not the EZTerminal WebView');
      port = candidatePort;
      target = candidateTarget;
      webViewForwardPort = candidatePort;
      break;
    } catch (error) {
      discoveryError = error;
      try {
        runAdb(['forward', '--remove', `tcp:${candidatePort}`]);
      } catch {
        // Continue probing any other live WebView socket.
      }
    }
  }
  if (!target?.webSocketDebuggerUrl || port <= 0) {
    throw new Error(`No inspectable EZTerminal WebView page appeared: ${String(discoveryError)}`);
  }

  const debuggerUrl = new URL(target.webSocketDebuggerUrl);
  debuggerUrl.hostname = '127.0.0.1';
  debuggerUrl.port = String(port);
  const client = new WebSocket(debuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      client.off('open', onOpen);
      client.off('error', onError);
    };
    client.on('open', onOpen);
    client.on('error', onError);
  });
  client.on('message', (raw: RawData) => {
    let message: {
      readonly id?: number;
      readonly error?: { readonly message?: string };
      readonly result?: {
        readonly result?: { readonly value?: unknown; readonly description?: string };
        readonly exceptionDetails?: { readonly text?: string };
      };
    };
    try {
      message = JSON.parse(raw.toString()) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = webViewCdpPending.get(message.id);
    if (!pending) return;
    webViewCdpPending.delete(message.id);
    clearTimeout(pending.timer);
    const protocolError = message.error?.message
      ?? message.result?.exceptionDetails?.text;
    if (protocolError) pending.reject(new Error(protocolError));
    else pending.resolve(message.result?.result?.value);
  });
  client.on('close', () => resetWebViewCdp());
  client.on('error', (error) => resetWebViewCdp(error));
  webViewCdp = client;
  return client;
}

async function evaluateWebView<T>(expression: string): Promise<T> {
  const client = await resolveWebViewCdp();
  const id = webViewCdpRequestId + 1;
  webViewCdpRequestId = id;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = webViewCdpPending.get(id);
      if (!pending) return;
      const timeoutError = new Error('Android WebView DevTools evaluation timed out');
      webViewCdpPending.delete(id);
      // A timed-out Runtime.evaluate means this DevTools transport can no
      // longer be trusted. Drop the socket/adb forward so the caller's retry
      // discovers a fresh WebView target instead of spending its full
      // deadline retrying the same wedged connection.
      resetWebViewCdp(timeoutError);
      pending.reject(timeoutError);
    }, 5_000);
    webViewCdpPending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    client.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }), (error) => {
      if (!error) return;
      const pending = webViewCdpPending.get(id);
      if (!pending) return;
      webViewCdpPending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  });
}

export interface WebViewHistorySnapshot {
  readonly length: number;
  readonly state: unknown;
  readonly url: string;
}

/** A renderer-process memory sample read from the Android WebView itself.
 * `performance.memory` is a Chromium diagnostic API and is expected to be
 * present in the debug/E2E APK used by the release soak. Keeping the nullable
 * shape lets the soak fail with a precise "metric unavailable" error instead
 * of silently substituting an unrelated process-wide number. */
export interface WebViewMemorySnapshot {
  readonly usedJsHeapBytes: number | null;
  readonly totalJsHeapBytes: number | null;
  readonly jsHeapLimitBytes: number | null;
  readonly domNodeCount: number;
  readonly collectedAt: string;
}

export function getWebViewHistorySnapshot(): Promise<WebViewHistorySnapshot> {
  return evaluateWebView<WebViewHistorySnapshot>(
    '({ length: window.history.length, state: window.history.state, url: window.location.href })',
  );
}

export function getWebViewMemorySnapshot(): Promise<WebViewMemorySnapshot> {
  return evaluateWebView<WebViewMemorySnapshot>(`(() => {
    const memory = performance.memory;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      usedJsHeapBytes: finite(memory && memory.usedJSHeapSize),
      totalJsHeapBytes: finite(memory && memory.totalJSHeapSize),
      jsHeapLimitBytes: finite(memory && memory.jsHeapSizeLimit),
      domNodeCount: document.getElementsByTagName('*').length,
      collectedAt: new Date().toISOString(),
    };
  })()`);
}

/** Counts every DOM node with the exact test id, including nodes in hidden
 * tab panels. Release soak uses this to prove all eight sessions remain
 * mounted rather than trusting the currently-visible accessibility tree. */
export function getTestIdCount(testId: string): Promise<number> {
  return evaluateWebView<number>(`[...document.querySelectorAll('[data-testid]')]
    .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)}).length`);
}

/** Sets a controlled input/textarea through its native DOM setter and emits
 * the same bubbling `input` event React consumes. This is reserved for text
 * such as JSON that `adb shell input text` cannot transport byte-for-byte. */
export async function setTestIdTextValue(testId: string, value: string): Promise<void> {
  const actual = await evaluateWebView<string>(`(() => {
    const element = [...document.querySelectorAll('[data-testid]')]
      .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)})
      .reverse()
      .find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
      throw new Error('test-id control is not an input or textarea');
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const setter = descriptor && descriptor.set;
    if (!setter) throw new Error('native value setter is unavailable');
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return element.value;
  })()`);
  if (actual !== value) {
    throw new Error(
      `Failed to set data-testid=${JSON.stringify(testId)} exactly; `
      + `expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
    );
  }
  await sleep(100);
}

export function getTestIdTextContent(testId: string): Promise<string | null> {
  return evaluateWebView<string | null>(`(() => {
    const node = [...document.querySelectorAll('[data-testid]')]
      .find((candidate) => candidate.getAttribute('data-testid') === ${JSON.stringify(testId)});
    return node ? node.textContent : null;
  })()`);
}

/** Waits for a unique test control to expose an exact DOM attribute state.
 * Useful for locale-independent selected/toggled assertions that Android's
 * accessibility text would otherwise encode as translated labels. */
export async function waitForTestIdAttribute(
  testId: string,
  attribute: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActual: string | null = null;
  let lastError: unknown;
  for (;;) {
    try {
      lastActual = await evaluateWebView<string | null>(`(() => {
        const node = [...document.querySelectorAll('[data-testid]')]
          .find((candidate) => candidate.getAttribute('data-testid') === ${JSON.stringify(testId)});
        return node ? node.getAttribute(${JSON.stringify(attribute)}) : null;
      })()`);
      if (lastActual === expected) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `; last error: ${String(lastError)}` : '';
      throw new Error(
        `Timed out waiting for data-testid=${JSON.stringify(testId)} `
        + `${attribute}=${JSON.stringify(expected)} (last ${JSON.stringify(lastActual)})${detail}`,
      );
    }
    await sleep(250);
  }
}

/** Waits for the visible instance of a duplicated test-id control to become
 * enabled. Hidden mounted terminal tabs intentionally keep controls with the
 * same ids, so querying the first DOM match would observe the wrong tab. */
export async function waitForVisibleTestIdEnabled(
  testId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const enabled = await evaluateWebView<boolean>(`(() => {
        const element = [...document.querySelectorAll('[data-testid]')]
          .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)})
          .reverse()
          .find((node) => {
            if (!(node instanceof HTMLElement)) return false;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none' && style.visibility !== 'hidden';
          });
        return element instanceof HTMLElement
          && !element.hasAttribute('disabled')
          && element.getAttribute('aria-disabled') !== 'true';
      })()`);
      if (enabled) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `: ${String(lastError)}` : '';
      throw new Error(`Timed out waiting for visible data-testid=${JSON.stringify(testId)} to become enabled${detail}`);
    }
    await sleep(250);
  }
}

/** Returns the 0-based selected item among same-test-id tab controls, or -1.
 * This is an assertion helper only; interactions still go through Android
 * touch dispatch in {@link tapTestIdAt}. */
export function getSelectedTestIdIndex(testId: string): Promise<number> {
  return evaluateWebView<number>(`[...document.querySelectorAll('[data-testid]')]
    .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)})
    .findIndex((node) => node.getAttribute('aria-selected') === 'true')`);
}

function visibleTestIdExpression(testId: string, scrollIntoView = false): string {
  return `(() => {
    const nodes = [...document.querySelectorAll('[data-testid]')]
      .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)});
    const element = nodes.reverse().find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!(element instanceof HTMLElement)) return null;
    ${scrollIntoView ? "element.scrollIntoView({ block: 'center', inline: 'center' });" : ''}
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    };
  })()`;
}

interface WebViewElementGeometry extends WebViewViewportMetrics, Point {}

function resolveWebViewDeviceGeometry(
  geometry: WebViewElementGeometry,
): NonNullable<typeof webViewDeviceGeometry> {
  if (
    !webViewDeviceGeometry
    || webViewDeviceGeometry.viewportWidth !== geometry.viewportWidth
    || webViewDeviceGeometry.viewportHeight !== geometry.viewportHeight
    || webViewDeviceGeometry.devicePixelRatio !== geometry.devicePixelRatio
  ) {
    const activityDump = runAdb(['shell', 'dumpsys', 'activity', APP_ID]);
    const bounds = parseWebViewDeviceBounds(activityDump, geometry);
    webViewDeviceGeometry = bounds
      ? {
          bounds,
          viewportWidth: geometry.viewportWidth,
          viewportHeight: geometry.viewportHeight,
          devicePixelRatio: geometry.devicePixelRatio,
        }
      : null;
  }
  if (!webViewDeviceGeometry) {
    throw new Error(
      'Android WebView window bounds do not match the live CDP viewport '
      + `${geometry.viewportWidth}x${geometry.viewportHeight}@${geometry.devicePixelRatio}`,
    );
  }
  return webViewDeviceGeometry;
}

async function tapWebViewElementGeometry(geometry: WebViewElementGeometry): Promise<void> {
  const deviceGeometry = resolveWebViewDeviceGeometry(geometry);
  await tap(mapWebViewPointToDevice(geometry, deviceGeometry.bounds, geometry));
}

/** Locates a DOM test id through CDP, then performs a real device-level tap
 * at its center. WindowManager + CDP geometry keeps this path completely
 * independent from UIAutomator while still validating Android touch dispatch
 * rather than calling click(). */
export async function tapTestId(testId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const geometry = await evaluateWebView<{
        readonly x: number;
        readonly y: number;
        readonly viewportWidth: number;
        readonly viewportHeight: number;
        readonly devicePixelRatio: number;
      } | null>(visibleTestIdExpression(testId, true));
      if (!geometry) throw new Error('element is not visible');
      await tapWebViewElementGeometry(geometry);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() > deadline) {
        throw new Error(`Timed out tapping data-testid=${JSON.stringify(testId)}: ${String(lastError)}`);
      }
      await sleep(300);
    }
  }
}

/** Indexed sibling of {@link tapTestId}. The selected element is first
 * scrolled into view (needed for the horizontally-overflowing eight-tab
 * strip), then tapped through Android input at its real device coordinates. */
export async function tapTestIdAt(testId: string, index: number, timeoutMs = 15_000): Promise<void> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid test-id index: ${index}`);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const geometry = await evaluateWebView<{
        readonly x: number;
        readonly y: number;
        readonly viewportWidth: number;
        readonly viewportHeight: number;
        readonly devicePixelRatio: number;
      } | null>(`(() => {
        const nodes = [...document.querySelectorAll('[data-testid]')]
          .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)});
        const element = nodes[${index}];
        if (!(element instanceof HTMLElement)) return null;
        element.scrollIntoView({ inline: 'center', block: 'nearest' });
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        };
      })()`);
      if (!geometry) throw new Error('element is missing or not visible');
      await tapWebViewElementGeometry(geometry);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out tapping data-testid=${JSON.stringify(testId)} at index ${index}: ${String(lastError)}`,
        );
      }
      await sleep(300);
    }
  }
}

export async function waitForTestId(testId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const geometry = await evaluateWebView<unknown | null>(visibleTestIdExpression(testId));
      if (geometry) return;
      lastError = undefined;
    } catch (error) {
      // On a cold install Android can launch the Activity several seconds
      // before WebView exposes its DevTools socket. Treat that as "not ready"
      // so the product-state wait owns the complete startup deadline.
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `: ${String(lastError)}` : '';
      throw new Error(`Timed out waiting for data-testid=${JSON.stringify(testId)}${detail}`);
    }
    await sleep(250);
  }
}

/** Waits until the visible instance of a test-id host contains a rendered,
 * visible descendant. This proves canvas-backed widgets such as xterm have
 * mounted their real DOM instead of merely trusting the React host shell. */
export async function waitForVisibleTestIdDescendant(
  testId: string,
  descendantSelector: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const visible = await evaluateWebView<boolean>(`(() => {
        const isVisible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const host = [...document.querySelectorAll('[data-testid]')]
          .filter((node) => node.getAttribute('data-testid') === ${JSON.stringify(testId)})
          .reverse()
          .find(isVisible);
        if (!(host instanceof HTMLElement)) return false;
        return isVisible(host.querySelector(${JSON.stringify(descendantSelector)}));
      })()`);
      if (visible) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `: ${String(lastError)}` : '';
      throw new Error(
        `Timed out waiting for visible data-testid=${JSON.stringify(testId)} `
        + `to contain ${JSON.stringify(descendantSelector)}${detail}`,
      );
    }
    await sleep(250);
  }
}

/** Locale-independent race between visible product states. Returns the first
 * matching stable test id instead of depending on translated labels. */
export async function waitForAnyTestId(
  testIds: readonly string[],
  timeoutMs = 15_000,
): Promise<string> {
  if (testIds.length === 0) throw new Error('waitForAnyTestId requires at least one test id');
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      for (const testId of testIds) {
        const geometry = await evaluateWebView<unknown | null>(visibleTestIdExpression(testId));
        if (geometry) return testId;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `: ${String(lastError)}` : '';
      throw new Error(`Timed out waiting for one of data-testid=${JSON.stringify(testIds)}${detail}`);
    }
    await sleep(250);
  }
}

export async function waitForTestIdHidden(testId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const geometry = await evaluateWebView<unknown | null>(visibleTestIdExpression(testId));
      if (!geometry) return;
      lastError = undefined;
    } catch (error) {
      // A missing CDP endpoint does not prove that an element is hidden.
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `: ${String(lastError)}` : '';
      throw new Error(`Timed out hiding data-testid=${JSON.stringify(testId)}${detail}`);
    }
    await sleep(250);
  }
}

export async function typeText(text: string): Promise<void> {
  runAdb(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  await sleep(400);
}

/** Simulates a long-press at `p` via `adb shell input swipe x y x y <ms>` —
 * the standard adb trick for a "hold in place" gesture: a swipe with
 * identical start/end coordinates dwells for the full duration instead of
 * moving. Used for MobileFileView's row long-press action sheet (M6), which
 * needs >=500ms of continuous contact (long-press.ts's `LongPressTracker`
 * default) — a plain {@link tap} is a quick down+up, too fast to fire it. */
export async function longPress(p: Point, ms = 600): Promise<void> {
  runAdb(['shell', 'input', 'swipe', String(p.x), String(p.y), String(p.x), String(p.y), String(ms)]);
  await sleep(400);
}

/** Sends Android's KEYCODE_ENTER (66) to whatever EditText currently has
 * focus. Every OTHER flow in this codebase's e2e scripts submits via an
 * explicit button (Run, Connect, ...) rather than relying on the IME's
 * Enter/Go action — this exists for MobileFileView's path bar (M6), whose
 * `onKeyDown` only navigates on a literal Enter keydown and has no separate
 * submit button. Verified by parity.ts against the real MobileFileView path
 * input; keeping it isolated here avoids coupling other flows to IME action-
 * label behavior. */
export async function pressEnter(): Promise<void> {
  runAdb(['shell', 'input', 'keyevent', '66']);
  await sleep(500);
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

/** Like {@link waitForText}, but does NOT require the matching node to be
 * marked `clickable` (M6) — every tap target these scripts have used up to
 * now (Run/Connect/theme-sheet-rows/TabStrip's pills — the latter genuine
 * `<button>` elements, confirmed by reading TabStrip.tsx while adding this)
 * IS a real `<button>`, which the WebView's accessibility bridge always
 * marks clickable. MobileFileView's file-list rows (M6) are plain
 * `<div onClick>`, not buttons — Chrome's accessibility engine does not
 * reliably infer clickability for a bare div from its JS listener alone, so
 * `waitForText`'s `n.clickable` filter risks never matching a real, tappable
 * row. This is safe regardless: `input tap` simulates a physical touch at a
 * screen position — it never consults the accessibility tree's `clickable`
 * flag, which only exists here as a disambiguating search filter. */
export async function waitForAnyNodeText(text: string, timeoutMs = 15000): Promise<Point> {
  const start = Date.now();
  let lastNodes: DumpNode[] = [];
  for (;;) {
    const nodes = tryDumpUi();
    if (nodes.length > 0) lastNodes = nodes;
    // Exact text first, then prefix — VERIFIED TRAP (first live run): the
    // WebView merges a row's child spans into ONE dumped node text, so a file
    // row (name span + size span) dumps as `"parityreadtxt.txt25 B"` and an
    // equality check can never match the bare filename.
    const match = nodes.find((n) => n.text === text) ?? nodes.find((n) => n.text.startsWith(text));
    if (match) return center(match.bounds);
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for text "${text}" (any node). Current texts: ${JSON.stringify(lastNodes.map((n) => n.text).filter(Boolean))}`,
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
 * touches, including the token field.
 *
 * Clears any PRE-EXISTING content before typing (move-to-end + generous
 * backspace, one `input keyevent` call) — every field this was originally
 * written against (ConnectScreen's URL/token, cmd-input) starts empty, so
 * this was a no-op for them and the gap went unnoticed; MobileFileView's
 * path bar (M6) starts pre-filled with a cwd snapshot, where typing without
 * clearing first would just insert into the existing text instead of
 * replacing it. */
export async function fillReliably(index: number, text: string, maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const p = await waitForEditText(index);
    await tap(p);
    await sleep(600);
    runAdb(['shell', 'input', 'keyevent', '123', ...Array<string>(120).fill('67')]); // MOVE_END, then DEL x120
    await sleep(300);
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

/** Matches uncaught JavaScript exceptions emitted by this app's WebView while
 * excluding generic application error messages and unrelated Android logs. */
export function isWebViewJavaScriptRuntimeError(line: string): boolean {
  const isWebViewConsole = /\bCapacitor\/Console\b/.test(line)
    || /\bchromium\b.*\[ERROR:CONSOLE\(/i.test(line);
  if (!isWebViewConsole) return false;
  return /\bUncaught (?:\(in promise\) )?(?:EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|Error|DOMException)(?::|\b)/.test(line)
    || /\bReferenceError:\s*WeakRef is not defined\b/.test(line);
}

export function assertNoWebViewJavaScriptRuntimeErrors(): void {
  const failures = runAdb(['logcat', '-d', '-v', 'brief'])
    .split(/\r?\n/)
    .filter(isWebViewJavaScriptRuntimeError);
  if (failures.length === 0) return;
  throw new Error(
    `WebView JavaScript runtime error detected:\n${failures.slice(-20).join('\n')}`,
  );
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
  env.EZTERMINAL_ALLOW_MULTIPLE_INSTANCES = '1';
  env.EZTERMINAL_REMOTE_PORT = String(REMOTE_PORT);
  env.EZTERMINAL_OPENCLAW_PROXY_PORT = String(OPENCLAW_PROXY_PORT);
  const app = await electron.launch({ args: [MAIN_ENTRY], env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const token: string = await win.evaluate(() => window.ezterminal.getRemoteToken());
  // Remote control is OFF by default (opt-in, security review) — turn it on so
  // the phone can reach the bridge. `setRemoteEnabled` resolves only after the
  // WS listener has actually bound, so the emulator connect that follows won't
  // race a not-yet-listening port.
  await win.evaluate(() => window.ezterminal.setRemoteEnabled(true));
  return { app, token };
}

/**
 * Drives the phone from a cold/unknown app state into the authed
 * MobileWorkspace: installs the debug APK fresh, clears any stale app data,
 * launches the Activity, fills the connect form with the resolved Android
 * host URL (`10.0.2.2` by default, adb-reversed loopback on physical RC) +
 * `token`, then submits the stable connect control exactly once. A release
 * candidate must expose a cold-start connection failure instead of hiding it
 * behind a later successful product retry.
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

  // The first WebView process after a clean install can take materially longer
  // than a warm launch. Wait for the actual product state, not merely the
  // Activity process or accessibility tree, before trying to type.
  await waitForTestId('connect-screen', 45_000);

  console.log('[e2e] filling connect form...');
  // Use the controlled-input path for connection credentials. Old API 29
  // IMEs can autocorrect an adb-injected `ws://` value (observed `we://`),
  // while this path proves the exact React state without keyboard variance.
  await setTestIdTextValue('connect-url', EMULATOR_HOST_URL);
  await setTestIdTextValue('connect-token', token);

  await submitConnectionOnce();
}

/** Submit a prepared ConnectScreen exactly once and require its first product
 * result to be the workspace. Sharing this helper prevents individual RC
 * scenarios from quietly re-introducing connection retries. */
export async function submitConnectionOnce(): Promise<void> {
  console.log('[e2e] connecting (single attempt)...');
  await tapTestId('connect-submit');
  const outcome = await waitForAnyTestId(
    ['mobile-workspace', 'connect-error', 'connect-protocol-incompatible'],
    10000,
  );
  if (outcome !== 'mobile-workspace') {
    throw new Error(`Connection failed on the only allowed attempt: ${outcome}`);
  }
}

/** Creates a terminal from the 1.0 workspace's locale-independent header
 * action and waits until its command surface is ready for input. */
export async function createTerminalSession(): Promise<void> {
  await waitForTestId('mobile-workspace', 30_000);
  await tapTestId('tab-add-btn');
  await waitForTestId('mobile-session-view', 30_000);
}

/** Opens a More destination with real Android taps and verifies each state
 * transition. A missed native row tap may either leave the sheet open or hit
 * its backdrop and close it, so every attempt re-observes destination/sheet/
 * trigger state instead of treating "sheet closed" as proof of navigation. */
export async function openWorkspaceMoreAction(
  actionTestId: string,
  destinationTestId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(250, deadline - Date.now());
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt += 1) {
    let state: string;
    try {
      state = await waitForAnyTestId(
        [destinationTestId, 'workspace-more-sheet', 'workspace-more-btn'],
        Math.min(3_000, remaining()),
      );
    } catch (error) {
      lastError = error;
      continue;
    }
    if (state === destinationTestId) return;

    if (state === 'workspace-more-btn') {
      try {
        await tapTestId('workspace-more-btn', remaining());
        state = await waitForAnyTestId(
          [destinationTestId, 'workspace-more-sheet'],
          Math.min(5_000, remaining()),
        );
        if (state === destinationTestId) return;
      } catch (error) {
        lastError = error;
        console.log(`[e2e] More open attempt ${attempt} did not settle: ${String(error)}`);
        continue;
      }
    }

    try {
      await tapTestId(actionTestId, remaining());
      await waitForTestId(destinationTestId, Math.min(7_000, remaining()));
      return;
    } catch (error) {
      lastError = error;
      console.log(
        `[e2e] ${actionTestId} attempt ${attempt} did not reach ${destinationTestId}; re-observing state: ${String(error)}`,
      );
    }
  }

  throw new Error(
    `Unable to open ${destinationTestId} through ${actionTestId} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}
