import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { SessionInfo } from '../../src/shared/ipc';
import { CLOSE_RISK_LABEL, classifyCloseRisk, type CloseRisk } from '../../src/shared/close-risk';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [checkingSessionId, setCheckingSessionId] = useState<string | null>(null);
  const [destroyPrompt, setDestroyPrompt] = useState<{
    readonly sessionId: string;
    readonly cwd: string;
    readonly risk: CloseRisk;
    readonly activeRunIds: readonly string[];
  } | null>(null);
  const destroyFocusRef = useRef<HTMLElement | null>(null);
  const refreshGenerationRef = useRef(0);
  const destroyGuardRef = useRef(false);
  const destroyPromptSessionRef = useRef<string | null>(null);
  const destroyDialogRef = useRef<HTMLDivElement | null>(null);
  const destroyTitleId = useId();
  const destroyDescriptionId = useId();

  const refreshSessions = useCallback(async (): Promise<void> => {
    const generation = ++refreshGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      if (!transport.isAuthed) throw new Error('Desktop is offline.');
      const list = await transport.listSessions();
      if (!transport.isAuthed) throw new Error('Connection was lost while loading sessions.');
      if (generation !== refreshGenerationRef.current) return;
      setSessions(list);
    } catch (error) {
      if (generation !== refreshGenerationRef.current) return;
      setLoadError(error instanceof Error ? error.message : 'Could not load sessions.');
    } finally {
      if (generation === refreshGenerationRef.current) setLoading(false);
    }
  }, [transport]);

  // Seed authoritatively on every authenticated socket generation, then stay
  // live via the existing broadcasts between reconnects.
  useEffect(() => {
    const unsubConnection = transport.onConnectionStateChange((state) => {
      if (state === 'connected') void refreshSessions();
    });
    const unsubAdded = transport.onSessionAdded((session) => {
      setSessions((prev) =>
        prev.some((s) => s.sessionId === session.sessionId) ? prev : [...prev, session],
      );
    });
    const unsubRemoved = transport.onSessionRemoved((sessionId) => {
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      if (destroyPromptSessionRef.current === sessionId) {
        destroyPromptSessionRef.current = null;
        destroyGuardRef.current = false;
        setDestroyPrompt(null);
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('[data-testid="session-create"]')?.focus();
        });
      }
    });
    return () => {
      refreshGenerationRef.current += 1;
      unsubConnection();
      unsubAdded();
      unsubRemoved();
    };
  }, [transport, refreshSessions]);

  const createAndOpen = useCallback(async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const info = await transport.createSession();
      onSelect(info.sessionId, info.cwd);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create a session.');
    } finally {
      setCreating(false);
    }
  }, [creating, transport, onSelect]);

  const restoreDestroyFocus = useCallback((): void => {
    destroyGuardRef.current = false;
    destroyPromptSessionRef.current = null;
    setDestroyPrompt(null);
    const previous = destroyFocusRef.current;
    requestAnimationFrame(() => {
      if (previous?.isConnected) previous.focus();
    });
  }, []);

  useEffect(() => {
    if (!destroyPrompt) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        restoreDestroyFocus();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(destroyDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [destroyPrompt, restoreDestroyFocus]);

  const destroy = useCallback(async (session: SessionInfo): Promise<void> => {
    if (destroyGuardRef.current) return;
    destroyGuardRef.current = true;
    destroyFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCheckingSessionId(session.sessionId);
    try {
      const [runs, activity] = await Promise.all([
        transport.listRuns(),
        transport.getAgentActivitySnapshot(),
      ]);
      const sessionRuns = runs.filter((item) => item.sessionId === session.sessionId);
      const run = sessionRuns[0];
      const activeRunIds = sessionRuns.map((item) => item.runId).sort();
      const hasActiveAgent = activity.items.some(
        (item) =>
          item.sessionId === session.sessionId
          && item.status !== 'done'
          && item.status !== 'error',
      );
      const risk = classifyCloseRisk({
        destroysSession: true,
        isBusy: run !== undefined,
        executionKind: run?.executionKind ?? null,
        hasSshPrompt: false,
        hasActiveAgent,
      });
      if (risk === null) {
        const result = await transport.destroySessionGuarded(session.sessionId, activeRunIds);
        if (result.ok) {
          destroyGuardRef.current = false;
        } else {
          destroyPromptSessionRef.current = session.sessionId;
          setDestroyPrompt({ sessionId: session.sessionId, cwd: session.cwd, risk: 'unknown', activeRunIds });
        }
      } else {
        destroyPromptSessionRef.current = session.sessionId;
        setDestroyPrompt({ sessionId: session.sessionId, cwd: session.cwd, risk, activeRunIds });
      }
    } catch {
      destroyPromptSessionRef.current = session.sessionId;
      setDestroyPrompt({ sessionId: session.sessionId, cwd: session.cwd, risk: 'unknown', activeRunIds: [] });
    } finally {
      setCheckingSessionId(null);
    }
  }, [transport]);

  const confirmDestroy = useCallback(async (): Promise<void> => {
    if (!destroyPrompt) return;
    const { sessionId, activeRunIds: expectedActiveRunIds } = destroyPrompt;
    const runs = await transport.listRuns().catch(() => []);
    const latestActiveRunIds = runs
      .filter((item) => item.sessionId === sessionId)
      .map((item) => item.runId)
      .sort();
    if (
      latestActiveRunIds.length !== expectedActiveRunIds.length
      || latestActiveRunIds.some((runId, index) => runId !== expectedActiveRunIds[index])
    ) {
      setDestroyPrompt({ ...destroyPrompt, risk: 'unknown', activeRunIds: latestActiveRunIds });
      return;
    }
    const result = await transport.destroySessionGuarded(sessionId, latestActiveRunIds);
    if (!result.ok) {
      setDestroyPrompt({ ...destroyPrompt, risk: 'unknown', activeRunIds: latestActiveRunIds });
      return;
    }
    destroyGuardRef.current = false;
    destroyPromptSessionRef.current = null;
    setDestroyPrompt(null);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-testid="session-create"]')?.focus();
    });
  }, [destroyPrompt, transport]);

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
      ) : loadError ? (
        <div className="session-list-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={() => void refreshSessions()}>
            Retry
          </button>
        </div>
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
                onClick={() => void destroy(s)}
                disabled={checkingSessionId === s.sessionId}
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
        onClick={() => void createAndOpen()}
        disabled={creating || !transport.isAuthed}
        data-testid="session-create"
      >
        {creating ? 'Creating…' : '+ New Session'}
      </button>
      {createError && <p className="session-create-error" role="alert">{createError}</p>}
      {destroyPrompt && (
        <div
          className="session-destroy-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) restoreDestroyFocus();
          }}
          data-testid="session-destroy-backdrop"
        >
          <div
            ref={destroyDialogRef}
            className="session-destroy-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={destroyTitleId}
            aria-describedby={destroyDescriptionId}
            data-testid="session-destroy-dialog"
          >
            <h2 id={destroyTitleId}>Destroy active session?</h2>
            <p id={destroyDescriptionId}>
              This destroys {CLOSE_RISK_LABEL[destroyPrompt.risk]} in {destroyPrompt.cwd}.
            </p>
            <div className="session-destroy-actions">
              <button
                type="button"
                className="btn"
                onClick={restoreDestroyFocus}
                autoFocus
                data-testid="session-destroy-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-cancel"
                onClick={confirmDestroy}
                data-testid="session-destroy-confirm"
              >
                Destroy session
              </button>
            </div>
          </div>
        </div>
      )}
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
