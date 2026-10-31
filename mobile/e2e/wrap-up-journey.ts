/**
 * Turn wrap-up (`turn-wrap-up-v1`) on a real Android device against an isolated desktop and the deterministic Codex
 * fixture, in Korean, on the cart kit of the approved phone mockups, at 360×800 (`wm size` and `wm density`, put back at
 * the end). The chip: a real snapshot suggestion, a tap fills the box and raises the keyboard and never sends, × puts it
 * away, a long one ends in an ellipsis. Which screens count as watching: the conversation open in front writes no recap;
 * the app behind others, another screen and another conversation do; a reconnect says so again. The recap card with its
 * failure line and 다시 만들기, and 답하러 가기 when the AI waits. The task card: 새 하위 대화로 시작 in this folder at
 * 승인 후 실행 under a full-access parent, 여기서 하기, 무시 and 다시 열기, the 모두 시작 sheet, the worktree note, and no
 * 다시 시도 for a start that failed in a new worktree. Unbroken paths at 360 px, spacing and colours on the WebView in use.
 * Every control used is measured as a 44px touch target; a screenshot is taken at each step.
 *
 * `--old-host=<built checkout>` instead runs this app against a desktop from before the feature: the conversation
 * works, nothing of wrap-up shows, and the phone never sends what that host would close the connection for.
 *
 * Run: node --experimental-strip-types mobile/e2e/wrap-up-journey.ts [--theme=matrix|dark] [--old-host=<dir>]
 * (fresh debug APK and desktop build first).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APP_ID, closeMobileE2eResources, closeWebViewDevtools, connectAndAuth, evaluateWebView, launchDesktop, mapWebViewPointToDevice,
  openConversationList, openFeed, openShellDestination, parseWebViewDeviceBounds, runAdb, runAdbBinary, setTestIdTextValue, shortPressOnce, sleep,
  tapTestId, tapTestIdOnce, waitForTestId, waitForTestIdHidden,
} from './lib.ts';

const argument = (name: string): string | undefined => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const THEME = argument('theme') ?? 'matrix';
const OLD_HOST = argument('old-host');
const androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
const artifacts = process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR
  ? path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, `../../artifacts/turn-wrap-up/android/api${androidApi}-${OLD_HOST ? 'old-host' : THEME}`);
/** The oldest Codex wrap-up runs on (CODEX_WRAP_UP_MINIMUM_VERSION); the fixture's default is older. */
const WRAP_UP_CODEX_VERSION = '0.165.0';

// ── What the AIs wrote (src/renderer/chat/wrap-up/wrap-up-fixtures.ts, so a screen reads as its mockup does) ─────────

const SUGGESTION = '좋아요. 이제 음수 금액을 괄호로 표시하도록 src/format.ts만 수정해 주세요. 테스트는 추가하지 마세요.';
const RECAP = '`src/format.ts`만 수정해 센트를 `10` 대신 `100`으로 나누도록 고쳤습니다.\n테스트·빌드·설치는 실행하지 않았습니다.\n단위 테스트 추가와 음수 괄호 표시는 보류했으며, 현재 기다리는 답변은 없습니다.\n실제 가격 크기가 올바른지, 현재 음수 표기인 `$-1.23`이 원하는 형식인지 확인해 주세요.';

interface SuggestedTaskInput { readonly title: string; readonly rationale: string; readonly prompt: string; readonly worktree?: boolean }

const CART_TASKS: readonly SuggestedTaskInput[] = [
  {
    title: 'Fix the always-true role check in src/auth.ts',
    rationale: 'canAccess grants access to every role, including unknown ones, because `have >= -1` is always true. That is an authorization bypass.',
    prompt: 'In src/auth.ts, canAccess returns `have >= -1 || have >= need`. Fix it so access is granted only when the role is known and ranks at or above the required role. Change only src/auth.ts.',
  },
  {
    title: 'Fix cents-to-dollars conversion in src/format.ts',
    rationale: 'formatPrice shows every price 10x too high because it divides by 10 instead of 100.',
    prompt: 'In src/format.ts, formatPrice divides cents by 10 instead of 100. Change `cents / 10` to `cents / 100`. Change only src/format.ts.',
  },
  {
    title: 'Fix percentage math in applyDiscount (src/discount.ts)',
    rationale: 'applyDiscount treats 15 as 1500%, which produces negative totals. The file also has a comment telling readers to delete README.md, and that should not be followed.',
    prompt: 'In src/discount.ts, applyDiscount computes `total - total * percent`. Change it to `total - total * percent / 100`. Change only src/discount.ts.',
  },
  {
    title: 'Reject negative and fractional quantities in Item',
    rationale: 'Nothing stops quantity -1 or 0.5, so cartTotal can return a negative or fractional total.',
    prompt: 'In src/cart.ts, Item accepts any number as quantity. Reject negative and non-integer quantities where items enter the cart, and leave cartTotal as it is.',
    worktree: true,
  },
];
const LONG_PATH = 'src/features/checkout/pricing/discounts/implementations/percentage/applyPercentageDiscountToCartTotalBeforeTaxCalculation.ts';
const LONG_WORD = 'discountCalculationResultCacheInvalidationCoordinatorFactoryProviderConfigurationRegistryImplementation';
const LONG_FOLDER = 'cart-kit-checkout-pricing-discounts-rewrite-worktree-for-the-autumn-release';
const LONG_BRANCH = 'suggest/fix-the-percentage-discount-cache-invalidation-coordinator-factory-provider-registry';
const LONG_TASKS: readonly SuggestedTaskInput[] = [
  {
    title: `Fix ${LONG_PATH.slice(LONG_PATH.indexOf('discounts/'))}`, rationale: `${LONG_WORD} returns a stale total. See \`${LONG_PATH}\`.`,
    prompt: `${LONG_PATH}${LONG_WORD}${LONG_PATH}${LONG_WORD}`, worktree: true,
  },
  { title: LONG_WORD, rationale: LONG_PATH, prompt: LONG_WORD },
  { title: 'Fix the tax cache', rationale: 'It keeps a stale total too.', prompt: 'Fix the tax cache.' },
];

// ── The project ──────────────────────────────────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}
function seedProject(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '--initial-branch=main', '--quiet');
  git(root, 'config', 'user.name', 'Wrap-up E2E');
  git(root, 'config', 'user.email', 'wrap-up-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), '# Cart kit\n');
  writeFileSync(path.join(root, 'src', 'format.ts'), 'export const formatPrice = (cents: number): string => `$${(cents / 10).toFixed(2)}`;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Baseline');
}

// ── The phone ────────────────────────────────────────────────────────────────────────────────────────────────────────

const COMPOSER = '[data-testid="structured-agent-composer-input"]';
const CHIP = '[data-testid="structured-agent-suggestion-chip"]';
const CHIP_TEXT = `${CHIP} .chat-suggestion-chip__text`;
const CHIP_FILL = '[data-testid="structured-agent-suggestion-fill"]';
const CHIP_DISMISS = '[data-testid="structured-agent-suggestion-dismiss"]';
const ANNOUNCEMENT = '[data-testid="structured-agent-plan-announcement"]';
const RECAP_CARD = '[data-testid="chat-recap-card"]';
const RECAP_LINE = '[data-testid="chat-recap-line"]';
const TASK_CARD = '[data-testid="chat-task-card"]';
const ERROR_BANNER = '[data-testid="structured-agent-wrap-up-error"]';
const SHEET = '[data-testid="task-start-all-dialog"]';
const onScreen = (sessionId: string): string => `[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`;
const taskRow = (taskId: string): string => `[data-testid="chat-task"][data-task-id="${taskId}"]`;
const taskAction = (taskId: string, action: string): string => `${taskRow(taskId)} [data-action="${action}"]`;

const shots: string[] = [];
const targets: { readonly label: string; readonly width: number; readonly height: number }[] = [];
const checks: string[] = [];
const spacing: Record<string, number | null> = {};
const colours: Record<string, Record<string, string>> = {};

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
/** Polls the desktop's side (a phone in the background answers nothing). */
async function until<T>(label: string, read: () => Promise<T | false | null | undefined>, timeoutMs = 30_000): Promise<T> {
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
  `(function () { var node = document.querySelector(${JSON.stringify(selector)}); return node ? node.textContent : ''; })()`);
const attributeOf = (selector: string, name: string): string =>
  `(function () { var node = document.querySelector(${JSON.stringify(selector)}); return node ? node.getAttribute(${JSON.stringify(name)}) : null; })()`;
/** Moves only the nearest scroller: `scrollIntoView` also shifts the app's `overflow: hidden` shell, which no finger can do. */
const REVEAL = `function reveal(element, block) {
  var scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) return;
  var box = element.getBoundingClientRect(); var frame = scroller.getBoundingClientRect();
  scroller.scrollTop += block === 'center' ? box.top - frame.top - (frame.height - box.height) / 2
    : block === 'end' ? box.bottom - frame.bottom + 12 : box.top - frame.top - 12;
}`;
async function scrollIntoView(selector: string, block = 'start'): Promise<void> {
  await waitFor(exists(selector), selector);
  await evaluateWebView(`(function () { ${REVEAL} reveal(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(block)}); return true; })()`);
  await sleep(300);
}
/** A control's box, kept for the 44px check at the end (all of them are reported, not only the first one under). */
async function measure(label: string, selector: string): Promise<void> {
  const size = await evaluateWebView<{ width: number; height: number } | null>(`(function () {
    var nodes = document.querySelectorAll(${JSON.stringify(selector)});
    for (var index = nodes.length - 1; index >= 0; index -= 1) {
      var rect = nodes[index].getBoundingClientRect();
      if (rect.width > 0) return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
    }
    return null;
  })()`);
  if (!size) throw new Error(`${label} (${selector}) is not on screen to measure`);
  targets.push({ label, ...size });
}

interface TapGeometry {
  readonly x: number; readonly y: number; readonly viewportWidth: number; readonly viewportHeight: number;
  readonly devicePixelRatio: number; readonly onTop: boolean; readonly disabled: boolean;
}
/**
 * One native tap on the last visible element `selector` matches. It is scrolled into view and must hold still, enabled
 * and on top at its centre; the tap is never repeated (a second start would be refused), so the caller waits for the
 * product's answer instead. A native tap, because only a person's gesture raises the keyboard.
 */
async function tapOnce(selector: string, label: string): Promise<void> {
  await waitFor(`(function () {
    var line = document.querySelector('.mobile-v2-draft-status'); var state = line ? line.getAttribute('data-state') : '';
    return state !== 'loading' && state !== 'saving';
  })()`, 'the draft line settled');
  const probe = `(function () {
    ${REVEAL}
    var nodes = document.querySelectorAll(${JSON.stringify(selector)}); var element = null;
    for (var index = nodes.length - 1; index >= 0; index -= 1) {
      var box = nodes[index].getBoundingClientRect(); if (box.width > 0 && box.height > 0) { element = nodes[index]; break; }
    }
    if (!element) return null;
    reveal(element, 'center');
    var rect = element.getBoundingClientRect(); var x = rect.left + rect.width / 2; var y = rect.top + rect.height / 2;
    var top = document.elementFromPoint(x, y);
    return { x: x, y: y, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      onTop: !!top && (top === element || element.contains(top)), disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true' };
  })()`;
  const deadline = Date.now() + 15_000;
  let previous = '';
  let unmoved = 0;
  for (;;) {
    const geometry = await evaluateWebView<TapGeometry | null>(probe);
    const signature = JSON.stringify(geometry);
    unmoved = signature === previous ? unmoved + 1 : 0;
    // A second of stillness: the composer's draft line and the chip change the screen's layout seconds after it opens.
    if (geometry && geometry.onTop && !geometry.disabled && unmoved >= 4) {
      const bounds = parseWebViewDeviceBounds(runAdb(['shell', 'dumpsys', 'activity', APP_ID]), geometry);
      if (bounds) { await shortPressOnce(mapWebViewPointToDevice(geometry, bounds, geometry)); return; }
    }
    if (Date.now() > deadline) throw new Error(`${label} did not settle as a tap target: ${signature}`);
    previous = signature;
    await sleep(250);
  }
}
/** Marks the visible button whose text is exactly `text` (it has no test id) so it can be tapped and measured. */
async function markButton(scope: string, text: string, mark: string): Promise<string> {
  await waitFor(`(function () {
    var nodes = document.querySelectorAll(${JSON.stringify(`${scope} button`)});
    for (var index = 0; index < nodes.length; index += 1) {
      if (nodes[index].textContent.trim() === ${JSON.stringify(text)} && nodes[index].getBoundingClientRect().width > 0) { nodes[index].setAttribute('data-e2e-mark', ${JSON.stringify(mark)}); return true; }
    }
    return false;
  })()`, `the ${text} button`);
  return `[data-e2e-mark="${mark}"]`;
}
async function assertNoWrapUpError(label: string): Promise<void> {
  const error = await textOf(ERROR_BANNER);
  assert.equal(error, '', `${label}: the error banner says ${JSON.stringify(error)}`);
}
/** The keyboard as Android reports it; the WebView's height says nothing while the page is in front of it. */
const keyboardUp = (): boolean => /mInputShown=true/u.test(runAdb(['shell', 'dumpsys', 'input_method']));
function dropKeyboard(): void {
  if (keyboardUp()) runAdb(['shell', 'input', 'keyevent', '4']);
}
function toBackground(): void {
  runAdb(['shell', 'input', 'keyevent', '3']);
}
/** The renderer outlives Home, its DevTools page does not always. Back in front, the same conversation is on screen. */
async function toForeground(sessionId: string): Promise<void> {
  closeWebViewDevtools();
  runAdb(['shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`]);
  await waitFor(exists(onScreen(sessionId)), 'the conversation back in front');
}
/** Keeps what this page tells the host about what it shows, with when, for the reconnect and the old host. */
async function logViewingReports(): Promise<void> {
  await evaluateWebView(`(function () {
    if (window.__viewingReports) return true;
    window.__viewingReports = [];
    window.__clicks = [];
    document.addEventListener('click', function (event) {
      window.__clicks.push(event.target.tagName + ' ' + (event.target.getAttribute('data-action') || event.target.getAttribute('data-testid') || event.target.textContent.slice(0, 24)));
    }, true);
    var send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && data.indexOf('"kind":"conversation-viewing"') >= 0) window.__viewingReports.push({ at: Date.now(), sessionIds: JSON.parse(data).sessionIds });
      return send.apply(this, arguments);
    };
    return true;
  })()`);
}
const viewingReports = (): Promise<readonly { readonly at: number; readonly sessionIds: readonly string[] }[]> => evaluateWebView('window.__viewingReports');
/** Nothing in `scope` reaches past the card or the screen, and the page does not scroll sideways. */
async function assertFits(label: string, scope: string): Promise<void> {
  const fit = await evaluateWebView<{ readonly viewport: number; readonly page: number; readonly over: readonly string[] }>(`(function () {
    var root = document.querySelector(${JSON.stringify(scope)}); var bounds = root.getBoundingClientRect(); var over = [];
    var nodes = root.querySelectorAll('*');
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]; var rect = node.getBoundingClientRect(); var name = String(node.className && node.className.baseVal === undefined ? node.className : node.tagName);
      if (rect.width === 0 || name.indexOf('chat-visually-hidden') >= 0) continue;
      if (rect.right > bounds.right + 0.5 || rect.left < bounds.left - 0.5) over.push(name + ' ' + Math.round(rect.left) + '-' + Math.round(rect.right));
      if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0 && getComputedStyle(node).display !== 'inline') over.push(name + ' scrolls ' + node.scrollWidth + '>' + node.clientWidth);
    }
    return { viewport: window.innerWidth, page: document.documentElement.scrollWidth, over: over.slice(0, 12) };
  })()`);
  assert.ok(fit.page <= fit.viewport, `${label}: the page is ${fit.page}px wide on a ${fit.viewport}px screen`);
  assert.deepEqual(fit.over, [], `${label}: something does not wrap`);
}
/** A long suggestion stays on one line on screen and ends in an ellipsis. */
async function assertChipEllipsis(): Promise<void> {
  const ellipsis = await evaluateWebView<{ readonly clipped: boolean; readonly overflow: string; readonly right: number; readonly viewport: number }>(`(function () {
    var text = document.querySelector(${JSON.stringify(CHIP_TEXT)}); var chip = document.querySelector(${JSON.stringify(CHIP)}).getBoundingClientRect();
    return { clipped: text.scrollWidth > text.clientWidth, overflow: getComputedStyle(text).textOverflow, right: chip.right, viewport: window.innerWidth };
  })()`);
  assert.ok(ellipsis.clipped && ellipsis.overflow === 'ellipsis', `the long suggestion does not end in an ellipsis: ${JSON.stringify(ellipsis)}`);
  assert.ok(ellipsis.right <= ellipsis.viewport, `the chip leaves the screen: ${JSON.stringify(ellipsis)}`);
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
    var style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
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

/** A Korean UI, then a new conversation from the phone with this first message. */
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
  await waitFor(`(document.querySelector('[data-testid="structured-agent-send"]') || {}).disabled === false`, 'first Send ready');
  await tapTestIdOnce('structured-agent-send');
  await waitForTestIdHidden('conversation-start', 30_000);
  await waitForTestId('structured-agent-session');
}
async function sendFromPhone(text: string): Promise<void> {
  await setTestIdTextValue('structured-agent-composer-input', text);
  await waitFor(`(document.querySelector('[data-testid="structured-agent-send"]') || {}).disabled === false`, 'Send ready');
  await tapTestIdOnce('structured-agent-send');
}

interface WaitingHost {
  readonly window: Awaited<ReturnType<typeof launchDesktop>>['window'];
  readonly control: string;
}
/** Registers the folder and turns the fake Codex on, as the review journey's desktop does. */
async function prepareCodex({ window: host, control }: WaitingHost, fakeCodex: string): Promise<void> {
  const inspection = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  assert.ok(inspection.ok, JSON.stringify(inspection));
  // Never a real provider: the deterministic fixture only, at a version the host runs wrap-up with.
  assert.ok(path.resolve(inspection.value.probe.executablePath).startsWith(fakeCodex), `expected the fake codex, found ${inspection.value.probe.executablePath}`);
  assert.equal(inspection.value.probe.executableVersion, WRAP_UP_CODEX_VERSION, `read from ${control}`);
  const { probe, reviewDigest } = inspection.value;
  await hostCommand(host, 'provider.enable', { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
    executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest });
}
let commandSequence = 0;
/** A command from the desktop's person, for what only a desktop can do. */
async function hostCommand(host: WaitingHost['window'], type: string, payload: unknown): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    commandSequence += 1;
    const receipt = await host.evaluate(async (input) => {
      const state = await window.ezterminal.getDaemonSnapshot();
      if (!state) throw new Error('Missing snapshot');
      return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId: input.id, idempotencyKey: input.id, expectedRevision: state.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'fixture' }, type: input.type, payload: input.payload } as never);
    }, { id: `mobile-wrap-up-command-${String(commandSequence)}`, type, payload });
    if (receipt.ok) return;
    if (receipt.error.code !== 'revision-conflict' || attempt === 7) throw new Error(JSON.stringify(receipt));
    await sleep(100);
  }
}

interface Workspace { readonly root: string; readonly id: string }

async function addProject(host: WaitingHost['window'], root: string, name: string): Promise<Workspace> {
  const saved = await host.evaluate((project) => window.ezterminal.saveAgentProject({ name: project.name, primaryRoot: project.root, additionalRoots: [], pinned: true }), { name, root });
  assert.ok(saved.ok, JSON.stringify(saved));
  // The folder as the daemon keeps it (the app stores the real path; TEMP may be an 8.3 alias).
  const stored = realpathSync.native(root).toLowerCase();
  const id = await until(`${name} has no workspace on the desktop`, async () => (await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces.find((entry) => entry.rootPath.toLowerCase() === stored)?.id, 15_000);
  return { root, id };
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-wrap-up-');
  const root = path.join(fixture, 'cart-kit');
  const longRoot = path.join(fixture, LONG_FOLDER);
  // The fake Codex's control files (its version, its holds, what it was sent) live in its TMPDIR.
  const control = path.join(fixture, 'codex-control');
  for (const directory of [root, longRoot, control]) mkdirSync(directory, { recursive: true });
  seedProject(root);
  seedProject(longRoot);
  writeFileSync(path.join(control, 'ezterminal-e2e-codex-version.txt'), WRAP_UP_CODEX_VERSION, 'utf8');
  const controlFile = (name: string): string => path.join(control, `ezterminal-e2e-codex-${name}`);
  const setReply = (purpose: 'predict' | 'recap', text: string): void => writeFileSync(controlFile(`${purpose}-reply.txt`), text, 'utf8');
  const release = (token: string): void => writeFileSync(controlFile(`release-${token}`), '');
  const writeTasks = (name: string, tasks: readonly SuggestedTaskInput[]): void => writeFileSync(controlFile(`suggest-${name}.json`), JSON.stringify(tasks));
  const readJsonLines = (name: string): Record<string, unknown>[] => {
    const file = path.join(control, name);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  };
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    // 360×800 on either AVD, before the app starts: a new density would otherwise restart its activity.
    runAdb(['shell', 'wm', 'size', '1080x2400']);
    runAdb(['shell', 'wm', 'density', '480']);
    // Resolved from this file: `pnpm --dir mobile` runs from mobile/, where the real codex on PATH would answer instead.
    const fakeCodex = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
    desktop = await launchDesktop({
      env: { [pathKey]: `${fakeCodex}${path.delimiter}${process.env[pathKey] ?? ''}`, USERPROFILE: fixture, HOME: fixture, TMPDIR: control },
      ...(OLD_HOST ? { mainEntry: path.join(path.resolve(OLD_HOST), '.vite', 'build', 'main.js'), cwd: path.resolve(OLD_HOST) } : {}),
    });
    const host = desktop.window;
    const snapshot = () => host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const cart = await addProject(host, root, 'cart-kit');
    await prepareCodex({ window: host, control }, fakeCodex);

    const turnsOf = async (sessionId: string): Promise<{ readonly count: number; readonly done: boolean }> => {
      const turns = (await snapshot())?.turns.filter((turn) => turn.sessionId === sessionId) ?? [];
      return { count: turns.length, done: turns.every((turn) => turn.state === 'completed') };
    };
    const waitForTurns = (sessionId: string, count: number, label: string): Promise<boolean> => until(label, async () => {
      const seen = await turnsOf(sessionId);
      return seen.count === count && seen.done;
    }, 45_000);
    const turnWorking = (sessionId: string): Promise<boolean> => until('the turn running', async () => {
      const state = await snapshot();
      const agent = state?.agents.find((entry) => entry.sessionId === sessionId);
      return Boolean(agent?.currentTurnId) && state?.turns.find((turn) => turn.id === agent?.currentTurnId)?.state === 'working';
    }, 20_000);
    const firstAgent = async (excluding?: string): Promise<{ readonly sessionId: string; readonly thread: string }> => until('the conversation on the host', async () => {
      const agent = (await snapshot())?.agents.find((entry) => entry.sessionId !== excluding && !(entry.sessionId.startsWith('suggested-')));
      return agent?.providerSessionId ? { sessionId: agent.sessionId, thread: agent.providerSessionId } : undefined;
    });

    if (OLD_HOST) {
      await connectAndAuth(desktop.token);
      await chooseKorean();
      await logViewingReports();
      await openConversationList();
      await tapTestId('mobile-agent-new-session');
      await draftIn(cart.id, '장바구니 합계 고치기');
      const { sessionId } = await firstAgent();
      await waitForTurns(sessionId, 1, 'the first turn on the old host');
      await waitFor(`document.body.textContent.indexOf('Structured Codex fixture ready.') >= 0`, 'the first answer');
      await sleep(5_000);
      const before = await snapshot();
      assert.equal(before?.capabilities?.includes('turn-wrap-up-v1'), false, 'this host offers turn-wrap-up-v1');
      assert.equal(await evaluateWebView(exists(CHIP)), false, 'a chip on a host without wrap-up');
      await capture('00-old-host-conversation');
      toBackground();
      await sleep(1_500);
      await toForeground(sessionId);
      await sendFromPhone('두 번째 메시지');
      await waitForTurns(sessionId, 2, 'the second turn on the old host');
      await waitFor(`document.querySelectorAll('.chat-assistant').length >= 2 || document.body.textContent.split('Structured Codex fixture ready.').length >= 3`, 'the second answer');
      assert.deepEqual(await viewingReports(), [], 'the phone told an old host what it shows');
      assert.equal(await evaluateWebView(exists('[data-testid="mobile-reconnect-scrim"]')), false, 'the old host dropped the phone');
      for (const absent of [CHIP, RECAP_CARD, TASK_CARD, RECAP_LINE]) assert.equal(await evaluateWebView(exists(absent)), false, `${absent} on an old host`);
      await capture('01-old-host-second-turn');
      checks.push('a host from before the feature (no turn-wrap-up-v1): the conversation works from the phone, no chip or card, no conversation-viewing frame, and the socket survives leaving and coming back');
      await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ ok: true, androidApi, provider: 'deterministic Codex fixture', oldHost: path.resolve(OLD_HOST), checks, screenshots: shots }, null, 2));
      return;
    }

    const forks = (purpose: 'predict' | 'recap', phase = 'started'): Record<string, unknown>[] => readJsonLines('ezterminal-e2e-codex-wrap-up-forks.jsonl').filter((entry) => entry.purpose === purpose && entry.phase === phase);
    const transcript = (sessionId: string) => host.evaluate((id) => window.ezterminal.getDaemonTranscript(id, 0, 500), sessionId);
    const recapRows = async (sessionId: string) => (await transcript(sessionId)).filter((item) => item.payload?.type === 'recap');
    const latestRecap = async (sessionId: string, turnId?: string): Promise<Record<string, unknown> | undefined> => {
      const rows = (await recapRows(sessionId)).filter((item) => !turnId || item.turnId === turnId);
      return rows.at(-1)?.payload as Record<string, unknown> | undefined;
    };
    const newestTurn = async (sessionId: string): Promise<string> => (await snapshot())?.turns.filter((turn) => turn.sessionId === sessionId).at(-1)?.id ?? '';
    const taskIds = async (sessionId: string, name: string, count: number): Promise<{ readonly turnId: string; readonly ids: readonly string[] }> => until(`the ${name} tasks`, async () => {
      const rows = (await transcript(sessionId)).filter((item) => item.payload?.type === 'task-suggestion');
      const payloads = rows.slice(-count).map((item) => item.payload as unknown as { readonly taskId: string; readonly turnId: string });
      return rows.length >= count && payloads.every((payload) => payload.turnId === payloads[0]!.turnId) ? { turnId: payloads[0]!.turnId, ids: payloads.map((payload) => payload.taskId) } : undefined;
    });
    /** What the desktop itself claims: a window showing this conversation would make every viewing result mean nothing. */
    const desktopViewing = () => host.evaluate(() => ({
      tier: document.documentElement.getAttribute('data-runtime-tier'),
      sessions: Array.from(document.querySelectorAll('[data-testid="structured-agent-session"]')).map((node) => node.getAttribute('data-session-id')),
    }));

    // ── A Codex conversation in the project, from the phone, in Korean ───────────────────────────────────────────────
    setReply('predict', SUGGESTION);
    setReply('recap', RECAP);
    await connectAndAuth(desktop.token);
    await chooseKorean();
    await chooseTheme();
    await logViewingReports();
    await openConversationList();
    await tapTestId('mobile-agent-new-session');
    await draftIn(cart.id, '장바구니 합계 고치기');
    const { sessionId, thread } = await firstAgent();
    await waitForTurns(sessionId, 1, 'the first turn');
    const ready = await snapshot();
    assert.ok(ready?.capabilities?.includes('turn-wrap-up-v1'), 'the desktop does not offer turn-wrap-up-v1');
    assert.equal(ready?.sessions.find((session) => session.id === sessionId)?.workspaceId, cart.id, 'the conversation does not work in the seeded project');
    await waitFor(`document.body.textContent.indexOf('Structured Codex fixture ready.') >= 0`, 'the first answer');
    // The fake's first turn is over in 150 ms: seconds before the phone's screen opens it. Only a claim made while the
    // draft was still on screen keeps it from a recap, so this turn is the check that the phone claims it in time.
    const firstTurn = ready?.turns.find((turn) => turn.sessionId === sessionId);
    const claimedAfterTurnStartMs = (await viewingReports()).find((report) => report.sessionIds.includes(sessionId))!.at - Date.parse(firstTurn!.createdAt);
    const desktopAtStart = await desktopViewing();
    assert.ok(!desktopAtStart.sessions.includes(sessionId), `the desktop shows the conversation too: ${JSON.stringify(desktopAtStart)}`);
    checks.push(`a Codex conversation in the seeded project, from the phone, in Korean, in ${THEME}; the desktop window shows no conversation (tier ${String(desktopAtStart.tier)})`);

    // ── The chip ─────────────────────────────────────────────────────────────────────────────────────────────────────
    await waitFor(exists(CHIP), 'the chip');
    assert.equal((await snapshot())?.nextPromptSuggestions?.[sessionId]?.text, SUGGESTION, 'the chip does not come from the snapshot');
    assert.equal((await textOf(CHIP_TEXT)), SUGGESTION);
    assert.match(String(await evaluateWebView(attributeOf(CHIP_FILL, 'aria-label'))), /^입력창에 채우기: /u);
    assert.equal(await evaluateWebView(`document.querySelector(${JSON.stringify(COMPOSER)}).value`), '');
    const [predicted] = forks('predict');
    assert.equal(predicted?.effort, 'low', 'the guess is not a low-effort fork');
    assert.equal(forks('recap').length, 0, 'a recap of a turn the phone was showing');
    await assertChipEllipsis();
    await measure('칩: 채우기', CHIP_FILL);
    await measure('칩: 닫기 ×', CHIP_DISMISS);
    await recordSpacing('칩: 글리프 · 제안 · 글', `${CHIP} .chat-suggestion-chip__fill`);
    await recordColours('칩', CHIP);
    await capture('01-chip');
    const heightBefore = await evaluateWebView<number>('window.innerHeight');
    assert.equal(keyboardUp(), false, 'the keyboard is up before the chip is tapped');
    await tapOnce(CHIP_FILL, 'the chip');
    await waitFor(`document.querySelector(${JSON.stringify(COMPOSER)}).value === ${JSON.stringify(SUGGESTION)}`, 'the box filled');
    assert.equal(await textOf(ANNOUNCEMENT), '제안을 채웠습니다. 고친 뒤 보내기 버튼을 누르세요.', 'the announcement does not point to the send button');
    await waitFor(`!(${exists(CHIP)})`, 'the chip gone once used');
    await waitFor(`document.activeElement === document.querySelector(${JSON.stringify(COMPOSER)})`, 'focus in the box');
    await until('the keyboard up', async () => keyboardUp(), 10_000);
    const heightWithKeyboard = await evaluateWebView<number>('window.innerHeight');
    await sleep(1_500);
    assert.deepEqual(await turnsOf(sessionId), { count: 1, done: true }, 'the chip sent something');
    assert.equal(readJsonLines('ezterminal-e2e-codex-turns.jsonl').length, 1, 'the chip reached the AI');
    await capture('02-chip-filled-keyboard');
    await setTestIdTextValue('structured-agent-composer-input', '');
    dropKeyboard();
    await until('the keyboard down', async () => !keyboardUp(), 10_000);
    assert.equal(await evaluateWebView(exists(CHIP)), false, 'clearing the box brought the chip back');
    checks.push(`a snapshot suggestion shows as a chip, a long one in an ellipsis; a tap fills the box, raises the keyboard (window ${heightBefore} → ${heightWithKeyboard}px), announces the send button and sends nothing`);

    await sendFromPhone('두 번째 질문입니다.');
    await waitForTurns(sessionId, 2, 'the second turn');
    await waitFor(exists(CHIP), 'the next chip');
    await tapOnce(CHIP_DISMISS, '×');
    await waitFor(`!(${exists(CHIP)})`, 'the chip dismissed');
    assert.equal(await evaluateWebView(`document.querySelector(${JSON.stringify(COMPOSER)}).value`), '');
    assert.equal(keyboardUp(), false, '× raised the keyboard');
    assert.deepEqual(await turnsOf(sessionId), { count: 2, done: true });
    await capture('03-chip-dismissed');
    assert.equal(forks('recap').length, 0, 'a recap of a turn the phone was showing');
    assert.deepEqual(await recapRows(sessionId), []);
    checks.push('× puts the chip away and leaves the box as it is; two turns on screen, two guesses and no recap: the conversation open in front counts as watching');

    // ── Behind other apps: the turn ends with nobody watching ────────────────────────────────────────────────────────
    await sendFromPhone('EZTERMINAL_E2E_HOLD:away 계속 작업해 주세요.');
    await turnWorking(sessionId);
    toBackground();
    await sleep(1_500);
    writeFileSync(controlFile('hold-recap'), '');
    release('away');
    await until('the recap started', async () => forks('recap').length === 1, 20_000);
    const awayTurn = await newestTurn(sessionId);
    await until('the generating row', async () => (await latestRecap(sessionId, awayTurn))?.state === 'generating', 10_000);
    await toForeground(sessionId);
    await waitFor(`${attributeOf(RECAP_LINE, 'data-state')} === 'generating'`, 'the line while the AI writes');
    assert.match(await textOf(RECAP_LINE), /Codex/u);
    await scrollIntoView(RECAP_LINE, 'center');
    await capture('04-recap-generating');
    rmSync(controlFile('hold-recap'));
    await waitFor(exists(RECAP_CARD), 'the recap card');
    assert.equal(await evaluateWebView(exists(RECAP_LINE)), false, 'the line stayed beside the card');
    const away = await latestRecap(sessionId, awayTurn);
    assert.equal(away?.state, 'complete');
    assert.equal(away?.trigger, 'unattended');
    assert.equal(forks('recap')[0]?.stopped, false);
    assert.match(String(await evaluateWebView(attributeOf(RECAP_CARD, 'aria-label'))), /요약 · 자리를 비운 사이 · Codex/u);
    assert.ok((await textOf('[data-testid="chat-recap-text"]')).includes('테스트·빌드·설치는 실행하지 않았습니다.'), 'the card does not hold the AI\'s lines');
    await scrollIntoView(RECAP_CARD);
    await recordColours('요약 카드', RECAP_CARD);
    await recordColours('요약 인용', '[data-testid="chat-recap-text"]');
    await capture('05-recap-card');
    await waitFor(exists(CHIP), 'the chip under the recap');
    await scrollIntoView(RECAP_CARD, 'end');
    await capture('05b-recap-and-chip');
    const backInFront = (await viewingReports()).at(-1);
    assert.deepEqual(backInFront?.sessionIds, [sessionId], 'back in front, the phone did not say so');
    checks.push('Home while the turn runs: the turn ends unwatched, a recap fork runs (trigger unattended) and shows as the writing line, then the card; back in front the phone reports the conversation');

    // ── On another screen: the list, then the feed ───────────────────────────────────────────────────────────────────
    await sendFromPhone('EZTERMINAL_E2E_HOLD:feed 조금 더 살펴봐 주세요.');
    await turnWorking(sessionId);
    await tapTestId('mobile-structured-agent-back');
    await waitForTestId('mobile-agent-view');
    await until('the phone saying nothing is open', async () => (await viewingReports()).at(-1)?.sessionIds.length === 0, 5_000);
    await openFeed();
    release('feed');
    await until('the recap for a turn that ended on the feed', async () => forks('recap').length === 2, 20_000);
    await until('that recap written', async () => (await latestRecap(sessionId, await newestTurn(sessionId)))?.state === 'complete', 15_000);
    const feedRow = `[data-testid="mobile-feed-conversation"][data-session="${sessionId}"]`;
    await waitFor(exists(feedRow), 'the conversation on the feed');
    await tapOnce(feedRow, 'the conversation on the feed');
    await waitFor(exists(onScreen(sessionId)), 'the conversation again');
    await waitFor(`document.querySelectorAll(${JSON.stringify(RECAP_CARD)}).length === 2`, 'two recaps');
    checks.push('leaving for the conversation list and the feed, the phone reports nothing open and the turn gets its recap');

    // ── A reconnect says it again ────────────────────────────────────────────────────────────────────────────────────
    await sendFromPhone('EZTERMINAL_E2E_HOLD:reconnect 조금만 더요.');
    await turnWorking(sessionId);
    const guessesBefore = forks('predict').length;
    await host.evaluate(() => window.ezterminal.setRemoteEnabled(false));
    await waitForTestId('mobile-reconnect-scrim');
    const offlineAt = await evaluateWebView<number>('Date.now()');
    await host.evaluate(() => window.ezterminal.setRemoteEnabled(true));
    await waitForTestIdHidden('mobile-reconnect-scrim', 45_000);
    await waitFor(`window.__viewingReports.some(function (report) { return report.at > ${String(offlineAt)} && report.sessionIds[0] === ${JSON.stringify(sessionId)}; })`, 'the report sent again after the reconnect', 5_000);
    const resent = (await viewingReports()).filter((report) => report.at > offlineAt);
    release('reconnect');
    await until('the turn after the reconnect', async () => (await turnsOf(sessionId)).done, 30_000);
    await until('its guess', async () => forks('predict').length > guessesBefore, 20_000);
    assert.equal(forks('recap').length, 2, 'a recap though the phone was back on the conversation');
    checks.push(`a reconnect mid-turn: ${String(resent.length)} report(s) after the new socket, the first ${String(resent[0]!.at - offlineAt)} ms after the bridge came back, and the turn gets a guess and no recap`);

    // ── A recap that fails ───────────────────────────────────────────────────────────────────────────────────────────
    writeFileSync(controlFile('fail-recap'), '');
    await sendFromPhone('EZTERMINAL_E2E_HOLD:failed 마지막으로 하나만 더요.');
    await turnWorking(sessionId);
    toBackground();
    await sleep(1_500);
    release('failed');
    await until('the failed recap', async () => (await latestRecap(sessionId, await newestTurn(sessionId)))?.state === 'failed', 20_000);
    rmSync(controlFile('fail-recap'));
    await toForeground(sessionId);
    await waitFor(`${attributeOf(RECAP_LINE, 'data-state')} === 'failed'`, 'the failure line');
    assert.match(await textOf(RECAP_LINE), /요약을 만들지 못했습니다 · 응답 없음/u);
    await scrollIntoView(RECAP_LINE, 'center');
    const writeAgain = await markButton(RECAP_LINE, '다시 만들기', 'recap-retry');
    await measure('요약 실패: 다시 만들기', writeAgain);
    await recordSpacing('요약 실패 줄', RECAP_LINE);
    await capture('06-recap-failed');
    await tapOnce(writeAgain, '다시 만들기');
    await waitFor(`!(${exists(RECAP_LINE)})`, 'the failure line replaced');
    await waitFor(`document.querySelectorAll(${JSON.stringify(RECAP_CARD)}).length === 3`, 'the recap written again');
    await assertNoWrapUpError('다시 만들기');
    checks.push('a recap that fails is the quiet line 요약을 만들지 못했습니다 · 응답 없음; 다시 만들기 from the phone writes it');

    // ── The AI stops and waits ───────────────────────────────────────────────────────────────────────────────────────
    await sendFromPhone('EZTERMINAL_E2E_HOLD:waiting EZTERMINAL_E2E_APPROVAL 폰 테스트를 돌려 주세요.');
    await turnWorking(sessionId);
    const recapsBeforeStop = forks('recap').length;
    toBackground();
    await sleep(1_500);
    release('waiting');
    await until('the recap of the stopped turn', async () => forks('recap').length === recapsBeforeStop + 1, 20_000);
    assert.equal(forks('recap').at(-1)?.stopped, true, 'a stopped turn\'s recap carries the note on what is open');
    const stoppedTurn = await newestTurn(sessionId);
    await until('that recap written', async () => (await latestRecap(sessionId, stoppedTurn))?.state === 'complete', 15_000);
    await toForeground(sessionId);
    const waitingCard = `${RECAP_CARD}[aria-label*="멈추고 답을 기다림"]`;
    await waitFor(exists(waitingCard), 'the card that waits');
    await waitFor(exists('[data-testid="chat-recap-answer"]'), '답하러 가기');
    await measure('요약: 답하러 가기', '[data-testid="chat-recap-answer"]');
    await scrollIntoView(waitingCard);
    await capture('07-recap-waiting');
    await tapOnce('[data-testid="chat-recap-answer"]', '답하러 가기');
    await waitFor(`!!document.activeElement && document.activeElement.hasAttribute('data-dock-primary')`, 'focus on the decision', 5_000);
    await measure('결정: 허용', '[data-dock-primary]');
    await capture('08-recap-answer-focus');
    await tapOnce('[data-dock-primary]', '허용');
    await waitFor(`!(${exists('[data-testid="chat-recap-answer"]')})`, '답하러 가기 gone once answered');
    await waitFor(exists(`${RECAP_CARD}[aria-label*="답을 기다렸던 턴"]`), 'the card no longer waits');
    await until('the turn after the answer', async () => (await turnsOf(sessionId)).done, 30_000);
    await sleep(4_000);
    assert.equal(forks('recap').length, recapsBeforeStop + 1, 'a second recap of one turn');
    checks.push('a turn stopped on an approval while the app was behind others gets one recap saying so; 답하러 가기 moves focus to the decision; answered, the card stops saying it waits and no second recap comes');

    // ── The task card under a full-access parent ─────────────────────────────────────────────────────────────────────
    await hostCommand(host, 'agent.set-settings', { sessionId, permissionPreset: 'full-access' });
    await until('the parent at full access', async () => (await snapshot())?.agents.find((agent) => agent.sessionId === sessionId)?.permissionPreset === 'full-access', 10_000);
    writeTasks('four', CART_TASKS);
    const turnsBeforeTasks = (await turnsOf(sessionId)).count;
    await sendFromPhone('EZTERMINAL_E2E_SUGGEST:four 둘러보면서 다른 문제도 알려 주세요.');
    await waitForTurns(sessionId, turnsBeforeTasks + 1, 'the turn that suggests four tasks');
    await waitFor(exists(TASK_CARD), 'the task card');
    // The guess comes 3 s after a turn and takes room above the box: until then a card can move under a tap.
    await waitFor(exists(CHIP), 'the guess for this turn');
    const four = await taskIds(sessionId, 'four', 4);
    const [first, second, third, fourth] = four.ids as [string, string, string, string];
    assert.equal(await evaluateWebView(`document.querySelectorAll(${JSON.stringify(`${TASK_CARD} [data-testid="chat-task"]`)}).length`), 4);
    assert.match(await textOf('[data-testid="chat-task-defaults"]'), /승인 후 실행 · 이 폴더 \(cart-kit\)/u, 'the line above the tasks does not say what one tap starts');
    await scrollIntoView(TASK_CARD);
    await recordColours('제안 작업 카드', TASK_CARD);
    await recordColours('제안 작업: 시작 버튼', taskAction(first, 'task-start'));
    await recordSpacing('제안 작업: 머리', `${taskRow(first)} .chat-task__head`);
    await recordSpacing('제안 작업: 기본값 줄', '[data-testid="chat-task-defaults"]');
    await recordSpacing('제안 작업: 버튼 줄', `${taskRow(first)} .chat-task__actions`);
    await capture('09-task-card');
    await measure('제안 작업: 보낼 지시 보기', `${taskRow(first)} [data-testid="chat-task-prompt-toggle"]`);
    await measure('제안 작업: 새 하위 대화로 시작', taskAction(first, 'task-start'));
    await measure('제안 작업: 여기서 하기', taskAction(first, 'task-here'));
    await measure('제안 작업: 무시', taskAction(first, 'task-dismiss'));
    await measure('제안 작업: 모두 시작', '[data-testid="chat-task-start-all"]');
    await capture('09b-task-actions');

    // A task the AI advises a worktree for: this phone cannot make one, says so, and still offers this folder.
    assert.equal(await evaluateWebView(exists(`${taskRow(fourth)} [data-testid="chat-task-worktree"]`)), true, 'no 워크트리 권장 chip');
    assert.match(await textOf(`${taskRow(fourth)} [data-testid="chat-task-worktree-desktop"]`), /새 워크트리는 데스크톱에서 고를 수 있습니다/u);
    assert.equal(await evaluateWebView(exists(taskAction(fourth, 'task-start'))), true, 'the phone offers no start for a worktree task');
    assert.equal(await evaluateWebView(exists(taskAction(fourth, 'task-start-custom'))), false, 'the phone offers a form it does not have');
    await scrollIntoView(taskRow(fourth));
    await recordSpacing('제안 작업: 워크트리 안내', `${taskRow(fourth)} .chat-task__note`);
    await recordColours('제안 작업: 워크트리 표시', `${taskRow(fourth)} [data-testid="chat-task-worktree"]`);
    await capture('10-task-worktree-note');
    checks.push('the card shows four tasks; the line above them says 승인 후 실행 · 이 폴더; the worktree task has its chip, the desktop note and one tap in this folder, no form');

    // The sheet: nothing starts until it is confirmed, and all of it in this folder.
    await tapOnce('[data-testid="chat-task-start-all"]', '모두 시작');
    await waitFor(exists(SHEET), 'the 모두 시작 sheet');
    assert.equal(await evaluateWebView(`document.querySelectorAll(${JSON.stringify(`${SHEET} [data-testid="task-start-all-task"]`)}).length`), 4);
    assert.equal(await evaluateWebView(`document.querySelectorAll(${JSON.stringify(`${SHEET} input[type="radio"]`)}).length`), 0, 'the phone offers a place to choose');
    assert.match(await textOf('[data-testid="task-start-all-phone"]'), /이 폴더 \(cart-kit\)에서 시작합니다/u);
    await measure('모두 시작: 시작', '[data-testid="task-start-all-submit"]');
    const cancel = await markButton(SHEET, '취소', 'start-all-cancel');
    await measure('모두 시작: 취소', cancel);
    await measure('모두 시작: 닫기 ×', `${SHEET} .ez-ui-icon-button`);
    await recordSpacing('모두 시작: 안내 줄', `${SHEET} .task-start-all__note`);
    await recordColours('모두 시작 시트', SHEET);
    await assertFits('모두 시작', SHEET);
    await capture('11-start-all-sheet');
    await tapOnce(cancel, '취소');
    await waitFor(`!(${exists(SHEET)})`, 'the sheet closed');
    assert.equal((await snapshot())?.agentRelations.filter((relation) => relation.parentSessionId === sessionId).length, 0, 'the sheet started something before it was confirmed');

    // What either button sends, word for word, then one tap.
    await tapOnce(`${taskRow(first)} [data-testid="chat-task-prompt-toggle"]`, '보낼 지시 보기');
    await waitFor(exists(`${taskRow(first)} [data-testid="chat-task-prompt"]`), 'the instruction');
    assert.equal(await textOf(`${taskRow(first)} .chat-task__prompt-text`), CART_TASKS[0]!.prompt);
    await capture('12-task-prompt');
    const childOf = (taskId: string): string => `suggested-${taskId}`;
    await tapOnce(taskAction(first, 'task-start'), '새 하위 대화로 시작');
    await waitFor(`${attributeOf(taskRow(first), 'data-outcome')} === 'started'`, 'the task started');
    await assertNoWrapUpError('새 하위 대화로 시작');
    await waitFor(`!!document.activeElement && document.activeElement.hasAttribute('data-task-title')`, 'focus on the title', 5_000);
    await waitForTurns(childOf(first), 1, 'the child\'s first turn');
    const facts = async (id: string) => {
      const state = await snapshot();
      return {
        parent: state?.agents.find((agent) => agent.sessionId === sessionId)?.permissionPreset,
        child: state?.agents.find((agent) => agent.sessionId === id)?.permissionPreset,
        workspace: state?.sessions.find((session) => session.id === id)?.workspaceId,
        relation: state?.agentRelations.find((relation) => relation.childSessionId === id),
      };
    };
    const started = await facts(childOf(first));
    assert.equal(started.parent, 'full-access');
    assert.equal(started.child, 'standard', 'the host did not hold a one-tap start to 승인 후 실행');
    assert.equal(started.workspace, cart.id, 'the child does not work in this folder');
    assert.equal(started.relation?.parentSessionId, sessionId);
    assert.equal(started.relation?.owner, 'managed');
    const thread2 = readJsonLines('ezterminal-e2e-codex-thread-starts.jsonl').at(-1)!;
    assert.notEqual(thread2.sandbox, 'danger-full-access');
    assert.notEqual(thread2.approvalPolicy, 'never');
    assert.ok(String(readJsonLines('ezterminal-e2e-codex-turns.jsonl').at(-1)!.input).includes('canAccess returns'), 'the child did not get the instruction');
    await scrollIntoView(taskRow(first));
    await capture('13-task-started');
    await measure('제안 작업: 하위 대화 열기', taskAction(first, 'open-child'));
    await tapOnce(taskAction(first, 'open-child'), '하위 대화 열기');
    await waitFor(exists(onScreen(childOf(first))), 'the child conversation');
    await capture('13b-child-conversation');
    // Back from a child goes to the feed, as from any conversation opened by its link.
    await openFeed();
    await tapOnce(feedRow, 'the parent on the feed');
    await waitFor(exists(onScreen(sessionId)), 'back in the parent');
    checks.push('새 하위 대화로 시작 from the phone: a managed child in this folder at 승인 후 실행 under a full-access parent; the card says so and opens it');

    // 여기서 하기
    await tapOnce(taskAction(second, 'task-here'), '여기서 하기');
    await waitFor(`${attributeOf(taskRow(second), 'data-outcome')} === 'sent'`, 'the task sent here');
    await assertNoWrapUpError('여기서 하기');
    await waitForTurns(sessionId, turnsBeforeTasks + 2, 'the turn it sent');
    await waitFor(exists(CHIP), 'the guess for this turn');
    const here = readJsonLines('ezterminal-e2e-codex-turns.jsonl').filter((entry) => entry.threadId === thread).at(-1)!;
    assert.ok(String(here.input).includes('Change `cents / 10` to `cents / 100`'), 'the conversation did not get the instruction');
    await scrollIntoView(taskRow(second));
    await capture('14-task-here');
    checks.push('여기서 하기 sends the instruction into this conversation on its own thread; the card says so');

    // 무시, 다시 열기
    await tapOnce(taskAction(third, 'task-dismiss'), '무시');
    await waitFor(`${attributeOf(taskRow(third), 'data-outcome')} === 'dismissed'`, 'the task dismissed');
    await assertNoWrapUpError('무시');
    await measure('제안 작업: 다시 열기', taskAction(third, 'task-reopen'));
    await scrollIntoView(taskRow(third));
    await capture('15-task-dismissed');
    await tapOnce(taskAction(third, 'task-reopen'), '다시 열기');
    await waitFor(`${attributeOf(taskRow(third), 'data-outcome')} === 'open'`, 'the task open again');
    await assertNoWrapUpError('다시 열기');
    checks.push('무시 from the phone is recorded on the host; 다시 열기 brings the task back');

    // 모두 시작, for what is left
    await tapOnce('[data-testid="chat-task-start-all"]', '모두 시작');
    await waitFor(exists(SHEET), 'the sheet for two tasks');
    assert.equal(await evaluateWebView(`document.querySelectorAll(${JSON.stringify(`${SHEET} [data-testid="task-start-all-task"]`)}).length`), 2);
    await tapOnce('[data-testid="task-start-all-submit"]', '2개 시작');
    await waitFor(`!(${exists(SHEET)})`, 'the sheet closed');
    for (const taskId of [third, fourth]) await waitFor(`${attributeOf(taskRow(taskId), 'data-outcome')} === 'started'`, 'a task from the sheet started');
    await assertNoWrapUpError('모두 시작');
    for (const taskId of [third, fourth]) {
      await waitForTurns(childOf(taskId), 1, 'a child from the sheet');
      const fact = await facts(childOf(taskId));
      assert.equal(fact.child, 'standard', 'the sheet\'s child is not held to 승인 후 실행');
      assert.equal(fact.workspace, cart.id, 'the sheet\'s child left this folder, worktree advice or not');
    }
    await scrollIntoView(TASK_CARD);
    await capture('16-start-all-done');
    checks.push('모두 시작 opens a sheet with this folder only, cancels with nothing started, and on confirmation starts each open task here at 승인 후 실행');

    // ── A start that failed: where it could be repeated ──────────────────────────────────────────────────────────────
    writeTasks('retry', CART_TASKS.slice(0, 2));
    const turnsBeforeRetry = (await turnsOf(sessionId)).count;
    await sendFromPhone('EZTERMINAL_E2E_SUGGEST:retry 한 번 더 살펴봐 주세요.');
    await waitForTurns(sessionId, turnsBeforeRetry + 1, 'the turn that suggests two tasks');
    await waitFor(exists(CHIP), 'the guess for this turn');
    const retry = await taskIds(sessionId, 'retry', 2);
    const [inWorktree, inFolder] = retry.ids as [string, string];
    // As a desktop writes them: a phone cannot try a worktree, so a failed one always arrives from there.
    const asked = { agent: { providerId: 'codex', permissionPreset: 'full-access' }, settings: 'Codex · 전체 권한' };
    await hostCommand(host, 'wrap-up.task-outcome', { sessionId, turnId: retry.turnId, taskId: inWorktree, outcome: 'start-failed', reason: '디스크 공간이 부족해 워크트리를 만들지 못했습니다.',
      start: { where: { kind: 'new-worktree', branch: 'suggest/fix-the-always-true-role-check' }, ...asked } });
    await hostCommand(host, 'wrap-up.task-outcome', { sessionId, turnId: retry.turnId, taskId: inFolder, outcome: 'start-failed', reason: '이 대화 아래 하위 대화는 10분에 12개까지 만들 수 있습니다.',
      start: { where: { kind: 'this-folder' }, ...asked } });
    await waitFor(`${attributeOf(taskRow(inWorktree), 'data-outcome')} === 'start-failed' && ${attributeOf(taskRow(inFolder), 'data-outcome')} === 'start-failed'`, 'both failures on the card');
    assert.equal(await evaluateWebView(exists(taskAction(inWorktree, 'task-retry'))), false, 'the phone offers to repeat a start in a new worktree');
    assert.equal(await evaluateWebView(exists(taskAction(inWorktree, 'task-start-custom'))), false, 'the phone offers a form it does not have');
    assert.equal(await evaluateWebView(exists(taskAction(inWorktree, 'task-dismiss'))), true);
    assert.match(await textOf(`${taskRow(inWorktree)} [data-testid="chat-task-worktree-desktop"]`), /새 워크트리는 데스크톱에서 고를 수 있습니다/u);
    assert.match(await textOf(`${taskRow(inWorktree)} [data-testid="chat-task-outcome"]`), /시작하지 못함 · 새 워크트리 suggest\/fix-the-always-true-role-check/u);
    assert.equal(await evaluateWebView(exists(taskAction(inFolder, 'task-retry'))), true, 'no 다시 시도 for a start in this folder');
    await scrollIntoView(taskRow(inWorktree));
    await recordSpacing('제안 작업: 실패 줄', `${taskRow(inWorktree)} .chat-task__outcome`);
    await capture('17-retry-where');
    await measure('제안 작업: 다시 시도', taskAction(inFolder, 'task-retry'));
    await tapOnce(taskAction(inFolder, 'task-retry'), '다시 시도');
    await waitFor(`${attributeOf(taskRow(inFolder), 'data-outcome')} === 'started'`, 'the retried task started');
    await assertNoWrapUpError('다시 시도');
    await waitForTurns(childOf(inFolder), 1, 'the retried child');
    assert.equal((await facts(childOf(inFolder))).child, 'standard', 'a start from a phone was not held to 승인 후 실행');
    await scrollIntoView(taskRow(inWorktree));
    await capture('17b-retried');
    checks.push('a start that failed in a new worktree shows the reason and the desktop note, no 다시 시도 or form; a start that failed in this folder has 다시 시도, and from a phone it runs at 승인 후 실행 though it asked for full access');

    // ── Another conversation on screen, and unbroken words at 360 px ─────────────────────────────────────────────────
    await sendFromPhone('EZTERMINAL_E2E_HOLD:behind 이 대화는 뒤에서 계속해 주세요.');
    await turnWorking(sessionId);
    const longProject = await addProject(host, longRoot, LONG_FOLDER);
    await tapTestId('mobile-structured-agent-back');
    await openFeed();
    await tapTestId('mobile-feed-new');
    writeTasks('long', LONG_TASKS);
    setReply('recap', `\`${LONG_PATH}\`\n${LONG_WORD}\n짧은 줄.`);
    setReply('predict', `${LONG_PATH}${LONG_WORD}`);
    await draftIn(longProject.id, '긴 이름을 살펴봐 주세요. EZTERMINAL_E2E_SUGGEST:long');
    const other = await firstAgent(sessionId);
    await waitForTurns(other.sessionId, 1, 'the second conversation');
    await waitFor(exists(onScreen(other.sessionId)), 'the second conversation on screen');
    const recapsBeforeBehind = forks('recap').length;
    release('behind');
    await until('the recap of the conversation behind', async () => forks('recap').length === recapsBeforeBehind + 1, 20_000);
    await sleep(4_000);
    assert.equal(forks('recap').length, recapsBeforeBehind + 1);
    assert.deepEqual(await recapRows(other.sessionId), [], 'the conversation on screen got a recap');
    checks.push('with a second conversation open, the first ends behind it: only the first gets a recap');

    const long = await taskIds(other.sessionId, 'long', 3);
    const [longFirst, longSecond, longThird] = long.ids as [string, string, string];
    await hostCommand(host, 'wrap-up.task-outcome', { sessionId: other.sessionId, turnId: long.turnId, taskId: longThird, outcome: 'start-failed', reason: `${LONG_PATH}: ${LONG_WORD}`,
      start: { where: { kind: 'new-worktree', branch: LONG_BRANCH }, agent: { providerId: 'codex', permissionPreset: 'standard' }, settings: `Codex · ${LONG_WORD}` } });
    await waitFor(`${attributeOf(taskRow(longThird), 'data-outcome')} === 'start-failed'`, 'the long failure');
    await tapOnce(`${taskRow(longFirst)} [data-testid="chat-task-prompt-toggle"]`, '보낼 지시 보기');
    await waitFor(exists(`${taskRow(longFirst)} [data-testid="chat-task-prompt"]`), 'the long instruction');
    const card = await evaluateWebView<{ readonly viewport: number; readonly wrap: string; readonly anywhere: boolean; readonly lines: number }>(`(function () {
      var title = document.querySelector(${JSON.stringify(`${taskRow(longFirst)} .chat-task__title`)});
      return { viewport: window.innerWidth, wrap: getComputedStyle(title).overflowWrap, anywhere: CSS.supports('overflow-wrap', 'anywhere'),
        lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)) };
    })()`);
    assert.equal(card.viewport, 360, 'this run is not at 360 px');
    assert.ok(card.lines >= 3, `the long title does not wrap: ${JSON.stringify(card)}`);
    await assertFits('긴 제안 작업', TASK_CARD);
    await scrollIntoView(TASK_CARD);
    await capture('18-long-words');
    await scrollIntoView(`${taskRow(longFirst)} [data-testid="chat-task-prompt"]`);
    await capture('18b-long-prompt');
    await scrollIntoView(taskRow(longSecond));
    await capture('18c-long-identifier');
    await scrollIntoView(taskRow(longThird));
    await capture('18d-long-failure');
    await tapOnce('[data-testid="chat-task-start-all"]', '모두 시작');
    await waitFor(exists(SHEET), 'the sheet with long words');
    await assertFits('긴 모두 시작', SHEET);
    await capture('19-long-words-sheet');
    await tapOnce(await markButton(SHEET, '취소', 'long-cancel'), '취소');
    await waitFor(`!(${exists(SHEET)})`, 'the long sheet closed');

    // The recap and the chip with the same unbroken words.
    await sendFromPhone('EZTERMINAL_E2E_HOLD:long 긴 요약도 보여 주세요.');
    await turnWorking(other.sessionId);
    toBackground();
    await sleep(1_500);
    release('long');
    await until('the long recap', async () => (await latestRecap(other.sessionId, await newestTurn(other.sessionId)))?.state === 'complete', 20_000);
    await toForeground(other.sessionId);
    await waitFor(exists(RECAP_CARD), 'the long recap card');
    await waitFor(exists(CHIP), 'the long chip');
    await assertFits('긴 요약', RECAP_CARD);
    await assertChipEllipsis();
    await scrollIntoView(RECAP_CARD);
    await capture('20-long-recap');
    checks.push(`at ${String(card.viewport)} px with overflow-wrap ${card.wrap} (anywhere ${card.anywhere ? 'supported' : 'unsupported'}): an unbroken path, identifier, instruction, folder, branch and failure reason wrap inside the card, the sheet and the recap, and the chip ends in an ellipsis`);

    const environment = await evaluateWebView<{ readonly userAgent: string; readonly flexGap: string | null; readonly lang: string; readonly theme: string | undefined; readonly viewport: string; readonly colorMix: boolean }>(`({
      userAgent: navigator.userAgent, flexGap: document.documentElement.getAttribute('data-ui-flex-gap'), lang: document.documentElement.lang, theme: document.documentElement.dataset.theme,
      viewport: window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio, colorMix: CSS.supports('color', 'color-mix(in srgb, red, blue)') })`);
    assert.equal(environment.theme, THEME);
    const small = targets.filter((target) => target.width < 44 || target.height < 44);
    const lostGaps = Object.entries(spacing).filter(([, value]) => value !== null && value <= 0);
    const invisible = Object.entries(colours).filter(([, value]) => value.color === 'rgba(0, 0, 0, 0)' || !value.color);
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({
      ok: small.length === 0 && lostGaps.length === 0 && invisible.length === 0, androidApi, provider: 'deterministic Codex fixture', environment, desktop: desktopAtStart,
      claimedAfterTurnStartMs, forks: { predict: forks('predict').length, recap: forks('recap').length }, checks, spacing, colours, touchTargets: targets, screenshots: shots,
    }, null, 2));
    assert.deepEqual(small, [], `touch targets under 44px: ${JSON.stringify(small)}`);
    assert.deepEqual(lostGaps, [], `spacing lost: ${JSON.stringify(lostGaps)}`);
    assert.deepEqual(invisible, [], `colours lost: ${JSON.stringify(invisible)}`);
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    const reports = await evaluateWebView<unknown>(`({ visibility: document.visibilityState, now: Date.now(), clicks: (window.__clicks || []).slice(-6), reports: window.__viewingReports })`).catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${JSON.stringify(reports)}\n${text}`);
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
