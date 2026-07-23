import { Browser } from '@capacitor/browser';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { BlockController } from '../../src/renderer/block-controller';
import { Block } from '../../src/renderer/Block';
import { registerPaneInput, unregisterPaneInput } from '../../src/renderer/pane-registry';
import { keyToPtyBytes } from '../../src/renderer/pty-keys';
import { TerminalContextMenu, type TerminalContextMenuItem } from '../../src/renderer/TerminalContextMenu';
import type { TerminalRuntimeOptions } from '../../src/renderer/xterm-runtime';
import type { RunStartedInfo } from '../../src/shared/ipc';
import type { FilePreviewResult } from '../../src/shared/file-preview';
import type { TerminalFileLocationResult } from '../../src/shared/terminal-file-location';
import { FilePreviewContent } from '../../src/renderer/FilePreviewContent';
import { normalizeExternalHttpUrl } from '../../src/shared/external-url';
import { useAppTranslation } from '../../src/renderer/i18n';
import { beforeInputTextForPty } from './composer-input';
import { installE2ETerminalOutputProbe } from './e2e-telemetry';
import { useLongPress } from './long-press';
import { appendToComposer, resolvePasteTarget } from './paste-routing';
import {
  closeRunPort,
  getRunPortBroker,
  RunPortError,
} from '../../src/renderer/run-port-broker';
import { MobileActionSheet } from './MobileActionSheet';
import { MobileQuickCommandSheet, type MobileQuickCommandSource } from './MobileQuickCommandSheet';
import { TouchInputBar } from './TouchInputBar';

const MOBILE_TERMINAL_RUNTIME_OPTIONS: TerminalRuntimeOptions = Object.freeze({
  platform: 'mobile',
  rendererPreference: 'dom',
  openExternalHttpUrl: (value: string) => {
    const url = normalizeExternalHttpUrl(value);
    if (url) void Browser.open({ url });
  },
});

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
// module doc). The session/header actions and ThemeMenu moved
// up to MobileWorkspace, which owns tabs/stats/theme for the whole authed
// shell; this view only owns the block list + input row + its own session-
// dead banner, and surfaces death upward via `onSessionDead` so the workspace
// can close this tab (MobileWorkspace.tsx's `handleSessionDead`).

interface BlockEntry {
  readonly id: string;
  readonly command: string;
  controller: BlockController | null;
}

type ResolvedTerminalPath = Extract<TerminalFileLocationResult, { ok: true }>;

interface TerminalPathPreview {
  readonly path: string;
  readonly result: FilePreviewResult;
  readonly line?: number;
  readonly column?: number;
}

export function MobileTerminalPathOverlay({
  action,
  preview,
  active = true,
  returnFocusRef,
  onCloseAction,
  onPreview,
  onCopyError,
  onClosePreview,
}: {
  readonly action: ResolvedTerminalPath | null;
  readonly preview: TerminalPathPreview | null;
  /** False while the owning terminal tab is preserved off-screen. */
  readonly active?: boolean;
  readonly returnFocusRef: RefObject<HTMLElement>;
  readonly onCloseAction: () => void;
  readonly onPreview: () => void;
  readonly onCopyError: () => void;
  readonly onClosePreview: () => void;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const activePath = preview?.path ?? action?.path;

  useLayoutEffect(() => {
    if (active || !activePath) return;
    if (preview) onClosePreview();
    else onCloseAction();
  }, [active, activePath, onCloseAction, onClosePreview, preview]);

  if (!active || !activePath) return null;

  const closePreviewAndRestoreFocus = (): void => {
    onClosePreview();
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  return (
    <MobileActionSheet
      title={preview ? t('mobile.terminalView.filePreview') : t('mobile.terminalView.fileActions')}
      description={preview ? undefined : activePath}
      onClose={preview ? onClosePreview : onCloseAction}
      returnFocusRef={returnFocusRef}
      closeLabel={t('common.cancel')}
      focusKey={preview ? `preview:${activePath}` : `actions:${activePath}`}
      showCloseButton={!preview}
      variant={preview ? 'fullscreen' : 'sheet'}
      className={preview ? 'terminal-path-preview mobile-file-viewer' : undefined}
      contentClassName={preview ? 'terminal-path-preview-content' : undefined}
      testId={preview ? 'terminal-path-preview' : 'terminal-path-action-sheet'}
      backdropTestId={preview ? 'terminal-path-preview-backdrop' : 'terminal-path-action-sheet-backdrop'}
    >
      {preview ? (
        <>
          <header className="mobile-file-head">
            <button
              type="button"
              className="btn btn-split"
              onClick={closePreviewAndRestoreFocus}
              data-testid="terminal-path-preview-back"
            >
              {t('common.back')}
            </button>
            <strong className="mobile-file-viewer-title" title={preview.path}>
              {preview.path.split(/[/\\]/).pop() || preview.path}
            </strong>
          </header>
          <FilePreviewContent
            result={preview.result}
            line={preview.line}
            column={preview.column}
            openExternalHttpUrl={MOBILE_TERMINAL_RUNTIME_OPTIONS.openExternalHttpUrl}
          />
        </>
      ) : action ? (
        <>
          <button
            type="button"
            className="mobile-action-sheet-row"
            onClick={onPreview}
            data-testid="terminal-path-preview-action"
          >
            {t('mobile.terminalView.preview')}
          </button>
          <button
            type="button"
            className="mobile-action-sheet-row"
            onClick={() => {
              void navigator.clipboard.writeText(action.path).then(() => {
                onCloseAction();
                requestAnimationFrame(() => returnFocusRef.current?.focus());
              }, onCopyError);
            }}
            data-testid="terminal-path-copy-action"
          >
            {t('mobile.terminalView.copyPath')}
          </button>
        </>
      ) : null}
    </MobileActionSheet>
  );
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
  active = true,
  quickCommandSource,
  quickCommandsSupported = false,
  connected = true,
  onSessionDead,
  onCwdChange,
}: {
  sessionId: string;
  /** Active workspace tab; inactive views remain mounted for PTY continuity. */
  active?: boolean;
  quickCommandSource?: MobileQuickCommandSource;
  quickCommandsSupported?: boolean;
  connected?: boolean;
  onSessionDead?: () => void;
  /** Best-effort cwd snapshot (file-explorer plan, M4) — mirrors desktop
   * TerminalPane's `setPaneCwd` call site (latest `end`, falling back to
   * `start`). MobileWorkspace records it in a map keyed by sessionId; Files
   * reads it ONCE at open, never live-follows it. */
  onCwdChange?: (sessionId: string, cwd: string) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [command, setCommand] = useState('');
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const draftBeforeRecall = useRef('');
  const activeController = useRef<BlockController | null>(null);
  const terminalPathSequenceRef = useRef(0);
  const [activeControllerForTouch, setActiveControllerForTouch] = useState<BlockController | null>(null);
  const [activeRunning, setActiveRunning] = useState(false);
  // Whether the active run is a RUNNING plain-mode `pty` block (M4, mirrors
  // desktop TerminalPane's identical flag): while true, cmd-input's
  // onKeyDown/onCompositionEnd below route keystrokes straight to the PTY
  // child instead of disabling the input, so a plain PTY program can be
  // driven from the physical/soft keyboard without TouchInputBar.
  const [activePlainPty, setActivePlainPty] = useState(false);
  // TUI takeover (TUI scroll parity, M2 — mirrors desktop TerminalPane's
  // `activeTakeover`): while the active run is a RUNNING xterm `pty`, the
  // shared `pane--tui-takeover` CSS (mobile-shared.css) hides sibling blocks and the
  // composer row and stretches the TUI to fill this view, so a touch drag
  // can't collide with block-list scrolling (PtyBlock's touch→wheel bridge
  // is gated to exactly this state).
  const [activeTakeover, setActiveTakeover] = useState(false);
  const activeUnsub = useRef<(() => void) | null>(null);
  const [sessionDead, setSessionDead] = useState(false);
  const [terminalPathAction, setTerminalPathAction] = useState<ResolvedTerminalPath | null>(null);
  const [terminalPathPreview, setTerminalPathPreview] = useState<TerminalPathPreview | null>(null);
  const [terminalPathError, setTerminalPathError] = useState<string | null>(null);
  const terminalPathReturnFocusRef = useRef<HTMLElement | null>(null);
  // Latest callback in a ref (not an effect dependency) so a fresh inline
  // closure from MobileWorkspace on every render doesn't churn the
  // subscribe/unsubscribe below.
  const onSessionDeadRef = useRef(onSessionDead);
  onSessionDeadRef.current = onSessionDead;
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  useLayoutEffect(() => {
    if (active) return;
    terminalPathSequenceRef.current += 1;
    setTerminalPathAction(null);
    setTerminalPathPreview(null);
    setTerminalPathError(null);
  }, [active]);

  const terminalRuntimeOptions = useMemo<TerminalRuntimeOptions>(() => ({
    ...MOBILE_TERMINAL_RUNTIME_OPTIONS,
    openTerminalFileLocation: (request, event) => {
      const eventTarget = event.target instanceof HTMLElement ? event.target : null;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      terminalPathReturnFocusRef.current = eventTarget?.closest<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? activeElement;
      terminalPathSequenceRef.current += 1;
      const sequence = terminalPathSequenceRef.current;
      void window.ezterminal.resolveTerminalFileLocation(request).then((result) => {
        if (sequence !== terminalPathSequenceRef.current) return;
        if (!result.ok) {
          const messages = {
            remote: t('mobile.terminalView.remotePath'),
            invalid: t('mobile.terminalView.invalidLocation'),
            'outside-workspace': t('mobile.terminalView.outsideWorkspace'),
            missing: t('mobile.terminalView.missing'),
            'not-file': t('mobile.terminalView.notFile'),
            unreadable: t('mobile.terminalView.unreadable'),
          } as const;
          setTerminalPathError(messages[result.reason]);
          return;
        }
        setTerminalPathError(null);
        setTerminalPathAction(result);
      }).catch(() => {
        if (sequence === terminalPathSequenceRef.current) {
          setTerminalPathError(t('mobile.terminalView.resolveFailed'));
        }
      });
    },
  }), [t]);

  const previewTerminalPath = useCallback(async (): Promise<void> => {
    const location = terminalPathAction;
    if (!location) return;
    const sequence = terminalPathSequenceRef.current;
    const result = await window.ezterminal.readFilePreview(location.path, location.capability).catch((): FilePreviewResult => ({
      ok: false,
      error: t('mobile.terminalView.previewLoadFailed'),
    }));
    if (sequence !== terminalPathSequenceRef.current) return;
    setTerminalPathAction(null);
    setTerminalPathPreview({
      path: location.path,
      result,
      line: location.line,
      column: location.column,
    });
  }, [t, terminalPathAction]);

  const blockListRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const blocksRef = useRef<BlockEntry[]>([]);
  blocksRef.current = blocks;
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
    abortPending('session-or-connection-change');
    if (!connected || sessionDead) {
      abortPending(sessionDead ? 'session-dead' : 'disconnect');
    }
    return () => abortPending('unmount');
  }, [connected, sessionDead, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A transient disconnect keeps drafts and views mounted, but a previously
  // focused xterm must not appear to accept bytes that cannot reach the host.
  useEffect(() => {
    if (connected) return;
    const pendingRunIds = new Set(pendingHandoffRunIdsRef.current);
    pendingHandoffRunIdsRef.current.clear();
    for (const runId of pendingRunIds) knownRunIdsRef.current.delete(runId);
    setBlocks((previous) => previous.filter((entry) => !pendingRunIds.has(entry.id)));
    const focused = document.activeElement as HTMLElement | null;
    if (focused && blockListRef.current?.contains(focused)) focused.blur();
  }, [connected]);

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
      for (const controller of handoffAbortByRunRef.current.values()) {
        controller.abort('session-dead');
      }
      handoffAbortByRunRef.current.clear();
      const pendingRunIds = new Set(pendingHandoffRunIdsRef.current);
      pendingHandoffRunIdsRef.current.clear();
      for (const runId of pendingRunIds) knownRunIdsRef.current.delete(runId);
      setBlocks((previous) => previous.filter((entry) => !pendingRunIds.has(entry.id)));
      setSessionDead(true);
      setActivePlainPty(false);
      setActiveTakeover(false);
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
      setCommand((prev) => appendToComposer(prev, text));
    });
    return () => unregisterPaneInput(sessionId);
  }, [sessionId]);

  // Android UI automation has no DOM access. In E2E mode this mirrors rendered
  // output to logcat; production replaces the flag with false and removes the
  // observer branch and terminal contents from the bundle entirely.
  useEffect(() => {
    return installE2ETerminalOutputProbe(blockListRef.current);
  }, []);

  useLayoutEffect(() => {
    if (stickToBottom.current) scrollBlockListToBottom();
  }, [blocks, scrollBlockListToBottom]);

  // Dispose every controller on unmount (switching sessions, or navigating
  // back) so the interpreter releases their stores. Unlike TerminalPane, there
  // is no session destroy here — SessionSwitcher owns that lifecycle.
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

  // Bind a run's controller as this view's ACTIVE one — shared by a run this
  // view itself started (handleRun below) and one it's MIRRORING (another
  // origin's run in this SAME session, see the onRunStarted effect below):
  // mirrors desktop TerminalPane's identical `bindActiveController` split (M2).
  const bindActiveController = useCallback(
    (controller: BlockController): void => {
      activeController.current = controller;
      setActiveControllerForTouch(controller);
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
        // cwd snapshot (M4): mirrors desktop TerminalPane's same site — latest
        // `end`, falling back to `start`, so a `cd` is reflected.
        const cwd = snap.endCwd ?? snap.startCwd;
        if (cwd) onCwdChangeRef.current?.(sessionId, cwd);
        if (stickToBottom.current) requestAnimationFrame(scrollBlockListToBottom);
      };
      activeUnsub.current = controller.subscribe(onActiveChange);
      onActiveChange();
    },
    [sessionId, scrollBlockListToBottom],
  );

  const runText = useCallback((requestedText: string) => {
    if (!connected || sessionDead || activeRunning) return;
    const text = requestedText.trim();
    if (!text) return;
    const runId = nextRunId();
    const handoffController = new AbortController();
    const handoffSignal = handoffController.signal;
    handoffAbortByRunRef.current.set(runId, handoffController);

    stickToBottom.current = true;
    setHistory((prev) => [...prev, text]);
    historyIndex.current = null;
    draftBeforeRecall.current = '';
    setCommand('');

    setBlocks((prev) => [...prev, { id: runId, command: text, controller: null }]);

    knownRunIdsRef.current.add(runId);
    pendingHandoffRunIdsRef.current.add(runId);
    void getRunPortBroker().request({
      kind: 'run',
      runId,
      signal: handoffSignal,
      send: () => window.ezterminal.runCommand(text, runId, sessionId),
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
        const controller = new BlockController(text, port);
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
        console.error('[mobile] failed to bind cmd-port:', error);
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
      console.error('[mobile] runCommand failed:', error);
    });
  }, [connected, sessionId, sessionDead, activeRunning, bindActiveController]);

  const handleRun = useCallback(() => {
    runText(command);
  }, [command, runText]);

  // Mirror a run this view did NOT start — shared by two triggers: the
  // edge-triggered `onRunStarted` broadcast below (a run beginning THIS
  // instant) and the level-triggered mount effect further down (a run
  // already in flight when this view mounts). `knownRunIdsRef` is updated
  // synchronously before transport I/O, so self-echo and concurrent catch-up
  // cannot create duplicate attach requests before React commits the block.
  const attachToRun = useCallback(
    (info: RunStartedInfo): void => {
      if (knownRunIdsRef.current.has(info.runId)) return; // already handled
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
          const controller = new BlockController(info.commandText, port, { mirror: true });
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
          console.error('[mobile] failed to bind attach-port:', error);
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
        console.error('[mobile] attachRun failed:', error);
      });
    },
    [bindActiveController],
  );

  // Edge-triggered mirroring (M2 full mirroring, T2.4 "AC5/AC6"): the desktop
  // (or another mobile tab) may start a run in this SAME session — sessions
  // are shared, not exclusively owned by whichever surface created them.
  // `onRunStarted` is an unconditional broadcast, including this view's OWN
  // runs (self-echo) — `attachToRun`'s known-run check tells "mine, already
  // handled" apart from "someone else's, attach".
  useEffect(() => {
    const unsub = window.ezterminal.onRunStarted((info: RunStartedInfo) => {
      if (info.sessionId !== sessionId) return; // not my session
      attachToRun(info);
    });
    return unsub;
  }, [sessionId, attachToRun]);

  // Level-triggered mirroring (M3): `onRunStarted` above only fires the
  // instant a run begins, so a run already in flight when this view mounts
  // (session switch, tab reopen) would otherwise show nothing. `listRuns()`
  // is the level-triggered counterpart — query what's active right now and
  // attach to anything in this session not already covered. A reconnect
  // re-runs this catch-up after the disconnected generation was aborted.
  useEffect(() => {
    if (!connected || sessionDead) return;
    let cancelled = false;
    void window.ezterminal.listRuns().then((runs) => {
      if (cancelled) return;
      for (const run of runs) {
        if (run.sessionId !== sessionId) continue;
        attachToRun(run);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connected, sessionDead, sessionId, attachToRun]);

  const handleCancel = useCallback(() => {
    activeController.current?.cancel();
  }, []);

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
          setActiveControllerForTouch(null);
          setActiveRunning(false);
          setActivePlainPty(false);
          setActiveTakeover(false);
        }
        entry.controller.dispose();
      }
      return prev.filter((e) => e.id !== id);
    });
  }, []);

  // Long-press → Copy/Paste/Select All (WT-parity M3): the desktop analogue
  // is a right-click (PtyBlock.tsx's `TerminalContextMenu`), which a touch
  // WebView has no equivalent for — `useLongPress` (file-explorer plan, M4)
  // fires this same `.block-list` container's press instead. Paste is
  // clipboard-read, so its routing (running PTY vs. idle composer draft) is
  // decided in `paste-routing.ts`, pure and unit-tested there.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPress((x, y) => setMenu({ x, y }));

  const menuItems: TerminalContextMenuItem[] = [
    {
      action: 'paste',
      label: t('mobile.terminalView.paste'),
      onClick: () => {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            const target = resolvePasteTarget(activeController.current?.getSnapshot() ?? null);
            if (target === 'pty') {
              // pasteText, not sendPtyInput: an xterm-upgraded child (claude/
              // codex enable bracketed paste) must receive ESC[200~…201~
              // framing and \n→\r normalization, or a multi-line paste
              // submits line-by-line as raw Enters.
              activeController.current?.pasteText(text);
            } else {
              setCommand((prev) => appendToComposer(prev, text));
            }
          })
          .catch((err: unknown) => console.error('[mobile] clipboard read failed:', err));
      },
    },
    {
      action: 'copy',
      label: t('mobile.terminalView.copy'),
      disabled: window.getSelection()?.isCollapsed ?? true,
      onClick: () => {
        const text = window.getSelection()?.toString();
        if (text) void navigator.clipboard.writeText(text);
      },
    },
    {
      action: 'select-all',
      label: t('mobile.terminalView.selectAll'),
      onClick: () => {
        const el = blockListRef.current;
        const sel = window.getSelection();
        if (!el || !sel) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      },
    },
  ];

  return (
    <div
      className={
        [
          'pane mobile-session-view',
          activeTakeover ? 'pane--tui-takeover' : '',
          connected ? '' : 'mobile-session-view--offline',
        ].filter(Boolean).join(' ')
      }
      data-testid="mobile-session-view"
    >
      {sessionDead && (
        <div className="mobile-session-dead-banner" data-testid="session-dead-banner">
          {t('mobile.terminalView.connectionLost')}
        </div>
      )}

      <div
        className="block-list"
        data-testid="block-list"
        ref={blockListRef}
        onScroll={() => {
          onBlockListScroll();
          longPress.onScroll();
        }}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        onContextMenu={longPress.onContextMenu}
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
              <div className="block-pending">{t('mobile.terminalView.starting')}</div>
            </section>
          ),
        )}
      </div>

      {menu && <TerminalContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {terminalPathError && (
        <div className="terminal-path-mobile-error" role="status">
          <span>{terminalPathError}</span>
          <button type="button" className="btn btn-split" onClick={() => setTerminalPathError(null)}>{t('mobile.terminalView.dismiss')}</button>
        </div>
      )}

      <MobileTerminalPathOverlay
        action={terminalPathAction}
        preview={terminalPathPreview}
        active={active}
        returnFocusRef={terminalPathReturnFocusRef}
        onCloseAction={() => setTerminalPathAction(null)}
        onPreview={() => void previewTerminalPath()}
        onCopyError={() => setTerminalPathError(t('mobile.terminalView.copyFailed'))}
        onClosePreview={() => setTerminalPathPreview(null)}
      />

      <TouchInputBar controller={activeControllerForTouch} connected={connected} />

      <div className="cmd-row">
        <span className="prompt-sigil prompt-sigil--input" aria-hidden="true">
          ❯
        </span>
        <input
          className="cmd-input"
          value={command}
          // Disabled while a run is active UNLESS it's a plain PTY (M4,
          // mirrors desktop TerminalPane): a plain run routes its keystrokes
          // here straight to the PTY child (onKeyDown/onCompositionEnd
          // below) instead of disabling input, so a running plain program
          // can be driven from the physical/soft keyboard. Any other running
          // shape (xterm-upgraded, non-pty) keeps the input disabled, same
          // as before.
          disabled={sessionDead || (activeRunning && (!activePlainPty || !connected))}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (activePlainPty) {
              // IME composing (CJK / dead-key input): let the input compose
              // normally — see desktop TerminalPane's identical guard.
              if (e.nativeEvent.isComposing || e.key === 'Process') return;
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
          onBeforeInput={(e) => {
            if (!activePlainPty) return; // idle: default typing-into-draft behavior
            // Android soft keyboards deliver most non-composition commits as
            // `beforeinput` with keydown 229, which the keyToPtyBytes path
            // above can't route — see composer-input.ts.
            const text = beforeInputTextForPty(e.nativeEvent as InputEvent);
            if (text === null) return;
            e.preventDefault();
            activeController.current?.sendPtyInput(text);
          }}
          onPaste={(e) => {
            // Desktop parity (TerminalPane.tsx's identical handler): a paste
            // into the composer during a plain PTY run goes to the child, not
            // the draft.
            if (!activePlainPty) return; // idle: default paste-into-input behavior
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (text) activeController.current?.sendPtyInput(text);
          }}
          onCompositionEnd={(e) => {
            if (!activePlainPty) return; // idle: default composition-into-draft behavior
            if (e.data) activeController.current?.sendPtyInput(e.data);
            setCommand(''); // clear what the browser composed into the input
          }}
          aria-label={t('mobile.terminalView.commandInput')}
          data-testid="cmd-input"
        />
        {quickCommandSource && (
          <MobileQuickCommandSheet
            source={quickCommandSource}
            supported={quickCommandsSupported}
            connected={connected}
            active={active}
            insertDisabledReason={sessionDead ? t('mobile.terminalView.sessionEnded') : undefined}
            runDisabledReason={
              sessionDead
                ? t('mobile.terminalView.sessionEnded')
                : activeRunning
                  ? t('mobile.terminalView.waitForCommand')
                  : command.trim()
                    ? t('mobile.terminalView.clearDraft')
                    : undefined
            }
            onInsert={(text) => setCommand((previous) => appendToComposer(previous, text))}
            onRun={runText}
          />
        )}
        <button
          type="button"
          className="btn btn-run"
          onClick={handleRun}
          disabled={!connected || sessionDead || activeRunning}
          data-testid="btn-run"
        >
          {t('mobile.terminalView.run')}
        </button>
        <button
          type="button"
          className="btn btn-cancel"
          onClick={handleCancel}
          disabled={!activeRunning}
          data-testid="btn-cancel"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
