/**
 * Long-run continuity (`long-run-v1`) on a real Android device against an isolated desktop and the deterministic Codex
 * fixture, in Korean, at 360×800 (`wm size` and `wm density`, put back at the end). The send button while a turn runs puts
 * plain text into it: the tray on its way, behind an approval, failed and caught by a limit, and the landed row. What cannot
 * go in waits in the queue and says why: a turn that refuses it, and an attachment. The limit card: waiting, 지금 시도,
 * 자동 재개 끄기 and 다시 켜기, the asks-first states with their buttons, 이어서 하기 from the phone and the app-sent row, the
 * chain of three that then asks, a plan that does not include the AI. The list and the header say the state; only a card
 * that asks takes the amber and a place in 나를 기다리는 것. A phone just watching sees the card move when the host sends
 * "Continue.". Long words at 360 px, every control at 44 px, the tray's height cap with the keyboard open, spacing and
 * colours on the WebView in use. A screenshot at each step.
 *
 * `--old-host=<built checkout>` instead runs this app against a desktop from before the feature: the conversation works,
 * Send queues behind a running turn, a limit is the error it always was, and the phone sends nothing that host would refuse.
 *
 * Run: node --experimental-strip-types mobile/e2e/long-run-journey.ts [--theme=matrix|dark] [--old-host=<dir>]
 * (fresh debug APK and desktop build first).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APP_ID, closeMobileE2eResources, connectAndAuth, evaluateWebView, launchDesktop, mapWebViewPointToDevice, openConversationList, openFeed, openShellDestination,
  parseWebViewDeviceBounds, runAdb, runAdbBinary, setTestIdTextValue, shortPressOnce, sleep, tapTestId, tapTestIdOnce, waitForTestId, waitForTestIdHidden,
} from './lib.ts';

const argument = (name: string): string | undefined => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const THEME = argument('theme') ?? 'matrix';
const OLD_HOST = argument('old-host');
const androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
const artifacts = process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR
  ? path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, `../../artifacts/long-run/android/api${androidApi}-${OLD_HOST ? 'old-host' : THEME}`);
/** The oldest Codex long-run continuity runs on (CODEX_LONG_RUN_MINIMUM_VERSION). */
const LONG_RUN_CODEX_VERSION = '0.165.0';
/** What only a spec shortens: the app's waits are minutes. */
const TIMING = { afterResetMs: 2_000, retryAfterRefusalMs: 4_000, lineGapMs: 1_000 };
const HOUR = 3_600;
/** What a running Electron holds open and nothing here needs: the daemon's store and the keys are outside these. */
const CHROMIUM_LEFTOVERS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Network', 'Session Storage', 'Shared Dictionary', 'blob_storage', 'Crashpad', 'lockfile']);

const LONG_PATH = 'src/features/checkout/pricing/discounts/implementations/percentage/applyPercentageDiscountToCartTotalBeforeTaxCalculation.ts';
const LONG_WORD = 'discountCalculationResultCacheInvalidationCoordinatorFactoryProviderConfigurationRegistryImplementation';
const LONG_MESSAGE = `${LONG_PATH} 파일만 고치고 ${LONG_WORD} 는 건드리지 마세요. 끝나면 어떤 테스트를 돌렸는지 한 줄로 알려 주세요.`;

// ── The phone ────────────────────────────────────────────────────────────────────────────────────────────────────────

const COMPOSER = '[data-testid="structured-agent-composer-input"]';
const SEND = '[data-testid="structured-agent-send"]';
const STOP = '[data-testid="structured-agent-stop"]';
const HINT = '[data-testid="structured-agent-composer-hint"]';
const TRAY = '[data-testid="chat-steer-tray"]';
const TRAY_MESSAGE = '[data-testid="chat-steer-message"]';
const TRAY_LIST = '.chat-steer__list';
const TRAY_TOGGLE = '[data-testid="chat-steer-toggle"]';
const TRAY_LINE = '[data-testid="chat-steer-line"]';
const LANDED = '[data-testid="chat-steer-landed"]';
const TO_BOX = '[data-testid="chat-steer-to-box"]';
const TO_QUEUE = '[data-testid="chat-steer-to-queue"]';
const ANNOUNCE = '[data-testid="chat-steer-announce"]';
const FALLBACK = '[data-testid="chat-queue-fallback"]';
const CARD = '[data-testid="chat-usage-limit-card"]';
const APP_SENT = '[data-testid="chat-app-sent"]';
const HEADER_STATE = '.structured-agent-session-header__status .structured-agent-state';
const DOCK_ALLOW = '[data-dock-primary]';
const WAITING = '[data-testid="mobile-feed-waiting"]';
const limitButton = (action: string): string => `[data-testid="chat-limit-limit-${action}"]`;
const feedRow = (sessionId: string): string => `[data-testid="mobile-feed-conversation"][data-session="${sessionId}"]`;
const onScreen = (sessionId: string): string => `[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`;

const shots: string[] = [];
const targets: { readonly label: string; readonly width: number; readonly height: number }[] = [];
const checks: string[] = [];
const spacing: Record<string, number | null> = {};
const colours: Record<string, Record<string, string>> = {};
const stateWords: Record<string, Record<string, unknown>> = {};

async function capture(name: string): Promise<void> {
  await writeFile(path.join(artifacts, `${name}.png`), runAdbBinary(['exec-out', 'screencap', '-p']));
  shots.push(`${name}.png`);
}
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
const count = (selector: string): Promise<number> => evaluateWebView<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
/** The last match: every stop keeps its card, and the newest is the one that speaks. */
const textOf = (selector: string): Promise<string> => evaluateWebView<string>(
  `(function () { var nodes = document.querySelectorAll(${JSON.stringify(selector)}); return nodes.length ? nodes[nodes.length - 1].textContent : ''; })()`);
const textContains = (selector: string, words: string): string => `(function () { var nodes = document.querySelectorAll(${JSON.stringify(selector)}); return nodes.length > 0 && nodes[nodes.length - 1].textContent.indexOf(${JSON.stringify(words)}) >= 0; })()`;
const attributeOf = (selector: string, name: string): Promise<string | null> => evaluateWebView<string | null>(
  `(function () { var node = document.querySelector(${JSON.stringify(selector)}); return node ? node.getAttribute(${JSON.stringify(name)}) : null; })()`);
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
/** A control's box, kept for the 44px check at the end (all of them are reported, not only the first one under). */
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
/**
 * One native tap on the last visible element `selector` matches, held still, enabled and on top at its centre. It is never
 * repeated (a second press would be refused or send twice), so the caller waits for the product's answer. A native tap,
 * because only a person's gesture raises the keyboard.
 */
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
const keyboardUp = (): boolean => /mInputShown=true/u.test(runAdb(['shell', 'dumpsys', 'input_method']));
function dropKeyboard(): void {
  if (keyboardUp()) runAdb(['shell', 'input', 'keyevent', '4']);
}
/** Keeps what this page says to its host about steering and cards: an old host would close the connection over them. */
async function logFrames(): Promise<void> {
  await evaluateWebView(`(function () {
    if (window.__longRunFrames) return true;
    window.__longRunFrames = [];
    var send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        ['agent.steer', 'long-run.limit-action', 'conversation-viewing'].forEach(function (word) { if (data.indexOf(word) >= 0) window.__longRunFrames.push(word); });
      }
      return send.apply(this, arguments);
    };
    return true;
  })()`);
}
const framesSent = (): Promise<readonly string[]> => evaluateWebView('window.__longRunFrames');
/** Nothing in `scope` reaches past it or the screen, and the page does not scroll sideways. */
async function assertFits(label: string, scope: string): Promise<void> {
  const fit = await evaluateWebView<{ readonly viewport: number; readonly page: number; readonly over: readonly string[] }>(`(function () {
    ${REVEAL}
    var root = lastVisible(${JSON.stringify(scope)}); var bounds = root.getBoundingClientRect(); var over = [];
    var nodes = root.querySelectorAll('*');
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]; var rect = node.getBoundingClientRect(); var name = String(node.className && node.className.baseVal === undefined ? node.className : node.tagName);
      if (rect.width === 0 || name.indexOf('visually-hidden') >= 0) continue;
      if (rect.right > bounds.right + 0.5 || rect.left < bounds.left - 0.5) over.push(name + ' ' + Math.round(rect.left) + '-' + Math.round(rect.right));
      if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0 && getComputedStyle(node).display !== 'inline') over.push(name + ' scrolls ' + node.scrollWidth + '>' + node.clientWidth);
    }
    return { viewport: window.innerWidth, page: document.documentElement.scrollWidth, over: over.slice(0, 12) };
  })()`);
  assert.ok(fit.page <= fit.viewport, `${label}: the page is ${fit.page}px wide on a ${fit.viewport}px screen`);
  assert.deepEqual(fit.over, [], `${label}: something does not wrap`);
}
/** A button's icon sits in its middle: WebView 74 does not lay a <button> out as a grid. */
async function assertIconCentred(label: string, selector: string): Promise<void> {
  const off = await evaluateWebView<number>(`(function () {
    var button = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    var icon = document.querySelector(${JSON.stringify(`${selector} svg`)}).getBoundingClientRect();
    return Math.abs(button.left + button.width / 2 - icon.left - icon.width / 2);
  })()`);
  assert.ok(off <= 1.5, `${label}: the icon is ${String(off)} px off the button's middle`);
}
/** The smallest space between what `selector` shows side by side, text measured as text: a lost flex gap reads 0. */
async function recordSpacing(label: string, selector: string): Promise<void> {
  spacing[label] = await evaluateWebView<number | null>(`(function () {
    var drawn = function (node) {
      var words = node.nodeType === 3 || (node.childNodes.length === 1 && node.firstChild.nodeType === 3);
      if (!words) return node.nodeType === 1 ? node.getBoundingClientRect() : null;
      if (!node.textContent.trim()) return null;
      var range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect();
    };
    var nodes = document.querySelectorAll(${JSON.stringify(selector)}); var smallest = null;
    for (var outer = 0; outer < nodes.length; outer += 1) {
      var parts = Array.prototype.map.call(nodes[outer].childNodes, drawn).filter(function (box) { return box && box.width > 0; });
      for (var index = 1; index < parts.length; index += 1) {
        var before = parts[index - 1]; var after = parts[index];
        if (after.top < before.bottom && after.bottom > before.top) { var space = Math.round((after.left - before.right) * 10) / 10; if (smallest === null || space < smallest) smallest = space; }
      }
    }
    return smallest;
  })()`);
}
async function recordColours(label: string, selector: string): Promise<void> {
  colours[label] = await evaluateWebView(`(function () {
    var nodes = document.querySelectorAll(${JSON.stringify(selector)}); var style = getComputedStyle(nodes[nodes.length - 1]);
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
  })()`);
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
/** Writes into the box and presses the one send button, whatever it does at this moment. */
async function sendFromPhone(text: string): Promise<void> {
  await setTestIdTextValue('structured-agent-composer-input', text);
  await waitFor(`(document.querySelector(${JSON.stringify(SEND)}) || {}).disabled === false`, 'Send ready');
  await tapTestIdOnce('structured-agent-send');
  await waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).value === ''`, 'the box emptied by the send');
}
/** A small text file through the box's own file input: the phone's picker is the system's, and this is what it hands over. */
async function attachNote(): Promise<void> {
  await evaluateWebView(`(function () {
    var input = document.querySelector('[data-testid="structured-agent-session"] input[type="file"]');
    var transfer = new DataTransfer();
    transfer.items.add(new File(['An attached note.\\n'], 'note.txt', { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(exists('.structured-agent-composer__attachments li'), 'the note attached');
}

// ── The project and the host ─────────────────────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}
function seedProject(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '--initial-branch=main', '--quiet');
  git(root, 'config', 'user.name', 'Long-run E2E');
  git(root, 'config', 'user.email', 'long-run-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), '# Cart kit\n');
  writeFileSync(path.join(root, 'src', 'cart.ts'), 'export const cartTotal = (prices: number[]): number => prices.reduce((sum, price) => sum + price, 0);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Baseline');
}

type HostWindow = Awaited<ReturnType<typeof launchDesktop>>['window'];
let commandSequence = 0;
/** A command from the desktop's person, for what only a desktop can do. */
async function hostCommand(host: HostWindow, type: string, payload: unknown): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    commandSequence += 1;
    const receipt = await host.evaluate(async (input) => {
      const state = await window.ezterminal.getDaemonSnapshot();
      if (!state) throw new Error('Missing snapshot');
      return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId: input.id, idempotencyKey: input.id, expectedRevision: state.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'fixture' }, type: input.type, payload: input.payload } as never);
    }, { id: `mobile-long-run-command-${String(commandSequence)}`, type, payload });
    if (receipt.ok) return;
    if (receipt.error.code !== 'revision-conflict' || attempt === 7) throw new Error(JSON.stringify(receipt));
    await sleep(100);
  }
}
async function prepareCodex(host: HostWindow, fakeCodex: string, control: string): Promise<void> {
  const inspection = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  assert.ok(inspection.ok, JSON.stringify(inspection));
  // Never a real provider: the deterministic fixture only, at a version the host runs long-run with.
  assert.ok(path.resolve(inspection.value.probe.executablePath).startsWith(fakeCodex), `expected the fake codex, found ${inspection.value.probe.executablePath}`);
  assert.equal(inspection.value.probe.executableVersion, LONG_RUN_CODEX_VERSION, `read from ${control}`);
  const { probe, reviewDigest } = inspection.value;
  await hostCommand(host, 'provider.enable', { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
    executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest });
}
async function addProject(host: HostWindow, root: string, name: string): Promise<string> {
  const saved = await host.evaluate((project) => window.ezterminal.saveAgentProject({ name: project.name, primaryRoot: project.root, additionalRoots: [], pinned: true }), { name, root });
  assert.ok(saved.ok, JSON.stringify(saved));
  const stored = realpathSync.native(root).toLowerCase();
  return until(`${name} has no workspace on the desktop`, async () => (await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces.find((entry) => entry.rootPath.toLowerCase() === stored)?.id, 15_000);
}

interface Card { readonly phase: string; readonly resumeAt?: string; readonly stopId: string; readonly chainEnded?: boolean; readonly sendReason?: string }

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-long-run-');
  const root = path.join(fixture, 'cart-kit');
  // The fake Codex's control files (its version, its limit, its holds, what it heard) live in its TMPDIR.
  const control = path.join(fixture, 'codex-control');
  for (const directory of [root, control]) mkdirSync(directory, { recursive: true });
  seedProject(root);
  writeFileSync(path.join(control, 'ezterminal-e2e-codex-version.txt'), LONG_RUN_CODEX_VERSION, 'utf8');
  const controlFile = (name: string): string => path.join(control, `ezterminal-e2e-codex-${name}`);
  const release = (token: string): void => writeFileSync(controlFile(`release-${token}`), '');
  const holdLanding = (): void => writeFileSync(controlFile('hold-steer'), '');
  const letLand = (): void => rmSync(controlFile('hold-steer'));
  const holdContinue = (): void => writeFileSync(controlFile('hold-continue'), '');
  const letContinue = (): void => rmSync(controlFile('hold-continue'));
  const refuseSteers = (how: 'review' | 'compact' | 'stale' | 'transport'): void => writeFileSync(controlFile('steer-refusal.txt'), how);
  const takeSteers = (): void => rmSync(controlFile('steer-refusal.txt'));
  const limitAccount = (limit: unknown): void => writeFileSync(controlFile('limit.json'), JSON.stringify(limit));
  const liftLimit = (): void => rmSync(controlFile('limit.json'));
  const readJsonLines = (name: string): Record<string, unknown>[] => {
    const file = controlFile(name);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  };
  const turnsHeard = (): Record<string, unknown>[] => readJsonLines('turns.jsonl');
  const steersHeard = (): Record<string, unknown>[] => readJsonLines('steers.jsonl');
  const continues = (): number => turnsHeard().filter((entry) => entry.text === 'Continue.').length;
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    // 360×800 on either AVD, before the app starts: a new density would otherwise restart its activity.
    runAdb(['shell', 'wm', 'size', '1080x2400']);
    runAdb(['shell', 'wm', 'density', '480']);
    // Resolved from this file: `pnpm --dir mobile` runs from mobile/, where the real codex on PATH would answer instead.
    const fakeCodex = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
    const hostEnvironment = { [pathKey]: `${fakeCodex}${path.delimiter}${process.env[pathKey] ?? ''}`, USERPROFILE: fixture, HOME: fixture, TMPDIR: control, EZTERMINAL_E2E_LONG_RUN_TIMING: JSON.stringify(TIMING) };
    let profile = '';
    desktop = await launchDesktop({
      env: hostEnvironment,
      prepareProfile: async (directory) => { profile = directory; },
      ...(OLD_HOST ? { mainEntry: path.join(path.resolve(OLD_HOST), '.vite', 'build', 'main.js'), cwd: path.resolve(OLD_HOST) } : {}),
    });
    let host = desktop.window;
    const snapshot = () => host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const workspaceId = await addProject(host, root, 'cart-kit');
    await prepareCodex(host, fakeCodex, control);

    const transcript = (sessionId: string) => host.evaluate((id) => window.ezterminal.getDaemonTranscript(id, 0, 500), sessionId);
    const hostCard = async (sessionId: string): Promise<Card | undefined> => {
      const rows = (await transcript(sessionId)).filter((item) => item.payload?.type === 'usage-limit');
      return rows.at(-1)?.payload as unknown as Card | undefined;
    };
    const reaches = (sessionId: string, phase: string, timeoutMs = 30_000): Promise<Card> => until(`the card at ${phase}`, async () => {
      const card = await hostCard(sessionId);
      return card?.phase === phase ? card : undefined;
    }, timeoutMs);
    const nothingRuns = (sessionId: string, label: string): Promise<boolean> => until(label, async () => {
      const state = await snapshot();
      const agent = state?.agents.find((entry) => entry.sessionId === sessionId);
      return Boolean(agent) && !agent?.currentTurnId && agent?.queuedTurnCount === 0;
    }, 45_000);
    const turnWorking = (sessionId: string): Promise<boolean> => until('the turn running', async () => {
      const state = await snapshot();
      const agent = state?.agents.find((entry) => entry.sessionId === sessionId);
      return Boolean(agent?.currentTurnId) && state?.turns.find((turn) => turn.id === agent?.currentTurnId)?.state === 'working';
    }, 20_000);
    const newAgent = (known: readonly string[]): Promise<string> => until('the conversation on the host', async () => (await snapshot())?.agents.find((entry) => !known.includes(entry.sessionId) && entry.providerSessionId)?.sessionId);
    const agentIds = async (): Promise<readonly string[]> => (await snapshot())?.agents.map((entry) => entry.sessionId) ?? [];
    /** A turn the fake keeps running until `release(token)`, sent from the phone. */
    const heldTurn = async (sessionId: string, token: string, words = '계속 작업해 주세요.'): Promise<void> => {
      await sendFromPhone(`EZTERMINAL_E2E_HOLD:${token} ${words}`);
      await turnWorking(sessionId);
      await waitFor(exists(STOP), 'the stop button while it runs');
    };
    const finishTurn = async (sessionId: string, token: string): Promise<void> => {
      release(token);
      await nothingRuns(sessionId, `the ${token} turn over`);
    };

    await connectAndAuth(desktop.token);
    await chooseKorean();

    if (OLD_HOST) {
      await logFrames();
      await openConversationList();
      await tapTestId('mobile-agent-new-session');
      const known = await agentIds();
      await draftIn(workspaceId, '장바구니 테스트를 고쳐 주세요.');
      const sessionId = await newAgent(known);
      await nothingRuns(sessionId, 'the first turn on the old host');
      await waitFor(`document.body.textContent.indexOf('Structured Codex fixture ready.') >= 0`, 'the first answer');
      const before = await snapshot();
      assert.equal(before?.capabilities?.includes('long-run-v1'), false, 'this host offers long-run-v1');
      assert.equal((before as { longRunSupport?: unknown } | null | undefined)?.longRunSupport, undefined, 'this host says what AIs run long-run');

      await heldTurn(sessionId, 'old');
      assert.equal(await evaluateWebView(exists(TRAY)), false, 'a tray on a host without long-run');
      await setTestIdTextValue('structured-agent-composer-input', '그 파일만 고쳐 주세요.');
      await waitFor(exists(SEND), 'the send button with words in the box');
      assert.notEqual(await attributeOf(SEND, 'aria-label'), '실행 중에 끼워넣기', 'the old host cannot take a message into a turn');
      await capture('00-old-host-busy-send');
      await tapTestIdOnce('structured-agent-send');
      await until('the message queued on the old host', async () => (await snapshot())?.turns.filter((turn) => turn.sessionId === sessionId).some((turn) => turn.state === 'queued'), 15_000);
      assert.equal(await evaluateWebView(exists(TRAY)), false, 'the queued message went to a tray');
      await capture('01-old-host-queued');
      await finishTurn(sessionId, 'old');
      assert.equal(turnsHeard().filter((entry) => entry.text === '그 파일만 고쳐 주세요.').length, 1, 'the queued message ran once');
      assert.deepEqual(steersHeard(), [], 'a steer reached the old host');

      limitAccount({ window: 'five-hour', resetIn: HOUR });
      await sendFromPhone('하나 더 고쳐 주세요.');
      await until('the limit, as the error it always was', async () => (await snapshot())?.turns.filter((turn) => turn.sessionId === sessionId).at(-1)?.state === 'failed', 15_000);
      await sleep(3_000);
      assert.equal(await evaluateWebView(exists(CARD)), false, 'a limit card on a host without long-run');
      await capture('02-old-host-limit-error');
      const frames = await framesSent();
      assert.deepEqual(frames.filter((frame) => frame !== 'conversation-viewing'), [], 'the phone sent an old host what it cannot read');
      assert.equal(await evaluateWebView(exists('[data-testid="mobile-reconnect-scrim"]')), false, 'the old host dropped the phone');
      checks.push('a host from before the feature (no long-run-v1): the conversation works, Send queues behind a running turn and runs once, no tray and no card, a limit is its error, and no agent.steer or long-run.limit-action is sent');
      await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ ok: true, androidApi, provider: 'deterministic Codex fixture', oldHost: path.resolve(OLD_HOST), checks, screenshots: shots }, null, 2));
      return;
    }

    await chooseTheme();
    await logFrames();

    // ── A Codex conversation in the project, from the phone ──────────────────────────────────────────────────────────
    await openConversationList();
    await tapTestId('mobile-agent-new-session');
    const known = await agentIds();
    await draftIn(workspaceId, '장바구니 테스트를 전부 고쳐 주세요.');
    const sessionId = await newAgent(known);
    await nothingRuns(sessionId, 'the first turn');
    await waitFor(`document.body.textContent.indexOf('Structured Codex fixture ready.') >= 0`, 'the first answer');
    const ready = await snapshot();
    assert.ok(ready?.capabilities?.includes('long-run-v1'), 'the desktop does not offer long-run-v1');
    assert.equal(ready?.longRunSupport?.codex, true, 'the fake Codex does not run long-run');
    checks.push(`a Codex conversation from the phone, in Korean, in ${THEME}`);

    // ── The send button while a turn runs ────────────────────────────────────────────────────────────────────────────
    await heldTurn(sessionId, 'steer');
    const heardBefore = turnsHeard().length;
    assert.match(await textOf(HINT), /^보내기로 끼워넣기 · 이 턴에 들어갑니다/u, 'the hint does not say what the button does');
    await measure('입력창: 중단', STOP);
    await assertIconCentred('입력창: 중단', STOP);
    await capture('01-busy');
    holdLanding();
    await setTestIdTextValue('structured-agent-composer-input', '장바구니 파일만 고쳐 주세요.');
    await waitFor(exists(SEND), 'the send button with words in the box');
    assert.equal(await attributeOf(SEND, 'aria-label'), '실행 중에 끼워넣기', 'the button does not name what it does');
    await measure('입력창: 끼워넣기', SEND);
    await assertIconCentred('입력창: 끼워넣기', SEND);
    await capture('02-busy-draft');
    await tapOnce(SEND, 'the busy send button');
    await waitFor(exists(TRAY), 'the tray');
    await waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).value === ''`, 'the box emptied');
    await until('the steer heard once', () => steersHeard().length === 1, 10_000);
    await waitFor(textContains(TRAY, '곧 들어갑니다 · 도구를 기다리지 않고 이 턴에'), 'the Codex words in the tray');
    assert.equal(steersHeard()[0]?.outcome, 'accepted');
    assert.equal(turnsHeard().length, heardBefore, 'the message started a turn');
    assert.equal((await snapshot())?.turns.filter((turn) => turn.sessionId === sessionId && turn.state === 'queued').length, 0, 'the message was queued');
    assert.ok(!(await transcript(sessionId)).some((item) => item.text === '장바구니 파일만 고쳐 주세요.'), 'a row before it landed');
    await recordSpacing('트레이: 제목', '.chat-steer__title');
    await recordSpacing('트레이: 상태', '.chat-steer__state');
    await recordColours('트레이', TRAY);
    await capture('03-steer-on-its-way');
    letLand();
    await waitFor(`!(${exists(TRAY)})`, 'the tray gone once it landed');
    await waitFor(exists(LANDED), 'the landed mark');
    assert.equal(await textOf(LANDED), '실행 중에 끼워넣음');
    assert.equal(await textOf(ANNOUNCE), '메시지가 전달됐습니다.');
    await scrollIntoView(LANDED, 'center');
    await capture('04-steer-landed');
    await finishTurn(sessionId, 'steer');
    const steered = (await transcript(sessionId)).filter((item) => item.text === '장바구니 파일만 고쳐 주세요.');
    assert.equal(steered.length, 1, 'the message has one row');
    assert.equal(steered[0]?.payload?.type, 'steer');
    checks.push('with words in the box the send button adds them to the running turn (one turn/steer, no turn, no queue); the tray says it goes in without waiting for the tool, then the row lands once with its mark');

    // While text is being written.
    await heldTurn(sessionId, 'writing', 'EZTERMINAL_E2E_WRITING 계속 작업해 주세요.');
    holdLanding();
    await sendFromPhone('글은 짧게 써 주세요.');
    await waitFor(textContains(TRAY, '쓰던 글은 버리고 이 턴에서 다시 씁니다'), 'the words for text being written');
    await capture('05-steer-while-writing');
    letLand();
    await waitFor(exists(LANDED), 'the landed mark after rewriting');
    await waitFor(textContains(LANDED, '다시'), 'the rewritten mark');
    await finishTurn(sessionId, 'writing');

    // Behind an approval.
    await sendFromPhone('EZTERMINAL_E2E_APPROVAL 전체 테스트를 돌려 주세요.');
    await waitFor(exists(DOCK_ALLOW), 'the approval dock');
    await waitFor(textContains(HINT, '승인에 답한 뒤 들어갑니다'), 'the hint behind an approval');
    await sendFromPhone('느린 테스트는 빼 주세요.');
    await waitFor(textContains(TRAY, '승인 뒤에 전달됩니다'), 'the tray behind an approval');
    assert.deepEqual(readJsonLines('landed.jsonl').filter((entry) => JSON.stringify(entry).includes('느린')), [], 'it landed behind the approval');
    await measure('승인: 허용', DOCK_ALLOW);
    await capture('06-steer-behind-approval');
    await tapOnce(DOCK_ALLOW, 'the approval');
    await waitFor(`!(${exists(TRAY)})`, 'the tray gone after the answer');
    await nothingRuns(sessionId, 'the approved turn over');
    assert.equal(steersHeard().filter((entry) => entry.text === '느린 테스트는 빼 주세요.').length, 1, 'it was steered once');
    checks.push('behind an approval the tray says so, nothing lands, and the answer lets it in');

    // Refused by the turn: the queue, with the reason.
    for (const [how, says] of [['review', '검토 턴에는 끼워넣을 수 없어 대기열에 넣었습니다.'], ['stale', '턴이 막 끝나 대기열에 넣었습니다.']] as const) {
      const token = `refused-${how}`;
      const words = `${how} 턴에 넣지 말아 주세요.`;
      await heldTurn(sessionId, token);
      refuseSteers(how);
      await sendFromPhone(words);
      await waitFor(textContains(FALLBACK, says), `the ${how} reason`);
      assert.equal(await textOf(ANNOUNCE), says);
      assert.equal(await evaluateWebView(exists(TRAY)), false, `a tray for a ${how} refusal`);
      await scrollIntoView(FALLBACK, 'center');
      await capture(`07-fallback-${how}`);
      takeSteers();
      await finishTurn(sessionId, token);
      assert.equal(turnsHeard().filter((entry) => entry.text === words).length, 1, `the ${how} message ran once`);
    }
    checks.push('a turn that refuses the message puts it in the queue, which says why, and it runs once as the next turn');

    // An attachment.
    await heldTurn(sessionId, 'attached');
    await attachNote();
    const steersBeforeNote = steersHeard().length;
    await sendFromPhone('이 메모를 읽어 주세요.');
    await waitFor(textContains(FALLBACK, '글만 끼워넣을 수 있어 대기열에 넣었습니다.'), 'the attachment in the queue');
    assert.equal(steersHeard().length, steersBeforeNote, 'an attachment was steered');
    await scrollIntoView(FALLBACK, 'center');
    await capture('08-attachment-queued');
    await finishTurn(sessionId, 'attached');
    checks.push('an attachment never goes into the running turn: it waits in the queue and says why');

    // The call breaks and the thread does not have it: failed, and nothing sends it again.
    await heldTurn(sessionId, 'broken');
    refuseSteers('transport');
    const failedWords = '이 메시지는 끊긴 연결로 갑니다.';
    await sendFromPhone(failedWords);
    await waitFor(textContains(TRAY, '끼워넣지 못했습니다 · 이 대화의 연결이 끊겼습니다'), 'the failed tray');
    takeSteers();
    assert.equal(await evaluateWebView(exists(TO_QUEUE)), false, 'a broken connection offers the queue');
    await measure('트레이: 입력창으로 되돌리기', TO_BOX);
    await capture('09-steer-failed');
    await tapOnce(TO_BOX, '입력창으로 되돌리기');
    await waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).value === ${JSON.stringify(failedWords)}`, 'the words back in the box');
    await waitFor(`!(${exists(TRAY)})`, 'the tray empty');
    await setTestIdTextValue('structured-agent-composer-input', '');
    dropKeyboard();
    await finishTurn(sessionId, 'broken');
    checks.push('a steer that broke on the way says so and only goes back to the box; nothing resends it');

    // Caught by a limit.
    await heldTurn(sessionId, 'caught');
    holdLanding();
    await sendFromPhone('이건 한도에 걸립니다.');
    await waitFor(textContains(TRAY, '곧 들어갑니다'), 'on its way before the limit');
    limitAccount({ window: 'five-hour', resetIn: HOUR });
    release('caught');
    await reaches(sessionId, 'waiting');
    await waitFor(textContains(TRAY, '한도로 턴이 멈춰 전달됐는지 확인하지 못했습니다'), 'the caught tray');
    assert.equal(await evaluateWebView(exists(TO_QUEUE)), false, 'a caught message offers a send that could read twice');
    await capture('10-steer-caught-by-limit');
    await tapOnce(TO_BOX, '입력창으로 되돌리기 (한도)');
    await waitFor(`!(${exists(TRAY)})`, 'the tray empty after the limit');
    await setTestIdTextValue('structured-agent-composer-input', '');
    // Back in the box, it asks for the keyboard; the card is read without it.
    dropKeyboard();
    await until('the keyboard down after the box', async () => !keyboardUp(), 10_000);
    letLand();
    checks.push('a limit landing on a message on its way says it cannot tell and offers no second send');

    // ── The limit card on a clock ────────────────────────────────────────────────────────────────────────────────────
    await waitFor(exists(limitButton('try-now')), 'the waiting card');
    const waitingCard = await hostCard(sessionId);
    assert.equal(waitingCard?.phase, 'waiting');
    await waitFor(textContains(CARD, '자동으로 재개를 시도합니다'), 'the plan on the card');
    assert.match(await textOf(CARD), /시도할 때 앱이 "Continue."를 보냅니다/u);
    await waitFor(textContains(HEADER_STATE, '한도 대기 · '), 'the clock in the header');
    assert.notEqual(await attributeOf(HEADER_STATE, 'data-state'), 'blocked', 'a clock wait is amber in the header');
    await waitFor(textContains(HINT, '보내면 자동 재개가 취소됩니다'), 'what a send costs');
    await measure('카드: 지금 시도', limitButton('try-now'));
    await measure('카드: 자동 재개 끄기', limitButton('auto-off'));
    await recordColours('헤더: 한도 대기', HEADER_STATE);
    stateWords.clock = { header: await textOf(HEADER_STATE), dataState: await attributeOf(HEADER_STATE, 'data-state') };
    await recordColours('카드', CARD);
    await assertFits('대기 카드', CARD);
    await scrollIntoView(CARD);
    await capture('11-limit-waiting');

    await tapOnce('[data-testid="mobile-structured-agent-back"]', '뒤로');
    await openFeed();
    await waitFor(textContains(feedRow(sessionId), '한도 대기'), 'the clock in the list');
    assert.equal(await attributeOf(feedRow(sessionId), 'data-need'), null, 'a clock wait is amber in the list');
    assert.equal(await count(WAITING), 0, 'a clock wait is in 나를 기다리는 것');
    await capture('12-feed-clock-wait');
    await tapOnce(feedRow(sessionId), '대화 열기');
    await waitFor(exists(onScreen(sessionId)), 'the conversation again');
    checks.push('on a clock: the card says when and what it sends, the header and the list say 한도 대기 with no amber, and nothing is in 나를 기다리는 것');

    // 지금 시도, refused: the clock stands.
    const clockBefore = (await hostCard(sessionId))?.resumeAt;
    await tapOnce(limitButton('try-now'), '지금 시도');
    await until('the try refused', async () => { const card = await hostCard(sessionId); return card?.phase === 'waiting' && continues() === 1; }, 20_000);
    await waitFor(textContains(CARD, '지금 시도가 거절됐습니다'), 'the refused try on the card');
    assert.equal((await hostCard(sessionId))?.resumeAt, clockBefore, 'a refused try moved the clock');
    await waitFor(textContains(APP_SENT, '앱이 보냄 · 지금 시도를 누름'), 'the app-sent row of a press');
    await recordColours('앱이 보낸 줄', APP_SENT);
    await recordSpacing('앱이 보낸 줄', '.chat-app-sent__who');
    await scrollIntoView(CARD);
    await capture('13-limit-tried');

    // 자동 재개 끄기, and 다시 켜기.
    await tapOnce(limitButton('auto-off'), '자동 재개 끄기');
    await reaches(sessionId, 'off');
    await waitFor(exists(limitButton('auto-on')), 'the way back');
    await waitFor(`!(${exists(limitButton('try-now'))})`, 'the schedule gone');
    await measure('카드: 다시 켜기', limitButton('auto-on'));
    await measure('카드: 이어서 하기', limitButton('resume'));
    await waitFor(textContains(HEADER_STATE, '한도로 멈춤'), 'the header once it is off');
    await scrollIntoView(CARD);
    await capture('14-limit-auto-off');
    await tapOnce(limitButton('auto-on'), '다시 켜기');
    await reaches(sessionId, 'waiting');
    await waitFor(exists(limitButton('try-now')), 'the schedule back');
    await tapOnce(limitButton('auto-off'), '자동 재개 끄기 (둘째)');
    await reaches(sessionId, 'off');

    // 이어서 하기 from the phone.
    liftLimit();
    const heardAtPress = continues();
    await tapOnce(limitButton('resume'), '이어서 하기');
    await reaches(sessionId, 'resumed');
    await nothingRuns(sessionId, 'the resumed turn over');
    assert.equal(continues(), heardAtPress + 1, 'one press, one "Continue."');
    await waitFor(textContains(APP_SENT, '앱이 보냄 · 이어서 하기를 누름'), 'the app-sent row');
    await waitFor(textContains(CARD, '앱이 "Continue."를 보냈습니다.'), 'the card once it went');
    assert.equal(await count(limitButton('resume')), 0, 'a resumed card still offers a press');
    await scrollIntoView(APP_SENT, 'center');
    await capture('15-app-sent-resumed');
    assert.ok((await framesSent()).includes('long-run.limit-action'), 'the press did not go from the phone');
    checks.push('지금 시도 refused keeps the clock and says so; 자동 재개 끄기 and 다시 켜기 move the card; 이어서 하기 from the phone sends one "Continue." and the app-sent row says who pressed');

    // ── The host sends while the phone only watches ──────────────────────────────────────────────────────────────────
    holdContinue();
    limitAccount({ window: 'five-hour', resetIn: 8 });
    await sendFromPhone('이번에는 지켜보기만 합니다.');
    await reaches(sessionId, 'waiting');
    await waitFor(exists(limitButton('try-now')), 'the card the phone watches');
    await evaluateWebView(`(function () {
      var cards = document.querySelectorAll(${JSON.stringify(CARD)}); window.__seen = [];
      var note = function () { var nodes = document.querySelectorAll(${JSON.stringify(CARD)}); var last = nodes[nodes.length - 1]; var head = document.querySelector(${JSON.stringify(HEADER_STATE)});
        var line = (last ? last.textContent.slice(0, 40) : '') + ' | ' + (head ? head.textContent : '');
        if (window.__seen[window.__seen.length - 1] !== line) window.__seen.push(line); };
      note(); new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
      return cards.length > 0;
    })()`);
    liftLimit();
    const watchedFrames = (await framesSent()).length;
    await reaches(sessionId, 'resuming', 30_000);
    await waitFor(textContains(CARD, '예약 시각이 되어 "Continue."를 보내는 중입니다.'), 'the card as it goes, with no press');
    await waitFor(textContains(HEADER_STATE, '이어서 하는 중'), 'the header as it goes');
    await scrollIntoView(CARD);
    await capture('16-host-sending');
    letContinue();
    await reaches(sessionId, 'resumed');
    await nothingRuns(sessionId, 'the scheduled turn over');
    await waitFor(textContains(CARD, '앱이 "Continue."를 보냈습니다.'), 'the card once the host sent');
    await waitFor(textContains(APP_SENT, '앱이 보냄 · 예약 시각이 되어'), 'the app-sent row of the clock');
    await scrollIntoView(APP_SENT, 'center');
    await capture('17-host-sent');
    const watched = await evaluateWebView<readonly string[]>('window.__seen');
    assert.ok(watched.some((line) => line.indexOf('한도 대기') >= 0) && watched.some((line) => line.indexOf('이어서 하는 중') >= 0), `the phone did not see it move: ${JSON.stringify(watched)}`);
    assert.deepEqual((await framesSent()).slice(watchedFrames).filter((frame) => frame !== 'conversation-viewing'), [], 'the phone pressed something while it only watched');
    stateWords.watched = { lines: watched };
    checks.push('a phone only watching sees the card and the header move from the clock to sending to sent as the host sends "Continue.", and it sends nothing itself');

    // ── States that ask first ────────────────────────────────────────────────────────────────────────────────────────
    const asksInHeader = async (label: string): Promise<void> => {
      await waitFor(textContains(HEADER_STATE, '한도 · 답 기다림'), `${label}: the header asks`);
      assert.equal(await attributeOf(HEADER_STATE, 'data-state'), 'blocked', `${label}: the header is not amber`);
    };
    limitAccount({ window: 'weekly', resetIn: 3 * 24 * HOUR });
    await sendFromPhone('주간 한도까지 갑니다.');
    await reaches(sessionId, 'ask-reset');
    await waitFor(textContains(CARD, '주간 한도는 먼저 묻습니다.'), 'the weekly card');
    await asksInHeader('weekly');
    await recordColours('헤더: 답 기다림', HEADER_STATE);
    stateWords.asks = { header: await textOf(HEADER_STATE), dataState: await attributeOf(HEADER_STATE, 'data-state') };
    await measure('카드: 그때 이어서 하기', limitButton('schedule'));
    await measure('카드: 그대로 두기', limitButton('leave'));
    await assertFits('주간 카드', CARD);
    await scrollIntoView(CARD);
    await capture('18-limit-weekly-asks');
    await tapOnce('[data-testid="mobile-structured-agent-back"]', '뒤로 (주간)');
    await openFeed();
    // It moves up: an amber card in 나를 기다리는 것, and no longer one of the ordinary conversations.
    await waitFor(`${exists(`${WAITING}[data-kind="usage-limit"]`)} && ${textContains(WAITING, '주간 한도 · 먼저 묻습니다')}`, 'a card in 나를 기다리는 것');
    assert.equal(await evaluateWebView(exists(feedRow(sessionId))), false, 'an asking conversation stays among the ordinary ones too');
    await recordColours('나를 기다리는 것', WAITING);
    await measure('나를 기다리는 것: 카드', WAITING);
    await capture('19-feed-asks');
    await tapOnce(WAITING, '대화 열기 (주간)');
    await waitFor(exists(onScreen(sessionId)), 'the conversation after the list');
    await tapOnce(limitButton('schedule'), '그때 이어서 하기');
    await reaches(sessionId, 'scheduled');
    await waitFor(exists(limitButton('unschedule')), 'the way back from a schedule');
    await measure('카드: 취소', limitButton('unschedule'));
    await waitFor(textContains(HEADER_STATE, '한도 대기'), 'the header once a time is chosen');
    assert.notEqual(await attributeOf(HEADER_STATE, 'data-state'), 'blocked', 'a chosen time is amber');
    await scrollIntoView(CARD);
    await capture('20-limit-scheduled');
    await tapOnce(limitButton('unschedule'), '취소');
    await reaches(sessionId, 'ask-reset');
    await waitFor(exists(limitButton('leave')), 'asking again');
    await tapOnce(limitButton('leave'), '그대로 두기');
    await reaches(sessionId, 'left');
    await waitFor(exists(limitButton('resume')), 'the card left with its way on');
    await scrollIntoView(CARD);
    await capture('21-limit-left');
    stateWords.left = { header: await textOf(HEADER_STATE) };
    liftLimit();
    await sendFromPhone('한도가 끝난 뒤에 보냅니다.');
    await reaches(sessionId, 'cancelled');
    await nothingRuns(sessionId, 'the message after it was left');

    // No reset known: a press, refused, tried once more, then it gives up.
    limitAccount({ kind: 'no-reset' });
    await sendFromPhone('리셋 시각을 모르는 한도입니다.');
    await reaches(sessionId, 'ask-unknown');
    await waitFor(textContains(CARD, '해제 예정 시각을 알 수 없습니다.'), 'the unknown card');
    await asksInHeader('unknown');
    await scrollIntoView(CARD);
    await capture('22-limit-unknown-asks');
    await tapOnce(limitButton('resume'), '이어서 하기 (시각 모름)');
    await reaches(sessionId, 'retrying', 20_000);
    await waitFor(textContains(CARD, '한 번 더 시도합니다'), 'the retry on the card');
    await scrollIntoView(CARD);
    await capture('23-limit-retrying');
    await reaches(sessionId, 'gave-up', 20_000);
    await waitFor(textContains(CARD, '앱은 더 시도하지 않습니다.'), 'the card giving up');
    await asksInHeader('gave up');
    await scrollIntoView(CARD);
    await capture('24-limit-gave-up');
    liftLimit();
    await tapOnce(limitButton('resume'), '이어서 하기 (포기 뒤)');
    await reaches(sessionId, 'resumed');
    await nothingRuns(sessionId, 'the turn after giving up');

    // A person writes first and the limit refuses it.
    limitAccount({ window: 'five-hour', resetIn: HOUR });
    await sendFromPhone('예약을 세웁니다.');
    await reaches(sessionId, 'waiting');
    await waitFor(exists(limitButton('try-now')), 'the clock before a person writes');
    await sendFromPhone('직접 먼저 보냅니다.');
    await reaches(sessionId, 'person-refused');
    await waitFor(textContains(CARD, '직접 보낸 메시지가 한도로 거절됐습니다.'), 'the refused message on the card');
    await scrollIntoView(CARD);
    await capture('25-limit-person-refused');
    stateWords['person-refused'] = { header: await textOf(HEADER_STATE) };
    liftLimit();
    await sendFromPhone('한도가 끝났습니다.');
    await reaches(sessionId, 'cancelled');
    await nothingRuns(sessionId, 'the message after the refusal');

    // Three in a row, then it asks.
    limitAccount({ window: 'five-hour', resetIn: 1, afterWork: true });
    const heardAtChain = continues();
    await sendFromPhone('계속 멈추는 작업입니다.');
    const capped = await reaches(sessionId, 'ask-reset', 60_000);
    assert.equal(capped.chainEnded, true, 'the fourth stop does not say why it asks');
    assert.equal(continues() - heardAtChain, 3, 'not three in a row');
    await waitFor(textContains(CARD, '자동으로 3번 연달아 이어서 했습니다. 이번에는 먼저 묻습니다.'), 'the chain on the card');
    await asksInHeader('chain');
    await assertFits('연속 카드', CARD);
    await scrollIntoView(CARD);
    await capture('26-limit-chain-asks');
    await sleep(Math.max(0, Date.parse(capped.resumeAt!) - Date.now()) + 3_000);
    assert.equal(continues() - heardAtChain, 3, 'the fourth went by itself');
    liftLimit();
    await tapOnce(limitButton('schedule'), '그때 이어서 하기 (연속)');
    await reaches(sessionId, 'resumed');
    await nothingRuns(sessionId, 'the run after the chain');
    assert.equal(continues() - heardAtChain, 4, 'the press sends the fourth');
    checks.push('weekly, unknown reset, gave up and the end of a chain of three ask first: amber in the header and the list, a line in 나를 기다리는 것, and the buttons each state offers; a chosen time is back on the clock; the fourth "Continue." goes only after a press');

    // A plan without this AI.
    limitAccount({ kind: 'not-included' });
    await sendFromPhone('이 요금제로 보냅니다.');
    await reaches(sessionId, 'not-included');
    await waitFor(textContains(CARD, '이 요금제에는 Codex 사용량이 포함되어 있지 않습니다.'), 'the plan card');
    await waitFor(textContains(HEADER_STATE, '한도로 멈춤'), 'the header of a stop for good');
    assert.notEqual(await attributeOf(HEADER_STATE, 'data-state'), 'blocked', 'a stop for good is amber');
    assert.equal(await evaluateWebView(`document.querySelectorAll(${JSON.stringify(`${CARD}:last-of-type button`)}).length`), 0, 'a plan card offers a button');
    await scrollIntoView(CARD);
    await capture('27-limit-not-included');
    stateWords['not-included'] = { header: await textOf(HEADER_STATE), dataState: await attributeOf(HEADER_STATE, 'data-state') };
    liftLimit();
    await sendFromPhone('요금제를 바꿨습니다.');
    await nothingRuns(sessionId, 'the message after the plan');
    await waitFor(`document.querySelector(${JSON.stringify(HEADER_STATE)}).textContent.indexOf('한도') < 0`, 'the header past the plan card');
    checks.push('a plan without this AI: no button, the header says 한도로 멈춤 with no amber, and a message that gets through closes it');

    // ── Long words, four messages, the tray's cap, the keyboard ──────────────────────────────────────────────────────
    await tapOnce('[data-testid="mobile-structured-agent-back"]', '뒤로 (긴 글)');
    await openFeed();
    await tapTestId('mobile-feed-new');
    const knownBeforeLong = await agentIds();
    await draftIn(workspaceId, '긴 글을 봅니다.');
    const longSession = await newAgent(knownBeforeLong);
    await nothingRuns(longSession, 'the long conversation');
    await heldTurn(longSession, 'long');
    holdLanding();
    for (let index = 1; index <= 4; index += 1) {
      await sendFromPhone(`${String(index)}. ${LONG_MESSAGE}`);
      await until(`steer ${String(index)} heard`, () => steersHeard().filter((entry) => String(entry.text).includes(LONG_WORD)).length === index, 10_000);
      await waitFor(`document.querySelectorAll(${JSON.stringify(TRAY_MESSAGE)}).length === ${String(index)}`, `message ${String(index)} in the tray`);
    }
    await waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).disabled === false`, 'the box after four');
    const wrapped = await evaluateWebView<{ readonly wrap: string; readonly anywhere: boolean }>(`(function () {
      return { wrap: getComputedStyle(document.querySelector('.chat-steer__text')).overflowWrap, anywhere: CSS.supports('overflow-wrap', 'anywhere') };
    })()`);
    await assertFits('긴 트레이', TRAY);
    const trayRoom = (): Promise<{ readonly panel: number; readonly list: number | null; readonly tray: number; readonly boxTop: number; readonly boxBottom: number; readonly screen: number; readonly maxHeight: string; readonly toggle: boolean }> => evaluateWebView(`(function () {
      var panel = document.querySelector('.structured-agent').getBoundingClientRect();
      var list = document.querySelector(${JSON.stringify(TRAY_LIST)}); var tray = document.querySelector(${JSON.stringify(TRAY)}).getBoundingClientRect();
      var box = document.querySelector('.chat-composer__box').getBoundingClientRect();
      return { panel: panel.height, list: list ? list.getBoundingClientRect().height : null, tray: tray.height, boxTop: box.top, boxBottom: box.bottom, screen: window.innerHeight, maxHeight: list ? list.style.maxHeight : '', toggle: !!document.querySelector(${JSON.stringify(TRAY_TOGGLE)}) };
    })()`);
    const roomy = await trayRoom();
    assert.ok(roomy.list !== null && roomy.list <= Math.max(64, Math.round(roomy.panel * 0.24)) + 1, `the tray's list passes its cap: ${JSON.stringify(roomy)}`);
    assert.ok(roomy.boxBottom <= roomy.screen + 1, `the box is pushed off the screen: ${JSON.stringify(roomy)}`);
    await capture('28-long-tray');
    await tapOnce(COMPOSER, '입력창');
    await until('the keyboard up', async () => keyboardUp(), 10_000);
    await waitFor(`window.innerHeight < ${String(roomy.screen)} || document.querySelector('.structured-agent').getBoundingClientRect().height < ${String(roomy.panel)}`, 'the panel shorter with the keyboard', 10_000);
    await sleep(800);
    const keyboard = await trayRoom();
    assert.ok(keyboard.panel < roomy.panel, `the panel did not shrink: ${JSON.stringify({ roomy, keyboard })}`);
    assert.ok(keyboard.boxBottom <= keyboard.screen + 1, `the keyboard covers the box: ${JSON.stringify(keyboard)}`);
    if (keyboard.panel < 560) {
      assert.equal(keyboard.toggle, true, `a short panel does not fold the tray: ${JSON.stringify(keyboard)}`);
      assert.equal(keyboard.list, null, 'the folded tray still shows its list');
      assert.ok(keyboard.tray <= 96, `the folded tray takes ${String(keyboard.tray)} px`);
      await measure('트레이: 접힌 줄', TRAY_TOGGLE);
      const title = await evaluateWebView<{ readonly lines: number; readonly clipped: boolean }>(`(function () {
        var span = document.querySelector(${JSON.stringify(`${TRAY_TOGGLE} > span`)});
        var range = document.createRange(); range.selectNodeContents(span);
        var summary = document.querySelector(${JSON.stringify(`${TRAY_TOGGLE} .chat-steer__summary`)});
        return { lines: range.getClientRects().length, clipped: summary.scrollWidth > summary.clientWidth };
      })()`);
      assert.equal(title.lines, 1, `the folded title breaks: ${JSON.stringify(title)}`);
    }
    await recordSpacing('트레이: 접힌 줄', TRAY_TOGGLE);
    await capture('29-long-tray-keyboard');
    if (keyboard.toggle) {
      await tapOnce(TRAY_TOGGLE, '트레이 펼치기');
      await waitFor(exists(TRAY_LIST), 'the tray opened with the keyboard up');
      await sleep(400);
      const opened = await trayRoom();
      assert.ok(opened.list !== null && opened.list <= Math.max(64, Math.round(opened.panel * 0.24)) + 1, `opened, the list passes its cap: ${JSON.stringify(opened)}`);
      assert.ok(opened.boxBottom <= opened.screen + 1, `opened, the box is off the screen: ${JSON.stringify(opened)}`);
      await capture('30-long-tray-keyboard-open');
      stateWords.keyboardOpen = opened;
    }
    stateWords.tray = { roomy, keyboard, wrapped };
    dropKeyboard();
    await until('the keyboard down', async () => !keyboardUp(), 10_000);
    letLand();
    await waitFor(`!(${exists(TRAY)})`, 'the long tray gone');
    await finishTurn(longSession, 'long');
    await scrollIntoView(LANDED, 'center');
    await assertFits('긴 메시지 줄', '.chat-viewport__scroll');
    await capture('31-long-landed');
    checks.push(`at 360 px with overflow-wrap ${wrapped.wrap} (anywhere ${wrapped.anywhere ? 'supported' : 'unsupported'}): an unbroken path and identifier wrap in the tray and its row; four long messages stay under the list's cap, and with the keyboard up the tray ${keyboard.toggle ? 'folds to a line and opens under the same cap' : 'keeps its cap'} and the box stays on screen`);

    // ── The PC app closed through the time ───────────────────────────────────────────────────────────────────────────
    limitAccount({ window: 'five-hour', resetIn: 20 });
    await sendFromPhone('PC 앱을 닫는 동안 시간이 지납니다.');
    const beforeClosing = await reaches(longSession, 'waiting');
    await waitFor(exists(limitButton('try-now')), 'the card before the PC closes');
    // `dispose` is the only way out and takes the profile with it, so what survives a close is kept aside first.
    const kept = registry.createTempDir('ezterm-mobile-long-run-kept-');
    cpSync(profile, kept, { recursive: true, filter: (source) => !CHROMIUM_LEFTOVERS.has(path.basename(source)) });
    const heardBeforeClosing = continues();
    await desktop.dispose();
    desktop = undefined;
    await sleep(Math.max(0, Date.parse(beforeClosing.resumeAt!) - Date.now()) + 2_000);
    assert.equal(continues(), heardBeforeClosing, 'something went out with the PC app closed');
    liftLimit();
    desktop = await launchDesktop({ env: hostEnvironment, prepareProfile: async (directory) => { cpSync(kept, directory, { recursive: true }); } });
    host = desktop.window;
    await reaches(longSession, 'ask-reopened', 60_000);
    await waitFor(textContains(CARD, 'PC 앱이 닫혀 있는 동안 해제 예정 시각'), 'the reopened card on the phone', 90_000);
    await waitFor(textContains(CARD, 'PC 앱을 열었다고 저절로 보내지 않습니다.'), 'the card saying nothing went');
    await waitFor(textContains(HEADER_STATE, '한도 · 답 기다림'), 'the header asks after reopening');
    assert.equal(continues(), heardBeforeClosing, 'a reopened app sent by itself');
    await assertFits('다시 연 카드', CARD);
    await scrollIntoView(CARD);
    await capture('32-limit-reopened');
    await tapOnce(limitButton('resume'), '이어서 하기 (다시 열림)');
    await reaches(longSession, 'resumed');
    await nothingRuns(longSession, 'the turn after reopening');
    assert.equal(continues(), heardBeforeClosing + 1, 'one press after reopening, one "Continue."');
    await capture('33-after-reopening');
    stateWords.afterReopening = { contextBanner: await evaluateWebView<boolean>(`document.body.textContent.indexOf('PC connection is unavailable') >= 0`) };
    checks.push('the PC app closed through the time: nothing goes, reopened it asks in words that name the PC app, the phone sees that and 이어서 하기 from the phone sends one "Continue."');

    const environment = await evaluateWebView<{ readonly userAgent: string; readonly flexGap: string | null; readonly lang: string; readonly theme: string | undefined; readonly viewport: string; readonly colorMix: boolean }>(`({
      userAgent: navigator.userAgent, flexGap: document.documentElement.getAttribute('data-ui-flex-gap'), lang: document.documentElement.lang, theme: document.documentElement.dataset.theme,
      viewport: window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio, colorMix: CSS.supports('color', 'color-mix(in srgb, red, blue)') })`);
    assert.equal(environment.theme, THEME);
    const small = targets.filter((target) => target.width < 44 || target.height < 44);
    const lostGaps = Object.entries(spacing).filter(([, value]) => value !== null && value <= 0);
    const invisible = Object.entries(colours).filter(([, value]) => value.color === 'rgba(0, 0, 0, 0)' || !value.color);
    assert.notDeepEqual(colours['헤더: 한도 대기'], colours['헤더: 답 기다림'], 'the clock and the ask read the same in the header');
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({
      ok: small.length === 0 && lostGaps.length === 0 && invisible.length === 0, androidApi, provider: 'deterministic Codex fixture', environment, heard: { turns: turnsHeard().length, steers: steersHeard().length, continues: continues() },
      checks, stateWords, spacing, colours, touchTargets: targets, screenshots: shots,
    }, null, 2));
    assert.deepEqual(small, [], `touch targets under 44px: ${JSON.stringify(small)}`);
    assert.deepEqual(lostGaps, [], `spacing lost: ${JSON.stringify(lostGaps)}`);
    assert.deepEqual(invisible, [], `colours lost: ${JSON.stringify(invisible)}`);
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${text}`);
    if (desktop) await writeFile(path.join(artifacts, 'failure-snapshot.json'), JSON.stringify(await desktop.window.evaluate(() => window.ezterminal.getDaemonSnapshot()), null, 2)).catch(() => undefined);
    throw error;
  } finally {
    runAdb(['shell', 'wm', 'size', 'reset']);
    runAdb(['shell', 'wm', 'density', 'reset']);
    await desktop?.dispose();
    closeMobileE2eResources();
    await registry.disposeAll();
  }
}
await main();
