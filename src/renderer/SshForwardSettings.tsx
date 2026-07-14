import { useCallback, useEffect, useRef, useState } from 'react';

import type { SshForwardInfo } from '../shared/ssh-forward';
import { useAppTranslation } from './i18n';

type SshForwardError =
  | { readonly kind: 'external'; readonly message: string }
  | { readonly kind: 'status-unavailable' | 'stop-failed' }
  | null;

/** Compact, desktop-only status/control surface for loopback SSH forwards. */
export function SshForwardSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const [forwards, setForwards] = useState<readonly SshForwardInfo[] | null>(null);
  const [error, setError] = useState<SshForwardError>(null);
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
      if (mountedRef.current) setError({ kind: 'status-unavailable' });
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
      if (!result.ok && mountedRef.current) setError({ kind: 'external', message: result.error.message });
      await refresh();
    } catch {
      if (mountedRef.current) setError({ kind: 'stop-failed' });
    } finally {
      if (mountedRef.current) setStopping(null);
    }
  }, [refresh, stopping]);

  const errorText = error?.kind === 'external'
    ? error.message
    : error?.kind === 'status-unavailable'
      ? t('remote.sshStatusUnavailable')
      : error?.kind === 'stop-failed'
        ? t('remote.sshStopFailed')
        : null;

  return (
    <section className="status-section" data-testid="settings-ssh-forwards">
      <h2 className="status-section-title">{t('remote.sshLocalForwards')}</h2>
      {forwards === null ? (
        <div className="status-loading">{t('common.loading')}</div>
      ) : forwards.length === 0 ? (
        <div className="status-loading">{t('remote.noActiveForwards')}</div>
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
                {stopping === forward.forwardId ? t('remote.stopping') : t('remote.stop')}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="status-loading" role="alert" data-testid="settings-ssh-forward-error">
          {errorText}
        </div>
      )}
    </section>
  );
}
