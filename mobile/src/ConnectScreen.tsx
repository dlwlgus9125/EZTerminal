import { Eye, EyeOff, KeyRound, Link2, QrCode, Server, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';
import { MOBILE_BUILD_INFO } from './build-info';
import { formatEndpointHost } from './mobile-endpoint';
import { MobileSignalMark } from './MobileSignalMark';
import { PairingScanner } from './PairingScanner';

export interface SavedConnection {
  readonly url: string;
  readonly token: string;
  readonly lastConnectedAt?: number;
}

/** Handoff §1: the four boot-log lines appear one at a time while linking. */
const BOOT_LOG_STEP_MS = 340;
const BOOT_LOG_STEPS = 4;

/** Coarse by design — the card says roughly when, not exactly. */
function relativeLastConnected(at: number, formatter: Intl.RelativeTimeFormat): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return formatter.format(0, 'minute');
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.floor(hours / 24), 'day');
}

// ConnectScreen — the mobile-only entry screen (no desktop analogue): host URL
// + token entry, pre-filled from the last successful connection (App.tsx
// persists it in Android secure storage). Token pairing itself (viewing/rotating the
// desktop's token) is the desktop pairing panel's job (M4) — this screen only
// accepts manually entered credentials only.
//
// The commercial pass changes only what this screen LOOKS like and how the
// wait is narrated. Reconnect/backoff/watchdog behaviour lives entirely in
// App.tsx + the transport and is untouched: `connecting` is an input here, and
// the boot log is a progressive disclosure of that single boolean, not a
// second source of truth about the handshake.
export function ConnectScreen({
  saved,
  connecting,
  failed,
  protocolIncompatible = false,
  storageWarning,
  onConnect,
}: {
  saved: SavedConnection | null;
  connecting: boolean;
  failed: boolean;
  protocolIncompatible?: boolean;
  storageWarning?: string | null;
  onConnect: (url: string, token: string) => void;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(i18n.resolvedLanguage ?? i18n.language, { numeric: 'auto' }),
    [i18n.resolvedLanguage, i18n.language],
  );
  const [url, setUrl] = useState(saved?.url ?? '');
  const [token, setToken] = useState(saved?.token ?? '');
  const [revealToken, setRevealToken] = useState(false);
  const [bootStep, setBootStep] = useState(0);
  const [scanning, setScanning] = useState(false);
  const scanTriggerRef = useRef<HTMLButtonElement | null>(null);
  const trimmedUrl = url.trim();
  const secureWs = /^wss:\/\//i.test(trimmedUrl);

  useEffect(() => {
    if (!connecting) {
      setBootStep(0);
      return;
    }
    const timers = Array.from({ length: BOOT_LOG_STEPS }, (_, index) =>
      setTimeout(() => setBootStep(index + 1), BOOT_LOG_STEP_MS * (index + 1)));
    return () => timers.forEach(clearTimeout);
  }, [connecting]);

  const submit = (nextUrl: string, nextToken: string): void => {
    const finalUrl = nextUrl.trim();
    const finalToken = nextToken.trim();
    if (!finalUrl || !finalToken) return;
    onConnect(finalUrl, finalToken);
  };

  return (
    <main className="connect-screen" data-testid="connect-screen">
      <form
        className="mob-connect"
        onSubmit={(event) => {
          event.preventDefault();
          submit(url, token);
        }}
      >
        <header className="mob-connect__brand">
          <MobileSignalMark size="lg" />
          <span className="mob-connect__wordmark">EZTerminal</span>
          <p className="mob-connect__eyebrow">{t('mobile.connect.consoleEyebrow')}</p>
        </header>

        {saved && (
          <div className="mob-connect__saved" data-testid="connect-saved-summary">
            <ShieldCheck aria-hidden="true" />
            <span className="mob-connect__saved-copy">
              <span className="mob-connect__saved-host">{formatEndpointHost(saved.url)}</span>
              {/* Host and address are the same field: the desktop only ever
                  advertises ws://<ipv4>:<port>, so the card shows when this
                  link last worked rather than repeating the host as an "IP". */}
              <span className="mob-connect__saved-meta" title={saved.url}>
                {saved.lastConnectedAt === undefined
                  ? t('mobile.connect.savedLabel')
                  : t('mobile.connect.lastConnected', {
                    value: relativeLastConnected(saved.lastConnectedAt, relativeTime),
                  })}
              </span>
            </span>
            <button
              type="button"
              className="mob-connect__saved-go"
              disabled={connecting}
              onClick={() => submit(saved.url, saved.token)}
              data-testid="connect-saved-go"
            >
              {t('mobile.connect.connectNow')}
            </button>
          </div>
        )}

        <p className="mob-connect__divider">{t('mobile.connect.orNew')}</p>

        <button
          ref={scanTriggerRef}
          type="button"
          className="mob-connect__scan"
          disabled={connecting}
          onClick={() => setScanning(true)}
          data-testid="connect-scan-qr"
        >
          <QrCode aria-hidden="true" />
          {t('pairing.scan')}
        </button>

        <div className="mob-connect__fields">
          <label className="mob-connect__label">
            {t('mobile.connect.serverUrl')}
            <span className="mob-connect__input">
              <Server aria-hidden="true" />
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="ws://192.168.1.10:7420"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                data-testid="connect-url"
              />
            </span>
          </label>
          <label className="mob-connect__label">
            {t('mobile.connect.token')}
            <span className="mob-connect__input mob-connect__input--token">
              <KeyRound aria-hidden="true" />
              <input
                type={revealToken ? 'text' : 'password'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoCapitalize="none"
                autoComplete="current-password"
                data-testid="connect-token"
              />
              <button
                type="button"
                className="mob-connect__reveal"
                aria-pressed={revealToken}
                aria-label={t('mobile.connect.revealToken')}
                onClick={() => setRevealToken((current) => !current)}
              >
                {revealToken ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </label>
        </div>

        {/* Always shown, per the handoff. The rule this states — reach the
            desktop only over a trusted VPN — is true of every EZTerminal link,
            not just the plaintext ones, and hiding it behind `wss://` taught
            the opposite. `wss` gets the softer wording instead of silence. */}
        <p
          className="mob-connect__warning"
          data-secure={secureWs ? 'true' : undefined}
          role="note"
          data-testid="connect-ws-warning"
        >
          <ShieldAlert aria-hidden="true" />
          <span>
            {secureWs
              ? t('mobile.connect.trustedNetworkNote')
              : t('mobile.connect.trustedNetworkWarning')}
          </span>
        </p>

        {protocolIncompatible ? (
          <div className="mob-connect__error" role="alert" data-testid="connect-protocol-incompatible">
            <strong>{t('mobile.connect.protocolIncompatibleLabel')}</strong>{' '}
            {t('mobile.connect.protocolIncompatibleDetail')}
          </div>
        ) : failed && (
          <div className="mob-connect__error" role="alert" data-testid="connect-error">
            {t('mobile.connect.failed')}
          </div>
        )}
        {storageWarning && (
          <div className="mob-connect__notice" role="status" data-testid="credential-storage-warning">
            {storageWarning}
          </div>
        )}

        {connecting && (
          <div className="mob-connect__log" role="status" aria-live="polite" data-testid="connect-boot-log">
            {bootStep >= 1 && <div>&gt; open {formatEndpointHost(trimmedUrl) || '—'} …… <b>OK</b></div>}
            {bootStep >= 2 && <div>&gt; auth token …… <b>{t('mobile.connect.bootAccepted')}</b></div>}
            {bootStep >= 3 && <div>&gt; protocol v{MOBILE_BUILD_INFO.protocolVersion} …… <b>OK</b></div>}
            {bootStep >= 4 && <div>&gt; {t('mobile.connect.bootLinkUp')}</div>}
          </div>
        )}

        <button
          type="submit"
          className="mob-connect__cta"
          disabled={connecting}
          data-testid="connect-submit"
        >
          {connecting ? (
            <>
              <span className="mob-spinner" aria-hidden="true" />
              <span>{t('mobile.connect.linking')}</span>
            </>
          ) : (
            <>
              <Link2 aria-hidden="true" />
              <span>{t('mobile.connect.establishLink')}</span>
            </>
          )}
        </button>

        <p className="mob-signal mob-connect__footer" aria-hidden="true">
          <span>EZT://PAIR</span><span data-build-stamp>v{MOBILE_BUILD_INFO.appVersion}</span>
        </p>
      </form>
      {scanning && (
        <PairingScanner
          returnFocusRef={scanTriggerRef}
          onClose={() => setScanning(false)}
          onDetected={({ endpoint, code }) => {
            setScanning(false);
            // Fill the fields as well as connecting: if the code has already
            // expired the user is left looking at what was scanned rather than
            // an empty form and no explanation.
            setUrl(endpoint);
            setToken(code);
            submit(endpoint, code);
          }}
        />
      )}
    </main>
  );
}
