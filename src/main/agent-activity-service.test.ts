import { describe, expect, it, vi } from 'vitest';

import { AGENT_SETTINGS_SCHEMA_VERSION, type AgentHookEvent, type AgentSettings } from '../shared/agent';
import type { InterpreterFrame, RunStartedInfo, SessionInfo } from '../shared/ipc';
import {
  AgentActivityService,
  classifyAgentCommand,
  type AgentActivityBroker,
} from './agent-activity-service';
import { APPROVAL_GATE_WINDOW_MS } from './agent-hook-relay';
import type { RemotePort } from './interpreter-broker';

const settings: AgentSettings = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  notifications: { waiting: true, blocked: true, error: true },
  genericProfiles: [{ id: 'aider', name: 'Aider', executable: 'aider.cmd', enabled: true }],
  approvalGate: true,
};

class FakePort implements RemotePort {
  readonly posted: unknown[] = [];
  started = false;
  closed = false;
  private readonly messageListeners = new Set<(event: { data: unknown }) => void>();
  private readonly closeListeners = new Set<() => void>();

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('closed');
    this.posted.push(message);
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageListeners.add(listener as (event: { data: unknown }) => void);
    else this.closeListeners.add(listener as () => void);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  frame(frame: InterpreterFrame): void {
    for (const listener of this.messageListeners) listener({ data: frame });
  }
}

class FakeBroker implements AgentActivityBroker {
  readonly ports: FakePort[] = [];
  sessions: SessionInfo[] = [{ sessionId: 'ez-1', cwd: 'C:\\work' }];
  runs: RunStartedInfo[] = [];
  private readonly runListeners = new Set<(info: RunStartedInfo) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();

  attachRun(): RemotePort {
    const port = new FakePort();
    this.ports.push(port);
    return port;
  }
  listRuns(): Promise<readonly RunStartedInfo[]> {
    return Promise.resolve(this.runs);
  }
  listSessions(): readonly SessionInfo[] {
    return this.sessions;
  }
  onRunStarted(listener: (info: RunStartedInfo) => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }
  onInterpreterExited(listener: (code?: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  run(info: RunStartedInfo): FakePort {
    for (const listener of this.runListeners) listener(info);
    return this.ports[this.ports.length - 1];
  }
  exit(code = 1): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

function hook(partial: Partial<AgentHookEvent> = {}): AgentHookEvent {
  return {
    provider: 'codex',
    ezSessionId: 'ez-1',
    providerSessionId: 'codex-session',
    cwd: 'C:\\work',
    event: 'UserPromptSubmit',
    ...partial,
  };
}

function makeService(): { service: AgentActivityService; broker: FakeBroker } {
  const broker = new FakeBroker();
  let id = 0;
  let approvalId = 0;
  let now = 100;
  return {
    broker,
    service: new AgentActivityService({
      broker,
      getSettings: () => settings,
      newId: () => `activity-${++id}`,
      newApprovalId: () => `approval-${++approvalId}`,
      now: () => ++now,
    }),
  };
}

describe('classifyAgentCommand', () => {
  it('recognizes direct provider and generic executables only', () => {
    expect(classifyAgentCommand('!codex --full-auto', settings)).toBe('codex');
    expect(classifyAgentCommand('"C:\\Tools\\claude.cmd" --resume', settings)).toBe('claude');
    expect(classifyAgentCommand('aider --model x', settings)).toBe('generic');
    expect(classifyAgentCommand('cmd /c codex', settings)).toBeNull();
    expect(classifyAgentCommand('codex | tee log.txt', settings)).toBeNull();
    expect(classifyAgentCommand('ssh host codex', settings)).toBeNull();
  });
});

describe('AgentActivityService', () => {
  it('maps exact hook lifecycle, updates cwd, and sends one waiting followup line', () => {
    const { service, broker } = makeService();
    const port = broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: '!codex' });
    expect(port.started).toBe(true);
    expect(service.getSnapshot().items[0]).toMatchObject({ provider: 'codex', status: 'working', cwd: 'C:\\work' });

    port.frame({ type: 'start', commandText: '!codex', cwd: 'C:\\repo' });
    service.handleHookEvent(hook({ event: 'SessionStart', cwd: 'C:\\repo' }));
    expect(service.getSnapshot().items[0].status).toBe('starting');
    service.handleHookEvent(hook({ event: 'UserPromptSubmit', cwd: 'C:\\repo' }));
    expect(service.getSnapshot().items[0].status).toBe('working');
    service.handleHookEvent(hook({ event: 'PermissionRequest', toolName: 'Bash', cwd: 'C:\\repo' }));
    expect(service.getSnapshot().items[0].status).toBe('blocked');
    service.handleHookEvent(hook({ event: 'Stop', cwd: 'C:\\repo' }));
    const activity = service.getSnapshot().items[0];
    expect(activity.status).toBe('waiting');
    expect(activity).not.toHaveProperty('runId');
    expect(activity).not.toHaveProperty('providerSessionId');

    expect(service.sendFollowup(activity.id, '  continue  ')).toEqual({ ok: true });
    expect(port.posted).toContainEqual({ type: 'pty-input', data: 'continue\r' });
    expect(service.getSnapshot().items[0].status).toBe('working');
    expect(service.sendFollowup(activity.id, 'bad\nline')).toEqual({ ok: false, error: 'not-waiting' });

    port.frame({ type: 'end', cwd: 'C:\\repo' });
    expect(service.getSnapshot().items[0].status).toBe('done');
    expect(service.sendFollowup(activity.id, 'again')).toEqual({ ok: false, error: 'session-ended' });
  });

  it('ignores an uncorrelated hook, then maps Claude notifications onto a recognized direct run', () => {
    const { service, broker } = makeService();
    service.handleHookEvent(
      hook({ provider: 'claude', providerSessionId: 'claude-session', event: 'Notification', notificationType: 'permission_prompt' }),
    );
    broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'claude' });
    expect(service.getSnapshot().items[0]).toMatchObject({ provider: 'claude', status: 'working' });
    service.handleHookEvent(
      hook({ provider: 'claude', providerSessionId: 'claude-session', event: 'Notification', notificationType: 'permission_prompt' }),
    );
    expect(service.getSnapshot().items[0]).toMatchObject({ provider: 'claude', status: 'blocked' });
    service.handleHookEvent(
      hook({ provider: 'claude', providerSessionId: 'claude-session', event: 'Notification', notificationType: 'idle_prompt' }),
    );
    expect(service.getSnapshot().items[0].status).toBe('waiting');
  });

  it('ignores Claude background-agent notifications for the foreground terminal activity', () => {
    const { service, broker } = makeService();
    broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'claude' });
    for (const notificationType of ['agent_needs_input', 'agent_completed']) {
      service.handleHookEvent(
        hook({
          provider: 'claude',
          providerSessionId: 'claude-session',
          event: 'Notification',
          notificationType,
        }),
      );
    }
    const activity = service.getSnapshot().items[0];
    expect(activity.status).toBe('working');
    expect(service.sendFollowup(activity.id, 'wrong target')).toEqual({ ok: false, error: 'not-waiting' });
  });

  it('never promotes an unrecognized wrapper from a session-only provider hook', () => {
    const { service, broker } = makeService();
    broker.run({ sessionId: 'ez-1', runId: 'wrapped-1', commandText: 'my-codex-wrapper --resume' });
    expect(service.getSnapshot().items).toEqual([]);
    service.handleHookEvent(hook({ event: 'SessionStart' }));
    expect(service.getSnapshot().items).toEqual([]);
    expect(broker.ports).toHaveLength(0);
  });

  it('does not promote a wrapper when its hook beats run-started', () => {
    const { service, broker } = makeService();
    service.handleHookEvent(hook({ event: 'SessionStart' }));
    broker.run({ sessionId: 'ez-1', runId: 'wrapped-1', commandText: 'my-codex-wrapper --resume' });
    expect(service.getSnapshot().items).toEqual([]);
    expect(broker.ports).toHaveLength(0);
  });

  it('marks live agents error on interpreter exit and bounds ended activity history', () => {
    const { service, broker } = makeService();
    broker.run({ sessionId: 'ez-1', runId: 'live', commandText: 'codex' });
    broker.exit();
    expect(service.getSnapshot().items[0].status).toBe('error');

    for (let i = 0; i < 101; i += 1) {
      const port = broker.run({ sessionId: 'ez-1', runId: `generic-${i}`, commandText: 'aider' });
      port.frame({ type: 'end' });
    }
    const snapshot = service.getSnapshot();
    expect(snapshot.items).toHaveLength(100);
    expect(snapshot.items.every((item) => item.status === 'done')).toBe(true);
  });

  it('maps a nonzero PTY process exit to error while preserving legacy end as done', () => {
    const { service, broker } = makeService();
    broker.run({ sessionId: 'ez-1', runId: 'failed', commandText: 'aider' }).frame({ type: 'end', exitCode: 3 });
    broker.run({ sessionId: 'ez-1', runId: 'legacy', commandText: 'codex' }).frame({ type: 'end' });
    expect(service.getSnapshot().items.map((item) => item.status).sort()).toEqual(['done', 'error']);
  });

  it('rejects multiline input while waiting and never writes directly to blocked approvals', () => {
    const { service, broker } = makeService();
    const port = broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'codex' });
    service.handleHookEvent(hook({ event: 'Stop' }));
    const id = service.getSnapshot().items[0].id;
    expect(service.sendFollowup(id, 'one\ntwo')).toEqual({ ok: false, error: 'invalid-text' });
    service.handleHookEvent(hook({ event: 'PermissionRequest' }));
    expect(service.sendFollowup(id, 'approve')).toEqual({ ok: false, error: 'not-waiting' });
    expect(port.posted).toEqual([]);
  });

  it('degrades to hook-only tracking when the interpreter mirror cap is full', () => {
    const { service, broker } = makeService();
    const port = broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'codex' });
    port.frame({ type: 'error', message: 'too many mirror viewers for this run' });
    port.close();
    service.handleHookEvent(hook({ event: 'Stop' }));
    const activity = service.getSnapshot().items[0];
    expect(activity.status).toBe('waiting');
    expect(service.sendFollowup(activity.id, 'continue')).toEqual({ ok: false, error: 'delivery-failed' });
  });
});

describe('AgentActivityService — approval gate', () => {
  const claudeHook = (partial: Partial<AgentHookEvent> = {}): AgentHookEvent =>
    hook({ provider: 'claude', providerSessionId: 'claude-session', ...partial });

  function blockedClaude(): { service: AgentActivityService; activityId: string } {
    const { service, broker } = makeService();
    broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'claude' });
    service.handleHookEvent(claudeHook({ event: 'SessionStart' }));
    return { service, activityId: service.getSnapshot().items[0].id };
  }

  function liveApprovalId(service: AgentActivityService): string {
    const approvalId = service.getSnapshot().items[0]?.approval?.approvalId;
    if (!approvalId) throw new Error('expected a live approval');
    return approvalId;
  }

  it('publishes the pending call, then allows it', async () => {
    const { service, activityId } = blockedClaude();
    const event = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'rm -rf out' });
    service.handleHookEvent(event);
    const pending = service.requestApproval(event);

    const blocked = service.getSnapshot().items[0];
    expect(blocked.status).toBe('blocked');
    expect(blocked.approval).toMatchObject({
      approvalId: 'approval-1',
      toolName: 'Bash',
      command: 'rm -rf out',
      risk: 'danger',
    });

    expect(service.decideApproval(activityId, liveApprovalId(service), 'allow')).toEqual({ ok: true });
    await expect(pending).resolves.toBe('allow');
    const after = service.getSnapshot().items[0];
    expect(after.status).toBe('working');
    // The command is what the promise said it would not keep.
    expect(after.approval).toBeUndefined();
  });

  it('lets a synchronous snapshot observer answer the exact published hook', async () => {
    const { service, activityId } = blockedClaude();
    const event = claudeHook({
      event: 'PermissionRequest',
      toolName: 'Bash',
      command: 'pnpm test',
    });
    service.handleHookEvent(event);
    let result: ReturnType<AgentActivityService['decideApproval']> | undefined;
    const unsubscribeDecision = service.onSnapshot((snapshot) => {
      const approval = snapshot.items[0]?.approval;
      if (approval) {
        result = service.decideApproval(activityId, approval.approvalId, 'allow');
      }
    });
    const unsubscribeThrowing = service.onSnapshot(() => {
      throw new Error('stale renderer');
    });
    const revisions: number[] = [];
    const unsubscribeRevision = service.onSnapshot((snapshot) => {
      revisions.push(snapshot.revision);
    });

    const pending = service.requestApproval(event);

    expect(result).toEqual({ ok: true });
    await expect(pending).resolves.toBe('allow');
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toBeGreaterThan(revisions[0]!);
    unsubscribeDecision();
    unsubscribeThrowing();
    unsubscribeRevision();
  });

  it('carries a denial back to the provider', async () => {
    const { service, activityId } = blockedClaude();
    const event = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'ls' });
    service.handleHookEvent(event);
    const pending = service.requestApproval(event);
    expect(service.decideApproval(activityId, liveApprovalId(service), 'deny')).toEqual({ ok: true });
    await expect(pending).resolves.toBe('deny');
  });

  it('retains a bounded decision receipt so an identical retry is idempotent', async () => {
    const { service, activityId } = blockedClaude();
    const event = claudeHook({
      event: 'PermissionRequest',
      toolName: 'Bash',
      command: 'pnpm build',
    });
    service.handleHookEvent(event);
    const pending = service.requestApproval(event);
    const approvalId = liveApprovalId(service);

    expect(service.decideApproval(activityId, approvalId, 'allow')).toEqual({ ok: true });
    await expect(pending).resolves.toBe('allow');
    expect(service.decideApproval(activityId, approvalId, 'allow')).toEqual({ ok: true });
    expect(service.decideApproval(activityId, approvalId, 'deny')).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(service.decideApproval('another-activity', approvalId, 'allow')).toEqual({
      ok: false,
      error: 'conflict',
    });
  });

  it('rejects a delayed decision after a newer request supersedes it', async () => {
    const { service, activityId } = blockedClaude();
    const firstEvent = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'git clean -fd' });
    service.handleHookEvent(firstEvent);
    const firstPending = service.requestApproval(firstEvent);
    const firstId = liveApprovalId(service);

    const secondEvent = claudeHook({ event: 'PermissionRequest', toolName: 'Read', command: 'README.md' });
    service.handleHookEvent(secondEvent);
    const secondPending = service.requestApproval(secondEvent);
    const secondId = liveApprovalId(service);

    expect(secondId).not.toBe(firstId);
    await expect(firstPending).resolves.toBeNull();
    expect(service.decideApproval(activityId, firstId, 'allow')).toEqual({
      ok: false,
      error: 'stale',
    });
    expect(service.getSnapshot().items[0].approval).toMatchObject({
      approvalId: secondId,
      command: 'README.md',
    });

    expect(service.decideApproval(activityId, secondId, 'deny')).toEqual({ ok: true });
    await expect(secondPending).resolves.toBe('deny');
  });

  it('fails open when the window closes, and drops the command text', async () => {
    vi.useFakeTimers();
    try {
      const { service, activityId } = blockedClaude();
      const event = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'pnpm build' });
      service.handleHookEvent(event);
      const pending = service.requestApproval(event);

      vi.advanceTimersByTime(APPROVAL_GATE_WINDOW_MS + 1);
      await expect(pending).resolves.toBeNull();

      const expired = service.getSnapshot().items[0];
      expect(expired.status).toBe('blocked');
      expect(expired.approval).toBeDefined();
      expect(expired.approval).not.toHaveProperty('command');
      expect(service.decideApproval(activityId, liveApprovalId(service), 'allow')).toEqual({
        ok: false,
        error: 'expired',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails open for a provider whose decision grammar is unverified', async () => {
    const { service, broker } = makeService();
    broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'codex' });
    // Same shape, `codex` instead of `claude`. The run is tracked and blocked,
    // but nothing we can check documents what codex reads back from a hook, so
    // the gate declines to answer rather than guessing.
    const event = hook({ event: 'PermissionRequest', toolName: 'Bash', command: 'rm -rf out' });
    service.handleHookEvent(event);
    expect(service.getSnapshot().items[0].status).toBe('blocked');
    await expect(service.requestApproval(event)).resolves.toBeNull();
    expect(service.getSnapshot().items[0].approval).toBeUndefined();
  });

  it('fails open when the gate is switched off', async () => {
    const broker = new FakeBroker();
    let gate = false;
    const service = new AgentActivityService({
      broker,
      getSettings: () => ({ ...settings, approvalGate: gate }),
      newId: () => 'activity-1',
      newApprovalId: () => 'approval-1',
    });
    broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'claude' });
    const event = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'ls' });
    service.handleHookEvent(event);
    await expect(service.requestApproval(event)).resolves.toBeNull();
    expect(service.getSnapshot().items[0].approval).toBeUndefined();

    gate = true;
    const pending = service.requestApproval(event);
    expect(service.getSnapshot().items[0].approval).toBeDefined();
    service.decideApproval('activity-1', 'approval-1', 'allow');
    await expect(pending).resolves.toBe('allow');
  });

  it('immediately releases every parked hook when the live gate is disabled', async () => {
    const broker = new FakeBroker();
    let current = settings;
    let approvalId = 0;
    const service = new AgentActivityService({
      broker,
      getSettings: () => current,
      newId: () => 'activity-1',
      newApprovalId: () => `approval-${++approvalId}`,
    });
    broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'claude' });
    const firstEvent = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'secret one' });
    const secondEvent = claudeHook({ event: 'PermissionRequest', toolName: 'Write', command: 'secret two' });
    service.handleHookEvent(firstEvent);
    const firstPending = service.requestApproval(firstEvent);
    // The service supports one current request per activity; make a second
    // activity so disabling exercises the full pending set.
    broker.sessions.push({ sessionId: 'ez-2', cwd: 'C:\\other' });
    broker.run({ sessionId: 'ez-2', runId: 'run-2', commandText: 'claude' });
    const secondActivityEvent = { ...secondEvent, ezSessionId: 'ez-2', providerSessionId: 'claude-session-2' };
    service.handleHookEvent(secondActivityEvent);
    const secondPending = service.requestApproval(secondActivityEvent);

    current = { ...settings, approvalGate: false };
    service.applySettings(current);

    await expect(firstPending).resolves.toBeNull();
    await expect(secondPending).resolves.toBeNull();
    expect(service.getSnapshot().items.every((item) => item.approval === undefined)).toBe(true);
  });

  it('releases a parked hook when the run ends underneath it', async () => {
    const broker = new FakeBroker();
    const service = new AgentActivityService({
      broker,
      getSettings: () => settings,
      newId: () => 'activity-1',
    });
    const port = broker.run({ sessionId: 'ez-1', runId: 'run-1', commandText: 'claude' });
    const event = claudeHook({ event: 'PermissionRequest', toolName: 'Bash', command: 'ls' });
    service.handleHookEvent(event);
    const pending = service.requestApproval(event);
    port.frame({ type: 'end', exitCode: 0 });
    await expect(pending).resolves.toBeNull();
    expect(service.getSnapshot().items[0].approval).toBeUndefined();
  });

  it('rejects a decision for an activity that never asked', () => {
    const { service, activityId } = blockedClaude();
    expect(service.decideApproval(activityId, 'missing', 'allow')).toEqual({
      ok: false,
      error: 'not-pending',
    });
    expect(service.decideApproval('nope', 'missing', 'allow')).toEqual({
      ok: false,
      error: 'not-found',
    });
  });
});
