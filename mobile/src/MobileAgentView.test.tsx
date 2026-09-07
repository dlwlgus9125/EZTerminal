// Real React root + native DOM events, same harness as the other mobile
// component tests in this package (no @testing-library/react here).
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentActivitySnapshot, AgentState } from '../../src/shared/agent';
import type { AgentCoordinationSnapshot, ManagedMergeRequest } from '../../src/shared/agent-coordination';
import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import type { GitDiffResult } from '../../src/shared/git-status';
import type {
  DaemonEvent,
  DaemonSnapshot,
  DaemonTranscriptItem,
} from '../../src/shared/daemon-protocol';
import { createDaemonCommand } from '../../src/shared/daemon-protocol';
import { AppI18nProvider } from '../../src/renderer/i18n';
import { MobileAgentView, type UncertainAgentCreate } from './MobileAgentView';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import {
  mobileAgentCreateRecoveryFromCommand,
  type MobileAgentCreateRecoveryController,
} from './mobile-agent-create-recovery-store';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

function activity(id: string, state: AgentState, overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id,
    sessionId: `session-${id}`,
    provider: 'claude',
    cwd: `C:/Workspace/${id}`,
    state,
    status: state,
    stateSeq: 1,
    live: true,
    interactiveReady: false,
    stateSource: 'provider-hook',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

function snapshotOf(...items: readonly AgentActivity[]): AgentActivitySnapshot {
  return { revision: 1, items };
}

const DAEMON_TIMESTAMP = '2026-09-04T09:30:00.000Z';

function daemonSnapshotOf(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision: 8,
    eventSequence: 12,
    generatedAt: DAEMON_TIMESTAMP,
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{
      id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }],
    workspaces: [{
      id: 'workspace-1', projectId: 'project-1', name: 'Main checkout', kind: 'local',
      rootPath: 'C:\\Working\\EZTerminal', revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }],
    sessions: [{
      id: 'structured-session-1', projectId: 'project-1', workspaceId: 'workspace-1',
      kind: 'agent', title: 'Structured mobile task', state: 'idle', source: 'structured',
      revision: 1, createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }],
    agents: [{
      sessionId: 'structured-session-1', providerId: 'codex', providerSessionId: 'provider-parent',
      model: 'gpt-5', permissionPreset: 'standard', state: 'idle', queuedTurnCount: 0,
      orchestrationEnabled: true, revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [{
      id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex',
      executableVersion: '1.0.0', argv: [], environmentVariableNames: [], capabilities: ['model:gpt-5'],
      enabled: true, health: 'ready', revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }, {
      id: 'claude', displayName: 'Claude Code', protocol: 'claude-agent-sdk', executablePath: 'claude',
      executableVersion: '1.0.0', argv: [], environmentVariableNames: [], capabilities: [],
      enabled: true, health: 'ready', revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
}

function clickButtonText(rootElement: ParentNode, text: string): void {
  const button = Array.from(rootElement.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => (
    candidate.textContent?.includes(text)
  ));
  if (!button) throw new Error(`Missing button: ${text}`);
  act(() => button.click());
}

function orchestrationWithWorker(activityId: string): AgentOrchestrationSnapshot {
  return {
    revision: 1,
    providers: [],
    profiles: [],
    policies: [],
    events: [],
    migration: { required: false, catalogItemCount: 0, runCount: 0 },
    runs: [{
      schemaVersion: AGENT_ORCHESTRATION_SCHEMA_VERSION,
      runId: 'run-1', revision: 1, projectId: 'project-1',
      leadSessionId: 'session-lead', leadActivityId: 'lead', policyRevision: 1,
      state: 'active', createdAt: 1, updatedAt: 1, expiresAt: 60_001,
      tasks: [{
        taskId: 'task-1', revision: 1, title: 'Hidden worker', brief: 'Do bounded work.',
        mode: 'read-only', dependsOn: [], writeScopes: [], profileId: 'builtin:codex:read',
        state: 'working', createdAt: 1, updatedAt: 1,
        worker: {
          workerId: 'worker-1', taskId: 'task-1', profileId: 'builtin:codex:read',
          providerId: 'codex', sessionId: 'session-worker', activityId,
        },
      }],
    }],
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: JSX.Element, locale: 'en' | 'ko' = 'en'): void {
  act(() => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNavigationHistoryProvider>
        {node}
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>,
  ));
}

function testIds(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
}

function changeSelect(testId: string, value: string): void {
  const select = testIds(testId)[0] as HTMLSelectElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}



async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function readyRecoveryController(
  overrides: Partial<MobileAgentCreateRecoveryController> = {},
): MobileAgentCreateRecoveryController {
  return {
    status: 'ready',
    recovery: null,
    prepare: async () => true,
    clear: async () => true,
    reload: async () => true,
    discard: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('MobileAgentView', () => {
  const noop = {
    onBack: () => undefined,
    onFocusSession: () => undefined,
    onSendFollowup: async () => ({ ok: true }) as const,
    agentCreateRecovery: readyRecoveryController(),
  };

  it('keeps orchestration workers out of cards, counts, and direct composers', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('lead', 'idle', { interactiveReady: true }),
          activity('worker', 'idle', { interactiveReady: true }),
        )}
        orchestrationSnapshot={orchestrationWithWorker('worker')}
        {...noop}
      />,
    );

    expect(testIds('agent-filter-all')[0]?.textContent).toContain('1');
    expect(testIds('agent-card')).toHaveLength(1);
    expect(testIds('agent-followup-input')).toHaveLength(1);
    expect(container.textContent).not.toContain('C:/Workspace/worker');
  });

  it('buckets every agent status into the four filters with counts', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('a', 'blocked'),
          activity('b', 'done'),
          activity('c', 'error'),
          activity('d', 'working'),
          activity('e', 'starting'),
          activity('f', 'idle'),
        )}
        {...noop}
      />,
    );

    expect(testIds('agent-filter-all')[0]?.textContent).toContain('6');
    expect(testIds('agent-filter-attention')[0]?.textContent).toContain('3');
    expect(testIds('agent-filter-running')[0]?.textContent).toContain('2');
    expect(testIds('agent-filter-done')[0]?.textContent).toContain('1');
    expect(testIds('agent-card')).toHaveLength(6);
    expect(testIds('agent-attention-summary')[0]?.textContent).toContain('3');
  });

  it('narrows the list to the selected bucket and back', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'blocked'), activity('b', 'working'), activity('c', 'done'))}
        {...noop}
      />,
    );
    expect(testIds('agent-card')).toHaveLength(3);

    act(() => testIds('agent-filter-running')[0]!.click());
    const running = testIds('agent-card');
    expect(running).toHaveLength(1);
    expect(running[0]?.getAttribute('data-status')).toBe('working');

    act(() => testIds('agent-filter-all')[0]!.click());
    expect(testIds('agent-card')).toHaveLength(3);
  });

  it('orders attention ahead of running and history, blocked first within attention', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('idle', 'idle'),
          activity('done', 'done'),
          activity('working', 'working'),
          activity('blocked', 'blocked'),
        )}
        {...noop}
      />,
    );
    expect(testIds('agent-card').map((card) => card.getAttribute('data-status')))
      .toEqual(['blocked', 'done', 'working', 'idle']);
  });

  it('places the daemon project navigator between attention and active history', async () => {
    const transport = {
      supportsAgentProjectManagement: true,
      supportsAgentDirectLaunch: true,
      listAgentProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
    } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('idle', 'idle'),
          activity('done', 'done'),
          activity('working', 'working'),
          activity('blocked', 'blocked'),
        )}
        {...noop}
        transport={transport}
        onResumeHistory={async () => undefined}
        onLaunchAgent={async () => undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const order = Array.from(container.querySelector('.mob-column')!.children).map((element) => (
      element.getAttribute('data-testid') === 'mobile-daemon-navigator'
        ? 'projects'
        : element.getAttribute('data-status')
    ));
    expect(order).toEqual(['blocked', 'done', 'projects', 'working', 'idle']);
  });

  it('keeps the navigator session id stable and opens a direct structured Agent composer', async () => {
    const daemonSnapshot = daemonSnapshotOf();
    const sendDaemonCommand = vi.fn(async (command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0]) => ({
      ok: true as const,
      status: 'queued' as const,
      commandId: command.commandId,
      revision: 9,
      eventSequence: 13,
    }));
    const transport = { sendDaemonCommand } as unknown as WsEzTerminalTransport;
    const onFocusSession = vi.fn();
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: daemonSnapshot }}
        transport={transport}
        {...noop}
        onFocusSession={onFocusSession}
      />,
    );

    clickButtonText(container, 'EZTerminal');
    clickButtonText(container, 'Main checkout');
    clickButtonText(container, 'Structured mobile task');
    expect(onFocusSession).toHaveBeenCalledWith('structured-session-1');
    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);

    const input = testIds('structured-agent-composer-input')[0] as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'Continue directly');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      testIds('structured-agent-send')[0]!.click();
      await Promise.resolve();
    });
    expect(sendDaemonCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent.submit',
      expectedRevision: 8,
      principal: { kind: 'android', id: 'mobile-agent-ui' },
      payload: { sessionId: 'structured-session-1', prompt: 'Continue directly' },
    }));
  });

  it('creates a structured Agent from global New session only on the first Send', async () => {
    const freshSnapshot = daemonSnapshotOf({ revision: 21 });
    const getDaemonSnapshot = vi.fn(async () => freshSnapshot);
    const sendDaemonCommand = vi.fn(async (
      command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0],
    ) => ({
      ok: true as const,
      status: 'queued' as const,
      commandId: command.commandId,
      revision: 22,
      eventSequence: 14,
    }));
    const onCreateWorkspaceTerminal = vi.fn(async () => ({ ok: true as const }));
    const prepare = vi.fn(async () => true);
    const clear = vi.fn(async () => true);
    const transport = { getDaemonSnapshot, sendDaemonCommand } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: daemonSnapshotOf() }}
        transport={transport}
        onCreateWorkspaceTerminal={onCreateWorkspaceTerminal}
        {...noop}
        agentCreateRecovery={readyRecoveryController({ prepare, clear })}
      />,
    );

    act(() => testIds('mobile-agent-new-session')[0]!.click());
    expect(testIds('mobile-new-session-draft')).toHaveLength(1);
    expect(testIds('mobile-new-session-agent')[0]?.getAttribute('aria-pressed')).toBe('true');

    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');

    expect(sendDaemonCommand).not.toHaveBeenCalled();
    expect(onCreateWorkspaceTerminal).not.toHaveBeenCalled();

    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(sendDaemonCommand).toHaveBeenCalledOnce();
    expect(getDaemonSnapshot).toHaveBeenCalled();
    expect(getDaemonSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(sendDaemonCommand.mock.invocationCallOrder[0]!);
    const command = sendDaemonCommand.mock.calls[0]![0];
    expect(command.type).toBe('agent.create');
    if (command.type !== 'agent.create') throw new Error('Expected one atomic agent.create command.');
    expect(command).toMatchObject({
      type: 'agent.create',
      expectedRevision: 21,
      principal: { kind: 'android', id: 'mobile-agent-ui' },
      payload: {
        workspaceId: 'workspace-1',
        title: 'Codex',
        providerId: 'codex',
        permissionPreset: 'standard',
      },
    });
    expect(command.idempotencyKey).toBe(command.commandId);
    expect(sendDaemonCommand.mock.calls.map(([sent]) => sent.type)).toEqual(['agent.create']);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(command);
    expect(prepare.mock.invocationCallOrder[0])
      .toBeLessThan(sendDaemonCommand.mock.invocationCallOrder[0]!);
    expect(clear).toHaveBeenCalledOnce();

    expect(testIds('mobile-new-session-draft')).toHaveLength(0);
    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id'))
      .toBe(command.payload.sessionId);
    expect(container.querySelector('[data-kind="user-message"]')).toBeNull();
    expect(container.textContent).toContain('Not started');
  });

  it.each([
    ['en' as const, 'Secure Agent recovery storage is unavailable'],
    ['ko' as const, '안전한 Agent 복구 저장소를 사용할 수 없습니다'],
  ])('does not send when secure recovery preparation fails (%s)', async (locale, expected) => {
    const authority = daemonSnapshotOf({ revision: 23 });
    const sendDaemonCommand = vi.fn();
    const prepare = vi.fn(async () => false);
    const transport = {
      getDaemonSnapshot: vi.fn(async () => authority),
      sendDaemonCommand,
    } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: authority }}
        transport={transport}
        {...noop}
        agentCreateRecovery={readyRecoveryController({ prepare })}
      />,
      locale,
    );

    act(() => testIds('mobile-agent-new-session')[0]!.click());
    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');
    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(prepare).toHaveBeenCalledOnce();
    expect(sendDaemonCommand).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
  });

  it('opens a contextual Terminal directly and keeps the exact invoking Workspace on failure', async () => {
    const authority = daemonSnapshotOf();
    const transport = {
      getDaemonSnapshot: vi.fn(async () => authority),
      sendDaemonCommand: vi.fn(),
    } as unknown as WsEzTerminalTransport;
    const onCreateWorkspaceTerminal = vi.fn(async () => ({ ok: false as const, reason: 'workspace-unavailable' as const }));
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: authority }}
        transport={transport}
        {...noop}
        onCreateWorkspaceTerminal={onCreateWorkspaceTerminal}
      />,
    );

    clickButtonText(container, 'EZTerminal');
    clickButtonText(container, 'Main checkout');
    act(() => testIds('mobile-daemon-create-session')[0]!.click());
    await flush();
    expect(onCreateWorkspaceTerminal).toHaveBeenCalledWith('workspace-1');
    expect(testIds('mobile-new-session-draft')).toHaveLength(0);

    expect(testIds('mobile-daemon-navigator')).toHaveLength(1);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Main checkout');
    expect(container.querySelector('[data-testid="mobile-daemon-create-session"]')?.getAttribute('aria-label'))
      .toBe('New terminal: Main checkout');
  });

  it('reconciles an uncertain first Send before replaying the exact same create command', async () => {
    const freshSnapshot = daemonSnapshotOf({ revision: 31 });
    const getDaemonSnapshot = vi.fn(async () => freshSnapshot);
    let sendCount = 0;
    const sendDaemonCommand = vi.fn(async (
      command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0],
    ) => {
      sendCount += 1;
      if (sendCount === 1) {
        return {
          ok: false as const,
          status: 'delivery-uncertain' as const,
          commandId: command.commandId,
          revision: 31,
          error: {
            code: 'delivery-uncertain' as const,
            message: 'The connection closed before acknowledgement.',
            retryable: true,
          },
        };
      }
      return {
        ok: true as const,
        status: 'replayed' as const,
        commandId: command.commandId,
        revision: 32,
        eventSequence: 15,
      };
    });
    const prepare = vi.fn(async () => true);
    const clear = vi.fn(async () => true);
    const transport = { getDaemonSnapshot, sendDaemonCommand } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: daemonSnapshotOf() }}
        transport={transport}
        {...noop}
        agentCreateRecovery={readyRecoveryController({ prepare, clear })}
      />,
    );

    act(() => testIds('mobile-agent-new-session')[0]!.click());
    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');

    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(sendDaemonCommand).toHaveBeenCalledOnce();
    const originalCommand = sendDaemonCommand.mock.calls[0]![0];
    expect(testIds('mobile-new-session-draft')).toHaveLength(1);
    expect(testIds('structured-agent-first-prompt')).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Delivery could not be confirmed');

    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(sendDaemonCommand).toHaveBeenCalledTimes(2);
    expect(getDaemonSnapshot.mock.invocationCallOrder[1])
      .toBeLessThan(sendDaemonCommand.mock.invocationCallOrder[1]!);
    const replayedCommand = sendDaemonCommand.mock.calls[1]![0];
    expect(originalCommand.type).toBe('agent.create');
    expect(replayedCommand.type).toBe('agent.create');
    if (originalCommand.type !== 'agent.create' || replayedCommand.type !== 'agent.create') {
      throw new Error('Expected the uncertain agent.create command to be replayed.');
    }
    expect(replayedCommand).toBe(originalCommand);
    expect(replayedCommand.commandId).toBe(originalCommand.commandId);
    expect(replayedCommand.payload.sessionId).toBe(originalCommand.payload.sessionId);
    expect(new Set([originalCommand.payload.sessionId, replayedCommand.payload.sessionId])).toEqual(
      new Set([originalCommand.payload.sessionId]),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(originalCommand);
    expect(clear).toHaveBeenCalledOnce();

    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id'))
      .toBe(originalCommand.payload.sessionId);
    expect(container.querySelector('[data-kind="user-message"]')).toBeNull();
  });

  it('keeps an uncertain command locked without replay when fresh authority is unavailable', async () => {
    const freshSnapshot = daemonSnapshotOf({ revision: 33 });
    const getDaemonSnapshot = vi.fn()
      .mockResolvedValueOnce(freshSnapshot)
      .mockRejectedValueOnce(new Error('offline'));
    const sendDaemonCommand = vi.fn(async (
      command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0],
    ) => ({
      ok: false as const,
      status: 'delivery-uncertain' as const,
      commandId: command.commandId,
      revision: 33,
      error: {
        code: 'delivery-uncertain' as const,
        message: 'The connection closed before acknowledgement.',
        retryable: true,
      },
    }));
    const transport = { getDaemonSnapshot, sendDaemonCommand } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: freshSnapshot }}
        transport={transport}
        {...noop}
      />,
    );

    act(() => testIds('mobile-agent-new-session')[0]!.click());
    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');
    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();
    const originalCommand = sendDaemonCommand.mock.calls[0]![0];

    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(getDaemonSnapshot).toHaveBeenCalledTimes(2);
    expect(sendDaemonCommand).toHaveBeenCalledOnce();
    expect(sendDaemonCommand.mock.calls[0]![0]).toBe(originalCommand);
    expect(testIds('mobile-new-session-draft')).toHaveLength(1);
    expect(testIds('structured-agent-first-prompt')).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Agent service is unavailable');
  });

  it('keeps the exact uncertain create envelope across an Agents view remount', async () => {
    const freshSnapshot = daemonSnapshotOf({ revision: 35 });
    const getDaemonSnapshot = vi.fn(async () => freshSnapshot);
    let sendCount = 0;
    const sendDaemonCommand = vi.fn(async (
      command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0],
    ) => {
      sendCount += 1;
      return sendCount === 1 ? {
        ok: false as const,
        status: 'delivery-uncertain' as const,
        commandId: command.commandId,
        revision: 35,
        error: {
          code: 'delivery-uncertain' as const,
          message: 'The connection closed before acknowledgement.',
          retryable: true,
        },
      } : {
        ok: true as const,
        status: 'replayed' as const,
        commandId: command.commandId,
        revision: 36,
        eventSequence: 16,
      };
    });
    const transport = { getDaemonSnapshot, sendDaemonCommand } as unknown as WsEzTerminalTransport;

    function RecoveryHost(): JSX.Element {
      const [visible, setVisible] = useState(true);
      const [recovery, setRecovery] = useState<UncertainAgentCreate | null>(null);
      const agentCreateRecovery = readyRecoveryController({
        recovery,
        prepare: async (command) => {
          setRecovery(mobileAgentCreateRecoveryFromCommand(command));
          return true;
        },
        clear: async () => {
          setRecovery(null);
          return true;
        },
      });
      return (
        <>
          <button type="button" data-testid="hide-agent-view" onClick={() => setVisible(false)}>Hide</button>
          <button type="button" data-testid="show-agent-view" onClick={() => setVisible(true)}>Show</button>
          {visible && (
            <MobileAgentView
              snapshot={snapshotOf()}
              daemonRuntimeState={{ status: 'ready', snapshot: freshSnapshot }}
              transport={transport}
              {...noop}
              agentCreateRecovery={agentCreateRecovery}
            />
          )}
        </>
      );
    }

    render(<RecoveryHost />);
    act(() => testIds('mobile-agent-new-session')[0]!.click());
    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');
    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    const originalCommand = sendDaemonCommand.mock.calls[0]![0];
    act(() => testIds('hide-agent-view')[0]!.click());
    expect(testIds('mobile-agent-view')).toHaveLength(0);
    act(() => testIds('show-agent-view')[0]!.click());

    expect(testIds('mobile-new-session-draft')).toHaveLength(1);
    expect(testIds('structured-agent-first-prompt')).toHaveLength(0);
    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(sendDaemonCommand).toHaveBeenCalledTimes(2);
    const replayedCommand = sendDaemonCommand.mock.calls[1]![0];
    expect(replayedCommand).toStrictEqual(originalCommand);
    expect(replayedCommand.commandId).toBe(originalCommand.commandId);
    expect(replayedCommand.idempotencyKey).toBe(originalCommand.idempotencyKey);
    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);
  });

  it('remounts an already-open draft with the exact recovery loaded asynchronously', async () => {
    const authority = daemonSnapshotOf({ revision: 37 });
    const recoveredCommand = createDaemonCommand({
      commandId: 'mobile-command-loaded-late',
      idempotencyKey: 'mobile-command-loaded-late',
      expectedRevision: 36,
      issuedAt: DAEMON_TIMESTAMP,
      principal: { kind: 'android', id: 'mobile-agent-ui' },
      type: 'agent.create',
      payload: {
        sessionId: 'mobile-agent-loaded-late',
        workspaceId: 'workspace-1',
        title: 'Restore the exact late recovery',
        providerId: 'claude',
        model: 'claude-sonnet-4-5',
        permissionPreset: 'full-access',
        initialPrompt: 'Restore the exact late recovery.',
      },
    });
    const recovery = mobileAgentCreateRecoveryFromCommand(recoveredCommand);
    const sendDaemonCommand = vi.fn(async () => ({
      ok: true as const,
      status: 'replayed' as const,
      commandId: recoveredCommand.commandId,
      revision: 38,
      eventSequence: 18,
    }));
    const transport = {
      getDaemonSnapshot: vi.fn(async () => authority),
      sendDaemonCommand,
    } as unknown as WsEzTerminalTransport;
    const clear = vi.fn(async () => true);

    function LateRecoveryHost(): JSX.Element {
      const [loadedRecovery, setLoadedRecovery] = useState<UncertainAgentCreate | null>(null);
      const controller = readyRecoveryController({
        status: loadedRecovery ? 'ready' : 'loading',
        recovery: loadedRecovery,
        clear,
      });
      return (
        <>
          <button
            type="button"
            data-testid="load-agent-recovery"
            onClick={() => setLoadedRecovery(recovery)}
          >
            Load recovery
          </button>
          <MobileAgentView
            snapshot={snapshotOf()}
            daemonRuntimeState={{ status: 'ready', snapshot: authority }}
            transport={transport}
            {...noop}
            agentCreateRecovery={controller}
          />
        </>
      );
    }

    render(<LateRecoveryHost />);
    act(() => testIds('mobile-agent-new-session')[0]!.click());
    expect(testIds('structured-agent-first-prompt')).toHaveLength(0);
    expect(testIds('structured-agent-first-prompt')).toHaveLength(0);

    act(() => testIds('load-agent-recovery')[0]!.click());
    await flush();

    expect((testIds('structured-agent-recovery-prompt')[0] as HTMLTextAreaElement).value)
      .toBe('Restore the exact late recovery.');
    expect((testIds('structured-agent-provider')[0] as HTMLSelectElement).value).toBe('claude');
    expect((testIds('structured-agent-model')[0] as HTMLSelectElement).value)
      .toBe('claude-sonnet-4-5');
    expect((container.querySelector('input[value="full-access"]') as HTMLInputElement).checked).toBe(true);
    expect(testIds('mobile-new-session-locked-workspace')[0]?.textContent)
      .toContain('EZTerminal · Main checkout');

    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(sendDaemonCommand).toHaveBeenCalledOnce();
    expect(sendDaemonCommand).toHaveBeenCalledWith(recoveredCommand);
    expect(clear).toHaveBeenCalledOnce();
    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);
  });

  it('localizes a stale Workspace Terminal rejection in Korean', async () => {
    const authority = daemonSnapshotOf();
    const transport = {
      getDaemonSnapshot: vi.fn(async () => authority),
      sendDaemonCommand: vi.fn(),
    } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: authority }}
        transport={transport}
        onCreateWorkspaceTerminal={vi.fn(async () => ({
          ok: false as const,
          reason: 'workspace-unavailable' as const,
        }))}
        {...noop}
      />,
      'ko',
    );

    act(() => testIds('mobile-agent-new-session')[0]!.click());
    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');
    act(() => testIds('mobile-new-session-terminal')[0]!.click());
    act(() => testIds('mobile-new-session-open-terminal')[0]!.click());
    await flush();

    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('이 Workspace를 더 이상 사용할 수 없습니다');
    expect(alert).not.toContain('This Workspace');
  });

  it('retries a stale create revision with a fresh command id and one logical session id', async () => {
    const initialSnapshot = daemonSnapshotOf({ revision: 40 });
    const refreshedSnapshot = daemonSnapshotOf({ revision: 41 });
    let snapshotCount = 0;
    const getDaemonSnapshot = vi.fn(async () => {
      snapshotCount += 1;
      return snapshotCount === 1 ? initialSnapshot : refreshedSnapshot;
    });
    let sendCount = 0;
    const sendDaemonCommand = vi.fn(async (
      command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0],
    ) => {
      sendCount += 1;
      if (sendCount === 1) {
        return {
          ok: false as const,
          status: 'rejected' as const,
          commandId: command.commandId,
          revision: 41,
          error: {
            code: 'revision-conflict' as const,
            message: 'The daemon revision advanced.',
            retryable: true,
            currentRevision: 41,
          },
        };
      }
      return {
        ok: true as const,
        status: 'queued' as const,
        commandId: command.commandId,
        revision: 42,
        eventSequence: 16,
      };
    });
    const prepare = vi.fn(async () => true);
    const clear = vi.fn(async () => true);
    const transport = { getDaemonSnapshot, sendDaemonCommand } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: initialSnapshot }}
        transport={transport}
        {...noop}
        agentCreateRecovery={readyRecoveryController({ prepare, clear })}
      />,
    );

    act(() => testIds('mobile-agent-new-session')[0]!.click());
    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-1');
    act(() => testIds('structured-agent-create')[0]!.click());
    await flush();

    expect(sendDaemonCommand).toHaveBeenCalledTimes(2);
    const [staleCommand, retriedCommand] = sendDaemonCommand.mock.calls.map(([command]) => command);
    expect(staleCommand!.type).toBe('agent.create');
    expect(retriedCommand!.type).toBe('agent.create');
    if (staleCommand!.type !== 'agent.create' || retriedCommand!.type !== 'agent.create') {
      throw new Error('Expected revision retry to use agent.create commands.');
    }
    expect([staleCommand!.expectedRevision, retriedCommand!.expectedRevision]).toEqual([40, 41]);
    expect(retriedCommand!.commandId).not.toBe(staleCommand!.commandId);
    expect(retriedCommand!.idempotencyKey).toBe(retriedCommand!.commandId);
    expect(retriedCommand!.payload.sessionId).toBe(staleCommand!.payload.sessionId);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(1, staleCommand);
    expect(prepare).toHaveBeenNthCalledWith(2, retriedCommand);
    expect(prepare.mock.invocationCallOrder[0])
      .toBeLessThan(sendDaemonCommand.mock.invocationCallOrder[0]!);
    expect(prepare.mock.invocationCallOrder[1])
      .toBeLessThan(sendDaemonCommand.mock.invocationCallOrder[1]!);
    expect(clear).toHaveBeenCalledOnce();
    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);
    expect(container.querySelector('[data-session-id]')?.getAttribute('data-session-id'))
      .toBe(staleCommand!.payload.sessionId);
  });

  it('enters daemon-only archived history without exposing impossible mobile controls', () => {
    const base = daemonSnapshotOf();
    const archivedSession: DaemonSnapshot['sessions'][number] = {
      id: 'archived-pre-provider',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      kind: 'agent',
      title: 'Archived pre-provider failure',
      state: 'failed',
      source: 'structured',
      archivedAt: DAEMON_TIMESTAMP,
      revision: 2,
      createdAt: DAEMON_TIMESTAMP,
      updatedAt: DAEMON_TIMESTAMP,
    };
    const archivedAgent: DaemonSnapshot['agents'][number] = {
      sessionId: archivedSession.id,
      providerId: 'codex',
      permissionPreset: 'standard',
      state: 'archived',
      queuedTurnCount: 0,
      orchestrationEnabled: true,
      revision: 2,
      createdAt: DAEMON_TIMESTAMP,
      updatedAt: DAEMON_TIMESTAMP,
    };
    const onFocusSession = vi.fn();
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{
          status: 'ready',
          snapshot: daemonSnapshotOf({
            sessions: [...base.sessions, archivedSession],
            agents: [...base.agents, archivedAgent],
          }),
        }}
        structuredTranscripts={{
          [archivedSession.id]: [{
            id: 'archived-message',
            sessionId: archivedSession.id,
            sequence: 1,
            kind: 'error',
            text: 'Provider startup failed before a legacy history id existed.',
            isDelta: false,
            isSensitive: false,
            createdAt: DAEMON_TIMESTAMP,
          }],
        }}
        transport={{ sendDaemonCommand: vi.fn() } as unknown as WsEzTerminalTransport}
        {...noop}
        onFocusSession={onFocusSession}
      />,
    );

    clickButtonText(container, 'Archived');
    clickButtonText(container, 'EZTerminal');
    clickButtonText(container, 'Main checkout');
    clickButtonText(container, 'Archived pre-provider failure');

    expect(onFocusSession).toHaveBeenCalledWith(archivedSession.id);
    expect(container.querySelector('[data-history-only="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Provider startup failed before a legacy history id existed.');
    expect(testIds('structured-agent-composer-input')).toHaveLength(0);
    expect(testIds('structured-agent-lifecycle')).toHaveLength(0);
    expect(testIds('structured-agent-live-model')).toHaveLength(0);
    expect(testIds('structured-agent-live-permission')).toHaveLength(0);
  });

  it('pages persisted structured transcripts and follows daemon append events', async () => {
    const transcript: DaemonTranscriptItem[] = [
      {
        id: 'item-1', sessionId: 'structured-session-1', sequence: 1,
        kind: 'user-message', text: 'Persisted mobile prompt', isDelta: false,
        isSensitive: false, createdAt: DAEMON_TIMESTAMP,
      },
      {
        id: 'item-2', sessionId: 'structured-session-1', sequence: 2,
        kind: 'assistant-message', text: 'Persisted ', isDelta: true,
        isSensitive: false, createdAt: DAEMON_TIMESTAMP,
      },
      {
        id: 'item-3', sessionId: 'structured-session-1', sequence: 3,
        kind: 'assistant-message', text: 'answer', isDelta: true,
        isSensitive: false, createdAt: DAEMON_TIMESTAMP,
      },
    ];
    const getDaemonTranscript = vi.fn(async (
      _sessionId: string,
      afterSequence = 0,
    ): Promise<readonly DaemonTranscriptItem[]> => {
      if (afterSequence === 0) return transcript.filter((item) => item.sequence <= 2);
      return transcript.filter((item) => item.sequence > afterSequence);
    });
    let daemonEventListener!: (
      event: DaemonEvent,
      continuity: 'next' | 'duplicate' | 'gap' | 'revision-regression',
    ) => void;
    const stopDaemonEvents = vi.fn();
    const setDaemonEventsSubscribed = vi.fn(async () => undefined);
    const transport = {
      getDaemonTranscript,
      sendDaemonCommand: vi.fn(),
      setDaemonEventsSubscribed,
      onDaemonEvent: vi.fn((listener: typeof daemonEventListener) => {
        daemonEventListener = listener;
        return stopDaemonEvents;
      }),
    } as unknown as WsEzTerminalTransport;
    const daemonSnapshot = daemonSnapshotOf({
      transcriptHeads: [{ sessionId: 'structured-session-1', lastSequence: 3, itemCount: 3 }],
    });
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: daemonSnapshot }}
        transport={transport}
        {...noop}
      />,
    );
    clickButtonText(container, 'EZTerminal');
    clickButtonText(container, 'Main checkout');
    clickButtonText(container, 'Structured mobile task');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getDaemonTranscript).toHaveBeenCalledWith('structured-session-1', 0, 500);
    expect(getDaemonTranscript).toHaveBeenCalledWith('structured-session-1', 2, 500);
    expect(container.textContent).toContain('Persisted mobile prompt');
    expect(container.textContent).toContain('Persisted answer');

    transcript.push({
      id: 'item-4', sessionId: 'structured-session-1', sequence: 4,
      kind: 'tool-result', text: 'Incremental mobile result', isDelta: false,
      isSensitive: false, createdAt: DAEMON_TIMESTAMP,
    });
    act(() => daemonEventListener({
      protocolVersion: 12,
      eventId: 'event-13',
      sequence: 13,
      revision: 9,
      occurredAt: DAEMON_TIMESTAMP,
      kind: 'transcript.appended',
      payload: { sessionId: 'structured-session-1', fromSequence: 4, toSequence: 4 },
    }, 'next'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getDaemonTranscript).toHaveBeenCalledWith('structured-session-1', 3, 500);
    expect(container.textContent).toContain('Incremental mobile result');

    act(() => root.unmount());
    expect(stopDaemonEvents).toHaveBeenCalledOnce();
    expect(setDaemonEventsSubscribed).toHaveBeenLastCalledWith(false);
    root = createRoot(container);
  });

  it('projects only direct attached children and routes valid lifecycle commands', async () => {
    const base = daemonSnapshotOf();
    const sessions: DaemonSnapshot['sessions'] = [
      ...base.sessions,
      {
        id: 'managed-child', projectId: 'project-1', workspaceId: 'workspace-1',
        kind: 'agent', title: 'Managed accessibility child', state: 'running', source: 'structured',
        revision: 1, createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
      {
        id: 'native-child', projectId: 'project-1', workspaceId: 'workspace-1',
        kind: 'agent', title: 'Native provider child', state: 'running', source: 'structured',
        revision: 1, createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
      {
        id: 'detached-child', projectId: 'project-1', workspaceId: 'workspace-1',
        kind: 'agent', title: 'Detached child', state: 'idle', source: 'structured',
        revision: 1, createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
      {
        id: 'grandchild', projectId: 'project-1', workspaceId: 'workspace-1',
        kind: 'agent', title: 'Grandchild', state: 'idle', source: 'structured',
        revision: 1, createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
    ];
    const agents: DaemonSnapshot['agents'] = [
      ...base.agents,
      {
        sessionId: 'managed-child', providerId: 'codex', providerSessionId: 'provider-managed',
        model: 'gpt-5', permissionPreset: 'standard', state: 'working', currentTurnId: 'turn-child',
        queuedTurnCount: 0, orchestrationEnabled: true, revision: 1,
        createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
      {
        sessionId: 'native-child', providerId: 'claude', providerSessionId: 'provider-native',
        permissionPreset: 'plan', state: 'working', queuedTurnCount: 0,
        orchestrationEnabled: true, revision: 1,
        createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
      {
        sessionId: 'detached-child', providerId: 'codex', providerSessionId: 'provider-detached',
        permissionPreset: 'standard', state: 'idle', queuedTurnCount: 0,
        orchestrationEnabled: true, revision: 1,
        createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
      {
        sessionId: 'grandchild', providerId: 'codex', providerSessionId: 'provider-grandchild',
        permissionPreset: 'standard', state: 'idle', queuedTurnCount: 0,
        orchestrationEnabled: true, revision: 1,
        createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      },
    ];
    const relations: DaemonSnapshot['agentRelations'] = [{
      id: 'relation-managed', treeId: 'structured-session-1',
      parentSessionId: 'structured-session-1', childSessionId: 'managed-child',
      owner: 'managed', depth: 1, revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }, {
      id: 'relation-native', treeId: 'structured-session-1',
      parentSessionId: 'structured-session-1', childSessionId: 'native-child',
      owner: 'provider-native', depth: 1, revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }, {
      id: 'relation-detached', treeId: 'structured-session-1',
      parentSessionId: 'structured-session-1', childSessionId: 'detached-child',
      owner: 'managed', depth: 1, detachedAt: DAEMON_TIMESTAMP, revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }, {
      id: 'relation-grandchild', treeId: 'structured-session-1',
      parentSessionId: 'managed-child', childSessionId: 'grandchild',
      owner: 'managed', depth: 2, revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    }];
    const firstSnapshot = daemonSnapshotOf({ sessions, agents, agentRelations: relations });
    let receiptRevision = firstSnapshot.revision;
    const sendDaemonCommand = vi.fn(async (command: Parameters<WsEzTerminalTransport['sendDaemonCommand']>[0]) => ({
      ok: true as const,
      status: 'queued' as const,
      commandId: command.commandId,
      revision: ++receiptRevision,
      eventSequence: ++receiptRevision,
    }));
    const transport = { sendDaemonCommand } as unknown as WsEzTerminalTransport;
    const onFocusSession = vi.fn();
    const view = (daemonSnapshot: DaemonSnapshot) => (
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: daemonSnapshot }}
        transport={transport}
        {...noop}
        onFocusSession={onFocusSession}
      />
    );
    render(view(firstSnapshot));
    clickButtonText(container, 'EZTerminal');
    clickButtonText(container, 'Main checkout');
    clickButtonText(container, 'Structured mobile task');

    const childButtons = testIds('structured-agent-child');
    expect(childButtons).toHaveLength(2);
    expect(childButtons[0]?.textContent).toContain('Managed accessibility child');
    expect(childButtons[0]?.textContent).toContain('Codex');
    expect(childButtons[0]?.textContent).toContain('working');
    expect(childButtons[0]?.textContent).toContain('Managed');
    expect(childButtons[1]?.textContent).toContain('Provider-owned');
    expect(container.textContent).not.toContain('Detached child');
    expect(container.textContent).not.toContain('Grandchild');

    act(() => childButtons[0]!.click());
    expect(onFocusSession).toHaveBeenLastCalledWith('managed-child');
    expect((testIds('structured-agent-composer-input')[0] as HTMLTextAreaElement).disabled).toBe(false);
    expect(testIds('structured-agent-cancel')).toHaveLength(1);
    expect(testIds('structured-agent-archive')).toHaveLength(0);
    expect(testIds('structured-agent-detach')).toHaveLength(1);

    await act(async () => {
      testIds('structured-agent-cancel')[0]!.click();
      await Promise.resolve();
    });
    expect(sendDaemonCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'agent.cancel',
      payload: { sessionId: 'managed-child' },
    }));

    const stoppedAgents = agents.map((agent) => agent.sessionId === 'managed-child'
      ? { ...agent, state: 'interrupted' as const, currentTurnId: undefined }
      : agent);
    const stoppedSessions = sessions.map((session) => session.id === 'managed-child'
      ? { ...session, state: 'interrupted' as const }
      : session);
    render(view(daemonSnapshotOf({
      revision: 9,
      sessions: stoppedSessions,
      agents: stoppedAgents,
      agentRelations: relations,
    })));
    expect(testIds('structured-agent-cancel')).toHaveLength(0);
    expect(testIds('structured-agent-archive')).toHaveLength(1);
    expect(testIds('structured-agent-detach')).toHaveLength(1);
    expect((testIds('structured-agent-composer-input')[0] as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      testIds('structured-agent-detach')[0]!.click();
      await Promise.resolve();
    });
    expect(sendDaemonCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'agent.detach',
      payload: { sessionId: 'managed-child' },
    }));

    const detachedRelations = relations.map((relation) => relation.id === 'relation-managed'
      ? { ...relation, detachedAt: DAEMON_TIMESTAMP }
      : relation);
    render(view(daemonSnapshotOf({
      revision: 10,
      sessions: stoppedSessions,
      agents: stoppedAgents,
      agentRelations: detachedRelations,
    })));
    expect(testIds('structured-agent-detach')).toHaveLength(0);
    expect(testIds('structured-agent-archive')).toHaveLength(1);

    await act(async () => {
      testIds('structured-agent-archive')[0]!.click();
      await Promise.resolve();
    });
    expect(sendDaemonCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'agent.archive',
      payload: { sessionId: 'managed-child' },
    }));

    const archivedAgents = stoppedAgents.map((agent) => agent.sessionId === 'managed-child'
      ? { ...agent, state: 'archived' as const }
      : agent);
    const archivedSessions = stoppedSessions.map((session) => session.id === 'managed-child'
      ? { ...session, state: 'archived' as const, archivedAt: DAEMON_TIMESTAMP }
      : session);
    render(view(daemonSnapshotOf({
      revision: 11,
      sessions: archivedSessions,
      agents: archivedAgents,
      agentRelations: detachedRelations,
    })));
    expect(testIds('mobile-structured-agent-session')).toHaveLength(1);
    expect(testIds('structured-agent-composer-input')).toHaveLength(0);
    expect(testIds('structured-agent-lifecycle')).toHaveLength(0);
  });

  it('opens transcript-related provider-owned children through the same read-only session route', () => {
    const base = daemonSnapshotOf();
    const childSession: DaemonSnapshot['sessions'][number] = {
      id: 'native-child', projectId: 'project-1', workspaceId: 'workspace-1',
      kind: 'agent', title: 'Provider-owned child', state: 'running', source: 'structured',
      revision: 1, createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    };
    const childAgent: DaemonSnapshot['agents'][number] = {
      sessionId: 'native-child', providerId: 'claude', providerSessionId: 'native-provider-id',
      permissionPreset: 'plan', state: 'working', queuedTurnCount: 0,
      orchestrationEnabled: true, revision: 1,
      createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
    };
    const daemonSnapshot = daemonSnapshotOf({
      sessions: [...base.sessions, childSession],
      agents: [...base.agents, childAgent],
      agentRelations: [{
        id: 'relation-native', treeId: 'structured-session-1',
        parentSessionId: 'structured-session-1', childSessionId: 'native-child',
        owner: 'provider-native', depth: 1, revision: 1,
        createdAt: DAEMON_TIMESTAMP, updatedAt: DAEMON_TIMESTAMP,
      }],
    });
    const transport = { sendDaemonCommand: vi.fn() } as unknown as WsEzTerminalTransport;
    const onFocusSession = vi.fn();
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        daemonRuntimeState={{ status: 'ready', snapshot: daemonSnapshot }}
        structuredTranscripts={{
          'structured-session-1': [{
            id: 'related-native',
            sessionId: 'structured-session-1',
            sequence: 1,
            kind: 'notice',
            text: 'Provider child has an update.',
            isDelta: false,
            isSensitive: false,
            relatedSessionId: 'native-child',
            createdAt: DAEMON_TIMESTAMP,
          }],
        }}
        transport={transport}
        {...noop}
        onFocusSession={onFocusSession}
      />,
    );
    clickButtonText(container, 'EZTerminal');
    clickButtonText(container, 'Main checkout');
    clickButtonText(container, 'Structured mobile task');
    clickButtonText(container, 'Open related session');

    expect(onFocusSession).toHaveBeenLastCalledWith('native-child');
    expect(container.querySelector('h1')?.textContent).toContain('Provider-owned child');
    expect(container.textContent).toContain('Provider-owned · Read only');
    expect((testIds('structured-agent-composer-input')[0] as HTMLTextAreaElement).disabled).toBe(true);
    expect(testIds('structured-agent-lifecycle')).toHaveLength(0);
  });

  it('orders parked approvals first by risk, expiry, then recency', () => {
    const approval = (
      approvalId: string,
      risk: 'danger' | 'write' | 'read',
      expiresAt: number,
    ) => ({
      approvalId,
      toolName: 'Shell',
      command: approvalId,
      risk,
      pending: true,
      requestedAt: NOW - 1_000,
      expiresAt,
    });
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('none', 'blocked', { updatedAt: NOW }),
          activity('read-late', 'blocked', {
            approval: approval('read-late', 'read', NOW + 20_000),
          }),
          activity('write', 'blocked', {
            approval: approval('write', 'write', NOW + 30_000),
          }),
          activity('danger', 'blocked', {
            approval: approval('danger', 'danger', NOW + 40_000),
          }),
          activity('read-soon', 'blocked', {
            approval: approval('read-soon', 'read', NOW + 10_000),
          }),
        )}
        {...noop}
      />,
    );

    expect(testIds('agent-card').map((card) => card.querySelector('code')?.textContent ?? 'none'))
      .toEqual(['danger', 'write', 'read-soon', 'read-late', 'none']);
  });

  it('offers the follow-up composer only for a live, interactive done agent', () => {
    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'blocked'))} {...noop} />);
    expect(testIds('agent-followup-input')).toHaveLength(0);

    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'done'))} {...noop} />);
    expect(testIds('agent-followup-input')).toHaveLength(0);

    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'done', {
      interactiveReady: true,
    }))} {...noop} />);
    expect(testIds('agent-followup-input')).toHaveLength(1);
  });

  it('uses host pending truth instead of the mobile wall clock', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('pending', 'blocked', {
          approval: {
            approvalId: 'approval-pending',
            toolName: 'Shell',
            risk: 'danger',
            pending: true,
            requestedAt: NOW - 120_000,
            expiresAt: NOW - 60_000,
          },
        }))}
        {...noop}
        onDecideApproval={async () => ({ ok: true })}
      />,
    );
    expect(testIds('agent-approve')).toHaveLength(1);

    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('released', 'blocked', {
          approval: {
            approvalId: 'approval-released',
            toolName: 'Shell',
            risk: 'danger',
            pending: false,
            requestedAt: NOW - 1_000,
            expiresAt: NOW + 60_000,
          },
        }))}
        {...noop}
        onDecideApproval={async () => ({ ok: true })}
      />,
    );
    expect(testIds('agent-approve')).toHaveLength(0);
  });

  it('sends a follow-up and clears the draft on success', async () => {
    const onSendFollowup = vi.fn(async () => ({ ok: true }) as const);
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'done', { interactiveReady: true }))}
        {...noop}
        onSendFollowup={onSendFollowup}
      />,
    );

    const input = testIds('agent-followup-input')[0] as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'continue please');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onSendFollowup).toHaveBeenCalledWith('a', 'continue please');
    expect((testIds('agent-followup-input')[0] as HTMLInputElement).value).toBe('');
  });

  it('surfaces a delivery failure without clearing the draft', async () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'done', { interactiveReady: true }))}
        {...noop}
        onSendFollowup={async () => ({ ok: false, error: 'not-waiting' }) as const}
      />,
    );

    const input = testIds('agent-followup-input')[0] as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The agent is no longer waiting.');
    expect((testIds('agent-followup-input')[0] as HTMLInputElement).value).toBe('hello');
  });

  it('focuses the terminal session behind an attention card', () => {
    const onFocusSession = vi.fn();
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'blocked'))}
        {...noop}
        onFocusSession={onFocusSession}
      />,
    );
    act(() => testIds('agent-focus')[0]!.click());
    expect(onFocusSession).toHaveBeenCalledWith('session-a');
  });

  it('shows diff truncation and omission reasons even when no text remains', async () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'blocked', {
          approval: {
            approvalId: 'approval-a',
            toolName: 'Shell',
            risk: 'write',
            pending: true,
            requestedAt: NOW - 1_000,
            expiresAt: NOW + 30_000,
          },
        }))}
        {...noop}
        onLoadDiff={async () => ({
          ok: true,
          text: '',
          truncated: true,
          omissions: [{ path: 'artifacts/large.bin', reason: 'too-large' }],
        })}
      />,
    );

    await act(async () => {
      testIds('agent-view-diff')[0]!.click();
      await Promise.resolve();
    });

    expect(testIds('mobile-agent-diff')).toHaveLength(1);
    expect(testIds('mobile-agent-diff-truncated')).toHaveLength(1);
    expect(testIds('mobile-agent-diff-omissions')[0]?.textContent).toContain('artifacts/large.bin');
    expect(testIds('mobile-agent-diff-omissions')[0]?.textContent).toContain('file exceeds the review limit');
  });

  it('keeps the newest diff when an older request resolves last', async () => {
    let resolveFirst!: (result: GitDiffResult) => void;
    let resolveSecond!: (result: GitDiffResult) => void;
    const first = new Promise<GitDiffResult>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<GitDiffResult>((resolve) => { resolveSecond = resolve; });
    const onLoadDiff = vi.fn((directory: string) => directory.endsWith('/first') ? first : second);
    const approval = (id: string): AgentActivity => activity(id, 'blocked', {
      approval: {
        approvalId: `approval-${id}`,
        toolName: 'Shell',
        risk: 'write',
        pending: true,
        requestedAt: NOW - 1_000,
        expiresAt: NOW + 30_000,
      },
    });
    render(
      <MobileAgentView
        snapshot={snapshotOf(approval('first'), approval('second'))}
        {...noop}
        onLoadDiff={onLoadDiff}
      />,
    );

    const buttons = testIds('agent-view-diff') as HTMLButtonElement[];
    act(() => {
      buttons[0]!.click();
      buttons[1]!.click();
    });
    expect(testIds('mobile-agent-diff')).toHaveLength(1);

    await act(async () => {
      resolveSecond({ ok: true, text: 'second diff', truncated: false, omissions: [] });
      await Promise.resolve();
    });
    expect(container.querySelector('.mob-agent-diff')?.textContent).toBe('second diff');

    await act(async () => {
      resolveFirst({ ok: true, text: 'first diff', truncated: false, omissions: [] });
      await Promise.resolve();
    });
    expect(container.querySelector('.mob-agent-diff')?.textContent).toBe('second diff');
  });

  it('does not reopen a closed diff after its request resolves', async () => {
    let resolveDiff!: (result: GitDiffResult) => void;
    const pending = new Promise<GitDiffResult>((resolve) => { resolveDiff = resolve; });
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'blocked', {
          approval: {
            approvalId: 'approval-a',
            toolName: 'Shell',
            risk: 'write',
            pending: true,
            requestedAt: NOW - 1_000,
            expiresAt: NOW + 30_000,
          },
        }))}
        {...noop}
        onLoadDiff={() => pending}
      />,
    );

    act(() => testIds('agent-view-diff')[0]!.click());
    const sheet = testIds('mobile-agent-diff')[0]!;
    act(() => {
      const buttons = sheet.querySelectorAll<HTMLButtonElement>('button');
      buttons[buttons.length - 1]!.click();
    });
    expect(testIds('mobile-agent-diff')).toHaveLength(0);

    await act(async () => {
      resolveDiff({ ok: true, text: 'late diff', truncated: false, omissions: [] });
      await Promise.resolve();
    });
    expect(testIds('mobile-agent-diff')).toHaveLength(0);
  });

  it('distinguishes an empty snapshot from an empty filter', () => {
    render(<MobileAgentView snapshot={snapshotOf()} {...noop} />);
    expect(testIds('agent-empty')[0]?.textContent).toContain('No agent activity yet');

    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'idle'))} {...noop} />);
    act(() => testIds('agent-filter-attention')[0]!.click());
    expect(testIds('agent-empty')[0]?.textContent).toBe('No agents match this filter.');
  });

  it('blocks follow-up while disconnected and says so', () => {
    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'done', {
      interactiveReady: true,
    }))} {...noop} disconnected />);
    expect((testIds('agent-followup-input')[0] as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain('Reconnecting to desktop…');
  });

  it('reviews a failed validation override on mobile and forwards the bounded reason', async () => {
    const request: ManagedMergeRequest = {
      requestId: 'merge-1',
      revision: 4,
      projectId: 'project-1',
      participantId: 'participant-1',
      activityId: 'activity-1',
      sourceWorkspaceId: 'workspace-1',
      sourceBranch: 'agent/feature',
      sourceHead: '1'.repeat(40),
      targetBranch: 'main',
      targetHead: '2'.repeat(40),
      candidateHead: '3'.repeat(40),
      state: 'override-required',
      validationConfigRevision: 1,
      validations: [{ id: 'unit', name: 'Unit tests', status: 'failed', exitCode: 1 }],
      createdAt: NOW - 2_000,
      updatedAt: NOW - 1_000,
      expiresAt: NOW + 60_000,
    };
    const coordinationSnapshot: AgentCoordinationSnapshot = {
      revision: 1,
      activityRevision: 1,
      activities: [],
      projects: [],
      mergeRequests: [request],
    };
    const decideManagedMerge = vi.fn(async () => ({
      ok: true as const,
      value: { ...request, state: 'merged' as const },
    }));
    const transport = { decideManagedMerge } as unknown as WsEzTerminalTransport;
    render(
      <MobileAgentView
        snapshot={snapshotOf()}
        coordinationSnapshot={coordinationSnapshot}
        transport={transport}
        {...noop}
      />,
    );

    act(() => testIds('managed-merge-override')[0]!.click());
    expect(testIds('mobile-managed-merge-override')).toHaveLength(1);
    const reason = testIds('mobile-managed-merge-override-reason')[0] as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(reason, 'Reviewed failing tests and accepted the risk.');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      testIds('mobile-managed-merge-override-confirm')[0]!.click();
      await Promise.resolve();
    });
    expect(decideManagedMerge).toHaveBeenCalledWith({
      requestId: 'merge-1',
      revision: 4,
      decision: 'approve',
      actor: 'mobile',
      overrideReason: 'Reviewed failing tests and accepted the risk.',
    });
    expect(testIds('mobile-managed-merge-override')).toHaveLength(0);
  });
});
