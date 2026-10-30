import type { AgentUsageLevel } from './agent-usage';

/**
 * Every AI call the host could make without the person pressing anything, and what governs it. Later
 * bundles register their calls here. A task from `suggest_task` is not listed: the AI makes that call
 * inside its own turn, so it is no separate call the host pays for.
 */
export interface AutomaticCallPolicy {
  /** The host starts it on its own. */
  readonly automatic: boolean;
  /** The Settings › 에이전트 › 턴 마무리 switch that stops it. */
  readonly setting?: 'suggestions' | 'recaps';
  /** It stops while a usage window is at AUTOMATIC_CALL_PAUSE_LEVEL. */
  readonly pausesNearLimit: boolean;
}

export const AUTOMATIC_CALLS = {
  review: { automatic: false, pausesNearLimit: false },
  'next-prompt-suggestion': { automatic: true, setting: 'suggestions', pausesNearLimit: true },
  'turn-recap': { automatic: true, setting: 'recaps', pausesNearLimit: true },
} as const satisfies Readonly<Record<string, AutomaticCallPolicy>>;

export const AUTOMATIC_CALL_PAUSE_LEVEL: AgentUsageLevel = 'danger';
