import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import type { BlockController } from './block-controller';
import { resolveFontFamily } from './fonts';
import { getActiveScrollback } from './scrollback';
import { getUserFontId } from './theme-runtime';
import { getActiveTheme } from './themes';
import { getActiveUiScale } from './ui-scale';
import { TerminalContextMenu, type TerminalContextMenuItem } from './TerminalContextMenu';
import { attachXtermImeHygiene } from './xterm-ime-hygiene';

// PtyBlock — the render surface for a `pty`-shape block. Execution is ALWAYS a
// live PTY (any single, non-piped external command, or `!cmd`); render is
// ADAPTIVE (Phase 3): `plain` (buffered text + ansi->html, input wired via a
// minimal keyset — matches a text block's UX) is the default, upgrading ONCE
// and IRREVERSIBLY to a full `xterm` terminal on `!cmd` (forceXterm) or the
// interpreter's first high-confidence TUI signal (`pty-render-upgrade` frame,
// see pty-session.ts's TuiSignalDetector). This top-level component just reads
// the mode and dispatches — each mode's mount/teardown lives in its own
// sub-component so switching modes is an ordinary React remount.
export function PtyBlock({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (snapshot.ptyRenderMode === 'xterm') {
    return <PtyXtermView controller={controller} />;
  }
  return <PtyPlainView controller={controller} />;
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

function PtyXtermView({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

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
      fontFamily: resolveFontFamily(getUserFontId(), initialTheme),
      fontSize: computeBaseFontSize(),
      cursorBlink: true,
      scrollback: getActiveScrollback(),
      theme: initialTheme.xterm,
    });
    termRef.current = term;

    // FitAddon is ALWAYS loaded now (M8b) — a non-controlling view can later
    // claim control and needs it to report its own size at that point
    // (`fitAndReport` below); while not in control it is simply never called.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Copy/paste shortcuts (WT-parity M2) — xterm's own key handler, so
    // everything else (Ctrl+C interrupt, arrows, ...) passes through
    // untouched (return true). Ctrl+Shift+C copies the current selection;
    // Ctrl+Shift+V pastes (term.paste applies bracketed-paste framing itself
    // when the child enabled it).
    term.attachCustomKeyEventHandler((e) => {
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
    let mirrorWritesInFlight = 0;
    const unsink = controller.setPtyDataSink((bytes, onFlushed) => {
      if (hasControlRef.current) {
        term.write(bytes, onFlushed);
        return;
      }
      mirrorWritesInFlight++;
      term.write(bytes, () => {
        mirrorWritesInFlight--;
        onFlushed();
      });
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
      observer.disconnect();
      window.removeEventListener('ez:refit', onRefit);
      window.removeEventListener('ez:theme', applyTypography);
      window.removeEventListener('ez:ui-scale', applyTypography);
      window.removeEventListener('ez:scrollback', applyScrollbackSetting);
      unregisterPaste();
      imeHygiene.dispose();
      dataDisposable.dispose();
      unsink();
      term.dispose();
      termRef.current = null;
    };
  }, [controller]);

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
  ];

  return (
    <div
      ref={containerRef}
      className={snapshot.hasControl ? 'pty-block' : 'pty-block pty-block--mirror'}
      data-testid="pty-block"
      onMouseDown={() => termRef.current?.focus()}
      onContextMenu={(e) => {
        // Touch devices get the mobile long-press menu instead
        // (MobileSessionView.tsx, WT-parity M3) — a right-click context menu
        // is a fine-pointer affordance, so skip it here to avoid a double menu.
        if (window.matchMedia?.('(pointer: coarse)').matches) return;
        e.preventDefault();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
    >
      {!snapshot.hasControl && snapshot.status === 'running' && (
        <button
          type="button"
          className="pty-take-control"
          data-testid="pty-take-control"
          onClick={() => controller.claimControl()}
        >
          Take control
        </button>
      )}
      {menuPos && (
        <TerminalContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={menuItems}
          onClose={() => {
            setMenuPos(null);
            termRef.current?.focus(); // refocus the terminal after the menu closes
          }}
        />
      )}
    </div>
  );
}

// ── plain view (Phase 3 adaptive render default) ─────────────────────────────

function PtyPlainView({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  // Right-click context menu (WT-parity M2) — same pattern as PtyXtermView's.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Mount: wire the plain sink (input focus now lives on cmd-input — M1 focus
  // retention routes plain-PTY keystrokes there, TerminalPane.tsx's
  // activePlainPty). Appending is imperative DOM (NOT React state) for the
  // same reason xterm's byte sink is — plain output can be just as firehose-y
  // (npm/pnpm progress, a large one-shot dump) as PTY bytes, and must stay out
  // of React state to avoid render-thrash (B2 e2e: large plain output must
  // complete without a UI stall or ack deadlock).
  useEffect(() => {
    return controller.setPlainDataSink((html) => {
      outputRef.current?.insertAdjacentHTML('beforeend', html);
    });
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
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
    >
      <pre ref={outputRef} className="text-block" data-testid="text-output" />
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
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}
