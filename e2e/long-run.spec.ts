import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand, type DaemonTranscriptItem } from '../src/shared/daemon-protocol';
import { LONG_RUN_CAPABILITY, RESUME_TEXT, type TurnUsageLimit, type UsageLimitPhase } from '../src/shared/long-run';
import { launchApp } from './launch-app';
import { startNewConversation } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test, type ElectronApplication, type Locator, type Page } from './test';
import { resizeWindow } from './workbench-navigation';

/**
 * Long-run continuity (`long-run-v1`) in the real workbench with the fake Codex: a message put into a running turn, and a
 * usage limit that stops a turn. The fake Codex is framed from the recordings of the real CLI against a stub, and logs
 * every `turn/start`, `turn/steer` and `turn/interrupt` it hears, so "once" and "none" are counted where they would land.
 * Its limit stands for the account: while its control file exists every conversation is refused, and the spec lifts it.
 *
 * The app's waits come from `EZTERMINAL_E2E_LONG_RUN_TIMING`; the real ones (2 minutes, 10 minutes) are unit tests. The
 * 60 seconds between two conversations is the real one. Claude has no fake here: it rests on replay and the live run.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
/** The oldest Codex this runs on (CODEX_LONG_RUN_MINIMUM_VERSION). */
const LONG_RUN_CODEX_VERSION = '0.165.0';
const evidence = path.resolve('artifacts/long-run/e2e');
mkdirSync(evidence, { recursive: true });

type Timing = { readonly afterResetMs?: number; readonly retryAfterRefusalMs?: number; readonly lineGapMs?: number };
type Limit = { readonly window: 'five-hour' | 'weekly'; readonly resetIn: number } | { readonly kind: 'no-reset' | 'not-included' };

const HOURS = 3_600;

// ── The app with the fake Codex ──────────────────────────────────────────────

function appEnvironment(profile: string, timing: Timing): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: profile, EZTERMINAL_E2E_LONG_RUN_TIMING: JSON.stringify(timing) };
}

async function enableCodex(page: Page, version: string): Promise<void> {
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  expect(probe.executableVersion).toBe(version);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const id = `e2e-long-run-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-long-run' }, type: 'provider.enable',
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

/** The window's focus as the app hears it: above any real report, so focus on this PC cannot overturn it. */
async function setWindowFocused(app: ElectronApplication, page: Page, focused: boolean): Promise<void> {
  nativeSequence += 1;
  await app.evaluate(({ BrowserWindow }, update) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('desktop-window:states-changed', {
      sequence: update.sequence,
      windows: [{
        windowName: 'main', kind: 'main', focused: update.focused, visible: true, minimized: false, maximized: false, fullscreen: false,
        displayId: '1', scaleFactor: 1, sequence: update.sequence,
      }],
    });
  }, { focused, sequence: nativeSequence });
  await expect(page.locator('html')).toHaveAttribute('data-runtime-tier', focused ? 'active' : 'passive');
}

interface Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly profile: string;
  readonly workspaceId: string;
}

async function launchProject(name: string, options: { readonly version?: string; readonly timing?: Timing } = {}): Promise<Launched> {
  const version = options.version ?? LONG_RUN_CODEX_VERSION;
  const profile = createRegisteredE2eTempDir(`ezterm-long-run-${name}-profile-`);
  const projectRoot = createRegisteredE2eTempDir(`ezterm-long-run-${name}-project-`);
  writeFileSync(path.join(projectRoot, 'README.md'), '# Long-run kit\n');
  writeFileSync(path.join(profile, 'ezterminal-e2e-codex-version.txt'), version, 'utf8');
  const app = await launchApp(profile, appEnvironment(profile, options.timing ?? {}));
  const page = await app.firstWindow();
  await resizeWindow(page, { width: 1600, height: 950 });
  await expect(page.getByTestId('cmd-input')).toBeVisible();
  await setWindowFocused(app, page, true);
  const saved = await page.evaluate(({ primaryRoot, projectName }) => window.ezterminal.saveAgentProject({ name: projectName, primaryRoot, additionalRoots: [], pinned: false }), { primaryRoot: projectRoot, projectName: name });
  if (!saved.ok) throw new Error(saved.reason);
  await enableCodex(page, version);
  const storedRoot = realpathSync.native(projectRoot).toLowerCase();
  let workspaceId = '';
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    workspaceId = snapshot?.workspaces.find((workspace) => workspace.rootPath.toLowerCase() === storedRoot)?.id ?? '';
    return workspaceId;
  }, { timeout: 15_000 }).not.toBe('');
  return { app, page, profile, workspaceId };
}

async function draftIn(page: Page, workspaceId: string): Promise<void> {
  const workspace = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))!.workspaces.find((candidate) => candidate.id === workspaceId)!;
  const draft = await startNewConversation(page);
  await expect(draft.getByTestId('structured-agent-live-model')).toHaveAttribute('aria-label', /^Codex model: /u);
  await draft.getByTestId('structured-agent-folders').click();
  await page.getByRole('menuitemradio').filter({ has: page.getByText(workspace.name, { exact: true }) }).click();
  await expect(draft.getByTestId('structured-agent-folders')).toHaveAttribute('aria-label', /^Working folder: /u);
}

function sessionView(page: Page, sessionId: string): Locator {
  return page.locator(`[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`);
}

async function send(session: Locator, text: string): Promise<void> {
  const composer = session.getByTestId('structured-agent-composer-input');
  await composer.click();
  await composer.fill(text);
  // After a launch the box waits for its saved draft; Enter does nothing until then.
  await expect(session.getByTestId('structured-agent-send')).toBeEnabled();
  await composer.press('Enter');
}

async function turnsOf(page: Page, sessionId: string): Promise<{ readonly count: number; readonly done: boolean }> {
  return page.evaluate(async (id) => {
    const snapshot = await window.ezterminal.getDaemonSnapshot();
    const turns = snapshot?.turns.filter((turn) => turn.sessionId === id) ?? [];
    return { count: turns.length, done: turns.every((turn) => turn.state === 'completed') };
  }, sessionId);
}

/** The first message starts the conversation and its Codex thread. */
async function firstReply(page: Page, text = 'Say hello.'): Promise<string> {
  const known = await page.evaluate(async () => (await window.ezterminal.getDaemonSnapshot())?.agents.map((agent) => agent.sessionId) ?? []);
  const draft = page.getByTestId('conversation-start');
  await send(draft, text);
  let sessionId = '';
  await expect.poll(async () => {
    sessionId = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents.find((agent) => !known.includes(agent.sessionId))?.sessionId ?? '';
    return sessionId;
  }, { timeout: 30_000 }).not.toBe('');
  await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 1, done: true });
  await expect(sessionView(page, sessionId)).toBeVisible();
  return sessionId;
}

async function turnState(page: Page, sessionId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => {
    const snapshot = await window.ezterminal.getDaemonSnapshot();
    const agent = snapshot?.agents.find((entry) => entry.sessionId === id);
    return agent?.currentTurnId ? snapshot?.turns.find((entry) => entry.id === agent.currentTurnId)?.state : undefined;
  }, sessionId);
}

/** A turn the fake Codex keeps running until `release(profile, token)`. */
async function startHeldTurn(page: Page, sessionId: string, token: string, extra = ''): Promise<void> {
  await send(sessionView(page, sessionId), `EZTERMINAL_E2E_HOLD:${token} ${extra} Keep working on it.`);
  await expect.poll(() => turnState(page, sessionId), { timeout: 20_000 }).toBe('working');
}

function release(profile: string, token: string): void {
  writeFileSync(path.join(profile, `ezterminal-e2e-codex-release-${token}`), '');
}

const control = (profile: string, name: string): string => path.join(profile, `ezterminal-e2e-codex-${name}`);
const holdLanding = (profile: string): void => writeFileSync(control(profile, 'hold-steer'), '');
const letLand = (profile: string): void => rmSync(control(profile, 'hold-steer'));
const holdContinue = (profile: string): void => writeFileSync(control(profile, 'hold-continue'), '');
const letContinue = (profile: string): void => rmSync(control(profile, 'hold-continue'));
const refuseSteers = (profile: string, how: 'review' | 'compact' | 'stale'): void => writeFileSync(control(profile, 'steer-refusal.txt'), how);
const takeSteers = (profile: string): void => rmSync(control(profile, 'steer-refusal.txt'));
const limitAccount = (profile: string, limit: Limit): void => writeFileSync(control(profile, 'limit.json'), JSON.stringify(limit));
const liftLimit = (profile: string): void => rmSync(control(profile, 'limit.json'));

function readJsonLines<T>(profile: string, name: string): readonly T[] {
  const file = path.join(profile, `ezterminal-e2e-codex-${name}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

interface TurnEntry { readonly at: number; readonly threadId: string; readonly text: string }
interface SteerEntry { readonly clientUserMessageId: string; readonly text: string; readonly outcome: string }

const turnsHeard = (profile: string): readonly TurnEntry[] => readJsonLines<TurnEntry>(profile, 'turns');
const continues = (profile: string): readonly TurnEntry[] => turnsHeard(profile).filter((entry) => entry.text === RESUME_TEXT);
const steersHeard = (profile: string): readonly SteerEntry[] => readJsonLines<SteerEntry>(profile, 'steers');

async function transcriptOf(page: Page, sessionId: string): Promise<readonly DaemonTranscriptItem[]> {
  return page.evaluate((id) => window.ezterminal.getDaemonTranscript(id, 0, 500), sessionId);
}

/** The card as its newest row says it: the record stays once the snapshot lets a stop go. */
async function latestCard(page: Page, sessionId: string): Promise<TurnUsageLimit | undefined> {
  const rows = await transcriptOf(page, sessionId);
  const row = rows.filter((item) => item.payload?.type === 'usage-limit').at(-1);
  return row?.payload as unknown as TurnUsageLimit | undefined;
}

async function cardPhase(page: Page, sessionId: string): Promise<UsageLimitPhase | undefined> {
  return (await latestCard(page, sessionId))?.phase;
}

const reaches = async (page: Page, sessionId: string, phase: UsageLimitPhase, timeout = 20_000): Promise<void> => {
  await expect.poll(() => cardPhase(page, sessionId), { timeout }).toBe(phase);
};

const limitCard = (session: Locator): Locator => session.getByTestId('chat-usage-limit-card');
const listRow = (page: Page, sessionId: string): Locator => page.locator(`[data-testid="shell-live-row"][data-session="${sessionId}"]`);
const headerState = (session: Locator): Locator => session.locator('.structured-agent-state').first();

/** The limit is gone and a message gets through: that closes a stop the person had set aside. */
async function afterTheLimit(page: Page, profile: string, sessionId: string): Promise<void> {
  liftLimit(profile);
  await send(sessionView(page, sessionId), 'The limit has lifted.');
  await reaches(page, sessionId, 'cancelled');
}

/** Past the time the card holds and a little more, so a send the app should not make would have shown. */
async function waitPast(page: Page, sessionId: string): Promise<void> {
  const { resumeAt } = (await latestCard(page, sessionId))!;
  await page.waitForTimeout(Math.max(0, Date.parse(resumeAt!) - Date.now()) + 2_500);
}

/** Nothing here waits on the person: no amber, and nothing in 나를 기다리는 것. */
async function waitsOnAClock(page: Page, session: Locator, sessionId: string, line: RegExp | string): Promise<void> {
  await expect(listRow(page, sessionId)).toContainText(line);
  await expect(listRow(page, sessionId)).not.toHaveAttribute('data-need', 'true');
  await expect(page.getByTestId('shell-live-waiting')).toHaveCount(0);
  await expect(headerState(session)).not.toHaveAttribute('data-state', 'blocked');
}

/** It waits on the person: amber in the list and the header, and a line in 나를 기다리는 것. */
async function asksThePerson(page: Page, session: Locator, sessionId: string): Promise<void> {
  await expect(listRow(page, sessionId)).toContainText('Limit · needs you');
  await expect(listRow(page, sessionId)).toHaveAttribute('data-need', 'true');
  await expect(page.getByTestId('shell-live-waiting')).toHaveCount(1);
  await expect(headerState(session)).toHaveAttribute('data-state', 'blocked');
}

async function hostState(page: Page, sessionId: string): Promise<{ readonly agent?: string; readonly session?: string }> {
  return page.evaluate(async (id) => {
    const snapshot = await window.ezterminal.getDaemonSnapshot();
    return { agent: snapshot?.agents.find((entry) => entry.sessionId === id)?.state, session: snapshot?.sessions.find((entry) => entry.id === id)?.state };
  }, sessionId);
}

async function diagnose(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(evidence, `${name}-failure.png`) }).catch(() => undefined);
  console.log((await page.locator('body').innerText().catch(() => '')).slice(-6000));
}

/** A launched app, closed however the test ends. */
async function withProject(name: string, options: Parameters<typeof launchProject>[1], body: (launched: Launched) => Promise<void>): Promise<void> {
  const launched = await launchProject(name, options);
  try {
    await body(launched);
  } catch (error) {
    await diagnose(launched.page, name);
    throw error;
  } finally {
    await launched.app.close();
  }
}

// ── A message into a running turn ────────────────────────────────────────────

test('Enter puts plain text into the running turn: the tray holds it, it lands once, and nothing queues', async () => {
  test.setTimeout(120_000);
  await withProject('steer', {}, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await startHeldTurn(page, sessionId, 'steer');
    await expect(session.getByTestId('structured-agent-composer-hint')).toContainText('Enter adds it');

    holdLanding(profile);
    await send(session, 'Only the cart file.');
    const tray = session.getByTestId('chat-steer-tray');
    await expect(tray).toContainText('Only the cart file.');
    await expect(tray).toContainText('On its way');
    await expect(session.getByTestId('structured-agent-composer-input')).toHaveValue('');
    await page.screenshot({ path: path.join(evidence, 'steer-on-its-way.png') });
    await expect.poll(() => steersHeard(profile).map((entry) => entry.outcome), { timeout: 10_000 }).toEqual(['accepted']);
    expect(await turnsOf(page, sessionId)).toMatchObject({ count: 2 });
    // Not in the transcript until it lands.
    expect((await transcriptOf(page, sessionId)).some((item) => item.text === 'Only the cart file.')).toBe(false);

    letLand(profile);
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    const landed = session.getByTestId('chat-steer-landed');
    await expect(landed).toHaveCount(1);
    await expect(landed).toHaveText('Added during the turn');
    await expect(session.getByTestId('chat-steer-announce')).toHaveText('Your message has been delivered.');
    await page.screenshot({ path: path.join(evidence, 'steer-landed.png') });

    release(profile, 'steer');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 2, done: true });
    expect(steersHeard(profile)).toHaveLength(1);
    expect(turnsHeard(profile)).toHaveLength(2);
    const rows = (await transcriptOf(page, sessionId)).filter((item) => item.text === 'Only the cart file.');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'user-message', payload: { v: 1, type: 'steer' } });
    expect(rows[0]!.turnId).toBe((await transcriptOf(page, sessionId)).find((item) => item.text.includes('EZTERMINAL_E2E_HOLD:steer'))?.turnId);
  });
});

test('text being written is dropped and redone: its deltas leave the transcript and the mark says so', async () => {
  test.setTimeout(120_000);
  await withProject('steer-writing', {}, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await startHeldTurn(page, sessionId, 'writing', 'EZTERMINAL_E2E_WRITING');
    await expect(session).toContainText('Half a thought that a steer drops');

    await send(session, 'Change course.');
    await expect(session.getByTestId('chat-steer-landed')).toHaveText('Added during the turn · text being written was dropped and redone', { timeout: 15_000 });
    await expect(session).not.toContainText('Half a thought that a steer drops');

    release(profile, 'writing');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 2, done: true });
    expect(steersHeard(profile)).toHaveLength(1);
  });
});

test('behind an approval a message says so and waits for the answer, then lands in that turn', async () => {
  test.setTimeout(120_000);
  await withProject('steer-approval', {}, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await send(session, 'EZTERMINAL_E2E_APPROVAL run the phone tests');
    const allow = session.locator('[data-dock-primary]');
    await expect(allow).toBeVisible({ timeout: 15_000 });
    await expect(session.getByTestId('structured-agent-composer-hint')).toContainText('it goes in after you answer');

    await send(session, 'Skip the slow ones.');
    const tray = session.getByTestId('chat-steer-tray');
    await expect(tray).toContainText('Delivered after the approval', { timeout: 15_000 });
    await expect(session.getByTestId('chat-steer-landed')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, 'steer-behind-approval.png') });
    expect(readJsonLines(profile, 'landed')).toEqual([]);

    await allow.click();
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    await expect(session.getByTestId('chat-steer-landed')).toHaveCount(1);
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 2, done: true });
    expect(steersHeard(profile)).toHaveLength(1);
  });
});

test('a steer the AI refuses falls back to the queue under the same words, says why, and runs once as the next turn', async () => {
  test.setTimeout(180_000);
  await withProject('steer-refused', {}, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const cases = [
      { how: 'review', says: 'A review turn can’t take it, so it went to the queue.' },
      { how: 'compact', says: 'Compaction can’t take it, so it went to the queue.' },
      { how: 'stale', says: 'The turn had just ended, so it went to the queue.' },
    ] as const;
    let turns = 1;
    for (const { how, says } of cases) {
      const token = `refused-${how}`;
      await startHeldTurn(page, sessionId, token);
      refuseSteers(profile, how);
      const text = `Not into a ${how} turn.`;
      await send(session, text);
      const fallback = session.getByTestId('chat-queue-fallback');
      await expect(fallback).toHaveText(says, { timeout: 15_000 });
      await expect(session.getByTestId('chat-steer-announce')).toHaveText(says);
      await expect(session.getByTestId('chat-steer-tray')).toHaveCount(0);
      await page.screenshot({ path: path.join(evidence, `steer-refused-${how}.png`) });
      takeSteers(profile);

      release(profile, token);
      turns += 2;
      await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: turns, done: true });
      await expect(fallback).toHaveCount(0);
      expect(turnsHeard(profile).filter((entry) => entry.text === text)).toHaveLength(1);
      expect((await transcriptOf(page, sessionId)).filter((item) => item.text === text)).toHaveLength(1);
    }
    expect(steersHeard(profile).map((entry) => entry.outcome)).toEqual(['review', 'compact', 'stale']);
  });
});

test('an attachment, a reply and a / command wait in the queue and say why; none reaches the running turn', async () => {
  test.setTimeout(180_000);
  await withProject('steer-not-plain', {}, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const says = 'Only plain text can be added, so it went to the queue.';
    const composer = session.getByTestId('structured-agent-composer-input');

    await startHeldTurn(page, sessionId, 'command');
    // The button, as a person would: the open command list takes Enter, here as anywhere else.
    await composer.fill('/fixture-note');
    await session.getByTestId('structured-agent-send').click();
    await expect(session.getByTestId('chat-queue-fallback')).toHaveText(says, { timeout: 15_000 });
    release(profile, 'command');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 3, done: true });

    await startHeldTurn(page, sessionId, 'attached');
    const note = path.join(profile, 'note.txt');
    writeFileSync(note, 'An attached note.\n');
    await session.locator('input[type="file"]').setInputFiles(note);
    await expect(composer).toBeEnabled();
    await send(session, 'Read this note.');
    await expect(session.getByTestId('chat-queue-fallback')).toHaveText(says, { timeout: 15_000 });
    release(profile, 'attached');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 5, done: true });

    await startHeldTurn(page, sessionId, 'replying');
    const answer = session.getByText('Structured Codex fixture ready.').first();
    await answer.hover();
    await session.getByRole('button', { name: 'Reply', exact: true }).first().click();
    await send(session, 'About that answer.');
    await expect(session.getByTestId('chat-queue-fallback')).toHaveText(says, { timeout: 15_000 });
    release(profile, 'replying');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 7, done: true });

    expect(steersHeard(profile)).toEqual([]);
    expect(turnsHeard(profile).map((entry) => entry.text)).toEqual(expect.arrayContaining(['/fixture-note']));
  });
});

test('끊고 보내기 still stops the turn: the message starts the next one and is never steered', async () => {
  test.setTimeout(120_000);
  await withProject('steer-interrupt', {}, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await startHeldTurn(page, sessionId, 'stop-me');
    const composer = session.getByTestId('structured-agent-composer-input');
    await composer.click();
    await composer.fill('Stop, do this first.');
    await session.getByTestId('structured-agent-interrupt-send').click();

    await expect.poll(() => readJsonLines(profile, 'interrupts').length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => turnsHeard(profile).at(-1)?.text, { timeout: 15_000 }).toBe('Stop, do this first.');
    await expect.poll(() => turnState(page, sessionId), { timeout: 15_000 }).toBeUndefined();
    expect(steersHeard(profile)).toEqual([]);
    const held = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))!.turns.filter((turn) => turn.sessionId === sessionId);
    expect(held.map((turn) => turn.state)).toEqual(['completed', 'interrupted', 'completed']);
  });
});

// ── A usage limit ────────────────────────────────────────────────────────────

test('a limit stops the turn, not the conversation: the card says when, nothing is amber, and "Continue." goes once, as the app\'s', async () => {
  test.setTimeout(120_000);
  await withProject('limit-once', { timing: { afterResetMs: 6_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);

    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');
    const card = limitCard(session);
    await expect(card).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Will try to continue at');
    await expect(card).toContainText('The try sends “Continue.”');
    await expect(session.getByTestId('chat-limit-limit-try-now')).toBeVisible();
    await expect(session.getByTestId('chat-limit-limit-auto-off')).toBeVisible();

    // A pause, not a failure: the conversation stays usable and no error row is written.
    expect(await hostState(page, sessionId)).toEqual({ agent: 'idle', session: 'idle' });
    const stopped = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))!.turns.filter((turn) => turn.sessionId === sessionId).at(-1)!;
    expect(stopped).toMatchObject({ state: 'failed', errorCode: 'usage-limit' });
    expect((await transcriptOf(page, sessionId)).filter((item) => item.kind === 'error')).toEqual([]);
    await expect(session.getByTestId('structured-agent-composer-input')).toBeEnabled();
    await expect(session.getByTestId('structured-agent-composer-hint')).toContainText('sending cancels auto-resume');

    await waitsOnAClock(page, session, sessionId, /Limit wait · /u);
    await expect(session.locator('.structured-agent-state').first().locator('..')).toContainText('Limit wait · ');
    await page.screenshot({ path: path.join(evidence, 'limit-waiting.png') });
    expect(continues(profile)).toEqual([]);

    liftLimit(profile);
    await reaches(page, sessionId, 'resumed', 30_000);
    expect(continues(profile)).toHaveLength(1);
    const sent = session.getByTestId('chat-app-sent');
    await expect(sent).toHaveCount(1);
    await expect(sent).toContainText('Sent by the app · at the scheduled time');
    await expect(sent).toContainText(RESUME_TEXT);
    await expect(card).toContainText('The app sent “Continue.” at');
    await expect(card).toContainText('Your stopped request was not sent again.');
    await page.screenshot({ path: path.join(evidence, 'limit-resumed.png') });

    // The person's first message was not sent again, and nothing goes twice however long the app stays up.
    await page.waitForTimeout(4_000);
    expect(continues(profile)).toHaveLength(1);
    expect(turnsHeard(profile).filter((entry) => entry.text === 'Fix every failing cart test.')).toHaveLength(1);
    await expect(listRow(page, sessionId)).not.toContainText('Limit');
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.usageLimits?.[sessionId]).toBeUndefined();
  });
});

test('refused, it tries once more after the wait, then stops and asks; a press then says the person pressed it', async () => {
  test.setTimeout(120_000);
  const retryAfterRefusalMs = 3_000;
  // A retry keeps the line's gap too, which the real ten minutes clear by far.
  await withProject('limit-refused', { timing: { afterResetMs: 1_000, retryAfterRefusalMs, lineGapMs: 1_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 1 });
    await send(session, 'Fix every failing cart test.');
    const card = limitCard(session);

    await reaches(page, sessionId, 'retrying');
    await expect(card).toContainText('The app will try once more at');
    await waitsOnAClock(page, session, sessionId, /Limit wait · /u);
    await page.screenshot({ path: path.join(evidence, 'limit-retrying.png') });

    await reaches(page, sessionId, 'gave-up');
    await expect(card).toContainText('The app will not try again by itself.');
    await asksThePerson(page, session, sessionId);
    await page.screenshot({ path: path.join(evidence, 'limit-gave-up.png') });
    const [first, second] = continues(profile);
    expect(continues(profile)).toHaveLength(2);
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(retryAfterRefusalMs - 200);

    // It stopped: no third try, however long it sits. One card, moved down to the last refused turn.
    await page.waitForTimeout(retryAfterRefusalMs + 2_000);
    expect(continues(profile)).toHaveLength(2);
    await expect(card).toHaveCount(1);

    // 이어서 하기 goes through the same send, and says it was pressed.
    liftLimit(profile);
    holdContinue(profile);
    await session.getByTestId('chat-limit-limit-resume').click();
    await reaches(page, sessionId, 'resuming');
    await expect(card).toContainText('You pressed Continue. Sending “Continue.”');
    await expect(card).not.toContainText('scheduled');
    letContinue(profile);
    await reaches(page, sessionId, 'resumed');
    expect(continues(profile)).toHaveLength(3);
    await expect(session.getByTestId('chat-app-sent').last()).toContainText('Sent by the app · you pressed Continue');
    await expect(page.getByTestId('shell-live-waiting')).toHaveCount(0);
  });
});

test('지금 시도 before the time: refused, the clock stands, and it spends no try', async () => {
  test.setTimeout(120_000);
  await withProject('limit-try-now', { timing: { afterResetMs: 15_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 1 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');
    const { resumeAt } = (await latestCard(page, sessionId))!;

    await session.getByTestId('chat-limit-limit-try-now').click();
    await expect.poll(async () => (await latestCard(page, sessionId))?.triedAt, { timeout: 15_000 }).toBeTruthy();
    expect(await latestCard(page, sessionId)).toMatchObject({ phase: 'waiting', resumeAt });
    expect(continues(profile)).toHaveLength(1);
    await expect(limitCard(session)).toContainText('Try now was refused at');
    await expect(session.getByTestId('chat-app-sent')).toContainText('Sent by the app · you pressed Try now');
    await waitsOnAClock(page, session, sessionId, /Limit wait · /u);
    await page.screenshot({ path: path.join(evidence, 'limit-tried-now.png') });

    // The refused try costs nothing: the schedule still goes, and it works.
    liftLimit(profile);
    await reaches(page, sessionId, 'resumed', 30_000);
    expect(continues(profile)).toHaveLength(2);
  });
});

test('자동 재개 끄기 cancels this card only: the time passes with no send, and 다시 켜기 brings the schedule back', async () => {
  test.setTimeout(120_000);
  await withProject('limit-card-off', { timing: { afterResetMs: 3_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');

    await session.getByTestId('chat-limit-limit-auto-off').click();
    await reaches(page, sessionId, 'off');
    const card = limitCard(session);
    await expect(card).toContainText('This conversation will not continue by itself.');
    await expect(session.getByTestId('chat-limit-limit-resume')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'limit-off.png') });

    await waitPast(page, sessionId);
    expect(continues(profile)).toEqual([]);
    expect(await cardPhase(page, sessionId)).toBe('off');
  });
});

test('turning the setting off cancels what has not gone out; on again restores nothing', async () => {
  test.setTimeout(120_000);
  await withProject('limit-setting-off', { timing: { afterResetMs: 10_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');

    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    const toggle = page.getByTestId('long-run-auto-resume');
    await expect(toggle).toBeChecked();
    await toggle.setChecked(false);
    await reaches(page, sessionId, 'off');
    expect(await latestCard(page, sessionId)).toMatchObject({ offBy: 'setting' });

    // On again brings back nothing already cancelled.
    await toggle.setChecked(true);
    await expect(toggle).toBeChecked();
    await page.getByTestId('btn-toggle-settings').click();
    await expect(limitCard(session)).toContainText('Turning auto-resume off in Settings cancelled this schedule.');
    await waitPast(page, sessionId);
    expect(continues(profile)).toEqual([]);
    expect(await cardPhase(page, sessionId)).toBe('off');
  });
});

test('with the setting off a new stop schedules nothing', async () => {
  test.setTimeout(120_000);
  await withProject('limit-setting-was-off', { timing: { afterResetMs: 1_000 } }, async ({ page, profile, workspaceId }) => {
    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    await page.getByTestId('long-run-auto-resume').setChecked(false);
    await page.getByTestId('btn-toggle-settings').click();

    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    limitAccount(profile, { window: 'five-hour', resetIn: 1 });
    await send(sessionView(page, sessionId), 'Fix every failing cart test.');
    await reaches(page, sessionId, 'off');
    await waitPast(page, sessionId);
    expect(continues(profile)).toEqual([]);
  });
});

test('a person who writes first cancels the send: it never goes, whether their message gets through or is refused', async () => {
  test.setTimeout(150_000);
  await withProject('limit-person-first', { timing: { afterResetMs: 5_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);

    // Refused: it stays in the conversation, and the card leaves the next step to the person.
    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');
    await send(session, 'I will fix the discount myself.');
    await reaches(page, sessionId, 'person-refused');
    await expect(limitCard(session)).toContainText('Your message was refused at the limit too. Auto-resume is cancelled.');
    await page.screenshot({ path: path.join(evidence, 'limit-person-refused.png') });
    await waitPast(page, sessionId);
    expect(continues(profile)).toEqual([]);
    expect(turnsHeard(profile).filter((entry) => entry.text === 'I will fix the discount myself.')).toHaveLength(1);

    // A refused message keeps this stop's one card; one that gets through closes it, and the next limit is a stop of its own.
    await afterTheLimit(page, profile, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix the rest of them.');
    await reaches(page, sessionId, 'waiting');

    // Through: the stop is over, and nothing goes out for it.
    liftLimit(profile);
    await send(session, 'Just run the tests.');
    await reaches(page, sessionId, 'cancelled');
    await waitPast(page, sessionId);
    expect(continues(profile)).toEqual([]);
    expect(turnsHeard(profile).filter((entry) => entry.text === 'Just run the tests.')).toHaveLength(1);
  });
});

test('a message that races the stop says what it really does: it goes now, in the app\'s words, and cancels the schedule', async () => {
  test.setTimeout(120_000);
  await withProject('limit-raced', { timing: { afterResetMs: 5_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(sessionView(page, sessionId), 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');

    // A window whose last snapshot still showed the turn running: Enter meant it for a turn that has just stopped.
    const { turnId } = (await latestCard(page, sessionId))!;
    const snapshot = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))!;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: 'e2e-raced-steer', idempotencyKey: 'e2e-raced-steer', expectedRevision: snapshot.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' }, type: 'agent.steer', payload: { sessionId, turnId, prompt: 'One more thing.' },
    }));
    expect(receipt.ok).toBe(true);

    await reaches(page, sessionId, 'person-refused');
    const row = (await transcriptOf(page, sessionId)).find((item) => item.text === 'One more thing.');
    expect(row?.payload).toEqual({ v: 1, type: 'steer-queued', reason: 'limit-open' });
    expect(steersHeard(profile)).toEqual([]);
    expect(turnsHeard(profile).filter((entry) => entry.text === 'One more thing.')).toHaveLength(1);
    await waitPast(page, sessionId);
    expect(continues(profile)).toEqual([]);
  });
});

test('a press that comes too late says so in the app\'s words', async () => {
  test.setTimeout(120_000);
  await withProject('limit-late-press', { timing: { afterResetMs: 15_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');

    // Their message is running, so the schedule is closed, and the card has not caught up: its button is still there.
    liftLimit(profile);
    await startHeldTurn(page, sessionId, 'late');
    await session.getByTestId('chat-limit-limit-try-now').click();
    const banner = session.getByTestId('structured-agent-wrap-up-error');
    await expect(banner).toContainText('This card moved on before your press reached it.');
    await expect(banner).not.toContainText('Check it again');
    release(profile, 'late');
    await reaches(page, sessionId, 'cancelled');
    await page.waitForTimeout(1_000);
    expect(continues(profile)).toEqual([]);
  });
});

test('a weekly limit, a far reset and an unknown reset ask first; the amber follows them, and only a person starts anything', async () => {
  test.setTimeout(150_000);
  await withProject('limit-asks', { timing: { afterResetMs: 2_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const card = limitCard(session);

    limitAccount(profile, { window: 'weekly', resetIn: 2 * 24 * HOURS });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'ask-reset');
    await expect(card).toContainText('A weekly limit asks first.');
    await asksThePerson(page, session, sessionId);
    await page.screenshot({ path: path.join(evidence, 'limit-weekly-asks.png') });

    // 그때 이어서 하기 is a person's yes: it waits on a clock now, so the amber goes, and 취소 brings the question back.
    await session.getByTestId('chat-limit-limit-schedule').click();
    await reaches(page, sessionId, 'scheduled');
    await waitsOnAClock(page, session, sessionId, /Limit wait · /u);
    await session.getByTestId('chat-limit-limit-unschedule').click();
    await reaches(page, sessionId, 'ask-reset');
    await asksThePerson(page, session, sessionId);
    await session.getByTestId('chat-limit-limit-leave').click();
    await reaches(page, sessionId, 'left');
    await expect(page.getByTestId('shell-live-waiting')).toHaveCount(0);

    await afterTheLimit(page, profile, sessionId);
    limitAccount(profile, { window: 'five-hour', resetIn: 8 * HOURS });
    await send(session, 'And the next one.');
    await reaches(page, sessionId, 'ask-reset');
    await expect(card.last()).toContainText('The expected reset is more than 6 hours away, so the app asks first.');
    await session.getByTestId('chat-limit-limit-leave').last().click();
    await reaches(page, sessionId, 'left');

    await afterTheLimit(page, profile, sessionId);
    limitAccount(profile, { kind: 'no-reset' });
    await send(session, 'And one more.');
    await reaches(page, sessionId, 'ask-unknown');
    await expect(card.last()).toContainText('The reset time isn’t known.');
    await asksThePerson(page, session, sessionId);
    await page.screenshot({ path: path.join(evidence, 'limit-unknown-asks.png') });
    await page.waitForTimeout(4_000);
    expect(continues(profile)).toEqual([]);

    // 이어서 하기 on an unknown reset: the card says when it went, though no schedule ever named a time.
    liftLimit(profile);
    await session.getByTestId('chat-limit-limit-resume').click();
    await reaches(page, sessionId, 'resumed');
    expect(continues(profile)).toHaveLength(1);
    await expect(card.last()).toContainText(/The app sent “Continue\.” at \S/u);
  });
});

test('a plan that does not include this AI stops with no button and nothing to wait for', async () => {
  test.setTimeout(120_000);
  await withProject('limit-not-included', { timing: { afterResetMs: 1_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    limitAccount(profile, { kind: 'not-included' });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'not-included');
    await expect(limitCard(session)).toContainText('This plan doesn’t include Codex usage.');
    await expect(limitCard(session).getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('shell-live-waiting')).toHaveCount(0);
    await page.waitForTimeout(3_000);
    expect(continues(profile)).toEqual([]);
  });
});

test('a reset that passed while the app was closed asks on reopening, and nothing goes by itself', async () => {
  test.setTimeout(150_000);
  const { app, page, profile, workspaceId } = await launchProject('limit-reopened', { timing: { afterResetMs: 3_000 } });
  let closed = false;
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    limitAccount(profile, { window: 'five-hour', resetIn: 1 });
    await send(sessionView(page, sessionId), 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');
    const { resumeAt } = (await latestCard(page, sessionId))!;
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());
    await app.close();
    closed = true;
    await new Promise((resolve) => { setTimeout(resolve, Math.max(0, Date.parse(resumeAt!) - Date.now()) + 500); });

    const relaunched = await launchApp(profile, appEnvironment(profile, { afterResetMs: 3_000 }));
    try {
      const nextPage = await relaunched.firstWindow();
      await resizeWindow(nextPage, { width: 1600, height: 950 });
      await setWindowFocused(relaunched, nextPage, true);
      const nextSession = sessionView(nextPage, sessionId);
      await reaches(nextPage, sessionId, 'ask-reopened', 30_000);
      await expect(limitCard(nextSession)).toContainText('while the PC app was closed');
      await asksThePerson(nextPage, nextSession, sessionId);
      await nextPage.screenshot({ path: path.join(evidence, 'limit-reopened.png') });
      await nextPage.waitForTimeout(4_000);
      expect(continues(profile)).toEqual([]);

      liftLimit(profile);
      await nextSession.getByTestId('chat-limit-limit-resume').click();
      await reaches(nextPage, sessionId, 'resumed', 30_000);
      expect(continues(profile)).toHaveLength(1);
    } catch (error) {
      await diagnose(relaunched.windows()[0]!, 'limit-reopened');
      throw error;
    } finally {
      await relaunched.close();
    }
  } catch (error) {
    if (!closed) await diagnose(page, 'limit-reopened');
    throw error;
  } finally {
    if (!closed) await app.close();
  }
});

test('two conversations of one AI go 60 seconds apart, the longer-stopped first, and the second does not wait for the first', async () => {
  test.setTimeout(240_000);
  await withProject('limit-line', { timing: { afterResetMs: 8_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const firstId = await firstReply(page, 'The first conversation.');
    await draftIn(page, workspaceId);
    const secondId = await firstReply(page, 'The second conversation.');
    const threadOf = (text: string): string => turnsHeard(profile).find((entry) => entry.text === text)!.threadId;
    const firstThread = threadOf('The first conversation.');
    const secondThread = threadOf('The second conversation.');
    expect(firstThread).not.toBe(secondThread);

    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await page.locator(`[data-testid="shell-live-row"][data-session="${firstId}"]`).click();
    await send(sessionView(page, firstId), 'Stopped first.');
    await reaches(page, firstId, 'waiting');
    await page.locator(`[data-testid="shell-live-row"][data-session="${secondId}"]`).click();
    await send(sessionView(page, secondId), 'Stopped second.');
    await reaches(page, secondId, 'waiting');

    await expect(limitCard(sessionView(page, secondId))).toContainText('2 conversations get this in turn · this one is number 2');
    await page.screenshot({ path: path.join(evidence, 'limit-line.png') });

    // The first send stays under way until the second has gone: the line never waits for a result.
    liftLimit(profile);
    holdContinue(profile);
    await expect.poll(() => continues(profile).length, { timeout: 40_000 }).toBe(1);
    await expect.poll(() => continues(profile).length, { timeout: 90_000 }).toBe(2);
    letContinue(profile);
    const [first, second] = continues(profile);
    expect(first!.threadId).toBe(firstThread);
    expect(second!.threadId).toBe(secondThread);
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(58_000);
    await reaches(page, firstId, 'resumed');
    await reaches(page, secondId, 'resumed');
    expect(continues(profile)).toHaveLength(2);
  });
});

test('a limit landing on a message still on its way says it cannot tell, and offers no send that could read twice', async () => {
  test.setTimeout(120_000);
  await withProject('steer-caught', { timing: { afterResetMs: 30_000 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await startHeldTurn(page, sessionId, 'caught');
    holdLanding(profile);
    await send(session, 'Only the cart file.');
    const tray = session.getByTestId('chat-steer-tray');
    await expect(tray).toContainText('On its way');

    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    release(profile, 'caught');
    await reaches(page, sessionId, 'waiting');
    await expect(tray).toContainText('The limit stopped the turn, so it is not known whether it arrived', { timeout: 15_000 });
    await expect(session.getByTestId('chat-steer-to-queue')).toHaveCount(0);
    await expect(session.getByTestId('chat-steer-to-box')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'steer-caught-by-limit.png') });
    expect(steersHeard(profile)).toHaveLength(1);
  });
});

test('a restart with a message on its way says it cannot tell, and sends nothing again', async () => {
  test.setTimeout(150_000);
  const { app, page, profile, workspaceId } = await launchProject('steer-restart');
  let closed = false;
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await startHeldTurn(page, sessionId, 'restart');
    holdLanding(profile);
    await send(session, 'Only the cart file.');
    await expect(session.getByTestId('chat-steer-tray')).toContainText('On its way');
    await expect.poll(() => steersHeard(profile).length, { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());
    await app.close();
    closed = true;
    letLand(profile);

    const relaunched = await launchApp(profile, appEnvironment(profile, {}));
    try {
      const nextPage = await relaunched.firstWindow();
      await resizeWindow(nextPage, { width: 1600, height: 950 });
      await setWindowFocused(relaunched, nextPage, true);
      const nextSession = sessionView(nextPage, sessionId);
      const tray = nextSession.getByTestId('chat-steer-tray');
      await expect(tray).toContainText('The turn stopped, so it is not known whether it arrived', { timeout: 30_000 });
      await expect(nextSession.getByTestId('chat-steer-to-queue')).toHaveCount(0);
      await expect(nextSession.getByTestId('chat-steer-to-box')).toBeVisible();
      await nextPage.screenshot({ path: path.join(evidence, 'steer-after-restart.png') });
      expect(steersHeard(profile)).toHaveLength(1);
      expect(turnsHeard(profile).filter((entry) => entry.text === 'Only the cart file.')).toEqual([]);

      await nextSession.getByTestId('chat-steer-to-box').click();
      await expect(nextSession.getByTestId('structured-agent-composer-input')).toHaveValue('Only the cart file.');
      await expect(tray).toHaveCount(0);
    } catch (error) {
      await diagnose(relaunched.windows()[0]!, 'steer-restart');
      throw error;
    } finally {
      await relaunched.close();
    }
  } catch (error) {
    if (!closed) await diagnose(page, 'steer-restart');
    throw error;
  } finally {
    if (!closed) await app.close();
  }
});

// ── Floors and old hosts ─────────────────────────────────────────────────────

test('Codex below the measured version: Enter queues, nothing steers, and a limit is the error it always was', async () => {
  test.setTimeout(120_000);
  await withProject('floor', { version: '0.164.0', timing: { afterResetMs: 500 } }, async ({ page, profile, workspaceId }) => {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.longRunSupport?.codex).toBe(false);

    await startHeldTurn(page, sessionId, 'floor');
    await expect(session.getByTestId('structured-agent-composer-hint')).not.toContainText('Enter adds it');
    await send(session, 'Next, the docs.');
    await expect(session.locator('.chat-queue__item')).toContainText('Next, the docs.', { timeout: 15_000 });
    await expect(session.getByTestId('chat-queue-fallback')).toHaveCount(0);
    expect(steersHeard(profile)).toEqual([]);
    release(profile, 'floor');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 3, done: true });

    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await expect.poll(() => hostState(page, sessionId), { timeout: 20_000 }).toEqual({ agent: 'error', session: 'failed' });
    await expect(limitCard(session)).toHaveCount(0);
    await page.waitForTimeout(3_000);
    expect(continues(profile)).toEqual([]);
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.usageLimits).toBeUndefined();
  });
});

test('a host that does not advertise long-run-v1: Enter queues, no tray, and a card stays a record with no buttons', async () => {
  test.setTimeout(120_000);
  await withProject('old-host', { timing: { afterResetMs: 15_000 } }, async ({ app, page, profile, workspaceId }) => {
    // The window reads every snapshot through this one channel; the host behind it does not change. What this holds is the client's side.
    await app.evaluate(({ ipcMain }, capability) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ capabilities: string[] } | null>> })._invokeHandlers;
      const original = handlers.get('daemon:get-snapshot')!;
      handlers.set('daemon:get-snapshot', async (...args) => {
        const snapshot = await original(...args);
        return snapshot && { ...snapshot, capabilities: snapshot.capabilities.filter((entry) => entry !== capability) };
      });
    }, LONG_RUN_CAPABILITY);
    await page.reload();
    await setWindowFocused(app, page, true);
    await expect(page.getByTestId('cmd-input')).toBeVisible();

    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    await expect(page.getByTestId('agent-chat-settings')).toBeVisible();
    await expect(page.getByTestId('long-run-auto-resume')).toHaveCount(0);
    await page.getByTestId('btn-toggle-settings').click();

    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await startHeldTurn(page, sessionId, 'old');
    await send(session, 'Next, the docs.');
    await expect(session.locator('.chat-queue__item')).toContainText('Next, the docs.', { timeout: 15_000 });
    await expect(session.getByTestId('chat-steer-tray')).toHaveCount(0);
    expect(steersHeard(profile)).toEqual([]);
    release(profile, 'old');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 3, done: true });

    limitAccount(profile, { window: 'five-hour', resetIn: 2 });
    await send(session, 'Fix every failing cart test.');
    await reaches(page, sessionId, 'waiting');
    await expect(limitCard(session)).toBeVisible();
    await expect(limitCard(session).getByRole('button')).toHaveCount(0);
  });
});
