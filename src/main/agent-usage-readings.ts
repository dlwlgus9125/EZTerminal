import type { AgentUsageLimitsReading, AgentUsageWindow } from '../shared/agent-usage';

/**
 * Provider wire values → the numbers the CLI HUDs show. Every formula for
 * usage lives here so a mismatch with a CLI is fixed in one place.
 */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function epochSecondsToMs(value: unknown): number | undefined {
  const seconds = finite(value);
  return seconds !== undefined && seconds > 0 ? seconds * 1000 : undefined;
}

function window(usedPercent: number, resetsAt: number | undefined): AgentUsageWindow {
  return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * Claude utilization is a 0-1 fraction. Claude Code keeps one decimal
 * (`Math.round(u * 1000) / 10`) and the HUD prints the whole part.
 */
function claudePercent(utilization: unknown): number | undefined {
  const value = finite(utilization);
  if (value === undefined || value < 0) return undefined;
  return clampPercent(Math.floor(Math.round(value * 1000) / 10));
}

function claudeWindow(value: unknown): AgentUsageWindow | null {
  const entry = asObject(value);
  const percent = claudePercent(entry?.utilization);
  return percent === undefined ? null : window(percent, epochSecondsToMs(entry?.resetsAt));
}

/** The 5-hour and weekly windows from a Claude `rate_limit_event`'s `rate_limit_info`. */
export function claudeLimitsFromRateLimitInfo(info: unknown): AgentUsageLimitsReading | undefined {
  const value = asObject(info);
  if (!value) return undefined;
  // Not in the SDK types; the CLI sends every window it knows here.
  const unified = asObject(value.unifiedWindows);
  if (unified) {
    return { fiveHour: claudeWindow(unified.five_hour), weekly: claudeWindow(unified.seven_day) };
  }
  const percent = claudePercent(value.utilization);
  if (percent === undefined) return undefined;
  const single = window(percent, epochSecondsToMs(value.resetsAt));
  if (value.rateLimitType === 'five_hour') return { fiveHour: single };
  if (value.rateLimitType === 'seven_day') return { weekly: single };
  return undefined;
}

/** Tokens the request sent: what fills the context window. Output is not counted. */
export function claudeInputTokens(usage: unknown): number {
  const value = asObject(usage);
  if (!value) return 0;
  const iterations = (Array.isArray(value.iterations) ? value.iterations : [])
    .map(asObject)
    .filter((entry): entry is JsonObject => entry !== undefined && entry.type !== 'compaction');
  const last = iterations[iterations.length - 1] ?? value;
  return (finite(last.input_tokens) ?? 0)
    + (finite(last.cache_creation_input_tokens) ?? 0)
    + (finite(last.cache_read_input_tokens) ?? 0);
}

/** Claude Code's context %: the last request's input side over the model's window. */
export function claudeContextPercent(usage: unknown, contextWindow: unknown): number | undefined {
  const size = finite(contextWindow);
  const tokens = claudeInputTokens(usage);
  if (size === undefined || size <= 0 || tokens <= 0) return undefined;
  return clampPercent(Math.round((tokens / size) * 100));
}

const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10_080;

/**
 * Codex `account/rateLimits/updated` → windows. The slot (primary/secondary)
 * does not say which window it is; its length does.
 */
export function codexLimitsFromRateLimits(rateLimits: unknown): AgentUsageLimitsReading | undefined {
  const value = asObject(rateLimits);
  if (!value) return undefined;
  if (value.limitId !== undefined && value.limitId !== null && value.limitId !== 'codex') return undefined;
  let fiveHour: AgentUsageWindow | null = null;
  let weekly: AgentUsageWindow | null = null;
  for (const slot of [value.primary, value.secondary]) {
    const entry = asObject(slot);
    const used = finite(entry?.usedPercent);
    if (!entry || used === undefined) continue;
    const reading = window(clampPercent(Math.round(used)), epochSecondsToMs(entry.resetsAt));
    if (entry.windowDurationMins === FIVE_HOUR_MINUTES) fiveHour = reading;
    else if (entry.windowDurationMins === WEEK_MINUTES) weekly = reading;
  }
  return { fiveHour, weekly };
}

/** Codex leaves this many tokens out of the window when it reports context use. */
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

/**
 * Codex's "context used" from `thread/tokenUsage/updated` (`last.totalTokens`
 * over `modelContextWindow`), with Codex's fixed baseline taken off both: the
 * footer's `Context N% used` is `100 - round(remaining)` (codex-rs
 * `TokenUsage::percent_of_context_window_remaining`, tui `status_controls.rs`).
 */
export function codexContextPercent(lastTotalTokens: unknown, contextWindow: unknown): number | undefined {
  const tokens = finite(lastTotalTokens);
  const size = finite(contextWindow);
  if (tokens === undefined || tokens <= 0 || size === undefined || size <= CODEX_CONTEXT_BASELINE_TOKENS) return undefined;
  const effective = size - CODEX_CONTEXT_BASELINE_TOKENS;
  const used = Math.max(0, tokens - CODEX_CONTEXT_BASELINE_TOKENS);
  const remainingPercent = clampPercent(Math.round(((effective - Math.min(used, effective)) / effective) * 100));
  return 100 - remainingPercent;
}
