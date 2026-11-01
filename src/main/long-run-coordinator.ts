import { createHash } from 'node:crypto';

import type { DaemonEvent, DaemonSnapshot, DaemonTurn } from '../shared/daemon-protocol';
import {
  RESUME_TIMING,
  resumesByItself,
  turnAutoResumeOff,
  USAGE_LIMIT_ERROR,
  type AppSentReason,
  type LongRunSettings,
  type OpenUsageLimit,
  type ProviderUsageLimit,
  type UsageLimitPhase,
  type UsageLimitReading,
} from '../shared/long-run';
import { parseTranscriptPayload, type UsageLimitPayload } from '../shared/transcript-payload';
import type { AgentProviderAdapter } from './agent-provider-adapter';
import type { DaemonSystemTransitionPlanner } from './daemon-command-router';
import type { DaemonStoreCommit, DaemonTranscriptItemInput } from './daemon-store';

/** A turn a usage limit stopped, as the runtime hands it over. */
export interface LimitStop {
  readonly sessionId: string;
  readonly providerId: string;
  readonly turn: DaemonTurn;
  readonly limit: ProviderUsageLimit;
  readonly stoppedAt: string;
}

/** What the runtime needs from the coordinator (DaemonAgentRuntime option `longRun`). */
export interface DaemonLongRunHost {
  /** Whether this session launches with long-run continuity. Undefined: a limit classifies as any error does. */
  sessionContext(sessionId: string): true | undefined;
  /**
   * A limit stopped this turn. Called under the command FIFO, in the planner that ends the turn: whatever it holds
   * applies before the pump can claim the next one.
   */
  limitStopped(stop: LimitStop): void;
}

/** One stop's card, as the jobs file keeps it: its row, plus what the host needs to carry on after a restart. */
export interface LimitJobRecord extends Omit<UsageLimitPayload, 'v' | 'type'> {
  readonly sessionId: string;
  /** The app's own tries the limit refused. */
  readonly attempt: number;
  /** Rows written: the row's id comes from it, so writing the same state again after a restart adds nothing. */
  readonly revision: number;
  /** Written before the command goes out: it says whether a "Continue." may be on its way. */
  readonly sending?: {
    readonly commandId: string;
    readonly reason: AppSentReason;
    /** The phase it was sent from: a refused 지금 시도 goes back to it, keeping its clock. */
    readonly from: UsageLimitPhase;
  };
}

/** Finished: the last row is the record, and nothing more can happen. */
const FINISHED_PHASES = new Set<UsageLimitPhase>(['resumed', 'cancelled', 'not-included']);
/** Still a card with 이어서 하기, but nothing waits on it: the queue goes on and the list shows nothing. */
const RELEASED_PHASES = new Set<UsageLimitPhase>(['left', 'person-refused']);
/** The AIs a managed child's resume was proved on (D7): the live scenario adds them. */
const MANAGED_RESUME_PROVEN: ReadonlySet<string> = new Set();
/** D4: the first try, and one later one. */
const RESUME_ATTEMPTS = 2;

const finished = (job: LimitJobRecord): boolean => FINISHED_PHASES.has(job.phase) || (job.phase === 'child' && job.childKind === 'managed');
const holds = (job: LimitJobRecord): boolean => !finished(job) && !RELEASED_PHASES.has(job.phase);

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

/** Reads on its own for clients without cards, and never says a limit has lifted: nothing tells the app that. */
const LIMIT_ROW_TEXT: Readonly<Record<UsageLimitPhase, string>> = {
  waiting: 'A usage limit stopped this turn. The app will send "Continue." after the expected reset.',
  resuming: 'Sending "Continue." to pick up where the usage limit stopped this turn.',
  resumed: 'Continued after the usage limit.',
  retrying: 'The usage limit refused "Continue.". The app will try once more.',
  'gave-up': 'The usage limit refused "Continue." twice. Nothing more goes out until you continue.',
  'ask-reset': 'A usage limit stopped this turn. Nothing goes out until you say so.',
  scheduled: 'A usage limit stopped this turn. The app will send "Continue." at the time you chose.',
  'ask-unknown': 'A usage limit stopped this turn, and its reset time is not known.',
  'ask-reopened': 'The expected reset passed while the app was closed. Nothing went out.',
  off: 'A usage limit stopped this turn. Automatic resume is off, so nothing goes out by itself.',
  left: 'A usage limit stopped this turn. It was left as it is.',
  cancelled: 'A message went out before the app sent one, so nothing more goes out.',
  'person-refused': 'The usage limit refused your message. It stays in the conversation.',
  skipped: 'An open request was waiting when the time came, so nothing went out.',
  'not-included': 'This plan does not include this AI.',
  child: 'A usage limit stopped this sub-conversation. It does not resume by itself.',
  failed: 'The app could not send "Continue.". Nothing went out.',
  unconfirmed: 'The app cannot say whether "Continue." arrived.',
};

/** A `usage-limit` notice row; its bounds match TranscriptPayloadSchema, so the store keeps the payload. */
export function limitRowItem(job: LimitJobRecord): DaemonTranscriptItemInput {
  const payload: UsageLimitPayload = {
    v: 1,
    type: 'usage-limit',
    ...cardFields(job),
  };
  return {
    id: stableId('limit-row', job.stopId, String(job.revision)),
    sessionId: job.sessionId,
    turnId: job.turnId,
    kind: 'notice',
    text: LIMIT_ROW_TEXT[job.phase],
    isDelta: false,
    isSensitive: false,
    payload,
  };
}

/** What a card shows, without what only the host needs. */
function cardFields(job: Omit<UsageLimitPayload, 'v' | 'type'>): Omit<UsageLimitPayload, 'v' | 'type'> {
  return {
    stopId: job.stopId,
    turnId: job.turnId,
    providerId: job.providerId,
    phase: job.phase,
    window: job.window,
    stoppedAt: job.stoppedAt,
    ...(job.resetsAt ? { resetsAt: job.resetsAt } : {}),
    ...(job.resumeAt ? { resumeAt: job.resumeAt } : {}),
    ...(job.retryAt ? { retryAt: job.retryAt } : {}),
    ...(job.refusedAt ? { refusedAt: job.refusedAt } : {}),
    ...(job.triedAt ? { triedAt: job.triedAt } : {}),
    ...(job.offBy ? { offBy: job.offBy } : {}),
    ...(job.childKind ? { childKind: job.childKind } : {}),
    ...(job.failure ? { failure: job.failure } : {}),
  };
}

/** Accepts only the shape this build writes; anything else is dropped rather than trusted. */
function parseJobs(value: unknown): LimitJobRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const records: LimitJobRecord[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { sessionId, attempt, revision, sending, ...card } = entry as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(attempt) || !Number.isInteger(revision)) continue;
    const payload = parseTranscriptPayload({ v: 1, type: 'usage-limit', ...card });
    if (payload?.type !== 'usage-limit') continue;
    const send = sending as LimitJobRecord['sending'] | undefined;
    const validSend = typeof send?.commandId === 'string' && typeof send.reason === 'string' && typeof send.from === 'string';
    records.push({ ...cardFields(payload), sessionId, attempt: attempt as number, revision: revision as number, ...(validSend ? { sending: send } : {}) });
  }
  return records;
}

export interface LongRunCoordinatorOptions {
  readonly getSnapshot: () => DaemonSnapshot;
  /** Evaluated under the command FIFO (the router's applySystemCommit). */
  readonly applySystemCommit: (commit: DaemonStoreCommit | DaemonSystemTransitionPlanner) => Promise<unknown>;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  /** Lets go of a queue a stop was holding. */
  readonly wakeQueuedTurns: () => void;
  /** The command the jobs file says went out: absent, it never reached the host. */
  readonly commandExists: (commandId: string) => boolean;
  /** Limit jobs: the schedule's authority, so a restart need not read transcripts. */
  readonly store?: {
    readonly load: () => Promise<unknown>;
    readonly save: (jobs: Readonly<Record<string, LimitJobRecord>>) => Promise<void>;
  };
  readonly providers: {
    longRunCapability(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): AgentProviderAdapter['longRun'];
    enabledAdapter(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): { readonly ok: true; readonly value: AgentProviderAdapter } | { readonly ok: false; readonly message: string };
  };
  /** Read per event, so the switch acts at once. Undefined until the file has loaded: no automatic send until then. */
  readonly settings: () => LongRunSettings | undefined;
  /** `wrapUpAllowed` with the host's facts. With `turn`, the turn is asked about too. */
  readonly allowed: (sessionId: string, turn?: DaemonTurn) => boolean;
  /** A session the host prepared (workflow, reviewer, planning): it stays out of all this. */
  readonly prepared: (sessionId: string) => boolean;
  readonly now?: () => Date;
  readonly reportError?: (context: string, error: unknown) => void;
}

/**
 * Long-run continuity's host side (`long-run-v1`). A usage limit is a pause: the turn fails, the conversation stays
 * usable, and this coordinator keeps one card per stop, in the jobs file first and then as a row, so a crash between
 * them only writes the row again. While a stop is open the queue behind it holds, because a queued turn would only be
 * refused and stay in the session.
 */
export class LongRunCoordinator implements DaemonLongRunHost {
  private readonly now: () => Date;
  /** Open stops, by id; at most one per conversation, since a refused turn moves the card down. */
  private readonly jobs = new Map<string, LimitJobRecord>();
  private loading: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private passScheduled = false;
  private disposed = false;
  /** File, row, in the order things happened. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: LongRunCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Before the runtime's pump: a queue held across a restart must be held from its first pass. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        for (const job of parseJobs(await this.options.store?.load())) this.jobs.set(job.stopId, job);
      } catch (error) {
        this.report('limit jobs load failed', error);
      }
    })();
    return this.loading;
  }

  /** Applies D5 to what the last run left, once the runtime has reconciled its turns, then follows the daemon's events. */
  async start(): Promise<void> {
    if (this.disposed || this.unsubscribe) return;
    await this.load();
    this.unsubscribe = this.options.onEvent((event) => {
      if (event.kind === 'entity.archived') this.schedulePass();
    });
    const snapshot = this.options.getSnapshot();
    for (const job of [...this.jobs.values()]) {
      const session = snapshot.sessions.find((entry) => entry.id === job.sessionId);
      if (!session || session.archivedAt !== undefined) {
        this.jobs.delete(job.stopId);
        continue;
      }
      const reopened = this.reopened(snapshot, job);
      // Written again either way: a repeated row id adds nothing, and a crash may have lost the row.
      if (reopened) this.place(reopened);
      else this.write(job);
    }
    await this.tail;
    await this.saveJobs();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
  }

  /** Everything written so far has reached the file and the transcript. */
  settled(): Promise<void> {
    return this.tail;
  }

  sessionContext(sessionId: string): true | undefined {
    const snapshot = this.options.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!agent || !this.options.providers.longRunCapability(snapshot, agent.providerId)) return undefined;
    return this.options.allowed(sessionId) || this.managedChild(snapshot, sessionId) ? true : undefined;
  }

  /** The turn may start: nothing behind an open stop does, except the send that resumes it. */
  canDispatchTurn(turn: Pick<DaemonTurn, 'sessionId' | 'commandId'>): boolean {
    const job = this.jobOf(turn.sessionId);
    return !job || !holds(job) || job.sending?.commandId === turn.commandId;
  }

  /** Which AIs run this now, by provider id. */
  support(snapshot: Pick<DaemonSnapshot, 'providers'>): Readonly<Record<string, boolean>> {
    return Object.fromEntries(snapshot.providers.map((provider) => [provider.id, this.options.providers.longRunCapability(snapshot, provider.id) !== undefined]));
  }

  /** What the snapshot carries: the list and the feed have no transcripts. Never stored. */
  usageLimits(snapshot: Pick<DaemonSnapshot, 'sessions'>): DaemonSnapshot['usageLimits'] {
    const open = [...this.jobs.values()].filter((job) => holds(job) && snapshot.sessions.some((session) => session.id === job.sessionId && session.archivedAt === undefined));
    return open.length ? Object.fromEntries(open.map((job) => [job.sessionId, this.view(job)])) : undefined;
  }

  limitStopped(stop: LimitStop): void {
    if (this.disposed) return;
    const open = this.jobOf(stop.sessionId);
    if (open?.sending?.commandId === stop.turn.commandId) {
      this.place(this.refused(open, stop.turn.id, stop.stoppedAt, stop.limit));
      return;
    }
    if (open && holds(open)) {
      this.place(this.moved(open, stop));
      return;
    }
    if (open) this.jobs.delete(open.stopId);
    const job = this.newJob(stop);
    if (!job) return;
    const placed = this.place(job);
    if (placed.phase === 'ask-unknown') void this.recover(placed);
  }

  /** The Settings switch went off: what has not gone out is cancelled, and turning it on restores nothing. */
  settingsChanged(): void {
    if (this.disposed || !this.unsubscribe || this.options.settings()?.autoResume !== false) return;
    for (const job of [...this.jobs.values()]) {
      const off = turnAutoResumeOff(job);
      if (off !== job) this.place(off);
    }
  }

  private jobOf(sessionId: string): LimitJobRecord | undefined {
    return [...this.jobs.values()].find((job) => job.sessionId === sessionId);
  }

  private managedChild(snapshot: Pick<DaemonSnapshot, 'agentRelations'>, sessionId: string): boolean {
    return !this.options.prepared(sessionId) && snapshot.agentRelations.some((relation) => (
      relation.childSessionId === sessionId && relation.owner === 'managed' && relation.detachedAt === undefined
    ));
  }

  private view(job: LimitJobRecord): OpenUsageLimit {
    return cardFields(job);
  }

  /** A person's conversation, or a managed child. No other session launches with `longRun`, so no other gets here. */
  private newJob(stop: LimitStop): LimitJobRecord | undefined {
    const snapshot = this.options.getSnapshot();
    const child = !this.options.allowed(stop.sessionId) && this.managedChild(snapshot, stop.sessionId);
    if (!child && !this.options.allowed(stop.sessionId)) return undefined;
    const base = {
      stopId: stableId('limit-stop', stop.turn.id),
      sessionId: stop.sessionId,
      turnId: stop.turn.id,
      providerId: stop.providerId,
      stoppedAt: stop.stoppedAt,
      window: stop.limit.window,
      ...(stop.limit.resetsAt ? { resetsAt: stop.limit.resetsAt } : {}),
      attempt: 0,
      revision: 0,
    };
    if (stop.limit.kind === 'not-included') return { ...base, phase: 'not-included' };
    if (child) return { ...base, phase: 'child', childKind: MANAGED_RESUME_PROVEN.has(stop.providerId) ? 'managed-supported' : 'managed' };
    return { ...base, ...this.schedule(stop.limit, stop.sessionId, stop.turn, stop.stoppedAt) };
  }

  /** D2: by itself only for a turn a person sent and a known reset within hours; every other stop asks first. */
  private schedule(
    limit: UsageLimitReading,
    sessionId: string,
    turn: DaemonTurn | undefined,
    stoppedAt: string,
  ): Pick<LimitJobRecord, 'phase' | 'resumeAt' | 'offBy'> {
    const stopped = Date.parse(stoppedAt);
    // A reset that has already passed is a stop right after it: the try still waits its own time.
    const resumeAt = limit.resetsAt ? { resumeAt: new Date(Math.max(Date.parse(limit.resetsAt), stopped) + RESUME_TIMING.afterResetMs).toISOString() } : {};
    const settings = this.options.settings();
    if (!settings || !turn || !resumesByItself(limit, stopped) || !this.options.allowed(sessionId, turn)) {
      return { phase: limit.resetsAt ? 'ask-reset' : 'ask-unknown', ...resumeAt };
    }
    return settings.autoResume ? { phase: 'waiting', ...resumeAt } : { phase: 'off', offBy: 'setting', ...resumeAt };
  }

  /** One card per stop: a turn refused while it is open moves the card down to itself. */
  private moved(job: LimitJobRecord, stop: LimitStop): LimitJobRecord {
    const known = stop.limit.window === 'unknown' ? {} : { window: stop.limit.window };
    return { ...job, turnId: stop.turn.id, ...known, ...(stop.limit.resetsAt ? { resetsAt: stop.limit.resetsAt } : {}) };
  }

  /** The limit refused the app's own "Continue.". A refused 지금 시도 spends no attempt and keeps its clock. */
  private refused(job: LimitJobRecord, turnId: string, refusedAt: string, limit?: UsageLimitReading): LimitJobRecord {
    const { sending, ...rest } = job;
    const reading = { ...(limit && limit.window !== 'unknown' ? { window: limit.window } : {}), ...(limit?.resetsAt ? { resetsAt: limit.resetsAt } : {}) };
    if (sending?.reason === 'try-now') return { ...rest, ...reading, turnId, phase: sending.from, triedAt: refusedAt };
    const attempt = job.attempt + 1;
    return attempt >= RESUME_ATTEMPTS
      ? { ...rest, ...reading, turnId, attempt, phase: 'gave-up', refusedAt }
      : { ...rest, ...reading, turnId, attempt, phase: 'retrying', refusedAt, retryAt: new Date(Date.parse(refusedAt) + RESUME_TIMING.retryAfterRefusalMs).toISOString() };
  }

  /** D5, and what became of a send the last run left unanswered. Undefined: it stands as it is. */
  private reopened(snapshot: DaemonSnapshot, job: LimitJobRecord): LimitJobRecord | undefined {
    const settings = this.options.settings();
    if (job.sending) {
      const { sending, ...rest } = job;
      const turn = snapshot.turns.find((entry) => entry.commandId === sending.commandId);
      if (!turn || !this.options.commandExists(sending.commandId)) return { ...rest, phase: 'ask-reopened' };
      if (turn.state === 'failed' && turn.errorCode === USAGE_LIMIT_ERROR) return this.refused(job, turn.id, turn.finishedAt ?? this.now().toISOString());
      if (turn.state === 'delivery-uncertain') return { ...job, phase: 'unconfirmed' };
      return turn.state === 'completed' || turn.state === 'interrupted' || turn.state === 'failed' ? { ...rest, phase: 'resumed' } : undefined;
    }
    const clock = job.phase === 'retrying' ? job.retryAt : job.phase === 'waiting' || job.phase === 'scheduled' ? job.resumeAt : undefined;
    if (clock === undefined) return undefined;
    if (settings?.autoResume === false) return turnAutoResumeOff(job);
    return Date.parse(clock) <= this.now().getTime() ? { ...job, phase: 'ask-reopened' } : undefined;
  }

  /** No time came with the stop: until this answers, the card says none is known. */
  private async recover(job: LimitJobRecord): Promise<void> {
    const snapshot = this.options.getSnapshot();
    const providerSessionId = snapshot.agents.find((entry) => entry.sessionId === job.sessionId)?.providerSessionId;
    const provider = this.options.providers.enabledAdapter(snapshot, job.providerId);
    if (!providerSessionId || !provider.ok) return;
    const reading = await provider.value.recoverLimit?.(job.sessionId, providerSessionId);
    const current = this.jobs.get(job.stopId);
    if (this.disposed || !reading?.resetsAt || current?.phase !== 'ask-unknown') return;
    const window = current.window === 'unknown' ? reading.window : current.window;
    const turn = this.options.getSnapshot().turns.find((entry) => entry.id === current.turnId);
    this.place({ ...current, window, resetsAt: reading.resetsAt, ...this.schedule({ window, resetsAt: reading.resetsAt }, current.sessionId, turn, current.stoppedAt) });
  }

  private place(job: LimitJobRecord): LimitJobRecord {
    const next = { ...job, revision: job.revision + 1 };
    this.jobs.set(next.stopId, next);
    this.write(next);
    return next;
  }

  /** The file first: a crash before the row writes the row again, never a card nothing stands behind. */
  private write(job: LimitJobRecord): void {
    this.tail = this.tail.then(async () => {
      await this.saveJobs();
      await this.commit((snapshot) => {
        const session = snapshot.sessions.find((entry) => entry.id === job.sessionId);
        if (!session || session.archivedAt !== undefined) return undefined;
        return {
          mutations: [{ kind: 'transcript.append', items: [{ ...limitRowItem(job), createdAt: this.now().toISOString() }] }],
          // Clients refetch the snapshot that carries the change, as they do for usage.
          events: [{ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: job.sessionId } }],
        };
      });
      if (finished(job) && this.jobs.get(job.stopId) === job) {
        this.jobs.delete(job.stopId);
        await this.saveJobs();
      }
      if (!holds(job)) this.options.wakeQueuedTurns();
    }).catch((error: unknown) => this.report('limit job write', error));
  }

  private schedulePass(): void {
    if (this.passScheduled || this.disposed) return;
    this.passScheduled = true;
    setImmediate(() => {
      this.passScheduled = false;
      if (!this.disposed) this.pass();
    });
  }

  /** A conversation archived or gone takes its stop with it. */
  private pass(): void {
    const snapshot = this.options.getSnapshot();
    let dropped = false;
    for (const job of [...this.jobs.values()]) {
      const session = snapshot.sessions.find((entry) => entry.id === job.sessionId);
      if (session && session.archivedAt === undefined) continue;
      this.jobs.delete(job.stopId);
      dropped = true;
    }
    if (dropped) this.tail = this.tail.then(() => this.saveJobs());
  }

  private async saveJobs(): Promise<void> {
    try {
      await this.options.store?.save(Object.fromEntries(this.jobs));
    } catch (error) {
      this.report('limit jobs save failed', error);
    }
  }

  private async commit(planner: DaemonStoreCommit | DaemonSystemTransitionPlanner): Promise<void> {
    if (this.disposed) return;
    try {
      await this.options.applySystemCommit(planner);
    } catch (error) {
      this.report('limit row', error);
    }
  }

  private report(context: string, error: unknown): void {
    this.options.reportError?.(context, error);
  }
}
