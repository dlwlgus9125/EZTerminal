import { useState } from 'react';
import { useAppTranslation } from '../../src/renderer/i18n';

export interface SavedConnection {
  readonly url: string;
  readonly token: string;
}

// ConnectScreen — the mobile-only entry screen (no desktop analogue): host URL
// + token entry, pre-filled from the last successful connection (App.tsx
// persists it in Android secure storage). Token pairing itself (viewing/rotating the
// desktop's token) is the desktop pairing panel's job (M4) — this screen only
// consumes whatever the user types or scans in.
export function ConnectScreen({
  saved,
  connecting,
  failed,
  storageWarning,
  onConnect,
}: {
  saved: SavedConnection | null;
  connecting: boolean;
  failed: boolean;
  storageWarning?: string | null;
  onConnect: (url: string, token: string) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [url, setUrl] = useState(saved?.url ?? '');
  const [token, setToken] = useState(saved?.token ?? '');

  const submit = (): void => {
    const trimmedUrl = url.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl || !trimmedToken) return;
    onConnect(trimmedUrl, trimmedToken);
  };

  return (
    <div className="connect-screen" data-testid="connect-screen">
      <div className="connect-card">
        <h1 className="connect-title">{t('mobile.connect.title')}</h1>
        <label className="connect-field">
          <span>{t('mobile.connect.serverUrl')}</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://192.168.1.10:7420"
            data-testid="connect-url"
          />
        </label>
        <label className="connect-field">
          <span>{t('mobile.connect.token')}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="connect-token"
          />
        </label>
        {failed && (
          <p className="connect-error" data-testid="connect-error">
            {t('mobile.connect.failed')}
          </p>
        )}
        {storageWarning && (
          <p className="connect-error" role="status" data-testid="credential-storage-warning">
            {storageWarning}
          </p>
        )}
        <button
          className="btn btn-run connect-submit"
          onClick={submit}
          disabled={connecting}
          data-testid="connect-submit"
        >
          {connecting ? t('mobile.connect.connecting') : t('mobile.connect.connect')}
        </button>
      </div>
    </div>
  );
}
