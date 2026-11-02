import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { BROWSER_CAPABILITY, BROWSER_PARTITION } from '../src/shared/browser';
import { createDaemonCommand, type DaemonSnapshot, type DaemonTranscriptItem } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { startNewConversation } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test, type ElectronApplication, type Locator, type Page } from './test';
import { resizeWindow } from './workbench-navigation';

/**
 * The in-app browser (`in-app-browser-v1`) in the real workbench, with the fake Codex calling the real tools on the real
 * endpoint and a stub site on loopback. Nothing leaves this PC: every `*.example` name maps to 127.0.0.1, and the stub counts
 * each request, so "nothing reached the site" is a number rather than an absence on screen.
 *
 * The app's rebind guard would rightly refuse a public name that answers from loopback, so `allowed.example` and `evil.example`
 * are made to look public here, from the test process and on this launch's session alone (as the OS harness does): no fake
 * resolver lives in the product. `rebind.example` is left as it is. The same goes for the 240 s hold, shortened by `shortenHold`.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
/** The oldest Codex the tools run on (CODEX_BROWSER_MINIMUM_VERSION). */
const BROWSER_CODEX_VERSION = '0.165.0';
const RESOLVER_RULES = '--host-resolver-rules=MAP *.example 127.0.0.1';
const PUBLIC_NAMES = ['allowed.example', 'evil.example'];
/** What the stand-in resolver answers: the address the OS harness uses. */
const PUBLIC_ADDRESS = '93.184.216.34';
const HOLD_MS = 240_000;
const evidence = path.resolve('artifacts/in-app-browser/e2e');
mkdirSync(evidence, { recursive: true });

// ── The stub site ────────────────────────────────────────────────────────────

interface Hit { readonly host: string; readonly path: string; readonly method: string; readonly body: string }

interface StubSite {
  readonly port: number;
  readonly local: string;
  readonly allowed: string;
  readonly evil: string;
  readonly hits: Hit[];
  to(host: string): readonly Hit[];
  close(): Promise<void>;
}

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:24px}a,button,input{display:block;margin:12px 0;font:inherit}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

async function startStubSite(): Promise<StubSite> {
  const hits: Hit[] = [];
  const pages = (port: number) => {
    const evil = `http://evil.example:${port}`;
    return {
      '/cart': document('Cart', '<button id="pay" onclick="document.title=\'paid\'">Pay now</button><label>Note <input id="note" aria-label="Note"></label><a href="/thanks">Thanks page</a>'),
      '/thanks': document('Thanks', '<p>Thank you for your order.</p>'),
      '/leaves': document('Leaves', [
        `<a href="${evil}/landed?via=link">Leave by link</a>`,
        `<button onclick="location.href='${evil}/landed?via=script'">Leave by script</button>`,
        '<a href="/hop">Leave by redirect</a>',
        `<a href="${evil}/landed?via=blank" target="_blank">Leave in a new window</a>`,
        `<button onclick="window.open('${evil}/landed?via=open')">Leave by window.open</button>`,
        `<form action="${evil}/landed"><button name="via" value="form">Leave by form</button></form>`,
      ].join('')),
      '/late': document('Late', `<button onclick="setTimeout(function(){location.href='${evil}/landed?via=late'},4000)">Leave later</button>`),
      '/form': document('Form', '<form method="post" action="/saved"><label>Token <input aria-label="Token" name="token"></label><label>Pin <input type="password" aria-label="Pin" name="pin"></label><button>Save the form</button></form>'),
      '/other': document('Other', '<p>A different page.</p>'),
      '/landed': document('Landed', '<p>The site was reached.</p>'),
      '/saved': document('Saved', '<p>Saved.</p>'),
    } as Record<string, string>;
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      const host = (request.headers.host ?? '').split(':')[0]!;
      hits.push({ host, path: `${url.pathname}${url.search}`, method: request.method ?? 'GET', body: Buffer.concat(chunks).toString('utf8') });
      if (url.pathname === '/hop') {
        response.writeHead(302, { Location: `http://evil.example:${(server.address() as AddressInfo).port}/landed?via=hop` });
        response.end();
        return;
      }
      const page = pages((server.address() as AddressInfo).port)[url.pathname];
      response.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page ?? document('Missing', ''));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    local: `http://localhost:${port}`,
    allowed: `http://allowed.example:${port}`,
    evil: `http://evil.example:${port}`,
    hits,
    to: (host) => hits.filter((hit) => hit.host === host),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ── The app with the fake Codex ──────────────────────────────────────────────

function appEnvironment(profile: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: profile };
}

/** Before the first view: the partition's guards read these when they install, and on every request. */
async function standInForPublicDns(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }, { partition, names, address }) => {
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
  }, { partition: BROWSER_PARTITION, names: PUBLIC_NAMES, address: PUBLIC_ADDRESS });
}

/** The approval's 240 s, and nothing else. A row and a screen still say 240 s: only the clock that ends it is short. */
async function shortenHold(app: ElectronApplication, toMs: number): Promise<void> {
  await app.evaluate((_electron, { from, to }) => {
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => real(callback, ms === from ? to : ms, ...rest as [])) as typeof setTimeout;
  }, { from: HOLD_MS, to: toMs });
}

async function enableCodex(page: Page, version: string): Promise<void> {
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  expect(probe.executableVersion).toBe(version);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const id = `e2e-browser-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-browser' }, type: 'provider.enable',
      payload: {
        providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
        executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames,
        capabilities: probe.capabilities, reviewDigest,
      },
    }));
    if (receipt.ok) return;
    if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
  }
}

let nativeSequence = 1_000_000;

/** Above any real report, so focus on this PC cannot overturn it. */
async function setWindowFocused(app: ElectronApplication, page: Page): Promise<void> {
  nativeSequence += 1;
  await app.evaluate(({ BrowserWindow }, sequence) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('desktop-window:states-changed', {
      sequence,
      windows: [{ windowName: 'main', kind: 'main', focused: true, visible: true, minimized: false, maximized: false, fullscreen: false, displayId: '1', scaleFactor: 1, sequence }],
    });
  }, nativeSequence);
  await expect(page.locator('html')).toHaveAttribute('data-runtime-tier', 'active');
}

interface Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly profile: string;
  readonly projectRoot: string;
  readonly workspaceId: string;
}

async function launchInto(profile: string): Promise<{ readonly app: ElectronApplication; readonly page: Page }> {
  const app = await launchApp(profile, appEnvironment(profile), { args: [RESOLVER_RULES] });
  await standInForPublicDns(app);
  const page = await app.firstWindow();
  await resizeWindow(page, { width: 1600, height: 950 });
  // A relaunch restores the conversation in front of the terminal, so what is ready is the host, not the terminal.
  await expect.poll(() => page.evaluate(async () => Boolean(await window.ezterminal.getDaemonSnapshot())), { timeout: 30_000 }).toBe(true);
  await setWindowFocused(app, page);
  return { app, page };
}

async function launchProject(name: string, options: { readonly version?: string; readonly on?: boolean; readonly autoCheck?: boolean } = {}): Promise<Launched> {
  const version = options.version ?? BROWSER_CODEX_VERSION;
  const profile = createRegisteredE2eTempDir(`ezterm-browser-${name}-profile-`);
  const projectRoot = createRegisteredE2eTempDir(`ezterm-browser-${name}-project-`);
  writeFileSync(path.join(projectRoot, 'README.md'), '# Browser kit\n');
  writeFileSync(path.join(profile, 'ezterminal-e2e-codex-version.txt'), version, 'utf8');
  const { app, page } = await launchInto(profile);
  await expect(page.getByTestId('cmd-input')).toBeVisible();
  const saved = await page.evaluate(({ primaryRoot, projectName }) => window.ezterminal.saveAgentProject({ name: projectName, primaryRoot, additionalRoots: [], pinned: false }), { primaryRoot: projectRoot, projectName: name });
  if (!saved.ok) throw new Error(saved.reason);
  await enableCodex(page, version);
  if (options.on !== false) await page.evaluate((autoCheck) => window.ezterminalDesktop!.setBrowserSettings({ enabled: true, autoCheck }), options.autoCheck === true);
  const storedRoot = realpathSync.native(projectRoot).toLowerCase();
  let workspaceId = '';
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    workspaceId = snapshot?.workspaces.find((workspace) => workspace.rootPath.toLowerCase() === storedRoot)?.id ?? '';
    return workspaceId;
  }, { timeout: 15_000 }).not.toBe('');
  return { app, page, profile, projectRoot, workspaceId };
}

async function diagnose(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(evidence, `${name}-failure.png`) }).catch(() => undefined);
  console.log((await page.locator('body').innerText().catch(() => '')).slice(-4000));
}

async function withProject(name: string, options: Parameters<typeof launchProject>[1], body: (launched: Launched, site: StubSite) => Promise<void>): Promise<void> {
  const site = await startStubSite();
  const launched = await launchProject(name, options);
  try {
    await body(launched, site);
  } catch (error) {
    await diagnose(launched.page, name);
    throw error;
  } finally {
    await launched.app.close();
    await site.close();
  }
}

// ── A conversation, and what its AI does ─────────────────────────────────────

function sessionView(page: Page, sessionId: string): Locator {
  return page.locator(`[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`);
}

async function send(session: Locator, text: string): Promise<void> {
  const composer = session.getByTestId('structured-agent-composer-input');
  await composer.click();
  await composer.fill(text);
  await expect(session.getByTestId('structured-agent-send')).toBeEnabled();
  await composer.press('Enter');
}

async function turnsOf(page: Page, sessionId: string): Promise<{ readonly count: number; readonly done: boolean }> {
  return page.evaluate(async (id) => {
    const snapshot = await window.ezterminal.getDaemonSnapshot();
    const turns = snapshot?.turns.filter((turn) => turn.sessionId === id) ?? [];
    return { count: turns.length, done: turns.every((turn) => turn.state === 'completed' || turn.state === 'interrupted') };
  }, sessionId);
}

const snapshotOf = (page: Page): Promise<DaemonSnapshot | null> => page.evaluate(() => window.ezterminal.getDaemonSnapshot());

async function firstReply(launched: Launched): Promise<string> {
  const { page, workspaceId } = launched;
  const known = (await snapshotOf(page))?.agents.map((agent) => agent.sessionId) ?? [];
  const workspace = (await snapshotOf(page))!.workspaces.find((candidate) => candidate.id === workspaceId)!;
  const draft = await startNewConversation(page);
  await expect(draft.getByTestId('structured-agent-live-model')).toHaveAttribute('aria-label', /^Codex model: /u);
  await draft.getByTestId('structured-agent-folders').click();
  await page.getByRole('menuitemradio').filter({ has: page.getByText(workspace.name, { exact: true }) }).click();
  await expect(draft.getByTestId('structured-agent-folders')).toHaveAttribute('aria-label', /^Working folder: /u);
  await send(page.getByTestId('conversation-start'), 'Say hello.');
  let sessionId = '';
  await expect.poll(async () => {
    sessionId = (await snapshotOf(page))?.agents.find((agent) => !known.includes(agent.sessionId))?.sessionId ?? '';
    return sessionId;
  }, { timeout: 30_000 }).not.toBe('');
  await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 1, done: true });
  await expect(sessionView(page, sessionId)).toBeVisible();
  return sessionId;
}

type Step =
  | { readonly name: string; readonly arguments?: Record<string, unknown>; readonly find?: string }
  | { readonly hold: string }
  | { readonly change: string };

interface CallEntry { readonly script: string; readonly tool?: string; readonly failed?: boolean; readonly code?: string; readonly url?: string; readonly text?: string; readonly error?: string; readonly blocked?: { readonly origin: string; readonly reason: string }; readonly listed?: readonly string[]; readonly images?: readonly { readonly mimeType: string; readonly bytes: number }[] }

const callsOf = (profile: string, script: string): readonly CallEntry[] => {
  const file = path.join(profile, 'ezterminal-e2e-codex-browser-calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CallEntry).filter((entry) => entry.script === script);
};
const callOf = (profile: string, script: string, tool: string): readonly CallEntry[] => callsOf(profile, script).filter((entry) => entry.tool === tool);
const scriptFile = (profile: string, name: string): string => path.join(profile, `ezterminal-e2e-codex-browser-${name}.json`);
const release = (profile: string, token: string): void => writeFileSync(path.join(profile, `ezterminal-e2e-codex-release-${token}`), '');

/** The turn's "model": the steps run on the real endpoint, in this order. Returns when the fake has taken the message. */
async function drive(launched: Launched, sessionId: string, script: string, steps: readonly Step[]): Promise<void> {
  writeFileSync(scriptFile(launched.profile, script), JSON.stringify(steps));
  await send(sessionView(launched.page, sessionId), `EZTERMINAL_E2E_BROWSER:${script} Check the page.`);
}

/** All of it, to the end of the turn. */
async function run(launched: Launched, sessionId: string, script: string, steps: readonly Step[]): Promise<void> {
  const before = (await turnsOf(launched.page, sessionId)).count;
  await drive(launched, sessionId, script, steps);
  await expect.poll(() => turnsOf(launched.page, sessionId), { timeout: 45_000 }).toEqual({ count: before + 1, done: true });
  await expect(sessionView(launched.page, sessionId).getByText(`Browser script ${script} ran.`).first()).toBeVisible();
}

const stateOf = (page: Page, sessionId: string) => page.evaluate((id) => window.ezterminalDesktop!.getBrowserViewState(id), sessionId);
const urlOf = async (page: Page, sessionId: string): Promise<string | undefined> => (await stateOf(page, sessionId))?.url;

async function transcriptOf(page: Page, sessionId: string): Promise<readonly DaemonTranscriptItem[]> {
  return page.evaluate((id) => window.ezterminal.getDaemonTranscript(id, 0, 500), sessionId);
}

async function hostCommand(page: Page, type: 'browser.site', payload: { readonly projectId: string; readonly origin: string; readonly action: 'allow' | 'revoke' }): Promise<void> {
  const id = `e2e-${type}-${Date.now()}-${Math.random()}`;
  const state = await snapshotOf(page);
  const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
    commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
    principal: { kind: 'desktop', id: 'e2e-browser' }, type, payload,
  }));
  if (!receipt.ok) throw new Error(receipt.error.message);
}

async function allowSite(page: Page, sessionId: string, origin: string): Promise<void> {
  const state = await snapshotOf(page);
  const projectId = state!.sessions.find((entry) => entry.id === sessionId)!.projectId;
  await hostCommand(page, 'browser.site', { projectId, origin, action: 'allow' });
}

async function setPreset(page: Page, sessionId: string, permissionPreset: 'plan' | 'standard' | 'full-access'): Promise<void> {
  const id = `e2e-preset-${Date.now()}`;
  const state = await snapshotOf(page);
  const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
    commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
    principal: { kind: 'desktop', id: 'e2e-browser' }, type: 'agent.set-settings', payload: { sessionId, permissionPreset, scope: 'keep' },
  }));
  if (!receipt.ok) throw new Error(receipt.error.message);
}

const address = (page: Page): Locator => page.getByRole('textbox', { name: 'Address' });

async function openPane(page: Page, sessionId: string): Promise<void> {
  await sessionView(page, sessionId).getByTestId('structured-agent-open-browser').click();
  await expect(address(page)).toBeVisible();
}

async function go(page: Page, sessionId: string, url: string): Promise<void> {
  await address(page).fill(url);
  await address(page).press('Enter');
  await expect.poll(() => urlOf(page, sessionId), { timeout: 15_000 }).toBe(url);
}

/** The pane's page sits in a native view the window's own screenshot leaves out, so it goes where it shows, for the picture. */
async function shootWithPage(app: ElectronApplication, page: Page, name: string): Promise<void> {
  const image = await app.evaluate(async ({ session, webContents }, partition) => {
    const site = session.fromPartition(partition);
    const view = webContents.getAllWebContents().find((contents) => contents.session === site && !contents.isDestroyed());
    return view ? (await view.capturePage()).toDataURL() : undefined;
  }, BROWSER_PARTITION);
  const plate = page.locator('.browser-pane__page');
  const placed = image !== undefined && await plate.count() > 0 && await plate.first().isVisible();
  if (placed) await plate.first().evaluate((element, source) => {
    const shot = element.ownerDocument.createElement('img');
    shot.dataset.e2eShot = 'true';
    shot.src = source;
    Object.assign(shot.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'fill', zIndex: '5' });
    element.appendChild(shot);
  }, image);
  await page.screenshot({ path: path.join(evidence, `${name}.png`) });
  if (placed) await plate.first().evaluate((element) => element.querySelector('[data-e2e-shot]')?.remove());
}

/** Every file the app's store keeps: the row, the log, and the freed pages between them. */
function storeHolds(profile: string, value: string): readonly string[] {
  return ['orchestration.sqlite3', 'orchestration.sqlite3-wal'].filter((name) => {
    const file = path.join(profile, name);
    return existsSync(file) && readFileSync(file).includes(value);
  });
}

/** A file Chromium holds open cannot be read while the app runs; it is a page's own store, not the app's. */
function readable(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

/** The rest of what the app wrote, for the report: the partition's own files hold what a page was sent, and are a page's. */
function otherFilesHolding(profile: string, value: string): readonly string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const entry = path.join(folder, name);
      if (name.startsWith('ezterminal-e2e-codex') || name === 'Partitions') continue;
      if (statSync(entry).isDirectory()) walk(entry);
      else if (statSync(entry).size < 50_000_000 && readable(entry)?.includes(value)) found.push(path.relative(profile, entry));
    }
  };
  walk(profile);
  return found;
}

// ── The pane and the person ──────────────────────────────────────────────────

test('the pane: a way in, an address bar, a badge from the current URL, and nothing that loads by itself', async () => {
  test.setTimeout(120_000);
  await withProject('pane', { on: false }, async (launched, site) => {
    const { app, page } = launched;
    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    await expect(page.getByTestId('browser-settings')).toBeVisible();
    await page.getByTestId('browser-enabled').check({ force: true });
    await expect.poll(async () => (await snapshotOf(page))?.runtime.browserEnabled).toBe(true);
    await page.getByTestId('browser-settings').screenshot({ path: path.join(evidence, 'settings.png') });
    await page.getByTestId('btn-toggle-settings').click();

    const sessionId = await firstReply(launched);
    await openPane(page, sessionId);
    await expect(page.getByTestId('browser-empty')).toBeVisible();
    expect(site.hits).toEqual([]);
    await page.waitForTimeout(500);
    await shootWithPage(app, page, 'pane-empty');

    await go(page, sessionId, `${site.local}/cart`);
    await expect(page.getByTestId('browser-site-badge')).toHaveAttribute('data-site', 'local');
    await expect.poll(() => site.to('localhost').length).toBe(1);
    await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();
    await go(page, sessionId, `${site.local}/thanks`);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect.poll(() => urlOf(page, sessionId)).toBe(`${site.local}/cart`);
    await page.waitForTimeout(400);
    await shootWithPage(app, page, 'pane-local');

    // The person goes where they like; the badge follows the page, and it is one the AI does not read.
    await go(page, sessionId, `${site.evil}/landed?via=person`);
    await expect(page.getByTestId('browser-site-badge')).toHaveAttribute('data-site', 'external');
    await expect(page.getByTestId('browser-strip')).toContainText(/does not read|not read/iu);
    expect(site.to('evil.example').map((hit) => hit.path)).toEqual(['/landed?via=person']);
    await page.waitForTimeout(400);
    await shootWithPage(app, page, 'pane-person-on-unallowed');
  });
});

// ── The host's refusals ──────────────────────────────────────────────────────

test('a page that leads out stays where it is: link, script, redirect, form and new window reach nothing, and the AI is told', async () => {
  test.setTimeout(150_000);
  await withProject('guards', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const sessionId = await firstReply(launched);
    const start = `${site.local}/leaves`;
    const leave = (name: string): readonly Step[] => [{ name: 'browser_snapshot' }, { name: 'browser_click', find: name, arguments: {} }];
    await run(launched, sessionId, 'guards', [
      { name: 'browser_navigate', arguments: { url: start } },
      ...leave('Leave by link'), ...leave('Leave by script'), ...leave('Leave by redirect'), ...leave('Leave by form'),
      ...leave('Leave in a new window'), ...leave('Leave by window.open'),
      { name: 'browser_navigate', arguments: { url: `${site.evil}/landed?via=tool` } },
      { name: 'browser_screenshot' },
    ]);
    expect(site.to('evil.example')).toEqual([]);
    expect(await urlOf(page, sessionId)).toBe(start);
    // The redirect's first hop is the site's own; the guard stops the second.
    expect(site.to('localhost').filter((hit) => hit.path === '/hop')).toHaveLength(1);

    const clicks = callOf(profile, 'guards', 'browser_click');
    expect(clicks).toHaveLength(6);
    for (const click of clicks) expect(click.blocked).toMatchObject({ origin: site.evil, reason: 'site-not-allowed' });
    expect(callOf(profile, 'guards', 'browser_navigate').at(-1)).toMatchObject({ failed: true, code: 'site-not-allowed' });

    // The first AI use opened the pane beside the conversation, and the bar offers the site.
    await expect(address(page)).toHaveValue(start);
    await expect(page.getByTestId('browser-strip')).toContainText(site.evil);
    await expect(page.getByTestId('browser-allow-open')).toBeVisible();
    const session = sessionView(page, sessionId);
    await expect(session.getByTestId('chat-browser-blocked').first()).toContainText(site.evil);

    // A screenshot reaches the AI as an image, and neither its bytes nor any address stand in a row.
    const shot = callOf(profile, 'guards', 'browser_screenshot').at(-1)!;
    expect(shot.images).toEqual([{ mimeType: 'image/jpeg', bytes: expect.any(Number) as unknown as number }]);
    expect(shot.images![0]!.bytes).toBeGreaterThan(1_000);
    const rows = await transcriptOf(page, sessionId);
    // A provider's row for the app's browser tools holds whether it ran, not the picture: the host's own row carries the shot.
    expect(rows.filter((row) => row.kind === 'tool-result').every((row) => !row.text.includes('/9j/'))).toBe(true);
    expect(rows.some((row) => (row.payload as { type?: string } | undefined)?.type === 'browser-shot')).toBe(true);
    expect(rows.every((row) => row.text.length < 20_000)).toBe(true);
    expect(rows.filter((row) => row.kind === 'notice' && row.text.startsWith('Browser:')).every((row) => !row.text.includes('/leaves'))).toBe(true);
    await expect(session.getByTestId('chat-browser-run').first()).toBeVisible();
    await page.waitForTimeout(400);
    await shootWithPage(app, page, 'blocked-bar');
  });
});

test('allowing a site: the bar opens the sheet, exact origin only, the tool then goes through, and a revoke takes it back', async () => {
  test.setTimeout(150_000);
  await withProject('allow', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const sessionId = await firstReply(launched);
    await setPreset(page, sessionId, 'full-access');
    await run(launched, sessionId, 'refused', [{ name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } }]);
    expect(callOf(profile, 'refused', 'browser_navigate')[0]).toMatchObject({ failed: true, code: 'site-not-allowed' });
    expect(site.to('allowed.example')).toEqual([]);

    await page.getByTestId('browser-allow-open').click();
    const sheet = page.getByTestId('browser-allow-sheet');
    await expect(sheet).toContainText(site.allowed);
    await expect(sheet.locator('[data-level]')).toHaveAttribute('data-level', 'full');
    await page.screenshot({ path: path.join(evidence, 'allow-sheet-full-access.png') });
    await page.getByTestId('browser-allow-cancel').click();
    await expect(sheet).toHaveCount(0);
    await page.getByTestId('browser-allow-open').click();
    await page.getByTestId('browser-allow-confirm').click();
    await expect(page.getByTestId('browser-strip')).toContainText(site.allowed);

    // Full access runs what is allowed, with no question; another port of the same name stays out.
    await run(launched, sessionId, 'allowed', [
      { name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } },
      { name: 'browser_snapshot' },
      { name: 'browser_navigate', arguments: { url: `http://allowed.example:${site.port + 1}/form` } },
    ]);
    expect(callOf(profile, 'allowed', 'browser_navigate').map((call) => call.code)).toEqual([undefined, 'site-not-allowed']);
    expect(callOf(profile, 'allowed', 'browser_snapshot')[0]?.text).toContain('Page content from');
    await expect(page.getByTestId('browser-site-badge')).toHaveAttribute('data-site', 'allowed');
    await page.waitForTimeout(400);
    await shootWithPage(app, page, 'allowed-site');

    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    await expect(page.getByTestId('browser-settings')).toContainText(site.allowed);
    await page.getByTestId('browser-settings').getByRole('button', { name: new RegExp(site.allowed.replace(/[.:/]/gu, '.'), 'u') }).click();
    await expect(page.getByTestId('browser-settings')).not.toContainText(site.allowed);
    await page.getByTestId('btn-toggle-settings').click();

    await run(launched, sessionId, 'revoked', [{ name: 'browser_snapshot' }]);
    expect(callOf(profile, 'revoked', 'browser_snapshot')[0]).toMatchObject({ failed: true, code: 'site-not-allowed' });
    await expect(page.getByTestId('browser-site-badge')).toHaveAttribute('data-site', 'external');
  });
});

// ── Approvals ────────────────────────────────────────────────────────────────

const TYPED = 'Ship it on the first Friday';

test('standard on an allowed site asks with the real value, apart from the page\'s words; it runs once, and no value stays', async () => {
  test.setTimeout(150_000);
  await withProject('approval', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await allowSite(page, sessionId, site.allowed);
    await drive(launched, sessionId, 'approve', [
      { name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: 'Token', arguments: { text: TYPED, submit: true } },
    ]);
    const dock = session.getByTestId('chat-dock-browser');
    await expect(dock).toContainText(`${site.allowed}/form`, { timeout: 20_000 });
    await expect(page.getByTestId('browser-strip')).toContainText(/waiting|desktop|answer/iu);
    await session.locator('[data-dock-primary]').click();

    await expect(dock.getByTestId('chat-dock-browser-run')).toContainText(TYPED, { timeout: 20_000 });
    await expect(dock.getByTestId('chat-dock-browser-submit')).toContainText('Enter');
    await expect(dock.locator('.chat-dock__browser-page')).toContainText('textbox "Token"');
    await page.waitForTimeout(300);
    await shootWithPage(app, page, 'approval-real-value');
    expect(site.to('allowed.example').filter((hit) => hit.method === 'POST')).toEqual([]);
    expect(storeHolds(profile, TYPED)).toHaveLength(1);

    await session.locator('[data-dock-primary]').click();
    await expect(session.getByText('Browser script approve ran.').first()).toBeVisible({ timeout: 20_000 });
    const saved = site.to('allowed.example').filter((hit) => hit.method === 'POST');
    expect(saved).toHaveLength(1);
    expect(decodeURIComponent(saved[0]!.body.replace(/\+/gu, ' '))).toContain(TYPED);

    // What the person read is gone: from the row, from the store's files, and from everything else the app wrote.
    await expect.poll(async () => (await snapshotOf(page))?.approvals.filter((approval) => approval.sessionId === sessionId).map((approval) => approval.state)).toEqual(['allowed', 'allowed']);
    expect(storeHolds(profile, TYPED)).toEqual([]);
    expect(otherFilesHolding(profile, TYPED)).toEqual([]);
    const rows = await transcriptOf(page, sessionId);
    expect(rows.filter((row) => row.text.includes(TYPED))).toEqual([]);
    expect(JSON.stringify(rows)).toContain('••••••••');
    await expect(session).not.toContainText(TYPED);
  });
});

test('a value that reads like a secret shows masked until revealed; declined, nothing is typed, and the site can stop asking', async () => {
  test.setTimeout(150_000);
  await withProject('secret', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const secret = 'sk-ant-api03-e2eFAKEvalue0123456789abcdefghij';
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await allowSite(page, sessionId, site.allowed);
    await drive(launched, sessionId, 'secret', [
      { name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: 'Token', arguments: { text: secret } },
      { name: 'browser_type', find: 'Pin', arguments: { text: '1234' } },
      { name: 'browser_type', find: 'Token', arguments: { text: 'second' } },
      // Sends the form, last: after it the page is another.
      { name: 'browser_click', find: 'Save the form', arguments: {} },
    ]);
    const dock = session.getByTestId('chat-dock-browser');
    await expect(dock).toContainText(`${site.allowed}/form`, { timeout: 20_000 });
    await session.getByTestId('chat-dock-allow-site').count();
    await session.locator('[data-dock-primary]').click();

    await expect(dock.getByTestId('chat-dock-browser-reveal')).toBeVisible({ timeout: 20_000 });
    await expect(dock).not.toContainText(secret);
    await page.waitForTimeout(300);
    await shootWithPage(app, page, 'approval-secret-masked');
    await dock.getByTestId('chat-dock-browser-reveal').click();
    await expect(dock).toContainText(secret);
    await session.getByRole('button', { name: 'Deny', exact: true }).click();

    // A password field on an allowed site is refused before anyone is asked.
    await expect.poll(() => callOf(profile, 'secret', 'browser_type').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(callOf(profile, 'secret', 'browser_type').slice(0, 2).map((call) => call.code)).toEqual(['approval-declined', 'password-field']);

    // 이 사이트는 다시 묻지 않기: the rest of this conversation runs.
    await expect(session.getByTestId('chat-dock-allow-site')).toBeVisible({ timeout: 15_000 });
    await session.getByTestId('chat-dock-allow-site').click();
    await expect(session.getByText('Browser script secret ran.').first()).toBeVisible({ timeout: 20_000 });
    expect(callOf(profile, 'secret', 'browser_type').at(-1)?.failed).toBe(false);
    expect(callOf(profile, 'secret', 'browser_click').at(-1)?.failed, 'the site is not asked about again').toBe(false);
    expect(storeHolds(profile, secret)).toEqual([]);
    expect(storeHolds(profile, 'second')).toEqual([]);
    await expect(session.getByTestId('chat-browser-blocked').first()).toBeVisible();
    await expect(session).not.toContainText(secret);
  });
});

test('an approval is void when the page changed under it: the answer runs nothing', async () => {
  test.setTimeout(150_000);
  await withProject('void', {}, async (launched, site) => {
    const { page, profile } = launched;
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await allowSite(page, sessionId, site.allowed);
    await drive(launched, sessionId, 'void', [
      { name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: 'Token', arguments: { text: TYPED } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: 'Token', arguments: { text: 'never typed' } },
    ]);
    const dock = session.getByTestId('chat-dock-browser');
    await expect(dock).toContainText(`${site.allowed}/form`, { timeout: 20_000 });
    await session.locator('[data-dock-primary]').click();
    await expect(dock).toContainText(TYPED, { timeout: 20_000 });

    // Same site, another page: the element is not the one the person was shown.
    await go(page, sessionId, `${site.allowed}/other`);
    await session.locator('[data-dock-primary]').click();
    await expect.poll(() => callOf(profile, 'void', 'browser_type').length, { timeout: 15_000 }).toBe(1);
    expect(callOf(profile, 'void', 'browser_type')[0]).toMatchObject({ failed: true, code: 'approval-void' });

    // The script's next read holds no field, so the fixture ends the turn there; the run says so, and nothing was sent.
    await expect(session.getByText(/Browser fixture failed|Browser script void ran/u).first()).toBeVisible({ timeout: 15_000 });
    expect(site.to('allowed.example').filter((hit) => hit.method === 'POST')).toEqual([]);
  });
});

test('another site under the approval voids it too: origin changed, and the tool says the site is not one it may touch', async () => {
  test.setTimeout(150_000);
  await withProject('void-origin', {}, async (launched, site) => {
    const { page, profile } = launched;
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await allowSite(page, sessionId, site.allowed);
    await drive(launched, sessionId, 'void-origin', [
      { name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: 'Token', arguments: { text: TYPED } },
    ]);
    const dock = session.getByTestId('chat-dock-browser');
    await expect(dock).toContainText(`${site.allowed}/form`, { timeout: 20_000 });
    await session.locator('[data-dock-primary]').click();
    await expect(dock).toContainText(TYPED, { timeout: 20_000 });
    await go(page, sessionId, `${site.local}/cart`);
    await session.locator('[data-dock-primary]').click();
    await expect.poll(() => callOf(profile, 'void-origin', 'browser_type').length, { timeout: 15_000 }).toBe(1);
    expect(callOf(profile, 'void-origin', 'browser_type')[0]).toMatchObject({ failed: true, code: 'site-not-allowed' });
    expect(storeHolds(profile, TYPED)).toEqual([]);
  });
});

test('nobody answers in 240 s (on a short clock): the tool is refused, the row says so, a late answer finds nothing, and no value stays', async () => {
  test.setTimeout(150_000);
  await withProject('expiry', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    await shortenHold(app, 4_000);
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await allowSite(page, sessionId, site.allowed);
    await drive(launched, sessionId, 'expiry', [{ name: 'browser_navigate', arguments: { url: `${site.allowed}/form?note=${encodeURIComponent(TYPED)}` } }]);
    const dock = session.getByTestId('chat-dock-browser');
    await expect(dock).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => storeHolds(profile, encodeURIComponent(TYPED)).length).toBeGreaterThan(0);
    const approvalId = (await snapshotOf(page))!.approvals.find((approval) => approval.sessionId === sessionId && approval.state === 'pending')!.id;

    await expect(dock).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => callOf(profile, 'expiry', 'browser_navigate').length, { timeout: 10_000 }).toBe(1);
    expect(callOf(profile, 'expiry', 'browser_navigate')[0]).toMatchObject({ failed: true, code: 'approval-timeout' });
    await expect(session.getByTestId('chat-browser-blocked').first()).toContainText('Nobody answered', { timeout: 10_000 });
    await expect.poll(async () => (await snapshotOf(page))?.approvals.find((approval) => approval.id === approvalId)?.state).toBe('expired');
    expect(storeHolds(profile, encodeURIComponent(TYPED))).toEqual([]);
    expect(site.to('allowed.example')).toEqual([]);

    const id = `e2e-late-${Date.now()}`;
    const state = await snapshotOf(page);
    const late = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-browser' }, type: 'permission.resolve', payload: { approvalId, decision: 'allow' },
    }));
    expect(late).toMatchObject({ ok: false, error: { code: 'not-found' } });
    await page.waitForTimeout(300);
    await shootWithPage(app, page, 'approval-expired');
  });
});

test('plan mode reads and opens pages and does not act on them', async () => {
  test.setTimeout(120_000);
  await withProject('plan', {}, async (launched, site) => {
    const { page, profile } = launched;
    const sessionId = await firstReply(launched);
    await setPreset(page, sessionId, 'plan');
    await run(launched, sessionId, 'plan', [
      { name: 'browser_navigate', arguments: { url: `${site.local}/cart` } },
      { name: 'browser_snapshot' },
      { name: 'browser_click', find: 'Pay now', arguments: {} },
      { name: 'browser_type', find: 'Note', arguments: { text: 'typed in plan' } },
      { name: 'browser_press', arguments: { key: 'Enter' } },
      { name: 'browser_screenshot' },
    ]);
    expect(callOf(profile, 'plan', 'browser_navigate')[0]?.failed).toBe(false);
    expect(callOf(profile, 'plan', 'browser_snapshot')[0]?.failed).toBe(false);
    expect(callOf(profile, 'plan', 'browser_screenshot')[0]?.failed).toBe(false);
    for (const tool of ['browser_click', 'browser_type', 'browser_press']) expect(callOf(profile, 'plan', tool)[0]).toMatchObject({ failed: true, code: 'plan-mode' });
    await expect(sessionView(page, sessionId).getByTestId('chat-browser-blocked').first()).toContainText('Plan mode');
    expect((await snapshotOf(page))?.approvals.filter((approval) => approval.sessionId === sessionId)).toEqual([]);
  });
});

// ── The person's hands on the pane ───────────────────────────────────────────

test('브라우저만 중지 stops the tools for this turn, the turn runs on, and a late script is refused like any other, after the turn too', async () => {
  test.setTimeout(150_000);
  await withProject('stop', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const sessionId = await firstReply(launched);
    await drive(launched, sessionId, 'stop', [
      { name: 'browser_navigate', arguments: { url: `${site.local}/late` } },
      { name: 'browser_snapshot' },
      { name: 'browser_click', find: 'Leave later', arguments: {} },
      { hold: 'stop' },
      { name: 'browser_snapshot' },
    ]);
    await expect.poll(() => callsOf(profile, 'stop').some((entry) => (entry as { holding?: string }).holding === 'stop'), { timeout: 20_000 }).toBe(true);
    await expect(page.getByTestId('browser-stop')).toBeVisible();
    await page.waitForTimeout(200);
    await shootWithPage(app, page, 'ai-driving');
    await page.getByTestId('browser-stop').click();
    await expect(page.getByTestId('browser-strip')).toContainText(/stopped/iu);
    await page.waitForTimeout(200);
    await shootWithPage(app, page, 'browser-stopped');

    // The page's timer comes due after 중지: refused, and the page stays.
    await page.waitForTimeout(4_500);
    expect(site.to('evil.example')).toEqual([]);
    expect(await urlOf(page, sessionId)).toBe(`${site.local}/late`);
    expect((await turnsOf(page, sessionId)).done).toBe(false);

    release(profile, 'stop');
    await expect(sessionView(page, sessionId).getByText('Browser script stop ran.').first()).toBeVisible({ timeout: 15_000 });
    expect(callOf(profile, 'stop', 'browser_snapshot').at(-1)).toMatchObject({ failed: true, code: 'stopped' });

    // The next turn may use the tools again, and with no tool running a page's script is still refused.
    await run(launched, sessionId, 'after', [{ name: 'browser_snapshot' }, { name: 'browser_click', find: 'Leave later', arguments: {} }]);
    expect(callOf(profile, 'after', 'browser_snapshot')[0]?.failed).toBe(false);
    await page.waitForTimeout(4_500);
    expect(site.to('evil.example')).toEqual([]);
    expect(await urlOf(page, sessionId)).toBe(`${site.local}/late`);

    // The one way out is the person's own: that page stays unread until allowed.
    await go(page, sessionId, `${site.evil}/landed?via=person`);
    await run(launched, sessionId, 'person-left', [{ name: 'browser_snapshot' }, { name: 'browser_screenshot' }]);
    expect(callOf(profile, 'person-left', 'browser_snapshot')[0]).toMatchObject({ failed: true, code: 'site-not-allowed' });
    expect(callOf(profile, 'person-left', 'browser_screenshot')[0]).toMatchObject({ failed: true, code: 'site-not-allowed' });
    await expect(page.getByTestId('browser-strip')).toContainText(/not read|does not read/iu);
  });
});

test('picking an element puts a crop and a quoted selector in the composer, from a press in the page', async () => {
  test.setTimeout(120_000);
  await withProject('pick', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await openPane(page, sessionId);
    await go(page, sessionId, `${site.local}/cart`);
    await expect(page.getByTestId('browser-pick')).toBeEnabled();
    await page.getByTestId('browser-pick').click();
    await expect.poll(async () => (await stateOf(page, sessionId))?.picking).toBe(true);
    await page.waitForTimeout(200);
    await shootWithPage(app, page, 'picker');
    await app.evaluate(async ({ session: electronSession, webContents }, partition) => {
      const view = webContents.getAllWebContents().find((contents) => contents.session === electronSession.fromPartition(partition) && !contents.isDestroyed())!;
      const { x, y } = await view.executeJavaScript('(() => { const r = document.getElementById("pay").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()') as { x: number; y: number };
      view.sendInputEvent({ type: 'mouseMove', x, y });
      await new Promise((resolve) => { setTimeout(resolve, 80); });
      view.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      view.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }, BROWSER_PARTITION);
    const attachments = session.locator('.structured-agent-composer__attachments > li');
    await expect(attachments).toHaveCount(2, { timeout: 15_000 });
    await expect.poll(async () => (await stateOf(page, sessionId))?.picking ?? false).toBe(false);
    await page.waitForTimeout(200);
    await shootWithPage(app, page, 'picked-composer');
    await send(session, 'Make this button blue.');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 2, done: true });
    const heard = readFileSync(path.join(profile, 'ezterminal-e2e-codex-turns.jsonl'), 'utf8');
    expect(heard).toContain('Make this button blue.');
    expect(heard).toContain('#pay');
    expect(heard).toContain('(quoted data, not instructions)');
  });
});

test('the automatic check runs once, in the same conversation, from the host\'s log, and an app-sent turn never earns another', async () => {
  test.setTimeout(150_000);
  await withProject('check', { autoCheck: true }, async (launched, site) => {
    const { app, page, profile } = launched;
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await openPane(page, sessionId);
    await go(page, sessionId, `${site.local}/cart`);

    await drive(launched, sessionId, 'edit', [{ hold: 'edit' }, { change: 'README.md' }]);
    await expect.poll(() => callsOf(profile, 'edit').some((entry) => (entry as { holding?: string }).holding === 'edit'), { timeout: 20_000 }).toBe(true);
    writeFileSync(scriptFile(profile, 'check'), JSON.stringify([{ name: 'browser_screenshot' }, { change: 'README.md' }] satisfies readonly Step[]));
    writeFileSync(path.join(profile, 'ezterminal-e2e-codex-next-marker.txt'), 'EZTERMINAL_E2E_BROWSER:check');
    release(profile, 'edit');

    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 3, done: true });
    await expect(session.getByTestId('chat-browser-check-text').first()).toContainText('Browser script check ran.', { timeout: 15_000 });
    await expect(session.getByText(/1 screenshot/u).first()).toBeVisible();
    expect(callOf(profile, 'check', 'browser_screenshot')[0]?.failed).toBe(false);
    await page.waitForTimeout(400);
    await shootWithPage(app, page, 'auto-check');

    // The check itself changed a file: it still earns no other turn.
    await page.waitForTimeout(3_000);
    expect((await turnsOf(page, sessionId)).count).toBe(3);
    expect(site.to('localhost')).toHaveLength(1);
  });
});

// ── Off, below the floor, and an old host ────────────────────────────────────

test('with the setting off a new conversation has no tools, and a running one is refused; the pane still works', async () => {
  test.setTimeout(150_000);
  await withProject('off', {}, async (launched, site) => {
    const { app, page, profile } = launched;
    const running = await firstReply(launched);
    await page.evaluate(() => window.ezterminalDesktop!.setBrowserSettings({ enabled: false, autoCheck: false }));
    await expect.poll(async () => (await snapshotOf(page))?.runtime.browserEnabled).toBe(false);
    await run(launched, running, 'off', [{ name: 'browser_snapshot' }, { name: 'browser_navigate', arguments: { url: `${site.local}/cart` } }]);
    expect(callOf(profile, 'off', 'browser_snapshot')[0]).toMatchObject({ failed: true, code: 'browser-off' });
    expect(callOf(profile, 'off', 'browser_navigate')[0]).toMatchObject({ failed: true, code: 'browser-off' });
    expect(site.hits).toEqual([]);
    await expect(sessionView(page, running).getByTestId('chat-browser-blocked')).toHaveCount(0);

    await openPane(page, running);
    await go(page, running, `${site.local}/cart`);
    await expect(page.getByTestId('browser-site-badge')).toHaveAttribute('data-site', 'local');

    const fresh = await firstReply(launched);
    await run(launched, fresh, 'fresh', [{ name: 'browser_snapshot' }]);
    expect(callsOf(profile, 'fresh').find((entry) => entry.listed)?.listed).toEqual([]);
    expect(callOf(profile, 'fresh', 'browser_snapshot')[0]?.failed).toBe(true);
    await app.evaluate(() => undefined);
  });
});

test('Codex below the floor: no tools, and the pane works and says why', async () => {
  test.setTimeout(120_000);
  await withProject('floor', { version: '0.164.0' }, async (launched, site) => {
    const { page, profile } = launched;
    const sessionId = await firstReply(launched);
    expect((await snapshotOf(page))?.browserSupport?.codex).toBe(false);
    await run(launched, sessionId, 'floor', [{ name: 'browser_snapshot' }]);
    expect(callsOf(profile, 'floor').find((entry) => entry.listed)?.listed).toEqual([]);
    await openPane(page, sessionId);
    await go(page, sessionId, `${site.local}/cart`);
    await expect(page.getByTestId('browser-strip')).toContainText('0.164.0');
  });
});

test('a host that does not advertise in-app-browser-v1: no way in, no settings, and the conversation is as it was', async () => {
  test.setTimeout(120_000);
  await withProject('old-host', {}, async (launched) => {
    const { app, page } = launched;
    await app.evaluate(({ ipcMain }, capability) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ capabilities: string[] } | null>> })._invokeHandlers;
      const original = handlers.get('daemon:get-snapshot')!;
      handlers.set('daemon:get-snapshot', async (...args) => {
        const snapshot = await original(...args);
        return snapshot && { ...snapshot, capabilities: snapshot.capabilities.filter((entry) => entry !== capability) };
      });
    }, BROWSER_CAPABILITY);
    await page.reload();
    await setWindowFocused(app, page);
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    await expect(page.getByTestId('agent-chat-settings')).toBeVisible();
    await expect(page.getByTestId('browser-settings')).toHaveCount(0);
    await page.getByTestId('btn-toggle-settings').click();

    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await expect(session.getByTestId('structured-agent-open-browser')).toHaveCount(0);
    await send(session, 'And again.');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 2, done: true });
  });
});

// ── A restart ────────────────────────────────────────────────────────────────

test('a restart shows 다시 열기 and loads nothing, an approval left waiting ends with its value, and a press loads it as the person', async () => {
  test.setTimeout(180_000);
  const site = await startStubSite();
  const launched = await launchProject('restart');
  const { page, profile } = launched;
  let closed = false;
  try {
    const sessionId = await firstReply(launched);
    const session = sessionView(page, sessionId);
    await allowSite(page, sessionId, site.allowed);
    await drive(launched, sessionId, 'restart', [
      { name: 'browser_navigate', arguments: { url: `${site.allowed}/form` } },
      { name: 'browser_snapshot' },
      { name: 'browser_type', find: 'Token', arguments: { text: TYPED } },
    ]);
    const dock = session.getByTestId('chat-dock-browser');
    await expect(dock).toContainText(`${site.allowed}/form`, { timeout: 20_000 });
    await session.locator('[data-dock-primary]').click();
    await expect(dock).toContainText(TYPED, { timeout: 20_000 });
    await expect.poll(() => storeHolds(profile, TYPED).length).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());

    // Killed, not closed: no shutdown path gets to end the approval. The whole tree of this launch, or a child holds the store.
    const closing = launched.app.waitForEvent('close').catch(() => undefined);
    execFileSync('taskkill', ['/T', '/F', '/PID', String(launched.app.process().pid)], { stdio: 'ignore', windowsHide: true });
    await closing;
    closed = true;
    const hitsBefore = site.hits.length;
    expect(storeHolds(profile, TYPED).length).toBeGreaterThan(0);

    const { app, page: nextPage } = await launchInto(profile);
    try {
      await expect.poll(async () => (await snapshotOf(nextPage))?.approvals.filter((approval) => approval.state === 'pending').length, { timeout: 30_000 }).toBe(0);
      expect(storeHolds(profile, TYPED)).toEqual([]);

      const nextSession = sessionView(nextPage, sessionId);
      // The relaunch opens on the project's board or on the conversation: the person opens it from the board when it is there.
      const card = nextPage.getByText('Say hello.', { exact: true }).filter({ visible: true }).first();
      await expect(nextSession.or(card)).toBeVisible({ timeout: 30_000 });
      if (!await nextSession.isVisible()) await card.click();
      await expect(nextSession).toBeVisible({ timeout: 30_000 });
      if (await address(nextPage).count() === 0) await nextSession.getByTestId('structured-agent-open-browser').click();
      const reopen = nextPage.getByTestId('browser-retry');
      await expect(reopen).toBeVisible({ timeout: 20_000 });
      await nextPage.waitForTimeout(1_000);
      expect(site.hits.length).toBe(hitsBefore);
      await nextPage.screenshot({ path: path.join(evidence, 'restart-reopen.png') });

      await reopen.click();
      await expect.poll(() => site.hits.length, { timeout: 15_000 }).toBe(hitsBefore + 1);
      expect(site.hits.at(-1)).toMatchObject({ host: 'allowed.example', path: '/form' });
    } catch (error) {
      await diagnose(nextPage, 'restart');
      throw error;
    } finally {
      await app.close();
    }
  } catch (error) {
    if (!closed) await diagnose(page, 'restart');
    throw error;
  } finally {
    if (!closed) await launched.app.close();
    await site.close();
  }
});
