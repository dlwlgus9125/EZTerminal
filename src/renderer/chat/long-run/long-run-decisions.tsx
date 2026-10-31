import { createContext, useContext } from 'react';

/**
 * 시안 only (2026-11-01): the options the person chooses between, shown side by side in Production/LongRun/Mockup. The
 * defaults are the recommended ones; after approval the chosen behaviour stays and this context goes. D2, D5, D6 and D7
 * need no switch here: what differs is what the host says, so a fixture draws them.
 *
 * - D1 `enter`: Enter while a turn runs puts the message into that turn (`steer`), or keeps queueing it and a separate
 *   button puts it in (`queue`).
 * - D3 `appRow`: the row the app wrote shows the exact text it sent (`exact`), or a Korean description only (`described`).
 * - D9 `settings`: the switch has its own section after 턴 마무리 (`own-section`), or sits inside it (`in-wrap-up`).
 */
export interface LongRunDecisions {
  readonly enter: 'steer' | 'queue';
  readonly appRow: 'exact' | 'described';
  readonly settings: 'own-section' | 'in-wrap-up';
}

export const RECOMMENDED_LONG_RUN_DECISIONS: LongRunDecisions = { enter: 'steer', appRow: 'exact', settings: 'own-section' };

const LongRunDecisionsContext = createContext<LongRunDecisions>(RECOMMENDED_LONG_RUN_DECISIONS);

export const LongRunDecisionsProvider = LongRunDecisionsContext.Provider;

export function useLongRunDecisions(): LongRunDecisions {
  return useContext(LongRunDecisionsContext);
}
