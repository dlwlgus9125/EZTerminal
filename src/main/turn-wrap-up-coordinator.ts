import { agentUsageLevel, type AgentUsage } from '../shared/agent-usage';
import { AUTOMATIC_CALL_PAUSE_LEVEL } from '../shared/automatic-calls';
import { REVIEWER_SESSION_PREFIX, type DaemonAgent, type DaemonCommand, type DaemonEvent, type DaemonSnapshot, type DaemonTurn } from '../shared/daemon-protocol';
import { isStructuredDaemonAgentSession } from '../shared/daemon-session-visibility';
import {
  isSuggestedTaskChildSession,
  type NextPromptSuggestion,
  type TurnWrapUpPause,
  type TurnWrapUpSettings,
} from '../shared/turn-wrap-up';
import type { AgentProviderAdapter, AgentProviderEvent, PromptSuggestionMode } from './agent-provider-adapter';
import { ProviderSideQuestionError } from './agent-provider-adapter';
import type { DaemonSystemTransitionPlanner } from './daemon-command-router';
import type { DaemonStoreCommit } from './daemon-store';
import { latestFinishedTurn } from './managed-child-transcript';
import { conversationBusy } from './review-coordinator';
import { settingsConversationAllowed } from './settings-authority';

/** How long a finished turn settles before the host decides anything: a person's next message often lands first. */
export const TURN_SETTLE_MS = 3_000;
/** The slowest measured fork took 24 s at the conversation's own effort; a low-effort one has no reason to run long. */
const PREDICTION_TIMEOUT_MS = 60_000;

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

/** What a provider's own suggestions run as: `on-past-limit` only with the near-limit pause off (it beats the provider's own stop). */
export function suggestionMode(settings: TurnWrapUpSettings, providerId: string, paused: boolean): PromptSuggestionMode {
  if (!suggestionsOn(settings, providerId)) return 'off';
  if (!settings.pauseNearLimit) return 'on-past-limit';
  return paused ? 'off' : 'on';
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

/** What the runtime needs from the coordinator (DaemonAgentRuntime option `wrapUp`). */
export interface DaemonWrapUpHost {
  /** A provider's own guess of the person's next message. */
  promptSuggestion(providerId: string, event: Extract<AgentProviderEvent, { kind: 'prompt-suggestion' }>): void;
}

export interface TurnWrapUpCoordinatorOptions {
  readonly getSnapshot: () => DaemonSnapshot;
  /** Evaluated under the command FIFO (the router's applySystemCommit). */
  readonly applySystemCommit: (commit: DaemonStoreCommit | DaemonSystemTransitionPlanner) => Promise<unknown>;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  readonly providers: {
    wrapUpCapability(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): AgentProviderAdapter['wrapUp'];
    enabledAdapter(snapshot: Pick<DaemonSnapshot, 'providers'>, providerId: string): { readonly ok: true; readonly value: AgentProviderAdapter } | { readonly ok: false; readonly message: string };
  };
  /** Read per event, so a switch acts at once. Undefined until the file has loaded: no automatic calls until then. */
  readonly settings: () => TurnWrapUpSettings | undefined;
  /** `wrapUpAllowed` with the host's facts. With `turn`, the turn is asked about too. */
  readonly allowed: (sessionId: string, turn?: DaemonTurn) => boolean;
  readonly now?: () => Date;
  readonly settleMs?: number;
  readonly predictionTimeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface Prediction {
  readonly turnId: string;
  readonly abort: AbortController;
}

/**
 * Turn wrap-up's host side (`turn-wrap-up-v1`). It watches turns end and decides, in one place, what the host
 * may spend on them. Next-prompt suggestions live only in memory and only while their turn is the newest;
 * Claude sends its own and the host can switch them off, Codex gets a read-only fork the next message aborts.
 */
export class TurnWrapUpCoordinator implements DaemonWrapUpHost {
  private readonly now: () => Date;
  private readonly suggestions = new Map<string, NextPromptSuggestion>();
  private readonly predictions = new Map<string, Prediction>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Turns written since the last pass. */
  private readonly changedTurns = new Set<string>();
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
      else if (!(event.kind === 'entity.archived' || (event.kind === 'entity.upserted' && (event.payload.entityType === 'agent' || event.payload.entityType === 'provider')))) return;
      this.schedulePass();
    });
  }

  /** Stops what runs now. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const prediction of this.predictions.values()) prediction.abort.abort();
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
      if (turn?.state === 'completed' && this.endedTurns.get(turn.sessionId) !== turn.id) {
        this.endedTurns.set(turn.sessionId, turn.id);
        this.afterSettling(() => this.turnEnded(turn.id));
      }
    }
    this.changedTurns.clear();
    this.switchSuggestions(snapshot);
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
    if (this.suggesting(snapshot, agent.providerId)) this.predict(snapshot, agent, turn);
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

  private async commit(planner: DaemonSystemTransitionPlanner): Promise<void> {
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
