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
import { AgentHub } from './AgentHub';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let originalEzTerminal: typeof window.ezterminal | undefined;

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
    status,
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

describe('AgentHub local history paging', () => {
  it('loads ten sessions, opens by double-click, and appends the next page', async () => {
    const project = {
      projectId: 'project-1',
      name: 'Project',
      primaryRoot: 'C:\\Project',
      additionalRoots: [],
      pinned: false,
      saved: false,
      sessionCount: 0,
      providers: [],
      lastActiveAt: 20,
    } as const;
    const session = (index: number) => ({
      historyId: `codex_${String(index).padStart(24, '0')}`,
      projectId: project.projectId,
      provider: 'codex' as const,
      title: `Session ${index}`,
      preview: '',
      createdAt: index,
      updatedAt: index,
      roots: [project.primaryRoot],
      source: 'cli',
    });
    const listAgentProjects = vi.fn(async () => ({ items: [project], nextCursor: null }));
    const listAgentHistorySessions = vi.fn(async (
      _projectId: string,
      cursor?: string,
    ) => cursor
      ? { items: [session(11), session(12)], nextCursor: null }
      : { items: Array.from({ length: 10 }, (_, index) => session(index + 1)), nextCursor: 'page-2' });
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: { listAgentProjects, listAgentHistorySessions },
    });
    const onOpenHistorySession = vi.fn();

    await renderHub(
      { revision: 1, items: [] },
      { onOpenHistorySession },
    );
    act(() => container.querySelector<HTMLButtonElement>('.agent-project-toggle')!.click());
    await flush();

    const rows = container.querySelectorAll<HTMLButtonElement>('.agent-history-row');
    expect(rows).toHaveLength(10);
    act(() => rows[0]!.click());
    expect(onOpenHistorySession).not.toHaveBeenCalled();
    act(() => rows[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onOpenHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Session 1' }),
      project,
    );

    act(() => container.querySelector<HTMLButtonElement>('.agent-history-more')!.click());
    await flush();
    expect(listAgentHistorySessions).toHaveBeenLastCalledWith('project-1', 'page-2', 10);
    expect(container.querySelectorAll('.agent-history-row')).toHaveLength(12);
  });
});

describe('AgentHub real actions and honest diff', () => {
  it('renders the new-run action only when a real callback is supplied', async () => {
    const onNewAgentRun = vi.fn();
    await renderHub({ revision: 1, items: [] }, { onNewAgentRun });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="agent-new-run"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onNewAgentRun).toHaveBeenCalledOnce();
  });

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
