import { resizeWindow } from './workbench-navigation';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { startNewConversation } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>['firstWindow']>>;

/**
 * A project with two folders: a new conversation chooses its working folder under the message
 * box, the AI (fake Codex) receives both folders, and a folder removed from the project is gone
 * from the next turn on. The header keeps title and state; the folders are a composer setting.
 */

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidence = path.resolve('artifacts/conversation-folders/e2e');
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
    const id = `e2e-folders-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-conversation-folders' }, type: 'provider.enable',
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

const key = (folder: string): string => folder.replace(/[\\/]+$/u, '').toLowerCase();

function turnRoots(profile: string): readonly (readonly string[] | null)[] {
  const file = path.join(profile, 'ezterminal-e2e-codex-turns.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => (JSON.parse(line) as { runtimeWorkspaceRoots: string[] | null }).runtimeWorkspaceRoots);
}

test('a conversation works in every project folder and drops a removed one from the next turn', async () => {
  test.setTimeout(180_000);
  const profile = createRegisteredE2eTempDir('ezterm-folders-profile-');
  const mainRoot = createRegisteredE2eTempDir('ezterm-folders-main-');
  const sharedRoot = createRegisteredE2eTempDir('ezterm-folders-shared-');
  // The app stores real paths; TEMP may be an 8.3 alias (as on CI).
  const mainReal = realpathSync.native(mainRoot);
  const sharedReal = realpathSync.native(sharedRoot);
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1600, height: 950 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate(([primaryRoot, shared]) => window.ezterminal.saveAgentProject({
      name: 'Folders acceptance', primaryRoot, additionalRoots: [shared], pinned: false,
    }), [mainRoot, sharedRoot] as const);
    if (!saved.ok) throw new Error(saved.reason);
    await enableCodex(page);
    await expect.poll(async () => {
      const workspaces = (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces ?? [];
      return [mainReal, sharedReal].every((root) => workspaces.some((workspace) => key(workspace.rootPath) === key(root)));
    }, { timeout: 15_000 }).toBe(true);
    const snapshot = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const mainWorkspace = snapshot!.workspaces.find((workspace) => key(workspace.rootPath) === key(mainReal))!;

    // New conversation: the working folder is chosen from the folder setting under the message box.
    const draft = await startNewConversation(page);
    await expect(draft.getByRole('combobox', { name: 'Conversation workspace' })).toHaveCount(0);
    const folders = draft.getByTestId('structured-agent-folders');
    await folders.click();
    await page.getByRole('menuitemradio').filter({ has: page.getByText(mainWorkspace.name, { exact: true }) }).click();
    await expect(folders).toHaveAttribute('aria-label', `Working folder: ${mainWorkspace.name}, also works in 1 folder`);
    await folders.click();
    const menu = page.getByRole('menu', { name: 'Working folder' });
    await expect(menu).toContainText('Also works in');
    await expect(menu).toContainText(sharedReal);
    await page.screenshot({ path: path.join(evidence, 'new-conversation-folders.png') });
    await page.keyboard.press('Escape');

    // Codex starts the thread in both folders, the chosen one first.
    const composer = draft.getByTestId('structured-agent-composer-input');
    await composer.click();
    await composer.fill('List both folders.');
    await composer.press('Enter');
    const threadFile = path.join(profile, 'ezterminal-e2e-codex-thread-start.json');
    await expect.poll(() => existsSync(threadFile), { timeout: 30_000 }).toBe(true);
    const thread = JSON.parse(readFileSync(threadFile, 'utf8')) as { cwd: string; runtimeWorkspaceRoots: string[] };
    expect(key(thread.cwd)).toBe(key(mainReal));
    expect(thread.runtimeWorkspaceRoots.map(key)).toEqual([key(mainReal), key(sharedReal)]);

    // The started conversation: the header has no folder line; the folder setting stays.
    const session = page.getByTestId('structured-agent-session').first();
    await expect(page.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
    await expect(session.locator('.structured-agent-session-header__identity p')).toHaveCount(0);
    const liveFolders = session.getByTestId('structured-agent-folders');
    await expect(liveFolders).toHaveAttribute('aria-label', `Working folder: ${mainWorkspace.name}, also works in 1 folder`);
    const sessionId = (await session.getAttribute('data-session-id'))!;
    await expect.poll(async () => (await page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.turns
      .filter((turn) => turn.sessionId === id).every((turn) => turn.state === 'completed'), sessionId)), { timeout: 20_000 }).toBe(true);
    await page.screenshot({ path: path.join(evidence, 'live-conversation-folders.png') });

    // The folder menu leads to the project editor with every registered folder.
    await liveFolders.click();
    await page.getByRole('menuitem', { name: 'Edit project…' }).click();
    const editor = page.getByTestId('agent-project-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(sharedReal);
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);

    // The shared folder leaves the project: the next turn runs in the working folder only.
    const updated = await page.evaluate(([projectId, primaryRoot]) => window.ezterminal.saveAgentProject({
      projectId, name: 'Folders acceptance', primaryRoot, additionalRoots: [], pinned: false,
    }), [saved.project.projectId, mainRoot] as const);
    if (!updated.ok) throw new Error(updated.reason);
    await expect(liveFolders).toHaveAttribute('aria-label', `Working folder: ${mainWorkspace.name}`, { timeout: 15_000 });
    const before = turnRoots(profile).length;
    const liveComposer = session.getByTestId('structured-agent-composer-input');
    await liveComposer.click();
    await liveComposer.fill('Only the working folder now.');
    await liveComposer.press('Enter');
    await expect.poll(() => turnRoots(profile).length, { timeout: 30_000 }).toBe(before + 1);
    expect(turnRoots(profile).at(-1)?.map(key)).toEqual([key(mainReal)]);
  } finally {
    await app.close();
  }
});
