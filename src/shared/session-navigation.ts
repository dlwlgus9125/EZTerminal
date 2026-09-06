/** UI intents only. Execution and persisted identities remain host-owned. */
export interface NewSessionDraftIntent {
  readonly kind: 'agent' | 'terminal';
  readonly agentMode: 'conversation' | 'cli';
  readonly projectId?: string;
  readonly workspaceId?: string;
}

export type SessionNavigationTarget =
  | { readonly kind: 'terminal'; readonly sessionId: string }
  | { readonly kind: 'agent'; readonly sessionId: string; readonly title?: string }
  | { readonly kind: 'history'; readonly historyId: string; readonly projectId: string };
