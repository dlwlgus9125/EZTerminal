import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import { createWorkspaceWorktree, pathIsWithin, removeWorkspaceWorktree } from './workspace-worktree-actions';
import { WorkspaceWorktreeService } from './workspace-worktree-service';
import { WorktreeService } from './worktree-service';

const bases: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const base of bases.splice(0)) await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A program working in the folder, the way a terminal opened there would (or a chat's process that is exiting). */
function hold(folder: string, exitAfterMs?: number): ChildProcess {
  const script = exitAfterMs ? `setTimeout(() => {}, ${exitAfterMs})` : 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', script], { cwd: folder, stdio: 'ignore', windowsHide: true });
  children.push(child);
  return child;
}

async function release(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true });
}

/**
 * A repository with one or more projects in it and a stand-in for the daemon: a sync turns new
 * managed worktrees into workspaces (one per project) and archives those whose folder is gone.
 */
async function setup(projectFolders: readonly string[] = ['']) {
  const base = mkdtempSync(path.join(tmpdir(), 'ezterm-cleanup-'));
  bases.push(base);
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const folder of projectFolders) {
    mkdirSync(path.join(repo, folder), { recursive: true });
    writeFileSync(path.join(repo, folder, 'README.md'), 'initial\n');
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  const realRepo = await fs.realpath(repo);
  const userData = path.join(base, 'user-data');
  mkdirSync(userData);
  const worktrees = new WorktreeService({ userDataDir: userData });
  await worktrees.init();
  const service = new WorkspaceWorktreeService();
  const projects = projectFolders.map((folder, index) => ({ id: `P${index}`, rootPath: path.join(realRepo, folder) }));
  let snapshot = {
    revision: 1, projects, sessions: [], agents: [], turns: [], approvals: [], agentRelations: [],
    workspaces: projects.map((project) => ({ id: `${project.id}-local`, projectId: project.id, kind: 'local', name: 'local', rootPath: project.rootPath })),
  } as unknown as DaemonSnapshot;
  const commands: string[] = [];
  const syncProjects = async () => {
    const listed = await worktrees.execute({ action: 'list', cwd: realRepo }, 'desktop');
    const workspaces = snapshot.workspaces.map((entry) => entry.kind === 'worktree' && !entry.archivedAt && !existsSync(entry.rootPath) ? { ...entry, archivedAt: 'gone' } : entry);
    for (const entry of listed.ok ? listed.worktrees : []) {
      if (entry.main || workspaces.some((workspace) => workspace.kind === 'worktree' && pathIsWithin(workspace.rootPath, entry.path))) continue;
      for (const project of projects) {
        workspaces.push({ id: `${project.id}-${path.basename(entry.path)}`, projectId: project.id, kind: 'worktree', name: entry.branch ?? 'detached', rootPath: path.join(entry.path, path.relative(realRepo, project.rootPath)) } as never);
      }
    }
    snapshot = { ...snapshot, revision: snapshot.revision + 1, workspaces } as DaemonSnapshot;
  };
  const deps = {
    worktrees, service, getSnapshot: () => snapshot, syncProjects,
    executeCommand: async (command: DaemonCommand) => {
      commands.push(command.type);
      return { ok: true as const, status: 'applied' as const, commandId: command.commandId, revision: snapshot.revision, eventSequence: 1 };
    },
    releaseProviders: async () => undefined,
    liveTerminalIds: () => new Set<string>(),
  };
  const create = async (projectId = 'P0', branch = 'feature/notes') => {
    const created = await createWorkspaceWorktree(deps, projectId, branch);
    if (!created.ok) throw new Error(created.message);
    return created.value;
  };
  const commitAndMerge = async (workspace: { workspaceId: string; path: string }, file = 'notes.md', merge = true) => {
    writeFileSync(path.join(workspace.path, file), 'from the worktree\n');
    const mainRoot = snapshot.projects.find((project) => snapshot.workspaces.find((entry) => entry.id === workspace.workspaceId)?.projectId === project.id)!.rootPath as string;
    const target = { workspaceId: workspace.workspaceId, rootPath: workspace.path, mainRoot };
    expect(await service.commit(target, 'Add notes')).toMatchObject({ ok: true });
    if (merge) expect(await service.merge(target)).toMatchObject({ ok: true });
  };
  const branches = () => git(realRepo, 'branch', '--list', '--format=%(refname:short)').split(/\r?\n/u).filter(Boolean);
  const addChat = (workspaceId: string) => {
    snapshot = { ...snapshot, sessions: [{ id: 'chat', projectId: 'P0', workspaceId, kind: 'agent', state: 'idle' }],
      agents: [{ sessionId: 'chat', state: 'idle', queuedTurnCount: 0 }] } as unknown as DaemonSnapshot;
  };
  return { repo: realRepo, deps, create, commitAndMerge, branches, commands, addChat, snapshot: () => snapshot };
}

describe('removeWorkspaceWorktree with git', () => {
  it('removes a merged worktree, deletes its branch and forgets the workspace', async () => {
    const s = await setup();
    const created = await s.create();
    await s.commitAndMerge(created);
    expect(await removeWorkspaceWorktree(s.deps, created.workspaceId)).toEqual({ ok: true, value: { branch: 'feature/notes', branchDeleted: true, archivedChats: 0, notes: [] } });
    expect(existsSync(created.path)).toBe(false);
    expect(s.branches()).toEqual(['main']);
    expect(s.snapshot().workspaces.find((entry) => entry.id === created.workspaceId)?.archivedAt).toBeDefined();
    expect(git(s.repo, 'show', 'HEAD:notes.md')).toBe('from the worktree\n');
  });

  it('keeps work that is not merged, and a worktree that has nothing in it yet', async () => {
    const s = await setup();
    const unmerged = await s.create('P0', 'feature/unmerged');
    await s.commitAndMerge(unmerged, 'notes.md', false);
    expect(await removeWorkspaceWorktree(s.deps, unmerged.workspaceId)).toMatchObject({ ok: false, reason: 'not-merged' });
    const fresh = await s.create('P0', 'feature/fresh');
    expect(await removeWorkspaceWorktree(s.deps, fresh.workspaceId)).toMatchObject({ ok: false, reason: 'not-merged' });
    expect(existsSync(unmerged.path) && existsSync(fresh.path)).toBe(true);
    expect(s.branches()).toEqual(['feature/fresh', 'feature/unmerged', 'main']);
  });

  it('removes the whole folder for projects that are subfolders of one repository', async () => {
    const s = await setup(['api', 'web']);
    const created = await s.create('P1', 'feature/web');
    expect(created.workspaceId).toMatch(/^P1-/u);
    await s.commitAndMerge(created);
    expect(await removeWorkspaceWorktree(s.deps, created.workspaceId)).toMatchObject({ ok: true, value: { branchDeleted: true } });
    expect(existsSync(path.dirname(created.path))).toBe(false);
    // The api project's workspace in the same folder went with it.
    expect(s.snapshot().workspaces.filter((entry) => entry.kind === 'worktree' && !entry.archivedAt)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('refuses while a program works in the folder, touching nothing, and succeeds once it is gone', async () => {
    const s = await setup();
    const created = await s.create();
    await s.commitAndMerge(created);
    const holder = hold(created.path);
    await new Promise((resolve) => holder.once('spawn', resolve));
    const first = await removeWorkspaceWorktree(s.deps, created.workspaceId);
    expect(first).toMatchObject({ ok: false, reason: 'in-use' });
    // Git was never asked: the checkout, git's record of it and the branch are all still there.
    expect(existsSync(path.join(created.path, '.git'))).toBe(true);
    expect(existsSync(path.join(created.path, 'notes.md'))).toBe(true);
    expect(git(s.repo, 'worktree', 'list')).toContain(path.basename(created.path));
    expect(s.branches()).toEqual(['feature/notes', 'main']);
    await release(holder);
    expect(await removeWorkspaceWorktree(s.deps, created.workspaceId)).toMatchObject({ ok: true, value: { branchDeleted: true } });
    expect(existsSync(created.path)).toBe(false);
    expect(s.branches()).toEqual(['main']);
    expect(s.snapshot().workspaces.find((entry) => entry.id === created.workspaceId)?.archivedAt).toBeDefined();
  });

  it.runIf(process.platform === 'win32')('waits for an archived chat’s process to let go of the folder', async () => {
    const s = await setup();
    const created = await s.create();
    await s.commitAndMerge(created);
    s.addChat(created.workspaceId);
    const exiting = hold(created.path, 2_000);
    await new Promise((resolve) => exiting.once('spawn', resolve));
    expect(await removeWorkspaceWorktree({ ...s.deps, folderReleaseMs: 15_000 }, created.workspaceId))
      .toMatchObject({ ok: true, value: { archivedChats: 1, branchDeleted: true } });
    expect(s.commands).toEqual(['agent.archive']);
    expect(existsSync(created.path)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('finishes a worktree git removed only partly, leaving its branch alone', async () => {
    const s = await setup();
    const created = await s.create();
    await s.commitAndMerge(created);
    mkdirSync(path.join(created.path, 'src'));
    const holder = hold(path.join(created.path, 'src'));
    await new Promise((resolve) => holder.once('spawn', resolve));
    // What git leaves when a program holds the folder: its record and the files go, empty folders stay.
    expect(() => git(s.repo, 'worktree', 'remove', created.path)).toThrow();
    expect(existsSync(created.path)).toBe(true);
    expect(await removeWorkspaceWorktree(s.deps, created.workspaceId)).toMatchObject({ ok: false, reason: 'in-use' });
    await release(holder);
    const finished = await removeWorkspaceWorktree(s.deps, created.workspaceId);
    expect(finished).toMatchObject({ ok: true, value: { branchDeleted: false, notes: ['Git had already removed this worktree, so its branch was not touched.'] } });
    expect(existsSync(created.path)).toBe(false);
    expect(s.branches()).toEqual(['feature/notes', 'main']);
    expect(s.snapshot().workspaces.find((entry) => entry.id === created.workspaceId)?.archivedAt).toBeDefined();
  });
});
