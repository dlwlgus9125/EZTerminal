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
import type { ThemeMod } from '../shared/theme-schema';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { ConnectionInfoPanel } from './ConnectionInfoPanel';
import { EFFECT_CATALOG, type EffectId } from './effects';
import { DEFAULT_ROLLBAR_PARAMS, applyRollbarParams, clampRollbarParams, type RollbarParams } from './effect-params';
import { FileExplorerPanel } from './FileExplorerPanel';
import { SettingsPanel } from './SettingsPanel';
import { StatusPanel } from './StatusPanel';
import { TerminalPane } from './TerminalPane';
import { applyThemeVarsAndEffects, setUserFontId, themeModToDefinition } from './theme-runtime';
import { THEME_ORDER, THEMES, listThemes, registerTheme, type ThemeDefinition } from './themes';
import { applyUiScale, clampUiScale, UI_SCALE_DEFAULT } from './ui-scale';

// Desktop's per-effect default-on state (App.tsx's `applyTheme`/`onToggleEffect`
// platformDefaults): mirrors the effect catalog's own guidance exactly, so a
// theme's declared effects (e.g. Matrix's scanlines+phosphor-glow) are ON by
// default on desktop unless the user has explicitly toggled one off.
const DESKTOP_EFFECT_DEFAULTS: Partial<Record<EffectId, boolean>> = Object.fromEntries(
  Object.values(EFFECT_CATALOG).map((entry) => [entry.id, entry.defaultOn]),
);

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
  // onSessionUnbound synchronously, well before any IPC round trip, before
  // this broadcast comes back).
  //
  // The ADD side needs a defer that REMOVE doesn't (confirmed race, e2e/
  // splits.spec.ts flake under load): TerminalPane's `createSession()` reply
  // resolves a Promise, so its continuation (`bindSession` -> `onSessionBound`
  // -> the `sessionPanelMapRef.current.set(...)` below) is a MICROTASK.
  // `onSessionAdded`'s broadcast, in contrast, fires a plain SYNCHRONOUS
  // `ipcRenderer.on` listener — main already sends the reply before the
  // broadcast (it resolves the correlated Promise first, then calls
  // `sessionDirectory.add()`, whose own listener dispatch is deferred via
  // `setImmediate` — see session-directory.ts's module doc, ADR C6), but that
  // only orders WHEN main SENDS the two messages. If the renderer ever has a
  // backlog of already-arrived IPC messages (plausible under load — an
  // isolated run of this spec never reproduced the flake, only the full
  // gate's contention did) and drains more than one in a single JS task
  // before a microtask checkpoint, the synchronous broadcast handler can run
  // BEFORE the reply's microtask gets a turn — this pane's OWN new session
  // would then look "unknown" and get a duplicate adopt-mode panel (nothing
  // would ever clean that duplicate up — closing either one just deletes
  // whichever entry currently occupies the map's single slot for that
  // sessionId, since `Map.set` last-write-wins; the other stays a stray,
  // un-trackable extra pane indefinitely, worth restating since it's why
  // this needs to be airtight, not just usually-fine).
  //
  // Deferring the CHECK by one macrotask (not just one microtask — Electron's
  // exact number of internal microtask hops for an `invoke` reply isn't
  // something to rely on) is airtight regardless of the precise interleaving:
  // a macrotask callback only runs once the CURRENT task's microtask queue is
  // fully drained, and if the two IPC messages were instead dispatched as two
  // SEPARATE tasks, every microtask from the earlier one drains before the
  // later one's task even begins. Either way, by the time this fires, any
  // already-resolved local `createSession()` for this exact session has
  // already registered in `sessionPanelMapRef`. Mirroring's own AC4 budget
  // (adopt tab appears within ~2s) absorbs a same-tick setTimeout(0) trivially.
  useEffect(() => {
    const pendingAddChecks = new Set<ReturnType<typeof setTimeout>>();
    const unsubAdded = window.ezterminal?.onSessionAdded?.((session) => {
      const timer = setTimeout(() => {
        pendingAddChecks.delete(timer);
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
      }, 0);
      pendingAddChecks.add(timer);
    });
    const unsubRemoved = window.ezterminal?.onSessionRemoved?.((sessionId) => {
      const panelId = sessionPanelMapRef.current.get(sessionId);
      if (!panelId) return; // not one of ours (never bound, or already closed)
      apiRef.current?.getPanel(panelId)?.api.close();
    });
    return () => {
      unsubAdded?.();
      unsubRemoved?.();
      for (const timer of pendingAddChecks) clearTimeout(timer);
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

  // ── Settings drawer (v0.2.0 M2) ───────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── File explorer drawer (file-explorer plan, M1) ─────────────────────────
  // Left-edge overlay — unlike stats/pairing above, it does not share their
  // right-slot mutual exclusion. `activePanelId` tracks dockview's active
  // panel so the drawer can read that pane's live cwd via pane-registry when
  // it opens (best-effort snapshot only, no live-following — see App.tsx's
  // onDidActivePanelChange subscription in onReady below).
  const [filesOpen, setFilesOpen] = useState(false);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);

  // ── Theme (E1) + custom mods, font, effects (theme-effects-font M3) ──────
  // Applied via `data-theme` on <html> so index.css's [data-theme] blocks take
  // over the --term-* vars; 'ez:theme' notifies open PtyBlocks to re-theme their
  // xterm instance (mirrors the existing 'ez:refit' pattern). A custom mod's
  // OWN cssVars/effects are applied by `applyThemeVarsAndEffects` (the shared
  // apply-path helper) right after the attribute is set, before that event.
  const [theme, setThemeState] = useState<ThemeName>('dark');
  const [availableThemes, setAvailableThemes] = useState<ThemeDefinition[]>(() => listThemes());
  // Guards the initial getTheme() fetch against a click that lands before its IPC
  // round-trip resolves — without this, a fast click could be silently overwritten
  // by the (now-stale) persisted value moments later.
  const userChangedThemeRef = useRef(false);

  // effectToggles needs to be read from INSIDE `applyTheme` (a stable, dep-free
  // callback — see below) without forcing it to change identity on every
  // toggle, so a ref mirrors the state (same shape as userChangedThemeRef).
  const [effectToggles, setEffectTogglesState] = useState<Record<string, boolean>>({});
  const effectTogglesRef = useRef<Record<string, boolean>>({});
  const setEffectToggles = useCallback((next: Record<string, boolean>): void => {
    effectTogglesRef.current = next;
    setEffectTogglesState(next);
  }, []);

  const [fontId, setFontId] = useState<string | undefined>(undefined);

  // crt-rollbar line params (rollbar-params) — same ref-mirrors-state shape
  // as effectToggles above, needed so onChangeRollbar (a stable, dep-free
  // callback) can read the latest value without becoming a moving target.
  const [rollbar, setRollbarState] = useState<RollbarParams>(DEFAULT_ROLLBAR_PARAMS);
  const rollbarRef = useRef<RollbarParams>(DEFAULT_ROLLBAR_PARAMS);
  const setRollbar = useCallback((next: RollbarParams): void => {
    rollbarRef.current = next;
    setRollbarState(next);
  }, []);

  const applyTheme = useCallback((name: ThemeName): void => {
    document.documentElement.dataset.theme = name;
    applyThemeVarsAndEffects(name, {
      effectToggles: effectTogglesRef.current,
      platformDefaults: DESKTOP_EFFECT_DEFAULTS,
    });
    window.dispatchEvent(new Event('ez:theme'));
    setThemeState(name);
  }, []);

  const registerMods = useCallback((mods: ThemeMod[]): void => {
    for (const mod of mods) registerTheme(themeModToDefinition(mod));
    setAvailableThemes(listThemes());
  }, []);

  const refreshAvailableThemes = useCallback(async (): Promise<void> => {
    try {
      const mods = await window.ezterminalDesktop?.getAvailableThemes();
      if (mods) registerMods(mods);
    } catch {
      // Desktop bridge unavailable — built-ins still work via THEME_ORDER.
    }
  }, [registerMods]);

  const onImportTheme = useCallback(
    async (json: string): Promise<{ ok: boolean; error?: string }> => {
      const result = await window.ezterminalDesktop?.importTheme(json);
      if (!result) return { ok: false, error: 'Desktop theme import unavailable' };
      if (result.ok) await refreshAvailableThemes();
      return result;
    },
    [refreshAvailableThemes],
  );

  // Boot ordering (FOUC fix): custom theme mods must be registered, and the
  // persisted font/effect toggles loaded into state, BEFORE the first
  // `applyTheme(getTheme())` — otherwise a custom theme's `data-theme` value
  // resolves against an empty registry (getActiveTheme() falls back to
  // 'dark') and effects apply with an empty toggle map for one frame.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshAvailableThemes();
      if (cancelled) return;
      try {
        const [persistedFontId, persistedToggles, persistedRollbar] = await Promise.all([
          window.ezterminalDesktop?.getFont(),
          window.ezterminalDesktop?.getEffectToggles(),
          window.ezterminalDesktop?.getRollbar(),
        ]);
        if (cancelled) return;
        if (persistedFontId) {
          setUserFontId(persistedFontId);
          setFontId(persistedFontId);
        }
        if (persistedToggles) setEffectToggles(persistedToggles);
        if (persistedRollbar) {
          const clamped = clampRollbarParams(persistedRollbar);
          applyRollbarParams(clamped);
          setRollbar(clamped);
        }
      } catch {
        // Desktop bridge unavailable — no user font override, theme defaults for effects.
      }
      const name = await window.ezterminal.getTheme();
      if (!cancelled && !userChangedThemeRef.current) applyTheme(name);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyTheme, refreshAvailableThemes, setEffectToggles, setRollbar]);

  const selectTheme = useCallback(
    (name: ThemeName): void => {
      userChangedThemeRef.current = true;
      applyTheme(name);
      void window.ezterminal.setTheme(name);
    },
    [applyTheme],
  );

  const cycleTheme = useCallback((): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    selectTheme(next);
  }, [theme, selectTheme]);

  const activeThemeDef = useMemo<ThemeDefinition>(
    () => availableThemes.find((t) => t.id === theme) ?? THEMES.dark,
    [availableThemes, theme],
  );

  const onSelectFont = useCallback((id: string): void => {
    setUserFontId(id);
    setFontId(id);
    void window.ezterminalDesktop?.setFont(id);
    window.dispatchEvent(new Event('ez:theme')); // re-applies typography (PtyBlock)
  }, []);

  const onToggleEffect = useCallback(
    (id: string, on: boolean): void => {
      const next = { ...effectTogglesRef.current, [id]: on };
      setEffectToggles(next);
      void window.ezterminalDesktop?.setEffectToggles(next);
      applyThemeVarsAndEffects(theme, { effectToggles: next, platformDefaults: DESKTOP_EFFECT_DEFAULTS });
    },
    [theme, setEffectToggles],
  );

  const onChangeRollbar = useCallback(
    (partial: Partial<RollbarParams>): void => {
      const next = clampRollbarParams({ ...rollbarRef.current, ...partial });
      setRollbar(next);
      applyRollbarParams(next);
      void window.ezterminalDesktop?.setRollbar(next);
    },
    [setRollbar],
  );

  // ── UI scale (v0.2.0 D1) ──────────────────────────────────────────────────
  // Mirrors the theme mechanism directly above: applyUiScaleState sets the CSS
  // var + notifies open PtyBlocks (ui-scale.ts's applyUiScale) AND the local
  // label state; the boot fetch guards against a fast user change the same way
  // userChangedThemeRef does.
  const [uiScale, setUiScaleState] = useState<number>(UI_SCALE_DEFAULT);
  const userChangedUiScaleRef = useRef(false);

  const applyUiScaleState = useCallback((percent: number): void => {
    applyUiScale(percent);
    setUiScaleState(clampUiScale(percent));
  }, []);

  useEffect(() => {
    void window.ezterminal.getUiScale().then((percent) => {
      if (!userChangedUiScaleRef.current) applyUiScaleState(percent);
    });
  }, [applyUiScaleState]);

  const changeUiScale = useCallback(
    (percent: number): void => {
      userChangedUiScaleRef.current = true;
      applyUiScaleState(percent);
      void window.ezterminal.setUiScale(clampUiScale(percent));
    },
    [applyUiScaleState],
  );

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
      api.onDidActivePanelChange((changeEvent) => {
        setActivePanelId(changeEvent.panel?.id ?? null);
        // Tab strip overflow (v0.2.0 M3): dockview's own tab strip already
        // scrolls a newly-active tab into view within ITS group (tabs.js's
        // setActivePanel), but that's an internal implementation detail we
        // shouldn't rely on staying that way — this is a small, idempotent
        // belt-and-suspenders nudge on top of it. rAF gives dockview's own
        // DOM update (the new .dv-active-tab class) a tick to commit first.
        requestAnimationFrame(() => {
          const activeTab =
            document.querySelector('.ez-dock .dv-active-group .dv-tab.dv-active-tab') ??
            document.querySelector('.ez-dock .dv-tab.dv-active-tab');
          activeTab?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        });
      });
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
            setSettingsOpen(false);
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
            setSettingsOpen(false);
          }}
          title="Show mobile pairing info"
          data-testid="btn-toggle-pairing"
        >
          Pairing
        </button>
        <button
          className="btn btn-split"
          onMouseDown={(e) => e.preventDefault()} // must not steal focus from the terminal
          onClick={() => {
            setSettingsOpen((open) => !open);
            setStatsOpen(false); // same status-drawer slot (right:0) — only one at a time
            setPairingOpen(false);
          }}
          title="Settings"
          data-testid="btn-toggle-settings"
        >
          ⚙️
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
        {settingsOpen && (
          <SettingsPanel
            uiScale={uiScale}
            onChangeUiScale={changeUiScale}
            theme={theme}
            onSelectTheme={selectTheme}
            availableThemes={availableThemes}
            onImportTheme={onImportTheme}
            fontId={fontId}
            onSelectFont={onSelectFont}
            activeThemeEffects={activeThemeDef.effects ?? []}
            effectToggles={effectToggles}
            onToggleEffect={onToggleEffect}
            rollbar={rollbar}
            onChangeRollbar={onChangeRollbar}
          />
        )}
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
