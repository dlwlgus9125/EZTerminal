import { describe, expect, it, vi } from 'vitest';

import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import { DaemonCliControl } from './daemon-cli-control';

function snapshot(): DaemonSnapshot {
  const timestamp = '2026-09-04T00:00:00.000Z';
  const revisioned = { revision: 3, createdAt: timestamp, updatedAt: timestamp };
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    revision: 3,
    eventSequence: 8,
    generatedAt: timestamp,
    runtime: { keepRunning: true, startAtLogin: true, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [
      { ...revisioned, id: 'project-1', name: 'One', rootPath: 'C:\\one', source: 'native' },
      { ...revisioned, id: 'project-2', name: 'Two', rootPath: 'C:\\two', source: 'native' },
    ],
    workspaces: [
      { ...revisioned, id: 'workspace-1', projectId: 'project-1', name: 'Main', kind: 'local', rootPath: 'C:\\one' },
      { ...revisioned, id: 'workspace-2', projectId: 'project-2', name: 'Main', kind: 'local', rootPath: 'C:\\two' },
    ],
    sessions: [
      { ...revisioned, id: 'terminal-1', projectId: 'project-1', workspaceId: 'workspace-1', kind: 'terminal', title: 'Shell', state: 'running', source: 'legacy-pty' },
      { ...revisioned, id: 'agent-1', projectId: 'project-1', workspaceId: 'workspace-1', kind: 'agent', title: 'Builder', state: 'idle', source: 'structured' },
      { ...revisioned, id: 'agent-2', projectId: 'project-2', workspaceId: 'workspace-2', kind: 'agent', title: 'Foreign', state: 'idle', source: 'structured' },
    ],
    agents: [
      { ...revisioned, sessionId: 'agent-1', providerId: 'codex', permissionPreset: 'standard', state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true },
      { ...revisioned, sessionId: 'agent-2', providerId: 'claude', permissionPreset: 'plan', state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true },
    ],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [
      { ...revisioned, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'reviewed-codex', enabled: true, health: 'ready' },
      { ...revisioned, id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' },
    ],
    schedules: [
      { ...revisioned, id: 'schedule-1', name: 'Morning', workspaceId: 'workspace-1', providerId: 'codex', permissionPreset: 'standard', prompt: 'Review', cron: '0 9 * * *', timezone: 'Asia/Seoul', enabled: true, runCount: 0 },
      { ...revisioned, id: 'schedule-2', name: 'Foreign', workspaceId: 'workspace-2', providerId: 'claude', permissionPreset: 'plan', prompt: 'Review', cron: '0 9 * * *', timezone: 'UTC', enabled: true, runCount: 0 },
    ],
    heartbeats: [
      { ...revisioned, sessionId: 'agent-1', prompt: 'Status?', cron: '*/5 * * * *', timezone: 'UTC', enabled: true, pending: false },
    ],
  };
}

function fixture(
  receipts?: DaemonCommandReceipt[],
  resolvePhysicalDirectory: (value: string) => Promise<string> = async (value) => value,
) {
  let current = snapshot();
  const execute = vi.fn<(command: unknown) => Promise<DaemonCommandReceipt>>(async (command) => {
    void command;
    return receipts?.shift() ?? {
      ok: true,
      status: 'applied',
      commandId: 'applied',
      revision: current.revision + 1,
      eventSequence: current.eventSequence + 1,
    };
  });
  const readTranscript = vi.fn(() => ([{
    id: 'transcript-1',
    sessionId: 'agent-1',
    sequence: 4,
    kind: 'assistant-message' as const,
    text: 'Bounded result',
    isDelta: false,
    isSensitive: false,
    createdAt: '2026-09-04T00:30:00.000Z',
  }]));
  const control = new DaemonCliControl({
    getSnapshot: () => current,
    execute,
    readTranscript,
  }, () => new Date('2026-09-04T01:00:00.000Z'), resolvePhysicalDirectory);
  return { control, execute, readTranscript, setSnapshot: (value: DaemonSnapshot) => { current = value; } };
}

const source = { sessionId: 'terminal-1', projectId: 'project-1' } as const;

describe('DaemonCliControl', () => {
  it('returns a protocol-marked status and a Project-scoped snapshot', async () => {
    const { control } = fixture();
    await expect(control.handle('/v1/daemon/status', {}, source)).resolves.toMatchObject({
      status: 200,
      body: { ok: true, protocolVersion: 12, revision: 3, projectId: 'project-1', counts: { sessions: 2, activeAgents: 1 } },
    });
    const result = await control.handle('/v1/daemon/snapshot', {}, source);
    const scoped = result?.body.snapshot as DaemonSnapshot;
    expect(scoped.projects.map((project) => project.id)).toEqual(['project-1']);
    expect(scoped.sessions.map((session) => session.id)).toEqual(['terminal-1', 'agent-1']);
    expect(scoped.schedules.map((schedule) => schedule.id)).toEqual(['schedule-1']);
    expect(scoped.providers.map((provider) => provider.id)).toEqual(['codex']);
  });

  it('lists scoped Projects and Workspaces plus sanitized global Provider health', async () => {
    const { control } = fixture();
    const projects = await control.handle('/v1/daemon/projects', {}, source);
    const workspaces = await control.handle('/v1/daemon/workspaces', {}, source);
    const providers = await control.handle('/v1/daemon/providers', {}, source);

    expect((projects?.body.items as Array<{ id: string }>).map((item) => item.id)).toEqual(['project-1']);
    expect((workspaces?.body.items as Array<{ id: string }>).map((item) => item.id)).toEqual(['workspace-1']);
    expect((providers?.body.items as Array<Record<string, unknown>>)).toMatchObject([
      { id: 'codex', enabled: true, health: 'ready', reviewCurrent: true },
      { id: 'claude', enabled: true, health: 'ready', reviewCurrent: false },
    ]);
    for (const provider of providers?.body.items as Array<Record<string, unknown>>) {
      expect(provider).not.toHaveProperty('executablePath');
      expect(provider).not.toHaveProperty('argv');
      expect(provider).not.toHaveProperty('environmentVariableNames');
      expect(provider).not.toHaveProperty('reviewDigest');
    }
  });

  it('builds a typed CLI command with a fresh revision and stable attempt key', async () => {
    const { control, execute } = fixture();
    await expect(control.handle('/v1/daemon/agents/send', {
      target: 'Builder',
      prompt: 'Continue with the bounded task.',
      requestId: 'request-1',
    }, source)).resolves.toMatchObject({ status: 200, body: { ok: true } });

    const command = execute.mock.calls[0]![0] as DaemonCommand;
    expect(command).toMatchObject({
      protocolVersion: 12,
      commandId: 'cli-command-request-1-1',
      idempotencyKey: 'cli-request-1-1',
      expectedRevision: 3,
      issuedAt: '2026-09-04T01:00:00.000Z',
      principal: { kind: 'cli', id: 'terminal-1', sessionId: 'terminal-1' },
      type: 'agent.submit',
      payload: { sessionId: 'agent-1', prompt: 'Continue with the bounded task.' },
    });
  });

  it('retries only revision conflicts with a new idempotency key', async () => {
    const conflict: DaemonCommandReceipt = {
      ok: false,
      status: 'rejected',
      commandId: 'first',
      revision: 4,
      error: { code: 'revision-conflict', message: 'retry', retryable: true, currentRevision: 4 },
    };
    const { control, execute, setSnapshot } = fixture();
    execute.mockImplementationOnce(async () => {
      const next = snapshot();
      setSnapshot({ ...next, revision: 4 });
      return conflict;
    }).mockResolvedValueOnce({
      ok: true, status: 'applied', commandId: 'second', revision: 5, eventSequence: 10,
    });
    await control.handle('/v1/daemon/agents/cancel', { target: 'agent-1', requestId: 'request-2' }, source);
    expect(execute).toHaveBeenCalledTimes(2);
    expect((execute.mock.calls[0]![0] as DaemonCommand).idempotencyKey).toBe('cli-request-2-1');
    expect((execute.mock.calls[1]![0] as DaemonCommand)).toMatchObject({
      idempotencyKey: 'cli-request-2-2',
      expectedRevision: 4,
      type: 'agent.cancel',
    });
  });

  it('denies foreign and ambiguous targets before reaching the router', async () => {
    const { control, execute } = fixture();
    await expect(control.handle('/v1/daemon/agents/send', {
      target: 'agent-2', prompt: 'Do not send', requestId: 'request-3',
    }, source)).resolves.toMatchObject({ status: 404, body: { ok: false, error: 'not-found' } });
    await expect(control.handle('/v1/daemon/schedules/run', {
      target: 'schedule-2', requestId: 'request-4',
    }, source)).resolves.toMatchObject({ status: 404, body: { ok: false, error: 'not-found' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lists and triggers only automation owned by the local Project', async () => {
    const { control, execute } = fixture();
    const agents = await control.handle('/v1/daemon/agents', {}, source);
    expect((agents?.body.items as unknown[])).toHaveLength(1);
    const schedules = await control.handle('/v1/daemon/schedules', {}, source);
    expect((schedules?.body.items as unknown[])).toHaveLength(1);

    await control.handle('/v1/daemon/schedules/run', { target: 'Morning', requestId: 'schedule-run' }, source);
    await control.handle('/v1/daemon/heartbeats/trigger', { target: 'Builder', requestId: 'heartbeat-run' }, source);
    expect(execute.mock.calls.map((call) => (call[0] as DaemonCommand).type)).toEqual([
      'schedule.run-now',
      'heartbeat.trigger',
    ]);
  });

  it('reads one Project-scoped Agent and a bounded transcript page', async () => {
    const { control, readTranscript } = fixture();
    await expect(control.handle('/v1/daemon/agents/read', {
      target: 'Builder', afterSequence: 3, limit: 25,
    }, source)).resolves.toMatchObject({
      status: 200,
      body: {
        ok: true,
        session: { id: 'agent-1' },
        agent: { sessionId: 'agent-1' },
        transcript: [{ sequence: 4, text: 'Bounded result' }],
      },
    });
    expect(readTranscript).toHaveBeenCalledWith('agent-1', 3, 25);

    await expect(control.handle('/v1/daemon/agents/read', {
      target: 'agent-1', limit: 501,
    }, source)).resolves.toMatchObject({ status: 400, body: { error: 'invalid-request' } });
    await expect(control.handle('/v1/daemon/agents/read', {
      target: 'agent-2',
    }, source)).resolves.toMatchObject({ status: 404, body: { error: 'not-found' } });
  });

  it('maps direct Agent lifecycle and settings operations to typed commands', async () => {
    const { control, execute } = fixture();
    await control.handle('/v1/daemon/agents/interrupt', { target: 'Builder', requestId: 'interrupt-1' }, source);
    await control.handle('/v1/daemon/agents/cancel', { target: 'Builder', requestId: 'cancel-1' }, source);
    await control.handle('/v1/daemon/agents/archive', { target: 'Builder', requestId: 'archive-1' }, source);
    await control.handle('/v1/daemon/agents/detach', { target: 'Builder', requestId: 'detach-1' }, source);
    await control.handle('/v1/daemon/agents/settings', {
      target: 'Builder', model: 'gpt-5.6', permissionPreset: 'plan', requestId: 'settings-1',
    }, source);
    await control.handle('/v1/daemon/agents/interrupt-and-send', {
      target: 'Builder', prompt: 'Use the latest requirements.', requestId: 'replace-1',
    }, source);

    expect(execute.mock.calls.map((call) => (call[0] as DaemonCommand).type)).toEqual([
      'agent.interrupt',
      'agent.cancel',
      'agent.archive',
      'agent.detach',
      'agent.set-settings',
      'agent.interrupt-and-submit',
    ]);
    expect(execute.mock.calls[4]![0]).toMatchObject({
      payload: { sessionId: 'agent-1', model: 'gpt-5.6', permissionPreset: 'plan' },
    });
    expect(execute.mock.calls[5]![0]).toMatchObject({
      payload: { sessionId: 'agent-1', prompt: 'Use the latest requirements.' },
    });
  });

  it('updates only the capability Project and physically contained Workspace roots', async () => {
    const resolvePhysicalDirectory = vi.fn(async (value: string) => (
      value === 'C:\\one\\linked-outside' ? 'C:\\outside' : value
    ));
    const { control, execute } = fixture(undefined, resolvePhysicalDirectory);

    await control.handle('/v1/daemon/projects/update', {
      target: 'One', name: 'Renamed', requestId: 'project-update',
    }, source);
    await control.handle('/v1/daemon/workspaces/create', {
      workspaceId: 'workspace-new', name: 'Additional', kind: 'local', rootPath: 'C:\\one\\additional',
      sourceWorkspace: 'Main', requestId: 'workspace-create',
    }, source);
    await control.handle('/v1/daemon/workspaces/update', {
      target: 'Main', name: 'Primary', rootPath: 'C:\\one\\primary', requestId: 'workspace-update',
    }, source);

    expect(execute.mock.calls.map((call) => (call[0] as DaemonCommand).type)).toEqual([
      'project.update', 'workspace.create', 'workspace.update',
    ]);
    expect(execute.mock.calls[1]![0]).toMatchObject({
      payload: {
        workspaceId: 'workspace-new', projectId: 'project-1', sourceWorkspaceId: 'workspace-1',
        rootPath: 'C:\\one\\additional',
      },
    });

    await expect(control.handle('/v1/daemon/projects/update', {
      target: 'One', rootPath: 'C:\\one\\nested', requestId: 'project-root-update',
    }, source)).resolves.toMatchObject({
      status: 403,
      body: { code: 'root-verification-required', remediation: { action: 'manage-project-roots' } },
    });
    await expect(control.handle('/v1/daemon/workspaces/create', {
      workspaceId: 'workspace-worktree', name: 'Worktree', kind: 'worktree', rootPath: 'C:\\one\\worktree',
      sourceWorkspace: 'Main', requestId: 'worktree-create',
    }, source)).resolves.toMatchObject({
      status: 403,
      body: { code: 'worktree-service-required', remediation: { action: 'manage-worktrees' } },
    });

    await expect(control.handle('/v1/daemon/workspaces/create', {
      workspaceId: 'workspace-outside', name: 'Outside', kind: 'local', rootPath: 'C:\\one\\linked-outside',
      requestId: 'workspace-outside',
    }, source)).resolves.toMatchObject({ status: 403, body: { error: 'path-outside-project' } });
    await expect(control.handle('/v1/daemon/workspaces/update', {
      target: 'workspace-2', name: 'Foreign', requestId: 'foreign-workspace',
    }, source)).resolves.toMatchObject({ status: 404, body: { error: 'not-found' } });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('fails closed when a root cannot be physically verified', async () => {
    const { control, execute } = fixture(undefined, async (value) => {
      if (value.endsWith('missing')) throw new Error('missing');
      return value;
    });
    await expect(control.handle('/v1/daemon/workspaces/update', {
      target: 'Main', rootPath: 'C:\\one\\missing', requestId: 'missing-root',
    }, source)).resolves.toMatchObject({
      status: 403,
      body: {
        error: 'unauthorized',
        code: 'root-verification-required',
        remediation: { surface: 'desktop', action: 'manage-project-roots' },
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows Worktree naming but delegates Worktree identity changes to Desktop', async () => {
    const { control, execute, setSnapshot } = fixture();
    const current = snapshot();
    setSnapshot({
      ...current,
      workspaces: current.workspaces.map((workspace) => (
        workspace.id === 'workspace-1' ? { ...workspace, kind: 'worktree' as const } : workspace
      )),
    });
    await control.handle('/v1/daemon/workspaces/update', {
      target: 'Main', name: 'Renamed worktree', requestId: 'worktree-name',
    }, source);
    await expect(control.handle('/v1/daemon/workspaces/update', {
      target: 'Main', rootPath: 'C:\\one\\moved', requestId: 'worktree-root',
    }, source)).resolves.toMatchObject({
      status: 403,
      body: { code: 'worktree-service-required', remediation: { action: 'manage-worktrees' } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: 'workspace.update', payload: { workspaceId: 'workspace-1', name: 'Renamed worktree' },
    });
  });

  it('creates, updates, and archives only implemented Project Session metadata', async () => {
    const { control, execute } = fixture();
    await control.handle('/v1/daemon/sessions/create', {
      sessionId: 'session-new', workspace: 'Main', kind: 'terminal', title: 'Scratch', requestId: 'session-create',
    }, source);
    await control.handle('/v1/daemon/sessions/update', {
      target: 'Shell', title: 'Main shell', requestId: 'session-update',
    }, source);
    await control.handle('/v1/daemon/sessions/archive', {
      target: 'Builder', requestId: 'session-archive',
    }, source);
    await expect(control.handle('/v1/daemon/sessions/create', {
      sessionId: 'browser-new', workspace: 'Main', kind: 'browser', title: 'Browser', requestId: 'browser-create',
    }, source)).resolves.toMatchObject({ status: 409, body: { error: 'unsupported-session-kind' } });

    expect(execute.mock.calls.map((call) => (call[0] as DaemonCommand).type)).toEqual([
      'session.create', 'session.update', 'session.archive',
    ]);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      payload: { sessionId: 'session-new', workspaceId: 'workspace-1', kind: 'terminal', title: 'Scratch' },
    });
  });

  it('creates Agents and resumes only a stopped Provider Session already owned by this Project', async () => {
    const { control, execute, setSnapshot } = fixture();
    const current = snapshot();
    const revisioned = current.sessions[0]!;
    const dormantSession: DaemonSnapshot['sessions'][number] = {
      revision: revisioned.revision,
      createdAt: revisioned.createdAt,
      updatedAt: revisioned.updatedAt,
      id: 'agent-old', projectId: 'project-1', workspaceId: 'workspace-1', kind: 'agent',
      title: 'Dormant', state: 'completed', source: 'structured',
    };
    const dormantAgent: DaemonSnapshot['agents'][number] = {
      revision: revisioned.revision,
      createdAt: revisioned.createdAt,
      updatedAt: revisioned.updatedAt,
      sessionId: 'agent-old', providerId: 'codex', providerSessionId: 'provider-owned-handle',
      model: 'gpt-5.6', permissionPreset: 'plan', state: 'done', queuedTurnCount: 0,
      orchestrationEnabled: true,
    };
    setSnapshot({
      ...current,
      sessions: [...current.sessions, dormantSession],
      agents: [...current.agents, dormantAgent],
    });

    await control.handle('/v1/daemon/agents/create', {
      sessionId: 'agent-new', workspace: 'Main', title: 'Research', providerId: 'codex',
      permissionPreset: 'standard', prompt: 'Investigate.', parent: 'Builder', requestId: 'agent-create',
    }, source);
    await control.handle('/v1/daemon/agents/resume', {
      target: 'Dormant', sessionId: 'agent-resumed', title: 'Research resumed', parent: 'Builder',
      requestId: 'agent-resume',
    }, source);

    expect(execute.mock.calls.map((call) => (call[0] as DaemonCommand).type)).toEqual([
      'agent.create', 'agent.resume',
    ]);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      payload: { workspaceId: 'workspace-1', providerId: 'codex', parentSessionId: 'agent-1' },
    });
    expect(execute.mock.calls[1]![0]).toMatchObject({
      payload: {
        sessionId: 'agent-resumed', providerId: 'codex', providerSessionId: 'provider-owned-handle',
        model: 'gpt-5.6', permissionPreset: 'plan', parentSessionId: 'agent-1',
      },
    });

    await expect(control.handle('/v1/daemon/agents/resume', {
      target: 'agent-2', sessionId: 'foreign-resume', requestId: 'foreign-resume',
    }, source)).resolves.toMatchObject({ status: 404, body: { error: 'not-found' } });
    await expect(control.handle('/v1/daemon/agents/resume', {
      target: 'Builder', sessionId: 'active-resume', requestId: 'active-resume',
    }, source)).resolves.toMatchObject({ status: 409, body: { error: 'invalid-state' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps Project creation and Provider review desktop-only while allowing Provider disable', async () => {
    const { control, execute } = fixture();
    for (const route of [
      '/v1/daemon/projects/create',
      '/v1/daemon/providers/enable',
      '/v1/daemon/providers/update',
    ]) {
      await expect(control.handle(route, { untrusted: 'descriptor' }, source)).resolves.toMatchObject({
        status: 403,
        body: { error: 'unauthorized', remediation: { surface: 'desktop' } },
      });
    }
    await expect(control.handle('/v1/daemon/providers/disable', {
      target: 'codex', requestId: 'provider-disable',
    }, source)).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: 'provider.disable', payload: { providerId: 'codex' },
    });
  });

  it('requires stable ids when Project-local names are ambiguous', async () => {
    const { control, execute, setSnapshot } = fixture();
    const current = snapshot();
    const base = current.workspaces[0]!;
    const session = current.sessions[1]!;
    setSnapshot({
      ...current,
      workspaces: [...current.workspaces, { ...base, id: 'workspace-duplicate', name: 'Main' }],
      sessions: [...current.sessions, { ...session, id: 'agent-duplicate', title: 'Builder' }],
      agents: [...current.agents, { ...current.agents[0]!, sessionId: 'agent-duplicate' }],
    });

    await expect(control.handle('/v1/daemon/sessions/create', {
      sessionId: 'ambiguous-workspace', workspace: 'Main', kind: 'diff', title: 'Diff', requestId: 'ambiguous-ws',
    }, source)).resolves.toMatchObject({ status: 409, body: { error: 'ambiguous-target' } });
    await expect(control.handle('/v1/daemon/agents/send', {
      target: 'Builder', prompt: 'No', requestId: 'ambiguous-session',
    }, source)).resolves.toMatchObject({ status: 409, body: { error: 'ambiguous-target' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('creates, updates, runs, and deletes Project-scoped schedules', async () => {
    const { control, execute } = fixture();
    await expect(control.handle('/v1/daemon/schedules/create', {
      scheduleId: 'schedule-new',
      name: 'Evening review',
      workspace: 'Main',
      providerId: 'codex',
      model: 'gpt-5.6',
      permissionPreset: 'standard',
      prompt: 'Review today changes',
      cron: '0 18 * * *',
      timezone: 'Asia/Seoul',
      maxRuns: 10,
      enabled: true,
      requestId: 'schedule-create',
    }, source)).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await control.handle('/v1/daemon/schedules/update', {
      target: 'Morning', enabled: false, cron: '30 9 * * *', requestId: 'schedule-update',
    }, source);
    await control.handle('/v1/daemon/schedules/run', {
      target: 'Morning', requestId: 'schedule-run',
    }, source);
    await control.handle('/v1/daemon/schedules/delete', {
      target: 'Morning', requestId: 'schedule-delete',
    }, source);

    expect(execute.mock.calls.map((call) => (call[0] as DaemonCommand).type)).toEqual([
      'schedule.create', 'schedule.update', 'schedule.run-now', 'schedule.delete',
    ]);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      payload: { scheduleId: 'schedule-new', workspaceId: 'workspace-1', providerId: 'codex' },
    });
    expect(execute.mock.calls[1]![0]).toMatchObject({
      payload: { scheduleId: 'schedule-1', enabled: false, cron: '30 9 * * *' },
    });
  });

  it('configures heartbeats and rejects malformed or expansive payloads', async () => {
    const { control, execute } = fixture();
    await expect(control.handle('/v1/daemon/heartbeats/configure', {
      target: 'Builder',
      prompt: 'Report blockers',
      cron: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
      requestId: 'heartbeat-configure',
    }, source)).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: 'heartbeat.configure',
      payload: { sessionId: 'agent-1', prompt: 'Report blockers', enabled: true },
    });

    await expect(control.handle('/v1/daemon/agents/settings', {
      target: 'Builder', requestId: 'empty-settings',
    }, source)).resolves.toMatchObject({ status: 400, body: { error: 'invalid-request' } });
    await expect(control.handle('/v1/daemon/schedules/update', {
      target: 'Morning', providerId: 'claude', requestId: 'unsupported-update',
    }, source)).resolves.toMatchObject({ status: 400, body: { error: 'invalid-request' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the bearer Session and claimed Project diverge', async () => {
    const { control, execute } = fixture();
    await expect(control.handle('/v1/daemon/status', {}, {
      sessionId: 'terminal-1', projectId: 'project-2',
    })).resolves.toMatchObject({ status: 403, body: { ok: false, error: 'unauthorized' } });
    expect(execute).not.toHaveBeenCalled();
  });
});
