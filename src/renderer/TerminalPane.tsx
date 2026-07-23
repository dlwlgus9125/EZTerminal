import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BlockController } from './block-controller';
import { Block } from './Block';
import { formatCwd } from './format-cwd';
import { useAppTranslation } from './i18n';
import {
  registerPane,
  type PaneActionResult,
  type PaneSnapshot,
} from './pane-registry';
import { focusPaneSurface } from './pane-focus';
import { keyToPtyBytes } from './pty-keys';
import {
  resolveTerminalShortcut,
  takeCodexInterruptNotice,
} from './terminal-key-policy';
import { pasteFromRuntimeClipboard } from './terminal-paste';
import { selectedTextWithin } from './terminal-selection';
import { QuickCommandShelf } from './QuickCommandShelf';
import {
  closeRunPort,
  getRunPortBroker,
  RunPortError,
} from './run-port-broker';
import type {
  PaneInstanceToken,
  SessionPaneLease,
} from './session-panel-tracker';
import {
  DEFAULT_TERMINAL_RUNTIME_OPTIONS,
  type TerminalRuntimeOptions,
} from './xterm-runtime';
import type { RunStartedInfo, SessionInfo } from '../shared/ipc';
import type { QuickCommand } from '../shared/quick-command';
import { classifyDirectAgentCommand } from '../shared/agent-command';

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
  /** Exact Dockview panel API object. Unlike panelId, this identity is never
   * reused by a layout replacement. Tests without Dockview may omit it. */
  readonly paneInstanceToken?: PaneInstanceToken;
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
  /** Exact lifecycle lease: pending adoption is registered at mount, actual
   * binding is recorded once known, and cleanup releases both identities. */
  readonly mountSessionPane?: (
    panelId: string,
    instanceToken: PaneInstanceToken,
    requestedAdoptSessionId?: string,
  ) => SessionPaneLease;
  readonly terminalRuntimeOptions?: TerminalRuntimeOptions;
  /** Preset replacement owns a short global mutation lease. The boolean is
   * for rendering; the callback is the synchronous submission authority so a
   * React commit delay cannot open a run race. */
  readonly commandSubmissionLocked?: boolean;
  readonly isCommandSubmissionLocked?: () => boolean;
  readonly quickCommands?: readonly QuickCommand[];
  readonly onManageQuickCommands?: () => void;
}

export function TerminalPane({
  panelId,
  paneInstanceToken,
  initialCwd,
  adoptSessionId,
  mountSessionPane,
  terminalRuntimeOptions,
  commandSubmissionLocked = false,
  isCommandSubmissionLocked,
  quickCommands = [],
  onManageQuickCommands,
}: TerminalPaneProps): JSX.Element {
  const { t } = useAppTranslation();
  const resolvedTerminalRuntimeOptions = terminalRuntimeOptions ?? DEFAULT_TERMINAL_RUNTIME_OPTIONS;
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
  // unmount. The latest lease factory stays in a ref so callback identity
  // changes do not churn the session mount effect.
  const isAdoptedRef = useRef(false);
  const sessionBindingPendingRef = useRef(true);
  // Completion marker set only after guarded destruction was acknowledged (or
  // shared-fate interpreter death was observed). It never grants advance
  // authorization to destroy a future run.
  const handledSessionDestroyRef = useRef<string | null>(null);
  const mountSessionPaneRef = useRef(mountSessionPane);
  mountSessionPaneRef.current = mountSessionPane;
  const fallbackPaneInstanceTokenRef = useRef<PaneInstanceToken>({});
  const exactPaneInstanceToken = paneInstanceToken ?? fallbackPaneInstanceTokenRef.current;

  // The session's current working directory, shown in the live prompt. Seeded from
  // the session's startup cwd, then tracked from the active block's frames (latest
  // `end`, falling back to its `start`) so a `cd` updates it.
  const [currentCwd, setCurrentCwd] = useState<string | null>(null);

  // The scrollable block-list container — auto-scrolled to follow new output like a
  // terminal. `stickToBottom` stays true while the view is pinned to the bottom and
  // flips false if the user scrolls up, so we never yank them back down.
  const blockListRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const cmdInputRef = useRef<HTMLInputElement>(null);

  const scrollBlockListToBottom = useCallback((): void => {
    const el = blockListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onBlockListScroll = useCallback((): void => {
    const el = blockListRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  // Click-to-refocus: returns focus to the composer so the next command is
  // immediately typeable — EXCEPT (a) while selecting text to copy (non-collapsed
  // selection), and (b) when the click lands in a running interactive xterm block
  // (.pty-block), which must keep focus for keystrokes to reach the child
  // (PtyBlock.tsx:269). Plain output / tables / empty space refocus the input.
  const handleScreenClick = (e: React.MouseEvent): void => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // preserve drag-to-select/copy
    const target = e.target as HTMLElement;
    if (target.closest('.pty-block')) return; // xterm block keeps its own focus
    if (target.closest('button, a, input, textarea, select')) return; // interactive controls
    cmdInputRef.current?.focus();
  };

  const blocksRef = useRef<BlockEntry[]>([]);
  blocksRef.current = blocks;

  // M4 attach-on-bind: latest `attachToRun` (defined below, after
  // `bindActiveController`) in a ref so the mount effect below — which needs
  // to call it from inside an async `listRuns()` continuation that fires
  // long before `attachToRun` exists in this file's top-to-bottom order —
  // always reaches the current one. Same "latest callback in a ref" idiom as
  // the pane lease factory above.
  const attachToRunRef = useRef<((info: RunStartedInfo) => void) | null>(null);
  // Port handoffs belong to the current pane/session binding. The scope is
  // replaced before paint when that binding changes, so late transfers cannot
  // create controllers after unmount, session death, or adoption replacement.
  const handoffAbortByRunRef = useRef(new Map<string, AbortController>());
  const knownRunIdsRef = useRef(new Set<string>());
  const pendingHandoffRunIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    const abortPending = (reason: string): void => {
      for (const controller of handoffAbortByRunRef.current.values()) {
        controller.abort(reason);
      }
      handoffAbortByRunRef.current.clear();
    };
    abortPending(sessionDead ? 'session-dead' : 'session-change');
    if (!sessionId) {
      abortPending('session-unavailable');
    }
    return () => abortPending('unmount');
  }, [sessionId, sessionDead]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    // React StrictMode runs setup -> cleanup -> setup on the same ref object.
    // Cleanup clears the flag, so every setup must explicitly reacquire the
    // binding-pending state before it can issue list/create requests.
    sessionBindingPendingRef.current = true;
    let cancelled = false;
    let boundSessionId: string | null = null;
    let boundAdopted = false;
    const paneLease = mountSessionPaneRef.current?.(
      panelId,
      exactPaneInstanceToken,
      adoptSessionId,
    );

    const bindSession = (info: SessionInfo, adopted: boolean): void => {
      if (paneLease && !paneLease.bind(info.sessionId)) {
        if (!adopted) void window.ezterminal?.destroySession?.(info.sessionId);
        return;
      }
      sessionBindingPendingRef.current = false;
      isAdoptedRef.current = adopted;
      boundAdopted = adopted;
      sessionIdRef.current = info.sessionId;
      setSessionId(info.sessionId);
      setCurrentCwd((prev) => prev ?? info.cwd);
      if (!adopted) liveSessionCount += 1;
      boundSessionId = info.sessionId;

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
        .catch(() => {
          if (!cancelled) sessionBindingPendingRef.current = false;
        });
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
      sessionBindingPendingRef.current = false;
      if (boundSessionId) {
        if (!boundAdopted) {
          if (handledSessionDestroyRef.current !== boundSessionId) {
            // An ordinary unmount is allowed to tear down only while idle. The
            // interpreter rejects `[]` if any foreground run exists. A close or
            // preset that already received its guarded ACK marks completion and
            // deliberately skips this redundant second request.
            void window.ezterminal?.destroySessionGuarded?.(
              boundSessionId,
              [],
            );
          }
          liveSessionCount -= 1;
        }
        if (sessionIdRef.current === boundSessionId) sessionIdRef.current = null;
      }
      paneLease?.dispose();
    };
  }, [panelId, exactPaneInstanceToken, initialCwd, adoptSessionId]);

  // The interpreter is shared by all sessions in Phase 1, so its death kills this one
  // too — latch dead to stop accepting runs (Codex B8). Also release a stuck TUI
  // takeover (T1) and a stuck plain-PTY input route (M1): if the interpreter dies
  // mid-run, the active block's `onFrame` never delivers the 'end'/'error' that
  // would normally flip `activeTakeover`/`activePlainPty` false, which would
  // otherwise hide cmd-input permanently or keep routing keys nowhere.
  useEffect(() => {
    const unsubscribeDead = window.ezterminal?.onSessionDead?.(() => {
      for (const controller of handoffAbortByRunRef.current.values()) {
        controller.abort('session-dead');
      }
      handoffAbortByRunRef.current.clear();
      const pendingRunIds = new Set(pendingHandoffRunIdsRef.current);
      pendingHandoffRunIdsRef.current.clear();
      for (const runId of pendingRunIds) knownRunIdsRef.current.delete(runId);
      setBlocks((previous) => previous.filter((entry) => !pendingRunIds.has(entry.id)));
      for (const entry of blocksRef.current) {
        entry.controller?.markTransportInterrupted(t('terminalPane.interpreterInterrupted'));
      }
      setSessionDead(true);
      setActiveRunning(false);
      setActiveTakeover(false);
      setActivePlainPty(false);
    });
    const unsubscribeRecovered = window.ezterminal?.onSessionRecovered?.(() => {
      setSessionDead(false);
      requestAnimationFrame(() => cmdInputRef.current?.focus());
    });
    return () => {
      unsubscribeDead?.();
      unsubscribeRecovered?.();
    };
  }, [t]);

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

  // The pane owns both takeover visibility and the command input's disabled
  // state, so it also owns the reliable focus handoff when takeover ends.
  // Focusing from the child PTY view can race this commit and no-op while the
  // input is still disabled; the parent effect runs after that state is live.
  const previousTakeoverRef = useRef(activeTakeover);
  useEffect(() => {
    const wasActive = previousTakeoverRef.current;
    previousTakeoverRef.current = activeTakeover;
    if (!wasActive || activeTakeover) return;
    const raf = requestAnimationFrame(() => cmdInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeTakeover]);

  // Dispose every controller on unmount so the interpreter releases its stores. This
  // runs before the session-destroy cleanup above so the pane tears down its blocks,
  // then its session (Codex B6 ordering).
  useEffect(() => {
    const pendingRunIds = pendingHandoffRunIdsRef.current;
    const knownRunIds = knownRunIdsRef.current;
    return () => {
      activeUnsub.current?.();
      for (const entry of blocksRef.current) entry.controller?.dispose();
      pendingRunIds.clear();
      knownRunIds.clear();
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
        }
        if (stickToBottom.current) requestAnimationFrame(scrollBlockListToBottom);
      };
      activeUnsub.current = controller.subscribe(onActiveChange);
      onActiveChange();
    },
    [scrollBlockListToBottom],
  );

  const runText = useCallback((requestedText: string): PaneActionResult => {
    // Gate: need a live session (B1/B5), and serialize foreground runs — one command
    // at a time per session (B4); the backend rejects a concurrent run defensively.
    if (isCommandSubmissionLocked?.()) return { ok: false, reason: 'unavailable' };
    if (!sessionId) return { ok: false, reason: 'unavailable' };
    if (sessionDead) return { ok: false, reason: 'dead' };
    if (activeRunning) return { ok: false, reason: 'busy' };
    const text = requestedText.trim();
    if (!text) return { ok: false, reason: 'empty' };
    const runSessionId = sessionId;
    const runId = nextRunId();
    const handoffController = new AbortController();
    const handoffSignal = handoffController.signal;
    handoffAbortByRunRef.current.set(runId, handoffController);

    // Submitting a command re-engages terminal-style following, even if the user had
    // scrolled up to read earlier output.
    stickToBottom.current = true;

    // Record for ↑/↓ recall and reset the cursor to the (now empty) live draft.
    setHistory((prev) => [...prev, text]);
    historyIndex.current = null;
    draftBeforeRecall.current = '';
    setCommand('');

    setBlocks((prev) => [...prev, { id: runId, command: text, controller: null }]);

    // The singleton broker registers the runId correlation before asking the
    // preload to transfer the command port.
    knownRunIdsRef.current.add(runId);
    pendingHandoffRunIdsRef.current.add(runId);
    void getRunPortBroker().request({
      kind: 'run',
      runId,
      signal: handoffSignal,
      send: () => window.ezterminal.runCommand(text, runId, runSessionId),
    }).then((port) => {
      if (handoffAbortByRunRef.current.get(runId) === handoffController) {
        handoffAbortByRunRef.current.delete(runId);
      }
      pendingHandoffRunIdsRef.current.delete(runId);
      if (handoffSignal.aborted) {
        closeRunPort(port);
        knownRunIdsRef.current.delete(runId);
        if (mountedRef.current) {
          setBlocks((prev) => prev.filter((entry) => entry.id !== runId));
        }
        return;
      }
      try {
        const controller = new BlockController(text, port, {
          controlTarget: { panelId, sessionId: runSessionId, runId },
        });
        bindActiveController(controller);
        setBlocks((prev) =>
          prev.map((entry) => (entry.id === runId ? { ...entry, controller } : entry)),
        );
      } catch (error) {
        closeRunPort(port);
        knownRunIdsRef.current.delete(runId);
        if (mountedRef.current) {
          setBlocks((prev) => prev.filter((entry) => entry.id !== runId));
        }
        console.error('[renderer] failed to bind cmd-port:', error);
      }
    }).catch((error: unknown) => {
      if (handoffAbortByRunRef.current.get(runId) === handoffController) {
        handoffAbortByRunRef.current.delete(runId);
      }
      pendingHandoffRunIdsRef.current.delete(runId);
      knownRunIdsRef.current.delete(runId);
      if (mountedRef.current) {
        setBlocks((prev) => prev.filter((entry) => entry.id !== runId));
      }
      if (handoffSignal.aborted || (error instanceof RunPortError && error.code === 'aborted')) return;
      console.error('[renderer] runCommand failed:', error);
    });
    return { ok: true };
  }, [
    sessionId,
    sessionDead,
    activeRunning,
    bindActiveController,
    isCommandSubmissionLocked,
    panelId,
  ]);

  const handleRun = useCallback((): void => {
    runText(command);
  }, [command, runText]);

  // One aggregate pane handle replaces the historical cwd/input maps. The
  // effect refreshes the handle whenever its observable snapshot changes;
  // registry consumers receive one revision notification and always query a
  // coherent snapshot/actions pair.
  useEffect(() => {
    const getSnapshot = (): PaneSnapshot => {
      const active = activeController.current?.getSnapshot();
      const isBusy = active?.status === 'running';
      const activePty = Boolean(isBusy && active?.shape === 'pty');
      return {
        panelId,
        sessionId: sessionIdRef.current,
        cwd: currentCwd ?? '',
        history,
        draft: command,
        isBusy,
        isDead: sessionDead,
        sessionBindingPending: sessionBindingPendingRef.current,
        destroysSessionOnClose: sessionIdRef.current !== null && !isAdoptedRef.current,
        activeRunIds: blocksRef.current
          .filter((entry) => entry.controller?.getSnapshot().status === 'running')
          .map((entry) => entry.id),
        executionKind: active?.executionKind ?? null,
        hasSshPrompt: active?.sshPrompt !== null && active?.sshPrompt !== undefined,
        activePty,
        activeCommand: activePty ? (activeController.current?.command ?? null) : null,
      };
    };
    const dispose = registerPane(panelId, {
      getSnapshot,
      markSessionDestroyHandled: (destroyedSessionId): boolean => {
        const snapshot = getSnapshot();
        if (
          !snapshot.destroysSessionOnClose
          || snapshot.sessionId === null
          || snapshot.sessionId !== destroyedSessionId
        ) {
          return false;
        }
        handledSessionDestroyRef.current = destroyedSessionId;
        return true;
      },
      insertText: (text): PaneActionResult => {
        if (sessionDead) return { ok: false, reason: 'dead' };
        setCommand((previous) =>
          previous === '' || /\s$/.test(previous) ? `${previous}${text}` : `${previous} ${text}`,
        );
        requestAnimationFrame(() => cmdInputRef.current?.focus());
        return { ok: true };
      },
      runText: (text): PaneActionResult => {
        if (command.trim() !== '') return { ok: false, reason: 'draft-not-empty' };
        return runText(text);
      },
      pasteToPty: (text): PaneActionResult => {
        const controller = activeController.current;
        const snapshot = controller?.getSnapshot();
        if (!controller || snapshot?.status !== 'running' || snapshot.shape !== 'pty') {
          return { ok: false, reason: 'not-pty' };
        }
        controller.pasteText(text);
        return { ok: true };
      },
      focus: (): void => {
        const active = activeController.current?.getSnapshot();
        focusPaneSurface(
          cmdInputRef.current,
          active?.status === 'running' && active.shape === 'pty',
        );
      },
    });
    return dispose;
  }, [panelId, sessionId, currentCwd, history, command, activeRunning, sessionDead, runText]);

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
      if (knownRunIdsRef.current.has(info.runId)) return;
      const handoffController = new AbortController();
      const handoffSignal = handoffController.signal;
      handoffAbortByRunRef.current.set(info.runId, handoffController);
      knownRunIdsRef.current.add(info.runId);
      pendingHandoffRunIdsRef.current.add(info.runId);
      setBlocks((prev) => [...prev, { id: info.runId, command: info.commandText, controller: null }]);

      void getRunPortBroker().request({
        kind: 'attach',
        runId: info.runId,
        signal: handoffSignal,
        send: () => window.ezterminal.attachRun(info.sessionId, info.runId),
      }).then((port) => {
        if (handoffAbortByRunRef.current.get(info.runId) === handoffController) {
          handoffAbortByRunRef.current.delete(info.runId);
        }
        pendingHandoffRunIdsRef.current.delete(info.runId);
        if (handoffSignal.aborted) {
          closeRunPort(port);
          knownRunIdsRef.current.delete(info.runId);
          if (mountedRef.current) {
            setBlocks((prev) => prev.filter((entry) => entry.id !== info.runId));
          }
          return;
        }
        try {
          const controller = new BlockController(info.commandText, port, {
            mirror: true,
            controlTarget: { panelId, sessionId: info.sessionId, runId: info.runId },
          });
          bindActiveController(controller);
          setBlocks((prev) =>
            prev.map((entry) => (
              entry.id === info.runId ? { ...entry, controller } : entry
            )),
          );
        } catch (error) {
          closeRunPort(port);
          knownRunIdsRef.current.delete(info.runId);
          if (mountedRef.current) {
            setBlocks((prev) => prev.filter((entry) => entry.id !== info.runId));
          }
          console.error('[renderer] failed to bind attach-port:', error);
        }
      }).catch((error: unknown) => {
        if (handoffAbortByRunRef.current.get(info.runId) === handoffController) {
          handoffAbortByRunRef.current.delete(info.runId);
        }
        pendingHandoffRunIdsRef.current.delete(info.runId);
        knownRunIdsRef.current.delete(info.runId);
        if (mountedRef.current) {
          setBlocks((prev) => prev.filter((entry) => entry.id !== info.runId));
        }
        if (handoffSignal.aborted || (error instanceof RunPortError && error.code === 'aborted')) return;
        console.error('[renderer] attachRun failed:', error);
      });
    },
    [bindActiveController, panelId],
  );
  attachToRunRef.current = attachToRun;

  useEffect(() => {
    const unsub = window.ezterminal?.onRunStarted?.((info: RunStartedInfo) => {
      if (info.sessionId !== sessionIdRef.current) return; // not my session
      if (knownRunIdsRef.current.has(info.runId)) return; // my own/already-pending run
      attachToRun(info);
    });
    return () => unsub?.();
  }, [attachToRun]);

  const handleCancel = useCallback(() => {
    activeController.current?.cancel();
  }, []);

  const selectedPlainOutputText = useCallback((): string => {
    const pane = cmdInputRef.current?.closest('.pane');
    return selectedTextWithin(pane ?? null);
  }, []);

  const pasteIntoActivePlainPty = useCallback((mode: 'default' | 'text'): void => {
    const controller = activeController.current;
    if (!controller || controller.getSnapshot().status !== 'running') return;
    void pasteFromRuntimeClipboard(resolvedTerminalRuntimeOptions, {
      isCodex: classifyDirectAgentCommand(controller.command) === 'codex',
      mode,
      deliverImage: () => {
        if (activeController.current === controller) controller.sendPtyInput('\x16');
      },
      deliverText: (text) => {
        if (activeController.current === controller) controller.sendPtyInput(text);
      },
    });
  }, [resolvedTerminalRuntimeOptions]);

  const activeIsCodex = activeRunning
    && classifyDirectAgentCommand(activeController.current?.command ?? '') === 'codex';

  // Dismiss a finished (or any) block: dispose its controller so the interpreter
  // releases the ResultStore + closes the port, then drop it from the list. This
  // bounds memory — completed blocks no longer pin a store for the app lifetime
  // (ARCH-P1 / CODE-M4).
  const handleDismiss = useCallback((id: string) => {
    handoffAbortByRunRef.current.get(id)?.abort('block-dismissed');
    handoffAbortByRunRef.current.delete(id);
    knownRunIdsRef.current.delete(id);
    pendingHandoffRunIdsRef.current.delete(id);
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
        onClick={handleScreenClick}
      >
        {blocks.map((entry) =>
          entry.controller ? (
            <Block
              key={entry.id}
              controller={entry.controller}
              onDismiss={() => handleDismiss(entry.id)}
              isTakeover={activeTakeover && activeController.current === entry.controller}
              terminalRuntimeOptions={terminalRuntimeOptions}
            />
          ) : (
            <section key={entry.id} className="block" data-testid="block" data-status="running">
              <div className="block-pending">{t('terminalPane.starting')}</div>
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
          ref={cmdInputRef}
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
              // IME composing (CJK / dead-key input, M4): let the input
              // compose normally — don't route the in-progress keydowns to
              // keyToPtyBytes (they're not the real character yet) or
              // preventDefault (that would break composition). The composed
              // text is sent once, on `onCompositionEnd` below, so it must
              // NOT also go through this per-keydown path.
              if (e.nativeEvent.isComposing || e.key === 'Process') return;
              const controller = activeController.current;
              const selectedText = selectedPlainOutputText();
              const shortcut = resolveTerminalShortcut({
                code: e.code,
                key: e.key,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                isCodex: classifyDirectAgentCommand(controller?.command ?? '') === 'codex',
                hasSelection: selectedText !== '',
                canFind: false,
              });
              if (shortcut.kind !== 'pass') {
                e.preventDefault();
                if (shortcut.kind === 'copy') {
                  if (selectedText) void navigator.clipboard.writeText(selectedText);
                } else if (shortcut.kind === 'paste') {
                  pasteIntoActivePlainPty(shortcut.mode);
                } else if (
                  shortcut.kind === 'block'
                  && shortcut.notice === 'codex-interrupt-help'
                  && controller
                  && takeCodexInterruptNotice(controller)
                ) {
                  resolvedTerminalRuntimeOptions.notifyTerminal?.('codex-interrupt-help');
                }
                return;
              }
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
            pasteIntoActivePlainPty('default');
          }}
          onCompositionEnd={(e) => {
            if (!activePlainPty) return; // idle: default composition-into-draft behavior
            if (e.data) activeController.current?.sendPtyInput(e.data);
            setCommand(''); // clear what the browser composed into the input
          }}
          aria-label={t('terminalPane.commandInput')}
          data-testid="cmd-input"
        />
        {onManageQuickCommands && (
          <QuickCommandShelf
            commands={quickCommands}
            insertDisabledReason={sessionDead ? t('terminalPane.ended') : undefined}
            runDisabledReason={
              !sessionId
                ? t('terminalPane.sessionStarting')
                : sessionDead
                  ? t('terminalPane.ended')
                  : activeRunning
                    ? t('terminalPane.waitForCommand')
                    : command.trim()
                      ? t('terminalPane.clearDraft')
                      : commandSubmissionLocked
                        ? t('terminalPane.layoutRecovery')
                        : undefined
            }
            onInsert={(text) => {
              setCommand((previous) => (
                previous === '' || /\s$/.test(previous) ? `${previous}${text}` : `${previous} ${text}`
              ));
              requestAnimationFrame(() => cmdInputRef.current?.focus());
            }}
            onRun={runText}
            onManage={onManageQuickCommands}
          />
        )}
        <button
          className="btn btn-run"
          onClick={handleRun}
          disabled={!sessionId || sessionDead || activeRunning || commandSubmissionLocked}
          data-testid="btn-run"
        >
          {t('terminalPane.run')}
        </button>
        <button
          className="btn btn-cancel"
          onClick={handleCancel}
          disabled={!activeRunning}
          data-testid="btn-cancel"
        >
          {activeIsCodex ? t('terminalPane.forceStop') : t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
