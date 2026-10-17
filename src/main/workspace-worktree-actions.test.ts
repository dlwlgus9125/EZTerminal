import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import { createWorkspaceWorktree, pathIsWithin, removeWorkspaceWorktree } from './workspace-worktree-actions';

const root = path.resolve('repo');
const tree = path.resolve('repo-worktrees', 'feature');

function deps(projects: Array<{ id: string; rootPath: string }>, after: Array<{ id: string; projectId: string; rootPath: string }>) {
  let snapshot = { projects, workspaces: [] } as unknown as DaemonSnapshot;
  const worktrees = { execute: vi.fn(async () => ({ ok: true, action: 'create', worktrees: [], opened: { path: tree } })) };
  const syncProjects = vi.fn(async () => {
    snapshot = { projects, workspaces: after.map((entry) => ({ ...entry, kind: 'worktree' })) } as unknown as DaemonSnapshot;
  });
  return { worktrees: worktrees as never, getSnapshot: () => snapshot, syncProjects, execute: worktrees.execute };
}

describe('createWorkspaceWorktree', () => {
  it('finds the workspace of a project that is a subfolder of its repository', async () => {
    const d = deps([{ id: 'web', rootPath: path.join(root, 'apps', 'web') }], [{ id: 'web-tree', projectId: 'web', rootPath: path.join(tree, 'apps', 'web') }]);
    expect(await createWorkspaceWorktree(d, 'web', 'feature/login')).toEqual({ ok: true, value: { workspaceId: 'web-tree', path: path.join(tree, 'apps', 'web'), branch: 'feature/login' } });
    expect(d.execute).toHaveBeenCalledWith({ action: 'create', cwd: path.join(root, 'apps', 'web'), branch: 'feature/login', allowDirtyBase: true }, 'desktop');
  });

  it('answers with the asking project’s workspace when two projects share the repository', async () => {
    const d = deps([{ id: 'api', rootPath: path.join(root, 'api') }, { id: 'web', rootPath: path.join(root, 'web') }], [
      { id: 'web-tree', projectId: 'web', rootPath: path.join(tree, 'web') },
      { id: 'api-tree', projectId: 'api', rootPath: path.join(tree, 'api') },
    ]);
    expect(await createWorkspaceWorktree(d, 'api', 'feature/login')).toMatchObject({ ok: true, value: { workspaceId: 'api-tree' } });
  });

  it('refuses unknown projects and unsafe branch names before touching git', async () => {
    const d = deps([{ id: 'p', rootPath: root }], []);
    expect(await createWorkspaceWorktree(d, 'missing', 'feature')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await createWorkspaceWorktree(d, 'p', '--upload-pack=x')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it('treats a folder and what is inside it as the same place, and nothing beside it', () => {
    expect(pathIsWithin(tree, tree)).toBe(true);
    expect(pathIsWithin(path.join(tree, 'web'), tree)).toBe(true);
    expect(pathIsWithin(`${tree}-other`, tree)).toBe(false);
  });
});

describe('removeWorkspaceWorktree', () => {
  const mainRoot = path.resolve('repo');
  const folder = path.resolve('repo-worktrees', 'feature');
  type Row = Record<string, unknown>;

  function cleanup(options: {
    status?: Partial<{ branch: string | undefined; dirty: boolean; ahead: number; merged: boolean }>;
    sessions?: Row[]; agents?: Row[]; turns?: Row[]; approvals?: Row[]; relations?: Row[];
    workspaces?: Row[]; projects?: Row[];
    listed?: Row[]; listedAfterRemove?: Row[]; removeResult?: Row; branchResult?: { deleted: boolean; message?: string };
    syncArchives?: boolean; conflictsFirst?: number;
  } = {}) {
    const calls: string[] = [];
    let snapshot = {
      revision: 7,
      projects: options.projects ?? [{ id: 'P', rootPath: mainRoot }],
      workspaces: options.workspaces ?? [
        { id: 'L', projectId: 'P', kind: 'local', rootPath: mainRoot },
        { id: 'W', projectId: 'P', kind: 'worktree', name: 'feature', rootPath: folder },
      ],
      sessions: options.sessions ?? [], agents: options.agents ?? [], turns: options.turns ?? [],
      approvals: options.approvals ?? [], agentRelations: options.relations ?? [],
    } as unknown as DaemonSnapshot;
    const status = { workspaceId: 'W', branch: 'feature', baseBranch: 'main', dirty: false, ahead: 0, merged: true, ...options.status };
    let conflicts = options.conflictsFirst ?? 0;
    let removeTried = false;
    const worktrees = { execute: vi.fn(async (request: { action: string }) => {
      calls.push(`git ${request.action}`);
      const listed = options.listed ?? [{ worktreeId: 'wt-1', path: folder, managed: true, main: false, locked: false }];
      if (request.action === 'list') return { ok: true, action: 'list', worktrees: removeTried ? options.listedAfterRemove ?? listed : listed };
      removeTried = true;
      return options.removeResult ?? { ok: true, action: 'remove', worktrees: [] };
    }) };
    const service = {
      status: vi.fn(async () => { calls.push('status'); return status; }),
      deleteMergedBranch: vi.fn(async (_root: string, branch: string) => { calls.push(`branch -d ${branch}`); return options.branchResult ?? { deleted: true }; }),
    };
    const executeCommand = vi.fn(async (command: DaemonCommand) => {
      if (conflicts > 0) {
        conflicts -= 1;
        return { ok: false, status: 'rejected', commandId: command.commandId, revision: 7, error: { code: 'revision-conflict', message: 'stale', retryable: true } } as const;
      }
      const target = 'sessionId' in command.payload ? command.payload.sessionId : (command.payload as { workspaceId: string }).workspaceId;
      calls.push(`${command.type} ${target}`);
      if (command.type === 'workspace.archive') {
        snapshot = { ...snapshot, workspaces: snapshot.workspaces.map((entry) => entry.id === target ? { ...entry, archivedAt: 'now' } : entry) } as DaemonSnapshot;
      }
      return { ok: true, status: 'applied', commandId: command.commandId, revision: 8, eventSequence: 1 } as const;
    });
    const syncProjects = vi.fn(async () => {
      calls.push('sync');
      if (options.syncArchives ?? true) {
        snapshot = { ...snapshot, workspaces: snapshot.workspaces.map((entry) => pathIsWithin(entry.rootPath, folder) && entry.kind === 'worktree' ? { ...entry, archivedAt: 'now' } : entry) } as DaemonSnapshot;
      }
    });
    const deps = {
      worktrees: worktrees as never, service: service as never, getSnapshot: () => snapshot, syncProjects, executeCommand,
      releaseProviders: vi.fn(async () => { calls.push('release'); }), createId: (() => { let n = 0; return () => `id-${n++}`; })(),
    };
    return { deps, calls, executeCommand, worktrees };
  }

  const chat = (id: string, workspaceId = 'W', kind = 'agent', state = 'idle') => ({ id, workspaceId, kind, state });
  const agent = (sessionId: string, extra: Row = {}) => ({ sessionId, state: 'idle', queuedTurnCount: 0, ...extra });

  it('archives the chats, lets their processes go, removes the folder, deletes the branch and syncs, in that order', async () => {
    const c = cleanup({
      sessions: [chat('lead'), chat('helper'), chat('native'), chat('elsewhere', 'L')],
      agents: [agent('lead'), agent('helper'), agent('native'), agent('elsewhere')],
      relations: [{ parentSessionId: 'lead', childSessionId: 'native', owner: 'provider-native' }],
    });
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toEqual({ ok: true, value: { branch: 'feature', branchDeleted: true, archivedChats: 2, notes: [] } });
    // A provider's own subagent follows its parent; the chat in the main checkout is not touched.
    expect(c.calls).toEqual(['git list', 'status', 'agent.archive lead', 'agent.archive helper', 'release', 'git remove', 'branch -d feature', 'sync']);
    expect(c.worktrees.execute).toHaveBeenCalledWith({ action: 'remove', cwd: mainRoot, worktreeId: 'wt-1' }, 'desktop');
    expect(c.executeCommand.mock.calls[0]![0]).toMatchObject({ principal: { kind: 'desktop', id: 'worktree-cleanup' }, expectedRevision: 7 });
  });

  it.each([
    ['uncommitted changes', { status: { dirty: true } }, 'dirty-worktree'],
    ['commits not merged yet', { status: { ahead: 2, merged: false } }, 'not-merged'],
    ['a branch that was never merged', { status: { merged: false } }, 'not-merged'],
    ['a detached checkout', { status: { branch: undefined } }, 'not-merged'],
    ['a worktree EZTerminal did not create', { listed: [{ worktreeId: 'x', path: folder, managed: false, main: false, locked: false }] }, 'invalid'],
    ['a locked worktree', { listed: [{ worktreeId: 'x', path: folder, managed: true, main: false, locked: true }] }, 'invalid'],
    ['a turn in flight', { sessions: [chat('lead')], agents: [agent('lead', { currentTurnId: 't1' })] }, 'in-use'],
    ['a queued turn', { sessions: [chat('lead')], agents: [agent('lead', { queuedTurnCount: 1 })] }, 'in-use'],
    ['an approval waiting', { sessions: [chat('lead')], agents: [agent('lead')], approvals: [{ sessionId: 'lead', state: 'pending' }] }, 'in-use'],
    ['a terminal still open there', { sessions: [chat('shell', 'W', 'terminal', 'running')] }, 'in-use'],
  ] as const)('touches nothing when there is %s', async (_label, options, reason) => {
    const c = cleanup(options as never);
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toMatchObject({ ok: false, reason });
    expect(c.executeCommand).not.toHaveBeenCalled();
    expect(c.calls).not.toContain('git remove');
    expect(c.calls).not.toContain('release');
  });

  it('refuses the main checkout, a planning run’s worktree and unknown ids before asking git', async () => {
    const c = cleanup({ workspaces: [
      { id: 'L', projectId: 'P', kind: 'local', rootPath: mainRoot },
      { id: 'planning-workspace-1', projectId: 'P', kind: 'worktree', rootPath: folder },
    ] });
    for (const id of ['L', 'planning-workspace-1', 'missing', 42]) expect(await removeWorkspaceWorktree(c.deps, id)).toMatchObject({ ok: false, reason: 'not-found' });
    expect(c.calls).toEqual([]);
  });

  it('still succeeds when git keeps the branch, and says why', async () => {
    const c = cleanup({ branchResult: { deleted: false, message: 'not fully merged' } });
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toEqual({ ok: true, value: {
      branch: 'feature', branchDeleted: false, archivedChats: 0, notes: ['The branch feature was kept: not fully merged'],
    } });
  });

  it('says the chats were already archived when git cannot remove the folder', async () => {
    const c = cleanup({
      sessions: [chat('lead')], agents: [agent('lead')],
      removeResult: { ok: false, error: 'WORKTREE_IN_USE', message: 'The worktree is still open in a terminal.' },
    });
    const result = await removeWorkspaceWorktree(c.deps, 'W');
    expect(result).toMatchObject({ ok: false, reason: 'in-use' });
    expect(result.ok ? '' : result.message).toContain('1 chat(s) were already archived; cleaning up again is safe.');
    expect(c.calls).not.toContain('sync');
  });

  it('finishes the job when git forgot the worktree although its remove failed', async () => {
    const c = cleanup({
      sessions: [chat('lead')], agents: [agent('lead')], listedAfterRemove: [],
      removeResult: { ok: false, error: 'GIT_FAILED', message: 'failed to delete' },
    });
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toEqual({ ok: true, value: { branch: 'feature', branchDeleted: true, archivedChats: 1, notes: [] } });
    expect(c.calls).toEqual(['git list', 'status', 'agent.archive lead', 'release', 'git remove', 'git list', 'branch -d feature', 'sync']);
  });

  it('keeps the branch and the workspace when git still has the worktree after a failed remove', async () => {
    const c = cleanup({ removeResult: { ok: false, error: 'GIT_FAILED', message: 'failed' } });
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toMatchObject({ ok: false, reason: 'git-failed' });
    expect(c.calls).not.toContain('branch -d feature');
    expect(c.calls).not.toContain('sync');
  });

  it('archives the workspace itself when the sync leaves it listed, and retries a stale revision', async () => {
    const c = cleanup({ syncArchives: false, conflictsFirst: 1 });
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toMatchObject({ ok: true });
    expect(c.calls.slice(-2)).toEqual(['sync', 'workspace.archive W']);
    expect(c.executeCommand).toHaveBeenCalledTimes(2);
  });

  it('cleans up every project’s workspace inside the folder', async () => {
    const c = cleanup({
      projects: [{ id: 'P', rootPath: mainRoot }, { id: 'web', rootPath: path.join(mainRoot, 'web') }],
      workspaces: [
        { id: 'W', projectId: 'P', kind: 'worktree', name: 'feature', rootPath: folder },
        { id: 'W-web', projectId: 'web', kind: 'worktree', name: 'feature', rootPath: path.join(folder, 'web') },
        { id: 'beside', projectId: 'P', kind: 'worktree', name: 'other', rootPath: `${folder}-other` },
      ],
      sessions: [chat('lead'), chat('web-chat', 'W-web'), chat('beside-chat', 'beside')],
      agents: [agent('lead'), agent('web-chat'), agent('beside-chat')],
    });
    expect(await removeWorkspaceWorktree(c.deps, 'W')).toMatchObject({ ok: true, value: { archivedChats: 2 } });
    expect(c.calls).toContain('agent.archive web-chat');
    expect(c.calls).not.toContain('agent.archive beside-chat');
  });
});
