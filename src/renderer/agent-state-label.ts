import { useCallback } from 'react';

import type { ManagedAgentState } from '../shared/daemon-protocol';
import { useAppTranslation } from './i18n';

const AGENT_STATES: ReadonlySet<string> = new Set<ManagedAgentState>([
  'starting', 'queued', 'working', 'blocked', 'idle', 'done', 'interrupted', 'delivery-uncertain', 'error', 'archived',
]);

/** Names a managed Agent state in the UI language ("idle" reads "준비됨"); other values pass through. */
export function useAgentStateLabel(): (state: string) => string {
  const { t } = useAppTranslation();
  return useCallback(
    (state: string) => (AGENT_STATES.has(state) ? t(`agentHub.structuredSessions.state.${state as ManagedAgentState}`) : state),
    [t],
  );
}
