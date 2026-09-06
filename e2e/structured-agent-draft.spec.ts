import { writeFileSync } from 'node:fs';
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
    const codexCard = window.getByTestId('structured-provider-codex');
    await expect(codexCard).toContainText('Ready');
    await expect(codexCard).toContainText('0.153.4');
    await expect(codexCard.getByTestId('provider-enable-codex')).toHaveCount(0);
    await window.getByTestId('btn-toggle-settings').click();

    await window.getByTestId('btn-toggle-agents').click();
    await window.getByTestId('agent-new-run').click();

    const draft = window.getByTestId('structured-agent-draft');
    await expect(draft).toBeVisible();
    const provider = draft.getByTestId('structured-agent-provider');
    await expect(
      provider,
      `Codex enable receipt: ${JSON.stringify(receipt)}`,
    ).toHaveValue('codex');
    await expect(provider.locator('option[value="codex"]')).toHaveText('Codex');
    await expect(provider.locator('option[value="codex"]')).toBeEnabled();

    const workspace = draft.getByTestId('structured-agent-workspace');
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
