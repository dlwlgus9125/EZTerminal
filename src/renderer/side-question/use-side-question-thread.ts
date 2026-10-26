import { useCallback, useEffect, useRef, useState } from 'react';

import {
  boundedSideQuestionHistory,
  SIDE_QUESTION_MAX_QUESTION_CHARS,
  type AgentSideQuestionClient,
  type AgentSideQuestionErrorCode,
} from '../../shared/agent-side-question';

export type SideQuestionStatus = 'pending' | 'answered' | 'failed';

export interface SideQuestionEntry {
  readonly id: number;
  readonly question: string;
  readonly status: SideQuestionStatus;
  /** null: the provider returned no answer. */
  readonly answer?: string | null;
  readonly synthetic?: boolean;
  readonly fallbackNotice?: string;
  readonly errorCode?: AgentSideQuestionErrorCode;
}

export interface SideQuestionThread {
  readonly entries: readonly SideQuestionEntry[];
  readonly pending: boolean;
  /** False when nothing was sent (empty, too long, one already pending, or no client). */
  ask(question: string): boolean;
  cancel(): void;
  clear(): void;
}

const MAX_ENTRIES = 50;

/**
 * One conversation's /btw thread, in memory only: no storage API is touched, so it is gone when
 * the panel unmounts (the tab closes) or the app quits. Earlier answered exchanges travel as history.
 */
export function useSideQuestionThread(sessionId: string, client: AgentSideQuestionClient | undefined): SideQuestionThread {
  const [entries, setEntries] = useState<readonly SideQuestionEntry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pendingRef = useRef<{ readonly id: number; readonly controller: AbortController } | undefined>(undefined);
  const nextId = useRef(0);

  const settle = useCallback((id: number, patch: Partial<SideQuestionEntry>) => {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

  const cancel = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = undefined;
    pending.controller.abort();
    settle(pending.id, { status: 'failed', errorCode: 'cancelled' });
  }, [settle]);

  const clear = useCallback(() => {
    pendingRef.current?.controller.abort();
    pendingRef.current = undefined;
    setEntries([]);
  }, []);

  // A different conversation in the same panel starts its own thread.
  useEffect(() => clear, [sessionId, clear]);

  const ask = useCallback((raw: string): boolean => {
    const question = raw.trim();
    if (!client || !question || question.length > SIDE_QUESTION_MAX_QUESTION_CHARS || pendingRef.current) return false;
    const history = boundedSideQuestionHistory(entriesRef.current
      .filter((entry) => entry.status === 'answered' && typeof entry.answer === 'string' && !entry.synthetic)
      .map((entry) => ({ question: entry.question, answer: entry.answer as string, ...(entry.fallbackNotice ? { fallbackNotice: entry.fallbackNotice } : {}) })));
    const id = ++nextId.current;
    const controller = new AbortController();
    pendingRef.current = { id, controller };
    setEntries((current) => [...current, { id, question, status: 'pending' as const }].slice(-MAX_ENTRIES));
    void client.ask({ sessionId, question, history }, controller.signal).then((result) => {
      if (pendingRef.current?.id !== id) return; // cancelled, cleared or replaced: already settled
      pendingRef.current = undefined;
      settle(id, result.ok
        ? { status: 'answered', answer: result.answer, synthetic: result.synthetic, ...(result.fallbackNotice ? { fallbackNotice: result.fallbackNotice } : {}) }
        : { status: 'failed', errorCode: result.code });
    });
    return true;
  }, [client, sessionId, settle]);

  return { entries, pending: entries.some((entry) => entry.status === 'pending'), ask, cancel, clear };
}
