import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Device } from '@capacitor/device';

import { ConnectScreen, type SavedConnection } from './ConnectScreen';
import { ConnectionCredentialStore, type StoredConnection } from './connection-credential-store';
import {
  classifyConnectionHealth,
  type ConnectionHealthSnapshot,
} from './transport/connection-health';
import { WsEzTerminalTransport, type RemoteConnectionState } from './transport/ws-ezterminal';
import { useAppTranslation } from '../../src/renderer/i18n';

const MobileWorkspace = lazy(async () => ({
  default: (await import('./MobileWorkspace')).MobileWorkspace,
}));

// The transport retries indefinitely with backoff AND self-heals a stuck/half-
// open attempt via its own auth watchdog (by design — a flappy link, or a host
// that isn't reachable yet, should recover on its own). This UI timeout only
// swaps the "Connecting…" label for a "Connection failed — check URL/token"
// hint after a while; it deliberately does NOT tear the transport down, so once
// the host becomes reachable the transport authenticates and App flips to
// `authed` with no manual reconnect. (Earlier this called `disconnect()`, which
// permanently killed the retry loop — a fresh Connect tap / reload was then the
// only way to recover.)
const CONNECT_TIMEOUT_MS = 6000;

async function createMobileIdentity(): Promise<Pick<StoredConnection, 'clientId' | 'clientName'>> {
  let clientName = 'Android device';
  try {
    const info = await Device.getInfo();
    clientName = (info.name || info.model || clientName).trim().slice(0, 80) || clientName;
  } catch {
    // The install-scoped UUID remains sufficient when model lookup fails.
  }
  return { clientId: crypto.randomUUID(), clientName };
}

const CREDENTIAL_WARNING_KEY = {
  'Secure credential storage is available only in the Android app. Credentials will not be saved here.':
    'mobile.connect.secureAndroidOnly',
  'Android secure credential storage is unavailable.': 'mobile.connect.secureUnavailable',
  'Stored connection credentials are invalid or unavailable.': 'mobile.connect.storedCredentialsInvalid',
  'Plaintext credential cleanup is pending; enter the connection again.': 'mobile.connect.cleanupPending',
  'Existing credentials could not be migrated to Android secure storage.': 'mobile.connect.migrationFailed',
  'The old plaintext connection record is invalid and was not used.': 'mobile.connect.oldPlaintextInvalid',
  'Plaintext credential cleanup could not be verified.': 'mobile.connect.cleanupUnverified',
} as const;

// App — the mobile shell's top-level state machine: disconnected (show
// ConnectScreen) -> connecting -> connected (MobileWorkspace, M5's tabbed
// authed shell). Replaces the desktop's dockview host (App.tsx there) —
// nothing here is dockview-specific, so this file has no desktop analogue.
export function App(): JSX.Element {
  const { t } = useAppTranslation();
  const [transport, setTransport] = useState<WsEzTerminalTransport | null>(null);
  const [authed, setAuthed] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<RemoteConnectionState>('disconnected');
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealthSnapshot | null>(null);
  const [connectionClock, setConnectionClock] = useState(() => Date.now());
  const [diagnosticCopyState, setDiagnosticCopyState] = useState<'copied' | 'failed' | null>(null);
  const [connectFailed, setConnectFailed] = useState(false);
  const [sessionDead, setSessionDead] = useState(false);
  const [savedConnection, setSavedConnection] = useState<SavedConnection | null>(null);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [credentialWarning, setCredentialWarning] = useState<string | null>(null);
  const [currentConnection, setCurrentConnection] = useState<SavedConnection | null>(null);
  const transportRef = useRef<WsEzTerminalTransport | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCredentialRef = useRef<StoredConnection | null>(null);
  const clientIdentityRef = useRef<Pick<StoredConnection, 'clientId' | 'clientName'> | null>(null);
  const credentialStoreRef = useRef<ConnectionCredentialStore | null>(null);
  if (credentialStoreRef.current === null) credentialStoreRef.current = new ConnectionCredentialStore();

  useEffect(() => {
    let alive = true;
    void credentialStoreRef.current!.load().then((result) => {
      if (!alive) return;
      setSavedConnection(result.connection);
      if (result.connection) {
        clientIdentityRef.current = {
          clientId: result.connection.clientId,
          clientName: result.connection.clientName,
        };
      }
      setCredentialWarning(result.warning);
      setCredentialsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const clearConnectTimeout = useCallback((): void => {
    if (connectTimeoutRef.current !== null) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback(
    (url: string, token: string) => {
      void (async () => {
      transportRef.current?.disconnect();
      clearConnectTimeout();
      setConnectFailed(false);
      setHasConnected(false);
      setConnectionState('connecting');
      setConnectionHealth(null);
      setDiagnosticCopyState(null);
      setSessionDead(false);
      setCredentialWarning(null);

      const identity = clientIdentityRef.current ?? await createMobileIdentity();
      clientIdentityRef.current = identity;
      const connection: StoredConnection = { url, token, ...identity };
      pendingCredentialRef.current = connection;
      setCurrentConnection(connection);

      const t = new WsEzTerminalTransport({
        url,
        token,
        clientIdentity: { ...identity, platform: 'android' },
      });
      transportRef.current = t;
      // `window.ezterminal` is declared `readonly` in the shared type (see
      // src/shared/window.d.ts) because on desktop it's injected once by
      // Electron's contextBridge, invisible to the type checker — a plain JS
      // assignment never happens there. Mobile has no contextBridge; this is
      // the one place that plays that same role, so the readonly is bypassed
      // here deliberately (not a hole anywhere else in the mobile codebase).
      (window as unknown as { ezterminal: WsEzTerminalTransport }).ezterminal = t;
      setTransport(t);

      connectTimeoutRef.current = setTimeout(() => {
        connectTimeoutRef.current = null;
        // Surface a hint, but leave the transport retrying — it auto-connects
        // once the host is reachable (see CONNECT_TIMEOUT_MS note above).
        if (!t.isAuthed) setConnectFailed(true);
      }, CONNECT_TIMEOUT_MS);
      })();
    },
    [clearConnectTimeout],
  );

  useEffect(() => {
    if (!transport) return;
    const unsubAuth = transport.onAuthChange((isAuthed) => {
      setAuthed(isAuthed);
      if (isAuthed) {
        setHasConnected(true);
        clearConnectTimeout();
        setConnectFailed(false); // a later auto-reconnect clears the stale hint
        const pending = pendingCredentialRef.current;
        pendingCredentialRef.current = null;
        if (pending) {
          void credentialStoreRef.current!.save(pending).then(
            () => {
              setSavedConnection(pending);
              setCredentialWarning(null);
            },
            () => setCredentialWarning(t('mobile.connect.credentialsNotSaved')),
          );
        }
      }
    });
    const unsubConnectionState = transport.onConnectionStateChange((state) => {
      setConnectionState(state);
      if (state === 'auth-rejected' && !hasConnected) setConnectFailed(true);
    });
    const unsubConnectionHealth = transport.onConnectionHealthChange((snapshot) => {
      setConnectionHealth(snapshot);
      setConnectionClock(Date.now());
    });
    const unsubDead = transport.onSessionDead(() => setSessionDead(true));
    return () => {
      unsubAuth();
      unsubConnectionState();
      unsubConnectionHealth();
      unsubDead();
    };
  }, [transport, clearConnectTimeout, hasConnected, t]);

  useEffect(() => {
    if (authed || !hasConnected) return;
    (document.activeElement as HTMLElement | null)?.blur();
  }, [authed, hasConnected]);

  useEffect(() => {
    if (authed || !hasConnected) return;
    const timer = setInterval(() => setConnectionClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [authed, hasConnected]);

  const disconnect = useCallback(() => {
    clearConnectTimeout();
    transportRef.current?.disconnect();
    transportRef.current = null;
    setTransport(null);
    setAuthed(false);
    setHasConnected(false);
    setConnectionState('disconnected');
    setConnectionHealth(null);
    setDiagnosticCopyState(null);
  }, [clearConnectTimeout]);

  const retryConnection = useCallback((): void => {
    setDiagnosticCopyState(null);
    transportRef.current?.retryNow();
  }, []);

  const copyConnectionDiagnostics = useCallback(async (): Promise<void> => {
    const current = transportRef.current;
    if (!current || !navigator.clipboard?.writeText) {
      setDiagnosticCopyState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(current.getConnectionDiagnostics());
      setDiagnosticCopyState('copied');
    } catch {
      setDiagnosticCopyState('failed');
    }
  }, []);

  const localizedCredentialWarning = credentialWarning
    ? t(CREDENTIAL_WARNING_KEY[credentialWarning as keyof typeof CREDENTIAL_WARNING_KEY]
      ?? 'mobile.connect.credentialWarning')
    : null;

  if (!credentialsLoaded && !transport) {
    return (
      <div className="connect-screen" data-testid="credential-loading">
        <div className="connect-card" role="status">{t('mobile.connect.loadingCredentials')}</div>
      </div>
    );
  }

  if (!transport || !hasConnected) {
    return (
      <ConnectScreen
        saved={savedConnection}
        connecting={
          transport !== null
          && !authed
          && !connectFailed
          && connectionState !== 'auth-rejected'
          && connectionState !== 'protocol-incompatible'
        }
        failed={connectFailed}
        protocolIncompatible={connectionState === 'protocol-incompatible'}
        storageWarning={localizedCredentialWarning}
        onConnect={connect}
      />
    );
  }

  if (sessionDead) {
    return (
      <div className="mobile-error-screen" data-testid="mobile-error-screen">
        <p>{t('mobile.connect.lost')}</p>
        <button type="button" className="btn btn-run" onClick={disconnect} data-testid="mobile-reconnect-btn">
          {t('mobile.connect.backToConnect')}
        </button>
      </div>
    );
  }

  const connectionVerdict = connectionHealth
    ? classifyConnectionHealth(connectionHealth, t, connectionClock)
    : null;
  const retrySeconds = connectionHealth?.nextRetryAt === null || connectionHealth?.nextRetryAt === undefined
    ? null
    : Math.max(0, Math.ceil((connectionHealth.nextRetryAt - connectionClock) / 1000));
  return (
    <div className="mobile-app-frame">
      <div className={authed ? 'mobile-workspace-shell' : 'mobile-workspace-shell mobile-workspace-shell--reconnecting'}>
        <Suspense
          fallback={<div className="status-loading mobile-workspace-loading" role="status">{t('common.loading')}</div>}
        >
          <MobileWorkspace
            transport={transport}
            connectionUrl={currentConnection?.url ?? savedConnection?.url ?? ''}
            onDisconnect={disconnect}
          />
        </Suspense>
      </div>
      {!authed && (
        <div className="mobile-reconnect-scrim" data-testid="mobile-reconnect-scrim">
          <div
            className={`mobile-reconnect-card mobile-reconnect-card--${connectionVerdict?.kind ?? 'reconnecting'}`}
            aria-labelledby="mobile-connection-health-title"
            aria-describedby="mobile-connection-health-detail"
          >
            <strong id="mobile-connection-health-title" role="status" aria-live="polite">
              {connectionVerdict?.label ?? t('mobile.connect.reconnecting')}
            </strong>
            <span id="mobile-connection-health-detail">
              {connectionVerdict?.detail ?? t('mobile.connect.retained')}
            </span>
            {connectionVerdict?.hint && <span>{connectionVerdict.hint}</span>}
            {retrySeconds !== null && (
              <span aria-hidden="true" data-testid="mobile-retry-countdown">
                {t('mobile.connect.retryIn', { seconds: retrySeconds })}
              </span>
            )}
            <div className="mobile-reconnect-actions">
              {connectionVerdict?.kind !== 'protocol-incompatible' && (
                <button type="button" className="btn btn-run" onClick={retryConnection} data-testid="mobile-retry-now">
                  {t('mobile.connect.retryNow')}
                </button>
              )}
              <button type="button" className="btn" onClick={() => void copyConnectionDiagnostics()}>
                {t('mobile.connect.copyDiagnostics')}
              </button>
              {(connectionVerdict?.kind === 'auth-rejected'
                || connectionVerdict?.kind === 'protocol-incompatible') && (
                <button type="button" className="btn btn-cancel" onClick={disconnect}>
                  {connectionVerdict.kind === 'protocol-incompatible'
                    ? t('mobile.connect.backToConnect')
                    : t('mobile.connect.pairAgain')}
                </button>
              )}
            </div>
            {diagnosticCopyState && (
              <span role="status">
                {diagnosticCopyState === 'copied'
                  ? t('mobile.connect.diagnosticsCopied')
                  : t('mobile.connect.diagnosticsCopyFailed')}
              </span>
            )}
          </div>
        </div>
      )}
      {localizedCredentialWarning && (
        <div className="credential-warning" role="status" data-testid="credential-warning">
          {localizedCredentialWarning}
        </div>
      )}
    </div>
  );
}
