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
      { ...revisioned, id: 'project-1', name: 'One', source: 'native' },
      { ...revisioned, id: 'project-2', name: 'Two', source: 'native' },
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
      { ...revisioned, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' },
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

function fixture(receipts?: DaemonCommandReceipt[]) {
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
  }, () => new Date('2026-09-04T01:00:00.000Z'));
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
