// Real React root + native DOM events, same harness as the other mobile
// component tests in this package (no @testing-library/react here).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentActivitySnapshot, AgentState } from '../../src/shared/agent';
import type { AgentCoordinationSnapshot, ManagedMergeRequest } from '../../src/shared/agent-coordination';
import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import type { GitDiffResult } from '../../src/shared/git-status';
import { MobileAgentView } from './MobileAgentView';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
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

function render(node: JSX.Element): void {
  act(() => root.render(
    <MobileNavigationHistoryProvider>
      {node}
    </MobileNavigationHistoryProvider>,
  ));
}

function testIds(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
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

  it('places projects between attention and active history in document order', async () => {
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
      element.getAttribute('data-testid') === 'mobile-agent-projects'
        ? 'projects'
        : element.getAttribute('data-status')
    ));
    expect(order).toEqual(['blocked', 'done', 'projects', 'working', 'idle']);
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
