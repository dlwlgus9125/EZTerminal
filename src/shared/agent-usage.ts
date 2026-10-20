/**
 * Provider usage shown in an agent's message box: the account's plan limits
 * and how full this conversation's context is. Values are what the provider
 * last reported, kept on this computer so a tab shows them as soon as it opens.
 */
export interface AgentUsageWindow {
  /** Whole percent used, 0-100. */
  readonly usedPercent: number;
  /** When the window resets, epoch ms. */
  readonly resetsAt?: number;
}

export interface AgentUsage {
  readonly fiveHour?: AgentUsageWindow;
  readonly weekly?: AgentUsageWindow;
  /** Epoch ms the plan limits were last reported. */
  readonly limitsObservedAt?: number;
  /** Whole percent of the model's context window the last request used. */
  readonly contextPercent?: number;
  /** Epoch ms the context was last reported. */
  readonly contextObservedAt?: number;
}

/**
 * One provider report of the account limits. `undefined` = not reported, keep
 * the known value; `null` = reported as absent, drop it.
 */
export interface AgentUsageLimitsReading {
  readonly fiveHour?: AgentUsageWindow | null;
  readonly weekly?: AgentUsageWindow | null;
}

export type AgentUsageLevel = 'normal' | 'warning' | 'danger';

/** Same thresholds as the CLI HUDs. */
export function agentUsageLevel(percent: number): AgentUsageLevel {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'normal';
}

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/** Time until a reset as the CLI HUD prints it: `2d5h`, `2h10m`, `45m`. */
export function formatUsageCountdown(remainingMs: number): string {
  const minutes = Math.max(0, Math.floor(remainingMs / MINUTE_MS));
  if (minutes >= DAY_MINUTES) {
    return `${Math.floor(minutes / DAY_MINUTES)}d${Math.floor((minutes % DAY_MINUTES) / HOUR_MINUTES)}h`;
  }
  if (minutes >= HOUR_MINUTES) {
    return `${Math.floor(minutes / HOUR_MINUTES)}h${minutes % HOUR_MINUTES}m`;
  }
  return `${Math.max(minutes, 1)}m`;
}
