import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import type { ExecutionRun } from '../shared/planning-execution';
import type { PlanningResultRecord } from '../shared/planning-result';
import { resultHash } from './planning-result-repository';
import { RUN_RETENTION_FILE, RunWorktreeCleanup } from './run-worktree-cleanup';
import { GitRunner, WorktreeService } from './worktree-service';

const bases = new Set<string>();
afterEach(async () => {
  for (const base of bases) await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  bases.clear();
});
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/**
 * A project whose flow has four finished runs; the oldest (r1) left an attempt work folder holding its captured result,
 * with an idle stage conversation in it — what the person's 작업 폴더 정리 finds.
 */
async function project(options: { turn?: boolean } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'ez-run-cleanup-'));
  bases.add(base);
  const repo = path.join(base, 'repo');
  const userData = path.join(base, 'user-data');
  mkdirSync(repo); mkdirSync(userData);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  git(repo, ['config', 'user.name', 'EZTerminal Tests']);
  writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  let n = 0;
  const worktrees = new WorktreeService({ userDataDir: userData, newId: () => `worktree-${String(++n).padStart(8, '0')}` });
  await worktrees.init();
  const created = await worktrees.execute({ action: 'create', cwd: repo, branch: 'ezterminal/attempt-1' }, 'desktop');
  if (!created.ok || !created.opened) throw new Error('create failed');
  const folder = created.opened.path;
  const baseCommit = git(folder, ['rev-parse', 'HEAD']).trim();
  writeFileSync(path.join(folder, 'README.md'), 'updated\n');
  git(folder, ['add', '-A']);
  const tree = git(folder, ['write-tree']).trim();
  const commit = git(folder, ['-c', 'user.name=EZTerminal', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', baseCommit, '-m', 'result']).trim();
  git(folder, ['update-ref', `refs/ezterminal/results/${resultHash(['P', 'A1'])}`, commit]);
  const run = (runId: string, minute: number, attempts: unknown[] = []) => ({ runId, state: 'completed', createdAt: new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 9, 26, 0, minute, 1)).toISOString(), attempts, preparation: { workflow: { subprojectId: 'flow' } } }) as unknown as ExecutionRun;
  const runs = [run('r1', 1, [{ attemptId: 'A1', state: 'succeeded', workspaceId: 'planning-workspace-1' }]), run('r2', 2), run('r3', 3), run('r4', 4)];
  const record = { rootPath: folder, baseCommit, commit } as unknown as PlanningResultRecord;
  const snapshot = {
    projects: [{ id: 'P', rootPath: repo }],
    workspaces: [{ id: 'planning-workspace-1', projectId: 'P', rootPath: folder, kind: 'worktree' }],
    sessions: [{ id: 'planning-s1', workspaceId: 'planning-workspace-1', kind: 'agent', state: 'idle', projectId: 'P' }],
    agents: [{ sessionId: 'planning-s1', state: 'idle', queuedTurnCount: 0, ...(options.turn ? { currentTurnId: 'turn-1' } : {}) }],
    turns: [], approvals: [], agentRelations: [], revision: 1,
  } as unknown as DaemonSnapshot;
  const commands: DaemonCommand[] = [];
  const cleanup = new RunWorktreeCleanup({
    directory: userData, getSnapshot: () => snapshot, runs: () => runs, readResult: async (_projectId, attemptId) => (attemptId === 'A1' ? record : null),
    resultBusy: async () => false, worktrees, git: new GitRunner(),
    executeCommand: vi.fn(async (command: DaemonCommand) => { commands.push(command); return { ok: true, status: 'committed', commandId: command.commandId, revision: 2 } as never; }),
    releaseProviders: async () => undefined, liveTerminalIds: () => new Set(), folderReleaseMs: 0,
  });
  return { repo, userData, folder, baseCommit, commit, cleanup, commands };
}

describe('RunWorktreeCleanup (real Git)', () => {
  it('offers an older run’s folder, archives what was rooted there and removes it, and remembers it', async () => {
    const p = await project();
    const plan = await p.cleanup.plan('P');
    expect(plan.runs).toEqual([expect.objectContaining({ runId: 'r1', runNumber: 1, why: 'older', folders: [expect.objectContaining({ kind: 'attempt', state: 'removable' })] })]);
    expect(await p.cleanup.cleanup('P', ['r1'])).toEqual({ removed: 1, kept: [] });
    expect(existsSync(p.folder)).toBe(false);
    expect(p.commands.map(command => command.type)).toEqual(['agent.archive', 'workspace.archive']);
    // Its result is still kept by the shared ref.
    expect(git(p.repo, ['rev-parse', `refs/ezterminal/results/${resultHash(['P', 'A1'])}`]).trim()).toBe(p.commit);
    const again = await p.cleanup.plan('P');
    expect(again.cleanedRunIds).toEqual(['r1']);
    expect(again.runs[0]!.folders[0]).toMatchObject({ state: 'removed' });
    const saved = JSON.parse(await fs.readFile(path.join(p.userData, RUN_RETENTION_FILE), 'utf8')) as { folders: { state: string; worktreeId?: string }[] };
    expect(saved.folders).toEqual([expect.objectContaining({ state: 'removed', worktreeId: 'worktree-00000001' })]);
  }, 60_000);

  it('keeps a folder holding a person’s file and never archives anything for it', async () => {
    const p = await project();
    writeFileSync(path.join(p.folder, 'notes.txt'), 'mine\n');
    const plan = await p.cleanup.plan('P');
    expect(plan.runs[0]!.folders[0]).toMatchObject({ state: 'kept', reason: expect.stringContaining('does not keep') });
    expect(await p.cleanup.cleanup('P', ['r1'])).toMatchObject({ removed: 0, kept: [expect.objectContaining({ path: p.folder })] });
    expect(existsSync(path.join(p.folder, 'notes.txt'))).toBe(true);
    expect(p.commands).toEqual([]);
  }, 60_000);

  it('leaves a folder whose conversation is working, and one whose kept result no longer matches its record', async () => {
    const busy = await project({ turn: true });
    expect(await busy.cleanup.cleanup('P', ['r1'])).toMatchObject({ removed: 0, kept: [expect.objectContaining({ reason: expect.stringContaining('still runs') })] });
    expect(existsSync(busy.folder)).toBe(true);
    expect(busy.commands).toEqual([]);
    const moved = await project();
    git(moved.repo, ['update-ref', `refs/ezterminal/results/${resultHash(['P', 'A1'])}`, moved.baseCommit]);
    expect((await moved.cleanup.plan('P')).runs[0]!.folders[0]).toMatchObject({ state: 'kept', reason: expect.stringContaining('does not match') });
  }, 60_000);

  it('offers nothing of the newest three runs', async () => {
    const p = await project();
    const plan = await p.cleanup.plan('P');
    expect(plan.runs.map(run => run.runId)).toEqual(['r1']);
  }, 60_000);
});
