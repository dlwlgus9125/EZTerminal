import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  AgentApproval,
  AgentDecision,
  AgentDecisionResult,
} from '../shared/agent';
import { BlockController } from './block-controller';
import { TerminalBlockEntries } from './TerminalBlockEntries';
import { Button } from './ui';
import { formatCwd } from './format-cwd';
import { useAppTranslation } from './i18n';
import {
  notifyPaneChanged,
  registerPane,
  type PaneActionResult,
  type PaneHandle,
  type PaneSnapshot,
} from './pane-registry';
import { focusPaneSurface } from './pane-focus';
import { keyToPtyBytes } from './pty-keys';
import {
  resolveTerminalShortcut,
  takeCodexInterruptNotice,
} from './terminal-key-policy';
import {
  captureTerminalContextMenuInvocation,
  closeTerminalContextMenu,
  isTerminalContextMenuKey,
  keyboardTerminalContextMenuInvocation,
  TerminalContextMenu,
  type TerminalContextMenuInvocation,
  type TerminalContextMenuItem,
} from './TerminalContextMenu';
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
} from './session-mirroring-coordinator';
import {
  DEFAULT_TERMINAL_RUNTIME_OPTIONS,
  type TerminalRuntimeOptions,
} from './xterm-runtime';
import type { RunStartedInfo } from '../shared/ipc';
import type { SessionSurfaceBinding } from '../shared/session-surface';
import type { QuickCommand } from '../shared/quick-command';
import type { AgentResumeBootstrap, AgentTerminalBootstrap } from '../shared/agent-history';
import { classifyDirectAgentCommand } from '../shared/agent-command';
import { clearAgentTerminalBootstrap } from './agent-terminal-bootstrap';
import type { ProjectSessionTarget } from '../shared/project-workspace';

// A TerminalPane is one independent shell surface: its own stack of command Blocks,
// pinned prompt, and an authority-issued binding to a shell session. The host owns
// session lifecycle policy; this component renders and interacts with that binding.

interface BlockEntry {
  readonly id: string;
  readonly command: string;
  controller: BlockController | null;
}

interface PaneContextMenuSource {
  readonly kind: 'input' | 'pane';
  readonly selectedText: string;
  readonly draftSelectionStart: number;
  readonly draftSelectionEnd: number;
}

interface PaneContextMenuState {
  readonly invocation: TerminalContextMenuInvocation;
  readonly source: PaneContextMenuSource;
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

export type TerminalResumeBootstrap = AgentResumeBootstrap;

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
  /** Opaque project location resolved by main when this surface opens. */
  readonly projectTarget?: ProjectSessionTarget;
  /**
   * Bind strictly to this already-existing session instead of creating a new
   * one. A missing live/manual adoption fails closed; it never silently creates
   * a replacement session. Undefined for a plain new tab/split.
   */
  readonly adoptSessionId?: string;
  /** Converts a read-only Agent Session panel into a live resumed Codex PTY. */
  readonly resumeBootstrap?: TerminalResumeBootstrap;
  /** Runtime-only project-card launch; never persisted in Dockview params. */
  readonly agentBootstrap?: AgentTerminalBootstrap;
  readonly onAgentBootstrapFailure?: (message: string) => void;
  /** Exact lifecycle lease: pending adoption is registered at mount, actual
   * binding is recorded once known, and cleanup releases both identities. */
  readonly mountSessionPane?: (
    panelId: string,
    instanceToken: PaneInstanceToken,
    initialCwd?: string,
    requestedAdoptSessionId?: string,
    projectTarget?: ProjectSessionTarget,
  ) => SessionPaneLease;
  readonly terminalRuntimeOptions?: TerminalRuntimeOptions;
  /** Preset replacement owns a short global mutation lease. The boolean is
   * for rendering; the callback is the synchronous submission authority so a
   * React commit delay cannot open a run race. */
  readonly commandSubmissionLocked?: boolean;
  readonly isCommandSubmissionLocked?: () => boolean;
  readonly quickCommands?: readonly QuickCommand[];
  readonly onManageQuickCommands?: () => void;
  /** The permission call the agent in THIS pane is parked on, if any. */
  readonly pendingApproval?: PaneApproval;
  readonly onDecideApproval?: (
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ) => Promise<AgentDecisionResult>;
}

/** The pending permission call for the agent running in a given pane, so the
 * pane can offer the same decision the Agent Hub does without the user having
 * to leave the terminal they are already looking at. */
export interface PaneApproval {
  readonly activityId: string;
  readonly approval: AgentApproval;
}

export function TerminalPane({
  panelId,
  paneInstanceToken,
  initialCwd,
  projectTarget,
  adoptSessionId,
  resumeBootstrap,
  agentBootstrap,
  onAgentBootstrapFailure,
  mountSessionPane,
  terminalRuntimeOptions,
  commandSubmissionLocked = false,
  isCommandSubmissionLocked,
  quickCommands = [],
  onManageQuickCommands,
  pendingApproval,
  onDecideApproval,
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
  // True while the explicit Codex recovery action is between Escape and its
  // delayed in-session `continue`; disables duplicate recovery sequences.
  const [activeCodexRecoveryPending, setActiveCodexRecoveryPending] = useState(false);
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
  const resumeStartedRef = useRef(false);
  const [bootstrapRetryToken, setBootstrapRetryToken] = useState(0);
  const [sessionBindingError, setSessionBindingError] = useState<string | null>(null);
  const [sessionBindingRetryToken, setSessionBindingRetryToken] = useState(0);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // Unsubscribe from the active controller's status (replaced on each new run).
  const activeUnsub = useRef<(() => void) | null>(null);

  // This pane's authority-issued shell binding. A command can only run once it
  // exists; `sessionDead` latches if the interpreter dies.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionDead, setSessionDead] = useState(false);
  // The latest lease factory stays in a ref so callback identity changes do not
  // churn the session mount effect.
  const sessionSurfaceBindingRef = useRef<SessionSurfaceBinding | null>(null);
  const sessionBindingPendingRef = useRef(true);
  // Completion marker set only after guarded destruction was acknowledged (or
  // shared-fate interpreter death was observed). It never grants advance
  // authorization to destroy a future run.
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
  const paneRef = useRef<HTMLDivElement>(null);
  const blockListRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const pendingDraftCaretRef = useRef<number | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<PaneContextMenuState | null>(null);

  useLayoutEffect(() => {
    const caret = pendingDraftCaretRef.current;
    if (caret === null) return;
    pendingDraftCaretRef.current = null;
    const input = cmdInputRef.current;
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }, [command]);

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
    const sel = (e.currentTarget.ownerDocument.defaultView ?? window).getSelection();
    if (sel && !sel.isCollapsed) return; // preserve drag-to-select/copy
    const target = e.target as HTMLElement;
    if (target.closest('.pty-block')) return; // xterm block keeps its own focus
    if (target.closest('button, a, input, textarea, select')) return; // interactive controls
    cmdInputRef.current?.focus();
  };

  const blocksRef = useRef<BlockEntry[]>([]);
  blocksRef.current = blocks;

  // M4 attach-on-bind: latest `attachToRun` (defined below, after
  // `bindActiveController`) in a ref so the committed-session catch-up effect
  // can call it from an async `listRuns()` continuation even though the
  // callback is declared later in this file. Same "latest callback in a ref"
  // idiom as the pane lease factory above.
  const attachToRunRef = useRef<((info: RunStartedInfo) => void) | null>(null);
  // Port handoffs belong to the current pane/session binding. The scope is
  // replaced before paint when that binding changes, so late transfers cannot
  // create controllers after unmount, session death, or adoption replacement.
  const handoffAbortByRunRef = useRef(new Map<string, AbortController>());
  const knownRunIdsRef = useRef(new Set<string>());
  const pendingHandoffRunIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const paneHandleRef = useRef<PaneHandle | null>(null);

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

  // Bind this surface on mount. The host authority either creates a fresh
  // owner binding or strictly adopts the requested live session. Cleanup only
  // releases the surface binding; guarded destruction is a separate close
  // transaction owned by the lifecycle coordinator.
  useEffect(() => {
    // React StrictMode runs setup -> cleanup -> setup on the same ref object.
    // Cleanup clears the flag, so every setup must explicitly reacquire the
    // binding-pending state before it can issue list/create requests.
    sessionBindingPendingRef.current = true;
    let cancelled = false;
    let bound: SessionSurfaceBinding | null = null;
    let countedOwner = false;
    const paneLease = mountSessionPaneRef.current?.(
      panelId,
      exactPaneInstanceToken,
      initialCwd,
      adoptSessionId,
      projectTarget,
    );

    const open = paneLease && window.ezterminal?.openSessionSurface;

    if (!paneLease || !open) {
      // Without the preload lifecycle seam this surface cannot safely acquire
      // or release a session binding, so it stays unavailable.
      sessionBindingPendingRef.current = false;
      setSessionBindingError('unavailable');
    } else {
      void open(paneLease.surfaceId, paneLease.intent).then((result) => {
        if (!result.ok) {
          if (!cancelled) {
            sessionBindingPendingRef.current = false;
            setSessionBindingError(result.reason);
          }
          return;
        }
        if (!paneLease.bind(result.binding) || cancelled) return;

        bound = result.binding;
        sessionSurfaceBindingRef.current = result.binding;
        sessionBindingPendingRef.current = false;
        setSessionBindingError(null);
        sessionIdRef.current = result.binding.session.sessionId;
        setSessionId(result.binding.session.sessionId);
        setCurrentCwd((previous) => previous ?? result.binding.session.cwd);
        if (result.binding.role === 'owner') {
          liveSessionCount += 1;
          countedOwner = true;
        }
      }).catch(() => {
        if (!cancelled) {
          sessionBindingPendingRef.current = false;
          setSessionBindingError('unavailable');
        }
      });
    }

    return () => {
      cancelled = true;
      sessionBindingPendingRef.current = false;
      if (countedOwner) liveSessionCount -= 1;
      if (bound) {
        if (sessionSurfaceBindingRef.current?.bindingId === bound.bindingId) {
          sessionSurfaceBindingRef.current = null;
        }
        if (sessionIdRef.current === bound.session.sessionId) sessionIdRef.current = null;
      }
      paneLease?.dispose();
    };
  }, [panelId, exactPaneInstanceToken, initialCwd, adoptSessionId, projectTarget, sessionBindingRetryToken]);

  // M4 attach-on-bind: catch up only after the session id has committed. If
  // this starts inside bindSession, a fast listRuns reply can begin a handoff
  // before React replaces the initial `sessionId=null` layout-effect scope;
  // that old scope's cleanup then aborts the new session's handoff. Running as
  // a committed-session effect guarantees the new abort scope is installed
  // first. onRunStarted remains the edge-triggered path, and the known-run set
  // makes the two discovery paths idempotent.
  useEffect(() => {
    if (!sessionId || sessionDead) return;
    let cancelled = false;
    const boundSessionId = sessionId;
    void window.ezterminal?.listRuns?.().then((runs) => {
      if (cancelled || sessionIdRef.current !== boundSessionId) return;
      for (const run of runs) {
        if (run.sessionId !== boundSessionId) continue;
        if (blocksRef.current.some((entry) => entry.id === run.runId)) continue;
        attachToRunRef.current?.(run);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionDead]);

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
      setActiveCodexRecoveryPending(false);
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
        setActiveCodexRecoveryPending(snap.codexRecoveryPending);
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

  useEffect(() => {
    const bootstrap = agentBootstrap ?? resumeBootstrap;
    if (
      !bootstrap
      || resumeStartedRef.current
      || !sessionId
      || sessionDead
    ) {
      return;
    }
    resumeStartedRef.current = true;
    setResumeError(null);
    const runSessionId = sessionId;
    const runId = nextRunId();
    const handoffController = new AbortController();
    const handoffSignal = handoffController.signal;
    handoffAbortByRunRef.current.set(runId, handoffController);
    knownRunIdsRef.current.add(runId);
    pendingHandoffRunIdsRef.current.add(runId);
    stickToBottom.current = true;
    // The first resumed prompt is one-shot PTY input, not an EZTerminal shell
    // command. Keep it out of command recall/history and only restore it as a
    // draft if resume startup fails.
    const resumeLabel = bootstrap.kind === 'resume' ? bootstrap.provider : bootstrap.name;
    setBlocks([{ id: runId, command: resumeLabel, controller: null }]);

    void getRunPortBroker().request({
      kind: 'run',
      runId,
      signal: handoffSignal,
      send: async () => {
        if (bootstrap.kind === 'resume') {
          const result = await window.ezterminal.startAgentResume({
            historyId: bootstrap.historyId,
            sessionId: runSessionId,
            runId,
            rootChoice: bootstrap.rootChoice,
            revision: bootstrap.revision,
          });
          if (!result.ok) throw new Error(`Agent resume failed: ${result.reason}`);
          return;
        }
        let launchTarget = bootstrap.target;
        let launchRevision = bootstrap.revision;
        if (bootstrapRetryToken > 0) {
          const preparation = await window.ezterminal.prepareAgentLaunch(
            bootstrap.target,
            bootstrap.launcherId,
          );
          if (!preparation.ok) {
            throw new Error(`Agent launch preparation failed: ${preparation.reason}`);
          }
          launchTarget = preparation.target;
          launchRevision = preparation.revision;
        }
        const result = await window.ezterminal.startAgentLaunch({
          target: launchTarget,
          launcherId: bootstrap.launcherId,
          sessionId: runSessionId,
          runId,
          revision: launchRevision,
        });
        if (!result.ok) throw new Error(`Agent launch failed: ${result.reason}`);
      },
    }).then((port) => {
      handoffAbortByRunRef.current.delete(runId);
      pendingHandoffRunIdsRef.current.delete(runId);
      if (handoffSignal.aborted) {
        closeRunPort(port);
        knownRunIdsRef.current.delete(runId);
        return;
      }
      try {
        const controller = new BlockController(resumeLabel, port, {
          controlTarget: { panelId, sessionId: runSessionId, runId },
        });
        if (bootstrap.kind === 'resume') controller.submitPtyWhenReady(bootstrap.initialPrompt);
        bindActiveController(controller);
        setBlocks((previous) => previous.map((entry) =>
          entry.id === runId ? { ...entry, controller } : entry));
        if (bootstrap.kind === 'new-chat') clearAgentTerminalBootstrap(panelId);
      } catch (error) {
        closeRunPort(port);
        knownRunIdsRef.current.delete(runId);
        console.error('[renderer] failed to bind Agent resume port:', error);
      }
    }).catch((error: unknown) => {
      handoffAbortByRunRef.current.delete(runId);
      pendingHandoffRunIdsRef.current.delete(runId);
      knownRunIdsRef.current.delete(runId);
      if (!handoffSignal.aborted) {
        setBlocks([]);
        resumeStartedRef.current = false;
        if (bootstrap.kind === 'resume') {
          setCommand(bootstrap.initialPrompt);
          const message = 'Could not open the previous session. Your message was restored below.';
          setResumeError(message);
          onAgentBootstrapFailure?.(message);
        } else {
          setResumeError(`Could not start ${bootstrap.name} in this project.`);
        }
        console.error('[renderer] Agent bootstrap failed:', error);
      }
    });
  }, [
    bindActiveController,
    agentBootstrap,
    bootstrapRetryToken,
    panelId,
    onAgentBootstrapFailure,
    resumeBootstrap,
    sessionDead,
    sessionId,
  ]);

  const handleRun = useCallback((): void => {
    runText(command);
  }, [command, runText]);

  // The registry owns one stable registration for this mount. The current
  // snapshot/actions live behind a ref, so typing a draft no longer tears down
  // and re-registers the pane (which previously invalidated the whole App).
  useLayoutEffect(() => {
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
        sessionSurfaceBindingId: sessionSurfaceBindingRef.current?.bindingId ?? null,
        sessionSurfaceRole: sessionSurfaceBindingRef.current?.role ?? null,
        destroysSessionOnClose: sessionSurfaceBindingRef.current?.role === 'owner',
        activeRunIds: blocksRef.current
          .filter((entry) => entry.controller?.getSnapshot().status === 'running')
          .map((entry) => entry.id),
        executionKind: active?.executionKind ?? null,
        hasSshPrompt: active?.sshPrompt !== null && active?.sshPrompt !== undefined,
        activePty,
        activeCommand: activePty ? (activeController.current?.command ?? null) : null,
      };
    };
    paneHandleRef.current = {
      getSnapshot,
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
      focus: (): boolean => {
        const active = activeController.current?.getSnapshot();
        return focusPaneSurface(
          cmdInputRef.current,
          active?.status === 'running' && active.shape === 'pty',
        );
      },
    };
  }, [panelId, sessionId, currentCwd, history, command, activeRunning, sessionDead, runText]);

  useEffect(() => registerPane(panelId, {
    getSnapshot: () => paneHandleRef.current!.getSnapshot(),
    insertText: (text) => paneHandleRef.current?.insertText(text)
      ?? { ok: false, reason: 'unavailable' },
    runText: (text) => paneHandleRef.current?.runText(text)
      ?? { ok: false, reason: 'unavailable' },
    pasteToPty: (text) => paneHandleRef.current?.pasteToPty(text)
      ?? { ok: false, reason: 'unavailable' },
    focus: () => paneHandleRef.current?.focus() ?? false,
  }), [panelId]);

  // Only state rendered outside the pane invalidates registry subscribers.
  // Draft/history remain available synchronously through getSnapshot() when a
  // close or replacement command actually needs them.
  useLayoutEffect(() => {
    notifyPaneChanged(panelId);
  }, [activeRunning, currentCwd, panelId, sessionDead, sessionId]);

  // Mirror a run this pane did NOT start: adds a pending block, brokers the
  // `_ezAttachPort` handoff `attachRun` triggers, and binds the resulting
  // controller as active. Shared by two callers below — the edge-triggered
  // `onRunStarted` broadcast (M2 full mirroring: another pane/window/mobile
  // started a run in this pane's session) and the committed-session level-
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

  const handleCodexRecovery = useCallback(() => {
    activeController.current?.recoverCodexSession();
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

  const capturePaneContextMenuSource = useCallback(
    (target: EventTarget | null): PaneContextMenuSource => {
      const input = cmdInputRef.current;
      const draftSelectionStart = input?.selectionStart ?? command.length;
      const draftSelectionEnd = input?.selectionEnd ?? draftSelectionStart;
      const inputWasClicked = input !== null
        && target instanceof Node
        && (target === input || input.contains(target));
      return {
        kind: inputWasClicked ? 'input' : 'pane',
        selectedText: inputWasClicked
          ? command.slice(draftSelectionStart, draftSelectionEnd)
          : selectedTextWithin(paneRef.current),
        draftSelectionStart,
        draftSelectionEnd,
      };
    },
    [command],
  );

  const openPaneContextMenu = useCallback(
    (invocation: TerminalContextMenuInvocation, target: EventTarget | null): void => {
      setPaneContextMenu({
        invocation,
        source: capturePaneContextMenuSource(target),
      });
    },
    [capturePaneContextMenuSource],
  );

  const insertTextIntoDraft = useCallback(
    (text: string, source: PaneContextMenuSource): void => {
      setCommand((previous) => {
        const start = Math.max(0, Math.min(source.draftSelectionStart, previous.length));
        const end = Math.max(start, Math.min(source.draftSelectionEnd, previous.length));
        pendingDraftCaretRef.current = start + text.length;
        return `${previous.slice(0, start)}${text}${previous.slice(end)}`;
      });
    },
    [],
  );

  const requestPaneMenuPaste = useCallback(
    (source: PaneContextMenuSource): void => {
      if (activePlainPty) {
        pasteIntoActivePlainPty('default');
        return;
      }
      void pasteFromRuntimeClipboard(resolvedTerminalRuntimeOptions, {
        isCodex: false,
        mode: 'text',
        deliverImage: () => {},
        deliverText: (text) => insertTextIntoDraft(text, source),
      });
    },
    [
      activePlainPty,
      insertTextIntoDraft,
      pasteIntoActivePlainPty,
      resolvedTerminalRuntimeOptions,
    ],
  );

  const selectPaneOutput = useCallback((): void => {
    const output = blockListRef.current;
    const selection = output?.ownerDocument.defaultView?.getSelection();
    if (!output || !selection) return;
    const range = output.ownerDocument.createRange();
    range.selectNodeContents(output);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const paneContextMenuItems: TerminalContextMenuItem[] = paneContextMenu
    ? [
      {
        action: 'copy',
        label: t('terminalContext.copy'),
        shortcut: resolvedTerminalRuntimeOptions.platform === 'desktop'
          ? 'Ctrl+C / Ctrl+Shift+C / Ctrl+Insert'
          : undefined,
        disabled: paneContextMenu.source.selectedText === '',
        onClick: () => {
          const text = paneContextMenu.source.selectedText;
          if (text) void navigator.clipboard.writeText(text);
        },
      },
      {
        action: 'paste',
        label: t('terminalContext.paste'),
        shortcut: resolvedTerminalRuntimeOptions.platform === 'desktop' ? 'Ctrl+V' : undefined,
        onClick: () => requestPaneMenuPaste(paneContextMenu.source),
      },
      {
        action: 'select-all',
        label: t('terminalContext.selectAll'),
        onClick: () => {
          if (paneContextMenu.source.kind === 'input') {
            cmdInputRef.current?.select();
          } else {
            selectPaneOutput();
          }
        },
      },
    ]
    : [];

  const activeIsCodex = activeRunning
    && classifyDirectAgentCommand(activeController.current?.command ?? '') === 'codex';
  const activeCanRecoverCodex = activeIsCodex
    && resolvedTerminalRuntimeOptions.platform === 'desktop';

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
          setActiveCodexRecoveryPending(false);
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
      ref={paneRef}
      className={activeTakeover ? 'pane pane--tui-takeover' : 'pane'}
      data-testid="pane"
      data-session-id={sessionId ?? undefined}
      onContextMenu={(event) => {
        if (
          event.defaultPrevented
          || event.currentTarget.ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches
          || (
            event.target instanceof Element
            && event.target.closest('.terminal-context-menu')
          )
        ) {
          return;
        }
        event.preventDefault();
        openPaneContextMenu(
          captureTerminalContextMenuInvocation(
            event.currentTarget,
            event.clientX,
            event.clientY,
          ),
          event.target,
        );
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented
          || !isTerminalContextMenuKey(event.nativeEvent)
          || (
            event.target instanceof Element
            && event.target.closest('.terminal-context-menu')
          )
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const host = event.target instanceof HTMLElement ? event.target : event.currentTarget;
        openPaneContextMenu(keyboardTerminalContextMenuInvocation(host), event.target);
      }}
    >
      <div
        className="block-list"
        data-testid="block-list"
        ref={blockListRef}
        onScroll={onBlockListScroll}
        onClick={handleScreenClick}
      >
        {sessionBindingError && projectTarget && (
          <div className="agent-history-terminal__error" role="alert">
            <span>{t('terminalPane.projectSessionUnavailable')}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSessionBindingRetryToken((value) => value + 1)}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {resumeError && (
          <div className="agent-history-terminal__error" role="alert">
            <span>{resumeError}</span>
            {(agentBootstrap ?? resumeBootstrap)?.kind === 'new-chat' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setResumeError(null);
                  setBootstrapRetryToken((value) => value + 1);
                }}
              >
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
        <TerminalBlockEntries
          entries={blocks}
          activeTakeoverController={activeTakeover ? activeController.current : null}
          terminalRuntimeOptions={terminalRuntimeOptions}
          pendingLabel={t('terminalPane.starting')}
          onDismiss={handleDismiss}
        />
      </div>

      {/* The same decision the Agent Hub offers, in the pane the agent is
          actually running in — asking someone to switch panels to answer a
          question about the terminal they are looking at is the long way. */}
      {pendingApproval?.approval.pending && (
        <div
          className="pane-approval"
          data-risk={pendingApproval.approval.risk}
          data-testid="pane-approval"
          role="group"
          aria-label={t('agentHub.approvalPending')}
        >
          <span className="pane-approval-risk">
            {t(`agentHub.approvalRisk.${pendingApproval.approval.risk}`)}
          </span>
          <code className="pane-approval-command">
            {pendingApproval.approval.command ?? pendingApproval.approval.toolName}
          </code>
          <span className="pane-approval-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={!onDecideApproval}
              onClick={() => void onDecideApproval?.(
                pendingApproval.activityId,
                pendingApproval.approval.approvalId,
                'allow',
              )}
              data-testid="pane-approve"
            >
              {t('agentHub.approve')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={!onDecideApproval}
              onClick={() => void onDecideApproval?.(
                pendingApproval.activityId,
                pendingApproval.approval.approvalId,
                'deny',
              )}
              data-testid="pane-deny"
            >
              {t('agentHub.deny')}
            </Button>
          </span>
        </div>
      )}

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
            if (
              e.code === 'KeyK'
              && (e.ctrlKey || e.metaKey)
              && !e.altKey
              && !e.shiftKey
              && !e.nativeEvent.isComposing
            ) {
              // Readline parity while the composer is idle: kill from the
              // caret to end-of-line. During a live plain PTY the branch above
              // sends the real ^K byte instead.
              e.preventDefault();
              const input = e.currentTarget;
              const caret = input.selectionStart ?? command.length;
              setCommand(command.slice(0, caret));
              requestAnimationFrame(() => input.setSelectionRange(caret, caret));
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
        {activeCanRecoverCodex && (
          <button
            type="button"
            className="btn btn-recover"
            onClick={handleCodexRecovery}
            disabled={activeCodexRecoveryPending}
            title={t('terminalPane.recoverCodexDescription')}
            data-testid="btn-codex-recover"
          >
            {activeCodexRecoveryPending
              ? t('terminalPane.recoveringCodex')
              : t('terminalPane.recoverCodex')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-cancel"
          onClick={handleCancel}
          disabled={!activeRunning}
          data-testid="btn-cancel"
        >
          {activeIsCodex ? t('terminalPane.forceStop') : t('common.cancel')}
        </button>
      </div>
      {paneContextMenu && (
        <TerminalContextMenu
          x={paneContextMenu.invocation.x}
          y={paneContextMenu.invocation.y}
          items={paneContextMenuItems}
          ariaLabel={t('terminalContext.actionsLabel')}
          shortcutLabel={(shortcut) => t('terminalContext.shortcut', { shortcut })}
          ownerDocument={paneContextMenu.invocation.originPane?.ownerDocument}
          onClose={(detail) => closeTerminalContextMenu(
            paneContextMenu.invocation,
            detail,
            () => setPaneContextMenu(null),
            () => cmdInputRef.current?.focus(),
            detail.reason === 'action'
              && detail.action === 'select-all'
              && paneContextMenu.source.kind === 'pane'
              ? selectPaneOutput
              : undefined,
          )}
        />
      )}
    </div>
  );
}
