import { createHash } from 'node:crypto';

import {
  createDaemonCommand,
  DAEMON_HARD_LIMITS,
  REVIEWER_SESSION_PREFIX,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonCommandReceipt,
  type DaemonEvent,
  type DaemonReviewSupport,
  type DaemonSnapshot,
  type DaemonTurn,
} from '../shared/daemon-protocol';
import type { GitReviewDiffResult, GitReviewScope } from '../shared/git-status';
import {
  composeReviewPrompt,
  fromStructuredJson,
  parseStructuredText,
  REVIEW_LIMITS,
  reviewerLabel,
  reviewSummaryText,
  type ReviewerRef,
  type ReviewFailureReason,
  type ReviewFinding,
  type ReviewState,
  type ReviewTarget,
} from '../shared/review-findings';
import { parseTranscriptPayload, type ReviewPayload } from '../shared/transcript-payload';
import { ProviderReviewError, type AgentProviderAdapter } from './agent-provider-adapter';
import type { DaemonSystemTransitionPlanner } from './daemon-command-router';
import type { DaemonStoreCommit, DaemonTranscriptItemInput } from './daemon-store';
import { finalAssistantText, type TranscriptReader } from './managed-child-transcript';
import type { ConversationFolderResolver } from './conversation-roots';
import { compareSemanticVersions, semanticVersion } from './provider-version';
import { withExcerpts } from './review-excerpts';

/** The host's own principal when it stops or archives a reviewer conversation. */
export const REVIEW_PRINCIPAL = { kind: 'cli', id: 'review-runtime' } as const;
/** A review that runs this long stops with `timeout`. */
export const REVIEW_TIMEOUT_MS = 15 * 60_000;
const SETTLE_TIMEOUT_MS = 10_000;

const ACTIVE_TURN_STATES = new Set<DaemonTurn['state']>(['submitting', 'working', 'blocked', 'delivery-uncertain']);
const TERMINAL_TURN_STATES = new Set<DaemonTurn['state']>(['completed', 'interrupted', 'failed']);

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

/** What survives a restart: enough to mark the card interrupted and stop its reviewer conversation. */
export interface ReviewJobRecord {
  readonly reviewId: string;
  /** The reviewed conversation, which holds the card. */
  readonly sessionId: string;
  readonly reviewer: ReviewerRef;
  readonly target: ReviewTarget;
  readonly focus?: string;
  /** Another AI's reviewer conversation (a managed child) and its one turn. */
  readonly child?: { readonly sessionId: string; readonly turnId: string };
}

/** A review the `review.start` command committed. */
export interface ReviewJobStart extends ReviewJobRecord {
  /** The conversation's turn running at the start; the review begins once it ends (D13). */
  readonly waitTurnId?: string;
  /**
   * Same AI (D13): the review also waits while the conversation has turns queued, which the queue would
   * start during the review.
   */
  readonly waitForQueue?: true;
  /** The command wrote the card as queued (waiting for the conversation's turn). */
  readonly queued?: true;
}

/** The conversation runs a turn or has turns queued to run. */
export function conversationBusy(snapshot: Pick<DaemonSnapshot, 'agents' | 'turns'>, sessionId: string): boolean {
  const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
  const current = agent?.currentTurnId ? snapshot.turns.find((turn) => turn.id === agent.currentTurnId) : undefined;
  return Boolean(current && ACTIVE_TURN_STATES.has(current.state))
    || snapshot.turns.some((turn) => turn.sessionId === sessionId && turn.state === 'queued');
}

/** One card row: the review as of now. Its text reads on its own for clients without cards. */
export interface ReviewRowInput {
  readonly id: string;
  readonly sessionId: string;
  readonly reviewId: string;
  readonly reviewer: ReviewerRef;
  readonly target: ReviewTarget;
  readonly focus?: string;
  readonly state: ReviewState;
  readonly waitingFor?: 'turn' | 'slot';
  readonly reason?: string;
  readonly findings?: readonly ReviewFinding[];
  readonly overall?: string;
  readonly truncated?: boolean;
  readonly dropped?: number;
  readonly rawText?: string;
  readonly wroteFiles?: boolean;
  readonly durationMs?: number;
  readonly createdAt?: string;
}

/** A `review` notice row; every bound matches TranscriptPayloadSchema so the store keeps the payload. */
export function reviewRowItem(input: ReviewRowInput): DaemonTranscriptItemInput {
  const findings = input.findings?.slice(0, REVIEW_LIMITS.findings);
  const payload: ReviewPayload = {
    v: 1,
    type: 'review',
    reviewId: input.reviewId,
    reviewer: input.reviewer,
    target: input.target,
    state: input.state,
    ...(input.waitingFor ? { waitingFor: input.waitingFor } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 2_000) } : {}),
    ...(input.focus ? { focus: input.focus.slice(0, REVIEW_LIMITS.focus) } : {}),
    ...(findings ? { findings: findings.map(({ excerpt, ...finding }) => ({ ...finding, ...(excerpt ? { excerpt: { startLine: excerpt.startLine, lines: [...excerpt.lines] } } : {}) })) } : {}),
    ...(input.overall ? { overall: input.overall.slice(0, REVIEW_LIMITS.overall) } : {}),
    ...(input.truncated ? { truncated: true } : {}),
    ...(input.dropped ? { dropped: input.dropped } : {}),
    ...(input.rawText ? { rawText: input.rawText.slice(0, REVIEW_LIMITS.rawText) } : {}),
    ...(input.wroteFiles ? { wroteFiles: true } : {}),
    ...(input.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {}),
  };
  return {
    id: input.id,
    sessionId: input.sessionId,
    kind: 'notice',
    text: reviewSummaryText({
      reviewerLabel: reviewerLabel(input.reviewer.providerId),
      state: input.state,
      ...(findings ? { findings } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.waitingFor ? { waitingFor: input.waitingFor } : {}),
    }),
    isDelta: false,
    isSensitive: false,
    payload,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

/** A finding's latest person event after its review: dismissed or reopened, or sent to be fixed in a turn. */
export type ReviewFindingEvent =
  | { readonly kind: 'status'; readonly state: 'dismissed' | 'open' }
  | { readonly kind: 'fix'; readonly turnId?: string };

/** A review's latest card and, per finding, its latest event, read as `build-chat-model` reads them on clients. */
export interface ReviewHistory {
  readonly review: ReviewPayload;
  readonly latest: ReadonlyMap<string, ReviewFindingEvent>;
}

function readPages(read: TranscriptReader, sessionId: string, visit: (item: ReturnType<TranscriptReader>[number]) => void): void {
  let afterSequence = 0;
  for (;;) {
    const page = read(sessionId, afterSequence, 2_000);
    for (const item of page) visit(item);
    const next = page.at(-1)?.sequence;
    if (page.length < 2_000 || next === undefined || next <= afterSequence) return;
    afterSequence = next;
  }
}

export function readReviewHistory(read: TranscriptReader, sessionId: string, reviewId: string): ReviewHistory | undefined {
  let review: ReviewPayload | undefined;
  const latest = new Map<string, ReviewFindingEvent>();
  readPages(read, sessionId, (item) => {
    const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
    if (!payload || !('reviewId' in payload) || payload.reviewId !== reviewId) return;
    if (payload.type === 'review') review = payload;
    else if (payload.type === 'review-status') for (const id of payload.findingIds) latest.set(id, { kind: 'status', state: payload.state });
    else if (payload.type === 'review-fix' && item.kind === 'user-message') {
      for (const id of payload.findingIds) latest.set(id, { kind: 'fix', ...(item.turnId ? { turnId: item.turnId } : {}) });
    }
  });
  return review ? { review, latest } : undefined;
}

/** The person's latest request in a conversation (not a fix, not a child's report): what an outside reviewer is told. */
function latestRequest(read: TranscriptReader, sessionId: string): string | undefined {
  let request: string | undefined;
  readPages(read, sessionId, (item) => {
    if (item.kind !== 'user-message' || item.isDelta || !item.text.trim()) return;
    const type = item.payload ? parseTranscriptPayload(item.payload)?.type : undefined;
    if (type !== 'review-fix' && type !== 'subagent') request = item.text;
  });
  return request;
}

/** What `review.start`, `review.cancel` and the queue need from the coordinator (DaemonAgentRuntime option `reviews`). */
export interface DaemonReviewHost {
  /** Per provider id: whether it can review now. Providers whose adapter never reviews are absent. */
  support(snapshot: Pick<DaemonSnapshot, 'providers'>): Readonly<Record<string, DaemonReviewSupport>>;
  /** The base branch of the worktree a conversation works in (when the client named none). */
  worktreeBase(snapshot: DaemonSnapshot, workspaceId: string): Promise<string | undefined>;
  /** The 단계 연결 review agent's model and effort, when that agent is this AI. */
  reviewAgent(providerId: string): { readonly model?: string; readonly reasoningEffort?: string } | undefined;
  /** A review with this id is live, or is still to be marked interrupted after a restart. */
  knows(reviewId: string): boolean;
  /** The review, if it still waits or runs. */
  active(reviewId: string): ReviewJobRecord | undefined;
  /** A committed review starts (the command's afterCommit). */
  begin(job: ReviewJobStart): void;
  /** A committed cancel stops what still runs (the command's afterCommit; the command wrote the row). */
  cancel(reviewId: string): void;
}

export interface ReviewCoordinatorOptions {
  readonly getSnapshot: () => DaemonSnapshot;
  /** Evaluated under the command FIFO (the router's applySystemCommit). */
  readonly applySystemCommit: (commit: DaemonStoreCommit | DaemonSystemTransitionPlanner) => Promise<unknown>;
  readonly readTranscript: TranscriptReader;
  readonly execute: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  /** Wakes the managed queue once a reviewer turn's prompt is in place. */
  readonly wakeQueuedTurns: () => void;
  readonly providers: {
    reviewCapability(providerId: string): { readonly minimumVersion: string; readonly fork: boolean } | undefined;
    enabledAdapter(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): { readonly ok: true; readonly value: AgentProviderAdapter } | { readonly ok: false; readonly message: string };
  };
  readonly git: {
    getReviewDiff(directory: string, scope: GitReviewScope, signal?: AbortSignal): Promise<GitReviewDiffResult>;
    fingerprint(directory: string, signal?: AbortSignal): Promise<string | undefined>;
  };
  /** The branch the project's main checkout has out, for a worktree workspace; undefined otherwise. */
  readonly worktreeBase?: (snapshot: DaemonSnapshot, workspaceId: string) => Promise<string | undefined>;
  readonly reviewAgent?: (providerId: string) => { readonly model?: string; readonly reasoningEffort?: string } | undefined;
  /** The folders a conversation works in (its workspace and the project's other folders), as the runtime reads them. */
  readonly conversationFolders?: ConversationFolderResolver;
  /** Live reviews, so a restart can mark their cards interrupted. */
  readonly store?: {
    readonly load: () => Promise<unknown>;
    readonly save: (jobs: Readonly<Record<string, ReviewJobRecord>>) => Promise<void>;
  };
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface Job {
  readonly record: ReviewJobRecord;
  /** Waiting for the reviewed turn, reading the change, reviewer turn handed over (child), finished. */
  phase: 'waiting' | 'preparing' | 'prompted' | 'done';
  readonly waitTurnId?: string;
  readonly waitForQueue: boolean;
  readonly abort: AbortController;
  timedOut: boolean;
  timer?: ReturnType<typeof setTimeout>;
  startedAt?: number;
  /** The working folder's fingerprint before the reviewer read it (wroteFiles). */
  before?: string;
  /** The waiting/running state the card shows, so each change is written once. */
  shown: string;
  step: number;
}

/**
 * The review loop's host side (`review-loop-v1`). The `review.start` command commits the card and,
 * for a reviewer conversation, that conversation with its one queued turn; this coordinator runs the
 * review from there. It waits for the reviewed conversation's running turn to end (D13), reads the
 * change (GitStatusService.getReviewDiff), asks the reviewer — a read-only fork of the conversation
 * through the adapter, or the reviewer conversation's turn, held by `canDispatchTurn` until its prompt
 * is in place — and moves the card from queued and running to complete, failed, unsupported or
 * cancelled. A reviewer conversation is archived once it answered (D11). After a restart, what was
 * still live is marked interrupted.
 */
export class ReviewCoordinator implements DaemonReviewHost {
  private readonly now: () => Date;
  private readonly jobs = new Map<string, Job>();
  /** Reviewer turns whose prompt is in place: the only reviewer turns the queue may start. */
  private readonly prompted = new Set<string>();
  /** Reviews of the last run whose cards are still to be marked interrupted. */
  private readonly recovering = new Map<string, ReviewJobRecord>();
  private unsubscribe: (() => void) | undefined;
  private advanceScheduled = false;
  private disposed = false;

  constructor(private readonly options: ReviewCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Reviewer conversations run read-only and frozen to a person, whatever their record says. */
  preparedSessionSettings(sessionId: string): { readonly permissionPreset: 'plan'; readonly managedExecution: true; readonly readOnlyReviewer: true } | undefined {
    return sessionId.startsWith(REVIEWER_SESSION_PREFIX)
      ? { permissionPreset: 'plan', managedExecution: true, readOnlyReviewer: true }
      : undefined;
  }

  /** A reviewer turn starts only once its prompt (the change, read after the reviewed turn ended) is in place. */
  canDispatchTurn(turn: Pick<DaemonTurn, 'id' | 'sessionId'>): boolean {
    return !turn.sessionId.startsWith(REVIEWER_SESSION_PREFIX) || this.prompted.has(turn.id);
  }

  support(snapshot: Pick<DaemonSnapshot, 'providers'>): Readonly<Record<string, DaemonReviewSupport>> {
    const support: Record<string, DaemonReviewSupport> = {};
    for (const provider of snapshot.providers) {
      const capability = this.options.providers.reviewCapability(provider.id);
      if (!capability) continue;
      if (!provider.enabled || provider.health !== 'ready') {
        support[provider.id] = { self: false, reviewer: false, reason: 'provider-unavailable' };
        continue;
      }
      const version = semanticVersion(provider.executableVersion);
      const minimum = semanticVersion(capability.minimumVersion);
      if (!version || !minimum || version.prerelease !== undefined || compareSemanticVersions(version, minimum) < 0) {
        support[provider.id] = { self: false, reviewer: false, reason: 'provider-too-old' };
        continue;
      }
      support[provider.id] = { self: capability.fork, reviewer: true };
    }
    return support;
  }

  worktreeBase(snapshot: DaemonSnapshot, workspaceId: string): Promise<string | undefined> {
    return this.options.worktreeBase?.(snapshot, workspaceId) ?? Promise.resolve(undefined);
  }

  reviewAgent(providerId: string): { readonly model?: string; readonly reasoningEffort?: string } | undefined {
    return this.options.reviewAgent?.(providerId);
  }

  knows(reviewId: string): boolean {
    return this.jobs.has(reviewId) || this.recovering.has(reviewId);
  }

  active(reviewId: string): ReviewJobRecord | undefined {
    const job = this.jobs.get(reviewId);
    return job && job.phase !== 'done' ? job.record : undefined;
  }

  /**
   * Marks the reviews the last run left live interrupted (`app-closed`), stops and archives reviewer
   * conversations nothing runs any more, then follows the daemon's events.
   */
  async start(): Promise<void> {
    if (this.disposed || this.unsubscribe) return;
    // Only reviewer conversations that exist now are leftovers; one a review starts meanwhile is live.
    const leftovers = this.options.getSnapshot().sessions
      .filter((session) => session.id.startsWith(REVIEWER_SESSION_PREFIX) && !session.archivedAt)
      .map((session) => session.id);
    this.unsubscribe = this.options.onEvent((event) => {
      if (event.kind === 'entity.upserted' || event.kind === 'entity.archived' || event.kind === 'transcript.appended') this.scheduleAdvance();
    });
    try {
      for (const record of parseJobs(await this.options.store?.load())) this.recovering.set(record.reviewId, record);
    } catch (error) {
      this.report('review jobs load failed', error);
    }
    for (const record of [...this.recovering.values()]) {
      await this.commit((snapshot) => {
        const session = snapshot.sessions.find((entry) => entry.id === record.sessionId);
        if (!session || session.archivedAt) return undefined;
        return this.rowCommit(reviewRowItem({ ...record, id: stableId('review-row', record.reviewId, 'interrupted'), state: 'interrupted', reason: 'app-closed' }));
      });
      this.recovering.delete(record.reviewId);
    }
    await this.saveJobs();
    const live = new Set([...this.jobs.values()].map((job) => job.record.child?.sessionId));
    for (const sessionId of leftovers) if (!live.has(sessionId)) await this.endReviewer(sessionId);
  }

  /** Stops what runs now; the store keeps the live reviews, so the next start marks them interrupted. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.abort.abort();
    }
  }

  begin(start: ReviewJobStart): void {
    if (this.disposed || this.jobs.has(start.reviewId)) return;
    const { waitTurnId, waitForQueue, queued, ...record } = start;
    const job: Job = {
      record,
      phase: 'waiting',
      ...(waitTurnId ? { waitTurnId } : {}),
      waitForQueue: waitForQueue === true,
      abort: new AbortController(),
      timedOut: false,
      shown: queued ? 'queued:turn' : 'running',
      step: 0,
    };
    this.jobs.set(record.reviewId, job);
    void this.saveJobs();
    this.advance(job);
  }

  cancel(reviewId: string): void {
    const job = this.jobs.get(reviewId);
    if (!job || job.phase === 'done') return;
    this.settle(job);
  }

  private scheduleAdvance(): void {
    if (this.advanceScheduled || this.disposed) return;
    this.advanceScheduled = true;
    setImmediate(() => {
      this.advanceScheduled = false;
      for (const job of [...this.jobs.values()]) this.advance(job);
    });
  }

  /** Moves a job on from what the daemon shows now. */
  private advance(job: Job): void {
    if (this.disposed || job.phase === 'done' || job.phase === 'preparing') return;
    const snapshot = this.options.getSnapshot();
    const session = snapshot.sessions.find((entry) => entry.id === job.record.sessionId);
    if (!session || session.archivedAt || session.state === 'archived') {
      void this.end(job, { state: 'failed', reason: 'conversation-closed' });
      return;
    }
    if (job.phase === 'waiting') {
      const turn = job.waitTurnId ? snapshot.turns.find((entry) => entry.id === job.waitTurnId) : undefined;
      if (turn && !TERMINAL_TURN_STATES.has(turn.state)) return;
      // Same AI: the turns queued behind it would run (and change files) during the review.
      if (job.waitForQueue && conversationBusy(snapshot, job.record.sessionId)) return;
      job.phase = 'preparing';
      void this.run(job).catch(async (error: unknown) => {
        this.report(`review ${job.record.reviewId}`, error);
        await this.end(job, { state: 'failed', reason: 'provider-error' });
      });
      return;
    }
    // Handed to the reviewer conversation: follow its turn.
    const turn = snapshot.turns.find((entry) => entry.id === job.record.child!.turnId);
    if (!turn) {
      void this.end(job, { state: 'failed', reason: 'provider-error' });
    } else if (TERMINAL_TURN_STATES.has(turn.state)) {
      job.phase = 'preparing';
      void this.finishReviewer(job, turn);
    } else if (turn.state === 'queued') {
      // Started reviews wait their turn in the managed queue like any other conversation.
      if (snapshot.turns.filter((entry) => ACTIVE_TURN_STATES.has(entry.state)).length >= DAEMON_HARD_LIMITS.concurrentManagedTurns) {
        void this.show(job, 'queued', 'slot');
      }
    } else {
      this.armTimeout(job);
      void this.show(job, 'running');
    }
  }

  /** Reads the change, then runs the fork or hands the prompt to the reviewer conversation. */
  private async run(job: Job): Promise<void> {
    const snapshot = this.options.getSnapshot();
    const session = snapshot.sessions.find((entry) => entry.id === job.record.sessionId);
    const workspace = session ? snapshot.workspaces.find((entry) => entry.id === session.workspaceId && !entry.archivedAt) : undefined;
    if (!session || !workspace) {
      await this.end(job, { state: 'failed', reason: 'conversation-closed' });
      return;
    }
    await this.show(job, 'running');
    job.startedAt = this.now().getTime();
    const { target, focus } = job.record;
    const diff = await this.options.git.getReviewDiff(workspace.rootPath, target, job.abort.signal);
    if (this.stopped(job)) return;
    if (!diff.ok) {
      await this.end(job, diff.error === 'not-a-repository'
        ? { state: 'unsupported', reason: 'not-git' }
        : {
            state: 'failed',
            reason: diff.error !== 'no-base' ? 'Git could not read the changes in this working folder.'
              : target.kind === 'base-branch' ? `${target.baseRef} could not be compared with this branch.` : 'There is no commit to compare with yet.',
          });
      return;
    }
    if (!diff.text && diff.omissions.length === 0) {
      await this.end(job, { state: 'failed', reason: 'no-changes' });
      return;
    }
    job.before = await this.options.git.fingerprint(workspace.rootPath, job.abort.signal).catch(() => undefined);
    if (this.stopped(job)) return;
    const quoted = { target, diff: diff.text, omittedFiles: diff.omissions.map((omission) => omission.path), ...(focus ? { focus } : {}) };
    if (!job.record.child) {
      await this.runFork(job, workspace.rootPath, quoted);
      return;
    }
    // Another AI has no part of the conversation: it hears what the person asked for, quoted.
    const recentRequest = latestRequest(this.options.readTranscript, session.id);
    await this.promptReviewer(job, composeReviewPrompt({ ...quoted, ...(recentRequest ? { recentRequest } : {}) }));
  }

  /**
   * Same AI: first a fork that keeps the conversation's prompt cache and is asked for the findings as
   * JSON text; when that answer does not read as findings, once more in a new fork whose answer the
   * provider's schema channel enforces (it reads the conversation again without the cache). The card
   * stays running across both; a second miss is `invalid-output` with what the reviewer said.
   */
  private async runFork(job: Job, workspaceRoot: string, quoted: Omit<Parameters<typeof composeReviewPrompt>[0], 'answerFormat'>): Promise<void> {
    const snapshot = this.options.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === job.record.sessionId);
    const provider = agent ? this.options.providers.enabledAdapter(snapshot, agent.providerId) : undefined;
    if (!agent?.providerSessionId || !provider?.ok) {
      await this.end(job, { state: 'unsupported', reason: 'provider-unavailable' });
      return;
    }
    if (!provider.value.reviewFork) {
      await this.end(job, { state: 'unsupported', reason: 'provider-too-old' });
      return;
    }
    this.armTimeout(job);
    const session = snapshot.sessions.find((entry) => entry.id === job.record.sessionId);
    const folders = session && this.options.conversationFolders
      ? await this.options.conversationFolders(snapshot, { projectId: session.projectId, workspaceId: session.workspaceId }).catch(() => undefined)
      : undefined;
    if (this.stopped(job)) return;
    let said: string | undefined;
    for (const answerFormat of ['json-text', 'enforced'] as const) {
      let result: Awaited<ReturnType<NonNullable<AgentProviderAdapter['reviewFork']>>>;
      try {
        result = await provider.value.reviewFork({
          sessionId: agent.sessionId,
          providerSessionId: agent.providerSessionId,
          workspaceRoot,
          ...(folders?.additional.length ? { additionalRoots: folders.additional } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          prompt: composeReviewPrompt({ ...quoted, answerFormat }),
          answerFormat,
        }, job.abort.signal);
      } catch (error) {
        if (job.timedOut) {
          await this.end(job, { state: 'failed', reason: 'timeout' });
        } else if (!this.stopped(job)) {
          const code = error instanceof ProviderReviewError ? error.code : 'failed';
          await this.end(job, code === 'unavailable' ? { state: 'unsupported', reason: 'provider-unavailable' }
            : code === 'unsupported' ? { state: 'unsupported', reason: 'provider-too-old' }
              : { state: 'failed', reason: 'provider-error' });
        }
        return;
      }
      if (this.stopped(job)) return;
      const output = result.output ?? (result.text !== undefined ? parseStructuredText(result.text) : undefined);
      if (fromStructuredJson(output, { reviewId: job.record.reviewId, workspaceRoot }).ok) {
        await this.complete(job, workspaceRoot, output, result.text);
        return;
      }
      if (result.text?.trim()) said = result.text;
    }
    // Never a made-up result: the card says the answer was not in the format and shows what was said.
    await this.complete(job, workspaceRoot, undefined, said);
  }

  /** The reviewer conversation's first message is the prompt, as its own row; then its turn may start. */
  private async promptReviewer(job: Job, prompt: string): Promise<void> {
    const child = job.record.child!;
    let placed = false;
    await this.commit((snapshot) => {
      const turn = snapshot.turns.find((entry) => entry.id === child.turnId && entry.sessionId === child.sessionId);
      if (job.phase === 'done' || !turn || turn.state !== 'queued') return undefined;
      placed = true;
      return { mutations: [{ kind: 'transcript.append', items: [{
        id: stableId('review-request', job.record.reviewId),
        sessionId: child.sessionId,
        turnId: child.turnId,
        kind: 'user-message',
        text: prompt,
        isDelta: false,
        isSensitive: false,
        payload: { v: 1, type: 'review-request', reviewId: job.record.reviewId, target: job.record.target, ...(job.record.focus ? { focus: job.record.focus } : {}) },
        createdAt: this.now().toISOString(),
      }] }] };
    });
    if (this.stopped(job)) return;
    if (!placed) {
      // The reviewer turn is gone (stopped from its own conversation) before it could start.
      await this.end(job, { state: 'cancelled' });
      return;
    }
    job.phase = 'prompted';
    this.prompted.add(child.turnId);
    this.options.wakeQueuedTurns();
    this.scheduleAdvance();
  }

  /** The reviewer turn ended: its last message is the answer. */
  private async finishReviewer(job: Job, turn: DaemonTurn): Promise<void> {
    const child = job.record.child!;
    this.prompted.delete(child.turnId);
    if (job.timedOut) {
      await this.end(job, { state: 'failed', reason: 'timeout' });
    } else if (turn.state === 'interrupted') {
      // Stopped from the reviewer conversation itself.
      await this.end(job, { state: 'cancelled' });
    } else if (turn.state === 'failed') {
      await this.end(job, { state: 'failed', reason: 'provider-error' });
    } else {
      const text = finalAssistantText(this.options.readTranscript, child.sessionId, turn.id);
      const snapshot = this.options.getSnapshot();
      const session = snapshot.sessions.find((entry) => entry.id === job.record.sessionId);
      const root = session ? snapshot.workspaces.find((entry) => entry.id === session.workspaceId)?.rootPath : undefined;
      await this.complete(job, root ?? '', text !== undefined ? parseStructuredText(text) : undefined, text);
    }
  }

  private async complete(job: Job, workspaceRoot: string, output: unknown, text: string | undefined): Promise<void> {
    if (this.stopped(job)) return;
    const normalized = fromStructuredJson(output, { reviewId: job.record.reviewId, workspaceRoot });
    const after = workspaceRoot ? await this.options.git.fingerprint(workspaceRoot).catch(() => undefined) : undefined;
    const wroteFiles = job.before !== undefined && after !== undefined && after !== job.before;
    const findings = normalized.ok ? await withExcerpts(workspaceRoot, normalized.findings) : [];
    await this.end(job, normalized.ok
      ? {
          state: 'complete',
          findings,
          ...(normalized.overall ? { overall: normalized.overall } : {}),
          ...(normalized.truncated ? { truncated: true } : {}),
          ...(normalized.dropped ? { dropped: normalized.dropped } : {}),
          ...(wroteFiles ? { wroteFiles } : {}),
        }
      // Never a made-up result: the card says the format was wrong and shows what the reviewer said.
      : { state: 'failed', reason: 'invalid-output', ...(text?.trim() ? { rawText: text.trim() } : {}), ...(wroteFiles ? { wroteFiles } : {}) });
  }

  /** Writes the review's final row, then lets go of everything it holds. */
  private async end(job: Job, row: Pick<ReviewRowInput, 'state' | 'reason' | 'findings' | 'overall' | 'truncated' | 'dropped' | 'rawText' | 'wroteFiles'>): Promise<void> {
    if (job.phase === 'done' || this.disposed) return;
    const durationMs = job.startedAt !== undefined && row.state !== 'unsupported' ? this.now().getTime() - job.startedAt : undefined;
    await this.write(job, { ...row, ...(durationMs !== undefined ? { durationMs } : {}) }, true);
    this.settle(job);
  }

  /** The job is no longer live: stop its fork, and stop and archive its reviewer conversation. */
  private settle(job: Job): void {
    this.finish(job);
    job.abort.abort();
    const child = job.record.child;
    if (child) void this.endReviewer(child.sessionId).catch((error: unknown) => this.report(`archive reviewer ${child.sessionId}`, error));
  }

  /** Writes a waiting/running row when what the card shows changes. */
  private async show(job: Job, state: 'queued' | 'running', waitingFor?: 'turn' | 'slot'): Promise<void> {
    const key = waitingFor ? `${state}:${waitingFor}` : state;
    if (job.shown === key) return;
    job.shown = key;
    await this.write(job, { state, ...(waitingFor ? { waitingFor } : {}) }, false);
  }

  private async write(job: Job, row: Omit<ReviewRowInput, 'id' | 'sessionId' | 'reviewId' | 'reviewer' | 'target' | 'focus'>, terminal: boolean): Promise<void> {
    const step = String(++job.step);
    await this.commit((snapshot) => {
      // A person's cancel (its own row) or another end settled this review first.
      if (job.phase === 'done' || !snapshot.sessions.some((entry) => entry.id === job.record.sessionId)) return undefined;
      if (terminal) this.finish(job);
      return this.rowCommit(reviewRowItem({ ...job.record, ...row, id: stableId('review-row', job.record.reviewId, step) }));
    });
  }

  /** The job stops counting as live and leaves the store, so a restart does not mark it again. */
  private finish(job: Job): void {
    if (job.phase === 'done') return;
    job.phase = 'done';
    if (job.timer) clearTimeout(job.timer);
    if (job.record.child) this.prompted.delete(job.record.child.turnId);
    void this.saveJobs();
  }

  private stopped(job: Job): boolean {
    return this.disposed || job.phase === 'done' || job.abort.signal.aborted;
  }

  private armTimeout(job: Job): void {
    if (job.timer || job.phase === 'done') return;
    job.timer = setTimeout(() => {
      if (job.phase === 'done') return;
      job.timedOut = true;
      job.abort.abort();
      // A fork answers its abort; a reviewer conversation is stopped here.
      if (job.record.child) void this.end(job, { state: 'failed', reason: 'timeout' });
    }, this.options.timeoutMs ?? REVIEW_TIMEOUT_MS);
    job.timer.unref?.();
  }

  /** Stops a reviewer conversation's turns, then archives it; it stays readable from the card (D11). */
  private async endReviewer(sessionId: string): Promise<void> {
    const busy = (): boolean => {
      const snapshot = this.options.getSnapshot();
      const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
      return Boolean(agent && (agent.currentTurnId || agent.queuedTurnCount > 0
        || snapshot.turns.some((turn) => turn.sessionId === sessionId && !TERMINAL_TURN_STATES.has(turn.state))));
    };
    const session = this.options.getSnapshot().sessions.find((entry) => entry.id === sessionId);
    if (!session || session.archivedAt) return;
    if (busy()) {
      await this.command('agent.cancel', { sessionId });
      await this.waitUntil(() => !busy(), SETTLE_TIMEOUT_MS);
    }
    await this.command('agent.archive', { sessionId });
  }

  private waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = this.options.onEvent(() => setImmediate(() => { if (!settled && done()) finish(true); }));
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (done()) finish(true);
    });
  }

  private async command<T extends 'agent.cancel' | 'agent.archive'>(type: T, payload: DaemonCommandPayloads[T]): Promise<DaemonCommandReceipt | undefined> {
    let receipt: DaemonCommandReceipt | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.options.getSnapshot();
      const id = stableId('review-command', type, JSON.stringify(payload), String(snapshot.revision));
      receipt = await this.options.execute(createDaemonCommand<T>({
        commandId: id,
        idempotencyKey: id,
        expectedRevision: snapshot.revision,
        issuedAt: this.now().toISOString(),
        principal: REVIEW_PRINCIPAL,
        type,
        payload,
      }) as DaemonCommand);
      if (receipt.ok || receipt.error.code !== 'revision-conflict') return receipt;
    }
    return receipt;
  }

  private rowCommit(item: DaemonTranscriptItemInput): DaemonStoreCommit {
    return { mutations: [{ kind: 'transcript.append', items: [{ ...item, createdAt: item.createdAt ?? this.now().toISOString() }] }] };
  }

  private async commit(planner: DaemonSystemTransitionPlanner): Promise<void> {
    if (this.disposed) return;
    try {
      await this.options.applySystemCommit(planner);
    } catch (error) {
      this.report('review row', error);
    }
  }

  private async saveJobs(): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    const records: Record<string, ReviewJobRecord> = Object.fromEntries(this.recovering);
    for (const job of this.jobs.values()) if (job.phase !== 'done') records[job.record.reviewId] = job.record;
    try {
      await store.save(records);
    } catch (error) {
      this.report('review jobs save failed', error);
    }
  }

  private report(context: string, error: unknown): void {
    this.options.reportError?.(context, error);
  }
}

/** Accepts only the shape this build writes; anything else is dropped rather than trusted. */
function parseJobs(value: unknown): ReviewJobRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const records: ReviewJobRecord[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const record = entry && typeof entry === 'object' ? entry as Partial<ReviewJobRecord> : undefined;
    if (!record || typeof record.reviewId !== 'string' || typeof record.sessionId !== 'string' || !record.sessionId) continue;
    const payload = parseTranscriptPayload({ v: 1, type: 'review', reviewId: record.reviewId, reviewer: record.reviewer, target: record.target, state: 'interrupted' });
    if (payload?.type !== 'review') continue;
    const child = record.child && typeof record.child.sessionId === 'string' && typeof record.child.turnId === 'string'
      ? { sessionId: record.child.sessionId, turnId: record.child.turnId } : undefined;
    records.push({
      reviewId: payload.reviewId,
      sessionId: record.sessionId,
      reviewer: payload.reviewer,
      target: payload.target,
      ...(typeof record.focus === 'string' && record.focus ? { focus: record.focus.slice(0, REVIEW_LIMITS.focus) } : {}),
      ...(child ? { child } : {}),
    });
  }
  return records;
}

/** Why a provider cannot review, as the card's reason code (shared by the runtime's start checks). */
export function unsupportedReason(support: DaemonReviewSupport | undefined, kind: 'self' | 'reviewer'): ReviewFailureReason | undefined {
  if (!support) return 'provider-unavailable';
  if (kind === 'self' ? support.self : support.reviewer) return undefined;
  return support.reason ?? 'provider-too-old';
}
