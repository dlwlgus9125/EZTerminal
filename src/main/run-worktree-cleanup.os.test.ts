import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import type { ExecutionRun } from '../shared/planning-execution';
import type { PlanningResultRecord } from '../shared/planning-result';
import { FileService } from './file-service';
import { resultHash } from './planning-result-repository';
import { RUN_RETENTION_FILE, RunWorktreeCleanup } from './run-worktree-cleanup';
import { GitRunner, WorktreeService } from './worktree-service';

/** A 1×1 PNG: bytes a text decoding would break. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
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
async function project(options: { turn?: boolean; onRelease?: (folder: string, repo: string, base: string) => void; busy?: () => boolean; integration?: 'passed' | 'validating' } = {}) {
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
  writeFileSync(path.join(folder, 'pixel.png'), PIXEL);
  git(folder, ['add', '-A']);
  const tree = git(folder, ['write-tree']).trim();
  const commit = git(folder, ['-c', 'user.name=EZTerminal', '-c', 'user.email=e@localhost', 'commit-tree', tree, '-p', baseCommit, '-m', 'result']).trim();
  git(folder, ['update-ref', `refs/ezterminal/results/${resultHash(['P', 'A1'])}`, commit]);
  const run = (runId: string, minute: number, attempts: unknown[] = []) => ({ runId, state: 'completed', createdAt: new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString(),
    startedAt: new Date(Date.UTC(2026, 9, 26, 0, minute, 1)).toISOString(), attempts, preparation: { workflow: { subprojectId: 'flow' } } }) as unknown as ExecutionRun;
  const runs = [run('r1', 1, [{ attemptId: 'A1', state: 'succeeded', workspaceId: 'planning-workspace-1' }]), run('r2', 2), run('r3', 3), run('r4', 4)];
  const record = { rootPath: folder, baseCommit, commit } as unknown as PlanningResultRecord;
  // The run's results combined in their own worktree, adopted as the integration result.
  let integration: Record<string, unknown> | null = null;
  if (options.integration) {
    const combined = await worktrees.execute({ action: 'create', cwd: repo, branch: 'ezterminal/integration-1', base: baseCommit, allowDirtyBase: true }, 'desktop');
    if (!combined.ok || !combined.opened) throw new Error('integration create failed');
    const at = combined.opened.path;
    git(at, ['-c', 'user.name=E', '-c', 'user.email=e@localhost', 'cherry-pick', commit]);
    const candidateCommit = git(at, ['rev-parse', 'HEAD']).trim();
    git(at, ['update-ref', `refs/ezterminal/integrations/${resultHash(['P', 'r1'])}`, candidateCommit]);
    integration = { status: options.integration, workspacePath: at, candidateCommit, ...(options.integration === 'passed' ? { successfulCommit: candidateCommit } : {}) };
  }
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
    readIntegration: async (_projectId, runId) => (runId === 'r1' ? integration as never : null),
    resultBusy: async () => options.busy?.() ?? false, worktrees, git: new GitRunner(),
    preview: (filePath, handle) => new FileService({ trashItem: async () => undefined }).readFilePreview(filePath, handle),
    executeCommand: vi.fn(async (command: DaemonCommand) => { commands.push(command); return { ok: true, status: 'committed', commandId: command.commandId, revision: 2 } as never; }),
    releaseProviders: async () => { options.onRelease?.(folder, repo, baseCommit); }, liveTerminalIds: () => new Set(), folderReleaseMs: 0,
  });
  return { repo, userData, folder, baseCommit, commit, cleanup, commands, snapshot, worktrees, record, integration };
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
    expect(again.cleaned).toEqual([{ runId: 'r1', attemptId: 'A1', kind: 'attempt' }]);
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

  it('reads a cleaned folder’s files from the run’s kept result, and nothing it cannot vouch for', async () => {
    const p = await project();
    expect(await p.cleanup.folderState(p.folder)).toEqual({ state: 'live' });
    await p.cleanup.cleanup('P', ['r1']);
    expect(await p.cleanup.folderState(p.folder)).toEqual({ state: 'cleaned', root: p.folder, result: true });
    expect(await p.cleanup.readFile(path.join(p.folder, 'README.md'))).toMatchObject({ ok: true, kind: 'text', content: 'updated\n', name: 'README.md' });
    const image = await p.cleanup.readFile(path.join(p.folder, 'pixel.png'));
    expect(image).toMatchObject({ ok: true, kind: 'image', mime: 'image/png', width: 1, height: 1 });
    expect(Buffer.from((image as { bytes: Uint8Array }).bytes).equals(PIXEL)).toBe(true);
    // A file the result does not hold, a path out of the folder, and the folder itself are not read.
    expect(await p.cleanup.readFile(path.join(p.folder, 'notes.txt'))).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') });
    expect(await p.cleanup.readFile(path.join(p.folder, '..', 'repo', 'README.md'))).toMatchObject({ ok: false });
    expect(await p.cleanup.readFile(p.folder)).toMatchObject({ ok: false });
    // Once the shared ref no longer names the recorded result, nothing is read from it.
    git(p.repo, ['update-ref', `refs/ezterminal/results/${resultHash(['P', 'A1'])}`, p.baseCommit]);
    expect(await p.cleanup.folderState(p.folder)).toEqual({ state: 'cleaned', root: p.folder, result: false });
    expect(await p.cleanup.readFile(path.join(p.folder, 'README.md'))).toMatchObject({ ok: false, error: expect.stringContaining('no result') });
  }, 60_000);

  it('keeps a folder another project’s workspace is rooted in, and archives nothing for it (Codex I2-7c P1-2)', async () => {
    const p = await project();
    (p.snapshot.workspaces as unknown[]).push({ id: 'other-ws', projectId: 'Q', rootPath: path.join(p.folder, 'sub'), kind: 'local' });
    expect((await p.cleanup.plan('P')).runs[0]!.folders[0]).toMatchObject({ state: 'kept', code: 'shared' });
    expect(await p.cleanup.cleanup('P', ['r1'])).toMatchObject({ removed: 0 });
    expect(p.commands).toEqual([]);
    expect(existsSync(p.folder)).toBe(true);
  }, 60_000);

  it('keeps a folder whose result record names another folder (Codex I2-7c P1-2)', async () => {
    const p = await project();
    (p.record as { rootPath: string }).rootPath = path.join(p.repo, '..', 'elsewhere');
    expect((await p.cleanup.plan('P')).runs[0]!.folders[0]).toMatchObject({ state: 'kept', code: 'result-mismatch' });
  }, 60_000);

  it('keeps the folder when its kept result ref moves while chats are let go (Codex I2-7c P1-4)', async () => {
    const p = await project({ onRelease: (_folder, repo, base) => { git(repo, ['update-ref', `refs/ezterminal/results/${resultHash(['P', 'A1'])}`, base]); } });
    expect(await p.cleanup.cleanup('P', ['r1'])).toMatchObject({ removed: 0, kept: [expect.objectContaining({ code: 'result-mismatch' })] });
    expect(existsSync(p.folder)).toBe(true);
  }, 60_000);

  it('stops when a review of the run starts after the list was shown (advisor, I2-7c)', async () => {
    // Four runs are asked about per plan; the cleanup plans once more, then asks again right before touching the folder.
    let calls = 0;
    const p = await project({ busy: () => ++calls > 8 });
    expect((await p.cleanup.plan('P')).runs[0]!.folders[0]).toMatchObject({ state: 'removable' });
    expect(await p.cleanup.cleanup('P', ['r1'])).toMatchObject({ removed: 0, kept: [expect.objectContaining({ code: 'busy' })] });
    expect(calls).toBe(9);
    expect(p.commands).toEqual([]);
    expect(existsSync(p.folder)).toBe(true);
  }, 60_000);

  it('knows a conversation rooted below a cleaned folder, and settles a cleanup the app stopped part way (Codex I2-7c P1-6, P2-7)', async () => {
    const p = await project();
    await p.cleanup.cleanup('P', ['r1']);
    expect(await p.cleanup.folderState(path.join(p.folder, 'src'))).toEqual({ state: 'cleaned', root: p.folder, result: true });
    // The app stopped after Git removed the folder, before the record said so.
    const file = path.join(p.userData, RUN_RETENTION_FILE);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { folders: { state: string }[] };
    saved.folders[0]!.state = 'retiring';
    await fs.writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
    const restarted = new RunWorktreeCleanup({ ...(p.cleanup as unknown as { options: ConstructorParameters<typeof RunWorktreeCleanup>[0] }).options });
    expect(await restarted.folderState(p.folder)).toEqual({ state: 'retiring', root: p.folder });
    await restarted.reconcile();
    expect(await restarted.folderState(p.folder)).toEqual({ state: 'cleaned', root: p.folder, result: true });
    // Stopped part way and a folder is at the old path again: never read as the run's (Codex I2-7c recheck).
    const replaced = JSON.parse(await fs.readFile(file, 'utf8')) as { folders: { state: string }[] };
    replaced.folders[0]!.state = 'retiring';
    await fs.writeFile(file, `${JSON.stringify(replaced, null, 2)}\n`);
    mkdirSync(p.folder);
    writeFileSync(path.join(p.folder, 'README.md'), 'someone else’s\n');
    const again = new RunWorktreeCleanup({ ...(p.cleanup as unknown as { options: ConstructorParameters<typeof RunWorktreeCleanup>[0] }).options });
    await again.reconcile();
    expect(await again.folderState(p.folder)).toEqual({ state: 'cleaned', root: p.folder, result: true });
    expect(await again.readFile(path.join(p.folder, 'README.md'))).toMatchObject({ ok: true, content: 'updated\n' });
  }, 60_000);

  it('never trusts another worktree at a cleaned folder’s path, nor a removal it could not confirm (Codex I2-7c recheck 2)', async () => {
    const p = await project();
    await p.cleanup.cleanup('P', ['r1']);
    const file = path.join(p.userData, RUN_RETENTION_FILE);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { folders: { state: string }[] };
    saved.folders[0]!.state = 'retiring';
    await fs.writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
    // Someone made another worktree at the same path before the app started again.
    git(p.repo, ['worktree', 'add', '-b', 'someone-else', p.folder]);
    const restarted = new RunWorktreeCleanup({ ...(p.cleanup as unknown as { options: ConstructorParameters<typeof RunWorktreeCleanup>[0] }).options });
    await restarted.reconcile();
    expect(await restarted.folderState(p.folder)).toEqual({ state: 'cleaned', root: p.folder, result: true });

    // Retirement reports an error and the list after it cannot be read: not 'live' again.
    const q = await project();
    const service = q.worktrees as unknown as { retire: (...args: unknown[]) => Promise<unknown>; execute: (...args: unknown[]) => Promise<unknown> };
    const execute = service.execute.bind(q.worktrees);
    let retired = false;
    service.retire = async () => { retired = true; return { ok: false, kept: false, code: 'GIT_FAILED', message: 'git failed part way' }; };
    service.execute = async (...args: unknown[]) => (retired ? { ok: false, code: 'GIT_FAILED', message: 'list failed' } : execute(...args));
    expect(await q.cleanup.cleanup('P', ['r1'])).toMatchObject({ removed: 0 });
    expect(await q.cleanup.folderState(q.folder)).toEqual({ state: 'cleaned', root: q.folder, result: true });
  }, 60_000);

  it('removes the folder a passed integration combined the run’s results in, and keeps any other (I2-7d)', async () => {
    const p = await project({ integration: 'passed' });
    const combined = p.integration!.workspacePath as string;
    expect((await p.cleanup.plan('P')).runs[0]!.folders).toEqual([
      expect.objectContaining({ kind: 'attempt', state: 'removable' }),
      expect.objectContaining({ kind: 'integration', path: combined, state: 'removable' }),
    ]);
    expect(await p.cleanup.cleanup('P', ['r1'])).toEqual({ removed: 2, kept: [] });
    expect(existsSync(combined)).toBe(false);
    // Its result is still kept by the shared ref and its branch.
    expect(git(p.repo, ['rev-parse', 'ezterminal/integration-1']).trim()).toBe(p.integration!.candidateCommit);
    const moved = await project({ integration: 'passed' });
    git(moved.repo, ['update-ref', `refs/ezterminal/integrations/${resultHash(['P', 'r1'])}`, moved.baseCommit]);
    expect((await moved.cleanup.plan('P')).runs[0]!.folders[1]).toMatchObject({ kind: 'integration', state: 'kept', code: 'result-mismatch' });
    const unfinished = await project({ integration: 'validating' });
    expect((await unfinished.cleanup.plan('P')).runs[0]!.folders.map(folder => folder.kind)).toEqual(['attempt']);
  }, 90_000);

  it('offers nothing of the newest three runs', async () => {
    const p = await project();
    const plan = await p.cleanup.plan('P');
    expect(plan.runs.map(run => run.runId)).toEqual(['r1']);
  }, 60_000);
});
