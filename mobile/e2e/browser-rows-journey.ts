/**
 * The in-app browser (`in-app-browser-v1`) on a real Android device: rows only (D16). An isolated desktop on the deterministic
 * Codex fixture, at the tools' floor, drives the real browser tools on a loopback stub; every `*.example` name maps to 127.0.0.1
 * inside the desktop's Electron alone, so no real site is reached. In Korean, at 360×800 (`wm size` and `wm density`, put back
 * at the end).
 *
 * A typed action with Enter on an allowed outside site waits on the desktop. The phone says who it waits on and until when, and
 * has no way to answer it: not in the conversation, not on the feed's 나를 기다리는 것, not in the list; an answer it sends anyway
 * is refused by the host. The desktop's answer and the 240 s expiry (on a short clock: only the timer that ends it is shorter,
 * the row still says 240 s) each end in a refused row, and a late answer finds nothing. Nothing the phone receives holds the
 * typed value: every message the app reads from its socket (at the point it reads it), the page, and the phone's stores
 * (decrypted through the app's own plugin, and the app's files raw) are searched.
 *
 * Pictures carry no test wording: a local copy of the fake Codex answers in Korean and names its model without "Fixture", and
 * the browser script reaches it outside the person's message.
 *
 * Run: node --experimental-strip-types mobile/e2e/browser-rows-journey.ts [--theme=matrix|dark] (fresh debug APK and desktop build first).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, networkInterfaces, userInfo } from 'node:os';
import path from 'node:path';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APP_ID, closeMobileE2eResources, connectAndAuth, evaluateWebView, launchDesktop, mapWebViewPointToDevice, openConversationList, openFeed, openShellDestination,
  parseWebViewDeviceBounds, runAdb, runAdbBinary, setTestIdTextValue, shortPressOnce, sleep, tapTestId, tapTestIdOnce, waitForTestId, waitForTestIdHidden,
} from './lib.ts';

const argument = (name: string): string | undefined => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const THEME = argument('theme') ?? 'matrix';
const androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
const artifacts = process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR
  ? path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, `../../artifacts/in-app-browser/android/api${androidApi}-${THEME}`);
/** The oldest Codex the browser tools run on (CODEX_BROWSER_MINIMUM_VERSION). */
const BROWSER_CODEX_VERSION = '0.165.0';
/** src/shared/browser.ts BROWSER_PARTITION and BROWSER_APPROVAL_HOLD_MS. */
const BROWSER_PARTITION = 'persist:ezterminal-browser';
const HOLD_MS = 240_000;
/** What the short clock ends the second approval at. */
const SHORT_HOLD_MS = 30_000;
const RESOLVER_RULES = '--host-resolver-rules=MAP *.example 127.0.0.1';
const SITE_NAME = 'staging.cart-kit.example';
/** What the stand-in resolver answers for the site: a public address, so the app's rebind guard lets it be. */
const PUBLIC_ADDRESS = '93.184.216.34';
/** The value the AI types: distinctive, so a search finds it wherever it went. */
const TYPED = 'PLUMHARBOR-73914-QZ';

const WAITING_ROW = '[data-testid="chat-browser-waiting"]';
const BLOCKED_ROW = '[data-testid="chat-browser-blocked"]';
const RUN_ROW = '[data-testid="chat-browser-run"]';
const HINT = '[data-testid="structured-agent-composer-hint"]';
const COMPOSER = '[data-testid="structured-agent-composer-input"]';
const SEND = '[data-testid="structured-agent-send"]';
const FEED_CARD = '[data-testid="mobile-feed-waiting"]';
const BACK = '[data-testid="mobile-structured-agent-back"]';
/** Every control that answers an approval on a phone, by its mark, and any button that reads like one. */
const ANSWER_CONTROLS = ['[data-dock-primary]', '.chat-dock', '[data-testid="mobile-feed-allow"]', '[data-testid="mobile-feed-deny"]', '[data-testid="agent-approve"]', '[data-testid="agent-deny"]', '[data-testid="chat-dock-allow-site"]'];

const shots: string[] = [];
const targets: { readonly label: string; readonly width: number; readonly height: number }[] = [];
const checks: string[] = [];
const facts: Record<string, unknown> = {};

// ── Nothing private, nothing of a test, in a picture ─────────────────────────────────────────────────────────────────

const PRIVATE = [
  userInfo().username, homedir(), 'AppData', 'Users\\', 'EZTERMINAL_E2E', 'ezterm-', 'fixture', 'Browser script',
  ...Object.values(networkInterfaces()).flat().filter((info) => info && !info.internal && info.family === 'IPv4').map((info) => info!.address),
].filter(Boolean);

async function capture(name: string, clean = false): Promise<void> {
  if (clean) {
    const text = await evaluateWebView<string>('document.body.innerText');
    const found = PRIVATE.filter((secret) => text.toLowerCase().includes(secret.toLowerCase()));
    assert.deepEqual(found, [], `${name}: the screen shows ${found.join(', ')}`);
    await writeFile(path.join(artifacts, `${name}.txt`), text);
  }
  await writeFile(path.join(artifacts, `${name}.png`), runAdbBinary(['exec-out', 'screencap', '-p']));
  shots.push(`${name}.png`);
}

// ── The phone ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Polls an expression in the WebView (Android 10's WebView 74: no `?.` or `??` in it). */
async function waitFor(expression: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await evaluateWebView<boolean>(expression)) return;
      lastError = undefined;
    } catch (error) { lastError = error; }
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}${lastError ? ` (${String(lastError)})` : ''}`);
    await sleep(200);
  }
}
/** Polls the desktop's side. */
async function until<T>(label: string, read: () => Promise<T | false | null | undefined> | T | false | null | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(250);
  }
}
const exists = (selector: string): string => `!!document.querySelector(${JSON.stringify(selector)})`;
const textOf = (selector: string): Promise<string> => evaluateWebView<string>(
  `(function () { var nodes = document.querySelectorAll(${JSON.stringify(selector)}); return nodes.length ? nodes[nodes.length - 1].textContent : ''; })()`);
const textContains = (selector: string, words: string): string => `(function () { var nodes = document.querySelectorAll(${JSON.stringify(selector)}); return nodes.length > 0 && nodes[nodes.length - 1].textContent.indexOf(${JSON.stringify(words)}) >= 0; })()`;
const count = (selector: string): Promise<number> => evaluateWebView<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
/** Moves only the nearest scroller: `scrollIntoView` also shifts the app's `overflow: hidden` shell, which no finger can do. */
const REVEAL = `function reveal(element, block) {
  var scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) return;
  var box = element.getBoundingClientRect(); var frame = scroller.getBoundingClientRect();
  scroller.scrollTop += block === 'center' ? box.top - frame.top - (frame.height - box.height) / 2
    : block === 'end' ? box.bottom - frame.bottom + 12 : box.top - frame.top - 12;
}
function lastVisible(selector) {
  var nodes = document.querySelectorAll(selector);
  for (var index = nodes.length - 1; index >= 0; index -= 1) {
    var box = nodes[index].getBoundingClientRect(); if (box.width > 0 && box.height > 0) return nodes[index];
  }
  return null;
}`;
async function scrollIntoView(selector: string, block = 'start'): Promise<void> {
  await waitFor(exists(selector), selector);
  await evaluateWebView(`(function () { ${REVEAL} reveal(lastVisible(${JSON.stringify(selector)}), ${JSON.stringify(block)}); return true; })()`);
  await sleep(300);
}
async function measure(label: string, selector: string): Promise<void> {
  const size = await evaluateWebView<{ width: number; height: number } | null>(`(function () {
    ${REVEAL}
    var node = lastVisible(${JSON.stringify(selector)}); if (!node) return null;
    var rect = node.getBoundingClientRect(); return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
  })()`);
  if (!size) throw new Error(`${label} (${selector}) is not on screen to measure`);
  targets.push({ label, ...size });
}

interface TapGeometry {
  readonly x: number; readonly y: number; readonly viewportWidth: number; readonly viewportHeight: number;
  readonly devicePixelRatio: number; readonly onTop: boolean; readonly disabled: boolean;
}
/** One native tap on the last visible element `selector` matches, held still, enabled and on top at its centre. */
async function tapOnce(selector: string, label: string): Promise<void> {
  const probe = `(function () {
    ${REVEAL}
    var element = lastVisible(${JSON.stringify(selector)});
    if (!element) return null;
    reveal(element, 'center');
    var rect = element.getBoundingClientRect(); var x = rect.left + rect.width / 2; var y = rect.top + rect.height / 2;
    var top = document.elementFromPoint(x, y);
    return { x: x, y: y, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      onTop: !!top && (top === element || element.contains(top)), disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true' };
  })()`;
  const deadline = Date.now() + 20_000;
  let previous = '';
  let unmoved = 0;
  for (;;) {
    const geometry = await evaluateWebView<TapGeometry | null>(probe);
    const signature = JSON.stringify(geometry);
    unmoved = signature === previous ? unmoved + 1 : 0;
    if (geometry && geometry.onTop && !geometry.disabled && unmoved >= 3) {
      const bounds = parseWebViewDeviceBounds(runAdb(['shell', 'dumpsys', 'activity', APP_ID]), geometry);
      if (bounds) { await shortPressOnce(mapWebViewPointToDevice(geometry, bounds, geometry)); return; }
    }
    if (Date.now() > deadline) throw new Error(`${label} did not settle as a tap target: ${signature}`);
    previous = signature;
    await sleep(250);
  }
}

/** No control on this screen answers an approval: by its mark, or a button that reads like one. */
async function assertNoAnswer(where: string): Promise<void> {
  const found = await evaluateWebView<readonly string[]>(`(function () {
    var marks = ${JSON.stringify(ANSWER_CONTROLS)}; var found = [];
    marks.forEach(function (mark) { if (document.querySelector(mark)) found.push(mark); });
    var buttons = document.querySelectorAll('button, [role="button"], a');
    for (var index = 0; index < buttons.length; index += 1) {
      var words = (buttons[index].textContent || '').trim();
      // Whole answers only: the access pill reads 승인 후 실행 and answers nothing.
      if (/^(허용|승인|거부|Allow|Approve|Deny)$|허용$|^Allow /.test(words)) found.push('button "' + words + '"');
    }
    return found;
  })()`);
  assert.deepEqual(found, [], `${where}: a control that answers`);
}

async function chooseTheme(): Promise<void> {
  if (THEME === 'matrix') return;
  await openShellDestination('more-theme', 'theme-menu');
  await tapTestId(`theme-option-${THEME}`);
  await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(THEME)}`, `the ${THEME} theme`);
  await waitForTestIdHidden('theme-menu');
}
async function chooseKorean(): Promise<void> {
  await openShellDestination('more-settings', 'mobile-settings-view');
  await tapTestId('settings-category-general');
  await waitForTestId('settings-language');
  await evaluateWebView(`(function () {
    var select = document.querySelector('[data-testid="settings-language"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'ko');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`document.documentElement.lang === 'ko'`, 'the Korean UI');
}
async function draftIn(workspaceId: string, firstMessage: string): Promise<void> {
  await waitForTestId('conversation-start');
  const folderSelect = '[data-testid="conversation-start"] select[aria-label="대화 작업 위치"]';
  await waitFor(`!!document.querySelector(${JSON.stringify(`${folderSelect}:not(:disabled) option[value="${workspaceId}"]`)})`, 'the project in 작업 위치');
  // A choice made before the draft's secure recovery has loaded is dropped without a word: chosen again until it holds.
  const deadline = Date.now() + 30_000;
  for (;;) {
    await evaluateWebView(`(function () {
      var select = document.querySelector(${JSON.stringify(folderSelect)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(workspaceId)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(1_500);
    if (await evaluateWebView<boolean>(`document.querySelector(${JSON.stringify(folderSelect)}).value === ${JSON.stringify(workspaceId)}`)) break;
    if (Date.now() > deadline) throw new Error('The project was never chosen as 작업 위치');
  }
  await setTestIdTextValue('structured-agent-composer-input', firstMessage);
  await waitFor(`(document.querySelector(${JSON.stringify(SEND)}) || {}).disabled === false`, 'first Send ready');
  await tapTestIdOnce('structured-agent-send');
  await waitForTestIdHidden('conversation-start', 60_000);
  await waitForTestId('structured-agent-session');
}
async function sendFromPhone(text: string): Promise<void> {
  await setTestIdTextValue('structured-agent-composer-input', text);
  await waitFor(`(document.querySelector(${JSON.stringify(SEND)}) || {}).disabled === false`, 'Send ready');
  await tapTestIdOnce('structured-agent-send');
  await waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).value === ''`, 'the box emptied by the send');
}

// ── What the phone receives ──────────────────────────────────────────────────────────────────────────────────────────

/** Words searched for in every message, at the point the app reads it. */
const NEEDLES = [TYPED, encodeURIComponent(TYPED), 'browser-action:', '/checkout'];
interface Watch {
  readonly installedAt: number;
  readonly messages: number;
  readonly chars: number;
  readonly binary: number;
  readonly hits: Readonly<Record<string, number>>;
  readonly excerpts: readonly string[];
}
/**
 * Every message the app reads from a WebSocket, sockets already open included: `MessageEvent.prototype.data` is where the
 * transport's handler reads each frame, so this sees what the app receives, decoded, and nothing is held back to say so.
 */
async function watchMessages(): Promise<void> {
  await evaluateWebView(`(function () {
    if (window.__browserWatch) return true;
    var needles = ${JSON.stringify(NEEDLES)};
    var watch = { installedAt: Date.now(), messages: 0, chars: 0, binary: 0, hits: {}, excerpts: [] };
    needles.forEach(function (needle) { watch.hits[needle] = 0; });
    var seen = new WeakSet();
    var data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, enumerable: data.enumerable, get: function () {
      var value = data.get.call(this);
      if (this.target instanceof WebSocket && !seen.has(this)) {
        seen.add(this);
        watch.messages += 1;
        var text = typeof value === 'string' ? value : '';
        if (typeof value !== 'string') {
          watch.binary += 1;
          if (value instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(value));
        }
        watch.chars += text.length;
        needles.forEach(function (needle) {
          var at = text.indexOf(needle);
          if (at < 0) return;
          watch.hits[needle] += 1;
          if (watch.excerpts.length < 60) watch.excerpts.push(needle + ' :: ' + text.slice(Math.max(0, at - 200), at + 60));
        });
      }
      return value;
    } });
    window.__browserWatch = watch;
    return true;
  })()`);
}
const watched = (): Promise<Watch> => evaluateWebView<Watch>('window.__browserWatch');

/** The phone's own stores: the page, its storage, and the secure store read back through the app's plugin. */
async function phoneStores(): Promise<{ readonly found: readonly string[]; readonly secureKeys: number; readonly local: number; readonly session: number; readonly databases: readonly string[] }> {
  return evaluateWebView(`(function () {
    var needle = ${JSON.stringify(TYPED)}; var found = [];
    var scan = function (where, text) { if (typeof text === 'string' && text.indexOf(needle) >= 0) found.push(where); };
    scan('page', document.documentElement.outerHTML);
    var index;
    for (index = 0; index < localStorage.length; index += 1) scan('localStorage:' + localStorage.key(index), localStorage.getItem(localStorage.key(index)));
    for (index = 0; index < sessionStorage.length; index += 1) scan('sessionStorage:' + sessionStorage.key(index), sessionStorage.getItem(sessionStorage.key(index)));
    var databases = indexedDB.databases ? indexedDB.databases().then(function (list) { return list.map(function (entry) { return entry.name; }); }) : Promise.resolve([]);
    var plugin = window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins.SecureStoragePlugin : null;
    if (!plugin) throw new Error('No secure store plugin to read back');
    return plugin.keys().then(function (result) {
      var keys = result.value || [];
      return Promise.all(keys.map(function (key) {
        return plugin.get({ key: key }).then(function (entry) { scan('secure:' + key, entry.value); }, function () { found.push('secure unreadable: ' + key); });
      })).then(function () { return databases; }).then(function (names) {
        return { found: found, secureKeys: keys.length, local: localStorage.length, session: sessionStorage.length, databases: names };
      });
    });
  })()`);
}

// ── The stub site and the host ───────────────────────────────────────────────────────────────────────────────────────

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:24px}label,input,button{display:block;margin:10px 0;font:inherit}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}
interface Hit { readonly host: string; readonly path: string; readonly method: string; readonly body: string }
async function startSite(): Promise<{ readonly origin: string; readonly hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const pages: Record<string, string> = {
    '/checkout': page('결제', '<p>주문 금액 32,000원</p><form method="post" action="/applied"><label>쿠폰 코드 <input name="coupon" aria-label="쿠폰 코드" autocomplete="off"></label><button>쿠폰 적용</button></form>'),
    '/applied': page('쿠폰 적용됨', '<p>쿠폰을 적용했습니다.</p>'),
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      hits.push({ host: (request.headers.host ?? '').split(':')[0]!, path: url.pathname, method: request.method ?? 'GET', body: Buffer.concat(chunks).toString('utf8') });
      const body = pages[url.pathname];
      response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(body ?? page('없음', ''));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return { origin: `http://${SITE_NAME}:${String(port)}`, hits, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A local copy of the e2e fake Codex whose words carry no test marker: its answer file closes a browser turn, and its model is "GPT 5.6". */
function prepareFakeCodex(target: string): void {
  const source = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(source, 'codex.cmd'), path.join(target, 'codex.cmd'));
  let code = readFileSync(path.join(source, 'codex-fixture.js'), 'utf8');
  for (const [from, to] of [
    ['browsed = `Browser script ${browserScript} ran.`;', "browsed = controlText('ezterminal-e2e-codex-answer.txt', '');"],
    ["displayName: 'GPT 5.6 Fixture',", "displayName: 'GPT 5.6',"],
  ] as const) {
    assert.equal(code.split(from).length, 2, `the fake Codex changed: ${from}`);
    code = code.replace(from, () => to);
  }
  writeFileSync(path.join(target, 'codex-fixture.js'), code);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}
function seedProject(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '--initial-branch=main', '--quiet');
  git(root, 'config', 'user.name', 'Browser Rows E2E');
  git(root, 'config', 'user.email', 'browser-rows-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), '# Cart kit\n');
  writeFileSync(path.join(root, 'src', 'cart.ts'), 'export const cartTotal = (prices: number[]): number => prices.reduce((sum, price) => sum + price, 0);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Baseline');
}

type Desktop = Awaited<ReturnType<typeof launchDesktop>>;
type HostWindow = Desktop['window'];
let commandSequence = 0;
/** A command from the desktop's person; the receipt as it came. */
async function hostReceipt(host: HostWindow, type: string, payload: unknown): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }> {
  for (let attempt = 0; ; attempt += 1) {
    commandSequence += 1;
    const receipt = await host.evaluate(async (input) => {
      const state = await window.ezterminal.getDaemonSnapshot();
      if (!state) throw new Error('Missing snapshot');
      return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId: input.id, idempotencyKey: input.id, expectedRevision: state.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'browser-rows-journey' }, type: input.type, payload: input.payload } as never);
    }, { id: `mobile-browser-rows-command-${String(commandSequence)}`, type, payload });
    if (receipt.ok || receipt.error.code !== 'revision-conflict' || attempt === 7) return receipt;
    await sleep(100);
  }
}
async function hostCommand(host: HostWindow, type: string, payload: unknown): Promise<void> {
  const receipt = await hostReceipt(host, type, payload);
  assert.ok(receipt.ok, JSON.stringify(receipt));
}
/** An answer the phone sends as itself, through the app's own transport. */
async function phoneAnswer(approvalId: string): Promise<{ readonly ok: boolean; readonly code?: string; readonly message?: string }> {
  return evaluateWebView(`(function () {
    return window.ezterminal.getDaemonSnapshot().then(function (state) {
      var id = 'browser-rows-phone-answer-' + Date.now();
      return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId: id, idempotencyKey: id, expectedRevision: state.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'android', id: 'mobile-agent-ui' }, type: 'permission.resolve',
        payload: { approvalId: ${JSON.stringify(approvalId)}, decision: 'allow' } });
    }).then(function (receipt) { return receipt.ok ? { ok: true } : { ok: false, code: receipt.error.code, message: receipt.error.message }; });
  })()`);
}

/** Before the first view: the partition's guards read these when they install, and on every request (as e2e/in-app-browser.spec.ts). */
async function standInForPublicDns(desktop: Desktop): Promise<void> {
  await desktop.evaluateMain(({ session }, { partition, names, address }) => {
    const site = session.fromPartition(partition);
    const resolveHost = site.resolveHost.bind(site);
    site.resolveHost = ((host: string, options: unknown) => (names.includes(host)
      ? Promise.resolve({ endpoints: [{ address, family: 'ipv4' }] })
      : (resolveHost as (name: string, value: unknown) => unknown)(host, options))) as typeof site.resolveHost;
    const requests = site.webRequest;
    const onResponseStarted = requests.onResponseStarted.bind(requests) as (filter: unknown, listener: (details: { readonly url: string }) => void) => void;
    requests.onResponseStarted = ((filter: unknown, listener: (details: { readonly url: string }) => void) => onResponseStarted(filter, (details) => {
      listener(names.includes(new URL(details.url).hostname) ? { ...details, ip: address } as typeof details : details);
    })) as typeof requests.onResponseStarted;
  }, { partition: BROWSER_PARTITION, names: [SITE_NAME], address: PUBLIC_ADDRESS });
}
/** The approval's 240 s, and nothing else: a row and a screen still say 240 s, only the clock that ends it is short. */
async function shortenHold(desktop: Desktop, toMs: number): Promise<void> {
  await desktop.evaluateMain((_electron, { from, to }) => {
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => real(callback, ms === from ? to : ms, ...rest as [])) as typeof setTimeout;
  }, { from: HOLD_MS, to: toMs });
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-browser-rows-');
  const root = path.join(fixture, 'cart-kit');
  // The fake Codex's control files (its version, its answer, its browser scripts, what it called) live in its TMPDIR.
  const control = path.join(fixture, 'codex-control');
  for (const directory of [root, control]) mkdirSync(directory, { recursive: true });
  seedProject(root);
  writeFileSync(path.join(control, 'ezterminal-e2e-codex-version.txt'), BROWSER_CODEX_VERSION, 'utf8');
  const controlFile = (name: string): string => path.join(control, `ezterminal-e2e-codex-${name}`);
  const fakeCodex = path.resolve(import.meta.dirname, '../../artifacts/in-app-browser/android/fake-codex');
  prepareFakeCodex(fakeCodex);
  const calls = (script: string): readonly Record<string, unknown>[] => {
    const file = controlFile('browser-calls.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.script === script) : [];
  };
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const site = await startSite();
  let desktop: Desktop | undefined;
  try {
    // 360×800 on either AVD, before the app starts: a new density would otherwise restart its activity.
    runAdb(['shell', 'wm', 'size', '1080x2400']);
    runAdb(['shell', 'wm', 'density', '480']);
    const hostEnvironment = { [pathKey]: `${fakeCodex}${path.delimiter}${process.env[pathKey] ?? ''}`, USERPROFILE: fixture, HOME: fixture, TMPDIR: control };
    desktop = await launchDesktop({ env: hostEnvironment, args: [RESOLVER_RULES] });
    await standInForPublicDns(desktop);
    const host = desktop.window;
    const snapshot = () => host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const saved = await host.evaluate((project) => window.ezterminal.saveAgentProject({ name: 'cart-kit', primaryRoot: project, additionalRoots: [], pinned: true }), root);
    assert.ok(saved.ok, JSON.stringify(saved));
    const workspaceId = await until('the project on the desktop', async () => (await snapshot())?.workspaces.find((entry) => path.basename(entry.rootPath).toLowerCase() === 'cart-kit')?.id, 15_000);
    const inspection = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    assert.ok(inspection.ok, JSON.stringify(inspection));
    // Never a real provider: the deterministic fixture only, at the version the browser tools start at.
    assert.ok(path.resolve(inspection.value.probe.executablePath).toLowerCase().startsWith(fakeCodex.toLowerCase()), `expected the fake codex, found ${inspection.value.probe.executablePath}`);
    assert.equal(inspection.value.probe.executableVersion, BROWSER_CODEX_VERSION);
    const { probe, reviewDigest } = inspection.value;
    await hostCommand(host, 'provider.enable', { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
      executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest });
    await host.evaluate(() => window.ezterminalDesktop!.setBrowserSettings({ enabled: true, autoCheck: false }));
    await until('the browser on, with its capability, for Codex', async () => {
      const state = await snapshot();
      return state?.runtime.browserEnabled === true && state.capabilities?.includes('in-app-browser-v1') && state.browserSupport?.codex === true;
    }, 30_000);
    writeFileSync(controlFile('answer.txt'), '결제 페이지를 볼 준비가 됐습니다.');

    await connectAndAuth(desktop.token);
    await chooseKorean();
    await chooseTheme();
    await watchMessages();
    const transcript = (sessionId: string) => host.evaluate((id) => window.ezterminal.getDaemonTranscript(id, 0, 500), sessionId);
    const nothingRuns = (sessionId: string, label: string): Promise<boolean> => until(label, async () => {
      const state = await snapshot();
      const agent = state?.agents.find((entry) => entry.sessionId === sessionId);
      return Boolean(agent) && !agent?.currentTurnId && agent?.queuedTurnCount === 0;
    }, 60_000);
    const pendingBrowserAction = (sessionId: string) => until('a browser action waiting on the desktop', async () => (await snapshot())?.approvals.find((entry) => entry.sessionId === sessionId
      && entry.state === 'pending' && String(entry.providerRequestId).startsWith('browser-action:')), 30_000);

    // ── A Codex conversation from the phone, on a site the person allowed ───────────────────────────────────────────
    await openConversationList();
    await tapTestId('mobile-agent-new-session');
    const known = (await snapshot())?.agents.map((entry) => entry.sessionId) ?? [];
    await draftIn(workspaceId, '결제 페이지를 함께 봐 주세요.');
    const sessionId = await until('the conversation on the host', async () => (await snapshot())?.agents.find((entry) => !known.includes(entry.sessionId) && entry.providerSessionId)?.sessionId);
    await nothingRuns(sessionId, 'the first turn');
    const agent = (await snapshot())!.agents.find((entry) => entry.sessionId === sessionId)!;
    if (agent.permissionPreset !== 'standard') await hostCommand(host, 'agent.set-settings', { sessionId, permissionPreset: 'standard', scope: 'keep' });
    const projectId = (await snapshot())!.sessions.find((entry) => entry.id === sessionId)!.projectId;
    await hostCommand(host, 'browser.site', { projectId, origin: site.origin, action: 'allow' });
    checks.push(`a Codex conversation from the phone, in Korean, in ${THEME}, standard; ${SITE_NAME} allowed on the desktop for the project`);

    // ── 1. A typed value with Enter waits on the desktop; the phone cannot answer it ────────────────────────────────
    const steps = [
      { name: 'browser_navigate', arguments: { url: `${site.origin}/checkout` } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: '쿠폰 코드', arguments: { text: TYPED, submit: true } },
    ];
    writeFileSync(controlFile('browser-coupon.json'), JSON.stringify(steps));
    writeFileSync(controlFile('answer.txt'), '데스크톱에서 거절되어 쿠폰 코드를 넣지 않았습니다.');
    writeFileSync(controlFile('next-marker.txt'), 'EZTERMINAL_E2E_BROWSER:coupon');
    await sendFromPhone('결제 페이지에 쿠폰 코드를 넣고 적용해 주세요.');
    // Standard asks for every action on an outside site, the way there first: the phone says so and leaves it to the desktop.
    const navigation = await pendingBrowserAction(sessionId);
    assert.equal((navigation.request as { toolName?: string } | undefined)?.toolName, 'browser_navigate');
    await waitFor(textContains(WAITING_ROW, `${site.origin}에서 페이지 이동`), 'the navigation waiting on the phone');
    await assertNoAnswer('the conversation, a navigation waiting');
    await scrollIntoView(WAITING_ROW, 'end');
    await capture('00-waiting-navigation', true);
    await hostCommand(host, 'permission.resolve', { approvalId: navigation.id, decision: 'allow' });
    checks.push('standard asks first for the way to the outside site: the phone shows 페이지 이동 waiting on the desktop, with no control to answer, and the desktop allows it');
    const first = await until('the typed action waiting on the desktop', async () => (await snapshot())?.approvals.find((entry) => entry.sessionId === sessionId
      && entry.state === 'pending' && (entry.request as { toolName?: string } | undefined)?.toolName === 'browser_type'), 30_000);
    const held = JSON.parse(String((first.request as { input?: unknown } | undefined)?.input)) as { value?: string; submit?: boolean };
    assert.equal(held.value, TYPED, 'the desktop holds the value it would type');
    assert.equal(held.submit, true, 'the desktop holds the Enter after it');
    const raisedAt = Date.now();
    await waitFor(exists(WAITING_ROW), 'the waiting row on the phone');
    await waitFor(textContains(WAITING_ROW, '데스크톱에서 승인 대기'), 'the row says who it waits on');
    await waitFor(textContains(WAITING_ROW, `${site.origin}에서 입력`), 'the row names the site and the action');
    await waitFor(textContains(WAITING_ROW, '폰에서는 답할 수 없습니다.'), 'the row says the phone cannot answer');
    const note = await textOf(`${WAITING_ROW} .chat-browser-waiting__note`);
    assert.match(note, /\d{1,2}:\d{2}.*까지 데스크톱에서 답이 없으면 이 조작은 실행되지 않고 시간 초과로 끝납니다\./u, 'the row says until when');
    facts.waitingRow = await textOf(WAITING_ROW);
    // The story's box says 데스크톱에서 답을 기다립니다. With a Codex that steers, the send button's own words come first and
    // say a message goes in after the answer; either way the box offers no way to answer here.
    const hint = await textOf(HINT);
    facts.composerHint = hint;
    assert.ok(['데스크톱에서 답을 기다립니다', '보내기로 끼워넣기 · 승인에 답한 뒤 들어갑니다'].includes(hint), `the box says: ${hint}`);
    assert.ok(!(await textOf(WAITING_ROW)).includes(TYPED), 'the row shows the value');
    await assertNoAnswer('the conversation');
    await waitFor(exists(RUN_ROW), 'the browser run row');
    await scrollIntoView(WAITING_ROW, 'end');
    await capture('01-waiting-row', true);

    const tried = await phoneAnswer(first.id);
    assert.equal(tried.ok, false, `the host took the phone's answer: ${JSON.stringify(tried)}`);
    facts.phoneAnswerWhilePending = tried;
    await sleep(1_000);
    assert.equal((await snapshot())?.approvals.find((entry) => entry.id === first.id)?.state, 'pending', 'the phone\'s answer moved the approval');
    assert.equal(calls('coupon').filter((entry) => entry.tool === 'browser_type').length, 0, 'the type ran on the phone\'s answer');
    checks.push(`a browser_type with Enter on an allowed outside site waits on the desktop (the host holds the value and the Enter); the phone's row says 데스크톱에서 승인 대기, the site and 입력, until when, and that the phone cannot answer; no dock, no allow control; the box offers no answer (it says "${hint}"); an answer the phone sends anyway is refused (${String(tried.code)}) and the approval stays pending`);

    await tapOnce(BACK, '뒤로');
    await openFeed();
    await waitFor(exists(FEED_CARD), 'the feed card');
    await waitFor(textContains(FEED_CARD, '데스크톱에서 승인 대기'), 'the feed card says who answers');
    await waitFor(textContains(FEED_CARD, '폰에서는 답할 수 없습니다.'), 'the feed card says the phone cannot answer');
    assert.equal(await count(FEED_CARD), 1, 'one waiting card');
    assert.equal(await evaluateWebView<string>(`document.querySelector(${JSON.stringify(FEED_CARD)}).tagName`), 'BUTTON', 'the card is one button that opens the conversation');
    await assertNoAnswer('the feed (나를 기다리는 것)');
    await measure('피드: 나를 기다리는 것 카드', FEED_CARD);
    await capture('02-feed-waiting', true);

    await openConversationList();
    await sleep(800);
    await assertNoAnswer('the conversation list');
    await capture('03-list');
    checks.push('the feed\'s 나를 기다리는 것 card says 데스크톱에서 승인 대기 and 폰에서는 답할 수 없습니다 and only opens the conversation; the list has no answer control either');

    await openFeed();
    await tapOnce(FEED_CARD, '나를 기다리는 것 카드');
    await waitFor(`!!document.querySelector('[data-testid="structured-agent-session"][data-session-id="${sessionId}"]')`, 'the card opens its conversation');
    await waitFor(exists(WAITING_ROW), 'the waiting row again');
    await assertNoAnswer('the conversation, opened from the feed');
    assert.ok(Date.now() - raisedAt < HOLD_MS - 20_000, 'the checks ran into the real 240 s');

    // The desktop's person answers.
    await hostCommand(host, 'permission.resolve', { approvalId: first.id, decision: 'deny' });
    await waitFor(`!(${exists(WAITING_ROW)})`, 'the waiting row gone after the desktop\'s answer');
    await waitFor(textContains(BLOCKED_ROW, '사람이 거절했습니다.'), 'the refused row');
    await nothingRuns(sessionId, 'the declined turn over');
    assert.equal(calls('coupon').find((entry) => entry.tool === 'browser_type')?.code, 'approval-declined');
    await scrollIntoView(BLOCKED_ROW, 'end');
    await capture('04-declined', true);
    checks.push('the desktop\'s 거부 ends it: the waiting row goes, a refused row says 사람이 거절했습니다, the tool was refused approval-declined');

    // ── 2. Nobody answers in 240 s (on a short clock) ─────────────────────────────────────────────────────────────────
    await shortenHold(desktop, SHORT_HOLD_MS);
    // The page is still the checkout: no way there to ask about, so the one approval is the typed value's.
    writeFileSync(controlFile('browser-coupon-late.json'), JSON.stringify(steps.slice(1)));
    writeFileSync(controlFile('answer.txt'), '데스크톱에서 답이 없어 쿠폰 코드를 넣지 않았습니다.');
    writeFileSync(controlFile('next-marker.txt'), 'EZTERMINAL_E2E_BROWSER:coupon-late');
    await sendFromPhone('쿠폰 코드를 한 번 더 넣어 주세요.');
    const second = await pendingBrowserAction(sessionId);
    assert.equal((second.request as { toolName?: string } | undefined)?.toolName, 'browser_type');
    await waitFor(textContains(WAITING_ROW, `${site.origin}에서 입력`), 'the second waiting row');
    await assertNoAnswer('the conversation, second action');
    await scrollIntoView(WAITING_ROW, 'end');
    await capture('05-waiting-again');
    await until('the approval expired on the desktop', async () => (await snapshot())?.approvals.find((entry) => entry.id === second.id)?.state === 'expired', SHORT_HOLD_MS + 30_000);
    await waitFor(`!(${exists(WAITING_ROW)})`, 'the waiting row gone at the expiry');
    await waitFor(textContains(BLOCKED_ROW, '데스크톱에서 답이 없어 시간 초과로 끝났습니다.'), 'the expiry row on the phone');
    await nothingRuns(sessionId, 'the expired turn over');
    assert.equal(calls('coupon-late').find((entry) => entry.tool === 'browser_type')?.code, 'approval-timeout');
    await assertNoAnswer('the conversation, after the expiry');
    // To the newest row, as a person reading it would be: short of it, the jump button sits on the row.
    await evaluateWebView(`(function () { var all = document.querySelectorAll('.chat-viewport__scroll'); var scroller = all[all.length - 1]; scroller.scrollTop = scroller.scrollHeight; return true; })()`);
    await sleep(800);
    await waitFor(`(function () {
      ${REVEAL}
      var row = lastVisible(${JSON.stringify(BLOCKED_ROW)}); if (!row) return false;
      var box = row.getBoundingClientRect(); var top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!top && row.contains(top);
    })()`, 'the expiry row in view, nothing on it');
    await capture('06-expired', true);
    const lateDesktop = await hostReceipt(host, 'permission.resolve', { approvalId: second.id, decision: 'allow' });
    const latePhone = await phoneAnswer(second.id);
    assert.equal(lateDesktop.ok, false, 'a late desktop answer was taken');
    assert.equal(latePhone.ok, false, 'a late phone answer was taken');
    facts.lateAnswers = { desktop: lateDesktop.error, phone: latePhone };
    assert.deepEqual(site.hits.filter((hit) => hit.method === 'POST'), [], 'something was sent to the site');
    checks.push(`nobody answers (240 s on a ${String(SHORT_HOLD_MS / 1_000)} s clock): the approval expires, the waiting row goes, a row says 데스크톱에서 답이 없어 시간 초과로 끝났습니다, the tool was refused approval-timeout; a late answer is refused from the desktop (${String(lateDesktop.error?.code)}) and the phone (${String(latePhone.code)}); the site got no POST`);

    // ── 3. Nothing the phone received holds the typed value ──────────────────────────────────────────────────────────
    const watch = await watched();
    assert.ok(watch && watch.messages > 0, 'the watch saw no message');
    facts.watch = watch;
    assert.ok(watch.hits['browser-action:']! > 0, 'the approvals never reached the phone, so the watch proves nothing');
    assert.equal(watch.hits[TYPED], 0, `the typed value reached the phone: ${watch.excerpts.filter((line) => line.startsWith(TYPED)).join('\n')}`);
    assert.equal(watch.hits[encodeURIComponent(TYPED)], 0, 'the typed value reached the phone, encoded');
    const stores = await phoneStores();
    facts.stores = stores;
    assert.deepEqual(stores.found, [], 'the typed value is in the phone\'s page or stores');
    const files = runAdb(['shell', `run-as ${APP_ID} sh -c 'grep -rl ${TYPED} . 2>/dev/null; true'`]).trim();
    assert.equal(files, '', `the typed value is in the app's files: ${files}`);
    const logged = runAdb(['logcat', '-d']).includes(TYPED);
    assert.equal(logged, false, 'the typed value is in the phone\'s log');
    const rows = await transcript(sessionId);
    facts.desktopRowsWithValue = rows.filter((row) => row.text.includes(TYPED) || JSON.stringify(row.payload ?? {}).includes(TYPED)).map((row) => `${row.kind}${row.isSensitive ? ' (sensitive)' : ''}`);
    checks.push(`nothing the phone received holds the typed value: ${String(watch.messages)} socket messages (${String(watch.chars)} characters, ${String(watch.binary)} binary) read at the app's receive point since the start of the conversation, ${String(watch.hits['browser-action:'])} of them carrying the browser approvals; the page, ${String(stores.local)} localStorage and ${String(stores.session)} sessionStorage entries, ${String(stores.secureKeys)} secure-store entries read back through the app's plugin, the app's files raw and the log`);

    const environment = await evaluateWebView<{ readonly userAgent: string; readonly lang: string; readonly theme: string | undefined; readonly viewport: string }>(`({
      userAgent: navigator.userAgent, lang: document.documentElement.lang, theme: document.documentElement.dataset.theme, viewport: window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio })`);
    assert.equal(environment.theme, THEME);
    assert.match(environment.viewport, /^360x/u, 'the phone is 360 px wide');
    const small = targets.filter((target) => target.width < 44 || target.height < 44);
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({
      ok: small.length === 0, androidApi, provider: 'deterministic Codex fixture', environment, site: site.origin, checks, facts, touchTargets: targets, screenshots: shots,
    }, null, 2));
    assert.deepEqual(small, [], `touch targets under 44px: ${JSON.stringify(small)}`);
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${text}`);
    if (desktop) await writeFile(path.join(artifacts, 'failure-snapshot.json'), JSON.stringify(await desktop.window.evaluate(() => window.ezterminal.getDaemonSnapshot()), null, 2)).catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure-facts.json'), JSON.stringify({ checks, facts, calls: existsSync(controlFile('browser-calls.jsonl')) ? readFileSync(controlFile('browser-calls.jsonl'), 'utf8') : '' }, null, 2)).catch(() => undefined);
    throw error;
  } finally {
    runAdb(['shell', 'wm', 'size', 'reset']);
    runAdb(['shell', 'wm', 'density', 'reset']);
    await desktop?.dispose();
    await site.close();
    closeMobileE2eResources();
    await registry.disposeAll();
  }
}
await main();
