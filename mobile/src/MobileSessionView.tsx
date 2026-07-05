import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BlockController } from '../../src/renderer/block-controller';
import { Block } from '../../src/renderer/Block';
import { registerPaneInput, unregisterPaneInput } from '../../src/renderer/pane-registry';
import { TouchInputBar } from './TouchInputBar';

// MobileSessionView — the mobile analogue of the desktop's TerminalPane.tsx.
// Reuses `BlockController`/`Block.tsx` UNMODIFIED (same `_ezPort` window-
// message handshake, same command-input/history/cancel/dismiss wiring). The
// ONE deliberate difference is session lifecycle: TerminalPane always mints a
// FRESH session on mount and destroys it on unmount (one pane = one session,
// forever, on desktop). Here the phone is switching between potentially
// several sessions ALREADY running on the desktop (SessionSwitcher owns
// create/destroy) — this view only ATTACHES to the `sessionId` it's given and
// never creates or destroys a session itself. Everything below `sessionId`
// (command running, block list, cancel, dismiss, history recall) is a direct
// port of TerminalPane's logic.
//
// M5: this is now one of possibly several tabs MobileWorkspace keeps mounted
// (display:none when inactive, never unmounted — see MobileWorkspace.tsx's
// module doc). The header ('‹ Sessions', cwd, 📊/🎨 buttons + ThemeMenu) moved
// up to MobileWorkspace, which owns tabs/stats/theme for the whole authed
// shell; this view only owns the block list + input row + its own session-
// dead banner, and surfaces death upward via `onSessionDead` so the workspace
// can close this tab (MobileWorkspace.tsx's `handleSessionDead`).

interface BlockEntry {
  readonly id: string;
  readonly command: string;
  controller: BlockController | null;
}

// Module-scoped so runIds are unique across every mounted view — mirrors
// TerminalPane's `nextRunId` (a collision would cross-wire brokered ports).
let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `mobile-run-${runCounter}-${Date.now()}`;
}

export function MobileSessionView({
  sessionId,
  onSessionDead,
  onCwdChange,
}: {
  sessionId: string;
  onSessionDead?: () => void;
  /** Best-effort cwd snapshot (file-explorer plan, M4) — mirrors desktop
   * TerminalPane's `setPaneCwd` call site (latest `end`, falling back to
   * `start`). MobileWorkspace records it in a map keyed by sessionId; Files
   * reads it ONCE at open, never live-follows it. */
  onCwdChange?: (sessionId: string, cwd: string) => void;
}): JSX.Element {
  const [command, setCommand] = useState('');
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const draftBeforeRecall = useRef('');
  const activeController = useRef<BlockController | null>(null);
  const [activeControllerForTouch, setActiveControllerForTouch] = useState<BlockController | null>(null);
  const [activeRunning, setActiveRunning] = useState(false);
  const activeUnsub = useRef<(() => void) | null>(null);
  const [sessionDead, setSessionDead] = useState(false);
  // Latest callback in a ref (not an effect dependency) so a fresh inline
  // closure from MobileWorkspace on every render doesn't churn the
  // subscribe/unsubscribe below.
  const onSessionDeadRef = useRef(onSessionDead);
  onSessionDeadRef.current = onSessionDead;
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  const blockListRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const blocksRef = useRef<BlockEntry[]>([]);
  blocksRef.current = blocks;

  const scrollBlockListToBottom = useCallback((): void => {
    const el = blockListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onBlockListScroll = useCallback((): void => {
    const el = blockListRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  // The shared interpreter's death kills every session — latch dead so the
  // input disables (Codex B8, same as TerminalPane), and tell the workspace
  // so it can close this tab (all open tabs get this at once, since the
  // signal is global — see module doc).
  useEffect(() => {
    const unsub = window.ezterminal.onSessionDead(() => {
      setSessionDead(true);
      onSessionDeadRef.current?.();
    });
    return unsub;
  }, []);

  // Paste-path-into-terminal (file-explorer plan, M4): registers a sink that
  // appends text to the live command draft, space-separated unless the
  // draft is empty or already ends in whitespace — mirrors desktop
  // TerminalPane's identical registration, keyed by sessionId instead of a
  // dockview panelId (`pane-registry.ts` is a plain string-keyed registry,
  // agnostic to what the key represents).
  useEffect(() => {
    registerPaneInput(sessionId, (text) => {
      setCommand((prev) => (prev === '' || /\s$/.test(prev) ? `${prev}${text}` : `${prev} ${text}`));
    });
    return () => unregisterPaneInput(sessionId);
  }, [sessionId]);

  // M3 e2e test hook ONLY: a running command's output renders into a
  // `[data-testid="text-output"]` element (TextBlock.tsx or PtyBlock.tsx's
  // plain-mode view — both protected/reused desktop files this app cannot
  // modify to add a verification seam directly). The Android emulator smoke
  // test has no DOM access without Appium, so this observer mirrors that
  // text to `console.log`, which Android's WebView forwards to logcat —
  // `mobile/e2e/smoke.ts` greps for the `[ez-e2e]` marker. Harmless in normal
  // use (one extra console.log per output mutation).
  useEffect(() => {
    const container = blockListRef.current;
    if (!container) return;
    const observer = new MutationObserver(() => {
      for (const el of container.querySelectorAll('[data-testid="text-output"]')) {
        const text = el.textContent;
        if (text) console.log('[ez-e2e] output:', text);
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (stickToBottom.current) scrollBlockListToBottom();
  }, [blocks, scrollBlockListToBottom]);

  // Dispose every controller on unmount (switching sessions, or navigating
  // back) so the interpreter releases their stores. Unlike TerminalPane, there
  // is no session destroy here — SessionSwitcher owns that lifecycle.
  useEffect(() => {
    return () => {
      activeUnsub.current?.();
      for (const entry of blocksRef.current) entry.controller?.dispose();
    };
  }, []);

  const handleRun = useCallback(() => {
    if (sessionDead || activeRunning) return;
    const text = command.trim();
    if (!text) return;
    const runId = nextRunId();

    stickToBottom.current = true;
    setHistory((prev) => [...prev, text]);
    historyIndex.current = null;
    draftBeforeRecall.current = '';
    setCommand('');

    setBlocks((prev) => [...prev, { id: runId, command: text, controller: null }]);

    // Same `_ezPort` handoff TerminalPane.tsx listens for — ws-ezterminal.ts's
    // runCommand() reproduces it via a synthetic dispatchEvent (see its module
    // doc). Listen BEFORE calling runCommand.
    const onWindowMessage = (ev: MessageEvent): void => {
      if (ev.source !== window && ev.origin !== window.location.origin) return;
      if (!ev.data || (ev.data as { _ezPort?: string })._ezPort !== runId) return;
      window.removeEventListener('message', onWindowMessage);

      const port = ev.ports[0];
      if (!port) {
        console.error('[mobile] cmd-port message arrived with no port');
        return;
      }
      const controller = new BlockController(text, port);
      activeController.current = controller;
      setActiveControllerForTouch(controller);
      activeUnsub.current?.();
      const onActiveChange = (): void => {
        const snap = controller.getSnapshot();
        setActiveRunning(snap.status === 'running');
        // cwd snapshot (M4): mirrors desktop TerminalPane's same site — latest
        // `end`, falling back to `start`, so a `cd` is reflected.
        const cwd = snap.endCwd ?? snap.startCwd;
        if (cwd) onCwdChangeRef.current?.(sessionId, cwd);
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
      console.error('[mobile] runCommand failed:', err);
    });
  }, [command, scrollBlockListToBottom, sessionId, sessionDead, activeRunning]);

  const handleCancel = useCallback(() => {
    activeController.current?.cancel();
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setBlocks((prev) => {
      const entry = prev.find((e) => e.id === id);
      if (entry?.controller) {
        if (activeController.current === entry.controller) {
          activeUnsub.current?.();
          activeUnsub.current = null;
          activeController.current = null;
          setActiveControllerForTouch(null);
          setActiveRunning(false);
        }
        entry.controller.dispose();
      }
      return prev.filter((e) => e.id !== id);
    });
  }, []);

  return (
    <div className="pane mobile-session-view" data-testid="mobile-session-view">
      {sessionDead && (
        <div className="mobile-session-dead-banner" data-testid="session-dead-banner">
          Connection lost.
        </div>
      )}

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
            />
          ) : (
            <section key={entry.id} className="block" data-testid="block" data-status="running">
              <div className="block-pending">starting…</div>
            </section>
          ),
        )}
      </div>

      <TouchInputBar controller={activeControllerForTouch} />

      <div className="cmd-row">
        <span className="prompt-sigil prompt-sigil--input" aria-hidden="true">
          ❯
        </span>
        <input
          className="cmd-input"
          value={command}
          disabled={sessionDead || activeRunning}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleRun();
              return;
            }
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
          type="button"
          className="btn btn-run"
          onClick={handleRun}
          disabled={sessionDead || activeRunning}
          data-testid="btn-run"
        >
          Run
        </button>
        <button
          type="button"
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
