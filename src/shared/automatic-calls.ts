import type { AgentUsageLevel } from './agent-usage';

/**
 * Every AI call the host could make without the person pressing anything, and what governs it. Later
 * bundles register their calls here. A task from `suggest_task` is not listed: the AI makes that call
 * inside its own turn, so it is no separate call the host pays for.
 */
export interface AutomaticCallPolicy {
  /** The host starts it on its own. */
  readonly automatic: boolean;
  /** The switch that stops it: Settings › 에이전트 › 턴 마무리 for `suggestions` and `recaps`, › 이어서 하기 for `autoResume`, › 내장 브라우저 for `browserCheck`. */
  readonly setting?: 'suggestions' | 'recaps' | 'autoResume' | 'browserCheck';
  /** It stops while a usage window is at AUTOMATIC_CALL_PAUSE_LEVEL. */
  readonly pausesNearLimit: boolean;
}

export const AUTOMATIC_CALLS = {
  review: { automatic: false, pausesNearLimit: false },
  'next-prompt-suggestion': { automatic: true, setting: 'suggestions', pausesNearLimit: true },
  'turn-recap': { automatic: true, setting: 'recaps', pausesNearLimit: true },
  // Sent because a limit stopped the turn, at the expected reset: LongRunCoordinator reads no usage window.
  'auto-resume': { automatic: true, setting: 'autoResume', pausesNearLimit: false },
  // One turn in the same conversation after a person's turn changed files: BrowserCheckCoordinator.
  'browser-check': { automatic: true, setting: 'browserCheck', pausesNearLimit: true },
} as const satisfies Readonly<Record<string, AutomaticCallPolicy>>;

export const AUTOMATIC_CALL_PAUSE_LEVEL: AgentUsageLevel = 'danger';
