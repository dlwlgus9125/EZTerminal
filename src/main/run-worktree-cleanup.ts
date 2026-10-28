import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import { IMAGE_PREVIEW_MAX_BYTES, type FilePreviewResult } from '../shared/file-preview';
import type { ExecutionRun } from '../shared/planning-execution';
import type { PlanningIntegrationRecord, PlanningResultRecord } from '../shared/planning-result';
import type { CleanedFolderEntry, CleanedFolderState, RunCleanupOutcome, RunCleanupPlan, RunFolderKeepCode, RunFolderPlan } from '../shared/run-retention';
import { flowRunNumber } from '../shared/workflow-run-view';
import { worktreeCleanupScope } from '../shared/workspace-worktree';
import { RecordFile } from './atomic-record-file';
import { folderHeld } from './folder-cleanup';
import { resultHash } from './planning-result-repository';
import { planningReviewerId } from './planning-review-identity';
import { retentionCandidates } from './run-retention';
import { executeAsPerson } from './workspace-worktree-actions';
import { judgeDisposable, type DisposableExpectation } from './worktree-disposability';
import type { GitRunner, WorktreeService } from './worktree-service';

export const RUN_RETENTION_FILE = 'run-retention-v1.json';


const FolderRecord = z.object({
  projectId: z.string().min(1).max(200), runId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200),
  kind: z.enum(['attempt', 'validation', 'integration']), path: z.string().min(1).max(4_000), worktreeId: z.string().max(200).optional(),
  // ambiguous: Git no longer has it as a worktree but files are at its path (left part way, or a new folder there): never read as the run's.
  state: z.enum(['retiring', 'removed', 'kept', 'blocked', 'ambiguous']), reason: z.string().max(1_000).optional(), at: z.string().datetime(),
}).strict();
const RecordSchema = z.object({
  version: z.literal(1),
  folders: z.array(FolderRecord),
  /** Runs a refused launch prepared and cancelled (PlanningRunService marks them as it cancels). */
  launchLeftovers: z.array(z.object({ projectId: z.string().min(1).max(200), runId: z.string().min(1).max(200), at: z.string().datetime() }).strict()),
}).strict();
type RetentionRecord = z.infer<typeof RecordSchema>;
type Expectation = DisposableExpectation & { readonly detachTo?: string };
/** A run's folder: where it is, what it must hold, and which workspaces may be rooted in it (its own). */
interface RunFolder {
  readonly path: string;
  readonly plan: Omit<RunFolderPlan, 'state' | 'reason' | 'code'>;
  readonly expected?: Expectation;
  readonly owners: Set<string>;
  readonly keep?: readonly [RunFolderKeepCode, string];
}

export interface RunWorktreeCleanupOptions {
  readonly directory: string;
  readonly getSnapshot: () => DaemonSnapshot | undefined;
  readonly runs: (projectId: string) => readonly ExecutionRun[];
  readonly readResult: (projectId: string, attemptId: string) => Promise<PlanningResultRecord | null>;
  /** The run's latest integration candidate record (PlanningResultService). */
  readonly readIntegration: (projectId: string, runId: string) => Promise<PlanningIntegrationRecord | null>;
  /** A review or an integration of this run is still being worked on (PlanningResultService). */
  readonly resultBusy: (projectId: string, run: ExecutionRun) => Promise<boolean>;
  readonly worktrees: Pick<WorktreeService, 'execute' | 'retire'>;
  readonly git: Pick<GitRunner, 'run' | 'runBytes'>;
  /** The host's file preview over bytes already read (a cleaned folder's file comes from its result commit). */
  readonly preview: (filePath: string, handle: FileHandle) => Promise<FilePreviewResult>;
  readonly executeCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  /** Waits (bounded) for archived chats to let go of their provider processes. */
  readonly releaseProviders: () => Promise<void>;
  readonly liveTerminalIds: () => ReadonlySet<string>;
  /** After every record change (screens ask again about the folders they show). */
  readonly onChange?: () => void;
  /**
   * 기획 기준본 정리 (I2-7f, PlanningRunService.pruneWorkflowBaselines): these runs' baselines that are provably theirs
   * and unused go (a dry run answers which would, writing nothing); one gated pass for all of them.
   */
  readonly pruneBaselines?: (projectId: string, runIds: readonly string[], options?: { readonly dryRun?: boolean }) =>
    Promise<{ readonly removed: readonly { readonly runId: string }[]; readonly errors: readonly string[] }>;
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

  /** The folders this host has removed (per attempt and kind, so a screen marks only what really went). */
  async cleaned(projectId: string): Promise<readonly CleanedFolderEntry[]> {
    return removedEntries(await this.read(), projectId);
  }

  /**
   * Settles records an earlier cleanup left 'retiring' (the app stopped part way), by the worktree they saved: still a
   * managed worktree (same id, same path) = kept (judged again next time); gone with its folder = removed; anything
   * else at its path (files left, or another worktree there) = ambiguous: only the run's verified result is read.
   */
  async reconcile(): Promise<void> {
    const record = await this.read();
    const snapshot = this.options.getSnapshot();
    for (const entry of record.folders.filter(folder => folder.state === 'retiring' && !this.cleaning.has(folder.projectId))) {
      const root = snapshot?.projects.find(project => project.id === entry.projectId)?.rootPath;
      if (!root) continue;
      const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
      if (!listed.ok) continue;
      const plan = { runId: entry.runId, attemptId: entry.attemptId, kind: entry.kind, path: entry.path };
      if (entry.worktreeId && listed.worktrees.some(worktree => worktree.managed && worktree.worktreeId === entry.worktreeId && samePath(worktree.path, entry.path))) {
        await this.write(entry.projectId, plan, 'kept', 'An earlier cleanup stopped before removing it.');
      } else if (!listed.worktrees.some(worktree => samePath(worktree.path, entry.path)) && !(await present(entry.path))) await this.write(entry.projectId, plan, 'removed');
      else await this.write(entry.projectId, plan, 'ambiguous', 'An earlier cleanup stopped part way; files are left there.');
    }
  }

  async plan(projectId: string): Promise<RunCleanupPlan> {
    if (!this.cleaning.has(projectId)) await this.reconcile();
    const record = await this.read();
    const snapshot = this.options.getSnapshot();
    const root = snapshot?.projects.find(entry => entry.id === projectId && !entry.archivedAt)?.rootPath;
    const cleaned = removedEntries(record, projectId);
    if (!snapshot || !root) return { runs: [], cleaned, baselines: 0 };
    const runs = this.options.runs(projectId);
    const busy = new Set<string>();
    for (const run of runs) if (await this.options.resultBusy(projectId, run)) busy.add(run.runId);
    const leftovers = new Set(record.launchLeftovers.filter(entry => entry.projectId === projectId).map(entry => entry.runId));
    const candidates = retentionCandidates(runs, { busy: run => busy.has(run.runId), launchLeftovers: leftovers });
    const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    const worktrees = listed.ok ? listed.worktrees : [];
    const planned: (RunCleanupPlan['runs'][number] & { baseline?: true })[] = [];
    const settled: string[] = [];
    for (const candidate of candidates) {
      const run = runs.find(entry => entry.runId === candidate.runId)!;
      const folders: RunFolderPlan[] = [];
      for (const folder of await this.folders(projectId, run, snapshot)) {
        const removed = record.folders.some(entry => entry.projectId === projectId && entry.runId === run.runId && samePath(entry.path, folder.path) && entry.state === 'removed');
        const worktree = worktrees.find(entry => samePath(entry.path, folder.path));
        if (removed && !worktree) { folders.push({ ...folder.plan, state: 'removed' }); continue; }
        const keep = this.keepBefore(snapshot, folder, worktree);
        if (keep) { folders.push({ ...folder.plan, state: 'kept', code: keep[0], reason: keep[1] }); continue; }
        const judged = await judgeDisposable(this.options.git, folder.path, folder.expected!);
        folders.push(judged.disposable ? { ...folder.plan, state: 'removable' } : { ...folder.plan, state: 'kept', code: judged.code, reason: judged.reason });
      }
      // With its folders gone (or none), the run's planning baseline can go too (asked below, for all such runs at once).
      if (folders.every(folder => folder.state === 'removed')) settled.push(run.runId);
      planned.push({ runId: run.runId, runNumber: flowRunNumber(runs, run), subprojectId: candidate.subprojectId, why: candidate.why, folders });
    }
    const removable = settled.length && this.options.pruneBaselines
      ? new Set((await this.options.pruneBaselines(projectId, settled, { dryRun: true }).catch(() => ({ removed: [] }))).removed.map(entry => entry.runId)) : new Set<string>();
    const shown = planned.map(run => (removable.has(run.runId) ? { ...run, baseline: true as const } : run)).filter(run => run.folders.length || run.baseline);
    return { runs: shown, cleaned, baselines: removable.size };
  }

  /** What keeps a folder before its contents are looked at: its records, its worktree, and anything else rooted in it. */
  private keepBefore(snapshot: DaemonSnapshot, folder: RunFolder, worktree: { readonly managed: boolean; readonly main: boolean; readonly locked?: boolean } | undefined): readonly [RunFolderKeepCode, string] | undefined {
    if (folder.keep) return folder.keep;
    if (!worktree || !worktree.managed || worktree.main) return ['not-ezterminal', 'It is not a work folder EZTerminal created for this project.'];
    if (worktree.locked) return ['locked', 'It is locked in Git.'];
    if (snapshot.projects.some(project => project.rootPath && within(project.rootPath, folder.path))) return ['project-inside', 'A project is registered in it.'];
    // Any workspace of another run, chat or project (archived ones too) rooted there or below: it is not only this run's.
    if (snapshot.workspaces.some(entry => entry.rootPath && within(entry.rootPath, folder.path) && !folder.owners.has(entry.id))) return ['shared', 'Another conversation, workspace or project uses it.'];
    if (!folder.expected) return ['no-record', 'It has no result record to check it against.'];
    return undefined;
  }

  /** Removes the removable work folders of these runs (the person confirmed them); anything else is left as it is. */
  async cleanup(projectId: string, runIds: readonly string[], baselineRunIds: readonly string[] = []): Promise<RunCleanupOutcome> {
    if (this.cleaning.has(projectId)) return { removed: 0, kept: [{ path: '', code: 'busy', reason: 'A cleanup of this project is already running.' }] };
    this.cleaning.add(projectId);
    try {
      const plan = await this.plan(projectId);
      const root = this.options.getSnapshot()?.projects.find(entry => entry.id === projectId && !entry.archivedAt)?.rootPath;
      let removed = 0;
      const kept: { path: string; code?: RunFolderKeepCode; reason: string }[] = [];
      for (const run of plan.runs.filter(entry => runIds.includes(entry.runId))) {
        for (const folder of run.folders) {
          if (folder.state !== 'removable') { if (folder.state === 'kept') kept.push({ path: folder.path, ...(folder.code ? { code: folder.code } : {}), reason: folder.reason ?? 'It was kept.' }); continue; }
          const outcome = root ? await this.retireFolder(projectId, root, run.runId, folder) : { ok: false as const, code: 'run-changed' as const, reason: 'The project is unavailable.' };
          if (outcome.ok) removed += 1; else kept.push({ path: folder.path, code: outcome.code, reason: outcome.reason });
        }
      }
      // Then the baselines of the chosen runs whose folders are all gone now (or had none): the cleanup proves each again.
      // The baselines the person was shown (and any this list offers now) are the ones accounted for.
      const offered = new Set([...baselineRunIds.filter(runId => runIds.includes(runId)),
        ...plan.runs.filter(run => runIds.includes(run.runId) && run.baseline).map(run => run.runId)]);
      const after = await this.plan(projectId);
      const ready = after.runs.filter(run => runIds.includes(run.runId) && (run.baseline || offered.has(run.runId))).map(run => run.runId);
      for (const runId of offered) if (!ready.includes(runId)) ready.push(runId);
      let baselinesRemoved = 0;
      let baselineError: string | undefined;
      let removedRuns = new Set<string>();
      if (ready.length && this.options.pruneBaselines) {
        try {
          const result = await this.options.pruneBaselines(projectId, ready);
          removedRuns = new Set(result.removed.map(entry => entry.runId));
          baselinesRemoved = removedRuns.size;
          if (result.errors.length) baselineError = result.errors.join(' ');
        } catch (error) { baselineError = error instanceof Error ? error.message : String(error); }
      }
      // One that was offered and stayed (something came to refer to it meanwhile, or it could not be written) says so.
      const baselinesKept = [...offered].filter(runId => !removedRuns.has(runId)).length;
      return { removed, kept, ...(baselinesRemoved ? { baselinesRemoved } : {}), ...(baselinesKept ? { baselinesKept } : {}), ...(baselineError ? { baselineError } : {}) };
    } finally {
      this.cleaning.delete(projectId);
    }
  }

  private async retireFolder(projectId: string, root: string, runId: string, folder: RunFolderPlan): Promise<{ ok: true } | { ok: false; code: RunFolderKeepCode; reason: string }> {
    const runs = this.options.runs(projectId);
    const run = runs.find(entry => entry.runId === runId);
    const snapshot = this.options.getSnapshot();
    const resolved = run && snapshot ? (await this.folders(projectId, run, snapshot)).find(entry => samePath(entry.path, folder.path)) : undefined;
    if (!run || !snapshot || !resolved?.expected) return this.settle(projectId, folder, 'kept', 'run-changed', 'Its run or result record changed.');
    // A review retry or device evidence may have started since the list was shown.
    if (await this.options.resultBusy(projectId, run)) return this.settle(projectId, folder, 'blocked', 'busy', 'Something still runs there. Stop it and clean up again.');
    const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    const worktree = listed.ok ? listed.worktrees.find(entry => samePath(entry.path, folder.path)) : undefined;
    const keep = this.keepBefore(snapshot, resolved, worktree);
    if (keep || !worktree) return this.settle(projectId, folder, 'kept', keep?.[0] ?? 'not-ezterminal', keep?.[1] ?? 'It is not a work folder EZTerminal created for this project.');
    await this.write(projectId, folder, 'retiring', undefined, worktree.worktreeId);
    // Everything rooted in the folder: its chats are archived (a live or queued turn, an approval or anything else running keeps it).
    const affected = new Set(snapshot.workspaces.filter(entry => !entry.archivedAt && within(entry.rootPath, folder.path)).map(entry => entry.id));
    const scope = worktreeCleanupScope(snapshot, affected, this.options.liveTerminalIds());
    if (scope.busy) return this.settle(projectId, folder, 'blocked', 'busy', 'Something still runs there. Stop it and clean up again.');
    const createId = randomUUID;
    for (const sessionId of scope.chats) {
      const receipt = await executeAsPerson(this.options, createId, 'agent.archive', { sessionId });
      if (!receipt.ok) return this.settle(projectId, folder, 'blocked', 'busy', receipt.error.message);
    }
    for (const workspaceId of affected) {
      const receipt = await executeAsPerson(this.options, createId, 'workspace.archive', { workspaceId });
      if (!receipt.ok) return this.settle(projectId, folder, 'blocked', 'busy', receipt.error.message);
    }
    await this.options.releaseProviders();
    // Archived chats' provider processes and the tools they started exit a little after the archive.
    const deadline = Date.now() + (scope.chats.length ? this.options.folderReleaseMs ?? 30_000 : 0);
    let held = await folderHeld(folder.path);
    while (held && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 500)); held = await folderHeld(folder.path); }
    if (held) return this.settle(projectId, folder, 'blocked', 'held', 'A program still uses this folder. Close it and clean up again.');
    const retired = await this.options.worktrees.retire(root, worktree.worktreeId, resolved.expected);
    if (retired.ok) return this.settle(projectId, folder, 'removed');
    if (retired.kept) return this.settle(projectId, folder, 'kept', retired.code, retired.reason);
    // Git may have let go of it part way: then what is left there is not read as the run's any more.
    const after = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    // A list that cannot be read is no proof it is still the run's worktree.
    const gone = !after.ok || !after.worktrees.some(entry => samePath(entry.path, folder.path) && entry.managed && entry.worktreeId === worktree.worktreeId);
    return this.settle(projectId, folder, gone ? 'ambiguous' : 'blocked', retired.code === 'WORKTREE_IN_USE' ? 'in-use' : 'failed', retired.message);
  }

  /**
   * The run's attempt and validation folders with what each must hold (from the host's own result record) and the
   * workspaces that are its own: the attempt's workspace and its reviews' workspaces. The attempt folder is the one its
   * workspace names; a result record naming another folder keeps it.
   */
  private async folders(projectId: string, run: ExecutionRun, snapshot: DaemonSnapshot): Promise<RunFolder[]> {
    const result: RunFolder[] = [];
    const add = (folder: RunFolder): void => {
      const index = result.findIndex(entry => samePath(entry.path, folder.path));
      const same = result[index];
      if (!same) { result.push(folder); return; }
      for (const owner of same.owners) folder.owners.add(owner);
      // '앞 대화 이어서': later stages of a chain work in the same folder; it must hold the last attempt's result.
      result[index] = folder.plan.kind === 'attempt' && same.plan.kind === 'attempt' ? folder : { ...same, owners: folder.owners };
    };
    for (const attempt of run.attempts) {
      const workspace = snapshot.workspaces.find(entry => entry.id === attempt.workspaceId);
      const record = await this.options.readResult(projectId, attempt.attemptId).catch(() => null);
      const rootPath = workspace?.rootPath ?? record?.rootPath;
      if (!rootPath) continue;
      const reviews = Array.from({ length: (record?.reviewAttempt ?? 0) + 1 }, (_value, generation) => `planning-review-workspace-${resultHash(planningReviewerId(run, attempt, generation)).slice(0, 32)}`);
      const keptRef = record?.commit ? { name: `refs/ezterminal/results/${resultHash([projectId, attempt.attemptId])}`, commit: record.commit } : undefined;
      const keep: readonly [RunFolderKeepCode, string] | undefined = !workspace ? ['no-record', 'It has no workspace record to check it against.']
        : record && !samePath(record.rootPath, workspace.rootPath) ? ['result-mismatch', 'Its result record names another folder.'] : undefined;
      const expected = record?.baseCommit ? (record.commit && keptRef
        ? { head: record.baseCommit, tree: record.commit, detachedAt: record.commit, detachTo: record.commit, keptRef }
        : { head: record.baseCommit, tree: record.baseCommit }) : undefined;
      add({ path: rootPath, plan: { runId: run.runId, attemptId: attempt.attemptId, kind: 'attempt', path: rootPath }, owners: new Set([attempt.workspaceId, ...reviews]),
        ...(expected ? { expected } : {}), ...(keep ? { keep } : {}) });
      if (record?.validationWorkspace && record.commit && keptRef && !samePath(record.validationWorkspace, rootPath)) {
        add({ path: record.validationWorkspace, plan: { runId: run.runId, attemptId: attempt.attemptId, kind: 'validation', path: record.validationWorkspace },
          owners: new Set(reviews), expected: { head: record.commit, tree: record.commit, keptRef } });
      }
    }
    // The folder the run's results were combined in, once that integration passed and its result is kept by the shared
    // ref. No workspace or chat of the run is rooted there; a failed or unfinished candidate stays for the person.
    const integration = await this.options.readIntegration(projectId, run.runId).catch(() => null);
    if (integration?.status === 'passed' && integration.successfulCommit === integration.candidateCommit && integration.workspacePath) {
      add({ path: integration.workspacePath, plan: { runId: run.runId, attemptId: `integration:${run.runId}`, kind: 'integration', path: integration.workspacePath }, owners: new Set(),
        expected: { head: integration.candidateCommit, tree: integration.candidateCommit,
          keptRef: { name: `refs/ezterminal/integrations/${resultHash([projectId, run.runId])}`, commit: integration.candidateCommit } } });
    }
    return result;
  }

  /** A conversation folder (or one below it) as the record says: being cleaned up, cleaned up (and whether its result reads), or live. */
  async folderState(folderPath: string): Promise<CleanedFolderState> {
    const entry = recordFor(await this.read(), folderPath);
    if (entry?.state === 'retiring') return { state: 'retiring', root: entry.path };
    if (entry?.state !== 'removed' && entry?.state !== 'ambiguous') return { state: 'live' };
    return { state: 'cleaned', root: entry.path, result: (await this.verifiedResult(entry)) !== undefined };
  }

  /**
   * A file of a cleaned-up folder, from the run's kept result in the project checkout: only once the shared result ref
   * still names the recorded commit, only a file of that commit's tree, never past the preview's own size bound.
   */
  async readFile(filePath: string): Promise<FilePreviewResult> {
    const resolved = path.resolve(filePath);
    const entry = recordFor(await this.read(), resolved);
    if (entry?.state !== 'removed' && entry?.state !== 'ambiguous') return { ok: false, error: 'This file is not in a cleaned-up work folder.' };
    const verified = await this.verifiedResult(entry);
    if (!verified) return { ok: false, error: 'This run kept no result to read the file from.' };
    const relative = path.relative(path.resolve(entry.path), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, error: 'This file is not in a cleaned-up work folder.' };
    const spec = `${verified.commit}:${relative.split(path.sep).join('/')}`;
    const read = ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', 'cat-file'];
    try {
      const type = (await this.options.git.run(verified.root, [...read, '-t', spec]).catch(() => '')).trim();
      if (type !== 'blob') return { ok: false, error: 'ENOENT: the run’s kept result has no such file.' };
      const size = Number((await this.options.git.run(verified.root, [...read, '-s', spec])).trim());
      if (!Number.isSafeInteger(size) || size > IMAGE_PREVIEW_MAX_BYTES) return { ok: false, error: 'This file is too large to show from the run’s kept result.' };
      const bytes = await this.options.git.runBytes(verified.root, [...read, 'blob', spec], size + 1);
      return await this.options.preview(resolved, memoryHandle(bytes));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A removed folder's result, once the project checkout's shared result ref still names the recorded commit. */
  private async verifiedResult(entry: { projectId: string; attemptId: string }): Promise<{ root: string; commit: string } | undefined> {
    const root = this.options.getSnapshot()?.projects.find(project => project.id === entry.projectId)?.rootPath;
    const record = root ? await this.options.readResult(entry.projectId, entry.attemptId).catch(() => null) : null;
    if (!root || !record?.commit) return undefined;
    return await this.resultKept(root, entry.projectId, entry.attemptId, { head: record.commit, tree: record.commit, detachTo: record.commit }) ? { root, commit: record.commit } : undefined;
  }

  /** The shared ref the run's result is kept by names the recorded result (a folder without one has nothing to check). */
  private async resultKept(root: string, projectId: string, attemptId: string, expected: DisposableExpectation & { detachTo?: string }): Promise<boolean> {
    if (!expected.detachTo) return true;
    const ref = `refs/ezterminal/results/${resultHash([projectId, attemptId])}`;
    try { return (await this.options.git.run(root, ['rev-parse', '--verify', '--quiet', ref])).trim() === expected.detachTo; } catch { return false; }
  }

  private async settle(projectId: string, folder: RunFolderPlan, state: 'removed' | 'kept' | 'blocked' | 'ambiguous', code?: RunFolderKeepCode, reason?: string): Promise<{ ok: true } | { ok: false; code: RunFolderKeepCode; reason: string }> {
    await this.write(projectId, folder, state, reason);
    return state === 'removed' ? { ok: true } : { ok: false, code: code ?? 'failed', reason: reason ?? 'It was kept.' };
  }

  private write(projectId: string, folder: Pick<RunFolderPlan, 'runId' | 'attemptId' | 'kind' | 'path'>, state: z.infer<typeof FolderRecord>['state'], reason?: string, worktreeId?: string): Promise<void> {
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
      try { this.options.onChange?.(); } catch { /* a screen that went away */ }
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
/** The deepest recorded folder holding this path, its latest record (a later one for the same path wins). */
function recordFor(record: RetentionRecord, target: string): RetentionRecord['folders'][number] | undefined {
  return record.folders.filter(folder => within(target, folder.path))
    .reduce<RetentionRecord['folders'][number] | undefined>((best, folder) => (!best || folder.path.length >= best.path.length ? folder : best), undefined);
}

function removedEntries(record: RetentionRecord, projectId: string): CleanedFolderEntry[] {
  return record.folders.filter(entry => entry.projectId === projectId && entry.state === 'removed').map(entry => ({ runId: entry.runId, attemptId: entry.attemptId, kind: entry.kind }));
}

async function present(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Bytes already read, behind the few file-handle calls the host's preview makes. */
function memoryHandle(bytes: Buffer): FileHandle {
  return {
    stat: async () => ({ size: bytes.length }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length)), buffer }),
    close: async () => undefined,
  } as unknown as FileHandle;
}
/** `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
