import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import type { BlockController } from './block-controller';
import { THEMES, getActiveThemeName } from './themes';
import { getActiveUiScale } from './ui-scale';

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

// ── xterm view (Phase 2 behavior, unchanged) ─────────────────────────────────
//
// B3: the parent (Block.tsx) keeps a `pty`-shape block mounted while collapsed
// (hidden via CSS) so collapsing never destroys a live xterm terminal or drops
// output — disposed only when the block is dismissed/closed (unmount).

function PtyXtermView({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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

    const initialTheme = THEMES[getActiveThemeName()];
    const term = new Terminal({
      fontFamily: initialTheme.fontFamily,
      fontSize: Math.round((initialTheme.fontSize * getActiveUiScale()) / 100),
      cursorBlink: true,
      scrollback: 5000,
      theme: initialTheme.xterm,
    });
    termRef.current = term;

    // Mirror mode (mobile mirroring fix, D3/D4): a `!cmd` mirror must NEVER
    // report its own size back — the shared PTY is sized to the PRIMARY only,
    // and a mirror's `pty-resize` control is gated out interpreter-side
    // anyway (interpreter-process.ts). No FitAddon at all here; sizing is
    // driven by `snapshot.ptyDims` in the effect below instead.
    const fit = controller.isMirror ? null : new FitAddon();
    if (fit) term.loadAddon(fit);
    term.open(el);

    const fitAndReport = (): void => {
      if (!fit) return; // mirror: no local fit/report — see above
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

    // Resize to the real pane size BEFORE registering the sink — this also
    // covers the plain->xterm upgrade case (Phase 3): the buffered plain-mode
    // history replays at the real pane size, not the PTY's 80x24 spawn default
    // (interpreter-process.ts's PTY_INITIAL_COLS/ROWS). A mirror obeys the
    // same size-before-sink rule, but at the PRIMARY's grid: attach replays
    // `pty-dims` ahead of the ring bytes, so the snapshot already carries it
    // by the time this mounts (the effect below handles LATER dims changes).
    if (fit) {
      fitAndReport();
    } else {
      const dims = controller.getSnapshot().ptyDims;
      term.resize(dims?.cols ?? 80, dims?.rows ?? 24);
    }
    term.focus();

    // PTY output → xterm. setPtyDataSink flushes any bytes buffered before mount
    // (Phase 2: pre-mount bytes; Phase 3: the ENTIRE plain-mode history on an
    // upgrade). The write callback drives the backpressure ack (Stage C): the
    // interpreter pauses the PTY when the renderer falls too far behind flushes.
    const unsink = controller.setPtyDataSink((bytes, onFlushed) => term.write(bytes, onFlushed));
    // Keystrokes / pasted text → PTY child (attach ports support input too).
    const dataDisposable = term.onData((data) => controller.sendPtyInput(data));

    // Keep the PTY grid synced to the rendered size (incl. collapse→expand).
    // Skipped for a mirror — see the fit-null note above.
    const observer = fit ? new ResizeObserver(() => fitAndReport()) : null;
    if (observer) observer.observe(el);
    // A dockview tab re-shown via renderer:'always' keeps its layout size, so the
    // ResizeObserver does NOT fire on show — refit explicitly on the host's signal (B7).
    const onRefit = (): void => fitAndReport();
    if (fit) window.addEventListener('ez:refit', onRefit);

    // Theme switch (E1) and UI scale change (v0.2.0 D1) while this PTY is
    // open: a fresh theme object reference is required for xterm to pick up
    // the change (assigning back the same reference is a documented no-op),
    // and fontSize must be recomputed from the (possibly new) theme's base
    // size composed with the (possibly new) scale — either event can change
    // either input, so both listeners share this one handler. `fitAndReport`
    // is a no-op in mirror mode, so a mirror only ever gets the font update.
    const applyTypography = (): void => {
      const activeTheme = THEMES[getActiveThemeName()];
      term.options.fontSize = Math.round((activeTheme.fontSize * getActiveUiScale()) / 100);
      term.options.theme = { ...activeTheme.xterm };
      fitAndReport();
    };
    window.addEventListener('ez:theme', applyTypography);
    window.addEventListener('ez:ui-scale', applyTypography);

    return () => {
      observer?.disconnect();
      if (fit) window.removeEventListener('ez:refit', onRefit);
      window.removeEventListener('ez:theme', applyTypography);
      window.removeEventListener('ez:ui-scale', applyTypography);
      dataDisposable.dispose();
      unsink();
      term.dispose();
      termRef.current = null;
    };
  }, [controller]);

  // Mirror mode (D3): size the terminal to the PRIMARY's grid instead of the
  // rendered box, so cursor-addressing bytes drawn for the PRIMARY's (often
  // larger) grid stay correct — a wide TUI scrolls horizontally in
  // `.pty-block--mirror` rather than reflowing. Defaults to 80x24 until the
  // first `pty-dims` frame replays (attach) or arrives (primary resize).
  useEffect(() => {
    if (!controller.isMirror) return;
    const term = termRef.current;
    if (!term) return;
    const { cols, rows } = snapshot.ptyDims ?? { cols: 80, rows: 24 };
    term.resize(cols, rows);
  }, [controller, snapshot.ptyDims]);

  return (
    <div
      ref={containerRef}
      className={controller.isMirror ? 'pty-block pty-block--mirror' : 'pty-block'}
      data-testid="pty-block"
      onMouseDown={() => termRef.current?.focus()}
    />
  );
}

// ── plain view (Phase 3 adaptive render default) ─────────────────────────────

function PtyPlainView({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

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

  return (
    // Output-only surface (M1): plain-mode input now routes through cmd-input
    // (TerminalPane.tsx's activePlainPty path), so this div no longer needs
    // its own tabIndex/key handlers.
    <div ref={containerRef} className="pty-plain-block" data-testid="pty-plain-block">
      <pre ref={outputRef} className="text-block" data-testid="text-output" />
      {snapshot.status === 'running' && (
        <span className="pty-plain-waiting" data-testid="pty-plain-waiting" aria-hidden="true">
          ▍
        </span>
      )}
    </div>
  );
}
