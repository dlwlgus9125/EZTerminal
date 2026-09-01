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
import type { EzTerminalDesktopApi } from '../shared/ipc';
import type { AgentTeamDesktopSnapshot, AgentTeamRun } from '../shared/agent-team';
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

describe('AgentHub local history paging', () => {
  it('opens project history from the overflow menu and appends the next page', async () => {
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
    expect(listAgentProjects).toHaveBeenCalledTimes(1);
    expect(listAgentProjects).toHaveBeenCalledWith(false, undefined, 40, undefined);
    expect(container.querySelector('.agent-project-toggle')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Manage Project"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    await flush();

    expect(container.querySelector('[data-testid="agent-project-history"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-projects"]')).toBeNull();
    const rows = container.querySelectorAll<HTMLButtonElement>('.agent-history-row');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.dataset.provider).toBe('codex');
    expect(rows[0]?.querySelector('.agent-provider-badge')?.textContent).toBe('Codex');
    act(() => rows[0]!.click());
    expect(onOpenHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Session 1' }),
      project,
    );

    act(() => container.querySelector<HTMLButtonElement>('.agent-history-more')!.click());
    await flush();
    expect(listAgentHistorySessions).toHaveBeenLastCalledWith('project-1', 'page-2', 20);
    expect(container.querySelectorAll('.agent-history-row')).toHaveLength(12);

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-project-history-back"]',
    )!.click());
    expect(container.querySelector('[data-testid="agent-projects"]')).not.toBeNull();
  });
  Object.defineProperty(window, 'ezterminalDesktop', {
    configurable: true,
    value: originalEzTerminalDesktop,
  });

  it('orders attention, projects, active, and recent in the document', async () => {
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        listAgentProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      },
    });
    await renderHub({
      revision: 1,
      items: [
        activity({ id: 'recent', status: 'idle' }),
        activity({ id: 'active', status: 'working' }),
        activity({ id: 'attention', status: 'blocked' }),
      ],
    });

    const ordered = Array.from(container.querySelectorAll<HTMLElement>(
      '.agent-group, [data-testid="agent-projects"]',
    )).map((element) => element.dataset.testid);
    expect(ordered).toEqual([
      'agent-group-attention',
      'agent-projects',
      'agent-group-active',
      'agent-group-recent',
    ]);
  });

  it('prepares a selected provider and hands a prompt-free new-chat bootstrap to the workspace', async () => {
    const project = {
      projectId: 'project-1',
      name: 'Project',
      primaryRoot: 'C:\\Project',
      additionalRoots: ['C:\\Shared'],
      pinned: false,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: 20,
    } as const;
    const launcher = {
      launcherId: 'claude',
      provider: 'claude' as const,
      name: 'Claude Code',
      supportsAdditionalRoots: true,
    };
    const listAgentProjects = vi.fn(async () => ({ items: [project], nextCursor: null }));
    const listAgentProjectLaunchers = vi.fn(async () => [launcher]);
    const prepareAgentLaunch = vi.fn(async () => ({
      ok: true as const,
      target: { kind: 'project' as const, projectId: project.projectId },
      launcherId: launcher.launcherId,
      provider: launcher.provider,
      name: launcher.name,
      cwd: project.primaryRoot,
      roots: [project.primaryRoot, ...project.additionalRoots],
      ignoredAdditionalRootCount: 0,
      revision: 'revision-1',
    }));
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        listAgentProjects,
        listAgentProjectLaunchers,
        prepareAgentLaunch,
      },
    });
    const onLaunchAgent = vi.fn();
    await renderHub({ revision: 1, items: [] }, { onLaunchAgent });

    act(() => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-project-new-chat-project-1"]',
      )!.click();
    });
    await flush();
    const launcherSelect = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="agent-launch-agent"]',
    )!;
    act(() => {
      launcherSelect.value = 'claude';
      launcherSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="agent-launch-submit"]')!.click();
    });
    await flush();

    expect(prepareAgentLaunch).toHaveBeenCalledWith(
      { kind: 'project', projectId: 'project-1' },
      'claude',
    );
    expect(onLaunchAgent).toHaveBeenCalledWith({
      kind: 'new-chat',
      target: { kind: 'project', projectId: 'project-1' },
      launcherId: 'claude',
      provider: 'claude',
      name: 'Claude Code',
      cwd: 'C:\\Project',
      revision: 'revision-1',
    }, {
      projectId: 'project-1',
      projectName: 'Project',
      titleMode: 'generated',
    });
    expect(JSON.stringify(onLaunchAgent.mock.calls)).not.toContain('prompt');
  });

  it('opens a project session as a plain terminal with a fixed project location', async () => {
    const project = {
      projectId: 'project-1',
      name: 'Project',
      primaryRoot: 'C:\\Project',
      additionalRoots: [],
      pinned: false,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: 20,
    } as const;
    const prepareAgentLaunch = vi.fn();
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        listAgentProjects: vi.fn(async () => ({ items: [project], nextCursor: null })),
        listAgentProjectLaunchers: vi.fn(async () => []),
        prepareAgentLaunch,
      },
    });
    const onLaunchAgent = vi.fn();
    const onOpenProjectTerminal = vi.fn();
    await renderHub(
      { revision: 1, items: [] },
      { onLaunchAgent, onOpenProjectTerminal },
    );

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-project-new-chat-project-1"]',
    )!.click());
    await flush();
    expect(document.body.querySelector('[data-testid="agent-launch-project"]')).toBeNull();
    const type = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="agent-launch-session-type"]',
    )!;
    act(() => {
      type.value = 'terminal';
      type.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.body.querySelector('[data-testid="agent-launch-agent"]')).toBeNull();
    act(() => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="agent-launch-submit"]',
    )!.click());

    expect(onOpenProjectTerminal).toHaveBeenCalledWith({
      projectId: 'project-1',
      projectName: 'Project',
      titleMode: 'generated',
    });
    expect(onLaunchAgent).not.toHaveBeenCalled();
    expect(prepareAgentLaunch).not.toHaveBeenCalled();
  });

  it('starts only the Planner from one frozen target commit in a managed worktree', async () => {
    const plannerId = '123e4567-e89b-12d3-a456-426614174000';
    const workerId = '123e4567-e89b-12d3-a456-426614174001';
    const teamId = '123e4567-e89b-12d3-a456-426614174010';
    const runId = '123e4567-e89b-12d3-a456-426614174020';
    const project = {
      projectId: 'project-1', name: 'Project', primaryRoot: 'C:\\Project', additionalRoots: [],
      pinned: false, saved: true, sessionCount: 0, providers: [], lastActiveAt: 20,
    } as const;
    const personas = [
      {
        personaId: plannerId, revision: 1, name: 'Planner', icon: 'search' as const,
        role: 'Planner', instructions: 'Plan only.',
        launch: { provider: 'codex' as const, sandbox: 'read-only' as const },
        createdAt: 1, updatedAt: 1,
      },
      {
        personaId: workerId, revision: 1, name: 'Worker', icon: 'code' as const,
        role: 'Worker', instructions: 'Implement.',
        launch: { provider: 'claude' as const, permissionMode: 'acceptEdits' as const },
        createdAt: 1, updatedAt: 1,
      },
    ];
    const team = {
      teamId, revision: 1, name: 'Core', instructions: 'Keep scopes bounded.',
      defaultGoal: {
        outcome: 'Ship Team launch',
        acceptanceCriteria: ['Planner starts before any other member.'],
      },
      personaIds: [plannerId, workerId], plannerPersonaId: plannerId, createdAt: 1, updatedAt: 1,
    };
    const run: AgentTeamRun = {
      schemaVersion: 1,
      runId,
      revision: 1,
      projectId: project.projectId,
      projectName: project.name,
      projectGoal: 'Maintain reliable terminal collaboration',
      goal: 'Ship Team launch',
      goalAcceptanceCriteria: ['Planner starts before any other member.'],
      targetBranch: 'main',
      validationConfigRevision: 1,
      validationCommands: [],
      team,
      personas,
      plannerPersonaId: plannerId,
      phase: 'preparing-planner',
      slots: personas.map((persona) => ({ personaId: persona.personaId, state: 'planned' as const, updatedAt: 1 })),
      baseHead: 'a'.repeat(40),
      baseDirty: false,
      warningAcknowledged: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const teamSnapshot: AgentTeamDesktopSnapshot = {
      revision: 1,
      catalog: {
        revision: 1,
        personas,
        teams: [team],
        capabilities: [
          { provider: 'codex', available: true, supportsModel: true, effortValues: [], permissionValues: ['read-only', 'workspace-write'], modelAvailability: 'launch-time' },
          { provider: 'claude', available: true, supportsModel: true, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'], permissionValues: ['plan', 'manual', 'acceptEdits'], modelAvailability: 'launch-time' },
        ],
      },
      runRevision: 0,
      runs: [],
    };
    const opened = {
      worktreeId: 'worktree-1', repoId: 'repo-1', path: 'C:\\Worktrees\\planner',
      branch: 'ez/team-planner', head: run.baseHead!, main: false, locked: false, managed: true, prunable: false,
    };
    const executeWorktree = vi.fn(async () => ({ ok: true as const, action: 'create' as const, worktrees: [opened], opened }));
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        listAgentProjects: vi.fn(async () => ({ items: [project], nextCursor: null })),
        executeWorktree,
      },
    });
    const preparedRun: AgentTeamRun = {
      ...run,
      revision: 2,
      slots: [
        {
          personaId: plannerId,
          state: 'prepared',
          branch: 'ez/team-planner',
          rootId: 'root-1',
          workspaceId: 'worktree-1',
          worktreeId: 'worktree-1',
          worktreePath: opened.path,
          updatedAt: 2,
        },
        run.slots[1]!,
      ],
    };
    const describeProjectWorkspace = vi.fn(async () => ({
      ok: true as const,
      project: {
        projectId: project.projectId,
        name: project.name,
        roots: [{ rootId: 'root-1', name: project.name, displayPath: project.primaryRoot, primary: true }],
        workspaces: [
          { workspaceId: 'root-1', rootId: 'root-1', name: 'main', displayPath: project.primaryRoot, kind: 'main' as const, access: 'granted' as const },
          { workspaceId: 'worktree-1', rootId: 'root-1', name: 'planner', displayPath: opened.path, kind: 'managed' as const, access: 'granted' as const },
        ],
      },
    }));
    const createAgentTeamRun = vi.fn(async () => ({ ok: true as const, value: run }));
    const prepareAgentTeamMemberLaunch = vi.fn(async () => ({
      ok: true as const,
      value: {
        run: preparedRun,
        preparation: {
          ok: true as const,
          target: { kind: 'project' as const, projectId: project.projectId, rootId: 'root-1', workspaceId: 'worktree-1' },
          launcherId: 'codex', provider: 'codex' as const, name: 'Codex', cwd: opened.path,
          roots: [opened.path], ignoredAdditionalRootCount: 0, revision: 'launch-revision',
        },
      },
    }));
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace,
        listProjectDocumentDirectory: vi.fn(async () => ({ ok: true, relativePath: '', parent: null, entries: [] })),
        getAgentTeamSnapshot: vi.fn(async () => teamSnapshot),
        onAgentTeamSnapshot: vi.fn(() => () => undefined),
        createAgentTeamRun,
        prepareAgentTeamMemberLaunch,
      } as unknown as EzTerminalDesktopApi,
    });
    const onLaunchAgent = vi.fn();
    await renderHub({ revision: 1, items: [] }, {
      teamSnapshot,
      coordinationSnapshot: {
        revision: 1,
        activityRevision: 1,
        activities: [],
        mergeRequests: [],
        projects: [{
          projectId: project.projectId,
          goal: 'Maintain reliable terminal collaboration',
          defaultTargetBranch: 'main',
          validationCommands: [],
          configRevision: 1,
          counts: { starting: 0, working: 0, blocked: 0, done: 0, idle: 0, error: 0, unknown: 0 },
          participants: [],
          pendingMergeCount: 0,
        }],
      },
      onReadGitStatus: vi.fn(async () => ({ availability: 'ready' as const, tracked: true as const, branch: 'main', changes: [], truncated: false })),
      onOpenProjectDocument: vi.fn(),
      onLaunchAgent,
    });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-project-open-project-1"]')!.click());
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="project-workspace-open-team"]')!.click());
    await flush();
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="agent-team-start"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createAgentTeamRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.projectId,
      teamId,
      goal: 'Ship Team launch',
      acceptanceCriteria: ['Planner starts before any other member.'],
    }));
    expect(document.body.textContent).toContain('Maintain reliable terminal collaboration');
    expect(executeWorktree).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create',
      cwd: project.primaryRoot,
      base: run.baseHead,
    }));
    expect(onLaunchAgent).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      teamMemberRequest: { runId, personaId: plannerId },
    }), expect.objectContaining({ workspaceId: 'worktree-1' }));
  });
});

describe('AgentHub real actions and honest diff', () => {
  it('opens the unified picker with blank agent and location from the global action', async () => {
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        listAgentProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
        listAgentProjectLaunchers: vi.fn(async () => []),
      },
    });
    const onLaunchAgent = vi.fn();
    await renderHub({ revision: 1, items: [] }, { onLaunchAgent });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="agent-new-run"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    await flush();
    expect(document.body.querySelector('[data-testid="agent-launch-picker"]')).not.toBeNull();
    expect(document.body.querySelector<HTMLSelectElement>('[data-testid="agent-launch-agent"]')?.value)
      .toBe('');
    expect(document.body.querySelector<HTMLSelectElement>('[data-testid="agent-launch-project"]')?.value)
      .toBe('');
    expect(onLaunchAgent).not.toHaveBeenCalled();
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
