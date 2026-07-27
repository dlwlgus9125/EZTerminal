import { Monitor, Smartphone } from 'lucide-react';

import type { RemoteDesktopHostStatus } from '../../shared/ipc';
import { useAppTranslation } from '../i18n';

export interface RemoteTopologyProps {
  readonly status: RemoteDesktopHostStatus | null;
}

/**
 * The remote link drawn as a link.
 *
 * The same facts — this machine, the transport, the round trip, the connected
 * device — are already available as label/value rows further down the panel.
 * Drawing them spatially is what makes "who is attached to me, over what" a
 * glance instead of a read.
 *
 * The transport label says `ws://`, not the handoff's `wss 암호화`. Remote
 * access is plaintext inside a trusted VPN — that is the whole reason the amber
 * strip below exists — so drawing an encryption badge here would contradict the
 * warning three elements away.
 */
export function RemoteTopology({ status }: RemoteTopologyProps): JSX.Element {
  const { t } = useAppTranslation();
  const peer = status?.controllerName ?? null;
  const rtt = status?.roundTripTimeMs ?? null;

  return (
    <section className="remote-topology" data-testid="remote-topology">
      <div className="remote-topology-row">
        <div className="remote-topology-node">
          <span className="remote-topology-glyph remote-topology-glyph--host" aria-hidden="true">
            <Monitor />
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
            <Smartphone />
          </span>
          <b>{peer ?? t('remote.topologyNoDevice')}</b>
          <span className="remote-topology-meta">
            {peer
              ? t(`remote.pcControlState.${status!.state}` as 'remote.pcControlState.idle')
              : t('remote.topologyWaiting')}
          </span>
        </div>
      </div>
    </section>
  );
}
