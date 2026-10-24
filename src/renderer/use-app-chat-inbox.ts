import { useCallback, useEffect, useMemo, useState } from 'react';

import { appChatInbox, type AppChatInboxEntry, type AppChatInboxSeen } from '../shared/app-chat-inbox';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { rendererCapabilities } from './capability-access';

const SEEN_KEY = 'ezterminal:app-chat-inbox:v1';
const MAX_SEEN = 500;

/** Device-local: which conversations this person has looked at since they ended. */
function readSeen(): AppChatInboxSeen {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null') as Partial<AppChatInboxSeen> | null;
    if (value && typeof value.epoch === 'string' && value.sessions && typeof value.sessions === 'object') {
      return { epoch: value.epoch, sessions: value.sessions as Record<string, string> };
    }
  } catch { /* An unreadable mark starts a fresh inbox; it never blocks the app. */ }
  // The first run only counts what ends from now on.
  const fresh = { epoch: new Date().toISOString(), sessions: {} };
  writeSeen(fresh);
  return fresh;
}

function writeSeen(seen: AppChatInboxSeen): void {
  const entries = Object.entries(seen.sessions).sort((left, right) => right[1].localeCompare(left[1])).slice(0, MAX_SEEN);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ epoch: seen.epoch, sessions: Object.fromEntries(entries) })); } catch { /* Kept in memory. */ }
}

export interface AppChatInboxState {
  readonly entries: readonly AppChatInboxEntry[];
  readonly markSeen: (sessionId: string) => void;
  /** The daemon snapshot the inbox reads; the Board + Desk shell reads the same one. */
  readonly snapshot: DaemonSnapshot | null;
}

/** The app-conversation part of 받은 요청, live from the daemon snapshot. */
export function useAppChatInbox(activeSessionId: string | undefined, daemon = rendererCapabilities.daemon): AppChatInboxState {
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [seen, setSeen] = useState<AppChatInboxSeen>(readSeen);

  useEffect(() => {
    let alive = true;
    let pending = false;
    let queued = false;
    const refresh = async (): Promise<void> => {
      if (pending) { queued = true; return; }
      pending = true;
      try {
        const next = await daemon.getSnapshot();
        if (alive) setSnapshot(next);
      } catch { /* The inbox stays as it was until the daemon answers again. */ }
      finally { pending = false; if (alive && queued) { queued = false; void refresh(); } }
    };
    void refresh();
    // Transcript deltas do not change what the inbox shows; entity changes do.
    const stop = daemon.observeEvents((event) => {
      if (event.kind === 'entity.upserted' || event.kind === 'entity.archived' || event.kind === 'approval.changed' || event.kind === 'runtime.recovery') void refresh();
    }, () => { void refresh(); });
    return () => { alive = false; stop(); };
  }, [daemon]);

  const mark = useCallback((sessionId: string, throttled: boolean): void => {
    setSeen((current) => {
      // An open conversation is marked as its snapshot changes; once every few seconds is enough.
      const last = current.sessions[sessionId];
      if (throttled && last && Date.now() - Date.parse(last) < 5_000) return current;
      const next = { ...current, sessions: { ...current.sessions, [sessionId]: new Date().toISOString() } };
      writeSeen(next);
      return next;
    });
  }, []);
  const markSeen = useCallback((sessionId: string): void => mark(sessionId, false), [mark]);

  // Looking at a conversation is reading it: a turn that ends while it is open is not news.
  useEffect(() => {
    if (activeSessionId) mark(activeSessionId, true);
  }, [activeSessionId, snapshot, mark]);

  const entries = useMemo(
    () => (snapshot ? appChatInbox(snapshot, seen, new Set(activeSessionId ? [activeSessionId] : [])) : []),
    [snapshot, seen, activeSessionId],
  );
  return { entries, markSeen, snapshot };
}
