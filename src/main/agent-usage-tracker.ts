import type { AgentUsage, AgentUsageLimitsReading, AgentUsageWindow } from '../shared/agent-usage';
import type { DaemonSnapshot } from '../shared/daemon-protocol';

export interface AgentUsageObservation {
  /** The conversation the context belongs to; absent for an account-wide limits change. */
  readonly sessionId?: string;
  readonly limits?: AgentUsageLimitsReading;
  readonly contextPercent?: number;
}

interface ProviderLimits {
  readonly fiveHour?: AgentUsageWindow;
  readonly weekly?: AgentUsageWindow;
  readonly observedAt: number;
}

interface SessionContext {
  readonly percent: number;
  readonly observedAt: number;
}

/** What survives a restart, so a tab shows the last known usage as soon as it opens. */
export interface PersistedAgentUsage {
  readonly version: 1;
  readonly providers: Readonly<Record<string, ProviderLimits>>;
  readonly contexts: Readonly<Record<string, SessionContext>>;
}

/** A reading this much newer than the shown one is worth a refresh even when the numbers match. */
const STALE_AFTER_MS = 60_000;

/**
 * Usage per conversation. Plan limits belong to the provider account, so one
 * reading updates every conversation of that provider; context belongs to one
 * conversation.
 */
export class AgentUsageTracker {
  private readonly limitsByProvider = new Map<string, ProviderLimits>();
  private readonly contexts = new Map<string, SessionContext>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Restores a persisted state; anything malformed is dropped. */
  restore(value: unknown): void {
    const state = parsePersistedAgentUsage(value);
    if (!state) return;
    for (const [providerId, limits] of Object.entries(state.providers)) this.limitsByProvider.set(providerId, limits);
    for (const [sessionId, context] of Object.entries(state.contexts)) this.contexts.set(sessionId, context);
  }

  serialize(): PersistedAgentUsage {
    return {
      version: 1,
      providers: Object.fromEntries(this.limitsByProvider),
      contexts: Object.fromEntries(this.contexts),
    };
  }

  /** Records a reading; true when what a conversation shows has changed. */
  observe(providerId: string, observation: AgentUsageObservation): boolean {
    const observedAt = this.now();
    let changed = false;
    if (observation.limits) {
      const previous = this.limitsByProvider.get(providerId);
      const next = mergeLimits(previous, observation.limits, observedAt);
      this.limitsByProvider.set(providerId, next);
      changed = !previous
        || !sameWindow(previous.fiveHour, next.fiveHour)
        || !sameWindow(previous.weekly, next.weekly)
        || observedAt - previous.observedAt >= STALE_AFTER_MS;
    }
    if (observation.sessionId && observation.contextPercent !== undefined) {
      const previous = this.contexts.get(observation.sessionId);
      this.contexts.set(observation.sessionId, { percent: observation.contextPercent, observedAt });
      changed ||= !previous
        || previous.percent !== observation.contextPercent
        || observedAt - previous.observedAt >= STALE_AFTER_MS;
    }
    return changed;
  }

  /** Usage for a snapshot: per live conversation, and per provider for a conversation not started yet. */
  snapshot(snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents'>): Pick<DaemonSnapshot, 'agentUsage' | 'providerUsage'> {
    const agentUsage = this.sessionUsage(snapshot);
    const providerUsage: Record<string, AgentUsage> = {};
    for (const [providerId, limits] of this.limitsByProvider) {
      const usage = limitsUsage(limits);
      if (usage) providerUsage[providerId] = usage;
    }
    return {
      ...(agentUsage ? { agentUsage } : {}),
      ...(Object.keys(providerUsage).length > 0 ? { providerUsage } : {}),
    };
  }

  /** Forgets contexts of conversations that are gone or archived. */
  private sessionUsage(snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents'>): Readonly<Record<string, AgentUsage>> | undefined {
    const live = new Set(snapshot.sessions
      .filter((session) => session.state !== 'archived' && !session.archivedAt)
      .map((session) => session.id));
    for (const sessionId of this.contexts.keys()) {
      if (!live.has(sessionId)) this.contexts.delete(sessionId);
    }
    const result: Record<string, AgentUsage> = {};
    for (const agent of snapshot.agents) {
      if (!live.has(agent.sessionId)) continue;
      const limits = this.limitsByProvider.get(agent.providerId);
      const usage = limits ? limitsUsage(limits) : undefined;
      const context = this.contexts.get(agent.sessionId);
      if (!usage && !context) continue;
      result[agent.sessionId] = {
        ...usage,
        ...(context ? { contextPercent: context.percent, contextObservedAt: context.observedAt } : {}),
      };
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
}

function limitsUsage(limits: ProviderLimits): AgentUsage | undefined {
  if (!limits.fiveHour && !limits.weekly) return undefined;
  return {
    ...(limits.fiveHour ? { fiveHour: limits.fiveHour } : {}),
    ...(limits.weekly ? { weekly: limits.weekly } : {}),
    limitsObservedAt: limits.observedAt,
  };
}

function mergeLimits(previous: ProviderLimits | undefined, reading: AgentUsageLimitsReading, observedAt: number): ProviderLimits {
  const fiveHour = reading.fiveHour === null ? undefined : reading.fiveHour ?? previous?.fiveHour;
  const weekly = reading.weekly === null ? undefined : reading.weekly ?? previous?.weekly;
  return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), observedAt };
}

function sameWindow(left: AgentUsageWindow | undefined, right: AgentUsageWindow | undefined): boolean {
  return left?.usedPercent === right?.usedPercent && left?.resetsAt === right?.resetsAt;
}

function finitePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function parseWindow(value: unknown): AgentUsageWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (!finitePercent(entry.usedPercent)) return undefined;
  const resetsAt = typeof entry.resetsAt === 'number' && Number.isFinite(entry.resetsAt) ? entry.resetsAt : undefined;
  return { usedPercent: entry.usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** Accepts only the shape this build writes; a file from elsewhere is ignored rather than trusted. */
export function parsePersistedAgentUsage(value: unknown): PersistedAgentUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !raw.providers || typeof raw.providers !== 'object' || !raw.contexts || typeof raw.contexts !== 'object') return undefined;
  const providers: Record<string, ProviderLimits> = {};
  for (const [providerId, entry] of Object.entries(raw.providers as Record<string, unknown>)) {
    const limits = entry as Record<string, unknown> | null;
    if (!limits || typeof limits.observedAt !== 'number') continue;
    const fiveHour = parseWindow(limits.fiveHour);
    const weekly = parseWindow(limits.weekly);
    providers[providerId] = { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), observedAt: limits.observedAt };
  }
  const contexts: Record<string, SessionContext> = {};
  for (const [sessionId, entry] of Object.entries(raw.contexts as Record<string, unknown>)) {
    const context = entry as Record<string, unknown> | null;
    if (!context || !finitePercent(context.percent) || typeof context.observedAt !== 'number') continue;
    contexts[sessionId] = { percent: context.percent, observedAt: context.observedAt };
  }
  return { version: 1, providers, contexts };
}
