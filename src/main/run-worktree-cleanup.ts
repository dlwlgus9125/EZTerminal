import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import type { ExecutionRun } from '../shared/planning-execution';
import type { PlanningResultRecord } from '../shared/planning-result';
import type { RunCleanupOutcome, RunCleanupPlan, RunFolderPlan } from '../shared/run-retention';
import { flowRunNumber } from '../shared/workflow-run-view';
import { worktreeCleanupScope } from '../shared/workspace-worktree';
import { RecordFile } from './atomic-record-file';
import { folderHeld } from './folder-cleanup';
import { resultHash } from './planning-result-repository';
import { retentionCandidates } from './run-retention';
import { executeAsPerson } from './workspace-worktree-actions';
import { judgeDisposable, type DisposableExpectation } from './worktree-disposability';
import type { GitRunner, WorktreeService } from './worktree-service';

export const RUN_RETENTION_FILE = 'run-retention-v1.json';


const FolderRecord = z.object({
  projectId: z.string().min(1).max(200), runId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200),
  kind: z.enum(['attempt', 'validation']), path: z.string().min(1).max(4_000), worktreeId: z.string().max(200).optional(),
  state: z.enum(['retiring', 'removed', 'kept', 'blocked']), reason: z.string().max(1_000).optional(), at: z.string().datetime(),
}).strict();
const RecordSchema = z.object({
  version: z.literal(1),
  folders: z.array(FolderRecord),
  /** Runs a refused launch prepared and cancelled (PlanningRunService marks them as it cancels). */
  launchLeftovers: z.array(z.object({ projectId: z.string().min(1).max(200), runId: z.string().min(1).max(200), at: z.string().datetime() }).strict()),
}).strict();
type RetentionRecord = z.infer<typeof RecordSchema>;

export interface RunWorktreeCleanupOptions {
  readonly directory: string;
  readonly getSnapshot: () => DaemonSnapshot | undefined;
  readonly runs: (projectId: string) => readonly ExecutionRun[];
  readonly readResult: (projectId: string, attemptId: string) => Promise<PlanningResultRecord | null>;
  /** A review or an integration of this run is still being worked on (PlanningResultService). */
  readonly resultBusy: (projectId: string, run: ExecutionRun) => Promise<boolean>;
  readonly worktrees: Pick<WorktreeService, 'execute' | 'retire'>;
  readonly git: Pick<GitRunner, 'run'>;
  readonly executeCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  /** Waits (bounded) for archived chats to let go of their provider processes. */
  readonly releaseProviders: () => Promise<void>;
  readonly liveTerminalIds: () => ReadonlySet<string>;
  readonly folderReleaseMs?: number;
  readonly now?: () => Date;
}

/**
 * 작업 폴더 정리 (I2-7, the person's action): offers the work folders of a flow's older finished runs (run-retention)
 * whose contents judgeDisposable lets go, and removes the ones the person confirms — their chats archived, their
 * workspaces archived, nothing running there, then WorktreeService.retire (detach to the result, remove without force).
 * Every step is recorded in run-retention-v1.json; a folder that holds anything Git does not keep is never offered.
 */
export class RunWorktreeCleanup {
  private readonly file: RecordFile;
  private record: RetentionRecord | undefined;
  private readonly cleaning = new Set<string>();

  constructor(private readonly options: RunWorktreeCleanupOptions) {
    this.file = new RecordFile(path.join(options.directory, RUN_RETENTION_FILE));
  }

  /** Called when a refused launch's prepared run is cancelled: a candidate whatever its number. */
  markLaunchLeftover(projectId: string, runId: string): Promise<void> {
    return this.change(record => (record.launchLeftovers.some(entry => entry.projectId === projectId && entry.runId === runId) ? record
      : { ...record, launchLeftovers: [...record.launchLeftovers, { projectId, runId, at: this.now() }] }));
  }

  async plan(projectId: string): Promise<RunCleanupPlan> {
    const record = await this.read();
    const snapshot = this.options.getSnapshot();
    const root = snapshot?.projects.find(entry => entry.id === projectId && !entry.archivedAt)?.rootPath;
    const cleanedRunIds = [...new Set(record.folders.filter(entry => entry.projectId === projectId && entry.state === 'removed').map(entry => entry.runId))];
    if (!snapshot || !root) return { runs: [], cleanedRunIds };
    const runs = this.options.runs(projectId);
    const busy = new Set<string>();
    for (const run of runs) if (await this.options.resultBusy(projectId, run)) busy.add(run.runId);
    const leftovers = new Set(record.launchLeftovers.filter(entry => entry.projectId === projectId).map(entry => entry.runId));
    const candidates = retentionCandidates(runs, { busy: run => busy.has(run.runId), launchLeftovers: leftovers });
    const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    const worktrees = listed.ok ? listed.worktrees : [];
    const planned: RunCleanupPlan['runs'][number][] = [];
    for (const candidate of candidates) {
      const run = runs.find(entry => entry.runId === candidate.runId)!;
      const folders: RunFolderPlan[] = [];
      for (const folder of await this.folders(projectId, run, snapshot)) {
        const removed = record.folders.some(entry => entry.projectId === projectId && entry.runId === run.runId && samePath(entry.path, folder.path) && entry.state === 'removed');
        const worktree = worktrees.find(entry => samePath(entry.path, folder.path));
        if (removed && !worktree) { folders.push({ ...folder.plan, state: 'removed' }); continue; }
        const reason = !worktree ? 'It is not an EZTerminal worktree of this project.'
          : !worktree.managed || worktree.main ? 'It is not a work folder EZTerminal created.'
            : worktree.locked ? 'It is locked in Git.'
              : snapshot.projects.some(project => project.rootPath && within(project.rootPath, folder.path)) ? 'A project is registered in it.'
                : !folder.expected ? folder.missing ?? 'Its result record is incomplete.'
                  : await this.resultKept(root, projectId, folder.plan.attemptId, folder.expected) ? undefined : 'Its kept result does not match its record.';
        if (reason) { folders.push({ ...folder.plan, state: 'kept', reason }); continue; }
        const judged = await judgeDisposable(this.options.git, folder.path, folder.expected!);
        folders.push(judged.disposable ? { ...folder.plan, state: 'removable' } : { ...folder.plan, state: 'kept', reason: judged.reason });
      }
      if (folders.length) planned.push({ runId: run.runId, runNumber: flowRunNumber(runs, run), subprojectId: candidate.subprojectId, why: candidate.why, folders });
    }
    return { runs: planned, cleanedRunIds };
  }

  /** Removes the removable work folders of these runs (the person confirmed them); anything else is left as it is. */
  async cleanup(projectId: string, runIds: readonly string[]): Promise<RunCleanupOutcome> {
    if (this.cleaning.has(projectId)) return { removed: 0, kept: [{ path: '', reason: 'A cleanup of this project is already running.' }] };
    this.cleaning.add(projectId);
    try {
      const plan = await this.plan(projectId);
      const root = this.options.getSnapshot()?.projects.find(entry => entry.id === projectId && !entry.archivedAt)?.rootPath;
      let removed = 0;
      const kept: { path: string; reason: string }[] = [];
      for (const run of plan.runs.filter(entry => runIds.includes(entry.runId))) {
        for (const folder of run.folders) {
          if (folder.state !== 'removable') { if (folder.state === 'kept') kept.push({ path: folder.path, reason: folder.reason ?? 'It was kept.' }); continue; }
          const outcome = root ? await this.retireFolder(projectId, root, run.runId, folder) : { ok: false as const, reason: 'The project is unavailable.' };
          if (outcome.ok) removed += 1; else kept.push({ path: folder.path, reason: outcome.reason });
        }
      }
      return { removed, kept };
    } finally {
      this.cleaning.delete(projectId);
    }
  }

  private async retireFolder(projectId: string, root: string, runId: string, folder: RunFolderPlan): Promise<{ ok: true } | { ok: false; reason: string }> {
    const runs = this.options.runs(projectId);
    const run = runs.find(entry => entry.runId === runId);
    const snapshot = this.options.getSnapshot();
    const resolved = run && snapshot ? (await this.folders(projectId, run, snapshot)).find(entry => samePath(entry.path, folder.path)) : undefined;
    if (!run || !snapshot || !resolved?.expected) return this.settle(projectId, folder, 'kept', 'Its run or result record changed.');
    const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    const worktree = listed.ok ? listed.worktrees.find(entry => samePath(entry.path, folder.path) && entry.managed && !entry.main) : undefined;
    if (!worktree) return this.settle(projectId, folder, 'kept', 'It is not an EZTerminal worktree of this project.');
    await this.write(projectId, folder, 'retiring', undefined, worktree.worktreeId);
    // Everything rooted in the folder: its chats are archived (a live or queued turn, an approval or anything else running keeps it).
    const affected = new Set(snapshot.workspaces.filter(entry => !entry.archivedAt && within(entry.rootPath, folder.path)).map(entry => entry.id));
    const scope = worktreeCleanupScope(snapshot, affected, this.options.liveTerminalIds());
    if (scope.busy) return this.settle(projectId, folder, 'blocked', 'Something still runs there. Stop it and clean up again.');
    const createId = randomUUID;
    for (const sessionId of scope.chats) {
      const receipt = await executeAsPerson(this.options, createId, 'agent.archive', { sessionId });
      if (!receipt.ok) return this.settle(projectId, folder, 'blocked', receipt.error.message);
    }
    for (const workspaceId of affected) {
      const receipt = await executeAsPerson(this.options, createId, 'workspace.archive', { workspaceId });
      if (!receipt.ok) return this.settle(projectId, folder, 'blocked', receipt.error.message);
    }
    await this.options.releaseProviders();
    // Archived chats' provider processes and the tools they started exit a little after the archive.
    const deadline = Date.now() + (scope.chats.length ? this.options.folderReleaseMs ?? 30_000 : 0);
    let held = await folderHeld(folder.path);
    while (held && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 500)); held = await folderHeld(folder.path); }
    if (held) return this.settle(projectId, folder, 'blocked', 'A program still uses this folder. Close it and clean up again.');
    const retired = await this.options.worktrees.retire(root, worktree.worktreeId, resolved.expected);
    if (retired.ok) return this.settle(projectId, folder, 'removed');
    return this.settle(projectId, folder, retired.kept ? 'kept' : 'blocked', retired.kept ? retired.reason : retired.message);
  }

  /** The run's attempt and validation folders with what each must hold (from the host's own result record). */
  private async folders(projectId: string, run: ExecutionRun, snapshot: DaemonSnapshot): Promise<{ path: string; plan: Omit<RunFolderPlan, 'state' | 'reason'>; expected?: DisposableExpectation & { detachTo?: string }; missing?: string }[]> {
    const result: { path: string; plan: Omit<RunFolderPlan, 'state' | 'reason'>; expected?: DisposableExpectation & { detachTo?: string }; missing?: string }[] = [];
    for (const attempt of run.attempts) {
      const workspace = snapshot.workspaces.find(entry => entry.id === attempt.workspaceId);
      const record = await this.options.readResult(projectId, attempt.attemptId).catch(() => null);
      const rootPath = record?.rootPath ?? workspace?.rootPath;
      if (rootPath && !result.some(entry => samePath(entry.path, rootPath))) {
        const expected = record?.baseCommit ? (record.commit
          ? { head: record.baseCommit, tree: record.commit, detachedAt: record.commit, detachTo: record.commit }
          : { head: record.baseCommit, tree: record.baseCommit }) : undefined;
        result.push({ path: rootPath, plan: { runId: run.runId, attemptId: attempt.attemptId, kind: 'attempt', path: rootPath }, ...(expected ? { expected } : { missing: 'It has no result record to check it against.' }) });
      }
      if (record?.validationWorkspace && record.commit && !result.some(entry => samePath(entry.path, record.validationWorkspace!))) {
        result.push({ path: record.validationWorkspace, plan: { runId: run.runId, attemptId: attempt.attemptId, kind: 'validation', path: record.validationWorkspace },
          expected: { head: record.commit, tree: record.commit } });
      }
    }
    return result;
  }

  /** The shared ref the run's result is kept by names the recorded result (a folder without one has nothing to check). */
  private async resultKept(root: string, projectId: string, attemptId: string, expected: DisposableExpectation & { detachTo?: string }): Promise<boolean> {
    if (!expected.detachTo) return true;
    const ref = `refs/ezterminal/results/${resultHash([projectId, attemptId])}`;
    try { return (await this.options.git.run(root, ['rev-parse', '--verify', '--quiet', ref])).trim() === expected.detachTo; } catch { return false; }
  }

  private async settle(projectId: string, folder: RunFolderPlan, state: 'removed' | 'kept' | 'blocked', reason?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.write(projectId, folder, state, reason);
    return state === 'removed' ? { ok: true } : { ok: false, reason: reason ?? 'It was kept.' };
  }

  private write(projectId: string, folder: RunFolderPlan, state: z.infer<typeof FolderRecord>['state'], reason?: string, worktreeId?: string): Promise<void> {
    return this.change(record => {
      const previous = record.folders.find(entry => entry.projectId === projectId && entry.runId === folder.runId && samePath(entry.path, folder.path));
      const next = { projectId, runId: folder.runId, attemptId: folder.attemptId, kind: folder.kind, path: folder.path, state, at: this.now(),
        ...(reason ? { reason: reason.slice(0, 1_000) } : {}), ...((worktreeId ?? previous?.worktreeId) ? { worktreeId: worktreeId ?? previous!.worktreeId } : {}) };
      return { ...record, folders: [...record.folders.filter(entry => entry !== previous), next] };
    });
  }

  private change(update: (record: RetentionRecord) => RetentionRecord): Promise<void> {
    return this.file.enqueue(async () => {
      const current = await this.readNow();
      const next = update(current);
      if (next === current) return;
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await this.file.write(text);
      this.record = next;
    });
  }

  private read(): Promise<RetentionRecord> { return this.file.enqueue(() => this.readNow()); }

  /** A record that cannot be read refuses everything (nothing is cleaned without knowing what was done before). */
  private async readNow(): Promise<RetentionRecord> {
    if (this.record) return this.record;
    await this.file.init();
    const text = await this.file.read();
    this.record = text === undefined ? { version: 1, folders: [], launchLeftovers: [] } : RecordSchema.parse(JSON.parse(text));
    return this.record;
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}
/** `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
