import { useEffect, useState } from 'react';
import type { EzTerminalApi } from '../shared/ipc';
import type { DaemonSnapshot } from '../shared/daemon-protocol';

type Access = Pick<EzTerminalApi, 'listSessions' | 'onSessionAdded' | 'onSessionRemoved'>;

/** A persisted PTY record is history, not proof of a live process. */
export function useLiveTerminalSessions(access?: Access): ReadonlySet<string> | null {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    setIds(null);
    if (!access || typeof access.listSessions !== 'function') return;
    let active = true;
    let generation = 0;
    const refresh = (): void => {
      const request = ++generation;
      void access.listSessions().then((sessions) => {
        if (active && request === generation) setIds(new Set(sessions.map((session) => session.sessionId)));
      }, () => { if (active && request === generation) setIds(null); });
    };
    const added = access.onSessionAdded?.(refresh);
    const removed = access.onSessionRemoved?.(refresh);
    refresh();
    return () => { active = false; added?.(); removed?.(); };
  }, [access]);
  return ids;
}

export function withLiveTerminalSessions(snapshot: DaemonSnapshot | null, ids: ReadonlySet<string> | null): DaemonSnapshot | null {
  if (!snapshot || !ids) return snapshot;
  return { ...snapshot, sessions: snapshot.sessions.map((session) => {
    if (session.kind !== 'terminal' || session.source !== 'legacy-pty') return session;
    if (!ids.has(session.id)) return { ...session, state: 'completed' as const };
    return session;
  }) };
}
