import { useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from './i18n';

type PairingError =
  | { readonly kind: 'external'; readonly message: string }
  | { readonly kind: 'token-unavailable' | 'rotate-failed' }
  | null
  | undefined;

/**
 * Mobile pairing panel (M4): shows the LAN URL(s) + auth token a phone needs
 * to connect to this desktop's remote-control bridge, plus a rotate action.
 * Reuses the `status-drawer`/`status-section`/`btn-split` styles StatusPanel
 * already defines in index.css rather than adding new CSS — same overlay
 * shape, different content.
 */
export function ConnectionInfoPanel(): JSX.Element {
  const { t } = useAppTranslation();
  const [urls, setUrls] = useState<readonly string[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState<boolean | null>(null);
  const [securityError, setSecurityError] = useState<PairingError>(undefined);
  const [justRotated, setJustRotated] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.ezterminal.getRemoteConnectionInfo().then((info) => {
      if (alive) setUrls(info.urls);
    });
    void window.ezterminal.getRemoteSecurityStatus().then((status) => {
      if (!alive) return;
      setSecurityError(status.error ? { kind: 'external', message: status.error } : null);
      if (status.state === 'ready') {
        void window.ezterminal.getRemoteToken().then(
          (t) => {
            if (alive) setToken(t);
          },
          () => {
            if (alive) setSecurityError({ kind: 'token-unavailable' });
          },
        );
      }
    });
    void window.ezterminal.getRemoteEnabled().then((v) => {
      if (alive) setRemoteEnabled(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleRotate = useCallback(() => {
    void window.ezterminal.rotateRemoteToken().then(
      (t) => {
        setToken(t);
        setJustRotated(true);
        setSecurityError(null);
      },
      () => setSecurityError({ kind: 'rotate-failed' }),
    );
  }, []);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedText(text);
      setTimeout(() => setCopiedText((current) => (current === text ? null : current)), 1500);
    });
  }, []);

  const loading = urls === null || remoteEnabled === null || securityError === undefined || (securityError === null && token === null);
  const securityErrorText = securityError?.kind === 'external'
    ? securityError.message
    : securityError?.kind === 'token-unavailable'
      ? t('remote.tokenUnavailable')
      : securityError?.kind === 'rotate-failed'
        ? t('remote.rotateFailed')
        : null;

  return (
    <div className="status-drawer" data-testid="connection-info-panel">
      <section className="status-section">
        <h2 className="status-section-title">{t('remote.pairingTitle')}</h2>
        {loading ? (
          <div className="status-loading">{t('common.loading')}</div>
        ) : securityError ? (
          <div className="status-loading" role="alert" data-testid="pairing-security-error">
            {securityErrorText}
          </div>
        ) : !remoteEnabled ? (
          <div className="status-loading" data-testid="pairing-remote-disabled">
            {t('remote.disabled')}
          </div>
        ) : urls.length === 0 ? (
          <div className="status-loading">{t('remote.noLan')}</div>
        ) : (
          <>
            {urls.map((url) => (
              <div key={url} className="status-metric" data-testid="connection-url">
                {url}{' '}
                <button className="btn btn-split" onClick={() => handleCopy(url)}>
                  {copiedText === url ? t('remote.copied') : t('remote.copy')}
                </button>
              </div>
            ))}
            <div className="status-metric" data-testid="connection-token">
              {t('remote.token')}: <code>{token}</code>{' '}
              <button className="btn btn-split" onClick={() => handleCopy(token!)}>
                {copiedText === token ? t('remote.copied') : t('remote.copy')}
              </button>
            </div>
            <button
              className="btn btn-split"
              onClick={handleRotate}
              title={t('remote.rotateTokenHint')}
              data-testid="btn-rotate-token"
            >
              {t('remote.rotateToken')}
            </button>
            {justRotated && (
              <div className="status-loading">
                {t('remote.rotatedNotice')}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
