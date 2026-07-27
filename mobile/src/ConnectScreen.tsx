import { Eye, EyeOff, KeyRound, Link2, Server, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';
import { MOBILE_BUILD_INFO } from './build-info';
import { formatEndpointHost } from './mobile-endpoint';
import { MobileSignalMark } from './MobileSignalMark';

export interface SavedConnection {
  readonly url: string;
  readonly token: string;
}

/** Handoff §1: the four boot-log lines appear one at a time while linking. */
const BOOT_LOG_STEP_MS = 340;
const BOOT_LOG_STEPS = 4;

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
  const { t } = useAppTranslation();
  const [url, setUrl] = useState(saved?.url ?? '');
  const [token, setToken] = useState(saved?.token ?? '');
  const [revealToken, setRevealToken] = useState(false);
  const [bootStep, setBootStep] = useState(0);
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
              <span className="mob-connect__saved-meta" title={saved.url}>
                {t('mobile.connect.savedLabel')}
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

        {!secureWs && (
          <p className="mob-connect__warning" role="note" data-testid="connect-ws-warning">
            <ShieldAlert aria-hidden="true" />
            <span>{t('mobile.connect.trustedNetworkWarning')}</span>
          </p>
        )}

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
          <span>EZT://PAIR</span><span>v{MOBILE_BUILD_INFO.appVersion}</span>
        </p>
      </form>
    </main>
  );
}
