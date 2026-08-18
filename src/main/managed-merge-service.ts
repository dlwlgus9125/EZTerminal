import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  type AgentCoordinationMutationResult,
  type AgentParticipant,
  type AgentValidationCommand,
  type ManagedMergeAuditRecord,
  type ManagedMergeDecisionInput,
  type ManagedMergeGrantInput,
  type ManagedMergeRequest,
  type ManagedMergeState,
  type ManagedMergeValidation,
  isSafeLocalBranch,
} from '../shared/agent-coordination';
import type { WorktreeInfo } from '../shared/worktree';
import type { GitDiffResult } from '../shared/git-status';
import type { AgentCoordinationService } from './agent-coordination-service';
import type { AgentCoordinationStore } from './agent-coordination-store';
import type { AgentValidationRunner } from './agent-validation-runner';
import { GitCommandError, GitRunner, parseWorktreePorcelain, type WorktreeService } from './worktree-service';
import type { SessionWorktreeGuard } from './session-worktree-guard';
import { JsonFile } from './json-file';

const REQUEST_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60_000;
const CANDIDATE_FILE_VERSION = 1 as const;
const REQUEST_MEMORY_CAP = 200;
const DECISION_RECEIPT_CAP = 500;
const VALIDATION_REQUEST_TAIL_BYTES = 128 * 1024;
const TERMINAL_STATES = new Set<ManagedMergeState>([
  'merged', 'denied', 'conflict', 'stale', 'failed', 'interrupted', 'already-integrated',
]);

interface CandidateEntry {
  readonly requestId: string;
  readonly candidatePath: string;
  readonly repoPath: string;
  readonly refName: string;
  readonly projectId: string;
  readonly participantId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceBranch: string;
  readonly sourceHead: string;
  readonly targetBranch: string;
  readonly targetHead: string;
  readonly createdAt: number;
}

interface CandidateFile {
  readonly version: typeof CANDIDATE_FILE_VERSION;
  readonly entries: readonly CandidateEntry[];
}

interface OneShotGrant {
  readonly grantId: string;
  readonly participantId: string;
  readonly sourceWorkspaceId: string;
  readonly targetBranch: string;
  readonly expiresAt: number;
}

function isCandidateEntry(value: unknown): value is CandidateEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<CandidateEntry>;
  return typeof entry.requestId === 'string'
    && typeof entry.candidatePath === 'string'
    && path.isAbsolute(entry.candidatePath)
    && typeof entry.repoPath === 'string'
    && path.isAbsolute(entry.repoPath)
    && typeof entry.refName === 'string'
    && entry.refName.startsWith('refs/ezterminal/merge-candidates/')
    && typeof entry.projectId === 'string'
    && typeof entry.participantId === 'string'
    && typeof entry.sourceWorkspaceId === 'string'
    && typeof entry.sourceBranch === 'string'
    && typeof entry.sourceHead === 'string'
    && typeof entry.targetBranch === 'string'
    && typeof entry.targetHead === 'string'
    && typeof entry.createdAt === 'number';
}

class CandidateRegistry {
  private readonly file: JsonFile;
  private entries: readonly CandidateEntry[] = [];

  constructor(userDataDir: string) {
    this.file = new JsonFile(userDataDir, 'managed-merge-candidates.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    const raw = await this.file.read();
    if (raw === undefined) return;
    const candidate = raw as Partial<CandidateFile>;
    if (
      typeof raw !== 'object'
      || raw === null
      || candidate.version !== CANDIDATE_FILE_VERSION
      || !Array.isArray(candidate.entries)
      || !candidate.entries.every(isCandidateEntry)
    ) {
      await this.file.quarantine();
      this.entries = [];
      return;
    }
    this.entries = candidate.entries;
  }

  list(): readonly CandidateEntry[] {
    return this.entries;
  }

  add(entry: CandidateEntry): Promise<void> {
    return this.file.enqueue(async () => {
      this.entries = [...this.entries.filter((item) => item.requestId !== entry.requestId), entry];
      await this.persist();
    });
  }

  remove(requestId: string): Promise<void> {
    return this.file.enqueue(async () => {
      this.entries = this.entries.filter((entry) => entry.requestId !== requestId);
      await this.persist();
    });
  }

  private persist(): Promise<void> {
    return this.file.writeAtomic(JSON.stringify({ version: CANDIDATE_FILE_VERSION, entries: this.entries }));
  }
}

function safeRelative(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function mergeMessage(request: ManagedMergeRequest): string {
  return `EZTerminal managed merge: ${request.sourceBranch} -> ${request.targetBranch} (${request.requestId})`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class ManagedMergeService {
  private readonly git = new GitRunner(undefined, { timeoutMs: 10 * 60_000, maxBuffer: 1024 * 1024 });
  private readonly registry: CandidateRegistry;
  private readonly requests = new Map<string, ManagedMergeRequest>();
  private readonly candidateByRequest = new Map<string, CandidateEntry>();
  private readonly grants = new Map<string, OneShotGrant>();
  private readonly decisionReceipts = new Map<string, AgentCoordinationMutationResult<ManagedMergeRequest>>();
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly candidateRoot: string;
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly deps: {
    readonly userDataDir: string;
    readonly coordination: AgentCoordinationService;
    readonly coordinationStore: AgentCoordinationStore;
    readonly worktrees: Pick<WorktreeService, 'execute'>;
    readonly validationRunner: AgentValidationRunner;
    readonly runGuard: SessionWorktreeGuard;
    readonly projectRoot: (projectId: string) => string | null;
    readonly hasActiveRunInPath: (targetPath: string) => Promise<boolean>;
    readonly newId?: () => string;
    readonly now?: () => number;
  }) {
    this.candidateRoot = path.join(deps.userDataDir, 'managed-merge-candidates');
    this.registry = new CandidateRegistry(deps.userDataDir);
    this.expiryTimer = setInterval(() => void this.expireRequests(), 60_000);
    this.expiryTimer.unref?.();
  }

  async init(): Promise<void> {
    await this.registry.init();
    await fs.mkdir(this.candidateRoot, { recursive: true });
    const root = await fs.realpath(this.candidateRoot);
    for (const entry of this.registry.list()) {
      await this.cleanupEntry(entry, root);
      await this.deps.coordinationStore.appendAudit({
        auditId: (this.deps.newId ?? randomUUID)(),
        requestId: entry.requestId,
        projectId: entry.projectId,
        participantId: entry.participantId,
        sourceWorkspaceId: entry.sourceWorkspaceId,
        sourceBranch: entry.sourceBranch,
        sourceHead: entry.sourceHead,
        targetBranch: entry.targetBranch,
        targetHead: entry.targetHead,
        validations: [],
        outcome: 'interrupted',
        createdAt: entry.createdAt,
        finishedAt: this.now(),
      });
      await this.registry.remove(entry.requestId);
    }
  }

  listRequests(): readonly ManagedMergeRequest[] {
    return [...this.requests.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async readCandidateDiff(requestId: string, revision: number): Promise<GitDiffResult> {
    const request = this.requests.get(requestId);
    const entry = this.candidateByRequest.get(requestId);
    if (
      !request
      || request.revision !== revision
      || !request.candidateHead
      || !entry
      || entry.requestId !== requestId
    ) return { ok: false, error: 'git-failed' };
    try {
      const output = await this.git.run(entry.repoPath, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--find-renames',
        request.targetHead,
        request.candidateHead,
        '--',
      ]);
      const maxChars = 200_000;
      return {
        ok: true,
        text: output.slice(0, maxChars),
        truncated: output.length > maxChars,
        omissions: [],
      };
    } catch {
      return { ok: false, error: 'git-failed' };
    }
  }

  onRequests(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForRequest(
    requestId: string,
    afterRevision: number | undefined,
    timeoutMs: number,
    stopAtDecision = false,
    signal?: AbortSignal,
  ): Promise<ManagedMergeRequest | null> {
    const current = this.requests.get(requestId);
    if (!current) return Promise.resolve(null);
    const ready = (request: ManagedMergeRequest): boolean => (
      (afterRevision === undefined || request.revision > afterRevision)
      && (TERMINAL_STATES.has(request.state)
        || (stopAtDecision && (request.state === 'approval-required' || request.state === 'override-required')))
    );
    if (ready(current)) return Promise.resolve(current);
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      const onAbort = (): void => finish(null);
      const finish = (request: ManagedMergeRequest | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(request);
      };
      const timer = setTimeout(() => finish(null), Math.max(1, Math.min(30 * 60_000, timeoutMs)));
      timer.unref?.();
      unsubscribe = this.onRequests(() => {
        const request = this.requests.get(requestId);
        if (!request) finish(null);
        else if (ready(request)) finish(request);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish(null);
    });
  }

  async requestForActivity(
    activityId: string,
    targetBranch: string,
  ): Promise<AgentCoordinationMutationResult<ManagedMergeRequest>> {
    if (this.disposed || !isSafeLocalBranch(targetBranch)) {
      return { ok: false, error: 'invalid', message: 'The target must be a safe local branch name.' };
    }
    const participant = this.deps.coordination.getParticipantByActivity(activityId);
    if (!participant?.joined) {
      return { ok: false, error: 'not-found', message: 'This Agent has not joined Project collaboration.' };
    }
    if (!participant.worktreeId) {
      return { ok: false, error: 'invalid', message: 'Managed merge requires an EZTerminal-managed source worktree.' };
    }
    const project = this.deps.coordination.getProject(participant.projectId);
    const projectRoot = this.deps.projectRoot(participant.projectId);
    if (!project || !projectRoot) {
      return { ok: false, error: 'not-found', message: 'Project configuration is unavailable.' };
    }
    const listed = await this.deps.worktrees.execute({ action: 'list', cwd: projectRoot }, 'desktop');
    const source = listed.ok
      ? listed.worktrees.find((worktree) => worktree.worktreeId === participant.worktreeId)
      : undefined;
    if (!source || !source.managed || source.main || source.prunable || source.locked) {
      return { ok: false, error: 'invalid', message: 'The source is no longer a safe managed worktree.' };
    }

    const createdAt = this.now();
    const requestId = (this.deps.newId ?? randomUUID)();
    const validations: ManagedMergeValidation[] = project.validationCommands.map((command) => ({
      id: command.id,
      name: command.name,
      status: 'pending',
    }));
    const request: ManagedMergeRequest = {
      requestId,
      revision: 1,
      projectId: participant.projectId,
      participantId: participant.participantId,
      activityId,
      sourceWorkspaceId: participant.workspaceId,
      sourceBranch: source.branch,
      sourceHead: source.head,
      targetBranch,
      targetHead: '',
      state: 'preparing',
      validationConfigRevision: project.configRevision,
      validations,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + REQUEST_TTL_MS,
    };
    this.requests.set(requestId, request);
    const matchingGrant = this.consumeMatchingGrant(participant, targetBranch);
    this.publish();
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    const validationPlan = project.validationCommands.map((command) => ({ ...command }));
    const preparation = this.prepare(
      requestId,
      source,
      validationPlan,
      matchingGrant !== null,
      controller.signal,
    ).finally(() => {
      this.controllers.delete(requestId);
      this.preparations.delete(requestId);
    });
    this.preparations.set(requestId, preparation);
    void preparation;
    return { ok: true, value: request };
  }

  grantNext(input: ManagedMergeGrantInput): AgentCoordinationMutationResult<{ readonly expiresAt: number }> {
    const participant = this.deps.coordination.getParticipant(input.participantId);
    if (
      !participant
      || participant.workspaceId !== input.sourceWorkspaceId
      || !participant.worktreeId
      || !isSafeLocalBranch(input.targetBranch)
      || ![900000, 3600000, 14400000].includes(input.durationMs)
    ) return { ok: false, error: 'invalid', message: 'The one-shot grant scope is invalid.' };
    const grant: OneShotGrant = {
      grantId: (this.deps.newId ?? randomUUID)(),
      participantId: input.participantId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      targetBranch: input.targetBranch,
      expiresAt: this.now() + input.durationMs,
    };
    this.grants.set(participant.participantId, grant);
    return { ok: true, value: { expiresAt: grant.expiresAt } };
  }

  async decide(input: ManagedMergeDecisionInput): Promise<AgentCoordinationMutationResult<ManagedMergeRequest>> {
    const receiptKey = `${input.requestId}\0${String(input.revision)}\0${input.decision}\0${input.actor}`;
    const receipt = this.decisionReceipts.get(receiptKey);
    if (receipt) return receipt;
    const request = this.requests.get(input.requestId);
    if (!request) return { ok: false, error: 'not-found', message: 'Merge request not found.' };
    if (request.revision !== input.revision) return { ok: false, error: 'stale', message: 'Merge request changed.' };
    if (request.state !== 'approval-required' && request.state !== 'override-required') {
      return { ok: false, error: 'conflict', message: 'This request is not awaiting a decision.' };
    }
    if (request.state === 'override-required') {
      if (input.actor !== 'desktop') {
        return { ok: false, error: 'invalid', message: 'Failed-validation override is desktop-only.' };
      }
      if (typeof input.overrideReason !== 'string' || input.overrideReason.trim().length < 4 || input.overrideReason.length > 500) {
        return { ok: false, error: 'invalid', message: 'A bounded override reason is required.' };
      }
    }
    if (input.decision === 'deny') {
      const denied = this.update(input.requestId, { state: 'denied' });
      await this.finishTerminal(denied, input.actor, input.overrideReason);
      const result = { ok: true, value: denied } as const;
      this.rememberDecision(receiptKey, result);
      return result;
    }
    const merging = this.update(input.requestId, { state: 'merging' });
    const result = await this.promote(merging, input.actor, input.overrideReason);
    this.rememberDecision(receiptKey, result);
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.expiryTimer);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.preparations.values()]);
    const pending = this.listRequests().filter((request) => !TERMINAL_STATES.has(request.state));
    for (const request of pending) {
      const interrupted = this.update(request.requestId, { state: 'interrupted' });
      await this.finishTerminal(interrupted);
    }
    this.listeners.clear();
    this.grants.clear();
  }

  private async prepare(
    requestId: string,
    source: WorktreeInfo,
    validationPlan: readonly AgentValidationCommand[],
    autoApproved: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const request = this.requireRequest(requestId);
      await this.assertSourceReady(source, signal);
      const targetHead = (await this.git.run(source.path, [
        'rev-parse', '--verify', '--end-of-options', `refs/heads/${request.targetBranch}^{commit}`,
      ], signal)).trim();
      const sourceHead = (await this.git.run(source.path, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
      const sourceBranch = (await this.git.run(source.path, ['symbolic-ref', '--short', 'HEAD'], signal)).trim();
      if (sourceBranch !== request.sourceBranch || sourceHead !== request.sourceHead) {
        this.update(requestId, { state: 'stale', error: 'The source changed before preparation.' });
        await this.finishTerminal(this.requireRequest(requestId));
        return;
      }
      if (await this.isAncestor(source.path, sourceHead, targetHead, signal)) {
        const integrated = this.update(requestId, { state: 'already-integrated', targetHead });
        await this.finishTerminal(integrated);
        return;
      }
      const candidate = await this.createCandidate(this.update(requestId, { targetHead }), source.path, signal);
      const candidateHead = (await this.git.run(candidate.candidatePath, ['rev-parse', 'HEAD^{commit}'], signal)).trim();
      let current = this.update(requestId, { candidateHead, state: 'validating' });

      if (validationPlan.length === 0) {
        current = this.update(requestId, {
          state: 'approval-required',
          warning: 'No validation commands are configured; automatic merge is unavailable.',
        });
        return;
      }

      let allPassed = true;
      for (let index = 0; index < validationPlan.length; index += 1) {
        signal.throwIfAborted();
        const command = validationPlan[index]!;
        this.patchValidation(requestId, index, { status: 'running', startedAt: this.now() });
        const result = await this.deps.validationRunner.run(
          candidate.candidatePath,
          command.command,
          command.timeoutMs || DEFAULT_VALIDATION_TIMEOUT_MS,
          signal,
          (output) => this.patchValidation(requestId, index, output),
        );
        const status = result.cancelled
          ? 'cancelled'
          : result.timedOut
            ? 'timed-out'
            : result.exitCode === 0 ? 'passed' : 'failed';
        this.patchValidation(requestId, index, {
          status,
          finishedAt: this.now(),
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          outputTail: result.outputTail,
          outputTruncated: result.outputTruncated,
        });
        if (status !== 'passed') {
          allPassed = false;
          break;
        }
      }
      await this.assertCandidateUnchanged(candidate.candidatePath, candidateHead, signal);
      current = this.requireRequest(requestId);
      if (!allPassed) {
        this.update(requestId, { state: 'override-required' });
        return;
      }
      if (autoApproved) {
        current = this.update(requestId, { state: 'merging' });
        await this.promote(current, 'grant');
      } else {
        this.update(requestId, { state: 'approval-required' });
      }
    } catch (error) {
      if (signal.aborted) {
        const request = this.requests.get(requestId);
        if (request && !TERMINAL_STATES.has(request.state)) {
          const interrupted = this.update(requestId, { state: 'interrupted' });
          await this.finishTerminal(interrupted);
        }
        return;
      }
      const entry = this.candidateByRequest.get(requestId);
      let conflictFiles: string[] = [];
      if (entry) {
        conflictFiles = await this.git.run(entry.candidatePath, [
          'diff', '--name-only', '--diff-filter=U', '-z',
        ]).then((output) => output.split('\0').filter(Boolean).slice(0, 200), () => []);
      }
      const failed = this.update(requestId, conflictFiles.length > 0
        ? { state: 'conflict', conflictFiles }
        : { state: 'failed', error: this.safeError(error) });
      await this.finishTerminal(failed);
    }
  }

  private async createCandidate(
    request: ManagedMergeRequest,
    repoPath: string,
    signal: AbortSignal,
  ): Promise<CandidateEntry> {
    const root = await fs.realpath(this.candidateRoot);
    const candidatePath = path.join(root, request.requestId);
    if (!safeRelative(root, candidatePath)) throw new Error('Candidate path escaped its managed root.');
    const refName = `refs/ezterminal/merge-candidates/${request.requestId}`;
    const entry: CandidateEntry = {
      requestId: request.requestId,
      candidatePath,
      repoPath,
      refName,
      projectId: request.projectId,
      participantId: request.participantId,
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceBranch: request.sourceBranch,
      sourceHead: request.sourceHead,
      targetBranch: request.targetBranch,
      targetHead: request.targetHead,
      createdAt: request.createdAt,
    };
    await this.registry.add(entry);
    this.candidateByRequest.set(request.requestId, entry);
    await this.git.run(repoPath, ['worktree', 'add', '--detach', candidatePath, request.targetHead], signal);
    await this.git.run(candidatePath, [
      'merge', '--no-ff', '--no-edit', '-m', mergeMessage(request), request.sourceHead,
    ], signal);
    const candidateHead = (await this.git.run(candidatePath, ['rev-parse', 'HEAD^{commit}'], signal)).trim();
    await this.git.run(repoPath, ['update-ref', refName, candidateHead], signal);
    return entry;
  }

  private async promote(
    request: ManagedMergeRequest,
    actor: 'desktop' | 'mobile' | 'grant',
    overrideReason?: string,
  ): Promise<AgentCoordinationMutationResult<ManagedMergeRequest>> {
    try {
      const entry = this.candidateByRequest.get(request.requestId);
      if (!entry || !request.candidateHead) throw new Error('Merge candidate is unavailable.');
      const participant = this.deps.coordination.getParticipant(request.participantId);
      const project = this.deps.coordination.getProject(request.projectId);
      const candidateRefHead = await this.git.run(entry.repoPath, [
        'rev-parse', '--verify', `${entry.refName}^{commit}`,
      ]).then((value) => value.trim(), () => '');
      if (
        !participant
        || participant.projectId !== request.projectId
        || participant.activityId !== request.activityId
        || participant.workspaceId !== request.sourceWorkspaceId
        || !participant.worktreeId
        || !project
        || project.configRevision !== request.validationConfigRevision
        || candidateRefHead !== request.candidateHead
      ) {
        const stale = this.update(request.requestId, { state: 'stale', error: 'Project or participant context changed.' });
        await this.finishTerminal(stale, actor, overrideReason);
        return { ok: false, error: 'stale', message: stale.error! };
      }
      const listed = await this.deps.worktrees.execute({
        action: 'list',
        cwd: this.deps.projectRoot(request.projectId) ?? entry.repoPath,
      }, 'desktop');
      const source = listed.ok
        ? listed.worktrees.find((worktree) => worktree.worktreeId === participant.worktreeId)
        : undefined;
      if (
        !source
        || !source.managed
        || source.main
        || source.locked
        || source.prunable
        || source.path !== entry.repoPath
        || source.branch !== request.sourceBranch
      ) {
        const stale = this.update(request.requestId, { state: 'stale', error: 'The managed source workspace changed.' });
        await this.finishTerminal(stale, actor, overrideReason);
        return { ok: false, error: 'stale', message: stale.error! };
      }
      const sourceHead = (await this.git.run(entry.repoPath, ['rev-parse', 'HEAD^{commit}'])).trim();
      const targetHead = (await this.git.run(entry.repoPath, [
        'rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`,
      ])).trim();
      if (sourceHead !== request.sourceHead || targetHead !== request.targetHead) {
        const stale = this.update(request.requestId, { state: 'stale', error: 'Source or target changed.' });
        await this.finishTerminal(stale, actor, overrideReason);
        return { ok: false, error: 'stale', message: stale.error! };
      }
      const worktrees = parseWorktreePorcelain(await this.git.run(entry.repoPath, [
        'worktree', 'list', '--porcelain', '-z',
      ]));
      const targetCheckout = worktrees.find((worktree) => worktree.branch === request.targetBranch);

      await this.deps.runGuard.withRemovalBarrier(async () => {
        const refreshedTarget = (await this.git.run(entry.repoPath, [
          'rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`,
        ])).trim();
        if (refreshedTarget !== request.targetHead) throw new Error('Target changed before promotion.');
        if (targetCheckout) {
          const dirty = await this.git.run(targetCheckout.path, [
            'status', '--porcelain=v1', '-z', '--untracked-files=all',
          ]);
          if (dirty.length > 0) throw new Error('The target checkout is dirty.');
          if (await this.deps.hasActiveRunInPath(targetCheckout.path)) {
            throw new Error('The target checkout has an active terminal run.');
          }
          await this.git.run(targetCheckout.path, ['merge', '--ff-only', request.candidateHead!]);
        } else {
          await this.git.run(entry.repoPath, [
            'update-ref', `refs/heads/${request.targetBranch}`, request.candidateHead!, request.targetHead,
          ]);
        }
      });
      const merged = this.update(request.requestId, { state: 'merged' });
      await this.finishTerminal(merged, actor, overrideReason);
      return { ok: true, value: merged };
    } catch (error) {
      const staleMessage = this.safeError(error);
      const state: ManagedMergeState = /changed|dirty|active terminal/u.test(staleMessage) ? 'stale' : 'failed';
      const failed = this.update(request.requestId, { state, error: staleMessage });
      await this.finishTerminal(failed, actor, overrideReason);
      return { ok: false, error: state === 'stale' ? 'stale' : 'unavailable', message: staleMessage };
    }
  }

  private async assertSourceReady(source: WorktreeInfo, signal: AbortSignal): Promise<void> {
    const dirty = await this.git.run(source.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
    if (dirty.length > 0) throw new Error('Commit or remove every source worktree change before requesting merge.');
    if (source.branch === '(detached)' || !isSafeLocalBranch(source.branch)) {
      throw new Error('The source worktree must be on a local branch.');
    }
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG']) {
      const markerPath = (await this.git.run(source.path, ['rev-parse', '--git-path', marker], signal)).trim();
      if (await fs.stat(path.resolve(source.path, markerPath)).then(() => true, () => false)) {
        throw new Error(`The source has an in-progress Git operation (${marker}).`);
      }
    }
  }

  private async assertCandidateUnchanged(
    candidatePath: string,
    candidateHead: string,
    signal: AbortSignal,
  ): Promise<void> {
    const [head, dirty] = await Promise.all([
      this.git.run(candidatePath, ['rev-parse', 'HEAD^{commit}'], signal).then((value) => value.trim()),
      this.git.run(candidatePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
    ]);
    if (head !== candidateHead || dirty.length > 0) {
      throw new Error('A validation command changed the immutable merge candidate.');
    }
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.git.run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], signal);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && Number(error.exitCode) === 1) return false;
      throw error;
    }
  }

  private consumeMatchingGrant(participant: AgentParticipant, targetBranch: string): OneShotGrant | null {
    const grant = this.grants.get(participant.participantId);
    if (!grant) return null;
    this.grants.delete(participant.participantId);
    const now = this.now();
    const exact = grant.participantId === participant.participantId
      && grant.sourceWorkspaceId === participant.workspaceId
      && grant.targetBranch === targetBranch
      && grant.expiresAt > now;
    return exact ? grant : null;
  }

  private patchValidation(requestId: string, index: number, patch: Partial<ManagedMergeValidation>): void {
    const request = this.requireRequest(requestId);
    let boundedPatch = patch;
    if (typeof patch.outputTail === 'string') {
      const encoded = Buffer.from(patch.outputTail, 'utf8');
      if (encoded.byteLength > VALIDATION_REQUEST_TAIL_BYTES) {
        let start = encoded.byteLength - VALIDATION_REQUEST_TAIL_BYTES;
        while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
        boundedPatch = {
          ...patch,
          outputTail: encoded.subarray(start).toString('utf8'),
          outputTruncated: true,
        };
      }
    }
    const validations = request.validations.map((validation, candidateIndex) => (
      candidateIndex === index ? { ...validation, ...boundedPatch } : validation
    ));
    this.update(requestId, { validations });
  }

  private update(requestId: string, patch: Partial<ManagedMergeRequest>): ManagedMergeRequest {
    const current = this.requireRequest(requestId);
    const next: ManagedMergeRequest = {
      ...current,
      ...patch,
      requestId: current.requestId,
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    this.requests.set(requestId, next);
    this.publish();
    return next;
  }

  private requireRequest(requestId: string): ManagedMergeRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('Merge request not found.');
    return request;
  }

  private async finishTerminal(
    request: ManagedMergeRequest,
    actor?: 'desktop' | 'mobile' | 'grant',
    overrideReason?: string,
  ): Promise<void> {
    const validations = request.validations.map((validation) => ({
      name: validation.name,
      status: validation.status,
      ...(validation.durationMs === undefined ? {} : { durationMs: validation.durationMs }),
      ...(validation.exitCode === undefined ? {} : { exitCode: validation.exitCode }),
      ...(validation.outputTail === undefined ? {} : { digest: digest(validation.outputTail) }),
    }));
    const audit: ManagedMergeAuditRecord = {
      auditId: (this.deps.newId ?? randomUUID)(),
      requestId: request.requestId,
      projectId: request.projectId,
      participantId: request.participantId,
      sourceWorkspaceId: request.sourceWorkspaceId,
      sourceBranch: request.sourceBranch,
      sourceHead: request.sourceHead,
      targetBranch: request.targetBranch,
      targetHead: request.targetHead,
      ...(request.candidateHead ? { candidateHead: request.candidateHead } : {}),
      validations,
      ...(actor ? { decisionActor: actor } : {}),
      outcome: request.state,
      ...(overrideReason ? { overrideReason: overrideReason.trim() } : {}),
      createdAt: request.createdAt,
      finishedAt: this.now(),
    };
    await this.deps.coordinationStore.appendAudit(audit);
    const entry = this.candidateByRequest.get(request.requestId);
    if (entry) {
      await this.cleanupEntry(entry, await fs.realpath(this.candidateRoot));
      this.candidateByRequest.delete(request.requestId);
      await this.registry.remove(request.requestId);
    }
    this.pruneRequestMemory();
  }

  private async cleanupEntry(entry: CandidateEntry, canonicalRoot: string): Promise<void> {
    if (!safeRelative(canonicalRoot, entry.candidatePath)) {
      throw new Error('Registered merge candidate escaped its managed root.');
    }
    await this.git.run(entry.repoPath, ['worktree', 'remove', '--force', entry.candidatePath]).catch(() => undefined);
    await this.git.run(entry.repoPath, ['update-ref', '-d', entry.refName]).catch(() => undefined);
    const resolved = path.resolve(entry.candidatePath);
    if (safeRelative(canonicalRoot, resolved)) {
      await fs.rm(resolved, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.git.run(entry.repoPath, ['worktree', 'prune']).catch(() => undefined);
    const pathStillExists = await fs.lstat(resolved).then(() => true, () => false);
    const refStillExists = await this.git.run(entry.repoPath, [
      'show-ref', '--verify', '--quiet', entry.refName,
    ]).then(() => true, (error: unknown) => (
      !(error instanceof GitCommandError && Number(error.exitCode) === 1)
    ));
    const worktreeStillRegistered = await this.git.run(entry.repoPath, [
      'worktree', 'list', '--porcelain', '-z',
    ]).then((output) => parseWorktreePorcelain(output).some((worktree) => (
      path.resolve(worktree.path) === resolved
    )), () => true);
    if (pathStillExists || refStillExists || worktreeStillRegistered) {
      throw new Error('Managed merge candidate cleanup is incomplete.');
    }
  }

  private async expireRequests(): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const request of this.requests.values()) {
      if (TERMINAL_STATES.has(request.state)) {
        if (request.expiresAt <= now) {
          this.requests.delete(request.requestId);
          changed = true;
        }
        continue;
      }
      if (request.expiresAt > now) continue;
      const stale = this.update(request.requestId, { state: 'stale', error: 'Merge request expired.' });
      await this.finishTerminal(stale);
    }
    for (const [participantId, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(participantId);
    }
    if (this.pruneRequestMemory()) changed = true;
    if (changed) this.publish();
  }

  private rememberDecision(
    key: string,
    result: AgentCoordinationMutationResult<ManagedMergeRequest>,
  ): void {
    this.decisionReceipts.set(key, result);
    while (this.decisionReceipts.size > DECISION_RECEIPT_CAP) {
      const oldest = this.decisionReceipts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.decisionReceipts.delete(oldest);
    }
  }

  private pruneRequestMemory(): boolean {
    if (this.requests.size <= REQUEST_MEMORY_CAP) return false;
    let changed = false;
    const removable = [...this.requests.values()]
      .filter((request) => TERMINAL_STATES.has(request.state))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.requests.size > REQUEST_MEMORY_CAP && removable.length > 0) {
      const request = removable.shift()!;
      this.requests.delete(request.requestId);
      changed = true;
      for (const key of this.decisionReceipts.keys()) {
        if (key.startsWith(`${request.requestId}\0`)) this.decisionReceipts.delete(key);
      }
    }
    return changed;
  }

  private publish(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Level-triggered observers can recover from the next request snapshot.
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private safeError(error: unknown): string {
    if (error instanceof GitCommandError) {
      return error.stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1)?.slice(0, 500)
        || 'Git rejected the managed merge operation.';
    }
    return (error instanceof Error ? error.message : 'Managed merge failed.').slice(0, 500);
  }
}

/** Constant-time descriptor comparison helper shared with loopback authentication tests. */
export function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}
