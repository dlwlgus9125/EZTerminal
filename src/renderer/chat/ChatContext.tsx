import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ChatReplyReference } from '../../shared/chat-message';
import type { ResolveFileLink } from './markdown/file-links';
import { readSessionViewState, saveSessionViewState } from '../session-view-state';
import type { ChatLocale } from './model/summary';

export type ChatSkin = 'bubble' | 'cli';

/** Where the conversation's Results tab should open, and on what. */
export interface ChatResultsTarget {
  readonly turnId?: string;
  readonly path?: string;
  readonly line?: number;
}

export type ChatReviewActionKind =
  | 'fix' | 'fix-all' | 'dismiss' | 'reopen' | 'walkthrough' | 'cancel' | 'retry' | 'open-reviewer' | 'review-with-other';

/**
 * Something the person did on an AI review card. Fixes always go to this conversation as an
 * ordinary turn; `walkthrough` opens the changes at a finding (`findingIds[0]`, else the first).
 */
export interface ChatReviewAction {
  readonly kind: ChatReviewActionKind;
  readonly reviewId: string;
  readonly findingIds?: readonly string[];
}

export interface ChatContextValue {
  readonly skin: ChatSkin;
  readonly locale: ChatLocale;
  readonly workspaceRoot?: string;
  readonly onReply?: (reply: ChatReplyReference) => void;
  readonly onReuse?: (text: string) => void;
  readonly onOpenLink?: (url: string) => void;
  readonly onOpenRelated?: (sessionId: string) => void;
  readonly onReviewChanges?: () => void;
  /**
   * Desktop: opens the conversation's Results tab. When present, change cards
   * and the task dock lead there instead of expanding in place.
   */
  readonly onOpenResults?: (section: 'changes' | 'files' | 'summary', target?: ChatResultsTarget) => void;
  /** Which file references in messages are links (they open in the Results tab). */
  readonly resolveFileLink?: ResolveFileLink;
  /** Review card actions. Absent (history, a host without reviews): the card is read-only. */
  readonly onReviewAction?: (action: ChatReviewAction) => void;
  /** Disclosure state that survives virtualized unmounts and skin switches. */
  readonly isExpanded: (key: string, fallback: boolean) => boolean;
  readonly setExpanded: (key: string, open: boolean) => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function useChatContext(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) throw new Error('Chat rows must render inside ChatProvider.');
  return value;
}

export function ChatProvider({
  children, stateKey, skin, locale, workspaceRoot, onReply, onReuse, onOpenLink, onOpenRelated, onReviewChanges, onOpenResults, resolveFileLink,
  onReviewAction,
}: Omit<ChatContextValue, 'isExpanded' | 'setExpanded'> & {
  readonly children: ReactNode;
  /** Persists expanded/collapsed choices per conversation in session storage. */
  readonly stateKey?: string;
}): JSX.Element {
  const storageKey = stateKey ? `${stateKey}:chat-disclosure` : undefined;
  const [expanded, setExpandedState] = useState<Readonly<Record<string, boolean>>>(
    () => (storageKey ? readSessionViewState<Record<string, boolean>>(storageKey) ?? {} : {}),
  );
  const isExpanded = useCallback((key: string, fallback: boolean) => expanded[key] ?? fallback, [expanded]);
  const setExpanded = useCallback((key: string, open: boolean) => {
    setExpandedState((current) => {
      const next = { ...current, [key]: open };
      if (storageKey) saveSessionViewState(storageKey, next);
      return next;
    });
  }, [storageKey]);
  // Every field is named, so the hook rule tracks each one; a field added to the type must be added here.
  const context = useMemo<ChatContextValue>(() => ({
    skin, locale, workspaceRoot, onReply, onReuse, onOpenLink, onOpenRelated, onReviewChanges, onOpenResults, resolveFileLink,
    onReviewAction, isExpanded, setExpanded,
  }), [
    skin, locale, workspaceRoot, onReply, onReuse, onOpenLink, onOpenRelated, onReviewChanges, onOpenResults, resolveFileLink,
    onReviewAction, isExpanded, setExpanded,
  ]);
  return <ChatContext.Provider value={context}>{children}</ChatContext.Provider>;
}

/** Re-renders every second while `active`, for live "Working for 12s" clocks. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
