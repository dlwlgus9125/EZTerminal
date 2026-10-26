import { createContext, useContext, useSyncExternalStore } from 'react';

import type { DaemonSnapshot } from '../../shared/daemon-protocol';

/**
 * What a terminal's AI input needs from the app: the live daemon snapshot (the
 * same one the shell reads) and a way to open a conversation. A small store,
 * so only the AI dock that is showing re-renders on snapshot changes — not
 * every terminal pane.
 */
export interface TerminalAiHost {
  getSnapshot(): DaemonSnapshot | null;
  subscribe(listener: () => void): () => void;
  /** Open (and show) a conversation's tab. */
  openConversation(sessionId: string): void;
  /** Say a message went to a conversation, in the window the terminal is in, with a way to open it. */
  notifySent(sessionId: string, ownerDocument: Document): void;
}

export const TerminalAiContext = createContext<TerminalAiHost | null>(null);

export function useTerminalAiHost(): TerminalAiHost | null {
  return useContext(TerminalAiContext);
}

const noSnapshot = (): DaemonSnapshot | null => null;
const noSubscribe = (): (() => void) => () => undefined;

/** The live snapshot, re-rendering the caller when it changes. */
export function useTerminalAiSnapshot(host: TerminalAiHost | null): DaemonSnapshot | null {
  return useSyncExternalStore(host?.subscribe ?? noSubscribe, host?.getSnapshot ?? noSnapshot);
}

export interface TerminalAiHostActions {
  readonly openConversation: (sessionId: string) => void;
  readonly notifySent: (sessionId: string, ownerDocument: Document) => void;
}

/** A host whose snapshot and actions the app pushes in (`set`, `setActions`), so its identity never changes. */
export function createTerminalAiHost(actions: TerminalAiHostActions): TerminalAiHost & {
  set(snapshot: DaemonSnapshot | null): void;
  setActions(actions: TerminalAiHostActions): void;
} {
  let snapshot: DaemonSnapshot | null = null;
  let current = actions;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    openConversation: (sessionId) => current.openConversation(sessionId),
    notifySent: (sessionId, ownerDocument) => current.notifySent(sessionId, ownerDocument),
    set: (next) => {
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    setActions: (next) => { current = next; },
  };
}
