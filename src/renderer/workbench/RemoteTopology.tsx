
import type { RemoteDesktopHostStatus } from '../../shared/ipc';
import { rendererCapabilities, type CapabilityAccess } from '../capability-access';
import { useAppTranslation } from '../i18n';
import { useElapsed, useRemoteDesktopDisconnect } from '../RemoteDesktopStatusCard';
import { Button, Glyph } from '../ui';

export interface RemoteTopologyProps {
  readonly status: RemoteDesktopHostStatus | null;
  readonly capabilities?: CapabilityAccess;
  /** Fixed clock for deterministic product handoff/reference rendering. */
  readonly currentTime?: number;
}

/**
 * The remote link drawn as a link.
 *
 * This machine, the transport, the round trip and the connected device are drawn
 * spatially, so "who is attached to me, over what" is a glance instead of a read.
 * While a device is in control, a footer adds how long and how well, and the
 * disconnect, as the handoff's topology card does.
 *
 * The transport label says `ws://`, not the handoff's `wss 암호화`. Remote
 * access is plaintext inside a trusted VPN — that is the whole reason the amber
 * strip below exists — so drawing an encryption badge here would contradict the
 * warning three elements away.
 */
export function RemoteTopology({
  status,
  capabilities = rendererCapabilities,
  currentTime,
}: RemoteTopologyProps): JSX.Element {
  const { t } = useAppTranslation();
  const peer = status?.controllerName ?? null;
  const rtt = status?.roundTripTimeMs ?? null;
  const elapsed = useElapsed(status?.connectedAt ?? null, currentTime);
  const { disconnecting, disconnect } = useRemoteDesktopDisconnect(capabilities);

  return (
    <section className="remote-topology" data-testid="remote-topology">
      <div className="remote-topology-row">
        <div className="remote-topology-node">
          <span className="remote-topology-glyph remote-topology-glyph--host" aria-hidden="true">
            <Glyph name="pc" size={22} />
          </span>
          <b>{t('remote.topologyThisPc')}</b>
          <span className="remote-topology-meta">
            {status?.localAddress ?? t('remote.topologyAddressUnknown')}
          </span>
        </div>

        <div className="remote-topology-link" data-connected={peer ? 'true' : undefined}>
          <i className="remote-topology-wire" aria-hidden="true" />
          <span className="remote-topology-wire-label">ws://</span>
          {rtt !== null && <span className="remote-topology-wire-rtt">{`${rtt} ms`}</span>}
        </div>

        <div className="remote-topology-node" data-idle={peer ? undefined : 'true'}>
          <span className="remote-topology-glyph remote-topology-glyph--peer" aria-hidden="true">
            <Glyph name="phone" size={22} />
          </span>
          <b>{peer ?? t('remote.topologyNoDevice')}</b>
          <span className="remote-topology-meta">
            {peer
              ? t(`remote.pcControlState.${status!.state}` as 'remote.pcControlState.idle')
              : t('remote.topologyWaiting')}
          </span>
        </div>
      </div>

      {peer && status && (
        <div className="remote-topology-footer" data-testid="remote-control-details">
          <dl className="remote-topology-stats">
            <div>
              <dt>{t('remote.pcControlDuration')}</dt>
              <dd>{elapsed}</dd>
            </div>
            <div>
              <dt>{t('remote.pcControlRate')}</dt>
              <dd>
                {status.framesPerSecond === null ? '—' : Math.round(status.framesPerSecond)}
                {' / '}
                {rtt === null ? '—' : `${Math.round(rtt)} ms`}
              </dd>
            </div>
            <div>
              <dt>{t('remote.pcControlQuality')}</dt>
              <dd>
                {status.qualityTier ?? '—'}
                {' / '}
                {status.bitrateKbps === null ? '—' : `${Math.round(status.bitrateKbps)} kbps`}
              </dd>
            </div>
          </dl>
          <Button
            size="sm"
            variant="danger"
            leadingIcon={<Glyph name="power" size={16} />}
            onClick={disconnect}
            disabled={disconnecting}
            data-testid="remote-desktop-disconnect"
          >
            {disconnecting ? t('remote.stopping') : t('remote.pcControlDisconnect')}
          </Button>
        </div>
      )}
    </section>
  );
}
