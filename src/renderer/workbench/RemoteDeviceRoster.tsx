import { Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { EzTerminalDesktopApi, RemoteDeviceEntry } from '../../shared/ipc';
import { observationalIntervalMs, type UiResourceProfile } from '../../shared/resource-profile';
import { startAsyncPoll } from '../async-poller';
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
type RemoteDeviceAccess = Pick<EzTerminalDesktopApi, 'listRemoteDevices'>;
type RosterState =
  | { readonly kind: 'loading'; readonly devices: readonly RemoteDeviceEntry[] }
  | { readonly kind: 'ready'; readonly devices: readonly RemoteDeviceEntry[] }
  | { readonly kind: 'unavailable'; readonly devices: readonly RemoteDeviceEntry[] };

export function RemoteDeviceRoster({
  desktopApi = window.ezterminalDesktop,
  resourceProfile = 'balanced',
}: {
  readonly desktopApi?: RemoteDeviceAccess;
  readonly resourceProfile?: UiResourceProfile;
} = {}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [roster, setRoster] = useState<RosterState>({ kind: 'loading', devices: [] });
  const locale = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    let alive = true;
    if (!desktopApi) {
      setRoster({ kind: 'unavailable', devices: [] });
      return () => {
        alive = false;
      };
    }
    const read = async (): Promise<void> => {
      await desktopApi.listRemoteDevices().then(
        (next) => {
          if (alive) {
            setRoster({ kind: 'ready', devices: next });
          }
        },
        () => {
          if (alive) {
            setRoster((current) => ({ kind: 'unavailable', devices: current.devices }));
          }
        },
      );
    };
    const stopPoll = startAsyncPoll({
      task: read,
      intervalMs: () => observationalIntervalMs(POLL_MS, resourceProfile),
    });
    return () => {
      alive = false;
      stopPoll();
    };
  }, [desktopApi, resourceProfile]);

  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <section className="status-section" data-testid="remote-device-roster">
      <h2 className="status-section-title">{t('remote.pairedDevices')}</h2>
      {roster.kind === 'loading' ? (
        <p className="status-empty" role="status" data-testid="remote-device-loading">
          {t('common.loading')}
        </p>
      ) : roster.kind === 'unavailable' ? (
        <p className="status-empty" role="status" data-testid="remote-device-unavailable">
          {t('remote.deviceListUnavailable')}
        </p>
      ) : roster.devices.length === 0 ? (
        <p className="status-empty" data-testid="remote-device-empty">
          {t('remote.topologyNoDevice')}
        </p>
      ) : (
        <div className="remote-devices">
          {roster.devices.map((device) => (
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
      )}
    </section>
  );
}
