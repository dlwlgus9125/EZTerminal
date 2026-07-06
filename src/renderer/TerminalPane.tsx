import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BlockController } from './block-controller';
import { Block } from './Block';
import { formatCwd } from './format-cwd';
import { registerPaneInput, removePaneCwd, setPaneCwd, unregisterPaneInput } from './pane-registry';
import { keyToPtyBytes } from './pty-keys';
import type { RunStartedInfo, SessionInfo } from '../shared/ipc';

// A TerminalPane is one independent shell surface: its own shell session (cwd/env/
// variables/history), its own stack of command Blocks, and its own pinned prompt.
// It owns everything that used to live in App — App is now just the host that mounts
// one (Track A M2). In M3 the dockview host mounts one TerminalPane per tab/split, so
// panes must be fully self-contained: each creates + destroys its own session.

interface BlockEntry {
  readonly id: string;
  readonly command: string;
  controller: BlockController | null;
}

// Module-scoped so runIds are unique across ALL panes — the brokered command port is
// correlated back to its run by this id (main echoes it on cmd-port), so a collision
// across panes would cross-wire ports.
let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `run-${runCounter}-${Date.now()}`;
}

// Live LOCALLY-CREATED session count across all panes — the `window.__ezSessions`
// test seam (Codex gate B6): layout-persistence e2e asserts no session leaks after
// restore/preset apply. Excludes M2 adopt-mode panes (bound to a session this
// window did NOT create) — those detach, never destroy, on unmount.
let liveSessionCount = 0;
(window as Window & { __ezSessions?: () => number }).__ezSessions = () => liveSessionCount;

interface TerminalPaneProps {
  /** This pane's dockview panel id — the pane-registry key the file-explorer
   * drawer (M1) uses to read this pane's live cwd when it opens. */
  readonly panelId: string;
  /** Starting cwd for a pane opened via the file-explorer's "open terminal
   * here" action (M2); undefined for a plain new tab/split (interpreter default). */
  readonly initialCwd?: string;
  /**
   * M2 adopt mode: bind to this ALREADY-EXISTING session instead of creating a
   * new one (this pane is following a session another surface — another
   * desktop tab, or mobile — created). `createSession` is skipped entirely;
   * on unmount the pane DETACHES (never `destroySession`s it). If the session
   * no longer exists (e.g. a restored layout referencing a session from a
   * PRIOR run of the interpreter), falls back to an ordinary new session —
   * see the mount effect. Undefined for a plain new tab/split.
   */
  readonly adoptSessionId?: string;
  /** C6 sessionId-report channel: fires once this pane's sessionId is known
   * (created OR adopted), so App.tsx can self-filter the `onSessionAdded`
   * broadcast (which fires for sessions this window itself just bound too)
   * and find the right panel to close on `onSessionRemoved`. */
  readonly onSessionBound?: (panelId: string, sessionId: string) => void;
  /** Companion to `onSessionBound` — fires on unmount so App.tsx can forget
   * the mapping (this panel no longer represents any session). */
  readonly onSessionUnbound?: (panelId: string) => void;
}

export function TerminalPane({
  panelId,
  initialCwd,
  adoptSessionId,
  onSessionBound,
  onSessionUnbound,
}: TerminalPaneProps): JSX.Element {
  const [command, setCommand] = useState('');
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  // Submitted commands (oldest first) for ↑/↓ recall. The renderer submits these,
  // so this list stays consistent with the interpreter's session history.
  const [history, setHistory] = useState<string[]>([]);
  // Recall cursor into `history`; null means "editing the live draft" (not recalling).
  const historyIndex = useRef<number | null>(null);
  // The in-progress draft saved when recall begins, restored when ↓ goes past newest.
  const draftBeforeRecall = useRef('');
  // Latest controller, so the Cancel button can reach the active run.
  const activeController = useRef<BlockController | null>(null);
  // Whether the active run is still running — gates the top-level Cancel button.
  const [activeRunning, setActiveRunning] = useState(false);
  // Whether the active run is a RUNNING xterm `pty` block — gates the "TUI pane
  // takeover" (terminal-feel pass T1): the pane hides its other blocks + pinned
  // cmd-input (CSS-only, never unmounted) and the running block fills the
  // pane's remaining height, like a real terminal handing the screen to a
  // full-screen program. Derived from the SAME active-run snapshot as
  // `activeRunning` — a pane has at most one running block (session runs are
  // serialized), so there is never more than one takeover candidate.
  const [activeTakeover, setActiveTakeover] = useState(false);
  // Whether the active run is a RUNNING plain-mode `pty` block (M1 focus
  // retention): while true, cmd-input's onKeyDown/onPaste below route
  // keystrokes straight to the PTY child instead of command-editing/
  // history/Enter-run, so the composer can double as the plain-PTY input
  // surface without losing focus. Derived from the SAME active-run snapshot
  // as `activeRunning`/`activeTakeover`. Caveat: it only flips true once this
  // run's MessagePort arrives and the controller subscribes (onActiveChange
  // below) — the ~1 frame between clicking Run and that arrival, keys typed
  // still hit command-editing instead of the PTY (accepted, plan ADR).
  const [activePlainPty, setActivePlainPty] = useState(false);
  // Unsubscribe from the active controller's status (replaced on each new run).
  const activeUnsub = useRef<(() => void) | null>(null);

  // This pane's shell session (Track A). Created on mount; a command can only run
  // once it exists (Codex B1/B5). `sessionDead` latches if the interpreter dies (B8).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionDead, setSessionDead] = useState(false);
  // M2 adopt mode: true once bound to an EXISTING session (vs. one this pane
  // created, including the C5 fallback below) — decides destroy-vs-detach on
  // unmount. Latest onSessionBound/onSessionUnbound in refs (not effect deps)
  // so a fresh inline closure from App on every render doesn't churn the
  // mount effect (mirrors MobileSessionView's onSessionDeadRef pattern).
  const isAdoptedRef = useRef(false);
  const onSessionBoundRef = useRef(onSessionBound);
  onSessionBoundRef.current = onSessionBound;
  const onSessionUnboundRef = useRef(onSessionUnbound);
  onSessionUnboundRef.current = onSessionUnbound;

  // The session's current working directory, shown in the live prompt. Seeded from
  // the session's startup cwd, then tracked from the active block's frames (latest
  // `end`, falling back to its `start`) so a `cd` updates it.
  const [currentCwd, setCurrentCwd] = useState<string | null>(null);

  // The scrollable block-list container — auto-scrolled to follow new output like a
  // terminal. `stickToBottom` stays true while the view is pinned to the bottom and
  // flips false if the user scrolls up, so we never yank them back down.
  const blockListRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const scrollBlockListToBottom = useCallback((): void => {
    const el = blockListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onBlockListScroll = useCallback((): void => {
    const el = blockListRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const blocksRef = useRef<BlockEntry[]>([]);
  blocksRef.current = blocks;

  // M4 attach-on-bind: latest `attachToRun` (defined below, after
  // `bindActiveController`) in a ref so the mount effect below — which needs
  // to call it from inside an async `listRuns()` continuation that fires
  // long before `attachToRun` exists in this file's top-to-bottom order —
  // always reaches the current one. Same "latest callback in a ref" idiom as
  // `onSessionBoundRef`/`onSessionUnboundRef` above.
  const attachToRunRef = useRef<((info: RunStartedInfo) => void) | null>(null);

  // Bind this pane to a session on mount — either ADOPT an existing one (M2,
  // `adoptSessionId`) or CREATE a fresh one (Codex B5), seeding the prompt
  // from its authoritative cwd either way. A created session is destroyed on
  // unmount so its state is released — the backend teardown is authoritative
  // even if this cleanup is skipped (B6); an ADOPTED session only DETACHES
  // (`isAdoptedRef`) — it belongs to whoever created it (maybe another
  // surface entirely), so this pane merely stops representing it.
  // The `cancelled` guard (Track A ③ A-M3, folds debt item (f)): if the effect
  // cleans up before the bind resolves — dev StrictMode double-mount, or a
  // pane torn down mid-restore during the fromJSON N-panel mount burst — the
  // late resolution must destroy/ignore the orphan instead of adopting it.
  useEffect(() => {
    let cancelled = false;

    const bindSession = (info: SessionInfo, adopted: boolean): void => {
      isAdoptedRef.current = adopted;
      sessionIdRef.current = info.sessionId;
      setSessionId(info.sessionId);
      setCurrentCwd((prev) => prev ?? info.cwd);
      setPaneCwd(panelId, info.cwd);
      if (!adopted) liveSessionCount += 1;
      onSessionBoundRef.current?.(panelId, info.sessionId);

      // M4 attach-on-bind: catch up on any run already in progress in this
      // session — covers the adopt-a-session-with-a-running-TUI gap (Ctrl+R
      // reload, or a restored/adopted layout panel) that the `onRunStarted`
      // effect below can't: it's edge-triggered, broadcasting once at the
      // moment a run BEGINS, so a pane that binds AFTER that moment never
      // sees it any other way. A fresh session has no runs yet, so this
      // resolves empty (no-op).
      void window.ezterminal?.listRuns?.().then((runs) => {
        if (cancelled) return;
        for (const run of runs) {
          if (run.sessionId !== info.sessionId) continue;
          if (blocksRef.current.some((entry) => entry.id === run.runId)) continue;
          attachToRunRef.current?.(run);
        }
      });
    };

    const createFresh = (): void => {
      void window.ezterminal
        ?.createSession?.(initialCwd)
        .then((info) => {
          if (cancelled) {
            window.ezterminal?.destroySession?.(info.sessionId);
            return;
          }
          bindSession(info, false);
        })
        .catch(() => undefined);
    };

    if (adoptSessionId) {
      // C5 persistence guard (Critic MS2): the adopt/fallback decision MUST be
      // sequenced strictly after `listSessions()` resolves — deciding off a
      // stale/assumed list would race a session mid-creation elsewhere
      // (warm-restore race). A restored layout can reference a session from a
      // PRIOR run of the interpreter (gone after a restart) — fall back to an
      // ordinary new session in that case, same as a plain ungrouped tab.
      void (window.ezterminal?.listSessions?.() ?? Promise.resolve([]))
        .then((sessions) => {
          if (cancelled) return;
          const existing = sessions.find((s) => s.sessionId === adoptSessionId);
          if (existing) {
            bindSession(existing, true);
          } else {
            createFresh();
          }
        })
        .catch(() => {
          if (!cancelled) createFresh();
        });
    } else {
      createFresh();
    }

    return () => {
      cancelled = true;
      if (sessionIdRef.current) {
        if (!isAdoptedRef.current) {
          window.ezterminal?.destroySession?.(sessionIdRef.current);
          liveSessionCount -= 1;
        }
        onSessionUnboundRef.current?.(panelId);
        sessionIdRef.current = null;
      }
      removePaneCwd(panelId);
    };
  }, [panelId, initialCwd, adoptSessionId]);

  // Paste-path-into-terminal (M2, file-explorer context menu): registers a
  // sink that appends text to the live command draft, space-separated unless
  // the draft is empty or already ends in whitespace.
  useEffect(() => {
    registerPaneInput(panelId, (text) => {
      setCommand((prev) => (prev === '' || /\s$/.test(prev) ? `${prev}${text}` : `${prev} ${text}`));
    });
    return () => unregisterPaneInput(panelId);
  }, [panelId]);

  // The interpreter is shared by all sessions in Phase 1, so its death kills this one
  // too — latch dead to stop accepting runs (Codex B8). Also release a stuck TUI
  // takeover (T1) and a stuck plain-PTY input route (M1): if the interpreter dies
  // mid-run, the active block's `onFrame` never delivers the 'end'/'error' that
  // would normally flip `activeTakeover`/`activePlainPty` false, which would
  // otherwise hide cmd-input permanently or keep routing keys nowhere.
  useEffect(() => {
    const unsub = window.ezterminal?.onSessionDead?.(() => {
      setSessionDead(true);
      setActiveTakeover(false);
      setActivePlainPty(false);
    });
    return () => unsub?.();
  }, []);

  // Follow new output: when a block is added (or its controller is attached) scroll
  // the list to the bottom if we are pinned there. Streaming growth of the active
  // block is handled in its subscription below.
  useLayoutEffect(() => {
    if (stickToBottom.current) scrollBlockListToBottom();
  }, [blocks, scrollBlockListToBottom]);

  // A takeover transition resizes the running block's `.pty-block` box via CSS
  // (360px <-> 100%). PtyBlock.tsx's ResizeObserver picks that up on its own in
  // practice, but 'ez:refit' (the same signal a dockview tab re-show uses, for
  // the same "size changed without an observer-visible mutation timing" reason)
  // is a cheap, guaranteed backstop.
  useEffect(() => {
    window.dispatchEvent(new Event('ez:refit'));
  }, [activeTakeover]);

  // Dispose every controller on unmount so the interpreter releases its stores. This
  // runs before the session-destroy cleanup above so the pane tears down its blocks,
  // then its session (Codex B6 ordering).
  useEffect(() => {
    return () => {
      activeUnsub.current?.();
      for (const entry of blocksRef.current) entry.controller?.dispose();
    };
  }, []);

  // Bind a run's controller as this pane's ACTIVE one — shared by a run this
  // pane itself started (handleRun below) and one it's MIRRORING (another
  // origin's run in this pane's session, see the onRunStarted effect below):
  // keeps the top-level Cancel/takeover/plain-PTY-input-routing state in sync
  // with whichever run is live, tracks the live prompt cwd, and follows
  // streaming output to the bottom while pinned. A session serializes its
  // runs (`canRun` — at most one running block at a time), so there is never
  // more than one "active" controller to track, whichever pane surfaced it.
  const bindActiveController = useCallback(
    (controller: BlockController): void => {
      activeController.current = controller;
      activeUnsub.current?.();
      const onActiveChange = (): void => {
        const snap = controller.getSnapshot();
        setActiveRunning(snap.status === 'running');
        setActiveTakeover(
          snap.status === 'running' && snap.shape === 'pty' && snap.ptyRenderMode === 'xterm',
        );
        setActivePlainPty(
          snap.status === 'running' && snap.shape === 'pty' && snap.ptyRenderMode === 'plain',
        );
        const cwd = snap.endCwd ?? snap.startCwd;
        if (cwd) {
          setCurrentCwd(cwd);
          setPaneCwd(panelId, cwd);
        }
        if (stickToBottom.current) requestAnimationFrame(scrollBlockListToBottom);
      };
      activeUnsub.current = controller.subscribe(onActiveChange);
      onActiveChange();
    },
    [panelId, scrollBlockListToBottom],
  );

  const handleRun = useCallback(() => {
    // Gate: need a live session (B1/B5), and serialize foreground runs — one command
    // at a time per session (B4); the backend rejects a concurrent run defensively.
    if (!sessionId || sessionDead || activeRunning) return;
    const text = command.trim();
    if (!text) return;
    const runId = nextRunId();

    // Submitting a command re-engages terminal-style following, even if the user had
    // scrolled up to read earlier output.
    stickToBottom.current = true;

    // Record for ↑/↓ recall and reset the cursor to the (now empty) live draft.
    setHistory((prev) => [...prev, text]);
    historyIndex.current = null;
    draftBeforeRecall.current = '';

    setBlocks((prev) => [...prev, { id: runId, command: text, controller: null }]);

    // The preload transfers the per-command MessagePort via window.postMessage,
    // echoing our runId so the right port reaches the right block (identical
    // command text run twice no longer collides). Listen BEFORE calling runCommand.
    const onWindowMessage = (ev: MessageEvent): void => {
      // Only trust port transfers from our own window — never a foreign frame
      // (SEC-LOW-5). The same-window identity is the reliable signal: on file://
      // the event origin serializes as the opaque "null" (≠ location.origin
      // "file://"), so an origin-string compare alone is unreliable; in dev (http)
      // the origins match. A cross-origin frame satisfies neither.
      if (ev.source !== window && ev.origin !== window.location.origin) return;
      if (!ev.data || ev.data._ezPort !== runId) return;
      window.removeEventListener('message', onWindowMessage);

      const port = ev.ports[0];
      if (!port) {
        console.error('[renderer] cmd-port message arrived with no port');
        return;
      }
      const controller = new BlockController(text, port);
      bindActiveController(controller);
      setBlocks((prev) =>
        prev.map((entry) => (entry.id === runId ? { ...entry, controller } : entry)),
      );
    };

    window.addEventListener('message', onWindowMessage);

    window.ezterminal.runCommand(text, runId, sessionId).catch((err: unknown) => {
      window.removeEventListener('message', onWindowMessage);
      console.error('[renderer] runCommand failed:', err);
    });
  }, [command, sessionId, sessionDead, activeRunning, bindActiveController]);

  // Mirror a run this pane did NOT start: adds a pending block, brokers the
  // `_ezAttachPort` handoff `attachRun` triggers, and binds the resulting
  // controller as active. Shared by two callers below — the edge-triggered
  // `onRunStarted` broadcast (M2 full mirroring: another pane/window/mobile
  // started a run in this pane's session) and the mount effect's level-
  // triggered `listRuns` catch-up (M4 attach-on-bind: a run already in
  // progress when this pane bound to the session) — both already know the
  // run isn't one of this pane's own before calling this.
  const attachToRun = useCallback(
    (info: RunStartedInfo): void => {
      setBlocks((prev) => [...prev, { id: info.runId, command: info.commandText, controller: null }]);

      // Mirrors handleRun's `_ezPort` handshake above, but for the
      // `_ezAttachPort` handoff `attachRun` triggers (preload.ts, ws-ezterminal.ts).
      const onWindowMessage = (ev: MessageEvent): void => {
        if (ev.source !== window && ev.origin !== window.location.origin) return;
        if (!ev.data || ev.data._ezAttachPort !== info.runId) return;
        window.removeEventListener('message', onWindowMessage);

        const port = ev.ports[0];
        if (!port) {
          console.error('[renderer] attach-port message arrived with no port');
          return;
        }
        const controller = new BlockController(info.commandText, port, { mirror: true });
        bindActiveController(controller);
        setBlocks((prev) =>
          prev.map((entry) => (entry.id === info.runId ? { ...entry, controller } : entry)),
        );
      };

      window.addEventListener('message', onWindowMessage);

      window.ezterminal.attachRun(info.sessionId, info.runId).catch((err: unknown) => {
        window.removeEventListener('message', onWindowMessage);
        console.error('[renderer] attachRun failed:', err);
      });
    },
    [bindActiveController],
  );
  attachToRunRef.current = attachToRun;

  useEffect(() => {
    const unsub = window.ezterminal?.onRunStarted?.((info: RunStartedInfo) => {
      if (info.sessionId !== sessionIdRef.current) return; // not my session
      if (blocksRef.current.some((entry) => entry.id === info.runId)) return; // my own run
      attachToRun(info);
    });
    return () => unsub?.();
  }, [attachToRun]);

  const handleCancel = useCallback(() => {
    activeController.current?.cancel();
  }, []);

  // Dismiss a finished (or any) block: dispose its controller so the interpreter
  // releases the ResultStore + closes the port, then drop it from the list. This
  // bounds memory — completed blocks no longer pin a store for the app lifetime
  // (ARCH-P1 / CODE-M4).
  const handleDismiss = useCallback((id: string) => {
    setBlocks((prev) => {
      const entry = prev.find((e) => e.id === id);
      if (entry?.controller) {
        if (activeController.current === entry.controller) {
          activeUnsub.current?.();
          activeUnsub.current = null;
          activeController.current = null;
          setActiveRunning(false);
          setActiveTakeover(false);
          setActivePlainPty(false);
        }
        entry.controller.dispose();
      }
      return prev.filter((e) => e.id !== id);
    });
  }, []);

  return (
    // data-session-id: layout-persistence e2e records per-pane session ids and
    // asserts they all DIFFER after a restart-restore (B1/B5 — fresh sessions).
    <div
      className={activeTakeover ? 'pane pane--tui-takeover' : 'pane'}
      data-testid="pane"
      data-session-id={sessionId ?? undefined}
    >
      <div
        className="block-list"
        data-testid="block-list"
        ref={blockListRef}
        onScroll={onBlockListScroll}
      >
        {blocks.map((entry) =>
          entry.controller ? (
            <Block
              key={entry.id}
              controller={entry.controller}
              onDismiss={() => handleDismiss(entry.id)}
              isTakeover={activeTakeover && activeController.current === entry.controller}
            />
          ) : (
            <section key={entry.id} className="block" data-testid="block" data-status="running">
              <div className="block-pending">starting…</div>
            </section>
          ),
        )}
      </div>

      <div className="cmd-row">
        {currentCwd && (
          <span className="prompt-cwd" title={currentCwd} data-testid="prompt-cwd">
            {formatCwd(currentCwd)}
          </span>
        )}
        <span className="prompt-sigil prompt-sigil--input" aria-hidden="true">
          ❯
        </span>
        <input
          className="cmd-input"
          value={command}
          // Disabled only during a TUI takeover (M1 focus retention): the
          // takeover's xterm view needs real focus for term.onData to work
          // (PtyBlock.tsx's PtyXtermView, unchanged), and cmd-input is hidden
          // via CSS during takeover anyway ('.pane--tui-takeover'). Otherwise
          // — idle, or a plain-mode PTY run — cmd-input stays enabled and
          // focused: a plain run routes its keystrokes here straight to the
          // PTY child (onKeyDown/onPaste below, activePlainPty) instead of
          // disabling input entirely, so the user never has to click back in.
          disabled={!sessionId || sessionDead || activeTakeover}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (activePlainPty) {
              // Plain PTY run: keystrokes go straight to the PTY child
              // (M1 focus retention) — command editing / history recall /
              // Enter-run are all suspended for the run's duration, matching
              // PtyPlainView's former minimal keyset (mode-key-map guard: the
              // same key means something different depending on the mode).
              const bytes = keyToPtyBytes(e);
              if (bytes === null) return; // unsupported key — leave default input behavior alone
              e.preventDefault();
              activeController.current?.sendPtyInput(bytes);
              return;
            }
            if (e.key === 'Enter') {
              handleRun();
              return;
            }
            // ↑/↓ recall previously submitted commands (standard shell behavior):
            // Up steps to older, Down steps to newer; past the newest restores the
            // draft that was in the input when recall began.
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (history.length === 0) return;
              if (historyIndex.current === null) {
                draftBeforeRecall.current = command;
                historyIndex.current = history.length - 1;
              } else if (historyIndex.current > 0) {
                historyIndex.current -= 1;
              }
              setCommand(history[historyIndex.current]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (historyIndex.current === null) return;
              if (historyIndex.current < history.length - 1) {
                historyIndex.current += 1;
                setCommand(history[historyIndex.current]);
              } else {
                historyIndex.current = null;
                setCommand(draftBeforeRecall.current);
              }
            }
          }}
          onPaste={(e) => {
            if (!activePlainPty) return; // idle: default paste-into-input behavior
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (text) activeController.current?.sendPtyInput(text);
          }}
          aria-label="command input"
          data-testid="cmd-input"
        />
        <button
          className="btn btn-run"
          onClick={handleRun}
          disabled={!sessionId || sessionDead || activeRunning}
          data-testid="btn-run"
        >
          Run
        </button>
        <button
          className="btn btn-cancel"
          onClick={handleCancel}
          disabled={!activeRunning}
          data-testid="btn-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
