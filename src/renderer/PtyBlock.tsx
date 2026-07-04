import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import type { BlockController } from './block-controller';
import { THEMES, getActiveThemeName } from './themes';

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
      fontSize: initialTheme.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      theme: initialTheme.xterm,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const fitAndReport = (): void => {
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
    // (interpreter-process.ts's PTY_INITIAL_COLS/ROWS).
    fitAndReport();
    term.focus();

    // PTY output → xterm. setPtyDataSink flushes any bytes buffered before mount
    // (Phase 2: pre-mount bytes; Phase 3: the ENTIRE plain-mode history on an
    // upgrade). The write callback drives the backpressure ack (Stage C): the
    // interpreter pauses the PTY when the renderer falls too far behind flushes.
    const unsink = controller.setPtyDataSink((bytes, onFlushed) => term.write(bytes, onFlushed));
    // Keystrokes / pasted text → PTY child.
    const dataDisposable = term.onData((data) => controller.sendPtyInput(data));

    // Keep the PTY grid synced to the rendered size (incl. collapse→expand).
    const observer = new ResizeObserver(() => fitAndReport());
    observer.observe(el);
    // A dockview tab re-shown via renderer:'always' keeps its layout size, so the
    // ResizeObserver does NOT fire on show — refit explicitly on the host's signal (B7).
    const onRefit = (): void => fitAndReport();
    window.addEventListener('ez:refit', onRefit);

    // Theme switch (E1) while this PTY is open: a fresh object reference is
    // required for xterm to pick up the change (assigning back the same
    // reference is a documented no-op).
    const onThemeChange = (): void => {
      term.options.theme = { ...THEMES[getActiveThemeName()].xterm };
    };
    window.addEventListener('ez:theme', onThemeChange);

    return () => {
      observer.disconnect();
      window.removeEventListener('ez:refit', onRefit);
      window.removeEventListener('ez:theme', onThemeChange);
      dataDisposable.dispose();
      unsink();
      term.dispose();
      termRef.current = null;
    };
  }, [controller]);

  return (
    <div
      ref={containerRef}
      className="pty-block"
      data-testid="pty-block"
      onMouseDown={() => termRef.current?.focus()}
    />
  );
}

// ── plain view (Phase 3 adaptive render default) ─────────────────────────────

/**
 * Minimal keyset forwarded to the PTY child in plain mode (B-R4): printable
 * characters, Enter, Backspace, Ctrl+C, Ctrl+D, Tab. Richer editing (arrow
 * keys / history) and IME composition are intentionally UNSUPPORTED here — a
 * program that needs them either emits a high-confidence signal (auto-upgrade
 * to xterm) or the user re-runs with `!cmd` (forced xterm). Returns null for
 * anything outside this set so the browser keeps its default behavior.
 */
function keyToPtyBytes(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key === 'c' || e.key === 'C') return '\x03';
    if (e.key === 'd' || e.key === 'D') return '\x04';
    return null;
  }
  if (e.altKey || e.metaKey) return null;
  if (e.key === 'Enter') return '\r';
  if (e.key === 'Backspace') return '\x7f';
  if (e.key === 'Tab') return '\t';
  if (e.key.length === 1) return e.key; // any other single printable character
  return null;
}

function PtyPlainView({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Mount: auto-focus + wire the plain sink. Appending is imperative DOM (NOT
  // React state) for the same reason xterm's byte sink is — plain output can
  // be just as firehose-y (npm/pnpm progress, a large one-shot dump) as PTY
  // bytes, and must stay out of React state to avoid render-thrash (B2 e2e:
  // large plain output must complete without a UI stall or ack deadlock).
  useEffect(() => {
    containerRef.current?.focus();
    return controller.setPlainDataSink((html) => {
      outputRef.current?.insertAdjacentHTML('beforeend', html);
    });
  }, [controller]);

  // On exit (status leaves 'running'), hand focus back to this pane's cmd-input
  // (re-enabled once the run settles — TerminalPane.tsx) so the next command
  // can be typed without a click. rAF gives that re-render a tick to commit
  // (cmd-input is disabled, and therefore unfocusable, while running).
  useEffect(() => {
    if (snapshot.status === 'running') return;
    const pane = containerRef.current?.closest('.pane');
    const cmdInput = pane?.querySelector<HTMLInputElement>('.cmd-input');
    if (!cmdInput) return;
    const raf = requestAnimationFrame(() => cmdInput.focus());
    return () => cancelAnimationFrame(raf);
  }, [snapshot.status]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const bytes = keyToPtyBytes(e);
    if (bytes === null) return; // unsupported key — leave default browser behavior alone
    // Forwarded keys MUST preventDefault: Tab would otherwise move focus,
    // Backspace/Space would scroll/navigate instead of reaching the PTY.
    e.preventDefault();
    controller.sendPtyInput(bytes);
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (text) controller.sendPtyInput(text);
  };

  return (
    // Element-scoped keydown/paste only (no window listener) — must not steal
    // keystrokes meant for cmd-input or the command palette elsewhere in the UI.
    <div
      ref={containerRef}
      className="pty-plain-block"
      data-testid="pty-plain-block"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onMouseDown={() => containerRef.current?.focus()}
    >
      <pre ref={outputRef} className="text-block" data-testid="text-output" />
      {snapshot.status === 'running' && (
        <span className="pty-plain-waiting" data-testid="pty-plain-waiting" aria-hidden="true">
          ▍
        </span>
      )}
    </div>
  );
}
