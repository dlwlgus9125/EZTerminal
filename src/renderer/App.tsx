import { createContext, useCallback, useContext, useMemo, useRef, useEffect, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';

import { maxTabSuffix, type LayoutEnvelope, type ThemeName } from '../shared/layout-schema';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { ConnectionInfoPanel } from './ConnectionInfoPanel';
import { FileExplorerPanel } from './FileExplorerPanel';
import { StatusPanel } from './StatusPanel';
import { TerminalPane } from './TerminalPane';

// App is the dockview host: one TerminalPane per tab or split pane. Each pane owns its
// own shell session, so panes are fully isolated. Panes are created programmatically —
// tabs via addPanel (no position), splits via addPanel with a `position` (a new grid
// group). Mouse drag-to-split / drag-rearrange is enabled; only detached floating windows
// are disabled (disableFloatingGroups). A drag MOVES the existing panel node, so the
// TerminalPane/session/PTY survive the move (dockview re-parents, never remounts). Panels
// render with `renderer: 'always'` so a hidden pane stays MOUNTED (visibility:hidden, not
// unmounted) — its live PTY/xterm survives (Codex B7 / dockview docs).

// C6 sessionId-report channel: TerminalPanel is dockview's registered component
// (module-scoped, outside App's closure), so it can't otherwise reach App's
// onSessionBound/onSessionUnbound callbacks — a context bridges the two without
// threading them through dockview panel `params` (which must stay JSON-
// serializable for `saveLayout`'s api.toJSON(), so a function value can't live
// there).
interface SessionBindingContextValue {
  readonly onSessionBound: (panelId: string, sessionId: string) => void;
  readonly onSessionUnbound: (panelId: string) => void;
}
const SessionBindingContext = createContext<SessionBindingContextValue | null>(null);

// The dockview panel content. On becoming visible again, broadcast a refit so the
// pane's xterm re-fits: a visibility:hidden panel keeps its layout size, so xterm's
// ResizeObserver does NOT fire on show — an explicit nudge is required (Codex B7).
function TerminalPanel(props: IDockviewPanelProps): JSX.Element {
  useEffect(() => {
    const disposable = props.api.onDidVisibilityChange((event) => {
      if (event.isVisible) {
        requestAnimationFrame(() => window.dispatchEvent(new Event('ez:refit')));
      }
    });
    return () => disposable.dispose();
  }, [props.api]);
  const binding = useContext(SessionBindingContext);
  return (
    <TerminalPane
      panelId={props.api.id}
      initialCwd={props.params?.cwd as string | undefined}
      adoptSessionId={props.params?.adoptSessionId as string | undefined}
      onSessionBound={binding?.onSessionBound}
      onSessionUnbound={binding?.onSessionUnbound}
    />
  );
}

const components = { terminal: TerminalPanel };

let tabCounter = 0;

/** Cycle order for the theme button (E1). */
const THEME_ORDER: readonly ThemeName[] = ['dark', 'light', 'high-contrast', 'matrix'];

/** How long a layout may keep changing before it is persisted. Changes made
 * less than this before a hard kill are lost — accepted v1 window (gate Q2). */
const SAVE_DEBOUNCE_MS = 300;

/** Pick the startup layout: a named preset when configured, else the last
 * layout, falling back from a missing preset to the last layout (never fails
 * hard — a null return means "open the default single pane"). */
async function pickStartupLayout(): Promise<LayoutEnvelope | null> {
  const ez = window.ezterminal;
  const startup = await ez.getStartup();
  if (startup.mode === 'preset' && startup.presetName) {
    const preset = await ez.getPreset(startup.presetName);
    if (preset) return preset;
  }
  return ez.loadLayout();
}

export function App(): JSX.Element {
  const versions = window.ezterminal?.versions;
  const apiRef = useRef<DockviewApi | null>(null);

  // ── Session mirroring (M2: full mirroring across desktop tabs + mobile) ──
  // sessionId -> panelId for every panel this window has bound (created OR
  // adopted) a session for. Two jobs: (1) self-filter `onSessionAdded`, an
  // unconditional broadcast that also fires for a session THIS window itself
  // just created/adopted (correlated response -> broadcast ordering is a
  // main-side guarantee — see remote-protocol.ts — so the map entry is
  // already there by the time the echo arrives); (2) find the panel to close
  // when `onSessionRemoved` reports a session gone from elsewhere.
  const sessionPanelMapRef = useRef<Map<string, string>>(new Map());

  const onSessionBound = useCallback((panelId: string, sessionId: string): void => {
    sessionPanelMapRef.current.set(sessionId, panelId);
  }, []);

  const onSessionUnbound = useCallback((panelId: string): void => {
    for (const [sessionId, boundPanelId] of sessionPanelMapRef.current) {
      if (boundPanelId === panelId) sessionPanelMapRef.current.delete(sessionId);
    }
  }, []);

  const sessionBindingValue = useMemo<SessionBindingContextValue>(
    () => ({ onSessionBound, onSessionUnbound }),
    [onSessionBound, onSessionUnbound],
  );

  // A session created/destroyed on ANY surface (another desktop tab/window, or
  // mobile) gets mirrored here: an unknown id adds a new ADOPT-mode tab
  // (T2.3); a removed id closes whichever panel is bound to it (self-echo for
  // a LOCAL destroy is a no-op — TerminalPane's unmount already called
  // onSessionUnbound before this broadcast round-trips back).
  useEffect(() => {
    const unsubAdded = window.ezterminal?.onSessionAdded?.((session) => {
      if (sessionPanelMapRef.current.has(session.sessionId)) return; // already have a panel for it
      const api = apiRef.current;
      if (!api) return;
      tabCounter += 1;
      api.addPanel({
        id: `tab-${tabCounter}`,
        component: 'terminal',
        title: `Terminal ${tabCounter}`,
        renderer: 'always',
        params: { adoptSessionId: session.sessionId },
      });
    });
    const unsubRemoved = window.ezterminal?.onSessionRemoved?.((sessionId) => {
      const panelId = sessionPanelMapRef.current.get(sessionId);
      if (!panelId) return; // not one of ours (never bound, or already closed)
      apiRef.current?.getPanel(panelId)?.api.close();
    });
    return () => {
      unsubAdded?.();
      unsubRemoved?.();
    };
  }, []);

  // Both "new tab" and "split" open a fresh self-contained TerminalPane. Passing a
  // `position` makes dockview place it in a NEW grid group (a split) instead of the
  // active group (a tab). One module-scoped counter keeps ids/titles globally unique
  // across tabs AND splits. `renderer: 'always'` is required either way so a pane that
  // later becomes hidden stays mounted and its live PTY survives (Codex B7).
  const openPanel = useCallback(
    (position?: { referencePanel: string; direction: 'right' | 'below' }, cwd?: string) => {
      const api = apiRef.current;
      if (!api) return;
      tabCounter += 1;
      api.addPanel({
        id: `tab-${tabCounter}`,
        component: 'terminal',
        title: `Terminal ${tabCounter}`,
        renderer: 'always',
        ...(cwd ? { params: { cwd } } : {}),
        ...(position ? { position } : {}),
      });
    },
    [],
  );

  const addTab = useCallback(() => openPanel(), [openPanel]);

  // File-explorer drawer's "open terminal here" (M2): a fresh tab whose session
  // starts in `dirPath`, threaded through dockview panel params to TerminalPanel.
  const onOpenTerminalAt = useCallback((dirPath: string) => openPanel(undefined, dirPath), [openPanel]);

  // Split the pane the user last focused. Omitting `direction` would default to
  // 'within' (a tab, not a split), so it is always explicit.
  const splitActive = useCallback(
    (direction: 'right' | 'below') => {
      const api = apiRef.current;
      if (!api || !api.activePanel) return;
      openPanel({ referencePanel: api.activePanel.id, direction });
    },
    [openPanel],
  );

  // ── Layout persistence (Track A ③, A-M3/M4) ──────────────────────────────
  // Startup restore AND preset apply run as generation-tokened TRANSACTIONS
  // (Codex gate B2): StrictMode remounts dispose the first dockview and fire
  // onReady again, so a stale async apply must never touch the new instance —
  // and a disposal-induced fromJSON failure must never quarantine a good file.
  // Saves are suppressed while a transaction runs (B3).
  const restoreGenRef = useRef(0);
  const savesSuppressedRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback((): void => {
    const api = apiRef.current;
    if (!api || savesSuppressedRef.current) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void window.ezterminal.saveLayout(api.toJSON());
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const runLayoutTransaction = useCallback(
    async (
      source: () => Promise<LayoutEnvelope | null>,
      opts: { quarantineOnCorrupt: boolean; restoreBackupOnFailure: boolean },
    ): Promise<void> => {
      const api = apiRef.current;
      if (!api) return;
      restoreGenRef.current += 1;
      const gen = restoreGenRef.current;
      const isStale = (): boolean => gen !== restoreGenRef.current;
      savesSuppressedRef.current = true;
      try {
        let envelope: LayoutEnvelope | null = null;
        try {
          envelope = await source();
        } catch {
          envelope = null; // bridge unavailable/failed — treated as "nothing to apply"
        }
        if (isStale()) return;
        if (envelope) {
          // Preset apply keeps a live backup: dockview's own revert does not
          // cover every failure window (gate B1), so we restore it ourselves.
          const backup =
            opts.restoreBackupOnFailure && api.panels.length > 0 ? api.toJSON() : null;
          try {
            // Re-seed BEFORE fromJSON: restored ids keep their original tab-N
            // names, and a later addPanel minting a duplicate id throws (F6).
            tabCounter = Math.max(tabCounter, maxTabSuffix(envelope.layout));
            api.fromJSON(envelope.layout as unknown as SerializedDockview);
            if (api.panels.length === 0) throw new Error('layout restored zero panels');
          } catch (err) {
            // Disposal/supersession is NOT corruption — never quarantine for it (B2).
            if (isStale()) return;
            console.error('[renderer] layout apply failed:', err);
            if (opts.quarantineOnCorrupt) {
              try {
                await window.ezterminal.quarantineLayout(); // awaited: B3
              } catch {
                // Quarantine is best-effort; a pane must still open below.
              }
              if (isStale()) return;
            }
            if (backup) {
              try {
                api.fromJSON(backup);
              } catch {
                // Backup re-apply failed too — the default pane below covers it.
              }
            }
            if (api.panels.length === 0) addTab();
          }
        } else if (api.panels.length === 0) {
          addTab(); // first run (or quarantined): the default single pane
        }
      } finally {
        if (!isStale()) savesSuppressedRef.current = false;
      }
    },
    [addTab],
  );

  // ── Interpreter-crash banner (B-M5) ───────────────────────────────────────
  // Shared fate: the one utilityProcess backs every session, so its death kills
  // them all. Panes latch dead individually (TerminalPane); this app-level
  // banner tells the user WHAT happened and where the local evidence lives.
  const [crashInfo, setCrashInfo] = useState<{ logPath: string | null } | null>(null);
  useEffect(() => {
    const unsub = window.ezterminal?.onSessionDead?.((info) =>
      setCrashInfo({ logPath: info?.logPath ?? null }),
    );
    return () => unsub?.();
  }, []);

  // ── Status overlay panel (status-overlay-panel) ──────────────────────────
  // Starts closed (AC11). The effect fires on every toggle AND once on mount
  // (statsOpen's initial value), which is exactly the "toggle + mount, both
  // idempotent" resync the main process expects (rev6 architecture).
  const [statsOpen, setStatsOpen] = useState(false);
  useEffect(() => {
    window.ezterminal.setStatsPanelVisible(statsOpen);
  }, [statsOpen]);

  // ── Mobile pairing panel (M4) ─────────────────────────────────────────────
  const [pairingOpen, setPairingOpen] = useState(false);

  // ── File explorer drawer (file-explorer plan, M1) ─────────────────────────
  // Left-edge overlay — unlike stats/pairing above, it does not share their
  // right-slot mutual exclusion. `activePanelId` tracks dockview's active
  // panel so the drawer can read that pane's live cwd via pane-registry when
  // it opens (best-effort snapshot only, no live-following — see App.tsx's
  // onDidActivePanelChange subscription in onReady below).
  const [filesOpen, setFilesOpen] = useState(false);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);

  // ── Theme (E1) ────────────────────────────────────────────────────────────
  // Applied via `data-theme` on <html> so index.css's [data-theme] blocks take
  // over the --term-* vars; 'ez:theme' notifies open PtyBlocks to re-theme their
  // xterm instance (mirrors the existing 'ez:refit' pattern).
  const [theme, setThemeState] = useState<ThemeName>('dark');
  // Guards the initial getTheme() fetch against a click that lands before its IPC
  // round-trip resolves — without this, a fast click could be silently overwritten
  // by the (now-stale) persisted value moments later.
  const userChangedThemeRef = useRef(false);

  const applyTheme = useCallback((name: ThemeName): void => {
    document.documentElement.dataset.theme = name;
    window.dispatchEvent(new Event('ez:theme'));
    setThemeState(name);
  }, []);

  useEffect(() => {
    void window.ezterminal.getTheme().then((name) => {
      if (!userChangedThemeRef.current) applyTheme(name);
    });
  }, [applyTheme]);

  const cycleTheme = useCallback((): void => {
    userChangedThemeRef.current = true;
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    applyTheme(next);
    void window.ezterminal.setTheme(next);
  }, [theme, applyTheme]);

  // ── Presets (A-M4) ────────────────────────────────────────────────────────
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetNames, setPresetNames] = useState<string[]>([]);
  const [startupPreset, setStartupPreset] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');

  const refreshPresets = useCallback(async (): Promise<void> => {
    try {
      const [names, startup] = await Promise.all([
        window.ezterminal.listPresets(),
        window.ezterminal.getStartup(),
      ]);
      setPresetNames(names);
      setStartupPreset(startup.mode === 'preset' ? (startup.presetName ?? null) : null);
    } catch {
      // Bridge unavailable — leave the current list untouched.
    }
  }, []);

  const saveCurrentAsPreset = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const name = presetNameDraft.trim();
    if (!api || !name) return;
    const ok = await window.ezterminal.savePreset(name, api.toJSON());
    if (ok) {
      setPresetNameDraft('');
      setSavingPreset(false);
      await refreshPresets();
    }
  }, [presetNameDraft, refreshPresets]);

  const applyPreset = useCallback(
    async (name: string): Promise<void> => {
      // Applying tears down every pane (fresh sessions by design — B1/B5); the
      // user must consent to losing live sessions.
      if (!window.confirm(`Apply preset "${name}"? Current panes and their sessions close.`)) {
        return;
      }
      setPresetsOpen(false);
      await runLayoutTransaction(() => window.ezterminal.getPreset(name), {
        quarantineOnCorrupt: false,
        restoreBackupOnFailure: true,
      });
      scheduleSave(); // changes made during suppression were ignored — persist now
    },
    [runLayoutTransaction, scheduleSave],
  );

  const toggleStartupPreset = useCallback(
    async (name: string): Promise<void> => {
      await window.ezterminal.setStartup(
        startupPreset === name ? { mode: 'last' } : { mode: 'preset', presetName: name },
      );
      await refreshPresets();
    },
    [startupPreset, refreshPresets],
  );

  const removePreset = useCallback(
    async (name: string): Promise<void> => {
      await window.ezterminal.deletePreset(name);
      if (startupPreset === name) await window.ezterminal.setStartup({ mode: 'last' });
      await refreshPresets();
    },
    [startupPreset, refreshPresets],
  );

  // ── Command palette (E2) ──────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openSavePresetDialog = useCallback((): void => {
    setPresetsOpen(true);
    setSavingPreset(true);
  }, []);

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: 'new-tab', title: 'New tab', run: addTab },
      { id: 'split-right', title: 'Split right', run: () => splitActive('right') },
      { id: 'split-down', title: 'Split down', run: () => splitActive('below') },
      { id: 'cycle-theme', title: 'Cycle theme', run: cycleTheme },
      ...presetNames.map((name) => ({
        id: `apply-preset-${name}`,
        title: `Apply preset: ${name}`,
        run: () => void applyPreset(name),
      })),
      { id: 'save-preset', title: 'Save layout as preset…', run: openSavePresetDialog },
    ],
    [addTab, splitActive, cycleTheme, presetNames, applyPreset, openSavePresetDialog],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const api = event.api;
      setActivePanelId(api.activePanel?.id ?? null);
      api.onDidActivePanelChange((changeEvent) => setActivePanelId(changeEvent.panel?.id ?? null));
      // Test seam: e2e drives programmatic panel moves through this handle. dockview's
      // mouse drag is native HTML5 DnD (not Playwright-drivable); panel.api.moveTo(...)
      // uses the identical move engine a drag invokes.
      (window as Window & { __ezDock?: DockviewApi }).__ezDock = api;

      // e2e seam: deterministically persist NOW (cancel the debounce, save,
      // await main's write chain) instead of polling the file from the test.
      (window as Window & { __ezLayoutFlush?: () => Promise<void> }).__ezLayoutFlush =
        async () => {
          const current = apiRef.current;
          if (!current || savesSuppressedRef.current) return;
          if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          await window.ezterminal.saveLayout(current.toJSON());
          await window.ezterminal.flushLayout();
        };

      void runLayoutTransaction(pickStartupLayout, {
        quarantineOnCorrupt: true,
        restoreBackupOnFailure: false,
      }).then(() => {
        // Attach the save listener only after the restore settled (B2/B3), and
        // only if this dockview instance is still the live one (StrictMode).
        if (apiRef.current !== api) return;
        api.onDidLayoutChange(() => scheduleSave());
        scheduleSave(); // persist the restored/initial state
      });
      void refreshPresets();
    },
    [runLayoutTransaction, scheduleSave, refreshPresets],
  );

  // Global keybindings: Alt+Shift+= (split right) / Alt+Shift+- (split down) /
  // Ctrl+Shift+P (toggle command palette). Capture phase so we win before xterm's
  // textarea handler and the cmd-input — a bound combo is intercepted, never typed.
  // We preventDefault ONLY for an exact modifier+code match in the table below; all
  // other keys pass through untouched. e.code is layout/shift-symbol independent.
  useEffect(() => {
    const bindings: Array<{
      code: string;
      alt: boolean;
      shift: boolean;
      ctrl: boolean;
      run: () => void;
    }> = [
      { code: 'Equal', alt: true, shift: true, ctrl: false, run: () => splitActive('right') },
      { code: 'Minus', alt: true, shift: true, ctrl: false, run: () => splitActive('below') },
      {
        code: 'KeyP',
        alt: false,
        shift: true,
        ctrl: true,
        run: () =>
          setPaletteOpen((open) => {
            if (!open) void refreshPresets(); // keep "Apply preset:" entries current
            return !open;
          }),
      },
    ];
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey) return;
      const binding = bindings.find(
        (b) => b.code === e.code && b.alt === e.altKey && b.shift === e.shiftKey && b.ctrl === e.ctrlKey,
      );
      if (!binding) return;
      e.preventDefault();
      e.stopPropagation();
      binding.run();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [splitActive, refreshPresets]);

  return (
    <main className="app">
      <header className="app-head">
        <span className="session-dot" aria-hidden="true" />
        <h1 className="app-title">EZTerminal</h1>
        <button
          className="btn btn-new-tab"
          onClick={addTab}
          title="New terminal tab"
          data-testid="btn-new-tab"
        >
          + Tab
        </button>
        <button
          className="btn btn-split"
          onClick={() => splitActive('right')}
          title="Split right (Alt+Shift+=)"
          data-testid="btn-split-right"
        >
          Split →
        </button>
        <button
          className="btn btn-split"
          onClick={() => splitActive('below')}
          title="Split down (Alt+Shift+-)"
          data-testid="btn-split-down"
        >
          Split ↓
        </button>
        <div className="preset-box">
          <button
            className="btn btn-split"
            onClick={() => {
              setPresetsOpen((open) => !open);
              setSavingPreset(false);
              void refreshPresets();
            }}
            title="Layout presets"
            data-testid="btn-presets"
          >
            Presets ▾
          </button>
          {presetsOpen && (
            <div className="preset-menu" data-testid="preset-menu">
              {presetNames.length === 0 && <div className="preset-empty">No presets yet</div>}
              {presetNames.map((name) => (
                <div key={name} className="preset-row">
                  <button
                    className="preset-apply"
                    onClick={() => void applyPreset(name)}
                    title={`Apply "${name}" (closes current panes)`}
                    data-testid={`preset-apply-${name}`}
                  >
                    {name}
                  </button>
                  <button
                    className="preset-icon"
                    onClick={() => void toggleStartupPreset(name)}
                    title={
                      startupPreset === name
                        ? 'Startup preset — click to use last layout instead'
                        : 'Open this preset at startup'
                    }
                    data-testid={`preset-star-${name}`}
                  >
                    {startupPreset === name ? '★' : '☆'}
                  </button>
                  <button
                    className="preset-icon"
                    onClick={() => void removePreset(name)}
                    title="Delete preset"
                    data-testid={`preset-del-${name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="preset-save-row">
                {savingPreset ? (
                  <>
                    <input
                      className="preset-name-input"
                      value={presetNameDraft}
                      onChange={(e) => setPresetNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveCurrentAsPreset();
                      }}
                      placeholder="preset name"
                      autoFocus
                      data-testid="preset-name-input"
                    />
                    <button
                      className="btn btn-split"
                      onClick={() => void saveCurrentAsPreset()}
                      data-testid="preset-save-confirm"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-split"
                    onClick={() => setSavingPreset(true)}
                    data-testid="btn-save-preset"
                  >
                    Save current…
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <button
          className="btn btn-split"
          onClick={cycleTheme}
          title="Cycle theme"
          data-testid="btn-theme"
        >
          Theme: {theme}
        </button>
        <button
          className="btn btn-split"
          onMouseDown={(e) => e.preventDefault()} // must not steal focus from the terminal
          onClick={() => setFilesOpen((open) => !open)}
          title="Toggle file explorer"
          data-testid="btn-toggle-files"
        >
          Files
        </button>
        <button
          className="btn btn-split"
          onMouseDown={(e) => e.preventDefault()} // must not steal focus from the terminal
          onClick={() => {
            setStatsOpen((open) => !open);
            setPairingOpen(false); // same status-drawer slot (right:0) — only one at a time
          }}
          title="Toggle system status panel"
          data-testid="btn-toggle-stats"
        >
          Stats
        </button>
        <button
          className="btn btn-split"
          onMouseDown={(e) => e.preventDefault()} // must not steal focus from the terminal
          onClick={() => {
            setPairingOpen((open) => !open);
            setStatsOpen(false); // same status-drawer slot (right:0) — only one at a time
          }}
          title="Show mobile pairing info"
          data-testid="btn-toggle-pairing"
        >
          Pairing
        </button>
        {versions && (
          <span className="versions" title="runtime versions">
            electron {versions.electron}
            <span className="versions-sep" aria-hidden="true">·</span>
            chromium {versions.chrome}
            <span className="versions-sep" aria-hidden="true">·</span>
            node {versions.node}
          </span>
        )}
      </header>

      {crashInfo && (
        <div className="crash-banner" role="alert" data-testid="crash-banner">
          <span>
            Shell interpreter crashed — all sessions are dead. Restart the app to continue.
          </span>
          {crashInfo.logPath && <code className="crash-banner-path">{crashInfo.logPath}</code>}
          <button
            className="btn btn-split"
            onClick={() => setCrashInfo(null)}
            title="Dismiss"
            data-testid="crash-banner-dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div className="dock-host">
        <SessionBindingContext.Provider value={sessionBindingValue}>
          <DockviewReact
            className="dockview-theme-dark ez-dock"
            components={components}
            onReady={onReady}
            disableFloatingGroups
          />
        </SessionBindingContext.Provider>
        {statsOpen && <StatusPanel />}
        {pairingOpen && <ConnectionInfoPanel />}
        {filesOpen && (
          <FileExplorerPanel
            activePanelId={activePanelId}
            onClose={() => setFilesOpen(false)}
            onOpenTerminalAt={onOpenTerminalAt}
          />
        )}
      </div>

      {paletteOpen && (
        <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}
    </main>
  );
}
