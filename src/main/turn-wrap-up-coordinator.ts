import { createHash } from 'node:crypto';
import path from 'node:path';

import { agentUsageLevel, type AgentUsage } from '../shared/agent-usage';
import { clipApprovalBody } from '../shared/approval-request';
import { AUTOMATIC_CALL_PAUSE_LEVEL } from '../shared/automatic-calls';
import type { SideQuestionExchange } from '../shared/agent-side-question';
import type { ConversationViewingStatus } from '../shared/conversation-viewing';
import {
  REVIEWER_SESSION_PREFIX,
  type DaemonAgent,
  type DaemonApproval,
  type DaemonCommand,
  type DaemonEvent,
  type DaemonSnapshot,
  type DaemonTurn,
} from '../shared/daemon-protocol';
import { isStructuredDaemonAgentSession } from '../shared/daemon-session-visibility';
import { isSettingsProposalRequest } from '../shared/settings-changes';
import {
  parseTranscriptPayload,
  type RecapPayload,
  type TaskSuggestionPayload,
  type TaskSuggestionStatusPayload,
} from '../shared/transcript-payload';
import {
  isSuggestedTaskChildSession,
  RECAP_INSTRUCTION,
  recapStoppedNote,
  SUGGEST_TASK_INSTRUCTIONS,
  TASK_SUGGESTION_LIMITS,
  TURN_RECAP_LIMITS,
  type NextPromptSuggestion,
  type TurnRecapFailure,
  type TurnRecapTrigger,
  type TurnRecapWaiting,
  type TurnWrapUpPause,
  type TurnWrapUpSettings,
} from '../shared/turn-wrap-up';
import type { SuggestTaskInput, SuggestTaskResult, WrapUpToolHost } from './agent-orchestration-mcp-server';
import type {
  AgentProviderAdapter,
  AgentProviderEvent,
  PromptSuggestionMode,
  ProviderSideQuestionAnswer,
  ProviderSubmitInput,
  ProviderWrapUpContext,
} from './agent-provider-adapter';
import { ProviderSideQuestionError } from './agent-provider-adapter';
import type { DaemonSystemTransitionPlanner } from './daemon-command-router';
import type { DaemonStoreCommit, DaemonTranscriptItemInput } from './daemon-store';
import { latestFinishedTurn, type TranscriptReader } from './managed-child-transcript';
import { conversationBusy, readPages } from './review-coordinator';
import { settingsConversationAllowed } from './settings-authority';

/** How long a finished turn settles before the host decides anything: a person's next message often lands first. */
export const TURN_SETTLE_MS = 3_000;
/** The slowest measured fork took 24 s at the conversation's own effort; a low-effort one has no reason to run long. */
const PREDICTION_TIMEOUT_MS = 60_000;
/** A recap took 25 s at most across both AIs; one that takes minutes has failed. */
const RECAP_TIMEOUT_MS = 120_000;

const TERMINAL_TURN_STATES = new Set<DaemonTurn['state']>(['completed', 'interrupted', 'failed']);

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

/**
 * The one rule for who gets turn wrap-up. A conversation a person sees directly and a child a person started
 * from a card qualify; reviewers, advisors, planning, scheduled and workflow sessions and every other child do
 * not. With `turnCommand` (the command that queued the turn; null when it cannot be told), the turn must be one
 * a person sent: no heartbeat, no child's report, no delegated first turn. Automatic calls need both answers.
 */
export function wrapUpAllowed(
  snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents' | 'agentRelations'>,
  sessionId: string,
  options: { readonly prepared: boolean; readonly turnCommand?: DaemonCommand | null },
): boolean {
  const session = snapshot.sessions.find((entry) => entry.id === sessionId);
  if (!session || !isStructuredDaemonAgentSession(session) || sessionId.startsWith(REVIEWER_SESSION_PREFIX)) return false;
  // A card child is a conversation of its own for this rule, as a detached child is.
  const agentRelations = snapshot.agentRelations.filter((relation) => !(
    relation.childSessionId === sessionId && relation.owner === 'managed' && isSuggestedTaskChildSession(sessionId)
  ));
  if (!settingsConversationAllowed({ ...snapshot, agentRelations }, sessionId, { prepared: options.prepared })) return false;
  const command = options.turnCommand;
  if (command === undefined) return true;
  if (command?.principal.kind !== 'desktop' && command?.principal.kind !== 'android') return false;
  return !(command.type === 'agent.create' && command.payload.parentSessionId);
}

function suggestionsOn(settings: TurnWrapUpSettings, providerId: string): boolean {
  return (providerId === 'claude' || providerId === 'codex') && settings.suggestions[providerId];
}

/** What a provider's own suggestions run as: on, until the switch is off or the pause holds them at 90%. */
export function suggestionMode(settings: TurnWrapUpSettings, providerId: string, paused: boolean): PromptSuggestionMode {
  return suggestionsOn(settings, providerId) && !(settings.pauseNearLimit && paused) ? 'on' : 'off';
}

/** The usage windows at the danger level now; a window whose reset has passed is over, whatever its last reading says. */
export function turnWrapUpPauses(snapshot: Pick<DaemonSnapshot, 'providerUsage'>, nowMs: number): readonly TurnWrapUpPause[] {
  const pauses: TurnWrapUpPause[] = [];
  const check = (providerId: string, window: TurnWrapUpPause['window'], reading: AgentUsage['fiveHour']): void => {
    if (!reading || agentUsageLevel(reading.usedPercent) !== AUTOMATIC_CALL_PAUSE_LEVEL) return;
    if (reading.resetsAt !== undefined && reading.resetsAt <= nowMs) return;
    pauses.push({ providerId, window, usedPercent: reading.usedPercent, ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}) });
  };
  for (const [providerId, usage] of Object.entries(snapshot.providerUsage ?? {})) {
    check(providerId, 'five-hour', usage.fiveHour);
    check(providerId, 'weekly', usage.weekly);
  }
  return pauses;
}

/** A suggestion holds only while its turn is the conversation's newest, it completed, and nothing runs or waits behind it. */
function suggestionCurrent(snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents' | 'turns'>, sessionId: string, turnId: string): boolean {
  const session = snapshot.sessions.find((entry) => entry.id === sessionId);
  if (!session || session.archivedAt !== undefined || conversationBusy(snapshot, sessionId)) return false;
  const newest = latestFinishedTurn(snapshot.turns, sessionId);
  return newest?.id === turnId && newest.state === 'completed';
}

/** What survives a restart: enough to tell the card that its recap stopped. */
export interface RecapJobRecord {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly trigger: TurnRecapTrigger;
  /** `start`, or the 다시 만들기 command: each attempt's rows have their own ids. */
  readonly attempt: string;
  readonly waiting?: TurnRecapWaiting;
  readonly decisionId?: string;
}

const RECAP_FAILURE_TEXT: Readonly<Record<TurnRecapFailure, string>> = {
  'usage-limit': 'a usage limit is close',
  disconnected: 'the conversation was not connected',
  'no-response': 'the AI did not answer',
};

/** A `recap` notice row. Its text reads on its own for clients without cards, and it carries the AI's words: always sensitive. */
function recapRowItem(input: RecapJobRecord & {
  readonly id: string;
  readonly state: RecapPayload['state'];
  readonly text?: string;
  readonly failure?: TurnRecapFailure;
}): DaemonTranscriptItemInput {
  const text = input.text === undefined ? undefined : clipApprovalBody(input.text, TURN_RECAP_LIMITS.text);
  const payload: RecapPayload = {
    v: 1,
    type: 'recap',
    turnId: input.turnId,
    providerId: input.providerId,
    trigger: input.trigger,
    state: input.state,
    ...(text ? { text } : {}),
    ...(input.waiting ? { waiting: input.waiting } : {}),
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
  };
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: 'notice',
    text: text ?? (input.failure ? `No recap of this turn: ${RECAP_FAILURE_TEXT[input.failure]}.` : 'Writing a recap of this turn.'),
    isDelta: false,
    isSensitive: true,
    payload,
  };
}

const recapStartRowId = (record: Pick<RecapJobRecord, 'turnId' | 'attempt'>): string => stableId('recap-row', record.turnId, record.attempt);
const recapEndRowId = (record: Pick<RecapJobRecord, 'turnId' | 'attempt'>): string => stableId('recap-row', record.turnId, record.attempt, 'end');

/** The latest state of a turn's recap, read as clients read it. */
export function readRecapHistory(read: TranscriptReader, sessionId: string, turnId: string): RecapPayload | undefined {
  let recap: RecapPayload | undefined;
  readPages(read, sessionId, (item) => {
    const payload = item.payload?.type === 'recap' ? parseTranscriptPayload(item.payload) : undefined;
    if (payload?.type === 'recap' && payload.turnId === turnId) recap = payload;
  });
  return recap;
}

const TASK_OUTCOME_TEXT: Readonly<Record<TaskSuggestionStatusPayload['outcome'], string>> = {
  started: 'Suggested task started as a sub-conversation.',
  dismissed: 'Suggested task dismissed.',
  open: 'Suggested task reopened.',
  'start-failed': 'Suggested task could not start.',
};

/** A `task-suggestion-status` row in the conversation that holds the card. A failed start repeats what was asked for: sensitive. */
export function taskStatusRowItem(input: {
  readonly id: string;
  /** The conversation that holds the card. */
  readonly sessionId: string;
  readonly status: Omit<TaskSuggestionStatusPayload, 'v' | 'type'>;
}): DaemonTranscriptItemInput {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.status.turnId,
    kind: 'notice',
    text: TASK_OUTCOME_TEXT[input.status.outcome],
    isDelta: false,
    isSensitive: input.status.outcome === 'start-failed',
    payload: { v: 1, type: 'task-suggestion-status', ...input.status },
  };
}

/** A card as clients read it: the latest status wins, and the send row's turn says what became of a send. */
export interface TaskCardHistory {
  readonly task: TaskSuggestionPayload;
  readonly status?: TaskSuggestionStatusPayload;
  /** The turn of the last 여기서 하기. */
  readonly sendTurnId?: string;
}

export function readTaskCard(read: TranscriptReader, sessionId: string, taskId: string): TaskCardHistory | undefined {
  let task: TaskSuggestionPayload | undefined;
  let status: TaskSuggestionStatusPayload | undefined;
  let sendTurnId: string | undefined;
  readPages(read, sessionId, (item) => {
    const raw = item.payload;
    if (raw?.type !== 'task-suggestion' && raw?.type !== 'task-suggestion-status' && raw?.type !== 'task-suggestion-send') return;
    const payload = parseTranscriptPayload(raw);
    if (!payload || !('taskId' in payload) || payload.taskId !== taskId) return;
    if (payload.type === 'task-suggestion') task = payload;
    else if (payload.type === 'task-suggestion-status') status = payload;
    else if (payload.type === 'task-suggestion-send' && item.kind === 'user-message') sendTurnId = item.turnId;
  });
  return task ? { task, ...(status ? { status } : {}), ...(sendTurnId ? { sendTurnId } : {}) } : undefined;
}

/** A pending request that stops a conversation on the person. A settings proposal stops nothing; a subagent's stops only the subagent. */
export function stoppingApproval(approval: DaemonApproval): boolean {
  return approval.state === 'pending' && !isSettingsProposalRequest(approval.providerRequestId) && approval.request?.subagent === undefined;
}

function waitingKind(approval: DaemonApproval): TurnRecapWaiting {
  const kind = approval.request?.kind;
  return kind === 'question' || kind === 'plan' ? kind : 'approval';
}

/** What is open, said the way that made both AIs report it truthfully (probe P5). */
function waitingSentence(approval: DaemonApproval): string {
  const request = approval.request;
  switch (request?.kind) {
    case 'question': return `the person has not answered your question: "${request.questions[0]?.question ?? 'your question'}".`;
    case 'plan': return 'the person has not answered your plan.';
    case 'file-change': return `the person has not answered your request to change ${request.files.map((file) => path.basename(file.path)).join(', ')}.`;
    case 'command': return 'the person has not answered your request to run a command.';
    case 'tool': return `the person has not answered your request to use ${request.toolName}.`;
    default: return `the person has not answered your request: ${approval.title}.`;
  }
}

function recapFailure(error: unknown, timedOut: boolean): TurnRecapFailure {
  const disconnected = error instanceof ProviderSideQuestionError && (error.code === 'not-live' || error.code === 'session-restarted');
  return disconnected && !timedOut ? 'disconnected' : 'no-response';
}

/** Accepts only the shape this build writes; anything else is dropped rather than trusted. */
function parseJobs(value: unknown): RecapJobRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const records: RecapJobRecord[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const record = entry && typeof entry === 'object' ? entry as Partial<RecapJobRecord> : undefined;
    if (!record || typeof record.sessionId !== 'string' || !record.sessionId || typeof record.attempt !== 'string' || !record.attempt) continue;
    const payload = parseTranscriptPayload({
      v: 1, type: 'recap', turnId: record.turnId, providerId: record.providerId, trigger: record.trigger, state: 'failed',
      ...(record.waiting ? { waiting: record.waiting } : {}), ...(record.decisionId ? { decisionId: record.decisionId } : {}),
    });
    if (payload?.type !== 'recap') continue;
    records.push({
      sessionId: record.sessionId, turnId: payload.turnId, providerId: payload.providerId, trigger: payload.trigger, attempt: record.attempt,
      ...(payload.waiting ? { waiting: payload.waiting } : {}), ...(payload.decisionId ? { decisionId: payload.decisionId } : {}),
    });
  }
  return records;
}

/** What the runtime needs from the coordinator (DaemonAgentRuntime option `wrapUp`). */
export interface DaemonWrapUpHost {
  /** A provider's own guess of the person's next message. */
  promptSuggestion(providerId: string, event: Extract<AgentProviderEvent, { kind: 'prompt-suggestion' }>): void;
  /**
   * `wrap-up.recap-retry`: the row a new attempt starts with and what runs it once committed, or why it cannot.
   * This is the person's call, not an automatic one: neither a screen showing the conversation nor the pause stops it.
   */
  retryRecap(snapshot: DaemonSnapshot, input: { readonly sessionId: string; readonly turnId: string; readonly attempt: string }):
    { readonly refused: string } | { readonly row: DaemonTranscriptItemInput; begin(): void };
  /** What a session launches and resumes with; undefined: wrap-up is off for it. */
  sessionContext(sessionId: string): ProviderWrapUpContext | undefined;
  /** What one turn is sent with. Read per turn, so a person's message never depends on a stale switch. */
  turnContext(turn: DaemonTurn): Pick<ProviderSubmitInput, 'promptSuggestions' | 'wrapUpInstructions'> | undefined;
}

export interface TurnWrapUpCoordinatorOptions {
  readonly getSnapshot: () => DaemonSnapshot;
  /** Evaluated under the command FIFO (the router's applySystemCommit). */
  readonly applySystemCommit: (commit: DaemonStoreCommit | DaemonSystemTransitionPlanner) => Promise<unknown>;
  readonly readTranscript: TranscriptReader;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  /** One question to the conversation's AI (`DaemonAgentRuntime.askSideQuestion`): it leaves the person's /btw budget alone. */
  readonly ask: (
    input: { readonly sessionId: string; readonly question: string; readonly note?: string; readonly history: readonly SideQuestionExchange[] },
    signal: AbortSignal,
  ) => Promise<ProviderSideQuestionAnswer>;
  readonly viewers: { status(sessionId: string): ConversationViewingStatus };
  /** Recaps in flight, so a restart can tell their cards they stopped. */
  readonly store?: {
    readonly load: () => Promise<unknown>;
    readonly save: (jobs: Readonly<Record<string, RecapJobRecord>>) => Promise<void>;
  };
  readonly providers: {
    wrapUpCapability(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): AgentProviderAdapter['wrapUp'];
    supportsSideQuestions(providerId: string): boolean;
    enabledAdapter(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): { readonly ok: true; readonly value: AgentProviderAdapter } | { readonly ok: false; readonly message: string };
  };
  /** Read per event, so a switch acts at once. Undefined until the file has loaded: no automatic calls until then. */
  readonly settings: () => TurnWrapUpSettings | undefined;
  /** `wrapUpAllowed` with the host's facts. With `turn`, the turn is asked about too. */
  readonly allowed: (sessionId: string, turn?: DaemonTurn) => boolean;
  /** This session's running provider has `suggest_task` (a session's list is frozen at launch). */
  readonly toolListed: (sessionId: string) => boolean;
  readonly now?: () => Date;
  readonly settleMs?: number;
  readonly predictionTimeoutMs?: number;
  readonly recapTimeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface Prediction {
  readonly turnId: string;
  readonly abort: AbortController;
}

interface RecapJob {
  readonly record: RecapJobRecord;
  /** What is open, when the turn is stopped on the person. */
  readonly waitingNote?: string;
  readonly abort: AbortController;
  timedOut: boolean;
}

/**
 * Turn wrap-up's host side (`turn-wrap-up-v1`). It watches turns end and decides, in one place, what the host
 * may spend on them. Next-prompt suggestions live only in memory and only while their turn is the newest;
 * Claude sends its own and the host can switch them off, Codex gets a read-only fork the next message aborts.
 * A recap is written when no screen shows the conversation and a turn ended or stopped on the person, once per
 * turn: the recap row is the slot, so a stopped recap also stands for that turn's end.
 */
export class TurnWrapUpCoordinator implements DaemonWrapUpHost, WrapUpToolHost {
  private readonly now: () => Date;
  private readonly suggestions = new Map<string, NextPromptSuggestion>();
  private readonly predictions = new Map<string, Prediction>();
  /** Recaps in flight, by turn. */
  private readonly recaps = new Map<string, RecapJob>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Turns written since the last pass. */
  private readonly changedTurns = new Set<string>();
  /** Approvals written since the last pass. */
  private readonly changedApprovals = new Set<string>();
  /** What `suggest_task` took per running turn. Memory is enough: the cap guards one turn, which a restart ends. */
  private readonly taskCounts = new Map<string, { readonly accepted: Set<string>; dropped: number }>();
  /** Each session's last turn seen ending, so writing a turn again does not end it twice. */
  private readonly endedTurns = new Map<string, string>();
  /** The mode each provider's sessions were last switched to. */
  private readonly modes = new Map<string, PromptSuggestionMode>();
  private unsubscribe: (() => void) | undefined;
  private passScheduled = false;
  private disposed = false;

  constructor(private readonly options: TurnWrapUpCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.disposed || this.unsubscribe) return;
    this.unsubscribe = this.options.onEvent((event) => {
      if (event.kind === 'entity.upserted' && event.payload.entityType === 'turn') this.changedTurns.add(event.payload.entityId);
      else if (event.kind === 'approval.changed') this.changedApprovals.add(event.payload.approvalId);
      else if (!(event.kind === 'entity.archived' || (event.kind === 'entity.upserted' && (event.payload.entityType === 'agent' || event.payload.entityType === 'provider')))) return;
      this.schedulePass();
    });
    await this.recoverRecaps();
  }

  /** Stops what runs now; the store keeps the recaps in flight, so the next start tells their cards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const prediction of this.predictions.values()) prediction.abort.abort();
    for (const job of this.recaps.values()) job.abort.abort();
  }

  /** The usage windows pausing the automatic calls now. */
  paused(snapshot: Pick<DaemonSnapshot, 'providerUsage'>): readonly TurnWrapUpPause[] {
    return turnWrapUpPauses(snapshot, this.now().getTime());
  }

  /** What the snapshot carries: read against it, so a turn that just started hides a suggestion in the same snapshot. */
  nextPromptSuggestions(snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents' | 'turns'>): DaemonSnapshot['nextPromptSuggestions'] {
    const current = [...this.suggestions].filter(([sessionId, suggestion]) => suggestionCurrent(snapshot, sessionId, suggestion.turnId));
    return current.length ? Object.fromEntries(current) : undefined;
  }

  promptSuggestion(providerId: string, event: Extract<AgentProviderEvent, { kind: 'prompt-suggestion' }>): void {
    const agent = this.options.getSnapshot().agents.find((entry) => entry.sessionId === event.sessionId);
    if (agent?.providerId === providerId) this.accept(event.sessionId, event.turnId, event.text);
  }

  /** The Settings screen changed: a switch turned off acts now, on what is shown and what runs. */
  settingsChanged(): void {
    if (this.disposed || !this.unsubscribe) return;
    const snapshot = this.options.getSnapshot();
    const settings = this.options.settings();
    const off = (sessionId: string): boolean => {
      const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
      return !settings || !agent || !suggestionsOn(settings, agent.providerId);
    };
    for (const [sessionId, prediction] of this.predictions) if (off(sessionId)) prediction.abort.abort();
    for (const sessionId of [...this.suggestions.keys()]) {
      if (!off(sessionId)) continue;
      this.suggestions.delete(sessionId);
      this.announce(sessionId);
    }
    this.switchSuggestions(snapshot);
  }

  /** Never reads the `tasks` switch: the list is frozen per session, and a change to it costs every conversation its cache. */
  listed(sessionId: string): boolean {
    const snapshot = this.options.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    return agent !== undefined && this.options.providers.wrapUpCapability(snapshot, agent.providerId) !== undefined && this.options.allowed(sessionId);
  }

  /**
   * One card for a turn a person sent. Repeating a call adds nothing; past the cap it is refused and counted,
   * and the count is written once when the turn ends.
   */
  async suggest(context: { readonly sessionId: string; readonly turnId: string }, input: SuggestTaskInput): Promise<SuggestTaskResult> {
    const snapshot = this.options.getSnapshot();
    const turn = snapshot.turns.find((entry) => entry.id === context.turnId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === context.sessionId);
    if (!turn || !agent || !this.automatic(snapshot, agent, turn)) return { ok: false, code: 'unattended', error: 'suggest_task answers only a turn a person sent.' };
    if (!this.options.settings()?.tasks) return { ok: false, code: 'off', error: 'Suggested tasks are turned off. Do not suggest more in this conversation.' };
    if (agent.currentTurnId !== turn.id) return { ok: false, error: 'suggest_task works only during a running turn.' };
    const taskId = stableId('task', turn.id, input.title, input.prompt);
    const counted = this.taskCounts.get(turn.id) ?? { accepted: new Set<string>(), dropped: 0 };
    this.taskCounts.set(turn.id, counted);
    if (counted.accepted.has(taskId)) return { ok: true, taskId };
    if (counted.accepted.size >= TASK_SUGGESTION_LIMITS.perTurn) {
      counted.dropped += 1;
      return { ok: false, code: 'cap', error: `A turn can suggest ${String(TASK_SUGGESTION_LIMITS.perTurn)} tasks. Stop suggesting; this one was not kept.` };
    }
    // Before the commit: an AI may call several at once, and each must see the others.
    counted.accepted.add(taskId);
    let written = false;
    await this.commit((fresh) => {
      const session = fresh.sessions.find((entry) => entry.id === context.sessionId);
      const running = fresh.agents.find((entry) => entry.sessionId === context.sessionId)?.currentTurnId;
      if (!session || session.archivedAt !== undefined || running !== turn.id) return undefined;
      written = true;
      return this.rowCommit({
        id: stableId('task-row', taskId),
        sessionId: context.sessionId,
        turnId: turn.id,
        kind: 'notice',
        text: `Suggested task: ${input.title}`,
        isDelta: false,
        isSensitive: true,
        payload: {
          v: 1, type: 'task-suggestion', taskId, turnId: turn.id, providerId: agent.providerId,
          title: input.title, rationale: input.rationale, prompt: input.prompt, ...(input.worktree ? { worktree: true } : {}),
        },
      });
    });
    if (written) return { ok: true, taskId };
    counted.accepted.delete(taskId);
    return { ok: false, error: 'suggest_task works only during a running turn.' };
  }

  sessionContext(sessionId: string): ProviderWrapUpContext | undefined {
    const snapshot = this.options.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    const capability = agent ? this.options.providers.wrapUpCapability(snapshot, agent.providerId) : undefined;
    if (!agent || !capability || !this.options.allowed(sessionId)) return undefined;
    const running = agent.currentTurnId ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId) : undefined;
    const attended = !running || this.options.allowed(sessionId, running);
    return {
      // Eligible sessions always launch able to suggest: one started without cannot get it later (probe P7).
      ...(capability.suggestions === 'native' ? { promptSuggestions: attended ? this.providerMode(snapshot, agent.providerId) : 'off' } : {}),
      suggestTask: true,
      // A delegated first turn may not use the tool, so its thread hears this with the first message a person sends.
      ...(attended && this.options.settings()?.tasks ? { developerInstructions: SUGGEST_TASK_INSTRUCTIONS } : {}),
    };
  }

  turnContext(turn: DaemonTurn): Pick<ProviderSubmitInput, 'promptSuggestions' | 'wrapUpInstructions'> | undefined {
    const snapshot = this.options.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === turn.sessionId);
    const capability = agent ? this.options.providers.wrapUpCapability(snapshot, agent.providerId) : undefined;
    if (!agent || !capability || !this.options.allowed(turn.sessionId)) return undefined;
    const attended = this.options.allowed(turn.sessionId, turn);
    return {
      ...(capability.suggestions === 'native' ? { promptSuggestions: attended ? this.providerMode(snapshot, agent.providerId) : 'off' } : {}),
      ...(attended && this.options.settings()?.tasks && this.options.toolListed(turn.sessionId) ? { wrapUpInstructions: SUGGEST_TASK_INSTRUCTIONS } : {}),
    };
  }

  private providerMode(snapshot: DaemonSnapshot, providerId: string): PromptSuggestionMode {
    const settings = this.options.settings();
    return settings ? suggestionMode(settings, providerId, this.providerPaused(snapshot, providerId)) : 'off';
  }

  retryRecap(snapshot: DaemonSnapshot, input: { readonly sessionId: string; readonly turnId: string; readonly attempt: string }):
  { readonly refused: string } | { readonly row: DaemonTranscriptItemInput; begin(): void } {
    const agent = snapshot.agents.find((entry) => entry.sessionId === input.sessionId);
    const recap = readRecapHistory(this.options.readTranscript, input.sessionId, input.turnId);
    if (recap?.state !== 'failed' || !agent || !this.options.allowed(input.sessionId)
      || !this.options.providers.wrapUpCapability(snapshot, agent.providerId) || !this.options.providers.supportsSideQuestions(agent.providerId)) {
      return { refused: 'This turn has no failed recap to write again.' };
    }
    // Still the turn's wait only while that decision is open: the card says the AI waits by this row.
    const decision = recap.decisionId ? snapshot.approvals.find((entry) => entry.id === recap.decisionId && stoppingApproval(entry)) : undefined;
    const record: RecapJobRecord = {
      sessionId: input.sessionId, turnId: input.turnId, providerId: recap.providerId, trigger: recap.trigger, attempt: input.attempt,
      ...(decision ? { waiting: waitingKind(decision), decisionId: decision.id } : {}),
    };
    const job = this.recapJob(record, decision);
    return {
      row: recapRowItem({ ...record, id: recapStartRowId(record), state: 'generating' }),
      begin: () => {
        if (this.disposed) return;
        this.recaps.set(record.turnId, job);
        void this.saveJobs();
        void this.runRecap(job);
      },
    };
  }

  private schedulePass(): void {
    if (this.passScheduled || this.disposed) return;
    this.passScheduled = true;
    setImmediate(() => {
      this.passScheduled = false;
      if (!this.disposed) this.pass();
    });
  }

  private pass(): void {
    const snapshot = this.options.getSnapshot();
    for (const [sessionId, prediction] of this.predictions) {
      if (!suggestionCurrent(snapshot, sessionId, prediction.turnId)) prediction.abort.abort();
    }
    for (const [sessionId, suggestion] of this.suggestions) {
      if (!suggestionCurrent(snapshot, sessionId, suggestion.turnId)) this.suggestions.delete(sessionId);
    }
    for (const turnId of this.changedTurns) {
      const turn = snapshot.turns.find((entry) => entry.id === turnId);
      if (turn && TERMINAL_TURN_STATES.has(turn.state)) this.closeTaskCount(turn);
      if (turn?.state === 'completed' && this.endedTurns.get(turn.sessionId) !== turn.id) {
        this.endedTurns.set(turn.sessionId, turn.id);
        this.afterSettling(() => this.turnEnded(turn.id));
      }
    }
    this.changedTurns.clear();
    for (const approvalId of this.changedApprovals) {
      const approval = snapshot.approvals.find((entry) => entry.id === approvalId);
      if (approval && stoppingApproval(approval)) this.afterSettling(() => this.turnStopped(approvalId));
    }
    this.changedApprovals.clear();
    this.switchSuggestions(snapshot);
  }

  private closeTaskCount(turn: DaemonTurn): void {
    const counted = this.taskCounts.get(turn.id);
    if (!counted) return;
    this.taskCounts.delete(turn.id);
    if (!counted.dropped) return;
    void this.commit(this.rowCommit({
      id: stableId('task-dropped', turn.id),
      sessionId: turn.sessionId,
      turnId: turn.id,
      kind: 'notice',
      text: `${String(counted.dropped)} more suggested tasks were left out.`,
      isDelta: false,
      isSensitive: false,
      payload: { v: 1, type: 'task-suggestions-dropped', turnId: turn.id, count: counted.dropped },
    }));
  }

  private afterSettling(task: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) task();
    }, this.options.settleMs ?? TURN_SETTLE_MS);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** The host pays for this turn only if it is eligible, attended, and the AI is one wrap-up was measured on. */
  private automatic(snapshot: DaemonSnapshot, agent: DaemonAgent, turn: DaemonTurn): boolean {
    return this.options.settings() !== undefined
      && this.options.providers.wrapUpCapability(snapshot, agent.providerId) !== undefined
      && turn.sessionId === agent.sessionId
      && this.options.allowed(agent.sessionId, turn);
  }

  private turnEnded(turnId: string): void {
    const snapshot = this.options.getSnapshot();
    const turn = snapshot.turns.find((entry) => entry.id === turnId);
    const agent = turn ? snapshot.agents.find((entry) => entry.sessionId === turn.sessionId) : undefined;
    if (!turn || !agent || !suggestionCurrent(snapshot, turn.sessionId, turn.id) || !this.automatic(snapshot, agent, turn)) return;
    // In plan mode the composer hides a guess, so a Codex fork there would be spent on nothing.
    if (agent.permissionPreset !== 'plan' && this.suggesting(snapshot, agent.providerId)) this.predict(snapshot, agent, turn);
    // Codex proposes a plan just after its turn ends: that is this turn waiting, whichever of the two settled first.
    this.offerRecap(snapshot, agent, turn, snapshot.approvals.find((entry) => entry.sessionId === turn.sessionId && !entry.turnId && stoppingApproval(entry)));
  }

  /** A request still open once it settled. A plan Codex proposes has no turn: it stops the one that just ended. */
  private turnStopped(approvalId: string): void {
    const snapshot = this.options.getSnapshot();
    const approval = snapshot.approvals.find((entry) => entry.id === approvalId);
    const agent = approval ? snapshot.agents.find((entry) => entry.sessionId === approval.sessionId) : undefined;
    if (!approval || !agent || !stoppingApproval(approval)) return;
    const turn = approval.turnId
      ? snapshot.turns.find((entry) => entry.id === approval.turnId && entry.id === agent.currentTurnId)
      : agent.currentTurnId ? undefined : latestFinishedTurn(snapshot.turns, approval.sessionId);
    if (turn && this.automatic(snapshot, agent, turn)) this.offerRecap(snapshot, agent, turn, approval);
  }

  /** Only `unviewed` makes a recap. With the pause on, the card says why there is none rather than spending a call. */
  private offerRecap(snapshot: DaemonSnapshot, agent: DaemonAgent, turn: DaemonTurn, decision: DaemonApproval | undefined): void {
    const settings = this.options.settings();
    const capability = this.options.providers.wrapUpCapability(snapshot, agent.providerId);
    if (!settings?.recaps || !capability || !this.options.providers.supportsSideQuestions(agent.providerId)) return;
    if ((decision && !capability.recapWhileBlocked) || this.options.viewers.status(agent.sessionId) !== 'unviewed') return;
    const record: RecapJobRecord = {
      sessionId: agent.sessionId, turnId: turn.id, providerId: agent.providerId, trigger: decision ? 'waiting' : 'unattended', attempt: 'start',
      ...(decision ? { waiting: waitingKind(decision), decisionId: decision.id } : {}),
    };
    void this.beginRecap(record, decision, settings.pauseNearLimit && this.providerPaused(snapshot, agent.providerId));
  }

  /**
   * Takes the turn's one slot, under the command FIFO. The job reaches the file before the row does: a crash
   * between them then writes a needless failure, never a card stuck generating.
   */
  private async beginRecap(record: RecapJobRecord, decision: DaemonApproval | undefined, paused: boolean): Promise<void> {
    if (this.recaps.has(record.turnId)) return;
    const job = paused ? undefined : this.recapJob(record, decision);
    if (job) {
      this.recaps.set(record.turnId, job);
      await this.saveJobs();
    }
    const row = recapRowItem({ ...record, id: recapStartRowId(record), ...(paused ? { state: 'failed', failure: 'usage-limit' } : { state: 'generating' }) });
    let taken = false;
    await this.commit((snapshot) => {
      const session = snapshot.sessions.find((entry) => entry.id === record.sessionId);
      if (!session || session.archivedAt !== undefined || readRecapHistory(this.options.readTranscript, record.sessionId, record.turnId)) return undefined;
      taken = true;
      return this.rowCommit(row);
    });
    if (!job || this.disposed) return;
    if (taken) {
      await this.runRecap(job);
    } else {
      this.recaps.delete(record.turnId);
      await this.saveJobs();
    }
  }

  private recapJob(record: RecapJobRecord, decision: DaemonApproval | undefined): RecapJob {
    return { record, ...(decision ? { waitingNote: waitingSentence(decision) } : {}), abort: new AbortController(), timedOut: false };
  }

  private async runRecap(job: RecapJob): Promise<void> {
    const { record } = job;
    const timeout = setTimeout(() => {
      job.timedOut = true;
      job.abort.abort();
    }, this.options.recapTimeoutMs ?? RECAP_TIMEOUT_MS);
    timeout.unref?.();
    let outcome: { readonly state: 'complete'; readonly text: string } | { readonly state: 'failed'; readonly failure: TurnRecapFailure };
    try {
      const note = job.waitingNote ? { note: recapStoppedNote(job.waitingNote) } : {};
      const answer = await this.options.ask({ sessionId: record.sessionId, question: RECAP_INSTRUCTION, ...note, history: [] }, job.abort.signal);
      const text = answer.synthetic ? undefined : answer.text?.trim();
      outcome = text ? { state: 'complete', text } : { state: 'failed', failure: 'no-response' };
    } catch (error) {
      if (this.disposed) return;
      outcome = { state: 'failed', failure: recapFailure(error, job.timedOut) };
    } finally {
      clearTimeout(timeout);
    }
    if (this.disposed) return;
    await this.commit((snapshot) => {
      const session = snapshot.sessions.find((entry) => entry.id === record.sessionId);
      return session && session.archivedAt === undefined ? this.rowCommit(recapRowItem({ ...record, id: recapEndRowId(record), ...outcome })) : undefined;
    });
    this.recaps.delete(record.turnId);
    await this.saveJobs();
  }

  /** What the last run left generating: the AI's answer went with it, and only the person asks again. */
  private async recoverRecaps(): Promise<void> {
    let records: RecapJobRecord[] = [];
    try {
      records = parseJobs(await this.options.store?.load());
    } catch (error) {
      this.report('recap jobs load failed', error);
    }
    for (const record of records) {
      await this.commit((snapshot) => {
        const session = snapshot.sessions.find((entry) => entry.id === record.sessionId);
        if (!session || session.archivedAt !== undefined) return undefined;
        return this.rowCommit(recapRowItem({ ...record, id: recapEndRowId(record), state: 'failed', failure: 'disconnected' }));
      });
    }
    await this.saveJobs();
  }

  private async saveJobs(): Promise<void> {
    try {
      await this.options.store?.save(Object.fromEntries([...this.recaps.values()].map((job) => [job.record.turnId, job.record])));
    } catch (error) {
      this.report('recap jobs save failed', error);
    }
  }

  private rowCommit(item: DaemonTranscriptItemInput): DaemonStoreCommit {
    return { mutations: [{ kind: 'transcript.append', items: [{ ...item, createdAt: this.now().toISOString() }] }] };
  }

  private suggesting(snapshot: DaemonSnapshot, providerId: string): boolean {
    const settings = this.options.settings();
    return settings !== undefined && suggestionMode(settings, providerId, this.providerPaused(snapshot, providerId)) !== 'off';
  }

  private providerPaused(snapshot: DaemonSnapshot, providerId: string): boolean {
    return this.paused(snapshot).some((pause) => pause.providerId === providerId);
  }

  /** The next message aborts the fork (`pass`), and it never waits for it. */
  private predict(snapshot: DaemonSnapshot, agent: DaemonAgent, turn: DaemonTurn): void {
    const provider = this.options.providers.enabledAdapter(snapshot, agent.providerId);
    const providerSessionId = agent.providerSessionId;
    if (this.options.providers.wrapUpCapability(snapshot, agent.providerId)?.suggestions !== 'fork' || !provider.ok || !providerSessionId) return;
    const predict = provider.value.predictNextPrompt?.bind(provider.value);
    if (!predict) return;
    const prediction: Prediction = { turnId: turn.id, abort: new AbortController() };
    this.predictions.get(agent.sessionId)?.abort.abort();
    this.predictions.set(agent.sessionId, prediction);
    const timeout = setTimeout(() => prediction.abort.abort(), this.options.predictionTimeoutMs ?? PREDICTION_TIMEOUT_MS);
    timeout.unref?.();
    void predict({ sessionId: agent.sessionId, providerSessionId }, prediction.abort.signal)
      .then((text) => { if (text) this.accept(agent.sessionId, turn.id, text); })
      // A fork that could not run is no guess; it never shows anywhere.
      .catch((error: unknown) => { if (!(error instanceof ProviderSideQuestionError)) this.report('next-prompt prediction', error); })
      .finally(() => {
        clearTimeout(timeout);
        if (this.predictions.get(agent.sessionId) === prediction) this.predictions.delete(agent.sessionId);
      });
  }

  private accept(sessionId: string, turnId: string, text: string): void {
    if (this.disposed) return;
    const snapshot = this.options.getSnapshot();
    const turn = snapshot.turns.find((entry) => entry.id === turnId);
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!turn || !agent || !suggestionCurrent(snapshot, sessionId, turnId) || !this.automatic(snapshot, agent, turn) || !this.suggesting(snapshot, agent.providerId)) return;
    this.suggestions.set(sessionId, { turnId, text });
    this.announce(sessionId);
  }

  /**
   * Moves a provider's live sessions when its mode changes (the setting, or a usage reading crossing the pause).
   * A turn no person sent keeps its session off: the provider would otherwise spend a call on it.
   */
  private switchSuggestions(snapshot: DaemonSnapshot): void {
    const settings = this.options.settings();
    if (!settings) return;
    for (const { id: providerId } of snapshot.providers) {
      if (this.options.providers.wrapUpCapability(snapshot, providerId)?.suggestions !== 'native') continue;
      const mode = suggestionMode(settings, providerId, this.providerPaused(snapshot, providerId));
      if (this.modes.get(providerId) === mode) continue;
      this.modes.set(providerId, mode);
      const provider = this.options.providers.enabledAdapter(snapshot, providerId);
      if (!provider.ok) continue;
      for (const agent of snapshot.agents) {
        if (agent.providerId !== providerId || !agent.providerSessionId || !this.options.allowed(agent.sessionId)) continue;
        const running = agent.currentTurnId ? snapshot.turns.find((entry) => entry.id === agent.currentTurnId) : undefined;
        void provider.value.setPromptSuggestions?.(agent.sessionId, running && !this.options.allowed(agent.sessionId, running) ? 'off' : mode);
      }
    }
  }

  /** Clients refetch the snapshot that carries the change, as they do for usage. */
  private announce(sessionId: string): void {
    void this.commit(() => ({ events: [{ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: sessionId } }] }));
  }

  private async commit(planner: DaemonStoreCommit | DaemonSystemTransitionPlanner): Promise<void> {
    if (this.disposed) return;
    try {
      await this.options.applySystemCommit(planner);
    } catch (error) {
      this.report('turn wrap-up commit', error);
    }
  }

  private report(context: string, error: unknown): void {
    this.options.reportError?.(context, error);
  }
}
