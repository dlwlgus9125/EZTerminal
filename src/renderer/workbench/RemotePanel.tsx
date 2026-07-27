import { QrCode } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { PairingCode } from '../../shared/pairing';
import { ConnectionInfoPanel } from '../ConnectionInfoPanel';
import { PairingQrDialog } from '../PairingQrDialog';
import { SshForwardSettings } from '../SshForwardSettings';
import { RemoteDesktopStatusCard, useRemoteDesktopHostStatus } from '../RemoteDesktopStatusCard';
import { useAppTranslation } from '../i18n';
import { RemoteDeviceRoster } from './RemoteDeviceRoster';
import { RemoteTopology } from './RemoteTopology';

/** Pairing/remote access and SSH tunnels share one workbench destination. */
export function RemotePanel(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useRemoteDesktopHostStatus();
  const [qrOpen, setQrOpen] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  const [endpoint, setEndpoint] = useState('');

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return undefined;
    void desktop.getPairingCode().then(setCode).catch(() => undefined);
    const offChanged = desktop.onPairingCodeChanged(setCode);
    const offRedeemed = desktop.onPairingRedeemed(() => setRedeemed(true));
    return () => {
      offChanged();
      offRedeemed();
    };
  }, []);

  // The first advertised URL is the one the pairing QR should carry: it is
  // what the desktop itself tells a user to type.
  useEffect(() => {
    void window.ezterminal.getRemoteConnectionInfo()
      .then((info) => setEndpoint(info.urls[0] ?? ''))
      .catch(() => undefined);
  }, [qrOpen]);

  const issue = useCallback((): void => {
    setRedeemed(false);
    void window.ezterminalDesktop?.issuePairingCode().then(setCode).catch(() => undefined);
  }, []);

  return (
    <div className="remote-panel" data-testid="remote-panel">
      {/* The link, drawn as a link, before the same facts appear as rows. */}
      <RemoteTopology status={status} />
      <div className="remote-panel__grid">
        <button
          type="button"
          className="remote-pairing-card"
          onClick={() => {
            setQrOpen(true);
            if (!code) issue();
          }}
          data-testid="open-pairing-qr"
        >
          <QrCode aria-hidden="true" />
          <b>{t('pairing.card')}</b>
          <span>{t('pairing.cardHint')}</span>
        </button>
        <RemoteDesktopStatusCard />
      </div>
      <ConnectionInfoPanel />
      <RemoteDeviceRoster />
      <SshForwardSettings />
      <PairingQrDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        endpoint={endpoint}
        code={code}
        redeemed={redeemed}
        onIssue={issue}
      />
    </div>
  );
}
