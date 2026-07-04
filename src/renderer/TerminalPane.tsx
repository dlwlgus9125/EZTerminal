import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BlockController } from './block-controller';
import { Block } from './Block';
import { formatCwd } from './format-cwd';

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

// Live (adopted) session count across all panes — the `window.__ezSessions` test
// seam (Codex gate B6): layout-persistence e2e asserts no session leaks after
// restore/preset apply. Counts only sessions a mounted pane adopted.
let liveSessionCount = 0;
(window as Window & { __ezSessions?: () => number }).__ezSessions = () => liveSessionCount;

export function TerminalPane(): JSX.Element {
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
  // Unsubscribe from the active controller's status (replaced on each new run).
  const activeUnsub = useRef<(() => void) | null>(null);

  // This pane's shell session (Track A). Created on mount; a command can only run
  // once it exists (Codex B1/B5). `sessionDead` latches if the interpreter dies (B8).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionDead, setSessionDead] = useState(false);

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

  // Create this pane's shell session on mount and seed the prompt from its
  // authoritative cwd (Codex B5). Destroy it on unmount so its state is released —
  // the backend teardown is authoritative even if this cleanup is skipped (B6).
  // The `cancelled` guard (Track A ③ A-M3, folds debt item (f)): if the effect
  // cleans up before createSession resolves — dev StrictMode double-mount, or a
  // pane torn down mid-restore during the fromJSON N-panel mount burst — the late
  // resolution must destroy the orphan session instead of adopting it.
  useEffect(() => {
    let cancelled = false;
    void window.ezterminal
      ?.createSession?.()
      .then((info) => {
        if (cancelled) {
          window.ezterminal?.destroySession?.(info.sessionId);
          return;
        }
        sessionIdRef.current = info.sessionId;
        setSessionId(info.sessionId);
        setCurrentCwd((prev) => prev ?? info.cwd);
        liveSessionCount += 1;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (sessionIdRef.current) {
        window.ezterminal?.destroySession?.(sessionIdRef.current);
        sessionIdRef.current = null;
        liveSessionCount -= 1;
      }
    };
  }, []);

  // The interpreter is shared by all sessions in Phase 1, so its death kills this one
  // too — latch dead to stop accepting runs (Codex B8). Also release a stuck TUI
  // takeover (T1): if the interpreter dies mid-run, the active block's `onFrame`
  // never delivers the 'end'/'error' that would normally flip `activeTakeover`
  // false, which would otherwise hide cmd-input/other blocks permanently.
  useEffect(() => {
    const unsub = window.ezterminal?.onSessionDead?.(() => {
      setSessionDead(true);
      setActiveTakeover(false);
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
      activeController.current = controller;
      // On every frame from the active run: keep the top-level Cancel in sync (it
      // disables once the run finishes), track the live prompt cwd (latest `end`,
      // else `start`), and — while pinned — follow the streaming output to the
      // bottom after React paints the new content (rAF, so scrollHeight is current).
      activeUnsub.current?.();
      const onActiveChange = (): void => {
        const snap = controller.getSnapshot();
        setActiveRunning(snap.status === 'running');
        setActiveTakeover(
          snap.status === 'running' && snap.shape === 'pty' && snap.ptyRenderMode === 'xterm',
        );
        const cwd = snap.endCwd ?? snap.startCwd;
        if (cwd) setCurrentCwd(cwd);
        if (stickToBottom.current) requestAnimationFrame(scrollBlockListToBottom);
      };
      activeUnsub.current = controller.subscribe(onActiveChange);
      onActiveChange();
      setBlocks((prev) =>
        prev.map((entry) => (entry.id === runId ? { ...entry, controller } : entry)),
      );
    };

    window.addEventListener('message', onWindowMessage);

    window.ezterminal.runCommand(text, runId, sessionId).catch((err: unknown) => {
      window.removeEventListener('message', onWindowMessage);
      console.error('[renderer] runCommand failed:', err);
    });
  }, [command, scrollBlockListToBottom, sessionId, sessionDead, activeRunning]);

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
          // Disabled while a foreground run is active (Phase 3 papercut fix): a
          // plain-mode PTY block wires its own keyboard input directly, so
          // cmd-input looking editable while it can't actually submit anything
          // was misleading; this also lets the block reliably hand focus back
          // to cmd-input on exit (PtyBlock.tsx) since a disabled input cannot
          // receive focus, so the timing only needs to work in one direction.
          disabled={!sessionId || sessionDead || activeRunning}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
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
