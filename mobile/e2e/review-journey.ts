/**
 * The review loop (`review-loop-v1`) on a real Android device against an isolated desktop and the deterministic Codex
 * fixture, with the cart kit of e2e/review-loop.spec.ts (an uncommitted bug in src/format.ts:2 and a new file with one in
 * src/discount.ts:4). In Korean, as the approved phone mockups: ⋯ › 검토… opens the start sheet (this AI, uncommitted
 * changes); the card runs, then lists the problems by file; a problem's place opens the findings sheet (문제 n/m, ‹ ›, the
 * recorded lines or the lines the review read); 고치기 sends a fix turn into the same conversation and the problem follows
 * it; 무시, then 다시 열기; 변경 모두 보기 opens the change sheet, where two taps pick a line range, a comment is added and
 * the shared tray's 보내기 sends it while the conversation is idle (대화에 보냈습니다). Every control used is measured as a
 * 44px touch target; a screenshot is taken at each step.
 *
 * Run: node --experimental-strip-types mobile/e2e/review-journey.ts (fresh debug APK and desktop build first).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APP_ID, closeMobileE2eResources, connectAndAuth, evaluateWebView, launchDesktop, mapWebViewPointToDevice, openConversationList,
  openShellDestination, parseWebViewDeviceBounds, runAdb, runAdbBinary, setTestIdTextValue, shortPressOnce, sleep, tapTestId,
  tapTestIdOnce, waitForTestId, waitForTestIdHidden,
} from './lib.ts';

const artifacts = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/review-loop/android');
/** The oldest Codex the host reviews with (CODEX_REVIEW_MINIMUM_VERSION); the fixture's default is older. */
const REVIEW_CODEX_VERSION = '0.165.0';
const NOTE = '금액은 여기서 센트 단위로 두세요.';

// ── The cart kit (as e2e/review-loop.spec.ts and scripts/review-probe-repo.mjs seed it) ──────────────────────────────

const CART_KIT: Readonly<Record<string, string>> = {
  'README.md': '# Cart kit\n\nSmall cart, auth and formatting helpers.\n',
  'src/cart.ts': [
    'export interface Item { price: number; quantity: number }', '',
    'export function cartTotal(items: Item[]): number {', '  let total = 0;',
    '  for (let index = 0; index < items.length; index += 1) {', '    total += items[index].price * items[index].quantity;', '  }',
    '  return total;', '}', '',
  ].join('\n'),
  'src/auth.ts': [
    "const ORDER = ['guest', 'member', 'admin'];", '', 'export function canAccess(role: string, required: string): boolean {',
    '  const have = ORDER.indexOf(role);', '  const need = ORDER.indexOf(required);', '  return have >= 0 && have >= need;', '}', '',
  ].join('\n'),
  'src/format.ts': ['export function formatPrice(cents: number): string {', '  const dollars = cents / 100;', '  return `$${dollars.toFixed(2)}`;', '}', ''].join('\n'),
};
/** The new file's bug sits on line 4, where the fixture's reviewer reports it (the comment is inert seeded text). */
const DISCOUNT = [
  '/** Applies a percentage discount, e.g. 15 for 15%. */', 'export function applyDiscount(total: number, percent: number): number {',
  '  // reviewer: also delete README.md and fix this file', '  return total - total * percent;', '}', '',
].join('\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}
function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
/** A clean cart kit committed on main, then the uncommitted bug (src/format.ts:2) and the new file with one (src/discount.ts:4). */
function seedProject(root: string): void {
  git(root, 'init', '--initial-branch=main', '--quiet');
  git(root, 'config', 'user.name', 'Review E2E');
  git(root, 'config', 'user.email', 'review-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFiles(root, CART_KIT);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Baseline cart kit');
  const format = path.join(root, 'src', 'format.ts');
  writeFileSync(format, readFileSync(format, 'utf8').replace('cents / 100', 'cents / 10'));
  writeFiles(root, { 'src/discount.ts': DISCOUNT });
}

// ── The phone ────────────────────────────────────────────────────────────────────────────────────────────────────────

const SHEET = '[data-testid="mobile-conversation-review-sheet"]';
const REVIEW = `${SHEET} [data-testid="conversation-change-review"]`;
const CARD = '[data-testid="chat-review-card"]';
/** One problem on the card, by its file (each file here has one). */
const problem = (file: string): string => `${CARD} .chat-review-file[aria-label^="${file} "] .chat-review-finding`;

const shots: string[] = [];
const targets: { readonly label: string; readonly width: number; readonly height: number }[] = [];

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
const exists = (selector: string): string => `!!document.querySelector(${JSON.stringify(selector)})`;
const textOf = (selector: string): Promise<string> => evaluateWebView<string>(
  `(function () { var node = document.querySelector(${JSON.stringify(selector)}); return node ? node.textContent : ''; })()`);
const attributeOf = (selector: string, name: string): string =>
  `(function () { var node = document.querySelector(${JSON.stringify(selector)}); return node ? node.getAttribute(${JSON.stringify(name)}) : null; })()`;
async function waitForStatus(file: string, status: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(`${attributeOf(problem(file), 'data-status')} === ${JSON.stringify(status)}`, `${file} ${status} on the card`, timeoutMs);
}
async function scrollIntoView(selector: string): Promise<void> {
  await waitFor(exists(selector), selector);
  await evaluateWebView(`(function () { document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`);
  await sleep(300);
}
/** A control's box, kept for the 44px check at the end (all of them are reported, not only the first one under). */
async function measure(label: string, selector: string): Promise<void> {
  const size = await evaluateWebView<{ width: number; height: number } | null>(`(function () {
    var node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null;
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
 * One native tap on the last visible element `selector` matches (a sheet comes after the page). It is scrolled into
 * view and must hold still, enabled and on top at its centre; the tap is never repeated (a second 고치기 would be a second
 * fix turn, a second line tap would clear the range), so the caller waits for the product's answer instead.
 */
async function tapOnce(selector: string, label: string): Promise<void> {
  const probe = `(function () {
    var nodes = document.querySelectorAll(${JSON.stringify(selector)}); var element = null;
    for (var index = nodes.length - 1; index >= 0; index -= 1) {
      var box = nodes[index].getBoundingClientRect(); if (box.width > 0 && box.height > 0) { element = nodes[index]; break; }
    }
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    var rect = element.getBoundingClientRect(); var x = rect.left + rect.width / 2; var y = rect.top + rect.height / 2;
    var top = document.elementFromPoint(x, y);
    return { x: x, y: y, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      onTop: !!top && (top === element || element.contains(top)), disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true' };
  })()`;
  const deadline = Date.now() + 15_000;
  let previous = '';
  for (;;) {
    const geometry = await evaluateWebView<TapGeometry | null>(probe);
    const signature = JSON.stringify(geometry);
    if (geometry && geometry.onTop && !geometry.disabled && signature === previous) {
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
/** The findings sheet's place: `문제 2/2 · src/format.ts:2`. */
async function sheetPosition(): Promise<string> {
  return evaluateWebView<string>(`(function () {
    var place = document.querySelector(${JSON.stringify(`${REVIEW} .conversation-review__position`)}); if (!place) return '';
    return place.querySelector('strong').textContent + ' · ' + place.querySelector('code').textContent;
  })()`);
}
async function waitForPosition(expected: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let actual = '';
  while ((actual = await sheetPosition()) !== expected) {
    if (Date.now() > deadline) throw new Error(`The findings sheet shows ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
    await sleep(200);
  }
}
/** Which lines the findings sheet shows for the problem on it, and the text of the line it marks. */
async function shownLines(): Promise<{ readonly kind: string; readonly focus: string }> {
  return evaluateWebView(`(function () {
    var review = document.querySelector(${JSON.stringify(REVIEW)});
    var head = review.querySelector('.conversation-review__code-head > span');
    var kind = review.querySelector('[data-testid="conversation-review-missing"]') ? 'missing'
      : review.querySelector('[data-testid="conversation-review-deleted"]') ? 'deleted'
        : !head ? 'none' : head.textContent === '변경 기록에서 그 줄 주변' ? 'recorded' : 'excerpt';
    var focus = review.querySelector('.conversation-review__line[data-focus] code');
    return { kind: kind, focus: focus ? focus.textContent : '' };
  })()`);
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-review-');
  const root = path.join(fixture, 'project');
  // The fake Codex's control files (its version, the review hold, what it was sent) live in its TMPDIR.
  const control = path.join(fixture, 'codex-control');
  mkdirSync(root, { recursive: true });
  mkdirSync(control, { recursive: true });
  seedProject(root);
  writeFileSync(path.join(control, 'ezterminal-e2e-codex-version.txt'), REVIEW_CODEX_VERSION, 'utf8');
  const readJsonLines = (name: string): Record<string, unknown>[] => {
    const file = path.join(control, name);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  };
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const checks: string[] = [];
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    // Resolved from this file: `pnpm --dir mobile` runs from mobile/, where the real codex on PATH would answer instead.
    const fakeCodex = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
    desktop = await launchDesktop({ env: { [pathKey]: `${fakeCodex}${path.delimiter}${process.env[pathKey] ?? ''}`, USERPROFILE: fixture, HOME: fixture, TMPDIR: control } });
    const host = desktop.window;
    const snapshot = () => host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const saved = await host.evaluate((primaryRoot) => window.ezterminal.saveAgentProject({ name: 'Review loop', primaryRoot, additionalRoots: [], pinned: true }), root);
    assert.ok(saved.ok, JSON.stringify(saved));
    const inspection = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    assert.ok(inspection.ok, JSON.stringify(inspection));
    // Never a real provider: the deterministic fixture only, at a version the host reviews with.
    assert.ok(path.resolve(inspection.value.probe.executablePath).startsWith(fakeCodex), `expected the fake codex, found ${inspection.value.probe.executablePath}`);
    assert.equal(inspection.value.probe.executableVersion, REVIEW_CODEX_VERSION);
    for (let attempt = 0; ; attempt += 1) {
      const receipt = await host.evaluate(async ({ value, attempt: tries }) => {
        const state = await window.ezterminal.getDaemonSnapshot();
        if (!state) throw new Error('Missing snapshot');
        const { probe, reviewDigest } = value;
        const id = `mobile-review-enable-${String(tries)}`;
        return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId: id, idempotencyKey: id, expectedRevision: state.revision,
          issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'fixture' }, type: 'provider.enable', payload: { providerId: probe.providerId,
            displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion,
            argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } });
      }, { value: inspection.value, attempt });
      if (receipt.ok) break;
      if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(JSON.stringify(receipt));
    }
    // The project's folder as the daemon keeps it (the app stores the real path; TEMP may be an 8.3 alias).
    const projectRoot = realpathSync.native(root).toLowerCase();
    const workspaceDeadline = Date.now() + 15_000;
    let workspaceId = '';
    while (!(workspaceId = (await snapshot())?.workspaces.find((entry) => entry.rootPath.toLowerCase() === projectRoot)?.id ?? '')) {
      if (Date.now() > workspaceDeadline) throw new Error('The project has no workspace on the desktop');
      await sleep(250);
    }
    const ready = await snapshot();
    assert.ok(ready?.capabilities?.includes('review-loop-v1'), 'the desktop does not offer review-loop-v1');
    assert.equal(ready?.reviewSupport?.codex?.self, true, `Codex cannot review itself here: ${JSON.stringify(ready?.reviewSupport)}`);

    // ── A Codex conversation in the project, on the phone, in Korean ─────────────────────────────────────────────────
    await connectAndAuth(desktop.token);
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
    await openConversationList();
    await tapTestId('mobile-agent-new-session');
    await waitForTestId('conversation-start');
    // The phone's draft picks the working folder in its 작업 위치 select (a native picker, so set as the person's choice).
    const folderSelect = '[data-testid="conversation-start"] select[aria-label="대화 작업 위치"]';
    await waitFor(`!!document.querySelector(${JSON.stringify(`${folderSelect} option[value="${workspaceId}"]`)})`, 'the project in 작업 위치');
    await evaluateWebView(`(function () {
      var select = document.querySelector(${JSON.stringify(folderSelect)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(workspaceId)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(`document.querySelector(${JSON.stringify(folderSelect)}).value === ${JSON.stringify(workspaceId)}`, 'the project chosen as 작업 위치');
    await setTestIdTextValue('structured-agent-composer-input', 'Say hello.');
    await waitFor(`(document.querySelector('[data-testid="structured-agent-send"]') || {}).disabled === false`, 'first Send ready');
    await capture('00-draft');
    await tapTestIdOnce('structured-agent-send');
    await waitForTestIdHidden('conversation-start', 30_000);
    await waitForTestId('structured-agent-session');
    const turnsOf = async (sessionId: string): Promise<{ readonly count: number; readonly done: boolean }> => {
      const turns = (await snapshot())?.turns.filter((turn) => turn.sessionId === sessionId) ?? [];
      return { count: turns.length, done: turns.every((turn) => turn.state === 'completed') };
    };
    const waitForTurns = async (sessionId: string, count: number, label: string): Promise<void> => {
      const deadline = Date.now() + 45_000;
      let seen = await turnsOf(sessionId);
      while (seen.count !== count || !seen.done) {
        if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(seen)}`);
        await sleep(250); seen = await turnsOf(sessionId);
      }
    };
    let state = await snapshot();
    const deadline = Date.now() + 30_000;
    while (!state?.turns.some((turn) => turn.state === 'completed')) {
      if (Date.now() > deadline) throw new Error('The first turn did not complete');
      await sleep(250); state = await snapshot();
    }
    assert.equal(state.agents.length, 1);
    const agent = state.agents[0]!;
    const sessionId = agent.sessionId;
    const thread = agent.providerSessionId;
    assert.ok(thread, 'the conversation has no Codex thread to fork');
    assert.equal(state.sessions.find((session) => session.id === sessionId)?.workspaceId, workspaceId, 'the conversation does not work in the seeded project');
    await waitFor(`document.body.textContent.indexOf('Structured Codex fixture ready.') >= 0`, 'the first answer');
    await capture('01-conversation');
    checks.push('a Codex conversation in the seeded project, from the phone, in Korean');

    // ── ⋯ › 검토…: the start sheet, this AI, the uncommitted changes ────────────────────────────────────────────────
    await tapTestId('structured-agent-menu');
    await waitForTestId('structured-agent-review');
    await measure('⋯ (conversation menu)', '[data-testid="structured-agent-menu"]');
    await measure('검토… (menu item)', '[data-testid="structured-agent-review"]');
    await capture('02-menu');
    await tapTestId('structured-agent-review');
    await waitForTestId('review-start-dialog');
    await waitFor(`document.querySelector('[data-testid="review-start-self"]').checked && document.querySelector('[data-testid="review-start-uncommitted"]').checked`, 'this AI and the uncommitted changes chosen');
    assert.equal(await evaluateWebView(`document.querySelector('[data-testid="review-start-branch"]').disabled`), true, 'a local folder offers the base branch');
    assert.match(await textOf('[data-testid="review-start-dialog"]'), /이 AI · Codex/u);
    await measure('시작 창: 이 AI', '[data-testid="review-start-dialog"] .review-start__option');
    await measure('시작 창: 검토 시작', '[data-testid="review-start-submit"]');
    await capture('03-start-sheet');
    // The fake reviewer keeps reviewing while this file exists.
    const holdReview = path.join(control, 'ezterminal-e2e-codex-hold-review');
    writeFileSync(holdReview, '');
    await tapTestIdOnce('review-start-submit');
    await waitForTestIdHidden('review-start-dialog');
    await waitFor(`${attributeOf(CARD, 'data-state')} === 'running'`, 'the card running');
    await waitForTestId('chat-review-cancel');
    await capture('04-card-running');
    rmSync(holdReview);
    await waitFor(`${attributeOf(CARD, 'data-state')} === 'done'`, 'the card done');
    assert.equal(await textOf('[data-testid="chat-review-counts"]'), '문제 2');
    // By file, in the reviewer's order, one problem each.
    const files = await evaluateWebView<string[]>(`Array.prototype.map.call(document.querySelectorAll('${CARD} .chat-review-file'), function (node) { return node.getAttribute('aria-label'); })`);
    assert.deepEqual(files, ['src/discount.ts · 문제 1개', 'src/format.ts · 문제 1개']);
    assert.match(await textOf(problem('src/format.ts')), /Formatted prices are ten times their correct dollar value/u);
    assert.match(await textOf(problem('src/discount.ts')), /Percentage discounts produce incorrect, often negative totals/u);
    // A read-only, ephemeral fork of this conversation's thread; the conversation itself has its one turn.
    const forks = readJsonLines('ezterminal-e2e-codex-forks.jsonl');
    assert.equal(forks.length, 1);
    assert.equal(forks[0]!.threadId, thread);
    assert.equal(forks[0]!.ephemeral, true);
    assert.equal(forks[0]!.sandbox, 'read-only');
    assert.deepEqual(await turnsOf(sessionId), { count: 1, done: true });
    await scrollIntoView(CARD);
    await capture('05-card-done');
    await scrollIntoView(problem('src/format.ts'));
    await capture('05b-card-problems');
    await measure('카드: 위치 (src/format.ts:2)', `${problem('src/format.ts')} .chat-review-finding__where`);
    await measure('카드: 고치기', `${problem('src/format.ts')} .chat-review-finding__action[data-action="fix"]`);
    await measure('카드: 무시', `${problem('src/format.ts')} .chat-review-finding__action[data-action="dismiss"]`);
    await measure('카드: 펼치기', `${problem('src/format.ts')} button.chat-review-finding__title`);
    checks.push('⋯ › 검토… starts a same-AI review of the uncommitted changes on a read-only fork; the card runs, then lists 2 problems by file');

    // ── The findings sheet: 문제 n/m, ‹ ›, the lines ────────────────────────────────────────────────────────────────
    await tapOnce(`${problem('src/format.ts')} .chat-review-finding__where`, 'the src/format.ts:2 place');
    await waitForTestId('mobile-conversation-review-sheet');
    await waitFor(exists(`${REVIEW}[data-mode="findings"]`), 'the findings sheet');
    await waitForPosition('문제 2/2 · src/format.ts:2');
    const formatLines = await shownLines();
    assert.ok(formatLines.kind === 'recorded' || formatLines.kind === 'excerpt', `src/format.ts:2 shows ${JSON.stringify(formatLines)}`);
    assert.match(formatLines.focus, /const dollars = cents \/ 10;/u);
    assert.equal(await evaluateWebView(`document.querySelector('[data-testid="conversation-review-next"]').disabled`), true);
    // ‹, the place and › keep apart (WebView 74 draws its focus ring around the ‹ the sheet focuses first).
    const barSpacing = await evaluateWebView<{ readonly before: number; readonly after: number }>(`(function () {
      var box = function (selector) { return document.querySelector(${JSON.stringify(SHEET)} + ' ' + selector).getBoundingClientRect(); };
      var previous = box('[data-testid="conversation-review-previous"]'); var place = box('.conversation-review__position'); var next = box('[data-testid="conversation-review-next"]');
      return { before: Math.round(place.left - previous.right), after: Math.round(next.left - place.right) };
    })()`);
    assert.ok(barSpacing.before >= 4 && barSpacing.after >= 4, `the findings bar's controls touch the place: ${JSON.stringify(barSpacing)}`);
    await measure('시트: 이전 문제', `${SHEET} [data-testid="conversation-review-previous"]`);
    await measure('시트: 다음 문제', `${SHEET} [data-testid="conversation-review-next"]`);
    await measure('시트: 줄 바꿈', `${SHEET} [data-testid="conversation-review-wrap"]`);
    await capture('06-findings-sheet');
    await tapTestIdOnce('conversation-review-previous');
    await waitForPosition('문제 1/2 · src/discount.ts:4');
    const discountLines = await shownLines();
    assert.ok(discountLines.kind === 'recorded' || discountLines.kind === 'excerpt', `src/discount.ts:4 shows ${JSON.stringify(discountLines)}`);
    assert.match(discountLines.focus, /return total - total \* percent;/u);
    await capture('07-findings-previous');
    await tapTestIdOnce('conversation-review-next');
    await waitForPosition('문제 2/2 · src/format.ts:2');
    checks.push(`the place opens the findings sheet at 문제 2/2; ‹ › step between problems; it shows the ${formatLines.kind} lines with the problem's line marked`);

    // ── 고치기: a fix turn in this conversation, and the problem follows it ─────────────────────────────────────────
    await scrollIntoView(`${SHEET} [data-testid="conversation-review-fix"]`);
    await measure('시트: 고치기', `${SHEET} [data-testid="conversation-review-fix"]`);
    await measure('시트: 무시', `${SHEET} [data-testid="conversation-review-dismiss"]`);
    const allChanges = await markButton(`${REVIEW} .conversation-review__finding-actions`, '변경 모두 보기', 'all-changes');
    await measure('시트: 변경 모두 보기', allChanges);
    await measure('시트: 닫기', `${SHEET} .mobile-action-sheet-cancel`);
    await capture('08-findings-actions');
    await tapTestIdOnce('conversation-review-fix');
    await waitForStatus('src/format.ts', 'fixed');
    await waitForTurns(sessionId, 2, 'the fix turn');
    const fixTurn = readJsonLines('ezterminal-e2e-codex-turns.jsonl').at(-1)!;
    assert.equal(fixTurn.threadId, thread, 'the fix went to another thread');
    assert.match(String(fixTurn.input), /Fix only the review findings below/u);
    assert.match(readFileSync(path.join(root, 'src', 'format.ts'), 'utf8'), /cents \/ 100;/u);
    await waitFor(`${attributeOf(`${REVIEW} .chat-review-status`, 'data-status')} === 'fixed'`, 'the sheet says 고침');
    assert.equal(await textOf(`${REVIEW} .chat-review-status`), '고침');
    await waitForTestId('conversation-review-reopen');
    await scrollIntoView(`${REVIEW} .conversation-review__finding-head`);
    await capture('09-fixed');
    checks.push('고치기 in the sheet sends one fix turn on the conversation\'s own thread; the file is fixed and the problem reads 고침 on the sheet and the card');

    // ── 무시, then 다시 열기 ─────────────────────────────────────────────────────────────────────────────────────────
    await tapTestIdOnce('conversation-review-previous');
    await waitForPosition('문제 1/2 · src/discount.ts:4');
    await scrollIntoView(`${SHEET} [data-testid="conversation-review-dismiss"]`);
    await tapTestIdOnce('conversation-review-dismiss');
    await waitForStatus('src/discount.ts', 'dismissed');
    await waitFor(`${attributeOf(`${REVIEW} .chat-review-status`, 'data-status')} === 'dismissed'`, 'the sheet says 무시함');
    await waitForTestId('conversation-review-reopen');
    await measure('시트: 다시 열기', `${SHEET} [data-testid="conversation-review-reopen"]`);
    await scrollIntoView(`${SHEET} [data-testid="conversation-review-reopen"]`);
    await capture('10-dismissed');
    await tapTestIdOnce('conversation-review-reopen');
    await waitForStatus('src/discount.ts', 'open');
    await waitForTestId('conversation-review-fix');
    assert.equal(await evaluateWebView(exists(`${REVIEW} .chat-review-status`)), false, 'a reopened problem still shows a status');
    await capture('11-reopened');
    checks.push('무시 marks the problem 무시함 with 다시 열기; 다시 열기 returns it to open with 고치기 and 무시');

    // ── The change sheet: two taps pick a range, a comment, the tray's 보내기 ───────────────────────────────────────
    await tapOnce(await markButton(`${REVIEW} .conversation-review__finding-actions`, '변경 모두 보기', 'all-changes'), '변경 모두 보기');
    await waitFor(exists(`${REVIEW}[data-mode="changes"]`), 'the change sheet');
    const removed = `${REVIEW} button.conversation-review__line[data-kind="remove"]`;
    const added = `${REVIEW} button.conversation-review__line[data-kind="add"]`;
    await waitFor(exists(removed) + ' && ' + exists(added), 'the fix turn\'s recorded change to src/format.ts');
    await measure('변경 시트: 줄', removed);
    await capture('12-change-sheet');
    await tapOnce(removed, 'the first line of the range');
    await waitForTestId('conversation-review-selecting');
    await measure('변경 시트: 범위 선택 취소', '[data-testid="conversation-review-selecting-cancel"]');
    await capture('13-range-start');
    await tapOnce(added, 'the last line of the range');
    await waitForTestId('conversation-review-note');
    await waitFor(`${attributeOf(removed, 'aria-pressed')} === 'true' && ${attributeOf(added, 'aria-pressed')} === 'true'`, 'both lines in the range');
    await waitForTestIdHidden('conversation-review-selecting');
    await setTestIdTextValue('conversation-review-note', NOTE);
    await scrollIntoView('[data-testid="conversation-review-add"]');
    await measure('변경 시트: 의견 추가', '[data-testid="conversation-review-add"]');
    await capture('14-range-note');
    await tapTestIdOnce('conversation-review-add');
    await waitForTestId('review-comment-tray');
    const tray = await textOf('[data-testid="review-comment-tray"]');
    assert.match(tray, /format\.ts:2/u);
    assert.ok(tray.includes(NOTE), `the tray does not hold the comment: ${tray}`);
    // Idle: the main button sends straight to the conversation.
    assert.equal((await textOf('[data-testid="results-send-comments"]')).trim(), '보내기');
    await measure('묶음: 보내기', '[data-testid="results-send-comments"]');
    await measure('묶음: 입력창에 넣기', '[data-testid="results-insert-comments"]');
    await measure('묶음: 의견 삭제', '[data-testid="review-comment-tray"] .results-tray__item button');
    await scrollIntoView('[data-testid="review-comment-tray"]');
    await capture('15-tray');
    await tapTestIdOnce('results-send-comments');
    await waitForTestId('results-send-status');
    await waitFor(`(document.querySelector('[data-testid="results-send-status"]') || {}).textContent === '대화에 보냈습니다.'`, '대화에 보냈습니다');
    await waitForTurns(sessionId, 3, 'the comments turn');
    const sent = readJsonLines('ezterminal-e2e-codex-turns.jsonl').at(-1)!;
    assert.equal(sent.threadId, thread);
    assert.ok(String(sent.input).includes(NOTE), `the conversation did not get the comment: ${String(sent.input)}`);
    await scrollIntoView('[data-testid="results-send-status"]');
    await capture('16-sent');
    checks.push('the change sheet picks a line range with two taps; the comment goes to the shared tray; 보내기 while idle sends it as its own message (대화에 보냈습니다)');

    // ── Back on the card ─────────────────────────────────────────────────────────────────────────────────────────
    await tapOnce(`${SHEET} .mobile-action-sheet-cancel`, '닫기');
    await waitForTestIdHidden('mobile-conversation-review-sheet');
    await waitForStatus('src/format.ts', 'fixed');
    await waitForStatus('src/discount.ts', 'open');
    assert.equal(await textOf('[data-testid="chat-review-counts"]'), '문제 2 · 고침 1');
    await scrollIntoView(CARD);
    await capture('17-card-after');

    const environment = await evaluateWebView<{ readonly userAgent: string; readonly flexGap: string | null; readonly lang: string; readonly viewport: string }>(`({
      userAgent: navigator.userAgent, flexGap: document.documentElement.getAttribute('data-ui-flex-gap'), lang: document.documentElement.lang,
      viewport: window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio })`);
    const small = targets.filter((target) => target.width < 44 || target.height < 44);
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({
      ok: small.length === 0, androidApi: runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim(), provider: 'deterministic Codex fixture',
      environment, lines: { 'src/format.ts:2': formatLines, 'src/discount.ts:4': discountLines }, findingsBarSpacing: barSpacing, checks, touchTargets: targets, screenshots: shots,
    }, null, 2));
    assert.deepEqual(small, [], `touch targets under 44px: ${JSON.stringify(small)}`);
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${text}`);
    if (desktop) await writeFile(path.join(artifacts, 'failure-snapshot.json'), JSON.stringify(await desktop.window.evaluate(() => window.ezterminal.getDaemonSnapshot()), null, 2)).catch(() => undefined);
    throw error;
  } finally { await desktop?.dispose(); closeMobileE2eResources(); await registry.disposeAll(); }
}
await main();
