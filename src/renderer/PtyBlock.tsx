import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { BlockController } from './block-controller';
import { resolveFontFamily } from './fonts';
import { getActiveScrollback } from './scrollback';
import { getUserFontId } from './theme-runtime';
import { getActiveTheme } from './themes';
import { getActiveUiScale } from './ui-scale';
import { PtyControlChip } from './PtyControlChip';
import {
  isTerminalContextMenuKey,
  mayRestoreTerminalContextMenuFocus,
  TerminalContextMenu,
  type TerminalContextMenuCloseDetail,
  type TerminalContextMenuItem,
} from './TerminalContextMenu';
import { TerminalFindBar } from './TerminalFindBar';
import { findTerminalFileLinkAtOffset } from '../shared/terminal-file-location';
import {
  acceptOsc52ClipboardWrite,
  Osc52WriteGate,
  TerminalSideEffectSuppression,
} from './osc52';
import { QUERY_CARRY_CHARS, containsTerminalQuery } from './pty-query-gate';
import { TouchScrollAccumulator } from './touch-scroll';
import { attachXtermImeHygiene } from './xterm-ime-hygiene';
import {
  DEFAULT_TERMINAL_RUNTIME_OPTIONS,
  XtermRuntime,
  type TerminalRuntimeOptions,
  type TerminalSearchResults,
} from './xterm-runtime';

// PtyBlock — the render surface for a `pty`-shape block. Execution is ALWAYS a
// live PTY (any single, non-piped external command, or `!cmd`); render is
// ADAPTIVE (Phase 3): `plain` (buffered text + ansi->html, input wired via a
// minimal keyset — matches a text block's UX) is the default, upgrading ONCE
// and IRREVERSIBLY to a full `xterm` terminal on `!cmd` (forceXterm) or the
// interpreter's first high-confidence TUI signal (`pty-render-upgrade` frame,
// see pty-session.ts's TuiSignalDetector). This top-level component just reads
// the mode and dispatches — each mode's mount/teardown lives in its own
// sub-component so switching modes is an ordinary React remount.
export interface PtyBlockProps {
  readonly controller: BlockController;
  readonly runtimeOptions?: TerminalRuntimeOptions;
}

export function PtyBlock({
  controller,
  runtimeOptions = DEFAULT_TERMINAL_RUNTIME_OPTIONS,
}: PtyBlockProps): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (snapshot.ptyRenderMode === 'xterm') {
    return <PtyXtermView controller={controller} runtimeOptions={runtimeOptions} />;
  }
  return <PtyPlainView controller={controller} runtimeOptions={runtimeOptions} />;
}

// ── xterm view (control handoff, M8b: control is now DYNAMIC) ───────────────
//
// B3: the parent (Block.tsx) keeps a `pty`-shape block mounted while collapsed
// (hidden via CSS) so collapsing never destroys a live xterm terminal or drops
// output — disposed only when the block is dismissed/closed (unmount).

/** The xterm font size derived from the active theme + UI scale — the size a
 * controlling view renders at, and the ceiling `applyMirrorLayout` (below)
 * scales down from for a non-controlling view. Module-level, not a
 * component-body closure, so every effect that needs it computes the same
 * thing without threading it through refs. */
function computeBaseFontSize(): number {
  const activeTheme = getActiveTheme();
  return Math.round((activeTheme.fontSize * getActiveUiScale()) / 100);
}

const EMPTY_SEARCH_RESULTS: TerminalSearchResults = Object.freeze({ resultIndex: -1, resultCount: 0 });

interface TerminalMenuInvocation {
  readonly x: number;
  readonly y: number;
  readonly invoker: HTMLElement | null;
  readonly originPane: Element | null;
}

function captureTerminalMenuInvocation(
  host: HTMLElement,
  x: number,
  y: number,
): TerminalMenuInvocation {
  const originPane = host.closest('.pane');
  const active = document.activeElement;
  return {
    x,
    y,
    invoker: active instanceof HTMLElement && originPane?.contains(active) ? active : null,
    originPane,
  };
}

function keyboardTerminalMenuInvocation(host: HTMLElement): TerminalMenuInvocation {
  const rect = host.getBoundingClientRect();
  return captureTerminalMenuInvocation(
    host,
    rect.left + Math.min(24, Math.max(8, rect.width / 2)),
    rect.top + Math.min(24, Math.max(8, rect.height / 2)),
  );
}

function closeTerminalMenu(
  invocation: TerminalMenuInvocation,
  detail: TerminalContextMenuCloseDetail,
  clear: () => void,
  fallbackFocus: () => void,
): void {
  const shouldRestore = mayRestoreTerminalContextMenuFocus(invocation.originPane, detail);
  clear();
  if (!shouldRestore) return;
  requestAnimationFrame(() => {
    if (!mayRestoreTerminalContextMenuFocus(invocation.originPane, detail)) return;
    const active = document.activeElement;
    if (
      active !== null
      && active !== document.body
      && active !== invocation.invoker
      && !active.closest('.terminal-context-menu')
    ) {
      return;
    }
    if (invocation.invoker?.isConnected) invocation.invoker.focus();
    else fallbackFocus();
  });
}

function PtyXtermView({
  controller,
  runtimeOptions,
}: {
  controller: BlockController;
  runtimeOptions: TerminalRuntimeOptions;
}): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const runtimeRef = useRef<XtermRuntime | null>(null);
  const openExternalHttpUrlRef = useRef(runtimeOptions.openExternalHttpUrl);
  openExternalHttpUrlRef.current = runtimeOptions.openExternalHttpUrl;
  const rendererPreferenceRef = useRef(runtimeOptions.rendererPreference);
  rendererPreferenceRef.current = runtimeOptions.rendererPreference;
  const allowOsc52ClipboardRef = useRef(Boolean(runtimeOptions.allowOsc52Clipboard));
  allowOsc52ClipboardRef.current = Boolean(runtimeOptions.allowOsc52Clipboard);
  const writeClipboardTextRef = useRef(runtimeOptions.writeClipboardText);
  writeClipboardTextRef.current = runtimeOptions.writeClipboardText;
  const openTerminalFileLocationRef = useRef(runtimeOptions.openTerminalFileLocation);
  openTerminalFileLocationRef.current = runtimeOptions.openTerminalFileLocation;
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findResults, setFindResults] = useState<TerminalSearchResults>(EMPTY_SEARCH_RESULTS);
  const linkHandlingEnabled = Boolean(runtimeOptions.openExternalHttpUrl);
  const terminalFileLinksEnabled = Boolean(runtimeOptions.openTerminalFileLocation);

  // Latest-value ref (M8b): the mount effect's callbacks (ResizeObserver,
  // ez:refit, the pty-data sink's auto-reply gate) are created once and must
  // still see the CURRENT control state whenever they later fire — control
  // moves independently of this component re-rendering. Mutated during
  // render (not inside an effect) so it is current before any effect for
  // this commit runs.
  const hasControlRef = useRef(snapshot.hasControl);
  hasControlRef.current = snapshot.hasControl;

  // Right-click context menu (WT-parity M2) — position of the triggering
  // `contextmenu` event, or null when closed.
  const [menuPos, setMenuPos] = useState<TerminalMenuInvocation | null>(null);
  const openKeyboardMenuRef = useRef<() => void>(() => {});
  openKeyboardMenuRef.current = () => {
    const host = containerRef.current;
    if (host) setMenuPos(keyboardTerminalMenuInvocation(host));
  };

  // The mount effect (re)creates these per mount, closing over that mount's
  // `term`/`fit`/`el` — routed through refs so the hasControl/ptyDims effects
  // further down can call the CURRENT mount's versions.
  const fitAndReportRef = useRef<() => void>(() => {});
  const applyMirrorLayoutRef = useRef<() => void>(() => {});

  // On exit (status leaves 'running'): the pane's TUI takeover releases (T1,
  // TerminalPane.tsx), and — mirroring PtyPlainView's existing exit-focus
  // pattern below — hand focus back to this pane's cmd-input so the next
  // command can be typed without a click. rAF gives the takeover's release
  // (cmd-input goes from hidden+disabled to shown+enabled) a tick to commit.
  useEffect(() => {
    if (snapshot.status === 'running') return;
    const pane = containerRef.current?.closest('.pane');
    const cmdInput = pane?.querySelector<HTMLInputElement>('.cmd-input');
    if (!cmdInput) return;
    const raf = requestAnimationFrame(() => cmdInput.focus());
    return () => cancelAnimationFrame(raf);
  }, [snapshot.status]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const initialTheme = getActiveTheme();
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: resolveFontFamily(getUserFontId(), initialTheme),
      fontSize: computeBaseFontSize(),
      cursorBlink: true,
      scrollback: getActiveScrollback(),
      theme: initialTheme.xterm,
    });
    const osc52Gate = new Osc52WriteGate();
    const sideEffectSuppression = new TerminalSideEffectSuppression();
    const osc52Disposable = term.parser.registerOscHandler(52, (payload) => {
      if (!allowOsc52ClipboardRef.current || !writeClipboardTextRef.current) return true;
      const text = acceptOsc52ClipboardWrite(payload, osc52Gate, sideEffectSuppression.active);
      if (text === null) return true;
      void Promise.resolve(writeClipboardTextRef.current(text)).catch(() => undefined);
      return true;
    });
    termRef.current = term;

    // FitAddon is ALWAYS loaded now (M8b) — a non-controlling view can later
    // claim control and needs it to report its own size at that point
    // (`fitAndReport` below); while not in control it is simply never called.
    const runtime = new XtermRuntime(
      term,
      el,
      {
        platform: runtimeOptions.platform,
        rendererPreference: rendererPreferenceRef.current,
        openExternalHttpUrl: linkHandlingEnabled
          ? (url) => openExternalHttpUrlRef.current?.(url)
          : undefined,
        openTerminalFileLocation: terminalFileLinksEnabled
          ? (request, event) => openTerminalFileLocationRef.current?.(request, event)
          : undefined,
        getTerminalFileContext: () => {
          const current = controller.getSnapshot();
          return { cwd: current.startCwd, executionKind: current.executionKind };
        },
      },
      { onSearchResults: setFindResults },
    );
    runtime.open();
    runtimeRef.current = runtime;
    const fit = runtime.fitAddon;
    // e2e/diagnostic seam (same spirit as block-controller's window.__ezPtyFlow):
    // expose the live Terminal on its container so tests can read PUBLIC xterm
    // state (modes.mouseTrackingMode, buffer.active.type) without new IPC.
    (el as HTMLDivElement & { __ezTerm?: Terminal }).__ezTerm = term;

    // Copy/paste shortcuts (WT-parity M2) — xterm's own key handler, so
    // everything else (Ctrl+C interrupt, arrows, ...) passes through
    // untouched (return true). Ctrl+Shift+C copies the current selection;
    // Ctrl+Shift+V pastes (term.paste applies bracketed-paste framing itself
    // when the child enabled it).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && isTerminalContextMenuKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        openKeyboardMenuRef.current();
        return false;
      }
      if (
        e.type === 'keydown' &&
        e.code === 'KeyF' &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        setFindOpen(true);
        return false;
      }
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
        e.preventDefault(); // suppress Chromium's dev-only Ctrl+Shift+C (inspect element)
        return false;
      }
      if (e.code === 'KeyV') {
        void navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        e.preventDefault();
        return false;
      }
      return true;
    });

    // In control: report OUR size to the interpreter — this is what claiming
    // control actually accomplishes (the shared PTY resizes to us). A no-op
    // while some other port holds control, so every caller below can stay
    // wired unconditionally instead of branching on control state itself.
    const fitAndReport = (): void => {
      if (!hasControlRef.current) return;
      try {
        fit.fit();
      } catch {
        // Container not measurable yet (e.g. briefly hidden) — skip this tick.
        return;
      }
      // Suppress resize sends for a zero / unmeasurable box (e.g. a dockview tab that
      // is hidden with no laid-out size) — a bogus 0×0 grid would corrupt the PTY (B7).
      if (term.cols > 0 && term.rows > 0) controller.sendPtyResize(term.cols, term.rows);
    };

    // NOT in control: render the controlling port's grid (`ptyDims`, replayed
    // on attach / updated on every authority resize) shrunk to fit this box
    // instead of reflowing it, so a wide TUI stays legible rather than
    // wrapping. `term.resize` sets the grid dimensions; the font size is then
    // scaled down from the base size until the rendered grid's actual pixel
    // width fits the container.
    const applyMirrorLayout = (): void => {
      const dims = controller.getSnapshot().ptyDims ?? { cols: 80, rows: 24 };
      const base = computeBaseFontSize();
      term.options.fontSize = base;
      term.resize(dims.cols, dims.rows);

      const screenEl = el.querySelector<HTMLElement>('.xterm-screen');
      const containerWidth = el.clientWidth;
      if (!screenEl || containerWidth <= 0) return; // not measurable yet — skip this tick
      const screenWidth = screenEl.getBoundingClientRect().width;
      if (screenWidth <= 0) return;

      let size = Math.min(base, Math.max(6, Math.floor(base * (containerWidth / screenWidth))));
      term.options.fontSize = size;
      // Correction loop: the scale factor above is measured at the BASE size,
      // so rounding can still leave the grid a hair too wide — step down
      // until it actually fits (or bottoms out at the floor).
      while (size > 6 && screenEl.getBoundingClientRect().width > containerWidth) {
        size -= 1;
        term.options.fontSize = size;
      }
    };

    fitAndReportRef.current = fitAndReport;
    applyMirrorLayoutRef.current = applyMirrorLayout;

    // Lay out to the real size BEFORE registering the sink — this also covers
    // the plain->xterm upgrade case (Phase 3): the buffered plain-mode
    // history replays at the right size, not the PTY's 80x24 spawn default
    // (interpreter-process.ts's PTY_INITIAL_COLS/ROWS). Control state is read
    // fresh off the controller, not the render closure that scheduled this
    // effect, since this effect only runs once per mount.
    if (controller.getSnapshot().hasControl) {
      fitAndReport();
    } else {
      applyMirrorLayout();
    }
    term.focus();

    // PTY output → xterm. setPtyDataSink flushes any bytes buffered before mount
    // (Phase 2: pre-mount bytes; Phase 3: the ENTIRE plain-mode history on an
    // upgrade). The write callback drives the backpressure ack (Stage C): the
    // interpreter pauses the PTY when the renderer falls too far behind flushes.
    //
    // Auto-reply suppression (VERIFIED on a live emulator, M6 — gate moved
    // from the fixed `controller.isMirror` to live control state, M8b): xterm
    // answers terminal queries (DA `ESC[c`, DSR/CPR, ...) by emitting the
    // response through onData while it PARSES the incoming bytes. Whoever
    // holds control owns those responses; a non-controlling view re-answering
    // queries it merely replays (the ring holds the original DA query from
    // session start) or tees live injects duplicate responses into the SHARED
    // PTY as input — observed corrupting the next typed command into
    // `^[[?1;2cecho ...`. Gating on `hasControlRef` instead of `isMirror`
    // means a demoted ex-primary stops double-answering once it loses
    // control, and a promoted view is allowed to answer once it becomes the
    // authority. Auto-replies fire synchronously inside write() parsing, so
    // "onData while a non-controlling write is in flight" identifies them; a
    // phone keystroke landing inside that brief window is dropped, which is
    // the right trade against corrupting everyone's input stream.
    // Gate refinement (TUI scroll parity, 2026-07-12): arming the gate for
    // EVERY mirror write assumed brief in-flight windows, but a claude-class
    // fullscreen TUI repaints continuously (spinner/HUD animation), keeping a
    // write in flight almost permanently — which swallowed essentially ALL
    // input from a non-controlling phone mirror (touch-scroll mouse reports
    // and keys alike; verified on the emulator). Only a write that CARRIES a
    // terminal query can make xterm emit an auto-reply, so only those writes
    // arm the gate (pty-query-gate.ts) — the ring-replayed session-start DA
    // query, the case the gate exists for, still arms it. `queryCarry`
    // stitches queries split across chunk boundaries (same carry technique as
    // the interpreter's TuiSignalDetector).
    let mirrorWritesInFlight = 0;
    let queryCarry = '';
    const latin1 = new TextDecoder('latin1');
    const writeToXterm = (
      bytes: Uint8Array,
      onFlushed: () => void,
      suppressSideEffects: boolean,
      suppressMirrorAutoReplies: boolean,
    ): void => {
      const releaseSideEffectSuppression = suppressSideEffects
        ? sideEffectSuppression.enter()
        : null;
      if (suppressMirrorAutoReplies) mirrorWritesInFlight++;
      try {
        term.write(bytes, () => {
          if (suppressMirrorAutoReplies) mirrorWritesInFlight--;
          releaseSideEffectSuppression?.();
          onFlushed();
        });
      } catch (error) {
        if (suppressMirrorAutoReplies) mirrorWritesInFlight--;
        releaseSideEffectSuppression?.();
        throw error;
      }
    };
    const unsink = controller.setPtyDataSink((bytes, onFlushed, metadata) => {
      if (hasControlRef.current) {
        writeToXterm(bytes, onFlushed, metadata.suppressSideEffects, false);
        return;
      }
      const text = queryCarry + latin1.decode(bytes);
      queryCarry = text.slice(-QUERY_CARRY_CHARS);
      if (!containsTerminalQuery(text)) {
        writeToXterm(bytes, onFlushed, metadata.suppressSideEffects, false);
        return;
      }
      writeToXterm(bytes, onFlushed, metadata.suppressSideEffects, true);
    });
    const unregisterReplayReset = controller.setPtyReplayResetHandler(() => {
      term.reset();
      runtime.clearSearch();
    });
    // Keystrokes / pasted text → PTY child (attach ports support input too).
    const dataDisposable = term.onData((data) => {
      if (mirrorWritesInFlight > 0) return; // auto-reply, not a user — see above
      controller.sendPtyInput(data);
    });
    // Soft-keyboard duplication fix: empty the helper textarea after every
    // commit so an IME (Samsung keyboard / Gboard) never keeps committed text
    // as rewritable context — see xterm-ime-hygiene.ts for the full mechanism.
    const imeHygiene = attachXtermImeHygiene(term);
    // Mobile long-press Paste (MobileSessionView) routes through here so the
    // text gets bracketed-paste framing / \n→\r normalization when the child
    // enabled it — same term.paste path the context-menu Paste below uses.
    const unregisterPaste = controller.setPasteHandler((text) => term.paste(text));

    // Touch → wheel bridge (TUI scroll parity, M3): xterm 6 has NO touch
    // handling (its vs/ scrollable element only listens for 'wheel'), so a
    // touch drag over a TUI did nothing at all. Re-emit the drag as synthetic
    // WheelEvents on the xterm screen — one per whole cell of drag distance —
    // so the scroll intent funnels through xterm's OWN wheel decision tree:
    // mouse reports when the child enabled tracking (claude), the standard
    // arrow-key fallback otherwise (vim parity), viewport scroll on the
    // normal buffer. No protocol logic is duplicated here. Gated to an active
    // pane takeover: outside it (mobile block-list), a drag must keep
    // scrolling the LIST natively, not the embedded 360px terminal.
    const touchAcc = new TouchScrollAccumulator();
    let lastTouchY: number | null = null;
    const onTouchStart = (ev: TouchEvent): void => {
      if (ev.touches.length !== 1 || !el.closest('.pane--tui-takeover')) {
        lastTouchY = null;
        return;
      }
      touchAcc.reset();
      lastTouchY = ev.touches[0].clientY;
    };
    const onTouchMove = (ev: TouchEvent): void => {
      if (lastTouchY === null || ev.touches.length !== 1) return;
      if (!el.closest('.pane--tui-takeover')) return;
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      if (!screen) return;
      // This drag IS terminal scrolling — keep native/list panning out of it.
      ev.preventDefault();
      const touch = ev.touches[0];
      const dy = lastTouchY - touch.clientY; // finger up = wheel down (natural scrolling)
      lastTouchY = touch.clientY;
      const rect = screen.getBoundingClientRect();
      const cell = term.rows > 0 ? rect.height / term.rows : 0;
      const steps = touchAcc.feed(dy, cell);
      if (steps === 0) return;
      // Clamp the report coordinates into the screen box — a drag can wander
      // outside it, and mouse-report cell coords must stay on the grid.
      const x = Math.min(Math.max(touch.clientX, rect.left), rect.right - 1);
      const y = Math.min(Math.max(touch.clientY, rect.top), rect.bottom - 1);
      const dir = steps > 0 ? 1 : -1;
      for (let i = 0; i < Math.abs(steps); i++) {
        screen.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: dir * cell,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    };
    const onTouchEnd = (): void => {
      lastTouchY = null;
      touchAcc.reset();
    };
    // Native listeners, touchmove NON-passive: React's synthetic touch events
    // are passive-by-default and cannot preventDefault the browser scroll.
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    // Keep the grid synced to the rendered size (incl. collapse→expand):
    // dispatch to whichever layout applies for the CURRENT control state.
    const relayout = (): void => {
      if (hasControlRef.current) fitAndReport();
      else applyMirrorLayout();
    };
    const observer = new ResizeObserver(() => relayout());
    observer.observe(el);
    // A dockview tab re-shown via renderer:'always' keeps its layout size, so the
    // ResizeObserver does NOT fire on show — refit explicitly on the host's signal (B7).
    const onRefit = (): void => relayout();
    window.addEventListener('ez:refit', onRefit);

    // Theme switch (E1) and UI scale change (v0.2.0 D1) while this PTY is
    // open: a fresh theme object reference is required for xterm to pick up
    // the change (assigning back the same reference is a documented no-op).
    // fontSize is then handled by whichever layout applies for the current
    // control state — `fitAndReport` doesn't touch it, so it is set directly
    // for a controlling view; `applyMirrorLayout` rescales from the new base.
    const applyTypography = (): void => {
      const activeTheme = getActiveTheme();
      term.options.theme = { ...activeTheme.xterm };
      term.options.fontFamily = resolveFontFamily(getUserFontId(), activeTheme);
      runtime.refreshSearchDecorations();
      if (hasControlRef.current) {
        term.options.fontSize = computeBaseFontSize();
        fitAndReport();
      } else {
        applyMirrorLayout();
      }
    };
    window.addEventListener('ez:theme', applyTypography);
    window.addEventListener('ez:ui-scale', applyTypography);

    // Scrollback setting change (WT-parity M5) while this PTY is open: applied
    // directly to the live term, no remount needed.
    const applyScrollbackSetting = (): void => {
      term.options.scrollback = getActiveScrollback();
    };
    window.addEventListener('ez:scrollback', applyScrollbackSetting);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      observer.disconnect();
      window.removeEventListener('ez:refit', onRefit);
      window.removeEventListener('ez:theme', applyTypography);
      window.removeEventListener('ez:ui-scale', applyTypography);
      window.removeEventListener('ez:scrollback', applyScrollbackSetting);
      unregisterPaste();
      imeHygiene.dispose();
      dataDisposable.dispose();
      unsink();
      unregisterReplayReset();
      osc52Disposable.dispose();
      runtimeRef.current = null;
      runtime.dispose();
      delete (el as HTMLDivElement & { __ezTerm?: Terminal }).__ezTerm;
      term.dispose();
      termRef.current = null;
    };
  }, [controller, linkHandlingEnabled, runtimeOptions.platform, terminalFileLinksEnabled]);

  // Switching renderer policy never remounts xterm or loses its scrollback.
  useEffect(() => {
    runtimeRef.current?.setRendererPreference(runtimeOptions.rendererPreference);
  }, [runtimeOptions.rendererPreference]);

  useEffect(() => {
    if (!findOpen) return;
    runtimeRef.current?.find(findQuery, 'next', findCaseSensitive, true);
  }, [findCaseSensitive, findOpen, findQuery]);

  // Control transition (control handoff, M8b): gaining control restores the
  // base font size and reports OUR size to the interpreter — a claim's whole
  // point, resizing the shared PTY to the claimer. Losing control switches to
  // shrink-to-fit.
  useEffect(() => {
    if (!termRef.current) return; // not mounted yet
    if (snapshot.hasControl) {
      termRef.current.options.fontSize = computeBaseFontSize();
      fitAndReportRef.current();
    } else {
      applyMirrorLayoutRef.current();
    }
  }, [snapshot.hasControl]);

  // A non-controlling view re-lays-out when the controlling port's grid
  // changes (`ptyDims` — attach replay or a live resize by whoever holds
  // control).
  useEffect(() => {
    if (hasControlRef.current) return;
    applyMirrorLayoutRef.current();
  }, [snapshot.ptyDims]);

  const closeFind = (): void => {
    runtimeRef.current?.clearSearch();
    setFindQuery('');
    setFindResults(EMPTY_SEARCH_RESULTS);
    setFindOpen(false);
    requestAnimationFrame(() => termRef.current?.focus());
  };

  const findNext = (): void => {
    runtimeRef.current?.find(findQuery, 'next', findCaseSensitive);
  };

  const findPrevious = (): void => {
    runtimeRef.current?.find(findQuery, 'previous', findCaseSensitive);
  };

  const menuItems: TerminalContextMenuItem[] = [
    {
      action: 'copy',
      label: 'Copy',
      disabled: !termRef.current?.hasSelection(),
      onClick: () => {
        const term = termRef.current;
        if (term) void navigator.clipboard.writeText(term.getSelection());
      },
    },
    {
      action: 'paste',
      label: 'Paste',
      onClick: () => {
        const term = termRef.current;
        if (!term) return;
        void navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
      },
    },
    { action: 'select-all', label: 'Select All', onClick: () => termRef.current?.selectAll() },
    { action: 'find', label: 'Find', onClick: () => setFindOpen(true) },
  ];

  return (
    <div
      ref={containerRef}
      className={snapshot.hasControl ? 'pty-block' : 'pty-block pty-block--mirror'}
      data-testid="pty-block"
      onMouseDown={(event) => {
        if (!(event.target as Element).closest(
          '.terminal-find-bar, .terminal-context-menu, .pty-control-chip',
        )) {
          termRef.current?.focus();
        }
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented
          || !isTerminalContextMenuKey(event.nativeEvent)
          || (event.target as Element).closest('.terminal-context-menu')
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openKeyboardMenuRef.current();
      }}
      onContextMenu={(e) => {
        // Touch devices get the mobile long-press menu instead
        // (MobileSessionView.tsx, WT-parity M3) — a right-click context menu
        // is a fine-pointer affordance, so skip it here to avoid a double menu.
        if (window.matchMedia?.('(pointer: coarse)').matches) return;
        e.preventDefault();
        setMenuPos(captureTerminalMenuInvocation(e.currentTarget, e.clientX, e.clientY));
      }}
    >
      <PtyControlChip
        controller={controller}
        hostRef={containerRef}
        onRestoreFocus={() => termRef.current?.focus()}
      />
      {findOpen && (
        <TerminalFindBar
          query={findQuery}
          caseSensitive={findCaseSensitive}
          results={findResults}
          onQueryChange={setFindQuery}
          onCaseSensitiveChange={setFindCaseSensitive}
          onNext={findNext}
          onPrevious={findPrevious}
          onClose={closeFind}
        />
      )}
      {menuPos && (
        <TerminalContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={menuItems}
          onClose={(detail) => closeTerminalMenu(
            menuPos,
            detail,
            () => setMenuPos(null),
            () => termRef.current?.focus(),
          )}
        />
      )}
    </div>
  );
}

// ── plain view (Phase 3 adaptive render default) ─────────────────────────────

function textOffsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
  const position = document.caretPositionFromPoint?.(x, y);
  const legacyDocument = document as Document & {
    caretRangeFromPoint?: (pointX: number, pointY: number) => Range | null;
  };
  const legacyRange = position ? null : legacyDocument.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? legacyRange?.startContainer;
  const offset = position?.offset ?? legacyRange?.startOffset;
  if (!node || offset === undefined || !root.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

function PtyPlainView({
  controller,
  runtimeOptions,
}: {
  controller: BlockController;
  runtimeOptions: TerminalRuntimeOptions;
}): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  // Right-click context menu (WT-parity M2) — same pattern as PtyXtermView's.
  const [menuPos, setMenuPos] = useState<TerminalMenuInvocation | null>(null);

  // Mount: wire the plain sink (input focus now lives on cmd-input — M1 focus
  // retention routes plain-PTY keystrokes there, TerminalPane.tsx's
  // activePlainPty). Appending is imperative DOM (NOT React state) for the
  // same reason xterm's byte sink is — plain output can be just as firehose-y
  // (npm/pnpm progress, a large one-shot dump) as PTY bytes, and must stay out
  // of React state to avoid render-thrash (B2 e2e: large plain output must
  // complete without a UI stall or ack deadlock).
  useEffect(() => {
    const unsink = controller.setPlainDataSink((html) => {
      outputRef.current?.insertAdjacentHTML('beforeend', html);
    });
    const unregisterReplayReset = controller.setPtyReplayResetHandler(() => {
      if (outputRef.current) outputRef.current.textContent = '';
    });
    return () => {
      unsink();
      unregisterReplayReset();
    };
  }, [controller]);

  // On exit (status leaves 'running'): re-focus this pane's cmd-input. Now a
  // harmless backstop (M1) — plain-mode input routes through cmd-input while
  // running too, so cmd-input was never actually unfocused here; this only
  // guards against focus having drifted elsewhere for some other reason.
  useEffect(() => {
    if (snapshot.status === 'running') return;
    const pane = containerRef.current?.closest('.pane');
    const cmdInput = pane?.querySelector<HTMLInputElement>('.cmd-input');
    if (!cmdInput) return;
    const raf = requestAnimationFrame(() => cmdInput.focus());
    return () => cancelAnimationFrame(raf);
  }, [snapshot.status]);

  useEffect(() => {
    if (snapshot.status !== 'running') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTerminalContextMenuKey(event)) return;
      const host = containerRef.current;
      const originPane = host?.closest('.pane');
      const active = document.activeElement;
      if (
        !host
        || !originPane
        || !(active instanceof Element)
        || (!host.contains(active) && !active.matches('.cmd-input'))
        || active.closest('.pane') !== originPane
        || active.closest('.terminal-context-menu')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setMenuPos(keyboardTerminalMenuInvocation(host));
    };
    // Capture before TerminalPane's composer handler so Shift+F10 is never
    // translated to the PTY's ordinary F10 byte sequence.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [snapshot.status]);

  // Paste (WT-parity M2): routed straight through the controller this view
  // already holds — the SAME child the composer's onPaste sends to while
  // `activePlainPty` (TerminalPane.tsx). NOT bracketed-paste-framed: under
  // the adaptive render model a program that enables bracketed paste
  // (?2004h) trips the plain->xterm upgrade, so plain mode never has it
  // active — adding ESC[200~ framing here would be dead code.
  const menuItems: TerminalContextMenuItem[] = [
    {
      action: 'copy',
      label: 'Copy',
      disabled: window.getSelection()?.isCollapsed ?? true,
      onClick: () => {
        const text = window.getSelection()?.toString();
        if (text) void navigator.clipboard.writeText(text);
      },
    },
    {
      action: 'paste',
      label: 'Paste',
      onClick: () => {
        void navigator.clipboard.readText().then((text) => {
          if (text) controller.sendPtyInput(text);
        });
      },
    },
    {
      action: 'select-all',
      label: 'Select All',
      onClick: () => {
        const el = outputRef.current;
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
    // Output-only surface (M1): plain-mode input now routes through cmd-input
    // (TerminalPane.tsx's activePlainPty path), so this div no longer needs
    // its own tabIndex/key handlers.
    <div
      ref={containerRef}
      className="pty-plain-block"
      data-testid="pty-plain-block"
      onContextMenu={(e) => {
        // Touch devices get the mobile long-press menu instead
        // (MobileSessionView.tsx, WT-parity M3) — a right-click context menu
        // is a fine-pointer affordance, so skip it here to avoid a double menu.
        if (window.matchMedia?.('(pointer: coarse)').matches) return;
        e.preventDefault();
        setMenuPos(captureTerminalMenuInvocation(e.currentTarget, e.clientX, e.clientY));
      }}
    >
      <PtyControlChip
        controller={controller}
        hostRef={containerRef}
        onRestoreFocus={() => {
          const pane = containerRef.current?.closest('.pane');
          pane?.querySelector<HTMLInputElement>('.cmd-input')?.focus();
        }}
      />
      <pre
        ref={outputRef}
        className="text-block"
        data-testid="text-output"
        onClick={(event) => {
          if (!runtimeOptions.openTerminalFileLocation) return;
          if (runtimeOptions.platform === 'desktop' && !event.ctrlKey && !event.metaKey) return;
          const output = outputRef.current;
          if (!output) return;
          const offset = textOffsetAtPoint(output, event.clientX, event.clientY);
          if (offset === null) return;
          const match = findTerminalFileLinkAtOffset(output.textContent ?? '', offset);
          if (!match) return;
          const context = controller.getSnapshot();
          if (!context.startCwd || context.executionKind !== 'local') return;
          runtimeOptions.openTerminalFileLocation({
            path: match.path,
            cwd: context.startCwd,
            executionKind: context.executionKind,
            ...(match.line === undefined ? {} : { line: match.line }),
            ...(match.column === undefined ? {} : { column: match.column }),
          }, event.nativeEvent);
        }}
      />
      {snapshot.status === 'running' && (
        <span className="pty-plain-waiting" data-testid="pty-plain-waiting" aria-hidden="true">
          ▍
        </span>
      )}
      {menuPos && (
        <TerminalContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={menuItems}
          onClose={(detail) => closeTerminalMenu(
            menuPos,
            detail,
            () => setMenuPos(null),
            () => {
              const pane = containerRef.current?.closest('.pane');
              pane?.querySelector<HTMLInputElement>('.cmd-input')?.focus();
            },
          )}
        />
      )}
    </div>
  );
}
