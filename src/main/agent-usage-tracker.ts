import type { AgentUsage, AgentUsageLimitsReading, AgentUsageWindow } from '../shared/agent-usage';
import type { DaemonSession } from '../shared/daemon-protocol';

export interface AgentUsageObservation {
  /** Set when this conversation finished a reply; absent for an account-wide limits change. */
  readonly sessionId?: string;
  readonly limits?: AgentUsageLimitsReading;
  readonly contextPercent?: number;
}

interface Limits {
  fiveHour?: AgentUsageWindow;
  weekly?: AgentUsageWindow;
}

interface Entry {
  readonly providerId: string;
  usage: AgentUsage;
}

/**
 * Usage per conversation, in memory only. Plan limits belong to the
 * provider account, so one reading updates every conversation of that
 * provider; a conversation only starts showing usage after its own reply.
 */
export class AgentUsageTracker {
  private readonly limitsByProvider = new Map<string, Limits>();
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(providerId: string, observation: AgentUsageObservation): void {
    const observedAt = this.now();
    if (observation.limits) {
      const limits = this.mergeLimits(providerId, observation.limits);
      for (const entry of this.entries.values()) {
        if (entry.providerId === providerId) entry.usage = withLimits(entry.usage, limits, observedAt);
      }
    }
    if (!observation.sessionId) return;
    const previous = this.entries.get(observation.sessionId);
    const contextPercent = observation.contextPercent ?? previous?.usage.contextPercent;
    this.entries.set(observation.sessionId, {
      providerId,
      usage: withLimits({
        observedAt,
        ...(contextPercent !== undefined ? { contextPercent } : {}),
      }, this.limitsByProvider.get(providerId) ?? {}, observedAt),
    });
  }

  /** Usage of the given live sessions; forgets sessions that are gone or archived. */
  snapshot(sessions: readonly DaemonSession[]): Readonly<Record<string, AgentUsage>> | undefined {
    if (this.entries.size === 0) return undefined;
    const live = new Set(sessions
      .filter((session) => session.state !== 'archived' && !session.archivedAt)
      .map((session) => session.id));
    const result: Record<string, AgentUsage> = {};
    for (const [sessionId, entry] of this.entries) {
      if (live.has(sessionId)) result[sessionId] = entry.usage;
      else this.entries.delete(sessionId);
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  private mergeLimits(providerId: string, reading: AgentUsageLimitsReading): Limits {
    const limits = { ...this.limitsByProvider.get(providerId) };
    if (reading.fiveHour === null) delete limits.fiveHour;
    else if (reading.fiveHour) limits.fiveHour = reading.fiveHour;
    if (reading.weekly === null) delete limits.weekly;
    else if (reading.weekly) limits.weekly = reading.weekly;
    this.limitsByProvider.set(providerId, limits);
    return limits;
  }
}

function withLimits(usage: AgentUsage, limits: Limits, observedAt: number): AgentUsage {
  return {
    ...(limits.fiveHour ? { fiveHour: limits.fiveHour } : {}),
    ...(limits.weekly ? { weekly: limits.weekly } : {}),
    ...(usage.contextPercent !== undefined ? { contextPercent: usage.contextPercent } : {}),
    observedAt,
  };
}
