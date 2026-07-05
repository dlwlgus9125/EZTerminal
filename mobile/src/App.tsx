import { useCallback, useEffect, useRef, useState } from 'react';

import { ConnectScreen, type SavedConnection } from './ConnectScreen';
import { SessionSwitcher } from './SessionSwitcher';
import { MobileSessionView } from './MobileSessionView';
import { WsEzTerminalTransport } from './transport/ws-ezterminal';

const STORAGE_KEY = 'ezterminal-mobile-connection';

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

function loadSaved(): SavedConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as SavedConnection).url === 'string' &&
      typeof (parsed as SavedConnection).token === 'string'
    ) {
      return parsed as SavedConnection;
    }
    return null;
  } catch {
    return null; // corrupt/quota-denied localStorage — just skip the autofill
  }
}

function persistConnection(conn: SavedConnection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
  } catch {
    // best-effort — a private-browsing/quota failure only costs autofill next time
  }
}

// App — the mobile shell's top-level state machine: disconnected (show
// ConnectScreen) -> connecting -> connected (SessionSwitcher, then a selected
// MobileSessionView). Replaces the desktop's dockview host (App.tsx there) —
// nothing here is dockview-specific, so this file has no desktop analogue.
export function App(): JSX.Element {
  const [transport, setTransport] = useState<WsEzTerminalTransport | null>(null);
  const [authed, setAuthed] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const [sessionDead, setSessionDead] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const transportRef = useRef<WsEzTerminalTransport | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearConnectTimeout = useCallback((): void => {
    if (connectTimeoutRef.current !== null) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback(
    (url: string, token: string) => {
      transportRef.current?.disconnect();
      clearConnectTimeout();
      setConnectFailed(false);
      setSessionDead(false);
      setActiveSessionId(null);

      const t = new WsEzTerminalTransport({ url, token });
      transportRef.current = t;
      // `window.ezterminal` is declared `readonly` in the shared type (see
      // src/shared/window.d.ts) because on desktop it's injected once by
      // Electron's contextBridge, invisible to the type checker — a plain JS
      // assignment never happens there. Mobile has no contextBridge; this is
      // the one place that plays that same role, so the readonly is bypassed
      // here deliberately (not a hole anywhere else in the mobile codebase).
      (window as unknown as { ezterminal: WsEzTerminalTransport }).ezterminal = t;
      setTransport(t);
      persistConnection({ url, token });

      connectTimeoutRef.current = setTimeout(() => {
        connectTimeoutRef.current = null;
        // Surface a hint, but leave the transport retrying — it auto-connects
        // once the host is reachable (see CONNECT_TIMEOUT_MS note above).
        if (!t.isAuthed) setConnectFailed(true);
      }, CONNECT_TIMEOUT_MS);
    },
    [clearConnectTimeout],
  );

  useEffect(() => {
    if (!transport) return;
    const unsubAuth = transport.onAuthChange((isAuthed) => {
      setAuthed(isAuthed);
      if (isAuthed) {
        clearConnectTimeout();
        setConnectFailed(false); // a later auto-reconnect clears the stale hint
      }
    });
    const unsubDead = transport.onSessionDead(() => setSessionDead(true));
    return () => {
      unsubAuth();
      unsubDead();
    };
  }, [transport, clearConnectTimeout]);

  const disconnect = useCallback(() => {
    clearConnectTimeout();
    transportRef.current?.disconnect();
    transportRef.current = null;
    setTransport(null);
    setAuthed(false);
    setActiveSessionId(null);
  }, [clearConnectTimeout]);

  if (!transport || !authed) {
    return (
      <ConnectScreen
        saved={loadSaved()}
        connecting={transport !== null && !authed && !connectFailed}
        failed={connectFailed}
        onConnect={connect}
      />
    );
  }

  if (sessionDead) {
    return (
      <div className="mobile-error-screen" data-testid="mobile-error-screen">
        <p>Connection to EZTerminal lost.</p>
        <button type="button" className="btn btn-run" onClick={disconnect} data-testid="mobile-reconnect-btn">
          Back to connect screen
        </button>
      </div>
    );
  }

  if (!activeSessionId) {
    return (
      <SessionSwitcher transport={transport} onSelect={setActiveSessionId} onDisconnect={disconnect} />
    );
  }

  return (
    <MobileSessionView
      key={activeSessionId}
      sessionId={activeSessionId}
      onBack={() => setActiveSessionId(null)}
    />
  );
}
