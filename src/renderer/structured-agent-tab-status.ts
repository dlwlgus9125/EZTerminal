import { useSyncExternalStore } from 'react';

import type { AgentProvider, AgentStatus } from '../shared/agent';
import type { ManagedAgentState } from '../shared/daemon-protocol';

export interface StructuredAgentTabStatus {
  readonly status: AgentStatus;
  readonly provider: AgentProvider;
  readonly providerLabel?: string;
}

/**
 * Tab dots for structured Agent panels. Terminal Agent tabs get theirs from the
 * activity service; a structured panel publishes its own state here, keyed by
 * Dockview panel id, and the workbench merges both.
 */
let statuses: ReadonlyMap<string, StructuredAgentTabStatus> = new Map();
const listeners = new Set<() => void>();

export function setStructuredAgentTabStatus(panelId: string, status: StructuredAgentTabStatus | undefined): void {
  const current = statuses.get(panelId);
  if (current?.status === status?.status && current?.provider === status?.provider && current?.providerLabel === status?.providerLabel) return;
  const next = new Map(statuses);
  if (status) next.set(panelId, status);
  else next.delete(panelId);
  statuses = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStructuredAgentTabStatuses(): ReadonlyMap<string, StructuredAgentTabStatus> {
  return statuses;
}

export function useStructuredAgentTabStatuses(): ReadonlyMap<string, StructuredAgentTabStatus> {
  return useSyncExternalStore(subscribe, getStructuredAgentTabStatuses);
}

/** The tab dot for a managed Agent state; `unseenDone` marks a finished turn the reader has not looked at. */
export function structuredTabStatus(state: ManagedAgentState | undefined, unseenDone: boolean): AgentStatus | undefined {
  switch (state) {
    case 'starting':
    case 'queued':
      return 'starting';
    case 'working':
      return 'working';
    case 'blocked':
    case 'delivery-uncertain':
      return 'blocked';
    case 'error':
      return 'error';
    case 'done':
      return 'done';
    default:
      return unseenDone ? 'done' : undefined;
  }
}

export function tabProvider(providerId: string | undefined): AgentProvider {
  return providerId === 'codex' || providerId === 'claude' ? providerId : 'generic';
}
