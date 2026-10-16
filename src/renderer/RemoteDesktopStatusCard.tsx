import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';

import type { RemoteDesktopHostStatus } from '../shared/ipc';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { Button } from './ui';
import './remote-panel.css';

export function useElapsed(connectedAt: number | null, currentTime?: number): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (connectedAt === null || currentTime !== undefined) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [connectedAt, currentTime]);
  if (connectedAt === null) return '—';
  const total = Math.max(0, Math.floor(((currentTime ?? Date.now()) - connectedAt) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function useRemoteDesktopDisconnect(
  capabilities: CapabilityAccess = rendererCapabilities,
): { readonly disconnecting: boolean; readonly disconnect: () => void } {
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = useCallback(() => {
    if (capabilities.snapshot().desktop === 'unavailable') return;
    setDisconnecting(true);
    void capabilities.remoteDesktop.disconnect()
      .catch(() => null)
      .finally(() => setDisconnecting(false));
  }, [capabilities]);
  return { disconnecting, disconnect };
}

export function useRemoteDesktopHostStatus(
  capabilities: CapabilityAccess = rendererCapabilities,
): RemoteDesktopHostStatus | null {
  const [status, setStatus] = useState<RemoteDesktopHostStatus | null>(null);
  const committedRef = useRef<RemoteDesktopHostStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let frame: number | null = null;
    let queued: RemoteDesktopHostStatus | null = null;
    const commit = (next: RemoteDesktopHostStatus): void => {
      if (!alive) return;
      committedRef.current = next;
      setStatus(next);
    };
    const unsubscribe = capabilities.remoteDesktop.observe((next) => {
      if (!alive) return;
      const previous = committedRef.current;
      const authorityChanged = previous === null
        || previous.service !== next.service
        || previous.state !== next.state
        || previous.controllerName !== next.controllerName
        || previous.connectedAt !== next.connectedAt
        || previous.errorCode !== next.errorCode;
      if (authorityChanged || typeof requestAnimationFrame !== 'function') {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        queued = null;
        commit(next);
        return;
      }
      queued = next;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const latest = queued;
        queued = null;
        if (latest) commit(latest);
      });
    });
    return () => {
      alive = false;
      if (frame !== null) cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [capabilities]);
  return status;
}

/**
 * The host side of PC control in one glance: what the session is doing and whether the
 * host service is there. Who is controlling, for how long and how well is drawn on the
 * topology above, which is also where the disconnect lives.
 */
export function RemoteDesktopStatusCard({
  status,
}: {
  readonly status: RemoteDesktopHostStatus | null;
}): JSX.Element {
  const { t } = useAppTranslation();
  const tone = !status
    ? undefined
    : status.state === 'error'
      ? 'danger'
      : status.state === 'starting' || status.state === 'reconnecting'
        ? 'warning'
        : status.service === 'ready' ? 'ok' : undefined;

  return (
    <section className="remote-card remote-host-card" data-testid="remote-desktop-status-card">
      <h2 className="remote-card__label">
        <MonitorSmartphone aria-hidden="true" />
        {t('remote.pcControlTitle')}
      </h2>
      {!status ? (
        <p className="remote-card__note">{t('common.loading')}</p>
      ) : (
        <>
          <p className="remote-host-card__state" data-tone={tone}>
            {t(`remote.pcControlState.${status.state}`)}
          </p>
          <p className="remote-card__note" data-tone={status.errorCode ? 'danger' : undefined}>
            {status.errorCode
              ?? `${t('remote.pcControlService')} · ${t(`remote.pcControlServiceState.${status.service}`)}`}
          </p>
        </>
      )}
    </section>
  );
}

export function RemoteControlBanner({
  status,
  capabilities = rendererCapabilities,
}: {
  readonly status: RemoteDesktopHostStatus;
  readonly capabilities?: CapabilityAccess;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [disconnecting, setDisconnecting] = useState(false);
  return (
    <div className="remote-control-banner" role="status" data-testid="remote-control-banner">
      <MonitorSmartphone aria-hidden="true" size={17} />
      <span>{t('remote.pcControlBanner', { device: status.controllerName ?? t('common.unavailable') })}</span>
      <Button
        size="sm"
        disabled={disconnecting}
        onClick={() => {
          if (capabilities.snapshot().desktop === 'unavailable') return;
          setDisconnecting(true);
          void capabilities.remoteDesktop.disconnect()
            .catch(() => null)
            .finally(() => setDisconnecting(false));
        }}
      >
        {disconnecting ? t('remote.stopping') : t('remote.pcControlDisconnect')}
      </Button>
    </div>
  );
}
