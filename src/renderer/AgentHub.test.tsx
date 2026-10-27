// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentActivity,
  AgentActivitySnapshot,
  AgentApprovalRisk,
} from '../shared/agent';
import type { GitDiffResult } from '../shared/git-status';
import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  type AgentOrchestrationSnapshot,
} from '../shared/agent-orchestration';
import { AgentHub } from './AgentHub';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let originalEzTerminal: typeof window.ezterminal | undefined;
let originalEzTerminalDesktop: typeof window.ezterminalDesktop;

function activity(input: {
  id: string;
  status?: AgentActivity['status'];
  risk?: AgentApprovalRisk;
  expiresAt?: number;
  pending?: boolean;
}): AgentActivity {
  const status = input.status ?? 'blocked';
  return {
    id: input.id,
    sessionId: `session-${input.id}`,
    provider: 'claude',
    cwd: `C:\\${input.id}`,
    state: status,
    status,
    stateSeq: 1,
    live: true,
    interactiveReady: true,
    stateSource: 'provider-hook',
    createdAt: 10,
    updatedAt: 20,
    ...(input.risk
      ? {
          approval: {
            approvalId: `approval-${input.id}`,
            toolName: 'Bash',
            command: `echo ${input.id}`,
            risk: input.risk,
            pending: input.pending ?? true,
            requestedAt: 30,
            expiresAt: input.expiresAt ?? Date.now() + 60_000,
          },
        }
      : {}),
  };
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHub(
  snapshot: AgentActivitySnapshot,
  overrides: Partial<ComponentProps<typeof AgentHub>> = {},
): Promise<void> {
  act(() => {
    root.render(
      <AgentHub
        view="inbox"
        snapshot={snapshot}
        onFocusSession={vi.fn()}
        onSendFollowup={vi.fn(async () => ({ ok: true as const }))}
        {...overrides}
      />,
    );
  });
  await flush();
}

beforeEach(() => {
  originalEzTerminal = window.ezterminal;
  originalEzTerminalDesktop = window.ezterminalDesktop;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: originalEzTerminal,
  });
  vi.restoreAllMocks();
});

describe('AgentHub approval integrity', () => {
  it('orders approvals by risk, deadline, then leaves non-approval attention behind them', async () => {
    const now = Date.now();
    await renderHub({
      revision: 1,
      items: [
        activity({ id: 'error', status: 'error' }),
        activity({ id: 'read', risk: 'read', expiresAt: now + 1_000 }),
        activity({ id: 'danger-later', risk: 'danger', expiresAt: now + 30_000 }),
        activity({ id: 'danger-sooner', risk: 'danger', expiresAt: now + 10_000 }),
        activity({ id: 'write', risk: 'write', expiresAt: now + 5_000 }),
      ],
    });

    const paths = Array.from(container.querySelectorAll<HTMLElement>('.agent-cwd'))
      .map((entry) => entry.title);
    expect(paths).toEqual([
      'C:\\danger-sooner',
      'C:\\danger-later',
      'C:\\write',
      'C:\\read',
      'C:\\error',
    ]);
  });

  it('sends the exact approval identity captured by the clicked card', async () => {
    const onDecideApproval = vi.fn(async () => ({ ok: true as const }));
    await renderHub(
      { revision: 1, items: [activity({ id: 'one', risk: 'danger' })] },
      { onDecideApproval },
    );

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-approve"]')!.click());
    await flush();
    expect(onDecideApproval).toHaveBeenCalledWith('one', 'approval-one', 'allow');
  });

  it('uses host pending truth instead of the renderer wall clock', async () => {
    const onDecideApproval = vi.fn(async () => ({ ok: true as const }));
    await renderHub(
      {
        revision: 1,
        items: [activity({
          id: 'host-pending',
          risk: 'danger',
          pending: true,
          expiresAt: Date.now() - 60_000,
        })],
      },
      { onDecideApproval },
    );
    expect(container.querySelector('[data-testid="agent-approve"]')).not.toBeNull();
    expect(container.querySelector('.agent-approval-countdown')).toBeNull();

    await renderHub(
      {
        revision: 2,
        items: [activity({
          id: 'host-released',
          risk: 'danger',
          pending: false,
          expiresAt: Date.now() + 60_000,
        })],
      },
      { onDecideApproval },
    );
    expect(container.querySelector('[data-testid="agent-approve"]')).toBeNull();
    expect(container.querySelector('.agent-approval-expired')).not.toBeNull();
  });
});

describe('AgentHub files view', () => {
  const project = {
    projectId: 'project-far', name: 'Far project', primaryRoot: 'C:\\Work\\far', additionalRoots: [],
    pinned: false, saved: true, sessionCount: 0, providers: [], lastActiveAt: 20,
  } as const;
  const other = { ...project, projectId: 'project-near', name: 'Near project', primaryRoot: 'C:\\Work\\near' };

  async function renderFiles(listAgentProjects: ReturnType<typeof vi.fn>): Promise<void> {
    Object.defineProperty(window, 'ezterminal', { configurable: true, value: { listAgentProjects, listAgentHistorySessions: vi.fn() } });
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: { describeProjectWorkspace: vi.fn(async () => ({ ok: false, error: 'io-error' })) },
    });
    await renderHub({ revision: 1, items: [] }, {
      view: 'files', activeProjectId: 'project-far', onOpenProjectDocument: vi.fn(), onOpenStructuredAgentDraft: vi.fn(), onEditProject: vi.fn(),
    });
    await flush();
  }
  afterEach(() => {
    Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: originalEzTerminalDesktop });
  });

  it('shows only the project’s files: no project list, no footer and no way back to a list', async () => {
    const listAgentProjects = vi.fn(async (_force?: boolean, cursor?: string) => (
      cursor ? { items: [project], nextCursor: null } : { items: [other], nextCursor: 'page-2' }
    ));
    await renderFiles(listAgentProjects);
    // Past the first page, the project is read on its own.
    expect(listAgentProjects).toHaveBeenCalledWith(false, 'page-2', 100);
    const panel = container.querySelector('[data-testid="project-workspace-panel"]');
    expect(panel?.textContent).toContain('Far project');
    expect(container.querySelector('[data-testid="agent-projects"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-new-run"]')).toBeNull();
    expect(container.querySelector('[aria-label="Back to projects"]')).toBeNull();
  });

  it('says so when the project cannot be found', async () => {
    await renderFiles(vi.fn(async () => ({ items: [other], nextCursor: null })));
    expect(container.querySelector('[data-testid="agent-files-unavailable"]')?.textContent).toBe('Could not load projects.');
    expect(container.querySelector('[data-testid="agent-projects"]')).toBeNull();
  });
});

describe('AgentHub Lead-only orchestration projection', () => {
  it('hides worker cards and their composer while keeping the Lead chatable', async () => {
    await renderHub({
      revision: 1,
      items: [
        activity({ id: 'lead', status: 'done' }),
        activity({ id: 'worker', status: 'done' }),
      ],
    }, { orchestrationSnapshot: orchestrationWithWorker('worker') });

    expect(container.querySelectorAll('[data-testid="agent-row"]')).toHaveLength(1);
    expect(container.querySelectorAll('.agent-followup-input')).toHaveLength(1);
    expect(container.textContent).not.toContain('C:\\worker');
  });
});

describe('AgentHub conversation safe mode', () => {
  it('shows the safe-mode notice above the inbox once the host confirms it', async () => {
    await renderHub({ revision: 1, items: [] }, {
      daemonAgentSessionAccess: {
        getAvailability: async () => ({
          state: 'legacy-only-safe-mode',
          initializationCode: 'database-corrupt',
          databaseDisposition: 'quarantined',
          supportedSchemaVersion: 3,
        }),
      },
    });
    await flush();

    expect(container.querySelector('[data-testid="daemon-safe-mode"]')).not.toBeNull();
    expect(container.querySelector('.agent-empty')?.textContent).toBe('No requests need your attention.');
  });
});

describe('AgentHub real actions and honest diff', () => {
  it('shows structured omissions even when no file content could be included', async () => {
    await renderHub(
      { revision: 1, items: [activity({ id: 'one', risk: 'write' })] },
      {
        onLoadDiff: vi.fn(async () => ({
          ok: true as const,
          text: '',
          truncated: true,
          omissions: [{ path: 'large.bin', reason: 'binary' as const }],
        })),
      },
    );

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-view-diff"]')!.click());
    await flush();
    const omissions = document.body.querySelector<HTMLElement>('[data-testid="agent-diff-omissions"]');
    expect(omissions?.textContent).toContain('large.bin');
    expect(omissions?.textContent).toContain('binary');
    expect(document.body.textContent).not.toContain(
      'Nothing has changed in the working tree yet.',
    );
  });

  it('reports an empty diff only when the complete result has no changes', async () => {
    await renderHub(
      { revision: 1, items: [activity({ id: 'complete-empty', risk: 'write' })] },
      {
        onLoadDiff: vi.fn(async () => ({
          ok: true as const,
          text: '',
          truncated: false,
          omissions: [],
        })),
      },
    );

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-view-diff"]')!.click());
    await flush();
    expect(document.body.textContent).toContain(
      'Nothing has changed in the working tree yet.',
    );
  });

  it('keeps the newest diff when an older request resolves last', async () => {
    let resolveFirst!: (result: GitDiffResult) => void;
    let resolveSecond!: (result: GitDiffResult) => void;
    const first = new Promise<GitDiffResult>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<GitDiffResult>((resolve) => { resolveSecond = resolve; });
    const onLoadDiff = vi.fn((directory: string) => directory.endsWith('first') ? first : second);
    await renderHub(
      {
        revision: 1,
        items: [
          activity({ id: 'first', risk: 'write' }),
          activity({ id: 'second', risk: 'write' }),
        ],
      },
      { onLoadDiff },
    );

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="agent-view-diff"]'),
    );
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    await act(async () => {
      resolveSecond({ ok: true, text: 'second diff', truncated: false, omissions: [] });
      await Promise.resolve();
    });
    expect(document.body.querySelector('[data-testid="agent-diff-text"]')?.textContent)
      .toBe('second diff');

    await act(async () => {
      resolveFirst({ ok: true, text: 'first diff', truncated: false, omissions: [] });
      await Promise.resolve();
    });
    expect(document.body.querySelector('[data-testid="agent-diff-text"]')?.textContent)
      .toBe('second diff');
  });

  it('does not reopen a closed diff after its request resolves', async () => {
    let resolveDiff!: (result: GitDiffResult) => void;
    const pending = new Promise<GitDiffResult>((resolve) => { resolveDiff = resolve; });
    await renderHub(
      { revision: 1, items: [activity({ id: 'one', risk: 'write' })] },
      { onLoadDiff: vi.fn(() => pending) },
    );

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-view-diff"]')!.click());
    await flush();
    const dialog = document.body.querySelector<HTMLElement>('[data-testid="agent-diff-dialog"]');
    expect(dialog).not.toBeNull();
    act(() => {
      dialog!.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
    });
    expect(document.body.querySelector('[data-testid="agent-diff-dialog"]')).toBeNull();

    await act(async () => {
      resolveDiff({ ok: true, text: 'late diff', truncated: false, omissions: [] });
      await Promise.resolve();
    });
    expect(document.body.querySelector('[data-testid="agent-diff-dialog"]')).toBeNull();
  });
});
