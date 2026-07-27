import { Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { RemoteDeviceEntry } from '../../shared/ipc';
import { useAppTranslation } from '../i18n';

/** Matches the SSH forward list's cadence — the bridge pushes no device events,
 * so the panel asks while it is on screen and stops when it is not. */
const POLL_MS = 2000;

/**
 * Devices the bridge has seen this run.
 *
 * Scoped to the process on purpose. This answers a live question — what is
 * attached, and what just detached — and persisting device names would write a
 * record of someone's hardware to disk for a panel only read while the app is
 * open. The empty state says as much rather than implying history was lost.
 */
export function RemoteDeviceRoster(): JSX.Element | null {
  const { t, i18n } = useAppTranslation();
  const [devices, setDevices] = useState<readonly RemoteDeviceEntry[]>([]);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void window.ezterminalDesktop?.listRemoteDevices().then(
        (next) => {
          if (alive) setDevices(next);
        },
        () => undefined,
      );
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (devices.length === 0) return null;

  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <section className="status-section" data-testid="remote-device-roster">
      <h2 className="status-section-title">{t('remote.pairedDevices')}</h2>
      <div className="remote-devices">
        {devices.map((device) => (
          <div className="remote-device" key={device.clientId} data-testid="remote-device">
            <Smartphone aria-hidden="true" className="remote-device-icon" />
            <span className="remote-device-name">{device.clientName}</span>
            <span
              className="remote-device-state"
              data-connected={device.connected ? 'true' : undefined}
            >
              {device.connected
                ? t('remote.deviceConnected')
                : t('remote.deviceLastSeen', { time: time.format(new Date(device.lastSeenAt)) })}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
