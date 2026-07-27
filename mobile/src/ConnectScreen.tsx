import { KeyRound, Link2, LockKeyhole, RadioTower, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';
import { Badge, Button, Field, Input, Status } from '../../src/renderer/ui';

export interface SavedConnection {
  readonly url: string;
  readonly token: string;
}

// ConnectScreen — the mobile-only entry screen (no desktop analogue): host URL
// + token entry, pre-filled from the last successful connection (App.tsx
// persists it in Android secure storage). Token pairing itself (viewing/rotating the
// desktop's token) is the desktop pairing panel's job (M4) — this screen only
// accepts manually entered credentials only.
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
  const insecureWs = /^ws:\/\//i.test(url.trim());

  const submit = (): void => {
    const trimmedUrl = url.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl || !trimmedToken) return;
    onConnect(trimmedUrl, trimmedToken);
  };

  return (
    <main className="connect-screen" data-testid="connect-screen">
      <div className="connect-signal" aria-hidden="true">
        <span>EZT://PAIR</span><span>MANUAL SECURE LINK</span>
      </div>
      <div className="connect-card">
        <header className="connect-brand">
          <span className="connect-brand__mark" aria-hidden="true"><RadioTower /></span>
          <div>
            <p className="connect-brand__eyebrow">{t('mobile.connect.eyebrow')}</p>
            <h1 className="connect-title">{t('mobile.connect.title')}</h1>
            <p className="connect-description">{t('mobile.connect.description')}</p>
          </div>
        </header>

        {saved && (
          <div className="connect-saved" data-testid="connect-saved-summary">
            <ShieldCheck aria-hidden="true" />
            <div>
              <Badge variant="success" size="sm">{t('mobile.connect.savedLabel')}</Badge>
              <strong title={saved.url}>{saved.url}</strong>
              <span>{t('mobile.connect.savedDescription')}</span>
            </div>
          </div>
        )}

        <form
          className="connect-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="connect-form__heading">
            <LockKeyhole aria-hidden="true" />
            <div>
              <h2>{t('mobile.connect.manualTitle')}</h2>
              <p>{t('mobile.connect.manualDescription')}</p>
            </div>
          </div>

          {insecureWs && (
            <p className="connect-security-warning" role="note" data-testid="connect-ws-warning">
              {t('mobile.connect.trustedNetworkWarning')}
            </p>
          )}

          <Field
            className="connect-field"
            label={t('mobile.connect.serverUrl')}
            required
          >
            <div className="connect-input-shell">
              <Link2 aria-hidden="true" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="ws://192.168.1.10:7420"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                data-testid="connect-url"
              />
            </div>
          </Field>
          <Field
            className="connect-field"
            label={t('mobile.connect.token')}
            description={t('mobile.connect.tokenDescription')}
            required
          >
            <div className="connect-input-shell">
              <KeyRound aria-hidden="true" />
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoCapitalize="none"
                autoComplete="current-password"
                data-testid="connect-token"
              />
            </div>
          </Field>

          {protocolIncompatible ? (
            <div className="connect-error" role="alert" data-testid="connect-protocol-incompatible">
              <strong>{t('mobile.connect.protocolIncompatibleLabel')}</strong>{' '}
              {t('mobile.connect.protocolIncompatibleDetail')}
            </div>
          ) : failed && (
            <div className="connect-error" role="alert" data-testid="connect-error">
              {t('mobile.connect.failed')}
            </div>
          )}
          {storageWarning && (
            <div className="connect-storage-warning" role="status" data-testid="credential-storage-warning">
              {storageWarning}
            </div>
          )}

          {connecting && (
            <Status variant="loading" live="polite">{t('mobile.connect.connecting')}</Status>
          )}
          <Button
            type="submit"
            className="connect-submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={connecting}
            loadingLabel={t('mobile.connect.connecting')}
            data-testid="connect-submit"
          >
            {t('mobile.connect.connect')}
          </Button>
        </form>
      </div>
    </main>
  );
}
