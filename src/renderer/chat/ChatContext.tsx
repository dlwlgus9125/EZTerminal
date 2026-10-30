import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ChatReplyReference } from '../../shared/chat-message';
import type { SuggestedTaskWhere } from '../../shared/turn-wrap-up';
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

/**
 * Turn wrap-up (시안): what the person did on a suggested-task or recap card. Starting, sending and dismissing are the
 * host's; `task-start-custom` opens the start form (맡기기) on the task. A started task's sub-conversation opens
 * through `onOpenRelated`, and a recap's 답하러 가기 through `onFocusDecision`.
 */
export type ChatWrapUpAction =
  | { readonly kind: 'task-start' | 'task-start-custom' | 'task-here' | 'task-dismiss' | 'task-reopen'; readonly turnId: string; readonly taskId: string }
  | { readonly kind: 'task-start-all'; readonly turnId: string; readonly starts: readonly { readonly taskId: string; readonly where: SuggestedTaskWhere }[] }
  | { readonly kind: 'recap-retry'; readonly turnId: string };

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
  /** Turn wrap-up card actions (시안). Absent: the cards are read-only. */
  readonly onWrapUpAction?: (action: ChatWrapUpAction) => void;
  /**
   * What 새 하위 대화로 시작 starts a sub-conversation with, in words (`Claude · Opus 5.5 · 높음 · 승인 후 실행`). On the
   * phone it always starts in this folder: only the desktop creates worktrees and has the start form.
   */
  readonly taskStart?: { readonly settings: string; readonly phone: boolean };
  /** Moves focus to the decision waiting above the message box; false when there is none. */
  readonly onFocusDecision?: () => boolean;
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
  onReviewAction, onWrapUpAction, taskStart, onFocusDecision,
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
    onReviewAction, onWrapUpAction, taskStart, onFocusDecision, isExpanded, setExpanded,
  }), [
    skin, locale, workspaceRoot, onReply, onReuse, onOpenLink, onOpenRelated, onReviewChanges, onOpenResults, resolveFileLink,
    onReviewAction, onWrapUpAction, taskStart, onFocusDecision, isExpanded, setExpanded,
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
