import { createContext } from 'react';

import type { AgentResultsOpenRequest } from './agent-results-dock';

/** The workbench's Results tabs (desktop only; Android and stories have none). */
export interface AgentResultsHost {
  readonly open: (ownerPanelId: string, request?: AgentResultsOpenRequest) => boolean;
  readonly requestAutoOpen: (ownerPanelId: string, sessionId: string) => void;
}

export const AgentResultsContext = createContext<AgentResultsHost | null>(null);

/** One conversation tab's way to its own Results tab. */
export interface AgentResultsOwner {
  readonly ownerPanelId: string;
  readonly open: (request?: AgentResultsOpenRequest) => void;
}

export const AgentResultsOwnerContext = createContext<AgentResultsOwner | null>(null);
