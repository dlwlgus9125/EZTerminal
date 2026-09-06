import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import {
  createStructuredAgentSession,
  resolvePreferredDaemonWorkspaceId,
  structuredAgentModelOptions,
  structuredAgentProviderOptions,
  structuredAgentWorkspaceOptions,
  type StructuredAgentCreateAccess,
  type StructuredAgentCreateCommand,
} from './structured-agent-create';

const NOW = '2026-09-06T04:00:00.000Z';

function daemonSnapshot(revision = 4): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision,
    eventSequence: revision + 5,
    generatedAt: NOW,
    runtime: {
      keepRunning: true,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [{
      id: 'project-1',
      name: 'Active project',
      source: 'native',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      id: 'project-archived',
      name: 'Archived project',
      source: 'native',
      archivedAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    workspaces: [{
      id: 'project-1.root-1.workspace-1',
      projectId: 'project-1',
      name: 'Feature worktree',
      kind: 'worktree',
      rootPath: 'C:\\Working\\feature',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      id: 'project-1.root-1.workspace-archived',
      projectId: 'project-1',
      name: 'Archived worktree',
      kind: 'worktree',
      rootPath: 'C:\\Working\\archived',
      archivedAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      id: 'project-archived.root-2.workspace-2',
      projectId: 'project-archived',
      name: 'Orphaned active worktree',
      kind: 'worktree',
      rootPath: 'C:\\Working\\orphaned',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [{
      id: 'codex',
      displayName: 'Codex',
      protocol: 'codex-app-server',
      executablePath: 'codex',
      executableVersion: '1.0.0',
      argv: [],
      environmentVariableNames: [],
      capabilities: ['model:gpt-5.6', 'model=gpt-5.7'],
      enabled: true,
      health: 'ready',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      id: 'claude',
      displayName: 'Claude Code',
      protocol: 'claude-agent-sdk',
      executablePath: 'claude',
      executableVersion: '1.0.0',
      argv: [],
      environmentVariableNames: [],
      capabilities: [],
      enabled: true,
      health: 'unavailable',
      healthDetail: 'Consent is required.',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      id: 'disabled',
      displayName: 'Disabled provider',
      protocol: 'acp',
      executablePath: 'disabled',
      executableVersion: '1.0.0',
      argv: [],
      environmentVariableNames: [],
      capabilities: [],
      enabled: false,
      health: 'ready',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    schedules: [],
    heartbeats: [],
  };
}

function applied(commandId: string, revision: number): DaemonCommandReceipt {
  return {
    ok: true,
    status: 'applied',
    commandId,
    revision,
    eventSequence: revision + 5,
  };
}

function revisionConflict(commandId: string, revision: number): DaemonCommandReceipt {
  return {
    ok: false,
    status: 'rejected',
    commandId,
    revision,
    error: {
      code: 'revision-conflict',
      message: 'The daemon revision changed.',
      retryable: true,
      currentRevision: revision,
    },
  };
}

function createIds(): (prefix: 'agent' | 'command') => string {
  let commandSequence = 0;
  return (prefix) => {
    if (prefix === 'agent') return 'agent-stable';
    commandSequence += 1;
    return `command-${commandSequence}`;
  };
}

const draft = {
  providerId: 'codex',
  model: 'gpt-5.6',
  workspaceId: 'project-1.root-1.workspace-1',
  permissionPreset: 'standard' as const,
  initialPrompt: '  Inspect\n  the project.  ',
};

describe('structured Agent create projections', () => {
  it('projects eligible providers, models, active workspaces, and opaque workspace identity', () => {
    const snapshot = daemonSnapshot();
    expect(structuredAgentProviderOptions(snapshot, {
      codex: [{ id: 'gpt-5.6', displayName: 'GPT-5.6' }],
    })).toEqual([{
      id: 'codex',
      label: 'Codex',
      models: [
        { id: 'gpt-5.6', label: 'GPT-5.6' },
        { id: 'gpt-5.7', label: 'gpt-5.7' },
      ],
      disabled: false,
      description: undefined,
    }, {
      id: 'claude',
      label: 'Claude Code',
      models: [],
      disabled: true,
      description: 'Consent is required.',
    }]);
    expect(structuredAgentModelOptions([], 'custom-model')).toEqual([
      { id: 'custom-model', label: 'custom-model' },
    ]);

    const workspaces = structuredAgentWorkspaceOptions(snapshot, 'project-1');
    expect(workspaces).toEqual([{
      id: 'project-1.root-1.workspace-1',
      label: 'Feature worktree',
      kind: 'worktree',
      path: 'C:\\Working\\feature',
    }]);
    expect(resolvePreferredDaemonWorkspaceId(
      workspaces,
      'project-1',
      'root-1',
      'workspace-1',
    )).toBe('project-1.root-1.workspace-1');
  });
});

describe('createStructuredAgentSession', () => {
  it('gets fresh authority and sends one atomic first-prompt command', async () => {
    const getSnapshot = vi.fn(async () => daemonSnapshot());
    const sendCommand = vi.fn(async (command: StructuredAgentCreateCommand) => (
      applied(command.commandId, 5)
    ));

    const outcome = await createStructuredAgentSession(draft, {
      access: { getSnapshot, sendCommand },
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      createId: createIds(),
      now: () => new Date(NOW),
    });

    expect(outcome.kind).toBe('created');
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'command-1',
      idempotencyKey: 'command-1',
      expectedRevision: 4,
      issuedAt: NOW,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        sessionId: 'agent-stable',
        workspaceId: 'project-1.root-1.workspace-1',
        title: 'Inspect the project.',
        providerId: 'codex',
        model: 'gpt-5.6',
        permissionPreset: 'standard',
        initialPrompt: 'Inspect\n  the project.',
      },
    }));
  });

  it('publishes the exact envelope before crossing the delivery boundary', async () => {
    let prepared: StructuredAgentCreateCommand | undefined;
    let releasePrepared!: () => void;
    const preparedSaved = new Promise<void>((resolve) => { releasePrepared = resolve; });
    const sendCommand = vi.fn(async (command: StructuredAgentCreateCommand) => {
      expect(prepared).toBe(command);
      return applied(command.commandId, 5);
    });

    const pending = createStructuredAgentSession(draft, {
      access: { getSnapshot: async () => daemonSnapshot(), sendCommand },
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      createId: createIds(),
      now: () => new Date(NOW),
      onCommandPrepared: async (command) => {
        prepared = command;
        await preparedSaved;
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(prepared).toBeDefined();
    expect(sendCommand).not.toHaveBeenCalled();
    releasePrepared();
    const outcome = await pending;
    expect(outcome.kind).toBe('created');
    expect(sendCommand).toHaveBeenCalledOnce();
  });

  it('does not deliver when exact-envelope escrow cannot be confirmed', async () => {
    const sendCommand = vi.fn<StructuredAgentCreateAccess['sendCommand']>();
    const outcome = await createStructuredAgentSession(draft, {
      access: { getSnapshot: async () => daemonSnapshot(), sendCommand },
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      createId: createIds(),
      now: () => new Date(NOW),
      onCommandPrepared: async () => { throw new Error('checkpoint rejected'); },
    });

    expect(outcome).toMatchObject({
      kind: 'rejected',
      reason: 'recovery-unavailable',
      command: { commandId: 'command-1' },
      message: expect.stringContaining('No command was sent'),
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('retries two revision conflicts with one Session identity and fresh command identities', async () => {
    const snapshots = [daemonSnapshot(4), daemonSnapshot(5), daemonSnapshot(6)];
    let snapshotIndex = 0;
    const getSnapshot = vi.fn(async () => snapshots[snapshotIndex++] ?? null);
    let sendIndex = 0;
    const sendCommand = vi.fn(async (command: StructuredAgentCreateCommand) => {
      sendIndex += 1;
      return sendIndex < 3
        ? revisionConflict(command.commandId, command.expectedRevision + 1)
        : applied(command.commandId, 7);
    });

    const outcome = await createStructuredAgentSession(draft, {
      access: { getSnapshot, sendCommand },
      principal: { kind: 'android', id: 'mobile-agent-ui' },
      createId: createIds(),
      now: () => new Date(NOW),
    });

    expect(outcome.kind).toBe('created');
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    expect(sendCommand).toHaveBeenCalledTimes(3);
    expect(sendCommand.mock.calls.map(([command]) => ({
      commandId: command.commandId,
      sessionId: command.payload.sessionId,
      title: command.payload.title,
      expectedRevision: command.expectedRevision,
    }))).toEqual([
      { commandId: 'command-1', sessionId: 'agent-stable', title: 'Inspect the project.', expectedRevision: 4 },
      { commandId: 'command-2', sessionId: 'agent-stable', title: 'Inspect the project.', expectedRevision: 5 },
      { commandId: 'command-3', sessionId: 'agent-stable', title: 'Inspect the project.', expectedRevision: 6 },
    ]);
  });

  it('stops after three total revision-conflict attempts', async () => {
    let revision = 3;
    const access: StructuredAgentCreateAccess = {
      getSnapshot: vi.fn(async () => daemonSnapshot(revision++)),
      sendCommand: vi.fn(async (command) => revisionConflict(
        command.commandId,
        command.expectedRevision + 1,
      )),
    };

    const outcome = await createStructuredAgentSession(draft, {
      access,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      createId: createIds(),
      now: () => new Date(NOW),
    });

    expect(outcome).toMatchObject({
      kind: 'rejected',
      reason: 'command-rejected',
      sessionId: 'agent-stable',
      command: { commandId: 'command-3' },
      receipt: { error: { code: 'revision-conflict' } },
    });
    expect(access.getSnapshot).toHaveBeenCalledTimes(3);
    expect(access.sendCommand).toHaveBeenCalledTimes(3);
  });

  it('returns the exact command when delivery is uncertain and does not retry it', async () => {
    let sent: StructuredAgentCreateCommand | undefined;
    const getSnapshot = vi.fn(async () => daemonSnapshot());
    const createId = vi.fn((prefix: 'agent' | 'command') => `${prefix}-recovery`);
    const sendCommand = vi.fn(async (command: StructuredAgentCreateCommand): Promise<DaemonCommandReceipt> => {
      sent = command;
      return {
        ok: false,
        status: 'delivery-uncertain',
        commandId: command.commandId,
        revision: command.expectedRevision,
        error: {
          code: 'delivery-uncertain',
          message: 'Connection closed before the receipt arrived.',
          retryable: false,
        },
      };
    });

    const outcome = await createStructuredAgentSession(draft, {
      access: { getSnapshot, sendCommand },
      principal: { kind: 'android', id: 'mobile-agent-ui' },
      sessionId: 'agent-original-attempt',
      createId,
      now: () => new Date(NOW),
    });

    expect(outcome.kind).toBe('delivery-uncertain');
    if (outcome.kind !== 'delivery-uncertain') throw new Error('Expected delivery uncertainty.');
    expect(outcome.command).toBe(sent);
    expect(outcome.command.payload.sessionId).toBe('agent-original-attempt');
    expect(createId).toHaveBeenCalledOnce();
    expect(createId).toHaveBeenCalledWith('command');
    expect(outcome.message).toBe('Connection closed before the receipt arrived.');
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledOnce();
  });

  it.each([
    ['provider-not-ready', { providerId: 'claude' }],
    ['workspace-unavailable', { workspaceId: 'project-1.root-1.workspace-archived' }],
  ] as const)('rejects %s before command delivery', async (reason, patch) => {
    const sendCommand = vi.fn<StructuredAgentCreateAccess['sendCommand']>();
    const outcome = await createStructuredAgentSession({ ...draft, ...patch }, {
      access: { getSnapshot: async () => daemonSnapshot(), sendCommand },
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      createId: createIds(),
      now: () => new Date(NOW),
    });

    expect(outcome).toMatchObject({ kind: 'rejected', reason });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
