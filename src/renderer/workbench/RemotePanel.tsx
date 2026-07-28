import { QrCode } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { EzTerminalDesktopApi } from '../../shared/ipc';
import type { PairingCode } from '../../shared/pairing';
import { ConnectionInfoPanel } from '../ConnectionInfoPanel';
import { PairingQrDialog } from '../PairingQrDialog';
import { SshForwardSettings } from '../SshForwardSettings';
import { RemoteDesktopStatusCard, useRemoteDesktopHostStatus } from '../RemoteDesktopStatusCard';
import { rendererCapabilities, type CapabilityAccess } from '../capability-access';
import { useAppTranslation } from '../i18n';
import { RemoteDeviceRoster } from './RemoteDeviceRoster';
import { RemoteTopology } from './RemoteTopology';

export type RemotePanelDesktopApi = Pick<
  EzTerminalDesktopApi,
  | 'getPairingCode'
  | 'issuePairingCode'
  | 'listRemoteDevices'
  | 'onPairingCodeChanged'
  | 'onPairingRedeemed'
>;

/** Pairing/remote access and SSH tunnels share one workbench destination. */
export function RemotePanel({
  capabilities = rendererCapabilities,
  desktopApi = window.ezterminalDesktop,
  currentTime,
}: {
  readonly capabilities?: CapabilityAccess;
  readonly desktopApi?: RemotePanelDesktopApi;
  readonly currentTime?: number;
} = {}): JSX.Element {
  const { t } = useAppTranslation();
  const status = useRemoteDesktopHostStatus(capabilities);
  const [qrOpen, setQrOpen] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [listening, setListening] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueFailed, setIssueFailed] = useState(false);
  const issueGeneration = useRef(0);
  const issuingRef = useRef(false);
  const listeningRef = useRef(false);
  const endpointRef = useRef('');
  const pairingInvalidatedRef = useRef(false);
  const pendingPairingStateRef = useRef<{
    readonly generation: number;
    readonly code: PairingCode | null;
    readonly redeemed: boolean;
  } | null>(null);

  const commitPendingPairingState = useCallback((): void => {
    const pending = pendingPairingStateRef.current;
    if (
      !pending
      || pending.generation !== issueGeneration.current
      || !listeningRef.current
      || endpointRef.current === ''
    ) return;
    pendingPairingStateRef.current = null;
    setCode(pending.code);
    setRedeemed(pending.redeemed);
  }, []);

  useEffect(() => {
    const desktop = desktopApi;
    if (!desktop) return undefined;
    let alive = true;
    const seedGeneration = issueGeneration.current;
    void desktop.getPairingCode().then(
      (next) => {
        // A level-triggered seed may resolve after a newer push or redemption.
        // Only the generation that initiated the read may commit its answer.
        if (
          alive
          && issueGeneration.current === seedGeneration
        ) {
          pendingPairingStateRef.current = {
            generation: seedGeneration,
            code: next,
            redeemed: false,
          };
          commitPendingPairingState();
        }
      },
      () => undefined,
    );
    const offChanged = desktop.onPairingCodeChanged((next) => {
      issueGeneration.current += 1;
      issuingRef.current = false;
      setIssuing(false);
      setIssueFailed(false);
      if (
        pairingInvalidatedRef.current
        && (!listeningRef.current || endpointRef.current === '')
      ) {
        pendingPairingStateRef.current = null;
        setCode(null);
        setRedeemed(false);
        return;
      }
      pendingPairingStateRef.current = {
        generation: issueGeneration.current,
        code: next,
        redeemed: false,
      };
      commitPendingPairingState();
    });
    const offRedeemed = desktop.onPairingRedeemed(() => {
      issueGeneration.current += 1;
      issuingRef.current = false;
      setIssuing(false);
      setIssueFailed(false);
      if (
        pairingInvalidatedRef.current
        && (!listeningRef.current || endpointRef.current === '')
      ) {
        pendingPairingStateRef.current = null;
        setCode(null);
        setRedeemed(false);
        return;
      }
      pendingPairingStateRef.current = {
        generation: issueGeneration.current,
        code: null,
        redeemed: true,
      };
      commitPendingPairingState();
    });
    return () => {
      alive = false;
      issueGeneration.current += 1;
      pendingPairingStateRef.current = null;
      issuingRef.current = false;
      offChanged();
      offRedeemed();
    };
  }, [commitPendingPairingState, desktopApi]);

  // The first advertised URL is the one the pairing QR should carry: it is
  // what the desktop itself tells a user to type. `listening` gates the card:
  // a code issued while the bridge is off is a code nothing can redeem, and
  // offering one would be a working-looking button that cannot work.
  useEffect(() => capabilities.remotePairing.observe({
    onConnectionInfo: (info) => {
      const next = info.urls.find((url) => url.trim() !== '')?.trim() ?? '';
      const lostReadyEndpoint = endpointRef.current !== '' && next === '';
      endpointRef.current = next;
      setEndpoint(next);
      if (next === '') {
        if (lostReadyEndpoint) {
          issueGeneration.current += 1;
          pairingInvalidatedRef.current = true;
          pendingPairingStateRef.current = null;
          issuingRef.current = false;
          setIssuing(false);
          setIssueFailed(false);
          setRedeemed(false);
          setCode(null);
          setQrOpen(false);
        }
      } else {
        if (listeningRef.current) pairingInvalidatedRef.current = false;
        commitPendingPairingState();
      }
    },
    onRuntime: (runtime) => {
      const next = runtime.state === 'running';
      listeningRef.current = next;
      setListening(next);
      if (!next) {
        issueGeneration.current += 1;
        pairingInvalidatedRef.current = true;
        pendingPairingStateRef.current = null;
        issuingRef.current = false;
        setIssuing(false);
        setIssueFailed(false);
        setRedeemed(false);
        setCode(null);
        setQrOpen(false);
      } else {
        if (endpointRef.current !== '') pairingInvalidatedRef.current = false;
        commitPendingPairingState();
      }
    },
    onSecurity: () => undefined,
    onToken: () => undefined,
    onError: () => {
      listeningRef.current = false;
      pairingInvalidatedRef.current = true;
      setListening(false);
      issueGeneration.current += 1;
      pendingPairingStateRef.current = null;
      issuingRef.current = false;
      setIssuing(false);
      setIssueFailed(false);
      setRedeemed(false);
      setCode(null);
      setQrOpen(false);
    },
  }), [capabilities, commitPendingPairingState]);

  const issue = useCallback((): void => {
    if (!listeningRef.current || endpointRef.current === '' || issuingRef.current) return;
    const generation = issueGeneration.current + 1;
    issueGeneration.current = generation;
    pendingPairingStateRef.current = null;
    issuingRef.current = true;
    setRedeemed(false);
    setIssueFailed(false);
    setIssuing(true);
    const issueCode = desktopApi?.issuePairingCode();
    if (!issueCode) {
      issuingRef.current = false;
      setIssuing(false);
      setIssueFailed(true);
      return;
    }
    void issueCode.then(
      (next) => {
        if (issueGeneration.current !== generation) return;
        issuingRef.current = false;
        setCode(next);
        setIssuing(false);
      },
      () => {
        if (issueGeneration.current !== generation) return;
        issuingRef.current = false;
        setIssuing(false);
        setIssueFailed(true);
      },
    );
  }, [desktopApi]);

  const pairingAvailable = listening && endpoint !== '';

  return (
    <div className="remote-panel" data-testid="remote-panel">
      {/* The link, drawn as a link, before the same facts appear as rows. */}
      <RemoteTopology status={status} />
      <div className="remote-panel__grid">
        <button
          type="button"
          className="remote-pairing-card"
          disabled={!pairingAvailable}
          title={pairingAvailable ? undefined : t('pairing.unavailable')}
          onClick={() => {
            if (!listeningRef.current || endpointRef.current === '') return;
            setQrOpen(true);
            if (!code) issue();
          }}
          data-testid="open-pairing-qr"
        >
          <QrCode aria-hidden="true" />
          <b>{t('pairing.card')}</b>
          <span>{pairingAvailable ? t('pairing.cardHint') : t('pairing.unavailable')}</span>
        </button>
        <RemoteDesktopStatusCard capabilities={capabilities} currentTime={currentTime} />
      </div>
      <ConnectionInfoPanel capabilities={capabilities} />
      <RemoteDeviceRoster desktopApi={desktopApi} />
      <SshForwardSettings capabilities={capabilities} />
      <PairingQrDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        endpoint={endpoint}
        code={code}
        redeemed={redeemed}
        issuing={issuing}
        issueFailed={issueFailed}
        onIssue={issue}
        currentTime={currentTime}
      />
    </div>
  );
}
