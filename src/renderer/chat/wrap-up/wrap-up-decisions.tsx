import { createContext, useContext } from 'react';

/**
 * 시안 only (2026-10-30): the options the person chooses between, shown side by side in
 * Production/TurnWrapUp/Mockup. The defaults are the recommended ones; after approval the chosen
 * behaviour stays and this context goes.
 *
 * - D2 `acceptKeys`: Tab fills the suggestion (`tab`), or Tab and → do (`tab-arrow`).
 * - D3 `recapHeading`: one heading on every recap (`away` 자리를 비운 사이, `turn` 이번 턴 요약), or the one that
 *   says why it was written (`trigger`: 자리를 비운 사이 / 멈추고 답을 기다림).
 * - D5 `taskStart`: 새 하위 대화로 시작 starts in one click with the defaults line and 바꿔서 시작… (`one-click`), or
 *   always opens the start form (`dialog`).
 */
export interface WrapUpDecisions {
  readonly acceptKeys: 'tab' | 'tab-arrow';
  readonly recapHeading: 'away' | 'turn' | 'trigger';
  readonly taskStart: 'one-click' | 'dialog';
}

export const RECOMMENDED_WRAP_UP_DECISIONS: WrapUpDecisions = { acceptKeys: 'tab', recapHeading: 'trigger', taskStart: 'one-click' };

const WrapUpDecisionsContext = createContext<WrapUpDecisions>(RECOMMENDED_WRAP_UP_DECISIONS);

export const WrapUpDecisionsProvider = WrapUpDecisionsContext.Provider;

export function useWrapUpDecisions(): WrapUpDecisions {
  return useContext(WrapUpDecisionsContext);
}
