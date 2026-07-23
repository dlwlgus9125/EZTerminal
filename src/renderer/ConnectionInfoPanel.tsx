import { useCallback, useEffect, useState } from 'react';

import type { RemoteRuntimeStatus } from '../shared/ipc';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
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
export function ConnectionInfoPanel({
  capabilities = rendererCapabilities,
}: { readonly capabilities?: CapabilityAccess }): JSX.Element {
  const { t } = useAppTranslation();
  const [urls, setUrls] = useState<readonly string[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteRuntimeStatus | null>(null);
  const [securityError, setSecurityError] = useState<PairingError>(undefined);
  const [justRotated, setJustRotated] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  useEffect(() => {
    return capabilities.remotePairing.observe({
      onConnectionInfo: (info) => setUrls(info.urls),
      onSecurity: (status) => {
        setSecurityError(status.error ? { kind: 'external', message: status.error } : null);
      },
      onToken: setToken,
      onRuntime: setRemoteStatus,
      onError: (stage) => {
        if (stage === 'security' || stage === 'token') {
          setSecurityError({ kind: 'token-unavailable' });
          return;
        }
        const message = t('remote.runtimeUnavailable');
        if (stage === 'connection') {
          setUrls([]);
          setSecurityError({ kind: 'external', message });
          return;
        }
        setRemoteStatus({
          desiredEnabled: false,
          state: 'error',
          port: 0,
          errorCode: 'CAPABILITY_UNAVAILABLE',
          error: message,
        });
      },
    });
  }, [capabilities, t]);

  const handleRotate = useCallback(() => {
    void capabilities.remotePairing.rotateToken().then(
      (t) => {
        setToken(t);
        setJustRotated(true);
        setSecurityError(null);
      },
      () => setSecurityError({ kind: 'rotate-failed' }),
    );
  }, [capabilities]);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedText(text);
      setTimeout(() => setCopiedText((current) => (current === text ? null : current)), 1500);
    });
  }, []);

  const handleRetry = useCallback(() => {
    void capabilities.remoteRuntime.retry().then(setRemoteStatus, () => {
      setRemoteStatus((current) => current && {
        ...current,
        state: 'error',
        error: current.error ?? t('remote.runtimeUnavailable'),
      });
    });
  }, [capabilities, t]);

  const loading = urls === null
    || remoteStatus === null
    || securityError === undefined
    || (remoteStatus?.state === 'running' && securityError === null && token === null);
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
        <p className="status-loading" role="note" data-testid="pairing-ws-warning">
          {t('remote.trustedNetworkWarning')}
        </p>
        {loading ? (
          <div className="status-loading">{t('common.loading')}</div>
        ) : securityError ? (
          <div className="status-loading" role="alert" data-testid="pairing-security-error">
            {securityErrorText}
          </div>
        ) : remoteStatus.state === 'error' ? (
          <div className="status-loading" role="alert" data-testid="pairing-runtime-error">
            {remoteStatus.error ?? t('remote.runtimeUnavailable')}{' '}
            {remoteStatus.desiredEnabled && (
              <button className="btn btn-split" onClick={handleRetry} data-testid="pairing-runtime-retry">
                {t('common.retry')}
              </button>
            )}
          </div>
        ) : remoteStatus.state === 'starting' || remoteStatus.state === 'stopping' ? (
          <div className="status-loading" data-testid="pairing-runtime-transition">
            {remoteStatus.state === 'starting' ? t('remote.starting') : t('remote.stopping')}
          </div>
        ) : remoteStatus.state !== 'running' ? (
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
