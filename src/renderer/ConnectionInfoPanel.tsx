import { useCallback, useEffect, useState } from 'react';

/**
 * Mobile pairing panel (M4): shows the LAN URL(s) + auth token a phone needs
 * to connect to this desktop's remote-control bridge, plus a rotate action.
 * Reuses the `status-drawer`/`status-section`/`btn-split` styles StatusPanel
 * already defines in index.css rather than adding new CSS — same overlay
 * shape, different content.
 */
export function ConnectionInfoPanel(): JSX.Element {
  const [urls, setUrls] = useState<readonly string[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [justRotated, setJustRotated] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.ezterminal.getRemoteConnectionInfo().then((info) => {
      if (alive) setUrls(info.urls);
    });
    void window.ezterminal.getRemoteToken().then((t) => {
      if (alive) setToken(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleRotate = useCallback(() => {
    void window.ezterminal.rotateRemoteToken().then((t) => {
      setToken(t);
      setJustRotated(true);
    });
  }, []);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedText(text);
      setTimeout(() => setCopiedText((current) => (current === text ? null : current)), 1500);
    });
  }, []);

  const loading = urls === null || token === null;

  return (
    <div className="status-drawer" data-testid="connection-info-panel">
      <section className="status-section">
        <h2 className="status-section-title">Mobile Pairing</h2>
        {loading ? (
          <div className="status-loading">Loading…</div>
        ) : urls.length === 0 ? (
          <div className="status-loading">No LAN network detected.</div>
        ) : (
          <>
            {urls.map((url) => (
              <div key={url} className="status-metric" data-testid="connection-url">
                {url}{' '}
                <button className="btn btn-split" onClick={() => handleCopy(url)}>
                  {copiedText === url ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
            <div className="status-metric" data-testid="connection-token">
              Token: <code>{token}</code>{' '}
              <button className="btn btn-split" onClick={() => handleCopy(token)}>
                {copiedText === token ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              className="btn btn-split"
              onClick={handleRotate}
              title="Mint a new token — existing connections stay connected, only new connections need it"
              data-testid="btn-rotate-token"
            >
              Rotate token
            </button>
            {justRotated && (
              <div className="status-loading">
                New token applies to new connections only — already-connected devices keep working.
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
