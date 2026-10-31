import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand, type DaemonTranscriptItem } from '../src/shared/daemon-protocol';
import {
  PREDICT_INSTRUCTION, RECAP_INSTRUCTION, suggestedTaskBranches, suggestedTaskChildSessionId, SUGGEST_TASK_INSTRUCTIONS, TURN_WRAP_UP_CAPABILITY,
} from '../src/shared/turn-wrap-up';
import { launchApp } from './launch-app';
import { openProjectBoard, startNewConversation } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test, type ElectronApplication, type Locator, type Page } from './test';
import { resizeWindow } from './workbench-navigation';

/**
 * Turn wrap-up (`turn-wrap-up-v1`) in the real workbench with the fake Codex: the next-message suggestion in the
 * composer, recaps of turns no screen was showing, and the tasks the AI suggests through the real `suggest_task`
 * tool on the conversation's MCP endpoint. The fake Codex answers forks from control files beside its version file
 * and logs each with its effort; the host's rows, commands and worktrees are all the product's.
 *
 * "No screen shows it" is driven by the two things a person does: the window loses focus (delivered as the native
 * state, as terminal-render-lifecycle does, so OS focus on this PC does not matter) or the board covers the conversation.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
/** The oldest Codex wrap-up runs on (CODEX_WRAP_UP_MINIMUM_VERSION); the fixture's default is older. */
const WRAP_UP_CODEX_VERSION = '0.165.0';
const evidence = path.resolve('artifacts/turn-wrap-up/e2e');
mkdirSync(evidence, { recursive: true });

const PREDICTED = 'Run the tests next.';
const RECAP_LINE = 'I answered with the fixture reply.';

interface SuggestedTaskInput {
  readonly title: string;
  readonly rationale: string;
  readonly prompt: string;
  readonly worktree?: boolean;
}

// ── The app with the fake Codex ──────────────────────────────────────────────

function fakeCodexEnvironment(profile: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: profile };
}

async function launchWithCodex(profile: string, version = WRAP_UP_CODEX_VERSION): Promise<ElectronApplication> {
  writeFileSync(path.join(profile, 'ezterminal-e2e-codex-version.txt'), version, 'utf8');
  return launchApp(profile, fakeCodexEnvironment(profile));
}

async function enableCodex(page: Page, version: string): Promise<void> {
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  expect(probe.executableVersion).toBe(version);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const id = `e2e-wrap-up-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-turn-wrap-up' }, type: 'provider.enable',
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

/** Registers the folder as a project with Codex enabled; resolves its daemon workspace. */
async function addProject(page: Page, root: string, name: string, version = WRAP_UP_CODEX_VERSION): Promise<{ readonly projectId: string; readonly workspaceId: string }> {
  const saved = await page.evaluate(({ primaryRoot, projectName }) => window.ezterminal.saveAgentProject({ name: projectName, primaryRoot, additionalRoots: [], pinned: false }), { primaryRoot: root, projectName: name });
  if (!saved.ok) throw new Error(saved.reason);
  await enableCodex(page, version);
  // The app stores the real path; TEMP may be an 8.3 alias (as on CI).
  const storedRoot = realpathSync.native(root).toLowerCase();
  let workspaceId = '';
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    workspaceId = snapshot?.workspaces.find((workspace) => workspace.rootPath.toLowerCase() === storedRoot)?.id ?? '';
    return workspaceId;
  }, { timeout: 15_000 }).not.toBe('');
  return { projectId: saved.project.projectId, workspaceId };
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
  // After a launch the box waits for its saved draft ("Restoring secure draft…"); Enter does nothing until then.
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
  await send(page.getByTestId('structured-agent-session').first(), text);
  await expect(page.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
  const sessionId = (await page.getByTestId('structured-agent-session').first().getAttribute('data-session-id'))!;
  await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 1, done: true });
  return sessionId;
}

/** A message, and its turn over. */
async function exchange(page: Page, sessionId: string, text: string): Promise<void> {
  const before = (await turnsOf(page, sessionId)).count;
  await send(sessionView(page, sessionId), text);
  await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: before + 1, done: true });
}

async function turnState(page: Page, sessionId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => {
    const snapshot = await window.ezterminal.getDaemonSnapshot();
    const agent = snapshot?.agents.find((entry) => entry.sessionId === id);
    return agent?.currentTurnId ? snapshot?.turns.find((entry) => entry.id === agent.currentTurnId)?.state : undefined;
  }, sessionId);
}

/** A turn the fake Codex keeps running until `release(profile, token)`. */
async function startHeldTurn(page: Page, sessionId: string, token: string): Promise<void> {
  await send(sessionView(page, sessionId), `EZTERMINAL_E2E_HOLD:${token} Keep working on it.`);
  await expect.poll(() => turnState(page, sessionId), { timeout: 20_000 }).toBe('working');
}

function release(profile: string, token: string): void {
  writeFileSync(path.join(profile, `ezterminal-e2e-codex-release-${token}`), '');
}

const control = (profile: string, name: string): string => path.join(profile, `ezterminal-e2e-codex-${name}`);

function readJsonLines(profile: string, name: string): Record<string, unknown>[] {
  const file = path.join(profile, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface ForkEntry {
  readonly threadId: string;
  readonly turnId: string;
  readonly purpose: 'predict' | 'recap';
  readonly phase: 'started' | 'answered' | 'interrupted' | 'failed';
  readonly effort?: string | null;
  readonly stopped?: boolean;
  readonly prompt?: string;
}

function forks(profile: string, purpose: ForkEntry['purpose'], phase: ForkEntry['phase'] = 'started'): readonly ForkEntry[] {
  return (readJsonLines(profile, 'ezterminal-e2e-codex-wrap-up-forks.jsonl') as unknown as ForkEntry[])
    .filter((entry) => entry.purpose === purpose && entry.phase === phase);
}

function releasedThreads(profile: string): readonly string[] {
  try {
    return JSON.parse(readFileSync(path.join(profile, 'ezterminal-e2e-codex-unsubscribed.json'), 'utf8')) as string[];
  } catch {
    return [];
  }
}

function writeTasks(profile: string, name: string, tasks: readonly SuggestedTaskInput[]): void {
  writeFileSync(control(profile, `suggest-${name}.json`), JSON.stringify(tasks));
}

async function transcriptOf(page: Page, sessionId: string): Promise<readonly DaemonTranscriptItem[]> {
  return page.evaluate((id) => window.ezterminal.getDaemonTranscript(id, 0, 500), sessionId);
}

const recapRows = (items: readonly DaemonTranscriptItem[]): readonly DaemonTranscriptItem[] => items.filter((item) => item.payload?.type === 'recap');
const toolCalls = (items: readonly DaemonTranscriptItem[], name: string): readonly DaemonTranscriptItem[] => items.filter((item) => (
  item.kind === 'tool-call' && item.payload?.type === 'tool' && item.payload.name === name
));

let nativeSequence = 1_000_000;

/**
 * The window's focus as the app hears it. The sequence stays above any real report, so a real focus change on this
 * PC cannot overturn it while a spec runs.
 */
async function setWindowFocused(app: ElectronApplication, page: Page, focused: boolean): Promise<void> {
  nativeSequence += 1;
  await app.evaluate(({ BrowserWindow }, update) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.send('desktop-window:states-changed', {
      sequence: update.sequence,
      windows: [{
        windowName: 'main', kind: 'main', focused: update.focused, visible: true, minimized: false, maximized: false, fullscreen: false,
        displayId: '1', scaleFactor: 1, sequence: update.sequence,
      }],
    });
  }, { focused, sequence: nativeSequence });
  await expect(page.locator('html')).toHaveAttribute('data-runtime-tier', focused ? 'active' : 'passive');
}

async function openWrapUpSettings(page: Page): Promise<Locator> {
  await page.getByTestId('btn-toggle-settings').click();
  await page.getByTestId('settings-category-agents').click();
  const section = page.getByTestId('turn-wrap-up-settings');
  await expect(section).toBeVisible();
  return section;
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId('btn-toggle-settings').click();
  await expect(page.getByTestId('turn-wrap-up-settings')).toHaveCount(0);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function seedRepository(root: string): void {
  git(root, 'init', '--initial-branch=main', '--quiet');
  git(root, 'config', 'user.name', 'Wrap-up E2E');
  git(root, 'config', 'user.email', 'wrap-up-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), '# Wrap-up kit\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Baseline');
}

async function diagnose(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(evidence, `${name}-failure.png`) }).catch(() => undefined);
  console.log((await page.locator('body').innerText().catch(() => '')).slice(-6000));
}

interface Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly profile: string;
  readonly projectRoot: string;
}

/** A focused app with a project; a spec's own file control comes before its first message. */
async function launchProject(name: string, options: { readonly version?: string; readonly repository?: boolean } = {}): Promise<Launched & { readonly projectId: string; readonly workspaceId: string }> {
  const profile = createRegisteredE2eTempDir(`ezterm-wrap-up-${name}-profile-`);
  const projectRoot = createRegisteredE2eTempDir(`ezterm-wrap-up-${name}-project-`);
  if (options.repository) seedRepository(projectRoot);
  else writeFileSync(path.join(projectRoot, 'README.md'), '# Wrap-up kit\n');
  const app = await launchWithCodex(profile, options.version);
  const page = await app.firstWindow();
  await resizeWindow(page, { width: 1600, height: 950 });
  await expect(page.getByTestId('cmd-input')).toBeVisible();
  await setWindowFocused(app, page, true);
  const { projectId, workspaceId } = await addProject(page, projectRoot, name, options.version);
  return { app, page, profile, projectRoot, projectId, workspaceId };
}

/** A settled run folds to its summary, which names the failure; opened, it shows the `suggest_task` calls that failed. */
async function openRefusedCall(session: Locator): Promise<Locator> {
  const run = session.locator('.chat-run').filter({ hasText: '1 failed' });
  await run.locator('.chat-run__header').click();
  return run.locator('.chat-tool[data-status="failed"]').filter({ hasText: 'Tried to call' }).filter({ hasText: 'ezterminal_orchestration / suggest_task' });
}

function ghostOf(session: Locator): Locator {
  return session.getByTestId('structured-agent-suggestion').locator('.chat-composer__ghost-text');
}

// ── Next-message suggestion ──────────────────────────────────────────────────

test('a suggestion shows as ghost text; Tab fills without sending, typing sets it aside, (none) leaves the box as it is, a new message drops a guess in flight', async () => {
  test.setTimeout(180_000);
  const { app, page, profile, workspaceId } = await launchProject('suggest');
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const composer = session.getByTestId('structured-agent-composer-input');
    const ghost = ghostOf(session);

    // The guess comes from a read-only ephemeral fork at low effort, and shows only in the empty box.
    await expect(ghost).toHaveText(PREDICTED, { timeout: 15_000 });
    await expect(composer).toHaveValue('');
    await page.screenshot({ path: path.join(evidence, 'suggestion-ghost.png') });
    const [fork] = forks(profile, 'predict');
    expect(fork).toMatchObject({ effort: 'low' });
    expect(fork!.prompt).toContain(PREDICT_INSTRUCTION);
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-forks.jsonl').at(-1)).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl')).toHaveLength(1);

    // Tab fills the box and sends nothing; the box is the person's from here on.
    await composer.click();
    await composer.press('Tab');
    await expect(composer).toHaveValue(PREDICTED);
    await expect(composer).toBeFocused();
    await expect(ghost).toHaveCount(0);
    expect(await turnsOf(page, sessionId)).toEqual({ count: 1, done: true });
    await composer.fill('');
    await expect(ghost).toHaveCount(0);

    // Plan mode hides it while on. Esc sets it aside for this turn and stops nothing.
    await exchange(page, sessionId, 'Another question.');
    await expect(ghost).toHaveText(PREDICTED, { timeout: 15_000 });
    const plan = session.getByTestId('structured-agent-live-plan');
    await plan.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'true');
    await expect(ghost).toHaveCount(0);
    await plan.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    await expect(ghost).toHaveText(PREDICTED);
    await composer.click();
    await composer.press('Escape');
    await expect(ghost).toHaveCount(0);

    // A new turn's guess; a typed character sets it aside, and clearing the box does not bring it back.
    await exchange(page, sessionId, 'And a third.');
    await expect(ghost).toHaveText(PREDICTED, { timeout: 15_000 });
    await composer.click();
    await composer.pressSequentially('x');
    await expect(ghost).toHaveCount(0);
    await composer.press('Backspace');
    await expect(composer).toHaveValue('');
    await expect(ghost).toHaveCount(0);

    // (none): the AI has no guess, so the composer stays exactly as it is today. The fork was let go, so it answered.
    writeFileSync(control(profile, 'predict-reply.txt'), '(none)');
    await exchange(page, sessionId, 'That is all.');
    await expect.poll(() => forks(profile, 'predict', 'answered').length, { timeout: 15_000 }).toBe(4);
    await expect.poll(() => releasedThreads(profile)).toContain(forks(profile, 'predict', 'answered')[3]!.threadId);
    await expect(ghost).toHaveCount(0);
    await expect(composer).not.toHaveAttribute('aria-describedby', /suggestion/u);
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.nextPromptSuggestions).toBeUndefined();
    rmSync(control(profile, 'predict-reply.txt'));

    // A guess still running when the person writes: the message goes at once, the fork is stopped, and nothing of it shows.
    writeFileSync(control(profile, 'hold-predict'), '');
    await exchange(page, sessionId, 'One more thing.');
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(5);
    await send(session, 'And another.');
    await expect.poll(() => forks(profile, 'predict', 'interrupted').length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 6, done: true });
    rmSync(control(profile, 'hold-predict'));
    await expect(ghost).toHaveText(PREDICTED, { timeout: 15_000 });
    expect(forks(profile, 'predict', 'answered')).toHaveLength(5);

    // The guess lives on the host, so a reloaded window shows it again.
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());
    await page.reload();
    await expect(ghostOf(sessionView(page, sessionId))).toHaveText(PREDICTED, { timeout: 30_000 });
  } catch (error) {
    await diagnose(page, 'suggestion');
    throw error;
  } finally {
    await app.close();
  }
});

// ── Recaps ───────────────────────────────────────────────────────────────────

test('a recap is written when no screen shows the conversation, not while one does, and once per turn; a failure says why and can be written again', async () => {
  test.setTimeout(180_000);
  const { app, page, profile, projectId, workspaceId } = await launchProject('recap');
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const card = session.getByTestId('chat-recap-card');
    const line = session.getByTestId('chat-recap-line');

    // Viewed: the same pass that offers a recap started this guess, and it offered none.
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(1);
    expect(forks(profile, 'recap')).toEqual([]);
    expect(recapRows(await transcriptOf(page, sessionId))).toEqual([]);
    await expect(card).toHaveCount(0);

    // The window loses focus while the AI works. The line shows while the AI writes, then its own words.
    await startHeldTurn(page, sessionId, 'away');
    await setWindowFocused(app, page, false);
    writeFileSync(control(profile, 'hold-recap'), '');
    release(profile, 'away');
    await expect(line).toHaveAttribute('data-state', 'generating', { timeout: 15_000 });
    await expect(line).toContainText('Codex is writing a recap…');
    await page.screenshot({ path: path.join(evidence, 'recap-generating.png') });
    rmSync(control(profile, 'hold-recap'));
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(line).toHaveCount(0);
    await expect(card).toHaveAttribute('aria-label', /Recap · While you were away · Written by Codex/u);
    await expect(card.getByTestId('chat-recap-text')).toContainText(RECAP_LINE);
    await page.screenshot({ path: path.join(evidence, 'recap-card.png') });
    // The conversation's own effort, and nothing of the fork reached the conversation.
    const recapFork = forks(profile, 'recap');
    expect(recapFork).toHaveLength(1);
    expect(recapFork[0]).toMatchObject({ stopped: false, effort: null });
    expect(recapFork[0]!.prompt).toContain(RECAP_INSTRUCTION);
    expect(await turnsOf(page, sessionId)).toEqual({ count: 2, done: true });
    const turn = recapRows(await transcriptOf(page, sessionId))[0]!.turnId;

    // Once per turn: another pass over the same turn writes nothing. Back on screen, the card stays.
    await setWindowFocused(app, page, true);
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await expect(card).toBeVisible();
    expect(forks(profile, 'recap')).toHaveLength(1);
    expect(new Set(recapRows(await transcriptOf(page, sessionId)).map((item) => item.turnId))).toEqual(new Set([turn]));

    // Viewed again, the next turn gets none.
    await exchange(page, sessionId, 'While I watch.');
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    expect(forks(profile, 'recap')).toHaveLength(1);

    // A recap that fails is one quiet line with the reason and 다시 만들기; that is the person's call, so it runs though the screen shows it.
    await setWindowFocused(app, page, false);
    writeFileSync(control(profile, 'fail-recap'), '');
    await exchange(page, sessionId, 'Now the failing one.');
    await expect(line).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
    await expect(line).toContainText('Couldn’t write a recap · no response');
    await page.screenshot({ path: path.join(evidence, 'recap-failed.png') });
    rmSync(control(profile, 'fail-recap'));
    await setWindowFocused(app, page, true);
    await line.getByRole('button', { name: 'Write it again', exact: true }).click();
    await expect(line).toHaveCount(0, { timeout: 15_000 });
    await expect(session.getByTestId('chat-recap-card')).toHaveCount(2);
    expect(forks(profile, 'recap')).toHaveLength(3);

    // The board over the conversation is no screen showing it either, though the window keeps focus.
    await startHeldTurn(page, sessionId, 'board');
    await openProjectBoard(page, projectId);
    release(profile, 'board');
    await expect.poll(() => forks(profile, 'recap').length, { timeout: 15_000 }).toBe(4);
    await expect.poll(async () => recapRows(await transcriptOf(page, sessionId)).at(-1)?.payload).toMatchObject({ state: 'complete', trigger: 'unattended' });
  } catch (error) {
    await diagnose(page, 'recap');
    throw error;
  } finally {
    await app.close();
  }
});

test('with two conversations only the one off screen gets a recap; a queued follow-up takes its turn’s place; the recap comes after the tasks, cut to fit', async () => {
  test.setTimeout(180_000);
  const { app, page, profile, workspaceId } = await launchProject('two');
  try {
    await draftIn(page, workspaceId);
    const firstId = await firstReply(page);
    await startHeldTurn(page, firstId, 'background');

    // A second conversation takes the screen while the first works.
    await draftIn(page, workspaceId);
    const draft = page.getByTestId('conversation-start');
    await draft.getByTestId('structured-agent-composer-input').fill('A second conversation.');
    await draft.getByTestId('structured-agent-composer-input').press('Enter');
    let secondId = '';
    await expect.poll(async () => {
      secondId = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents.find((agent) => agent.sessionId !== firstId)?.sessionId ?? '';
      return secondId;
    }, { timeout: 30_000 }).not.toBe('');
    await expect.poll(() => turnsOf(page, secondId), { timeout: 30_000 }).toEqual({ count: 1, done: true });
    await expect(sessionView(page, secondId)).toBeVisible();

    // The first finishes behind it: same window, same focus, but no screen shows that conversation.
    release(profile, 'background');
    await expect.poll(async () => recapRows(await transcriptOf(page, firstId)).at(-1)?.payload, { timeout: 15_000 }).toMatchObject({ state: 'complete', trigger: 'unattended' });
    expect(recapRows(await transcriptOf(page, secondId))).toEqual([]);
    expect(forks(profile, 'recap')).toHaveLength(1);
    await page.locator(`[data-testid="shell-live-row"][data-session="${firstId}"]`).click();
    await expect(sessionView(page, firstId).getByTestId('chat-recap-card')).toBeVisible();

    // A message queued behind the turn: the conversation is not done, so only its last turn is summed up.
    const session = sessionView(page, firstId);
    await setWindowFocused(app, page, false);
    await startHeldTurn(page, firstId, 'queued');
    await send(session, 'A follow-up while it works.');
    await expect(session.getByRole('region', { name: 'Queued requests' }).locator('.chat-queue__item')).toHaveCount(1);
    release(profile, 'queued');
    await expect.poll(() => forks(profile, 'recap').length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => turnsOf(page, firstId), { timeout: 30_000 }).toEqual({ count: 4, done: true });
    const turnIds = await page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())!.turns.filter((turn) => turn.sessionId === id).map((turn) => turn.id), firstId);
    await expect.poll(async () => recapRows(await transcriptOf(page, firstId)).at(-1)?.payload, { timeout: 15_000 }).toMatchObject({ state: 'complete', turnId: turnIds.at(-1) });
    expect(new Set(recapRows(await transcriptOf(page, firstId)).map((item) => item.turnId)).has(turnIds.at(-2)!)).toBe(false);

    // The order on screen: the AI's last message, its tasks, the recap. An answer past the limit is cut before it is stored.
    writeFileSync(control(profile, 'recap-reply.txt'), `Long recap. ${'x'.repeat(3_000)}`);
    writeTasks(profile, 'one', [{ title: 'Tidy the notes', rationale: 'They are stale.', prompt: 'Tidy the notes.' }]);
    await exchange(page, firstId, 'EZTERMINAL_E2E_SUGGEST:one Look around.');
    const taskCard = session.getByTestId('chat-task-card');
    const recaps = session.getByTestId('chat-recap-card');
    await expect(recaps).toHaveCount(3, { timeout: 15_000 });
    const top = async (locator: Locator): Promise<number> => (await locator.boundingBox())!.y;
    const lastMessage = await top(session.locator('.chat-assistant').filter({ hasText: 'Suggested 1 tasks.' }));
    expect(lastMessage).toBeLessThan(await top(taskCard));
    expect(await top(taskCard)).toBeLessThan(await top(recaps.last()));
    const stored = recapRows(await transcriptOf(page, firstId)).at(-1)!.payload as { readonly text?: string };
    expect(stored.text?.length).toBeLessThanOrEqual(2_000);
    await page.screenshot({ path: path.join(evidence, 'recap-after-tasks.png') });
  } catch (error) {
    await diagnose(page, 'two');
    throw error;
  } finally {
    await app.close();
  }
});

test('a long turn on screen stays viewed past the host’s 50 s: the window keeps saying so', async () => {
  test.setTimeout(120_000);
  const { app, page, profile, workspaceId } = await launchProject('heartbeat');
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(1);
    await startHeldTurn(page, sessionId, 'long');
    // CONVERSATION_VIEWING_TTL_MS is 50 s and a claim is resent every 20 s: without the resend this turn ends unwatched.
    await page.waitForTimeout(55_000);
    release(profile, 'long');
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(2);
    expect(forks(profile, 'recap')).toEqual([]);
    expect(recapRows(await transcriptOf(page, sessionId))).toEqual([]);
  } catch (error) {
    await diagnose(page, 'heartbeat');
    throw error;
  } finally {
    await app.close();
  }
});

test('a turn stopped on the person while no screen shows it gets its recap; answering writes no second one', async () => {
  test.setTimeout(120_000);
  const { app, page, profile, workspaceId } = await launchProject('stopped');
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(1);

    // The AI asks to run a command and waits. The recap says what is open, since a fork would otherwise call it aborted.
    await setWindowFocused(app, page, false);
    await send(session, 'EZTERMINAL_E2E_APPROVAL run the phone tests');
    const card = session.getByTestId('chat-recap-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    const [stopped] = forks(profile, 'recap');
    expect(stopped).toMatchObject({ stopped: true });
    expect(stopped!.prompt).toContain('the person has not answered your request to run a command.');
    // Before the question, as the probe that measured it had it: after it, two recaps in ten said the call was aborted.
    expect(stopped!.prompt!.indexOf('Right now this turn is stopped')).toBeLessThan(stopped!.prompt!.indexOf('Question: '));
    await expect(card).toHaveAttribute('aria-label', /Recap · Stopped for your answer · Written by Codex/u);
    await expect(card).toContainText('The AI is waiting for your approval');
    await page.screenshot({ path: path.join(evidence, 'recap-waiting.png') });

    // 답하러 가기 goes to the decision, and once answered the card no longer says it waits.
    await card.getByTestId('chat-recap-answer').click();
    const allow = session.locator('[data-dock-primary]');
    await expect(allow).toBeFocused();
    await allow.click();
    await expect(card).toHaveAttribute('aria-label', /Recap · It stopped to ask · Written by Codex/u, { timeout: 15_000 });
    await expect(card).not.toContainText('The AI is waiting for your approval');
    await expect(card.getByTestId('chat-recap-answer')).toHaveCount(0);
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 2, done: true });

    // Once per turn: the stopped recap stands for the turn's end. The guess is the same pass reaching this turn.
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(2);
    expect(forks(profile, 'recap')).toHaveLength(1);
    await expect(card).toHaveCount(1);
  } catch (error) {
    await diagnose(page, 'stopped');
    throw error;
  } finally {
    await app.close();
  }
});

// ── Suggested tasks ──────────────────────────────────────────────────────────

const nineTasks: readonly SuggestedTaskInput[] = Array.from({ length: 9 }, (_, index) => ({
  title: `Fix problem ${String(index + 1)} in \`src/cart.ts\``,
  rationale: `Problem ${String(index + 1)} is outside this task.`,
  prompt: `Fix only problem ${String(index + 1)} in src/cart.ts.\nKeep unrelated files unchanged.`,
}));

function taskRow(session: Locator, index: number): Locator {
  return session.getByTestId('chat-task').filter({ hasText: `Fix problem ${String(index)} in` });
}

test('the AI suggests tasks: a card with its calls folded and the ninth left visible; one click starts a child that must ask first; here, queued, dismissed and reopened', async () => {
  test.setTimeout(240_000);
  const { app, page, profile, workspaceId } = await launchProject('tasks');
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    // A new thread hears the instruction at its start, not again on a turn.
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-thread-starts.jsonl')[0]).toMatchObject({ developerInstructions: SUGGEST_TASK_INSTRUCTIONS });
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl')[0]).toMatchObject({ additionalContext: null });

    // This conversation runs with full access; what a one-click start runs at must not follow it.
    await session.getByTestId('structured-agent-live-permission').click();
    await page.getByRole('menuitemradio', { name: /Full access/u }).click();
    await expect(session.getByTestId('structured-agent-live-permission')).toHaveAttribute('aria-label', /Full access/u);

    writeTasks(profile, 'nine', nineTasks);
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:nine Look around while you are there.');
    const card = session.getByTestId('chat-task-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('chat-task')).toHaveCount(8);
    await expect(card).toContainText('1 more suggestion was not accepted (8 per turn).');
    await expect(card.getByTestId('chat-task-defaults')).toContainText('Ask before running');
    // Eight calls are the card; the refused ninth stays a tool row beside it, so nothing the AI did is hidden.
    expect(toolCalls(await transcriptOf(page, sessionId), 'suggest_task')).toHaveLength(9);
    const refused = await openRefusedCall(session);
    await expect(refused).toHaveCount(1);
    await refused.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'task-refused-call.png') });

    // What either button sends, word for word.
    const first = taskRow(session, 1);
    await first.getByTestId('chat-task-prompt-toggle').click();
    await expect(first.getByTestId('chat-task-prompt').locator('pre')).toHaveText(nineTasks[0]!.prompt);

    // One click: a child of this conversation, running at 승인 후 실행 though its parent has full access.
    const taskId = (await first.getAttribute('data-task-id'))!;
    const childId = suggestedTaskChildSessionId(taskId);
    await first.locator('[data-action="task-start"]').click();
    await expect(first).toHaveAttribute('data-outcome', 'started', { timeout: 15_000 });
    await expect(first.getByTestId('chat-task-outcome')).toBeVisible();
    // The pressed button is gone; focus is on the task's title, not lost to the page.
    await expect(first.locator('[data-task-title]')).toBeFocused();
    await expect.poll(() => turnsOf(page, childId), { timeout: 30_000 }).toEqual({ count: 1, done: true });
    const facts = await page.evaluate(async ({ parentId, id }) => {
      const snapshot = await window.ezterminal.getDaemonSnapshot();
      return {
        parent: snapshot?.agents.find((agent) => agent.sessionId === parentId)?.permissionPreset,
        child: snapshot?.agents.find((agent) => agent.sessionId === id)?.permissionPreset,
        relation: snapshot?.agentRelations.find((relation) => relation.childSessionId === id),
      };
    }, { parentId: sessionId, id: childId });
    expect(facts).toMatchObject({ parent: 'full-access', child: 'standard', relation: { parentSessionId: sessionId, owner: 'managed' } });
    const starts = readJsonLines(profile, 'ezterminal-e2e-codex-thread-starts.jsonl');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.sandbox).not.toBe('danger-full-access');
    expect(starts[1]!.approvalPolicy).not.toBe('never');
    expect(String(readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl').at(-1)!.input)).toContain('Fix only problem 1 in src/cart.ts.');

    // The child sits under its parent in the list and above the composer, and the card opens it.
    await expect(session.getByTestId('structured-agent-child').filter({ hasText: 'Fix problem 1 in' })).toBeVisible();
    await expect(page.getByTestId('shell-live-row')).toHaveCount(1);
    await expect(page.locator('.ez-shell-row[data-child="true"]').filter({ hasText: 'Fix problem 1 in' })).toBeVisible();
    await first.locator('[data-action="open-child"]').click();
    const child = sessionView(page, childId);
    await expect(child).toBeVisible({ timeout: 15_000 });
    await expect(child.getByTestId('structured-agent-live-permission')).toHaveAttribute('aria-label', /Ask before running/u);

    // The AI's instruction was the child's first turn: no guess for it, and its thread was told nothing of suggest_task.
    // Past the settle before a person writes, or the person's message would be what stopped the guess.
    expect(starts[1]).toMatchObject({ developerInstructions: null });
    await page.waitForTimeout(3_500);
    const childThread = starts[1]!.threadId;
    const forksOfChild = (): number => readJsonLines(profile, 'ezterminal-e2e-codex-forks.jsonl').filter((entry) => entry.threadId === childThread).length;
    expect(forksOfChild()).toBe(0);
    // A person's own message there is a conversation like any other: it hears the instruction once and gets a guess.
    await exchange(page, childId, 'Also check the tests.');
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl').at(-1)).toMatchObject({
      threadId: childThread, additionalContext: { ezterminal_turn_wrap_up: { kind: 'application', value: SUGGEST_TASK_INSTRUCTIONS } },
    });
    await expect.poll(forksOfChild, { timeout: 15_000 }).toBe(1);

    await page.locator(`[data-testid="shell-live-row"][data-session="${sessionId}"]`).click();
    await expect(session).toBeVisible();

    // 여기서 하기 with the conversation idle: the instruction goes here, and the card says so.
    const second = taskRow(session, 2);
    await second.locator('[data-action="task-here"]').click();
    await expect(second).toHaveAttribute('data-outcome', 'sent', { timeout: 15_000 });
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 30_000 }).toEqual({ count: 3, done: true });
    const threadId = readJsonLines(profile, 'ezterminal-e2e-codex-thread-starts.jsonl')[0]!.threadId;
    const sent = readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl').filter((entry) => entry.threadId === threadId).at(-1)!;
    expect(String(sent.input)).toContain('Fix only problem 2 in src/cart.ts.');

    // 여기서 하기 while the AI answers: it waits in the queue, in the reader's words, then runs.
    await startHeldTurn(page, sessionId, 'queue');
    const third = taskRow(session, 3);
    await third.locator('[data-action="task-here"]').click();
    await expect(third).toHaveAttribute('data-outcome', 'queued', { timeout: 15_000 });
    await expect(third.getByTestId('chat-task-outcome')).toContainText('Queued');
    const queued = session.getByRole('region', { name: 'Queued requests' }).locator('.chat-queue__item');
    await expect(queued).toHaveCount(1);
    await page.screenshot({ path: path.join(evidence, 'task-queued.png') });
    // Taken back out of the queue, the card is open again and can be sent again.
    await queued.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(third).toHaveAttribute('data-outcome', 'open', { timeout: 15_000 });
    await third.locator('[data-action="task-here"]').click();
    await expect(third).toHaveAttribute('data-outcome', 'queued', { timeout: 15_000 });
    release(profile, 'queue');
    await expect(third).toHaveAttribute('data-outcome', 'sent', { timeout: 30_000 });
    await expect.poll(async () => (await turnsOf(page, sessionId)).count, { timeout: 30_000 }).toBeGreaterThanOrEqual(5);
    await expect.poll(() => turnState(page, sessionId), { timeout: 30_000 }).toBeUndefined();

    // 무시 is the host's: still dismissed after a reload, and it can be brought back.
    const fourth = taskRow(session, 4);
    await fourth.locator('[data-action="task-dismiss"]').click();
    await expect(fourth).toHaveAttribute('data-outcome', 'dismissed', { timeout: 15_000 });
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());
    await page.reload();
    await setWindowFocused(app, page, true);
    const reloaded = taskRow(sessionView(page, sessionId), 4);
    await expect(reloaded).toHaveAttribute('data-outcome', 'dismissed', { timeout: 30_000 });
    await expect(taskRow(sessionView(page, sessionId), 1)).toHaveAttribute('data-outcome', 'started');
    await expect(taskRow(sessionView(page, sessionId), 3)).toHaveAttribute('data-outcome', 'sent');
    await reloaded.locator('[data-action="task-reopen"]').click();
    await expect(reloaded).toHaveAttribute('data-outcome', 'open', { timeout: 15_000 });
    await page.screenshot({ path: path.join(evidence, 'task-reopened.png') });

    // A card that arrives while its turn runs, and the person stops that turn: what the AI proposed stays on offer.
    const after = sessionView(page, sessionId);
    writeTasks(profile, 'late', [{ title: 'Check the late task', rationale: 'Found mid-turn.', prompt: 'Check the late task.' }]);
    await send(after, 'EZTERMINAL_E2E_SUGGEST:late EZTERMINAL_E2E_HOLD:stopped Keep working on it.');
    await expect.poll(() => turnState(page, sessionId), { timeout: 20_000 }).toBe('working');
    const late = after.getByTestId('chat-task').filter({ hasText: 'Check the late task' });
    await expect(late).toHaveAttribute('data-outcome', 'open', { timeout: 15_000 });
    await after.getByTestId('structured-agent-stop').click();
    await expect.poll(() => turnState(page, sessionId), { timeout: 20_000 }).toBeUndefined();
    await expect(late).toHaveAttribute('data-outcome', 'open');
    await late.locator('[data-action="task-here"]').click();
    await expect(late).toHaveAttribute('data-outcome', 'sent', { timeout: 15_000 });
  } catch (error) {
    await diagnose(page, 'tasks');
    throw error;
  } finally {
    await app.close();
  }
});

test('모두 시작 confirms first and starts each task where it was chosen, one in a new worktree; a branch that exists keeps the AI and asks for another name', async () => {
  test.setTimeout(240_000);
  const { app, page, profile, projectRoot, workspaceId } = await launchProject('start-all', { repository: true });
  const tasks: readonly SuggestedTaskInput[] = [
    { title: 'Add the missing cart tests', rationale: 'Nothing covers the cart.', prompt: 'Add tests for the cart. Keep unrelated files unchanged.', worktree: true },
    { title: 'Refresh the install notes', rationale: 'The README is stale.', prompt: 'Refresh the README install notes.' },
    { title: 'Rename the price helper', rationale: 'Its name misleads.', prompt: 'Rename the price helper. Keep unrelated files unchanged.', worktree: true },
  ];
  const branches = suggestedTaskBranches(tasks.map((task) => task.title));
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    // The AI repeats itself: the same task twice is one row on the card, and both calls are that row.
    writeTasks(profile, 'three', [tasks[0]!, ...tasks]);
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:three Look around while you are there.');
    const card = session.getByTestId('chat-task-card');
    await expect(card.getByTestId('chat-task')).toHaveCount(3);
    expect(toolCalls(await transcriptOf(page, sessionId), 'suggest_task')).toHaveLength(4);
    await expect(session.locator('.chat-run').filter({ hasText: 'failed' })).toHaveCount(0);
    const row = (title: string): Locator => session.getByTestId('chat-task').filter({ hasText: title });
    // The AI advises a worktree for this one, so one click does not start it in this folder: it goes through the form.
    await expect(row(tasks[0]!.title).locator('[data-action="task-start"]')).toHaveCount(0);
    await expect(row(tasks[0]!.title).locator('[data-action="task-start-custom"]')).toHaveCount(1);
    await expect(row(tasks[0]!.title).getByTestId('chat-task-worktree')).toBeVisible();

    // A branch already exists under the name the third task would take.
    git(projectRoot, 'branch', branches[2]!);

    // Nothing starts until the sheet is confirmed. Started together, each task defaults to a new worktree, advised or not.
    await card.getByTestId('chat-task-start-all').click();
    const sheet = page.getByTestId('task-start-all-dialog');
    await expect(sheet).toBeVisible();
    const sheetRows = sheet.getByTestId('task-start-all-task');
    await expect(sheetRows).toHaveCount(3);
    for (const index of [0, 1, 2]) await expect(sheetRows.nth(index).getByTestId('task-start-all-worktree')).toBeChecked();
    await expect(sheetRows.nth(0)).toContainText(branches[0]!);
    await page.screenshot({ path: path.join(evidence, 'start-all-sheet.png') });
    // Each can still be changed: this one stays in this folder.
    await sheetRows.nth(1).getByTestId('task-start-all-here').click();
    expect(await page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.agentRelations.filter((relation) => relation.parentSessionId === id).length, sessionId)).toBe(0);
    await sheet.getByTestId('task-start-all-submit').click();
    await expect(sheet).toHaveCount(0);

    // Past the failure: two start, and the card says why the third did not.
    await expect(row(tasks[0]!.title)).toHaveAttribute('data-outcome', 'started', { timeout: 30_000 });
    await expect(row(tasks[1]!.title)).toHaveAttribute('data-outcome', 'started', { timeout: 30_000 });
    await expect(row(tasks[2]!.title)).toHaveAttribute('data-outcome', 'start-failed', { timeout: 30_000 });
    await expect(row(tasks[0]!.title).getByTestId('chat-task-outcome')).toContainText(branches[0]!);
    await page.screenshot({ path: path.join(evidence, 'start-all-done.png') });
    const place = async (taskIndex: number): Promise<{ readonly kind?: string; readonly rootPath?: string; readonly sameFolder: boolean }> => {
      const taskId = (await row(tasks[taskIndex]!.title).getAttribute('data-task-id'))!;
      return page.evaluate(async ({ id, parentWorkspace }) => {
        const snapshot = await window.ezterminal.getDaemonSnapshot();
        const session = snapshot?.sessions.find((entry) => entry.id === id);
        const workspace = snapshot?.workspaces.find((entry) => entry.id === session?.workspaceId);
        return { ...(workspace ? { kind: workspace.kind, rootPath: workspace.rootPath } : {}), sameFolder: session?.workspaceId === parentWorkspace };
      }, { id: suggestedTaskChildSessionId(taskId), parentWorkspace: workspaceId });
    };
    expect(await place(0)).toMatchObject({ kind: 'worktree', sameFolder: false });
    expect(await place(1)).toMatchObject({ sameFolder: true });
    expect(git(projectRoot, 'branch', '--list', branches[0]!).trim()).toContain(branches[0]!);

    // 이름 바꿔 다시 시도: the form opens on the same AI and the taken name, and a new name starts it.
    const failed = row(tasks[2]!.title);
    await expect(failed.locator('[data-action="task-retry"]')).toHaveCount(0);
    await failed.locator('[data-action="task-start-custom"]').click();
    const form = page.getByTestId('delegate-agent-dialog');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('delegate-agent-branch')).toHaveValue(branches[2]!);
    const askedAgent = form.getByTestId('delegate-agent-profile').locator('option:checked');
    await expect(askedAgent).toContainText(/^Codex · /u);
    await expect(askedAgent).toContainText('Ask before running');
    await form.getByTestId('delegate-agent-branch').fill(`${branches[2]!}-2`);
    await form.getByTestId('delegate-agent-submit').click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });
    await expect(failed).toHaveAttribute('data-outcome', 'started', { timeout: 30_000 });
    expect(await place(2)).toMatchObject({ kind: 'worktree', sameFolder: false });
    expect(git(projectRoot, 'branch', '--list', `${branches[2]!}-2`).trim()).toContain(`${branches[2]!}-2`);
  } catch (error) {
    await diagnose(page, 'start-all');
    throw error;
  } finally {
    await app.close();
  }
});

test('past the host’s child limit the card says why for each task the host refused, and 다시 시도 repeats that start', async () => {
  test.setTimeout(240_000);
  const { app, page, profile, workspaceId } = await launchProject('limit');
  const list = (name: string): readonly SuggestedTaskInput[] => Array.from({ length: 8 }, (_, index) => ({
    title: `Task ${name}${String(index + 1)}`, rationale: `Reason ${name}${String(index + 1)}.`, prompt: `Do ${name}${String(index + 1)}.`,
  }));
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const cards = session.getByTestId('chat-task-card');
    const startAll = async (card: Locator): Promise<void> => {
      await card.getByTestId('chat-task-start-all').click();
      const sheet = page.getByTestId('task-start-all-dialog');
      // This project is no repository: a new worktree, the sheet's default for tasks started together, cannot exist here.
      const here = sheet.getByTestId('task-start-all-here');
      for (const index of Array.from({ length: await here.count() }, (_, position) => position)) await here.nth(index).click();
      await sheet.getByTestId('task-start-all-submit').click();
      await expect(sheet).toHaveCount(0);
    };

    // Eight fit one batch; DAEMON_HARD_LIMITS allows twelve children in ten minutes, so a second batch stops at four.
    writeTasks(profile, 'a', list('a'));
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:a Look around.');
    await startAll(cards.nth(0));
    await expect(cards.nth(0).locator('[data-testid="chat-task"][data-outcome="started"]')).toHaveCount(8, { timeout: 60_000 });
    writeTasks(profile, 'b', list('b'));
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:b Look around again.');
    await startAll(cards.nth(1));
    const refused = cards.nth(1).locator('[data-testid="chat-task"][data-outcome="start-failed"]');
    await expect(refused).toHaveCount(4, { timeout: 60_000 });
    await expect(cards.nth(1).locator('[data-testid="chat-task"][data-outcome="started"]')).toHaveCount(4);
    await expect(refused.first().getByTestId('chat-task-outcome')).toContainText('Managed Agent child creation rate limit reached.');
    await page.screenshot({ path: path.join(evidence, 'task-start-refused.png') });

    // 다시 시도 asks the host again for exactly that start; the limit still holds, and the card stays as it was.
    await refused.first().locator('[data-action="task-retry"]').click();
    await expect(refused).toHaveCount(4, { timeout: 15_000 });
    await expect(refused.first().getByTestId('chat-task-outcome')).toContainText('Managed Agent child creation rate limit reached.');
    await expect(session.getByTestId('structured-agent-wrap-up-error')).toHaveCount(0);
    // 무시 clears one off the card.
    await refused.first().locator('[data-action="task-dismiss"]').click();
    await expect(cards.nth(1).locator('[data-testid="chat-task"][data-outcome="dismissed"]')).toHaveCount(1, { timeout: 15_000 });
  } catch (error) {
    await diagnose(page, 'limit');
    throw error;
  } finally {
    await app.close();
  }
});

// ── Settings, floors and old hosts ───────────────────────────────────────────

test('the settings stop what they name, at once: a shown guess, a recap, a card, and near the limit the automatic calls', async () => {
  test.setTimeout(240_000);
  const { app, page, profile, workspaceId } = await launchProject('settings');
  try {
    // Suggested tasks off before the conversation starts: its thread hears nothing of them.
    let section = await openWrapUpSettings(page);
    await section.getByTestId('turn-wrap-up-tasks').uncheck();
    await closeSettings(page);
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    const ghost = ghostOf(session);
    const card = session.getByTestId('chat-recap-card');
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-thread-starts.jsonl')[0]).toMatchObject({ developerInstructions: null });
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl').at(-1)).toMatchObject({ additionalContext: null });

    // A call anyway is refused, stays a tool row, and makes no card.
    writeTasks(profile, 'one', [{ title: 'Tidy the notes', rationale: 'They are stale.', prompt: 'Tidy the notes.' }]);
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:one Look around.');
    await expect(await openRefusedCall(session)).toHaveCount(1);
    await expect(session.getByTestId('chat-task-card')).toHaveCount(0);

    // Turned on later, the running thread hears it once, with the next message.
    await expect(ghost).toHaveText(PREDICTED, { timeout: 15_000 });
    section = await openWrapUpSettings(page);
    await section.getByTestId('turn-wrap-up-tasks').check();
    await closeSettings(page);
    await exchange(page, sessionId, 'Next.');
    await exchange(page, sessionId, 'And next.');
    const contexts = readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl').map((entry) => entry.additionalContext);
    expect(contexts.slice(-2)).toEqual([{ ezterminal_turn_wrap_up: { kind: 'application', value: SUGGEST_TASK_INSTRUCTIONS } }, null]);

    // Suggestions off: the guess on show goes at once. Their fork stops too, and the recap of that turn is the anchor.
    await expect(ghost).toHaveText(PREDICTED, { timeout: 15_000 });
    section = await openWrapUpSettings(page);
    await section.getByTestId('turn-wrap-up-suggestions-codex').uncheck();
    await closeSettings(page);
    await expect(ghost).toHaveCount(0);
    const guesses = forks(profile, 'predict').length;
    await setWindowFocused(app, page, false);
    await exchange(page, sessionId, 'Now while away.');
    await expect(card).toBeVisible({ timeout: 15_000 });
    expect(forks(profile, 'predict')).toHaveLength(guesses);

    // Recaps off, suggestions back: the guess is the anchor, and still no screen shows the conversation.
    section = await openWrapUpSettings(page);
    await section.getByTestId('turn-wrap-up-suggestions-codex').check();
    await section.getByTestId('turn-wrap-up-recaps').uncheck();
    await closeSettings(page);
    await setWindowFocused(app, page, false);
    await exchange(page, sessionId, 'Again while away.');
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(guesses + 1);
    expect(forks(profile, 'recap')).toHaveLength(1);
    await expect(card).toHaveCount(1);

    // Near the limit: no guess and no recap call, and the card says why. Recaps are back on for it.
    section = await openWrapUpSettings(page);
    await section.getByTestId('turn-wrap-up-recaps').check();
    await closeSettings(page);
    await setWindowFocused(app, page, false);
    writeFileSync(control(profile, 'used-percent.txt'), '95');
    await exchange(page, sessionId, 'Near the limit.');
    const line = session.getByTestId('chat-recap-line');
    await expect(line).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
    await expect(line).toContainText('Couldn’t write a recap · usage limit');
    await page.screenshot({ path: path.join(evidence, 'recap-usage-limit.png') });
    expect(forks(profile, 'recap')).toHaveLength(1);
    expect(forks(profile, 'predict')).toHaveLength(guesses + 1);
    section = await openWrapUpSettings(page);
    await expect(section.getByTestId('turn-wrap-up-paused')).toContainText('95%');
    // Its switch off, the calls go on.
    await section.getByTestId('turn-wrap-up-pause').uncheck();
    await expect(section.getByTestId('turn-wrap-up-paused')).toHaveCount(0);
    await closeSettings(page);
    await setWindowFocused(app, page, false);
    await exchange(page, sessionId, 'Past the pause.');
    await expect.poll(() => forks(profile, 'recap').length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => forks(profile, 'predict').length, { timeout: 15_000 }).toBe(guesses + 2);
  } catch (error) {
    await diagnose(page, 'settings');
    throw error;
  } finally {
    await app.close();
  }
});

test('a restart turns a recap still being written into the failure line; 다시 만들기 waits until the conversation is attached again', async () => {
  test.setTimeout(180_000);
  const { app, page, profile, workspaceId } = await launchProject('restart');
  let closed = false;
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await setWindowFocused(app, page, false);
    writeFileSync(control(profile, 'hold-recap'), '');
    await exchange(page, sessionId, 'Work while I am away.');
    const line = session.getByTestId('chat-recap-line');
    await expect(line).toHaveAttribute('data-state', 'generating', { timeout: 15_000 });
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());
    await app.close();
    closed = true;
    rmSync(control(profile, 'hold-recap'));

    const relaunched = await launchApp(profile, fakeCodexEnvironment(profile));
    try {
      const nextPage = await relaunched.firstWindow();
      await resizeWindow(nextPage, { width: 1600, height: 950 });
      await setWindowFocused(relaunched, nextPage, true);
      const nextSession = sessionView(nextPage, sessionId);
      const nextLine = nextSession.getByTestId('chat-recap-line');
      await expect(nextLine).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
      await expect(nextLine).toContainText('Couldn’t write a recap · disconnected');
      // Not attached yet, so a retry could only fail. A guess lived in the last run's memory, so none shows.
      await expect(nextLine.getByRole('button', { name: 'Write it again', exact: true })).toHaveCount(0);
      await expect(nextSession.getByTestId('structured-agent-suggestion')).toHaveCount(0);
      await nextPage.screenshot({ path: path.join(evidence, 'recap-after-restart.png') });

      // The next message attaches it, and 다시 만들기 comes back and works.
      await exchange(nextPage, sessionId, 'I am back.');
      await nextLine.getByRole('button', { name: 'Write it again', exact: true }).click();
      await expect(nextSession.getByTestId('chat-recap-card')).toBeVisible({ timeout: 15_000 });
      await expect(nextLine).toHaveCount(0);
    } catch (error) {
      await diagnose(nextPageOf(relaunched), 'restart');
      throw error;
    } finally {
      await relaunched.close();
    }
  } catch (error) {
    if (!closed) await diagnose(page, 'restart');
    throw error;
  } finally {
    if (!closed) await app.close();
  }
});

function nextPageOf(app: ElectronApplication): Page {
  return app.windows()[0]!;
}

test('Codex below the measured version gets none of it: no forks, no instruction, no tool, the composer as before', async () => {
  test.setTimeout(120_000);
  // The fixture's default version, older than CODEX_WRAP_UP_MINIMUM_VERSION.
  const { app, page, profile, workspaceId } = await launchProject('floor', { version: '0.153.4' });
  try {
    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    await setWindowFocused(app, page, false);
    writeTasks(profile, 'one', [{ title: 'Tidy the notes', rationale: 'They are stale.', prompt: 'Tidy the notes.' }]);
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:one Look around.');
    // Nothing to anchor on: a turn that gets nothing leaves no trace. One bounded wait past the 3 s settle.
    await page.waitForTimeout(4_000);
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-wrap-up-forks.jsonl')).toEqual([]);
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-thread-starts.jsonl')[0]).toMatchObject({ developerInstructions: null });
    expect(readJsonLines(profile, 'ezterminal-e2e-codex-turns.jsonl').map((entry) => entry.additionalContext)).toEqual([null, null]);
    // The endpoint exists only for what the conversation may use; this one was never given the tool.
    await expect(session).toContainText('Suggest fixture failed');
    await expect(session.getByTestId('structured-agent-suggestion')).toHaveCount(0);
    await expect(session.getByTestId('chat-recap-card')).toHaveCount(0);
    await expect(session.getByTestId('chat-task-card')).toHaveCount(0);
  } catch (error) {
    await diagnose(page, 'floor');
    throw error;
  } finally {
    await app.close();
  }
});

test('a host that does not advertise turn-wrap-up-v1: no suggestion, no card actions, no settings section', async () => {
  test.setTimeout(120_000);
  const { app, page, profile, workspaceId } = await launchProject('old-host');
  try {
    // The window reads every snapshot through this one channel; the host behind it does not change, so its rows are
    // still written. What this holds is the client's side of the gate.
    await app.evaluate(({ ipcMain }, capability) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<{ capabilities: string[] } | null>> })._invokeHandlers;
      const original = handlers.get('daemon:get-snapshot')!;
      handlers.set('daemon:get-snapshot', async (...args) => {
        const snapshot = await original(...args);
        return snapshot && { ...snapshot, capabilities: snapshot.capabilities.filter((entry) => entry !== capability) };
      });
    }, TURN_WRAP_UP_CAPABILITY);
    await page.reload();
    await setWindowFocused(app, page, true);
    await expect(page.getByTestId('cmd-input')).toBeVisible();

    await page.getByTestId('btn-toggle-settings').click();
    await page.getByTestId('settings-category-agents').click();
    await expect(page.getByTestId('agent-chat-settings')).toBeVisible();
    await expect(page.getByTestId('turn-wrap-up-settings')).toHaveCount(0);
    await page.getByTestId('btn-toggle-settings').click();

    await draftIn(page, workspaceId);
    const sessionId = await firstReply(page);
    const session = sessionView(page, sessionId);
    writeTasks(profile, 'one', [{ title: 'Tidy the notes', rationale: 'They are stale.', prompt: 'Tidy the notes.' }]);
    await exchange(page, sessionId, 'EZTERMINAL_E2E_SUGGEST:one Look around.');
    // The host holds a guess and a card here, and the window offers neither: there is nothing to act on.
    await expect.poll(async () => (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.nextPromptSuggestions?.[sessionId]?.text, { timeout: 15_000 }).toBe(PREDICTED);
    await expect(session.getByTestId('chat-task-card')).toBeVisible();
    await expect(session.getByTestId('structured-agent-suggestion')).toHaveCount(0);
    await expect(session.locator('[data-action]')).toHaveCount(0);
  } catch (error) {
    await diagnose(page, 'old-host');
    throw error;
  } finally {
    await app.close();
  }
});
