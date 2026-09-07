import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createRegisteredE2eTempDir, expect, test } from './test';

import {
  createDaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
} from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const FAKE_CODEX_VERSION_FILE = 'ezterminal-e2e-codex-version.txt';

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

test('New Terminal opens immediately and an older Codex CLI starts without app-chat setup', async () => {
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
    await window.getByTestId('btn-new-session').click();
    await expect(window.getByTestId('new-session-cli')).toHaveAttribute('aria-pressed', 'true');
    await window.getByTestId('new-session-project').selectOption('direct');
    await window.getByRole('textbox', { name: 'Host folder path' }).fill(userDataDir);
    await window.getByTestId('session-cli-launcher').selectOption('codex');
    await window.getByTestId('session-cli-start').click();
    const terminal = window.locator('[data-testid="pane"]:visible').getByTestId('pty-block');
    await expect(terminal).toBeVisible();
    await expect.poll(() => readXtermBuffer(terminal), { timeout: 20000 }).toContain('FAKE-CODEX-READY');
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

    await window.getByTestId('btn-toggle-agents').click();
    await window.getByTestId('agent-new-run').click();

    await expect(window.getByTestId('new-session-cli')).toHaveAttribute('aria-pressed', 'true');
    await window.getByTestId('new-session-conversation').click();
    const draft = window.getByTestId('structured-agent-draft');
    await expect(draft).toBeVisible();
    await expect(draft.getByTestId('structured-agent-first-prompt')).toBeVisible();

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

test('New Agent keeps a newer compatible Codex ready while Claude consent is pending', async () => {
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

    await window.getByTestId('btn-toggle-agents').click();
    await window.getByTestId('agent-new-run').click();

    await expect(window.getByTestId('new-session-cli')).toHaveAttribute('aria-pressed', 'true');
    await window.getByTestId('new-session-conversation').click();
    const draft = window.getByTestId('structured-agent-draft');
    await expect(draft).toBeVisible();
    const provider = draft.getByTestId('structured-agent-provider');
    await expect(
      provider,
      `Codex enable receipt: ${JSON.stringify(receipt)}`,
    ).toHaveValue('codex');
    await expect(provider.locator('option[value="codex"]')).toHaveText('Codex');
    await expect(provider.locator('option[value="codex"]')).toBeEnabled();

    const project = window.getByTestId('new-session-project');
    await project.selectOption(restoredSnapshot!.workspaces[0].projectId);
    const workspace = window.getByTestId('new-session-workspace');
    await workspace.selectOption(restoredSnapshot!.workspaces[0].id);
    await expect(workspace).not.toHaveValue('');
    await draft.getByTestId('structured-agent-first-prompt').fill('Verify the ready provider.');
    const send = draft.getByTestId('structured-agent-create');
    await expect(send).toBeEnabled();
    await send.click();

    const session = window.getByTestId('structured-agent-session');
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute('data-provider', 'codex');
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
  } finally {
    await app.close();
  }
});

test('Project New Session opens a regular terminal and its closed view can be reopened', async () => {
  const projectRoot = createRegisteredE2eTempDir('ezterm-session-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-session-data-');
  const seedProjectId = 'session-ux-regression';
  writeFileSync(path.join(userDataDir, 'agent-projects.json'), JSON.stringify({ version: 3, projects: [{
    projectId: seedProjectId, name: 'Session UX fixture', primaryRoot: projectRoot, additionalRoots: [], pinned: true,
    origin: 'terminal', lastActiveAt: 1_785_181_625_234, createdAt: 1_785_181_600_000, updatedAt: 1_785_181_625_234,
  }] }), 'utf8');
  const app = await launchApp(userDataDir);
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    await window.getByTestId('btn-toggle-agents').click();
    const registered = await window.evaluate(async () => (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items);
    const projectId = registered.find((entry) => entry.name === 'Session UX fixture')?.projectId;
    expect(projectId, JSON.stringify(registered)).toBeTruthy();
    const before = await window.evaluate(() => globalThis.window.ezterminal.listSessions());
    await window.getByTestId(`agent-project-new-chat-${projectId}`).click();
    await expect(window.getByTestId('new-session-draft')).toHaveCount(0);
    const pane = window.locator('[data-testid="pane"]:visible');
    await expect(pane).toHaveCount(1);
    const sessionId = await pane.getAttribute('data-session-id');
    expect(sessionId).toBeTruthy();
    const sessions = await window.evaluate(() => globalThis.window.ezterminal.listSessions());
    expect(sessions).toHaveLength(before.length + 1);
    // Project terminal identity is canonical, even when TEMP uses a DOS 8.3 alias.
    expect(path.resolve(sessions.find((session) => session.sessionId === sessionId)!.cwd)).toBe(realpathSync.native(projectRoot));
    await pane.getByTestId('cmd-input').fill('echo preserved-draft');
    await window.locator('.ez-dock .dv-tab.dv-active-tab .dv-default-tab-action').click();
    await expect(window.locator(`[data-testid="pane"][data-session-id="${sessionId}"]`)).toHaveCount(0);
    const group = window.locator('.daemon-agent-project').filter({ has: window.getByTestId(`agent-project-open-${projectId}`) });
    await group.locator('summary').click();
    const row = group.locator(`button.daemon-agent-session[data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await row.click();
    const reopened = window.locator(`[data-testid="pane"][data-session-id="${sessionId}"]`);
    await expect(reopened).toBeVisible();
    await expect(reopened.getByTestId('cmd-input')).toHaveValue('echo preserved-draft');
    await row.locator('..').getByTestId('session-end').click();
    await expect(window.getByTestId('session-end-dialog')).toBeVisible();
    await window.getByTestId('session-end-confirm').click();
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.ezterminal.listSessions())).some((session) => session.sessionId === sessionId)).toBe(false);
  } finally { await app.close(); }
});
