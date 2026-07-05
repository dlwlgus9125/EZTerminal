import { useCallback, useEffect, useState } from 'react';

import type { SessionInfo } from '../../src/shared/ipc';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

// SessionSwitcher — the mobile-only drawer (no desktop analogue) listing every
// session currently live on the desktop bridge (`list-sessions`), with
// create/destroy/select. Selecting mounts a `MobileSessionView` for that
// sessionId; this component itself never creates a BlockController/port.
export function SessionSwitcher({
  transport,
  onSelect,
  onDisconnect,
}: {
  transport: WsEzTerminalTransport;
  onSelect: (sessionId: string) => void;
  onDisconnect: () => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<readonly SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    void transport.listSessions().then((list) => {
      setSessions(list);
      setLoading(false);
    });
  }, [transport]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createAndOpen = useCallback(() => {
    void transport.createSession().then((info) => onSelect(info.sessionId));
  }, [transport, onSelect]);

  const destroy = useCallback(
    (sessionId: string) => {
      transport.destroySession(sessionId);
      refresh();
    },
    [transport, refresh],
  );

  return (
    <div className="session-switcher" data-testid="session-switcher">
      <header className="session-switcher-head">
        <h2>Sessions</h2>
        <button className="btn" onClick={onDisconnect} data-testid="disconnect-btn">
          Disconnect
        </button>
      </header>

      {loading ? (
        <p className="session-list-loading">Loading…</p>
      ) : (
        <ul className="session-list" data-testid="session-list">
          {sessions.map((s) => (
            <li key={s.sessionId} className="session-list-item" data-testid="session-item">
              <button
                type="button"
                className="session-open"
                onClick={() => onSelect(s.sessionId)}
                data-testid="session-open"
              >
                {s.cwd}
              </button>
              <button
                type="button"
                className="btn btn-cancel"
                onClick={() => destroy(s.sessionId)}
                aria-label="destroy session"
                data-testid="session-destroy"
              >
                ✕
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="session-list-empty">No sessions yet.</li>}
        </ul>
      )}

      <button
        type="button"
        className="btn btn-run session-create"
        onClick={createAndOpen}
        data-testid="session-create"
      >
        + New Session
      </button>
    </div>
  );
}
