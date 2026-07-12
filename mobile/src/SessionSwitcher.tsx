import { useCallback, useEffect, useState } from 'react';

import type { SessionInfo } from '../../src/shared/ipc';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

/** Maps an OpenClaw status state (or `undefined` — not pushed yet) to the 🤖
 * entry button's status-dot color class (M4): green=running, gray=stopped/
 * not-installed, yellow=starting/unknown/not-yet-known. A coarser 3-color
 * grouping than the full status tab's own `openclaw-status-dot--<state>`
 * classes (MobileOpenClawView.tsx) — deliberately not reused, since those
 * grade 'unknown' as red (an alarm), which reads wrong on a small compact
 * badge that also has to represent "haven't heard yet". Exported so
 * MobileWorkspace's own workspace-header 🤖 button applies the identical dot. */
export function openclawEntryDotClass(state: OpenClawStatus['state'] | undefined): string {
  const modifier = state === 'running' ? 'running' : state === 'stopped' || state === 'not-installed' ? 'stopped' : 'pending';
  return `openclaw-entry-dot openclaw-entry-dot--${modifier}`;
}

// SessionSwitcher — the session manager listing every session currently live
// on the desktop bridge (`list-sessions`), with create/destroy/open-as-tab.
// Dual variant (M5, mobile-parity plan D5): 'page' renders in normal document
// flow — MobileWorkspace shows this as the zero-tab home screen, which MUST
// stay in-flow (not a fixed overlay) so uiautomator's accessibility dump can
// see '+ New Session' with no WebView running (see mobile/e2e/smoke.ts).
// 'sheet' is a ☰-opened fixed bottom sheet, a convenience surface while tabs
// are already open — not e2e-load-bearing.
//
// Selecting a session hands `(sessionId, cwd)` up so MobileWorkspace can open
// it as a tab; this component itself never creates a BlockController/port.
// The M4 theme button that used to live here has moved to MobileWorkspace's
// header (it owns theme state for the whole authed shell now).
export function SessionSwitcher({
  variant,
  transport,
  onSelect,
  onDisconnect,
  onCloseSheet,
  onOpenClaw,
  openclawState,
}: {
  variant: 'page' | 'sheet';
  transport: WsEzTerminalTransport;
  onSelect: (sessionId: string, cwd: string) => void;
  onDisconnect: () => void;
  onCloseSheet?: () => void;
  /** OpenClaw entry point (openclaw-stabilization M4) — only passed by the
   * zero-tab 'page' variant (MobileWorkspace), gated there on effective
   * OpenClaw visibility; the 'sheet' variant never passes these (the
   * workspace-header's own 🤖 button already covers that surface once tabs exist). */
  onOpenClaw?: () => void;
  openclawState?: OpenClawStatus['state'];
}): JSX.Element {
  const [sessions, setSessions] = useState<readonly SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // M2 full mirroring: seed the list once via `listSessions()`, then stay
  // live via `onSessionAdded`/`onSessionRemoved` (both unconditional
  // broadcasts, including a session THIS connection's own create/destroy
  // below just caused) instead of re-polling after every local action.
  useEffect(() => {
    let cancelled = false;
    void transport.listSessions().then((list) => {
      if (cancelled) return;
      setSessions(list);
      setLoading(false);
    });
    const unsubAdded = transport.onSessionAdded((session) => {
      setSessions((prev) =>
        prev.some((s) => s.sessionId === session.sessionId) ? prev : [...prev, session],
      );
    });
    const unsubRemoved = transport.onSessionRemoved((sessionId) => {
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    });
    return () => {
      cancelled = true;
      unsubAdded();
      unsubRemoved();
    };
  }, [transport]);

  const createAndOpen = useCallback(() => {
    void transport.createSession().then((info) => onSelect(info.sessionId, info.cwd));
  }, [transport, onSelect]);

  const destroy = useCallback(
    (sessionId: string) => {
      // The list drops it via the onSessionRemoved subscription above (echo included).
      transport.destroySession(sessionId);
    },
    [transport],
  );

  const content = (
    <div className="session-switcher" data-testid="session-switcher">
      <header className="session-switcher-head">
        <h2>Sessions</h2>
        {onOpenClaw && (
          <button
            type="button"
            className="btn openclaw-btn"
            onClick={onOpenClaw}
            aria-label="OpenClaw"
            data-testid="btn-toggle-openclaw"
          >
            🤖
            <span className={openclawEntryDotClass(openclawState)} data-testid="openclaw-entry-dot" />
          </button>
        )}
        <button className="btn" onClick={onDisconnect} data-testid="disconnect-btn">
          Disconnect
        </button>
      </header>

      {loading ? (
        <p className="session-list-loading">Loading…</p>
      ) : (
        <ul className="session-list" data-testid="session-list">
          {sessions.map((s) => (
            <li key={s.sessionId} className="session-list-item" data-testid="session-item">
              <button
                type="button"
                className="session-open"
                onClick={() => onSelect(s.sessionId, s.cwd)}
                data-testid="session-open"
              >
                {s.cwd}
              </button>
              <button
                type="button"
                className="btn btn-cancel"
                onClick={() => destroy(s.sessionId)}
                aria-label="destroy session"
                data-testid="session-destroy"
              >
                ✕
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="session-list-empty">No sessions yet.</li>}
        </ul>
      )}

      <button
        type="button"
        className="btn btn-run session-create"
        onClick={createAndOpen}
        data-testid="session-create"
      >
        + New Session
      </button>
    </div>
  );

  if (variant === 'page') {
    return content;
  }

  return (
    <div
      className="session-switcher-backdrop"
      data-testid="session-switcher-backdrop"
      onClick={onCloseSheet}
    >
      <div className="session-switcher-sheet" onClick={(e) => e.stopPropagation()}>
        {content}
      </div>
    </div>
  );
}
