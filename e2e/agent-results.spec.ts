import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>['firstWindow']>>;

/**
 * A conversation's Results tab in the real workbench: it opens beside the
 * conversation when the AI first changes files (focus stays in the message
 * box), shows numbered changes, puts review comments in the draft without
 * sending, stays closed once the person closes it, and closes with its
 * conversation. The fake Codex writes only inside a temporary project folder.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidence = path.resolve('artifacts/agent-results/e2e');
mkdirSync(evidence, { recursive: true });

function fakeCodexEnvironment(profile: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: profile };
}

async function enableCodex(page: Page): Promise<void> {
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const id = `e2e-results-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-agent-results' }, type: 'provider.enable',
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

async function startConversation(page: Page, projectRoot: string): Promise<string> {
  const saved = await page.evaluate((root) => window.ezterminal.saveAgentProject({ name: 'Results acceptance', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
  if (!saved.ok) throw new Error(saved.reason);
  await enableCodex(page);
  // The app stores the real path; TEMP may be an 8.3 alias (as on CI).
  const storedRoot = realpathSync.native(projectRoot).toLowerCase();
  await expect.poll(async () => (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces
    .some((workspace) => workspace.rootPath.toLowerCase() === storedRoot), { timeout: 15_000 }).toBe(true);
  const snapshot = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
  const workspace = snapshot!.workspaces.find((candidate) => candidate.rootPath.toLowerCase() === storedRoot)!;
  await page.getByTestId('rail-agents').click();
  await page.getByTestId('agent-new-run').click();
  const draft = page.getByTestId('conversation-start');
  await expect(draft).toBeVisible();
  await expect(draft.getByRole('combobox', { name: 'Conversation AI' })).toHaveValue('codex');
  await draft.getByRole('combobox', { name: 'Conversation workspace' }).selectOption(workspace.id);
  return workspace.id;
}

async function send(page: Page, text: string): Promise<void> {
  const session = page.getByTestId('structured-agent-session').first();
  const composer = session.getByTestId('structured-agent-composer-input');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

async function turnsOf(page: Page, sessionId: string): Promise<{ readonly count: number; readonly done: boolean }> {
  return page.evaluate(async (id) => {
    const snapshot = await window.ezterminal.getDaemonSnapshot();
    const turns = snapshot?.turns.filter((turn) => turn.sessionId === id) ?? [];
    return { count: turns.length, done: turns.every((turn) => turn.state === 'completed') };
  }, sessionId);
}

test('Results open beside the conversation on the first change, keep focus, review into the draft, stay closed once closed', async () => {
  test.setTimeout(180_000);
  const profile = createRegisteredE2eTempDir('ezterm-results-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-results-project-');
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    await startConversation(page, projectRoot);
    const session = page.getByTestId('structured-agent-session').first();
    await expect(session).toBeVisible();

    // A first reply without changes opens nothing.
    await send(page, 'Say hello.');
    await expect(page.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
    const sessionId = (await session.getAttribute('data-session-id'))!;
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 20_000 }).toEqual({ count: 1, done: true });
    await expect(page.getByTestId('conversation-results')).toHaveCount(0);

    // The AI changes files: Results open beside the conversation; the message box keeps focus.
    await send(page, 'EZTERMINAL_E2E_RESULTS change the answer');
    const results = page.getByTestId('conversation-results');
    await expect(results).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('structured-agent-composer-input');
    const resultsTab = page.locator('.ez-dock .dv-tab', { hasText: 'Results' });
    await expect(resultsTab).toHaveCount(1);
    const conversationBox = await session.boundingBox();
    const resultsBox = await results.boundingBox();
    expect(resultsBox!.x).toBeGreaterThan(conversationBox!.x + conversationBox!.width - 4);
    await expect(results.getByRole('button', { name: /^results-app\.ts/u })).toBeVisible();
    await expect(results.getByRole('button', { name: /^results-note\.md/u })).toBeVisible();
    await results.getByRole('button', { name: /^results-app\.ts/u }).click();
    const added = results.getByRole('button', { name: 'Line 1, added: export const answer = 42;' });
    await expect(added).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'auto-open.png') });

    // A comment on a line goes into the draft; nothing is sent.
    await added.click();
    await results.getByRole('button', { name: 'Add comment' }).click();
    await results.getByRole('textbox').fill('Keep 41 for now');
    await results.getByRole('button', { name: 'Add comment' }).click();
    await results.getByRole('button', { name: /Put in message/u }).click();
    const composer = session.getByTestId('structured-agent-composer-input');
    await expect(composer).toHaveValue(/Review comments \(1\)[\s\S]*results-app\.ts:1 — Keep 41 for now/u);
    expect((await turnsOf(page, sessionId)).count).toBe(2);
    await composer.fill('');

    // Files: the created note renders; Plan & tasks lists both files.
    await results.getByTestId('results-tab-files').click();
    await results.getByRole('button', { name: /^results-note\.md/u }).click();
    await expect(results.getByRole('heading', { name: 'Results note' })).toBeVisible();
    await results.getByTestId('results-tab-summary').click();
    await expect(results.getByRole('region', { name: 'Files in this conversation' })).toContainText('results-app.ts');
    await page.screenshot({ path: path.join(evidence, 'files-summary.png') });

    // The person closes it: the next change does not reopen it; the header button does.
    await resultsTab.hover();
    await resultsTab.locator('.dv-default-tab-action, [data-testid="tab-close"], button[aria-label*="Close"]').first().click();
    await expect(page.getByTestId('conversation-results')).toHaveCount(0);
    await send(page, 'EZTERMINAL_E2E_RESULTS again');
    await expect.poll(() => turnsOf(page, sessionId), { timeout: 20_000 }).toEqual({ count: 3, done: true });
    await page.waitForTimeout(1_000);
    await expect(page.getByTestId('conversation-results')).toHaveCount(0);
    await session.getByTestId('structured-agent-results').click();
    await expect(page.getByTestId('conversation-results')).toBeVisible();

    // A change card in the chat leads to that turn.
    await session.getByTestId('chat-changes-open-results').last().click();
    await expect(page.getByTestId('results-changes')).toBeVisible();

    // Closing the conversation closes its Results tab.
    await page.evaluate(() => {
      const dock = (window as unknown as { __ezDock: { panels: { api: { component: string; close(): void } }[] } }).__ezDock;
      dock.panels.find((panel) => panel.api.component === 'agent-session')?.api.close();
    });
    await expect(page.getByTestId('conversation-results')).toHaveCount(0);
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined);
    console.log((await page.locator('body').innerText().catch(() => '')).slice(-6000));
    throw error;
  } finally {
    await app.close();
  }
});

test('the Results tab comes back with its conversation after a restart', async () => {
  test.setTimeout(180_000);
  const profile = createRegisteredE2eTempDir('ezterm-results-restart-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-results-restart-project-');
  let app = await launchApp(profile, fakeCodexEnvironment(profile));
  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    await startConversation(page, projectRoot);
    await send(page, 'EZTERMINAL_E2E_RESULTS change the answer');
    await expect(page.getByTestId('conversation-results')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (window as unknown as { __ezLayoutFlush: () => Promise<void> }).__ezLayoutFlush());
    await app.close();

    app = await launchApp(profile, fakeCodexEnvironment(profile));
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 950 });
    const results = page.getByTestId('conversation-results');
    await expect(results).toBeVisible({ timeout: 30_000 });
    await expect(results.getByRole('button', { name: /^results-app\.ts/u })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(evidence, 'after-restart.png') });
  } finally {
    await app.close();
  }
});

test('an AI-made HTML page shows as an isolated static preview (no scripts, no navigating away) and a PDF shows in the viewer', async () => {
  test.setTimeout(180_000);
  const profile = createRegisteredE2eTempDir('ezterm-results-artifacts-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-results-artifacts-project-');
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    await startConversation(page, projectRoot);
    await send(page, 'EZTERMINAL_E2E_ARTIFACTS write a report');
    const results = page.getByTestId('conversation-results');
    await expect(results).toBeVisible({ timeout: 30_000 });
    await results.getByTestId('results-tab-files').click();
    await results.getByRole('button', { name: /^report\.html/u }).click();

    const frameElement = results.getByTestId('results-artifact-frame');
    await expect(frameElement).toHaveAttribute('src', /^ezartifact:\/\/[0-9a-f]{32}\/report\.html$/u);
    await expect(frameElement).toHaveAttribute('sandbox', '');
    const frame = page.frameLocator('[data-testid="results-artifact-frame"]');
    // Static preview: the page's own script never runs, so nothing in it can reach the network.
    await expect(frame.locator('#title')).toHaveText('Fixture report');
    await page.waitForTimeout(1_000);
    await expect(frame.locator('#script')).toHaveText('script did not run');
    await expect(frame.locator('#network')).toHaveText('network pending');
    // Its own stylesheet from the same folder loaded.
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(200, 0, 0)');
    await expect(results.getByTestId('results-open-browser')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'html-preview.png') });

    // A link out of the preview never reaches the web; the preview offers the way back.
    await frame.locator('#out').click();
    await expect(results.getByTestId('results-artifact-back')).toBeVisible({ timeout: 10_000 });
    expect(page.frames().map((candidate) => candidate.url()).some((url) => url.startsWith('https://example.com'))).toBe(false);
    await results.getByTestId('results-artifact-back').click();
    await expect(page.frameLocator('[data-testid="results-artifact-frame"]').locator('#title')).toHaveText('Fixture report');

    // Source view shows the page text instead.
    await results.getByRole('button', { name: 'Source' }).click();
    await expect(results.getByText(/getElementById\('script'\)/u)).toBeVisible();

    // The PDF shows in Chromium's viewer inside the same isolated preview.
    await results.getByRole('button', { name: /^paper\.pdf/u }).click();
    const pdf = results.getByTestId('results-artifact-frame');
    await expect(pdf).toHaveAttribute('src', /^ezartifact:\/\/[0-9a-f]{32}\/paper\.pdf$/u);
    // Chromium's viewer runs as a frame inside the preview (Electron 41+: no separate WebContents).
    await expect.poll(() => page.frames().map((candidate) => candidate.url()).some((url) => url.startsWith('chrome-extension://')), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(2_000);
    console.log('PDF FRAMES', JSON.stringify(page.frames().map((candidate) => candidate.url())));
    await page.screenshot({ path: path.join(evidence, 'pdf-preview.png') });
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'artifacts-failure.png') }).catch(() => undefined);
    console.log((await page.locator('body').innerText().catch(() => '')).slice(-4000));
    throw error;
  } finally {
    await app.close();
  }
});

test('a Results tab popped out to its own window keeps its previews and is not counted as closed', async () => {
  test.setTimeout(180_000);
  const profile = createRegisteredE2eTempDir('ezterm-results-popout-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-results-popout-project-');
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    await startConversation(page, projectRoot);
    await send(page, 'EZTERMINAL_E2E_ARTIFACTS write a report');
    await expect(page.getByTestId('conversation-results')).toBeVisible({ timeout: 30_000 });
    const opened = await page.evaluate(async () => {
      const dock = (window as unknown as { __ezDock: { panels: { id: string; api: { component: string } }[]; addPopoutGroup(panel: unknown, options: unknown): Promise<boolean> } }).__ezDock;
      const results = dock.panels.find((panel) => panel.api.component === 'agent-results');
      return results ? dock.addPopoutGroup(results, { position: { left: 120, top: 80, width: 760, height: 820 } }) : false;
    });
    expect(opened).toBe(true);
    await expect.poll(() => app.windows().filter((candidate) => candidate.url().includes('ez-popout=1')).length, { timeout: 15_000 }).toBe(1);
    const popout = app.windows().find((candidate) => candidate.url().includes('ez-popout=1'))!;
    const results = popout.getByTestId('conversation-results');
    await expect(results).toBeVisible({ timeout: 15_000 });
    await results.getByTestId('results-tab-files').click();
    await results.getByRole('button', { name: /^report\.html/u }).click();
    const frame = popout.frameLocator('[data-testid="results-artifact-frame"]');
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(200, 0, 0)');
    await expect(frame.locator('#script')).toHaveText('script did not run');
    await results.getByRole('button', { name: /^paper\.pdf/u }).click();
    await expect.poll(() => popout.frames().map((candidate) => candidate.url()).some((url) => url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')), { timeout: 15_000 }).toBe(true);
    await popout.waitForTimeout(1_500);
    await popout.screenshot({ path: path.join(evidence, 'popout-pdf.png') });
    // Moving the tab to a window is not closing it: the conversation still opens Results on its own later.
    const dismissed = await page.evaluate(() => localStorage.getItem('ezterminal.agent.results-tab.v1'));
    expect(dismissed ?? '[]').not.toContain('"dismissed":true');
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'popout-failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    await app.close();
  }
});
