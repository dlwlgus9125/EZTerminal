import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createRegisteredE2eTempDir, expect, test } from './test';

import {
  createDaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
} from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const FAKE_CODEX_VERSION_FILE = 'ezterminal-e2e-codex-version.txt';
const evidenceDirectory = path.resolve('artifacts/conversation-ux/windows');
mkdirSync(evidenceDirectory, { recursive: true });


function fakeCodexEnvironment(versionDirectory: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path')
    ?? 'PATH';
  return {
    [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`,
    TMPDIR: versionDirectory,
  };
}

function structuredAgentState(snapshot: DaemonSnapshot): {
  readonly sessions: typeof snapshot.sessions;
  readonly agents: typeof snapshot.agents;
  readonly turns: typeof snapshot.turns;
} {
  const sessions = snapshot.sessions.filter((session) => session.kind === 'agent');
  return {
    sessions,
    agents: snapshot.agents,
    turns: snapshot.turns,
  };
}

test('New Terminal opens immediately and an older Codex CLI starts without app-chat setup', async ({ browserName }, testInfo) => {
  void browserName;
  const userDataDir = createRegisteredE2eTempDir('ezterm-terminal-first-e2e-');
  writeFileSync(path.join(userDataDir, FAKE_CODEX_VERSION_FILE), '0.1.0', 'utf8');
  const app = await launchApp(userDataDir, fakeCodexEnvironment(userDataDir));
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    await expect(window.getByTestId('cmd-input')).toBeVisible();
    const before = await window.evaluate(() => globalThis.window.ezterminal.listSessions());
    await window.getByTestId('btn-new-tab').click();
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.ezterminal.listSessions())).length).toBe(before.length + 1);
    await expect(window.getByTestId('new-session-draft')).toHaveCount(0);
    const launchers = await window.evaluate(() => globalThis.window.ezterminal.listAgentProjectLaunchers());
    expect(launchers.find((entry) => entry.launcherId === 'codex')).toMatchObject({ installed: true });
    const inspection = await window.evaluate(() => globalThis.window.ezterminal.inspectDaemonProvider('codex'));
    expect(inspection.ok && inspection.value.probe.available).toBe(false);
    const command = window.locator('[data-testid="pane"]:visible').getByTestId('cmd-input');
    await command.fill('codex --model chosen-cli-model');
    await command.press('Enter');
    const terminal = window.locator('[data-testid="pane"]:visible');
    await expect(terminal).toContainText('CLI-MODEL:chosen-cli-model', { timeout: 20_000 });
  } catch (error) {
    const window = await app.firstWindow();
    await window.screenshot({ path: path.join(evidenceDirectory, 'terminal.png') });
    await testInfo.attach('terminal', { path: path.join(evidenceDirectory, 'terminal.png'), contentType: 'image/png' });
    console.log((await window.locator('body').innerText()).slice(-5000));
    throw error;
  } finally { await app.close(); }
});

test('New Agent opens a draft tab without creating structured daemon work', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    const before = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(before).not.toBeNull();

    await window.getByTestId('rail-agents').click();
    await window.getByTestId('agent-new-run').click();

    await expect(window.getByTestId('new-session-draft')).toHaveCount(0);
    const draft = window.getByTestId('conversation-start');
    await expect(draft).toBeVisible();
    await expect(draft.getByTestId('structured-agent-composer-input')).toBeVisible();
    // Plan mode is a switch beside the permission, which offers access levels only.
    const plan = draft.getByTestId('structured-agent-live-plan');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    await draft.getByTestId('structured-agent-live-permission').click();
    await expect(window.getByRole('menuitemradio')).toHaveCount(2);
    await window.keyboard.press('Escape');
    await draft.getByTestId('structured-agent-composer-input').click();
    await window.keyboard.press('Shift+Tab');
    await expect(plan).toHaveAttribute('aria-pressed', 'true');

    const after = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(after).not.toBeNull();
    // Legacy terminal registration and Project discovery may legitimately
    // advance the shared daemon revision while this read-only draft is open.
    // The draft contract is that no structured Provider work exists until Send.
    expect(structuredAgentState(after!)).toEqual(structuredAgentState(before!));
  } finally {
    await app.close();
  }
});

test('New Agent keeps a newer compatible Codex ready while Claude consent is pending', async ({ browserName }, testInfo) => {
  void browserName;
  const userDataDir = createRegisteredE2eTempDir('ezterm-codex-upgrade-e2e-');
  const versionFile = path.join(userDataDir, FAKE_CODEX_VERSION_FILE);
  writeFileSync(versionFile, '0.152.1', 'utf8');
  const baselineApp = await launchApp(userDataDir, fakeCodexEnvironment(userDataDir));
  let reviewedDigest = '';
  let receipt: DaemonCommandReceipt | undefined;
  try {
    const baselineWindow = await baselineApp.firstWindow();
    await baselineWindow.setViewportSize({ width: 1440, height: 900 });
    await expect(baselineWindow.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    const claude = await baselineWindow.evaluate(async () => (
      globalThis.window.ezterminal.getClaudeProviderEnablement()
    ));
    expect(claude).toEqual({
      ok: true,
      value: {
        enabled: false,
        termsAccepted: false,
        commercialUseApproved: false,
        authenticationPath: 'existing-cli-environment',
        anthropicThirdPartyApproval: false,
      },
    });

    const inspection = await baselineWindow.evaluate(async () => (
      globalThis.window.ezterminal.inspectDaemonProvider('codex')
    ));
    if (!inspection.ok) throw new Error(inspection.message);
    expect(inspection.value.probe.executableVersion).toBe('0.152.1');
    const { probe, reviewDigest } = inspection.value;
    reviewedDigest = reviewDigest;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const authority = await baselineWindow.evaluate(async () => (
        globalThis.window.ezterminal.getDaemonSnapshot()
      ));
      expect(authority).not.toBeNull();
      const commandId = `e2e-enable-codex-${attempt}`;
      receipt = await baselineWindow.evaluate(async (command) => (
        globalThis.window.ezterminal.sendDaemonCommand(command)
      ), createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority!.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'e2e-provider-readiness' },
        type: 'provider.enable',
        payload: {
          providerId: probe.providerId,
          displayName: probe.displayName,
          protocol: probe.protocol,
          executablePath: probe.executablePath,
          executableVersion: probe.executableVersion,
          argv: probe.argv,
          environmentVariableNames: probe.environmentVariableNames,
          capabilities: probe.capabilities,
          reviewDigest,
        },
      }));
      if (receipt.ok || receipt.error.code !== 'revision-conflict') break;
    }
    expect(receipt?.ok, `Codex enable receipt: ${JSON.stringify(receipt)}`).toBe(true);
  } finally {
    await baselineApp.close();
  }

  writeFileSync(versionFile, '0.153.4', 'utf8');
  const app = await launchApp(userDataDir, fakeCodexEnvironment(userDataDir));
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    const restoredSnapshot = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(restoredSnapshot?.providers.find((provider) => provider.id === 'codex')).toMatchObject({
      enabled: true,
      health: 'ready',
      executableVersion: '0.152.1',
      reviewDigest: reviewedDigest,
    });
    await window.getByTestId('btn-toggle-settings').click();
    await window.getByTestId('settings-category-agents').click();
    await window.getByTestId('agent-chat-settings').locator('summary').first().click();
    const codexCard = window.getByTestId('structured-provider-codex');
    await expect(codexCard).toContainText('Ready');
    await expect(codexCard).toContainText('0.153.4');
    await expect(codexCard.getByTestId('provider-enable-codex')).toHaveCount(0);
    await window.getByTestId('btn-toggle-settings').click();

    await window.getByTestId('rail-agents').click();
    await window.getByTestId('agent-new-run').click();

    await expect(window.getByTestId('new-session-draft')).toHaveCount(0);
    const draft = window.getByTestId('conversation-start');
    await expect(draft).toBeVisible();
    // The AI and the working folder are chosen under the message box.
    const model = draft.getByTestId('structured-agent-live-model');
    await expect(
      model,
      `Codex enable receipt: ${JSON.stringify(receipt)}`,
    ).toHaveAttribute('aria-label', /^Codex model: /u);
    await model.click();
    const codexChoice = window.getByRole('menuitemradio', { name: 'Codex', exact: true });
    await expect(codexChoice).toHaveAttribute('aria-checked', 'true');
    await expect(codexChoice).toBeEnabled();
    await window.keyboard.press('Escape');

    const workspaceName = restoredSnapshot!.workspaces[0].name;
    const folders = draft.getByTestId('structured-agent-folders');
    await folders.click();
    await window.getByRole('menuitemradio').filter({ has: window.getByText(workspaceName, { exact: true }) }).click();
    await expect(folders).toHaveAttribute('aria-label', `Working folder: ${workspaceName}`);
    const session = window.getByTestId('structured-agent-session');
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute('data-provider', 'codex');
    await expect(session).toContainText('Write your first message');
    const empty = await window.evaluate(async () => {
      const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
      return snapshot?.agents;
    });
    expect(empty).toEqual([]);
    const composer = session.getByTestId('structured-agent-composer-input');
    await composer.fill('$fixture-rev');
    await expect(session.getByRole('option', { name: /\$fixture-review/ })).toBeVisible();
    await composer.press('Enter');
    await expect(composer).toHaveValue('$fixture-review ');
    expect((await window.evaluate(() => globalThis.window.ezterminal.getDaemonSnapshot()))?.turns).toEqual([]);
    // Previous conversations live in the header's session menu.
    await session.getByTestId('structured-agent-menu').click();
    await session.getByRole('menuitem', { name: 'Previous conversations', exact: true }).click();
    await expect(window.getByTestId('conversation-history-dialog')).toBeVisible();
    await window.getByRole('button', { name: 'Close previous conversations', exact: true }).click();
    await expect(composer).toHaveValue('$fixture-review ');
    await composer.fill('$fixture-review Verify the ready provider.');
    // A new conversation already shows the AI's plan limits Codex reported when the tab opened; context comes with the reply.
    await expect(session.getByTestId('structured-agent-usage-weekly')).toBeVisible();
    await expect(session.getByTestId('structured-agent-usage-context')).toHaveCount(0);
    await window.screenshot({ path: path.join(evidenceDirectory, 'new-conversation.png') });
    await composer.press('Enter');
    await expect(window.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
    const sessionId = await session.getAttribute('data-session-id');
    expect(sessionId).toBeTruthy();
    await expect.poll(async () => window.evaluate(async (createdSessionId) => {
      const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
      const agent = snapshot?.agents.find((candidate) => candidate.sessionId === createdSessionId);
      const turn = snapshot?.turns.find((candidate) => candidate.sessionId === createdSessionId);
      return {
        providerId: agent?.providerId,
        providerSessionId: agent?.providerSessionId,
        agentState: agent?.state,
        turnState: turn?.state,
      };
    }, sessionId!), { timeout: 15_000 }).toEqual({
      providerId: 'codex',
      providerSessionId: 'fixture-thread-1',
      agentState: 'idle',
      turnState: 'completed',
    });
    // The reply brought the account's weekly window and this thread's context; the account has no 5-hour window.
    await expect(session.getByTestId('structured-agent-usage-weekly')).toBeVisible();
    await expect(session.getByTestId('structured-agent-usage-context')).toBeVisible();
    await expect(session.getByTestId('structured-agent-usage-fiveHour')).toHaveCount(0);
    await session.getByTestId('structured-agent-usage').click();
    const usageDetails = window.getByRole('dialog', { name: 'Codex usage' });
    await expect(usageDetails).toContainText('Weekly26%');
    await window.screenshot({ path: path.join(evidenceDirectory, 'usage-details.png') });
    await window.keyboard.press('Escape');
    await expect(usageDetails).toHaveCount(0);
    expect(JSON.parse(readFileSync(path.join(userDataDir, 'ezterminal-e2e-codex-last-input.json'), 'utf8'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'skill', name: 'fixture-review', path: 'C:\\fixture\\skills\\review\\SKILL.md' }),
    ]));
    await window.screenshot({ path: path.join(evidenceDirectory, 'after-first-send.png') });
    await testInfo.attach('after-first-send', { path: path.join(evidenceDirectory, 'after-first-send.png'), contentType: 'image/png' });

    // `/clear` starts over in this same tab with the same settings, and never reaches the model;
    // text after it starts the new conversation's message box.
    const tabs = window.locator('.ez-dock .dv-tab');
    const tabCount = await tabs.count();
    const providerInput = readFileSync(path.join(userDataDir, 'ezterminal-e2e-codex-last-input.json'), 'utf8');
    // Plan mode with Full access chosen for the plan: the new conversation keeps both.
    await session.getByTestId('structured-agent-live-plan').click();
    await expect(session.getByTestId('structured-agent-live-plan')).toHaveAttribute('aria-pressed', 'true');
    await session.getByTestId('structured-agent-live-permission').click();
    await window.getByRole('menuitemradio', { name: /Full access/u }).click();
    await expect(session.getByTestId('structured-agent-live-permission')).toHaveAttribute('aria-label', /Full access/u);
    await composer.fill('/clear keep this question');
    await composer.press('Escape');
    await composer.press('Enter');
    const cleared = window.getByTestId('conversation-start');
    await expect(cleared).toBeVisible();
    await expect(tabs).toHaveCount(tabCount);
    await expect(cleared.getByTestId('structured-agent-live-model')).toHaveAttribute('aria-label', /^Codex model: /u);
    await expect(cleared.getByTestId('structured-agent-folders')).toHaveAttribute('aria-label', `Working folder: ${workspaceName}`);
    await expect(cleared.getByTestId('structured-agent-session')).not.toHaveAttribute('data-session-id', sessionId!);
    await expect(cleared.getByTestId('structured-agent-composer-input')).toHaveValue('keep this question');
    await expect(cleared.getByTestId('structured-agent-live-plan')).toHaveAttribute('aria-pressed', 'true');
    await expect(cleared.getByTestId('structured-agent-live-permission')).toHaveAttribute('aria-label', /Full access/u);
    await expect(cleared.getByTestId('structured-agent-usage-weekly')).toBeVisible();
    await expect(cleared.getByTestId('structured-agent-usage-context')).toHaveCount(0);
    const afterClear = await window.evaluate(() => globalThis.window.ezterminal.getDaemonSnapshot());
    expect(afterClear?.sessions.find((candidate) => candidate.id === sessionId)?.state).not.toBe('archived');
    expect(afterClear?.turns.filter((turn) => turn.sessionId === sessionId)).toHaveLength(1);
    expect(readFileSync(path.join(userDataDir, 'ezterminal-e2e-codex-last-input.json'), 'utf8')).toBe(providerInput);
    // The replaced conversation's provider is released rather than kept until quit.
    const clearedThread = afterClear?.agents.find((candidate) => candidate.sessionId === sessionId)?.providerSessionId;
    expect(clearedThread).toBeTruthy();
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(path.join(userDataDir, 'ezterminal-e2e-codex-unsubscribed.json'), 'utf8')) as string[]; } catch { return []; }
    }, { timeout: 15_000 }).toContain(clearedThread);
    await window.screenshot({ path: path.join(evidenceDirectory, 'after-clear.png') });
    await testInfo.attach('after-clear', { path: path.join(evidenceDirectory, 'after-clear.png'), contentType: 'image/png' });
  } catch (error) {
    const window = await app.firstWindow();
    await window.screenshot({ path: path.join(evidenceDirectory, 'first-send-error.png') });
    console.log((await window.locator('body').innerText()).slice(-8000));
    throw error;
  } finally {
    await app.close();
  }
});

for (const storedRootKind of ['directory', 'DOS alias'] as const) {
  test(`Project New Session opens a regular terminal and its closed view can be reopened (${storedRootKind})`, async () => {
    test.skip(storedRootKind === 'DOS alias' && process.platform !== 'win32', 'Windows short paths');
    const projectParent = createRegisteredE2eTempDir('ezterm-session-root-');
    const projectRoot = path.join(projectParent, 'project');
    mkdirSync(projectRoot);
    const userDataDir = createRegisteredE2eTempDir('ezterm-session-data-');
    const storedRoot = storedRootKind === 'DOS alias'
      ? path.join(execFileSync('powershell.exe', ['-NoProfile', '-Command', `
        Add-Type -Namespace EzTerminalTest -Name ShortPath -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, System.Text.StringBuilder buffer, uint length);'
        $buffer = New-Object System.Text.StringBuilder 32768
        $length = [EzTerminalTest.ShortPath]::GetShortPathName($env:EZTERMINAL_TEST_PROJECT_ROOT, $buffer, 32768)
        if ($length -eq 0) { throw 'GetShortPathName failed' }
        $buffer.ToString()
      `], { encoding: 'utf8', env: { ...process.env, EZTERMINAL_TEST_PROJECT_ROOT: projectParent } }).trim(), 'project')
      : projectRoot;
    test.skip(storedRootKind === 'DOS alias' && storedRoot === realpathSync.native(projectRoot), '8.3 names are unavailable on the fixture volume');
    const seedProjectId = 'session-ux-regression';
    writeFileSync(path.join(userDataDir, 'agent-projects.json'), JSON.stringify({ version: 3, projects: [{
      projectId: seedProjectId, name: 'Session UX fixture', primaryRoot: storedRoot, additionalRoots: [], pinned: true,
      origin: 'terminal', lastActiveAt: 1_785_181_625_234, createdAt: 1_785_181_600_000, updatedAt: 1_785_181_625_234,
    }] }), 'utf8');
    const app = await launchApp(userDataDir);
    try {
      const window = await app.firstWindow();
      await window.setViewportSize({ width: 1440, height: 900 });
      await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
      await window.getByTestId('rail-agents').click();
      const registered = await window.evaluate(async () => (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items);
      const projectId = registered.find((entry) => entry.name === 'Session UX fixture')?.projectId;
      expect(projectId, JSON.stringify(registered)).toBeTruthy();
      const before = await window.evaluate(() => globalThis.window.ezterminal.listSessions());
      await window.getByRole('button', { name: 'Manage Session UX fixture', exact: true }).click();
      await window.getByRole('menuitem', { name: 'New Terminal', exact: true }).click();
      await expect(window.getByTestId('new-session-draft')).toHaveCount(0);
      const pane = window.locator('[data-testid="pane"]:visible');
      await expect(pane).toHaveCount(1);
      await expect(pane).toHaveAttribute('data-session-id', /\S+/);
      const sessionId = await pane.getAttribute('data-session-id');
      expect(sessionId).toBeTruthy();
      const sessions = await window.evaluate(() => globalThis.window.ezterminal.listSessions());
      expect(sessions).toHaveLength(before.length + 1);
      const sessionTitle = await window.evaluate(async id => (await globalThis.window.ezterminal.getDaemonSnapshot())?.sessions.find(item => item.id === id)?.title, sessionId!);
      expect(sessionTitle).toBeTruthy();
      // Project terminal identity is canonical, even when TEMP uses a DOS 8.3 alias.
      expect(path.resolve(sessions.find((session) => session.sessionId === sessionId)!.cwd)).toBe(realpathSync.native(projectRoot));
      await pane.getByTestId('cmd-input').fill('echo preserved-draft');
      await window.locator('.ez-dock .dv-tab.dv-active-tab .dv-default-tab-action').click();
      await expect(window.locator(`[data-testid="pane"][data-session-id="${sessionId}"]`)).toHaveCount(0);
      const projectRow = window.getByTestId(`agent-project-open-${projectId}`);
      if (await projectRow.getAttribute('aria-expanded') !== 'true') await projectRow.getByRole('button', { name: 'Expand: Session UX fixture', exact: true }).click();
      const row = window.getByTestId('project-conversation-tree').getByRole('treeitem', { name: `${sessionTitle} · Terminal`, exact: true });
      await expect(row).toBeVisible();
      await row.click();
      const reopened = window.locator(`[data-testid="pane"][data-session-id="${sessionId}"]`);
      await expect(reopened).toBeVisible();
      await expect(reopened.getByTestId('cmd-input')).toHaveValue('echo preserved-draft');
      await row.getByTestId('session-end').click();
      await expect(window.getByTestId('session-end-dialog')).toBeVisible();
      await window.getByTestId('session-end-confirm').click();
      await expect.poll(async () => (await window.evaluate(() => globalThis.window.ezterminal.listSessions())).some((session) => session.sessionId === sessionId)).toBe(false);
    } finally { await app.close(); }
  });
}
