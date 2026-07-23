import { useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone, Power } from 'lucide-react';

import type { RemoteDesktopHostStatus } from '../shared/ipc';
import { useAppTranslation } from './i18n';

function useElapsed(connectedAt: number | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (connectedAt === null) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [connectedAt]);
  if (connectedAt === null) return '—';
  const total = Math.max(0, Math.floor((Date.now() - connectedAt) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function useRemoteDesktopHostStatus(): RemoteDesktopHostStatus | null {
  const [status, setStatus] = useState<RemoteDesktopHostStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const api = window.ezterminalDesktop;
    if (!api?.getRemoteDesktopStatus || !api.onRemoteDesktopStatus) return undefined;
    void api.getRemoteDesktopStatus().then((next) => {
      if (alive) setStatus(next);
    });
    const unsubscribe = api.onRemoteDesktopStatus((next) => {
      if (alive) setStatus(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return status;
}

export function RemoteDesktopStatusCard(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useRemoteDesktopHostStatus();
  const elapsed = useElapsed(status?.connectedAt ?? null);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = useCallback(() => {
    const request = window.ezterminalDesktop?.disconnectRemoteDesktop();
    if (!request) return;
    setDisconnecting(true);
    void request.finally(() => setDisconnecting(false));
  }, []);

  return (
    <div className="status-drawer remote-desktop-card" data-testid="remote-desktop-status-card">
      <section className="status-section">
        <h2 className="status-section-title">
          <MonitorSmartphone aria-hidden="true" size={16} />
          {t('remote.pcControlTitle')}
        </h2>
        {!status ? (
          <div className="status-loading">{t('common.loading')}</div>
        ) : (
          <>
            <div className="status-metric">
              <span>{t('remote.pcControlService')}</span>
              <strong>{t(`remote.pcControlServiceState.${status.service}`)}</strong>
            </div>
            <div className="status-metric">
              <span>{t('remote.pcControlStateLabel')}</span>
              <strong>{t(`remote.pcControlState.${status.state}`)}</strong>
            </div>
            {status.controllerName ? (
              <>
                <div className="status-metric"><span>{t('remote.pcControlDevice')}</span><strong>{status.controllerName}</strong></div>
                <div className="status-metric"><span>{t('remote.pcControlDuration')}</span><strong>{elapsed}</strong></div>
                <div className="status-metric"><span>{t('remote.pcControlEndpoint')}</span><strong>{status.localAddress ?? '—'}:7422</strong></div>
                <div className="status-metric"><span>FPS / RTT</span><strong>{status.framesPerSecond === null ? '—' : Math.round(status.framesPerSecond)} / {status.roundTripTimeMs === null ? '—' : `${Math.round(status.roundTripTimeMs)} ms`}</strong></div>
                <div className="status-metric"><span>{t('remote.pcControlQuality')}</span><strong>{status.qualityTier ?? '—'} / {status.bitrateKbps === null ? '—' : `${Math.round(status.bitrateKbps)} kbps`}</strong></div>
                <button className="btn btn-split remote-desktop-disconnect" type="button" onClick={disconnect} disabled={disconnecting}>
                  <Power aria-hidden="true" size={14} />
                  {disconnecting ? t('remote.stopping') : t('remote.pcControlDisconnect')}
                </button>
              </>
            ) : (
              <p className="status-loading">{status.errorCode ?? t('remote.pcControlIdle')}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function RemoteControlBanner({ status }: { readonly status: RemoteDesktopHostStatus }): JSX.Element {
  const { t } = useAppTranslation();
  const [disconnecting, setDisconnecting] = useState(false);
  return (
    <div className="remote-control-banner" role="status" data-testid="remote-control-banner">
      <MonitorSmartphone aria-hidden="true" size={17} />
      <span>{t('remote.pcControlBanner', { device: status.controllerName ?? t('common.unavailable') })}</span>
      <button
        className="btn btn-split"
        type="button"
        disabled={disconnecting}
        onClick={() => {
          const request = window.ezterminalDesktop?.disconnectRemoteDesktop();
          if (!request) return;
          setDisconnecting(true);
          void request.finally(() => setDisconnecting(false));
        }}
      >
        {disconnecting ? t('remote.stopping') : t('remote.pcControlDisconnect')}
      </button>
    </div>
  );
}
