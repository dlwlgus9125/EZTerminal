import { describe, expect, it } from 'vitest';

import { AGENT_SETTINGS_SCHEMA_VERSION, type AgentHookEvent, type AgentSettings } from '../shared/agent';
import type { InterpreterFrame, RunStartedInfo, SessionInfo } from '../shared/ipc';
import {
  AgentActivityService,
  classifyAgentCommand,
  type AgentActivityBroker,
} from './agent-activity-service';
import type { RemotePort } from './interpreter-broker';

const settings: AgentSettings = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  notifications: { waiting: true, blocked: true, error: true },
  genericProfiles: [{ id: 'aider', name: 'Aider', executable: 'aider.cmd', enabled: true }],
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
  let now = 100;
  return {
    broker,
    service: new AgentActivityService({
      broker,
      getSettings: () => settings,
      newId: () => `activity-${++id}`,
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
