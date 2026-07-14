import { useCallback, useEffect, useRef, useState } from 'react';

import type { SshForwardInfo } from '../shared/ssh-forward';

/** Compact, desktop-only status/control surface for loopback SSH forwards. */
export function SshForwardSettings(): JSX.Element {
  const [forwards, setForwards] = useState<readonly SshForwardInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.ezterminalDesktop;
    if (!api) {
      if (mountedRef.current) setForwards([]);
      return;
    }
    try {
      const next = await api.listSshForwards();
      if (!mountedRef.current) return;
      setForwards(next);
      setError(null);
    } catch {
      if (mountedRef.current) setError('SSH forward status is temporarily unavailable.');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const stop = useCallback(async (forward: SshForwardInfo): Promise<void> => {
    const api = window.ezterminalDesktop;
    if (!api || stopping) return;
    setStopping(forward.forwardId);
    setError(null);
    try {
      const result = await api.stopSshForward(forward.connectionId, forward.forwardId);
      if (!result.ok && mountedRef.current) setError(result.error.message);
      await refresh();
    } catch {
      if (mountedRef.current) setError('The SSH forward could not be stopped.');
    } finally {
      if (mountedRef.current) setStopping(null);
    }
  }, [refresh, stopping]);

  return (
    <section className="status-section" data-testid="settings-ssh-forwards">
      <h2 className="status-section-title">SSH Local Forwards</h2>
      {forwards === null ? (
        <div className="status-loading">Loading…</div>
      ) : forwards.length === 0 ? (
        <div className="status-loading">No active loopback forwards.</div>
      ) : (
        <div className="settings-ssh-forward-list">
          {forwards.map((forward) => (
            <div className="settings-ssh-forward-row" key={forward.forwardId}>
              <div className="settings-ssh-forward-detail">
                <code title={`${forward.bindHost}:${forward.localPort}`}>
                  {forward.bindHost}:{forward.localPort}
                </code>
                <span title={`${forward.remoteHost}:${forward.remotePort}`}>
                  → {forward.remoteHost}:{forward.remotePort}
                </span>
                <small title={forward.connectionId}>SSH {forward.connectionId.slice(0, 8)}</small>
              </div>
              <button
                type="button"
                className="btn btn-split"
                disabled={stopping !== null}
                onClick={() => { void stop(forward); }}
                data-testid={`settings-ssh-forward-stop-${forward.forwardId}`}
              >
                {stopping === forward.forwardId ? 'Stopping…' : 'Stop'}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="status-loading" role="alert" data-testid="settings-ssh-forward-error">
          {error}
        </div>
      )}
    </section>
  );
}
