import { createHash } from 'node:crypto';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonCommandReceipt,
  type DaemonEvent,
  type DaemonSnapshot,
  type DaemonTurn,
} from '../shared/daemon-protocol';
import {
  LONG_RUN_PRINCIPAL,
  RESUME_TEXT,
  RESUME_TIMING,
  resumeDue,
  resumesByItself,
  turnAutoResumeOff,
  USAGE_LIMIT_ERROR,
  type AppSentReason,
  type LimitAction,
  type LongRunSettings,
  type OpenUsageLimit,
  type ProviderUsageLimit,
  type SteeredMessage,
  type SteerLanding,
  type UsageLimitPhase,
  type UsageLimitReading,
} from '../shared/long-run';
import { parseTranscriptPayload, type UsageLimitPayload } from '../shared/transcript-payload';
import type { AgentProviderAdapter } from './agent-provider-adapter';
import type { DaemonCommandExecutionResult, DaemonSystemTransitionPlanner } from './daemon-command-router';
import type { DaemonStoreCommit, DaemonTranscriptItemInput } from './daemon-store';
import type { TranscriptReader } from './managed-child-transcript';
import { conversationBusy } from './review-coordinator';
import { stoppingApproval } from './turn-wrap-up-coordinator';

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
  /** Under the FIFO, before anything is committed: whether the press stands. What it does runs in `afterCommit`. */
  limitAction(payload: DaemonCommandPayloads['long-run.limit-action']): DaemonCommandExecutionResult;
  /** A person's message is in the conversation: nothing goes out for this stop now, and its turn tells how the stop ends. */
  personSent(sessionId: string, turnId: string): void;
  /** A limit has stopped this conversation, and nothing has moved it on yet. */
  limitOpen(sessionId: string): boolean;
  /** On its way from now: the queue behind it holds at once, and it is in the file when this resolves. */
  steerSent(steer: SteerRecord): Promise<void>;
  /** What is known about it now. Landing is not in here: only `steerGone`, once its row is written. */
  steerMoved(id: string, next: SteerProgress): void;
  /** It has its place: a landed row, the queue, or back in the box. */
  steerGone(id: string): void;
  steerOf(id: string): SteerRecord | undefined;
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
  /** A person wrote before the app sent: the schedule is closed, and this turn alone goes past the hold. */
  readonly personTurnId?: string;
}

/** A message on its way into a running turn, as the jobs file keeps it. Its id is its command id. */
export interface SteerRecord extends SteeredMessage {
  readonly sessionId: string;
  /** The turn it was meant for. */
  readonly turnId: string;
  readonly providerId: string;
}

export type SteerProgress =
  | { readonly state: 'on-its-way'; readonly behind: NonNullable<SteeredMessage['behind']> }
  | { readonly state: 'failed'; readonly failure: NonNullable<SteeredMessage['failure']> }
  | { readonly state: 'unconfirmed' };

/** Finished: the last row is the record, and nothing more can happen. */
const FINISHED_PHASES = new Set<UsageLimitPhase>(['resumed', 'cancelled', 'not-included']);
/** Still a card with 이어서 하기, but nothing waits on it: the queue goes on and the list shows nothing. */
const RELEASED_PHASES = new Set<UsageLimitPhase>(['left', 'person-refused']);
/** The AIs a managed child's resume was proved on (D7): the live scenario adds them. */
const MANAGED_RESUME_PROVEN: ReadonlySet<string> = new Set();
/** D4: the first try, and one later one. */
const RESUME_ATTEMPTS = 2;
/** A send that keeps losing the revision race stops here, as a report-back does. */
const SEND_TRIES = 3;
/** Claude starts a steer right after a turn ends. If this passes with nothing, it stops holding the queue: it cannot be told. */
const STEER_LANDING_GRACE_MS = 30_000;
/** One timer, however far off the next time: each pass reads the clock, so a clock moved shows within this. */
const SCHEDULER_CAP_MS = 60_000;
/** What the timer waits at least, so a time already due cannot spin while something holds it back. */
const SCHEDULER_FLOOR_MS = 1_000;
/** The rows that prove the AI took it up. */
const ANSWER_KINDS = new Set(['assistant-message', 'tool-call']);
const TERMINAL_TURN_STATES = new Set<DaemonTurn['state']>(['completed', 'interrupted', 'failed']);
/** The card's buttons, by the phases that offer them. Anything else is a card out of date. */
const ACTION_PHASES: Readonly<Record<LimitAction, ReadonlySet<UsageLimitPhase>>> = {
  'try-now': new Set(['waiting']),
  resume: new Set(['gave-up', 'ask-unknown', 'ask-reopened', 'off', 'left', 'person-refused', 'unconfirmed', 'skipped', 'child', 'failed']),
  'auto-off': new Set(['waiting', 'retrying']),
  'auto-on': new Set(['off']),
  schedule: new Set(['ask-reset']),
  unschedule: new Set(['scheduled']),
  leave: new Set(['gave-up', 'ask-reset', 'ask-unknown', 'ask-reopened', 'unconfirmed', 'skipped']),
};

const finished = (job: LimitJobRecord): boolean => FINISHED_PHASES.has(job.phase) || (job.phase === 'child' && job.childKind === 'managed');
const holds = (job: LimitJobRecord): boolean => !finished(job) && !RELEASED_PHASES.has(job.phase);

/** When a job's clock says to send, if it waits on one. */
function dueAt(job: LimitJobRecord): number | undefined {
  if (job.personTurnId) return undefined;
  const clock = job.phase === 'retrying' ? job.retryAt : job.phase === 'waiting' || job.phase === 'scheduled' ? job.resumeAt : undefined;
  return clock === undefined ? undefined : Date.parse(clock);
}

function without(job: LimitJobRecord, key: 'personTurnId' | 'sending' | 'offBy'): LimitJobRecord {
  const copy = { ...job };
  delete copy[key];
  return copy;
}

/** What a person's turn made of the stop, once it can tell. A limit on a live turn comes through `limitStopped`, under the FIFO. */
function personOutcome(job: LimitJobRecord, turn: DaemonTurn): LimitJobRecord | undefined {
  if (turn.state === 'failed' && turn.errorCode === USAGE_LIMIT_ERROR) return { ...without(job, 'personTurnId'), turnId: turn.id, phase: 'person-refused' };
  return TERMINAL_TURN_STATES.has(turn.state) ? { ...without(job, 'personTurnId'), phase: 'cancelled' } : undefined;
}

const oldestFirst = (left: LimitJobRecord, right: LimitJobRecord): number => left.stoppedAt.localeCompare(right.stoppedAt) || left.stopId.localeCompare(right.stopId);

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
    ...(job.sendReason ? { sendReason: job.sendReason } : {}),
    ...(job.sentAt ? { sentAt: job.sentAt } : {}),
  };
}

/** The row of a message that landed, written where it landed. The queue would have written the same id: one row, either way. */
export function steerRowItem(steer: Pick<SteerRecord, 'id' | 'sessionId' | 'text'>, turnId: string, landing: Pick<SteerLanding, 'rewritten' | 'newTurn'>): DaemonTranscriptItemInput {
  return {
    id: stableId('message', steer.id, 'user'),
    sessionId: steer.sessionId,
    turnId,
    kind: 'user-message',
    text: steer.text,
    isDelta: false,
    isSensitive: false,
    payload: { v: 1, type: 'steer', ...landing },
  };
}

/** Accepts only the shape this build writes; anything else is dropped rather than trusted. */
function parseJobs(value: unknown): LimitJobRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const records: LimitJobRecord[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { sessionId, attempt, revision, sending, personTurnId, ...card } = entry as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(attempt) || !Number.isInteger(revision)) continue;
    const payload = parseTranscriptPayload({ v: 1, type: 'usage-limit', ...card });
    if (payload?.type !== 'usage-limit') continue;
    const send = sending as LimitJobRecord['sending'] | undefined;
    const validSend = typeof send?.commandId === 'string' && typeof send.reason === 'string' && typeof send.from === 'string';
    records.push({
      ...cardFields(payload), sessionId, attempt: attempt as number, revision: revision as number,
      ...(validSend ? { sending: send } : {}),
      ...(typeof personTurnId === 'string' ? { personTurnId } : {}),
    });
  }
  return records;
}

/** What a client sees of a steer: its words and where they are. */
function steerView({ id, text, state, sentAt, behind, failure, caught }: SteerRecord): SteeredMessage {
  return { id, text, state, sentAt, ...(behind ? { behind } : {}), ...(failure ? { failure } : {}), ...(caught ? { caught } : {}) };
}

/** A failed steer stays for the person; only these can be on the file. */
const STORED_STEER_STATES = new Set<SteeredMessage['state']>(['on-its-way', 'failed', 'unconfirmed']);

function parseSteers(value: unknown): SteerRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).flatMap((entry): SteerRecord[] => {
    const steer = entry as Partial<SteerRecord> | null;
    const texts = [steer?.id, steer?.sessionId, steer?.turnId, steer?.providerId, steer?.text, steer?.sentAt];
    return steer && texts.every((text) => typeof text === 'string' && text) && steer.state && STORED_STEER_STATES.has(steer.state) ? [steer as SteerRecord] : [];
  });
}

/** Limit jobs and steers: the file a restart reads, so it need not read transcripts. */
export interface LongRunJobs {
  readonly jobs: Readonly<Record<string, LimitJobRecord>>;
  readonly steers: Readonly<Record<string, SteerRecord>>;
}

export interface LongRunCoordinatorOptions {
  readonly getSnapshot: () => DaemonSnapshot;
  /** Evaluated under the command FIFO (the router's applySystemCommit). */
  readonly applySystemCommit: (commit: DaemonStoreCommit | DaemonSystemTransitionPlanner) => Promise<unknown>;
  readonly readTranscript: TranscriptReader;
  readonly execute: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  /** Lets go of a queue a stop was holding. */
  readonly wakeQueuedTurns: () => void;
  /** The command the jobs file says went out: absent, it never reached the host. */
  readonly commandExists: (commandId: string) => boolean;
  /** Limit jobs: the schedule's authority, so a restart need not read transcripts. */
  readonly store?: {
    readonly load: () => Promise<unknown>;
    readonly save: (state: LongRunJobs) => Promise<void>;
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
 *
 * When a time comes it sends "Continue.", the one thing the app sends with no press: per AI, oldest stop first, 60
 * seconds apart, never waiting for a result (D6). The send is written ahead of the command and never repeats by itself;
 * the outcome is read from what the turn does (D4). Nothing says a limit has lifted, so a time is only a try.
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
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Each AI's last send: the next one waits for the gap. */
  private readonly lastSend = new Map<string, number>();
  /** After a sleep, when the network has had its minute. */
  private notBefore = 0;
  /** The first row each session added since the last pass. */
  private readonly newRows = new Map<string, number>();
  /** Messages on their way into running turns, by command id. They have no row until they land. */
  private readonly steerRecords = new Map<string, SteerRecord>();
  /** Steers whose turn finished well: what they get before they stop holding the queue. */
  private readonly landingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: LongRunCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Before the runtime's pump: a queue held across a restart must be held from its first pass. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const { jobs, steers } = ((await this.options.store?.load()) ?? {}) as { readonly jobs?: unknown; readonly steers?: unknown };
        for (const job of parseJobs(jobs)) this.jobs.set(job.stopId, job);
        for (const steer of parseSteers(steers)) this.steerRecords.set(steer.id, steer);
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
      if (event.kind === 'transcript.appended') {
        const { sessionId, fromSequence } = event.payload;
        const job = this.jobOf(sessionId);
        if (job?.sending || job?.personTurnId) this.newRows.set(sessionId, Math.min(this.newRows.get(sessionId) ?? fromSequence, fromSequence));
      } else if (event.kind !== 'entity.archived' && !(event.kind === 'entity.upserted' && event.payload.entityType === 'turn')) {
        return;
      }
      this.schedulePass();
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
    this.arm();
    // Not awaited: a provider slow to answer must not hold up the start, and the queue holds until this has looked.
    this.tail = this.tail.then(() => this.recoverSteers()).catch((error: unknown) => this.report('steer recovery', error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.landingTimers.values()) clearTimeout(timer);
    this.landingTimers.clear();
  }

  /** The PC woke: a sleep is not the app closed, so the schedule stands, and the first send gives the network a minute. */
  wake(): void {
    this.notBefore = this.now().getTime() + RESUME_TIMING.lineGapMs;
    this.arm();
  }

  /** Everything written so far has reached the file and the transcript, what those writes led to included. */
  async settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.tail;
      await seen;
    } while (seen !== this.tail);
  }

  sessionContext(sessionId: string): true | undefined {
    const snapshot = this.options.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!agent || !this.options.providers.longRunCapability(snapshot, agent.providerId)) return undefined;
    return this.options.allowed(sessionId) || this.managedChild(snapshot, sessionId) ? true : undefined;
  }

  /**
   * The turn may start: nothing behind an open stop does, except the send that resumes it and a person's own message.
   * Nothing behind a steer does either: it may be about to become the next turn.
   */
  canDispatchTurn(turn: Pick<DaemonTurn, 'id' | 'sessionId' | 'commandId'>): boolean {
    if ([...this.steerRecords.values()].some((steer) => steer.sessionId === turn.sessionId && steer.state === 'on-its-way')) return false;
    const job = this.jobOf(turn.sessionId);
    return !job || !holds(job) || job.sending?.commandId === turn.commandId || job.personTurnId === turn.id;
  }

  limitOpen(sessionId: string): boolean {
    const job = this.jobOf(sessionId);
    return job !== undefined && holds(job);
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

  /** What the snapshot carries, one list per conversation. Never stored; no scoped reader and no phone cache keeps it. */
  steers(snapshot: Pick<DaemonSnapshot, 'sessions' | 'approvals'>): DaemonSnapshot['steers'] {
    const lists = new Map<string, SteeredMessage[]>();
    for (const steer of this.steerRecords.values()) {
      const { sessionId, turnId } = steer;
      if (!snapshot.sessions.some((session) => session.id === sessionId && session.archivedAt === undefined)) continue;
      const held = steer.state === 'on-its-way' && snapshot.approvals.some((approval) => approval.sessionId === sessionId && approval.turnId === turnId && approval.state === 'pending');
      lists.set(sessionId, [...(lists.get(sessionId) ?? []), { ...steerView(steer), ...(held ? { state: 'behind-approval' as const } : {}) }]);
    }
    return lists.size ? Object.fromEntries(lists) : undefined;
  }

  steerSent(steer: SteerRecord): Promise<void> {
    this.steerRecords.set(steer.id, steer);
    this.writeSteers(steer.sessionId);
    return this.tail;
  }

  steerMoved(id: string, next: SteerProgress): void {
    const steer = this.steerRecords.get(id);
    if (this.disposed || !steer || (next.state === 'on-its-way' && steer.state !== 'on-its-way') || (next.state === 'unconfirmed' && steer.state === 'unconfirmed')) return;
    const caught = next.state === 'unconfirmed' ? this.caughtBy(steer) : undefined;
    this.steerRecords.set(id, { ...steer, ...next, ...(caught ? { caught } : {}) });
    this.writeSteers(steer.sessionId);
    if (next.state !== 'on-its-way') this.options.wakeQueuedTurns();
  }

  steerGone(id: string): void {
    const steer = this.steerRecords.get(id);
    if (this.disposed || !steer) return;
    this.steerRecords.delete(id);
    this.stopLandingTimer(id);
    this.writeSteers(steer.sessionId);
    this.options.wakeQueuedTurns();
  }

  steerOf(id: string): SteerRecord | undefined {
    return this.steerRecords.get(id);
  }

  /** The file, then every client refetching the snapshot that shows it. */
  private writeSteers(sessionId: string): void {
    this.tail = this.tail.then(async () => {
      await this.saveJobs();
      await this.commit(() => ({ events: [{ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: sessionId } }] }));
    }).catch((error: unknown) => this.report('steer write', error));
  }

  private caughtBy(steer: SteerRecord): SteeredMessage['caught'] {
    const turn = this.options.getSnapshot().turns.find((entry) => entry.id === steer.turnId);
    if (turn?.state === 'interrupted') return 'stop';
    return turn?.state === 'failed' && turn.errorCode === USAGE_LIMIT_ERROR ? 'limit' : undefined;
  }

  private stopLandingTimer(id: string): void {
    const timer = this.landingTimers.get(id);
    if (timer) clearTimeout(timer);
    this.landingTimers.delete(id);
  }

  /** A steer outlived its turn. Limit or Stop first: it stays in the session, so it cannot be told. A clean end: it may start next. */
  private settleSteers(snapshot: DaemonSnapshot): boolean {
    let dropped = false;
    for (const steer of [...this.steerRecords.values()]) {
      if (!snapshot.sessions.some((session) => session.id === steer.sessionId && session.archivedAt === undefined)) {
        this.steerRecords.delete(steer.id);
        this.stopLandingTimer(steer.id);
        dropped = true;
      } else if (steer.state === 'on-its-way') {
        const turn = snapshot.turns.find((entry) => entry.id === steer.turnId);
        if (turn?.state === 'completed') this.waitForLanding(steer.id);
        else if (!turn || TERMINAL_TURN_STATES.has(turn.state)) this.steerMoved(steer.id, { state: 'unconfirmed' });
      }
    }
    return dropped;
  }

  private waitForLanding(id: string): void {
    if (this.landingTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.landingTimers.delete(id);
      this.steerMoved(id, { state: 'unconfirmed' });
    }, STEER_LANDING_GRACE_MS);
    timer.unref?.();
    this.landingTimers.set(id, timer);
  }

  /** What the last run left: only the thread can say. Found, it is a row; otherwise it cannot be told, and nothing goes again. */
  private async recoverSteers(): Promise<void> {
    for (const steer of [...this.steerRecords.values()]) {
      const snapshot = this.options.getSnapshot();
      if (this.disposed) return;
      if (!snapshot.sessions.some((session) => session.id === steer.sessionId && session.archivedAt === undefined)) {
        this.steerRecords.delete(steer.id);
        await this.saveJobs();
      } else if (steer.state !== 'failed') {
        if (await this.inThread(snapshot, steer)) {
          await this.commit(() => ({ mutations: [{ kind: 'transcript.append', items: [{ ...steerRowItem(steer, steer.turnId, {}), createdAt: this.now().toISOString() }] }] }));
          this.steerGone(steer.id);
        } else {
          this.steerMoved(steer.id, { state: 'unconfirmed' });
        }
      }
    }
  }

  /** No `turnId` in the question: with one, the adapter takes it for a turn to recover. */
  private async inThread(snapshot: DaemonSnapshot, steer: SteerRecord): Promise<boolean> {
    const providerSessionId = snapshot.agents.find((agent) => agent.sessionId === steer.sessionId)?.providerSessionId;
    const provider = this.options.providers.enabledAdapter(snapshot, steer.providerId);
    if (!providerSessionId || !provider.ok) return false;
    try {
      const { commands } = await provider.value.reconcile({ sessionId: steer.sessionId, providerSessionId, unsettledCommands: [{ commandId: steer.id, idempotencyKey: steer.id, type: 'agent.steer' }] });
      return commands.some((command) => command.commandId === steer.id && command.state === 'applied');
    } catch (error) {
      this.report(`steer recovery ${steer.id}`, error);
      return false;
    }
  }

  limitStopped(stop: LimitStop): void {
    if (this.disposed) return;
    const open = this.jobOf(stop.sessionId);
    if (open?.personTurnId === stop.turn.id) {
      this.place({ ...this.moved(without(open, 'personTurnId'), stop), phase: 'person-refused' });
      return;
    }
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

  limitAction({ sessionId, stopId, action }: DaemonCommandPayloads['long-run.limit-action']): DaemonCommandExecutionResult {
    const job = this.jobs.get(stopId);
    if (!job || job.sessionId !== sessionId) return { ok: false, error: { code: 'not-found', message: 'This card is no longer open.', retryable: false } };
    const offered = ACTION_PHASES[action].has(job.phase) && !job.personTurnId && (action !== 'auto-on' || job.offBy === 'card');
    if (!offered) return { ok: false, error: { code: 'invalid-state', message: 'This card has changed. Check it again.', retryable: false } };
    return { ok: true, afterCommit: () => this.act(stopId, action) };
  }

  personSent(sessionId: string, turnId: string): void {
    const job = this.jobOf(sessionId);
    if (this.disposed || !job || job.personTurnId || job.phase === 'resuming') return;
    this.jobs.set(job.stopId, { ...without(job, 'sending'), personTurnId: turnId });
    void this.queueSave();
    this.arm();
  }

  /** The Settings switch went off: what has not gone out is cancelled, and turning it on restores nothing. */
  settingsChanged(): void {
    if (this.disposed || !this.unsubscribe || this.options.settings()?.autoResume !== false) return;
    this.applySettingOff();
  }

  private act(stopId: string, action: LimitAction): void {
    const job = this.jobs.get(stopId);
    if (this.disposed || !job) return;
    switch (action) {
      case 'try-now':
        void this.send(job, 'try-now');
        return;
      case 'resume':
        void this.send(job, 'resume-pressed');
        return;
      case 'auto-off':
        this.place({ ...job, phase: 'off', offBy: 'card' });
        return;
      case 'auto-on': {
        const turn = this.options.getSnapshot().turns.find((entry) => entry.id === job.turnId);
        this.place({ ...without(job, 'offBy'), ...this.schedule({ window: job.window, ...(job.resetsAt ? { resetsAt: job.resetsAt } : {}) }, job.sessionId, turn, job.stoppedAt) });
        return;
      }
      case 'schedule':
        this.place(this.options.settings()?.autoResume === false ? turnAutoResumeOff({ ...job, phase: 'scheduled' }) : { ...job, phase: 'scheduled' });
        return;
      case 'unschedule':
        this.place({ ...job, phase: 'ask-reset' });
        return;
      case 'leave':
        this.place({ ...job, phase: 'left' });
    }
  }

  private applySettingOff(): void {
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
    const line = this.line(job);
    return { ...cardFields(job), ...(line ? { line } : {}) };
  }

  /** Stops of one AI whose times fall together share a line: the same reset, in practice. It is never stored. */
  private line(job: LimitJobRecord): OpenUsageLimit['line'] {
    const due = dueAt(job);
    if (due === undefined) return undefined;
    const peers = [...this.jobs.values()].filter((other) => {
      const theirs = dueAt(other);
      return other.providerId === job.providerId && theirs !== undefined && Math.abs(theirs - due) <= RESUME_TIMING.lineGapMs;
    }).sort(oldestFirst);
    return peers.length > 1 ? { position: peers.findIndex((other) => other.stopId === job.stopId) + 1, total: peers.length } : undefined;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.unsubscribe) return;
    const times = [...this.jobs.values()].flatMap((job) => dueAt(job) ?? []);
    if (times.length === 0) return;
    const wait = Math.min(SCHEDULER_CAP_MS, Math.max(SCHEDULER_FLOOR_MS, Math.min(...times) - this.now().getTime()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
      this.arm();
    }, wait);
    this.timer.unref?.();
  }

  /** Reads the clock itself, so a clock moved ahead tries early (refused, then +10 minutes, then it asks) and one moved back waits. */
  private fire(): void {
    if (this.disposed) return;
    const settings = this.options.settings();
    if (!settings) return;
    if (!settings.autoResume) {
      this.applySettingOff();
      return;
    }
    const nowMs = this.now().getTime();
    if (nowMs < this.notBefore) return;
    const lined = new Set<string>();
    for (const job of [...this.jobs.values()].filter((entry) => dueAt(entry) !== undefined && resumeDue(entry, nowMs)).sort(oldestFirst)) {
      if (lined.has(job.providerId)) continue;
      lined.add(job.providerId);
      const last = this.lastSend.get(job.providerId);
      if (last !== undefined && nowMs - last < RESUME_TIMING.lineGapMs) continue;
      this.lastSend.set(job.providerId, nowMs);
      void this.send(job, 'scheduled-time');
    }
  }

  /** What stands in the way as the time comes: a person's decision, or something already moving this conversation on. */
  private blocked(snapshot: DaemonSnapshot, job: LimitJobRecord): Pick<LimitJobRecord, 'phase' | 'failure'> | undefined {
    if (snapshot.approvals.some((approval) => approval.sessionId === job.sessionId && stoppingApproval(approval))) return { phase: 'skipped' };
    // A held queue goes instead: the refused prompt stays in the session, so nothing needs saying again.
    if (conversationBusy(snapshot, job.sessionId)) return { phase: 'cancelled' };
    return this.options.providers.enabledAdapter(snapshot, job.providerId).ok ? undefined : { phase: 'failed', failure: 'disconnected' };
  }

  /** One send: written ahead so a restart can tell, a new command for each lost race, never repeated by itself. */
  private async send(job: LimitJobRecord, reason: AppSentReason): Promise<void> {
    const blocked = this.blocked(this.options.getSnapshot(), job);
    if (blocked) {
      this.place({ ...job, ...blocked });
      return;
    }
    this.place({ ...job, phase: 'resuming', sendReason: reason, sentAt: this.now().toISOString(), sending: { commandId: this.sendId(job), reason, from: job.phase } });
    await this.tail;
    for (let tries = 0; tries < SEND_TRIES; tries += 1) {
      const current = this.jobs.get(job.stopId);
      if (this.disposed || current?.phase !== 'resuming' || !current.sending) return;
      const commandId = this.sendId(current);
      this.jobs.set(current.stopId, { ...current, sending: { ...current.sending, commandId } });
      await this.queueSave();
      let receipt: DaemonCommandReceipt;
      try {
        const expectedRevision = this.options.getSnapshot().revision;
        receipt = await this.options.execute(createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision,
          issuedAt: this.now().toISOString(),
          principal: { kind: 'cli', id: LONG_RUN_PRINCIPAL },
          type: 'agent.submit',
          payload: { sessionId: current.sessionId, prompt: RESUME_TEXT, longRunResume: { stopId: current.stopId, reason } },
        }));
      } catch (error) {
        // The router threw: the command may have gone, so the card says it cannot tell.
        this.report(`long-run send ${current.stopId}`, error);
        this.settleSend(job.stopId, { phase: 'unconfirmed' });
        return;
      }
      if (receipt.ok) return;
      if (receipt.error.code !== 'revision-conflict') {
        this.settleSend(job.stopId, { phase: 'failed', ...(receipt.error.code === 'not-found' ? { failure: 'session-gone' as const } : {}) });
        return;
      }
    }
    this.settleSend(job.stopId, { phase: 'failed' });
  }

  /** New at each try: Claude drops a repeated uuid in silence, and the uuid derives from this. */
  private sendId(job: LimitJobRecord): string {
    return stableId('long-run-send', job.stopId, String(job.attempt), String(this.options.getSnapshot().revision));
  }

  private settleSend(stopId: string, outcome: Pick<LimitJobRecord, 'phase' | 'failure'>): void {
    const current = this.jobs.get(stopId);
    if (!current) return;
    const { sending, ...rest } = current;
    if (sending) this.place({ ...rest, ...outcome });
  }

  /** What the send became, read from its turn. A limit on it comes through `limitStopped`, under the FIFO. */
  private advance(snapshot: DaemonSnapshot, job: LimitJobRecord): void {
    const commandId = job.sending?.commandId;
    const turn = snapshot.turns.find((entry) => (job.personTurnId ? entry.id === job.personTurnId : commandId !== undefined && entry.commandId === commandId));
    if (!turn) return;
    const from = this.newRows.get(job.sessionId);
    const answered = from !== undefined && this.options.readTranscript(job.sessionId, from - 1, 2_000).some((item) => item.turnId === turn.id && ANSWER_KINDS.has(item.kind));
    if (job.personTurnId) {
      const outcome = personOutcome(job, turn) ?? (answered ? { ...without(job, 'personTurnId'), phase: 'cancelled' as const } : undefined);
      if (outcome) this.place(outcome);
    } else if (answered || turn.state === 'completed' || turn.state === 'interrupted') {
      this.settleSend(job.stopId, { phase: 'resumed' });
    } else if (turn.state === 'failed' && turn.errorCode !== USAGE_LIMIT_ERROR) {
      // Never started: nothing went out. Anything later may have reached the AI.
      this.settleSend(job.stopId, turn.errorCode === 'provider-start-failed' ? { phase: 'failed', failure: 'disconnected' } : { phase: 'unconfirmed' });
    } else if (turn.state === 'delivery-uncertain' && job.phase === 'resuming') {
      // Kept with its `sending`: if the turn answers after all, this still closes.
      this.place({ ...job, phase: 'unconfirmed' });
    }
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
  private reopened(snapshot: DaemonSnapshot, stored: LimitJobRecord): LimitJobRecord | undefined {
    const settings = this.options.settings();
    const personTurn = stored.personTurnId ? snapshot.turns.find((entry) => entry.id === stored.personTurnId) : undefined;
    if (personTurn) return personOutcome(stored, personTurn);
    if (stored.personTurnId) {
      const job = without(stored, 'personTurnId');
      return this.reopened(snapshot, job) ?? job;
    }
    const job = stored;
    if (job.sending) {
      const { sending, ...rest } = job;
      const turn = snapshot.turns.find((entry) => entry.commandId === sending.commandId);
      if (!turn || !this.options.commandExists(sending.commandId)) return { ...rest, phase: 'ask-reopened' };
      if (turn.state === 'failed' && turn.errorCode === USAGE_LIMIT_ERROR) return this.refused(job, turn.id, turn.finishedAt ?? this.now().toISOString());
      if (turn.state === 'delivery-uncertain') return job.phase === 'unconfirmed' ? undefined : { ...job, phase: 'unconfirmed' };
      return turn.state === 'completed' || turn.state === 'interrupted' || turn.state === 'failed' ? { ...rest, phase: 'resumed' } : undefined;
    }
    const due = dueAt(job);
    if (due === undefined) return undefined;
    if (settings?.autoResume === false) return turnAutoResumeOff(job);
    return due <= this.now().getTime() ? { ...job, phase: 'ask-reopened' } : undefined;
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
    this.arm();
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

  /** In line with what is being written: the file never goes back to an older job. */
  private queueSave(): Promise<void> {
    this.tail = this.tail.then(() => this.saveJobs());
    return this.tail;
  }

  private schedulePass(): void {
    if (this.passScheduled || this.disposed) return;
    this.passScheduled = true;
    setImmediate(() => {
      this.passScheduled = false;
      if (!this.disposed) this.pass();
    });
  }

  /** A conversation archived or gone takes its stop with it; a send moves on with its turn. */
  private pass(): void {
    const snapshot = this.options.getSnapshot();
    let dropped = false;
    for (const job of [...this.jobs.values()]) {
      const session = snapshot.sessions.find((entry) => entry.id === job.sessionId);
      if (session && session.archivedAt === undefined) continue;
      this.jobs.delete(job.stopId);
      dropped = true;
    }
    if (this.settleSteers(snapshot) || dropped) void this.queueSave();
    for (const job of [...this.jobs.values()]) this.advance(snapshot, job);
    this.newRows.clear();
  }

  private async saveJobs(): Promise<void> {
    try {
      await this.options.store?.save({ jobs: Object.fromEntries(this.jobs), steers: Object.fromEntries(this.steerRecords) });
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
