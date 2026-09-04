/**
 * Layout persistence schema (Track A ③, A-M1) — the app's first persistence layer.
 *
 * Versioned Zod envelope around dockview's SerializedDockview. Current contract:
 * `docs/design/workbench-lifecycle.md`.
 *
 * Strictness policy (gate B5), by security weight:
 *  - OpenClaw `params` are STRICT empty. Terminal params are also strict and
 *    may contain only bounded project presentation/identity metadata; a cwd,
 *    sessionId or Agent bootstrap still fails validation loudly. A read-only
 *    Agent history panel may persist only its bounded, opaque EZTerminal
 *    `historyId` and bounded public identity hints.
 *  - `contentComponent` must be one of the known panel types ('terminal',
 *    'openclaw-chat', or 'agent-session'): an unknown component would make
 *    dockview-react throw at mount; rejecting here routes to the corrupt path.
 *  - Floating and edge groups remain unsupported and are stripped. Dockview
 *    popout groups are retained, but only DOM-backed terminal and Agent
 *    Session panels may appear in them; window URLs and internal reference ids
 *    are regenerated at runtime.
 *  - Other unknown keys are silently STRIPPED (Zod object default), not rejected:
 *    a future dockview adding a benign key must not brick saved layouts.
 *  - `grid.root` gets a minimal shape check (gate B1): dockview's fromJSON calls
 *    clear() BEFORE the validation that its revert try/catch covers, so a malformed
 *    root must never reach fromJSON at all.
 */
import { z } from 'zod';
import {
  MAX_EFFECT_INTENSITY,
  MIN_EFFECT_INTENSITY,
  SidebarWidthSchema,
  UiDensitySchema,
  UiLocalePreferenceSchema,
  UiResourceProfileSchema,
} from './ui-preferences';
import { isDetachablePanelComponent } from './desktop-window';

export const LAYOUT_SCHEMA_VERSION = 1 as const;

/** Upper bound on restorable panels (gate B5 — bounded input from disk/renderer). */
export const MAX_PANELS = 64;
export const MAX_POPOUT_WINDOWS = 16;

const PanelBaseSchema = z.object({
  id: z.string().min(1),
  // openclaw-management M3: 'openclaw-chat' is a fixed-id singleton panel
  // (main-owned WebContentsView embed) — additive to the union, so every
  // pre-M3 layout/preset file (whose panels are all 'terminal') still parses.
  title: z.string().optional(),
  // Serialized panels carry renderer:'always' (F1/F2); tolerate its absence and
  // let the sanitizer force it so restored panes always survive tab switches.
  renderer: z.enum(['always', 'onlyWhenVisible']).optional(),
  tabComponent: z.string().optional(),
  minimumWidth: z.number().optional(),
  minimumHeight: z.number().optional(),
  maximumWidth: z.number().optional(),
  maximumHeight: z.number().optional(),
});

const ProjectEditorParamsSchema = z.strictObject({
  projectId: z.string().min(1).max(128),
  rootId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  relativePath: z.string().min(1).max(4096),
});

const ProjectMapParamsSchema = z.strictObject({
  projectId: z.string().min(1).max(128),
  ownerRootId: z.string().min(1).max(128),
  ownerWorkspaceId: z.string().min(1).max(128),
  mapId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
});

const ProjectSessionParamsSchema = z.strictObject({
  projectId: z.string().min(1).max(128),
  rootId: z.string().min(1).max(128).optional(),
  workspaceId: z.string().min(1).max(128).optional(),
  projectName: z.string().trim().min(1).max(80),
  titleMode: z.enum(['generated', 'custom']),
}).refine(
  (value) => (value.rootId === undefined) === (value.workspaceId === undefined),
  { message: 'rootId and workspaceId must be provided together.' },
);

const PanelSchema = z.discriminatedUnion('contentComponent', [
  PanelBaseSchema.extend({
    contentComponent: z.literal('terminal'),
    renderer: z.literal('always').optional(),
    params: z.strictObject({
      projectSession: ProjectSessionParamsSchema.optional(),
    }).optional(),
  }),
  PanelBaseSchema.extend({
    contentComponent: z.literal('openclaw-chat'),
    renderer: z.literal('always').optional(),
    params: z.strictObject({}).optional(),
  }),
  PanelBaseSchema.extend({
    contentComponent: z.literal('agent-session'),
    renderer: z.literal('always').optional(),
    params: z.strictObject({
      historyId: z.string().min(1).max(128),
      provider: z.enum(['codex', 'claude']).optional(),
      projectId: z.string().min(1).max(128).optional(),
      rootId: z.string().min(1).max(128).optional(),
      workspaceId: z.string().min(1).max(128).optional(),
    }),
  }),
  PanelBaseSchema.extend({
    contentComponent: z.literal('project-editor'),
    renderer: z.literal('onlyWhenVisible').optional(),
    params: ProjectEditorParamsSchema,
  }),
  PanelBaseSchema.extend({
    contentComponent: z.literal('project-map'),
    renderer: z.literal('onlyWhenVisible').optional(),
    params: ProjectMapParamsSchema,
  }),
]);

const GridSchema = z.looseObject({
  root: z.looseObject({
    type: z.literal('branch'),
    data: z.array(z.unknown()),
  }),
  width: z.number(),
  height: z.number(),
  orientation: z.string(),
});

const PopoutGroupDataSchema = z.looseObject({
  id: z.string().min(1).max(256),
  views: z.array(z.string().min(1).max(256)).min(1).max(MAX_PANELS),
  activeView: z.string().min(1).max(256).optional(),
});

const PopoutGridSchema = z.looseObject({
  root: z.looseObject({
    type: z.literal('branch'),
    data: z.array(z.unknown()),
  }),
  width: z.number().finite().positive().max(32_768),
  height: z.number().finite().positive().max(32_768),
  orientation: z.string(),
});

const PopoutPositionSchema = z.object({
  left: z.number().finite().min(-1_000_000).max(1_000_000),
  top: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().positive().max(32_768),
  height: z.number().finite().positive().max(32_768),
});

const PopoutGroupSchema = z.object({
  data: PopoutGroupDataSchema.optional(),
  grid: PopoutGridSchema.optional(),
  position: PopoutPositionSchema,
}).refine(
  (value) => (value.data ? 1 : 0) + (value.grid ? 1 : 0) === 1,
  { message: 'A popout must contain exactly one single-group or nested-grid layout.' },
);

const LayoutSchema = z.object({
  grid: GridSchema,
  panels: z.record(z.string(), PanelSchema),
  activeGroup: z.string().optional(),
  popoutGroups: z.array(PopoutGroupSchema).max(MAX_POPOUT_WINDOWS).optional(),
});

export const LayoutEnvelopeSchema = z.object({
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  savedAt: z.string(),
  layout: LayoutSchema,
});

export type SerializedLayout = z.infer<typeof LayoutSchema>;
export type LayoutEnvelope = z.infer<typeof LayoutEnvelopeSchema>;

/** Startup preference (gate Q5: lives in settings.json, NOT presets.json). */
export const StartupPrefSchema = z.object({
  mode: z.union([z.literal('last'), z.literal('preset')]),
  presetName: z.string().min(1).max(64).optional(),
});
/** Built-in theme ids (E1; theme-effects-font M0) — the 4 themes that ship
 * with the app and always win an id collision against a custom mod (see
 * shared/theme-schema.ts's `validateThemeMod` and renderer/themes.ts's
 * `registerTheme`). */
export const BUILTIN_THEME_IDS = ['dark', 'light', 'high-contrast', 'matrix'] as const;

export function isBuiltinTheme(name: string): boolean {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(name);
}

/** Theme id/name — persisted in settings.json, applied via the `data-theme`
 * DOM attribute + the matching xterm ITheme in renderer/themes.ts. Was a
 * closed enum of the 4 built-ins pre-M0; now an open, runtime-validated
 * string so a custom/imported theme mod can register under its own id.
 * Resolve an actual theme through renderer/themes.ts's `getActiveTheme()`
 * (built-in ∪ registry, falls back to 'dark') rather than assuming this is
 * one of the 4 built-ins. */
export const ThemeNameSchema = z.string().min(1);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

/** OpenClaw desktop visibility mode (openclaw-stabilization M2) — controls
 * whether ANY OpenClaw UI is exposed on desktop. `auto` (default): visible
 * only when the `openclaw` CLI is installed (OpenClawService.isInstalled()).
 * `on`: always visible. `off`: fully hidden, and no OpenClaw background work
 * (status polling, RPC) is initiated from the desktop UI; a remote client's
 * status/log/lifecycle/config/chat-ticket requests are refused too (remote-
 * bridge.ts's `openclawVisible()` gate) — but the OpenClaw proxy's own port
 * still binds whenever `remoteEnabled` is on, independent of this mode. It
 * just has nothing to serve without a ticket, and 'off' means none is ever
 * minted. */
export const OpenClawModeSchema = z.enum(['auto', 'on', 'off']);
export type OpenClawMode = z.infer<typeof OpenClawModeSchema>;

export const TerminalRendererPreferenceSchema = z.enum(['auto', 'dom']);
export type TerminalRendererPreference = z.infer<typeof TerminalRendererPreferenceSchema>;

/** Wire shape for crt-rollbar line params (rollbar-params) — every field
 * optional, numbers unbounded here: renderer/effect-params.ts's
 * `clampRollbarParams` is the single place that clamps/defaults, both on
 * read and on set. */
export const RollbarParamsSchema = z.object({
  count: z.number().optional(),
  thickness: z.number().optional(),
  gap: z.number().optional(),
  color: z.string().optional(),
  speed: z.number().optional(),
  opacity: z.number().optional(),
  softness: z.number().optional(),
});
export type RollbarSettings = z.infer<typeof RollbarParamsSchema>;

/** Wire shape for the CRT-interference param blob (crt-interference) — ONE
 * loose record for all parameterized effects (jitter-burst / micro-jitter /
 * static-noise / flicker), keyed by effect id. Kept as loose as `rollbar`
 * above and for the same reason: renderer/effect-params.ts's
 * `clampInterferenceParams` is the single clamp/default authority, and a
 * since-removed effect id in an old settings.json must still parse. */
export const EffectParamsSchema = z.record(
  z.string(),
  z.record(z.string(), z.union([z.number(), z.boolean()])),
);
export type EffectParamsSettings = z.infer<typeof EffectParamsSchema>;

// Disk input is recoverable configuration, unlike the strict IPC payload.
// Clamp an old/manual out-of-range numeric value in isolation so one cosmetic
// setting cannot quarantine otherwise valid startup, theme, or layout choices.
const PersistedEffectIntensitySchema = z.number().finite().transform((value) =>
  Math.min(
    MAX_EFFECT_INTENSITY,
    Math.max(MIN_EFFECT_INTENSITY, Math.round(value)),
  ));

export const SettingsSchema = z.object({
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  startup: StartupPrefSchema,
  // Optional + schemaVersion stays 1: settings.json files written before E1
  // still parse with theme absent; layout-store defaults absence to 'matrix'.
  theme: ThemeNameSchema.optional(),
  // UI scale (v0.2.0 D1) — integer percent, absent defaults to 100 in layout-store.
  uiScale: z.number().int().min(80).max(150).optional(),
  // Scrollback buffer size in lines (WT-parity M5) — absent defaults to 5000 in layout-store.
  scrollback: z.number().int().min(100).max(100000).optional(),
  // xterm renderer preference. WebGL is best-effort under 'auto'; 'dom' is
  // the explicit compatibility mode. Mobile ignores this and always uses DOM.
  terminalRenderer: TerminalRendererPreferenceSchema.optional(),
  // Creator-owned pane close confirmation. Mobile session destruction is
  // intentionally always guarded and does not read this desktop preference.
  confirmRiskyPaneClose: z.boolean().optional(),
  /** Plays the CRT boot sequence over the workbench on launch. Optional like
   * every field added since schema version 1, so an older settings file still
   * parses and simply takes the default. */
  bootIntro: z.boolean().optional(),
  // Terminal-originated OSC 52 writes are privileged and default off.
  allowOsc52Clipboard: z.boolean().optional(),
  // Windows Terminal-style text paste warnings. Both default on in
  // layout-store; optional fields keep pre-feature schemaVersion 1 files valid.
  warnOnMultilinePaste: z.boolean().optional(),
  warnOnLargePaste: z.boolean().optional(),
  // Remote WS bridge on/off (v0.2.0 D2) — absent defaults to true (pre-existing
  // always-on behavior) in layout-store.
  remoteEnabled: z.boolean().optional(),
  // Electron main remains alive without a renderer only when explicitly
  // enabled. Runtime enforces startAtLogin => keepRunning.
  keepRunning: z.boolean().optional(),
  startAtLogin: z.boolean().optional(),
  // OpenClaw desktop visibility mode (openclaw-stabilization M2) — absent
  // defaults to 'auto' in layout-store (see OpenClawModeSchema above).
  openclawMode: OpenClawModeSchema.optional(),
  // User font override (theme-effects-font M0) — a renderer/fonts.ts
  // FONT_CATALOG id; absent means "use the active theme's own fontFamily"
  // (resolveFontFamily). Bounded, not enum-validated: an unrecognized id
  // (a removed catalog entry) still parses and just falls back to the theme
  // font rather than corrupting the whole settings file.
  fontFamily: z.string().min(1).max(256).optional(),
  // Per-effect on/off (theme-effects-font M0), keyed by renderer/effects.ts's
  // EffectId — Record<string, ...> rather than a closed key set so a
  // since-removed/renamed effect in an old settings.json still parses.
  // Absent entries default per-platform (desktop: theme-declared default,
  // mobile: off) via resolveActiveEffects's platformDefaults parameter.
  effectToggles: z.record(z.string(), z.boolean()).optional(),
  // crt-rollbar line params (rollbar-params) — a partial wire shape; absent
  // fields (and out-of-range values) default/clamp in
  // renderer/effect-params.ts's clampRollbarParams, so this schema itself
  // stays loose (bounds enforcement lives in exactly one place).
  rollbar: RollbarParamsSchema.optional(),
  // CRT-interference params (crt-interference) — same loose-wire policy as
  // `rollbar`, one blob for all four parameterized effects.
  effectParams: EffectParamsSchema.optional(),
  // Adaptive Workbench UI preferences. Additive optional fields keep the
  // settings envelope at schemaVersion 1 and preserve every pre-redesign file.
  locale: UiLocalePreferenceSchema.optional(),
  density: UiDensitySchema.optional(),
  sidebarWidth: SidebarWidthSchema.optional(),
  effectIntensity: PersistedEffectIntensitySchema.optional(),
  resourceProfile: UiResourceProfileSchema.optional(),
});
export type StartupPref = z.infer<typeof StartupPrefSchema>;
export type SettingsFile = z.infer<typeof SettingsSchema>;

/** Presets file: name -> envelope. Names are display keys only (no path meaning). */
export const PresetNameSchema = z.string().min(1).max(64);
export const PresetsFileSchema = z.object({
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  presets: z.record(PresetNameSchema, LayoutEnvelopeSchema),
});
export type PresetsFile = z.infer<typeof PresetsFileSchema>;

function pruneTransientPanels(node: unknown, removed: ReadonlySet<string>): unknown | null {
  if (typeof node !== 'object' || node === null) return node;
  const candidate = node as Record<string, unknown>;
  if (candidate.type === 'branch' && Array.isArray(candidate.data)) {
    const children = candidate.data
      .map((child) => pruneTransientPanels(child, removed))
      .filter((child) => child !== null);
    candidate.data = children;
    return children.length > 0 ? candidate : null;
  }
  if (candidate.type !== 'leaf' || typeof candidate.data !== 'object' || candidate.data === null) {
    return candidate;
  }
  const data = candidate.data as Record<string, unknown>;
  if (!Array.isArray(data.views)) return candidate;
  const views = data.views.filter((id) => typeof id !== 'string' || !removed.has(id));
  data.views = views;
  if (views.length === 0) return null;
  if (typeof data.activeView !== 'string' || removed.has(data.activeView)) {
    data.activeView = views[0];
  }
  return candidate;
}

function prunePanelIdsFromLayout(
  layout: Record<string, unknown>,
  removed: ReadonlySet<string>,
): void {
  if (removed.size === 0 || typeof layout.grid !== 'object' || layout.grid === null) return;
  const grid = layout.grid as Record<string, unknown>;
  grid.root = pruneTransientPanels(grid.root, removed) ?? { type: 'branch', data: [] };
  if (!Array.isArray(layout.popoutGroups)) return;
  layout.popoutGroups = layout.popoutGroups.filter((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return true;
    const popout = candidate as Record<string, unknown>;
    if (typeof popout.data === 'object' && popout.data !== null) {
      const data = popout.data as Record<string, unknown>;
      if (Array.isArray(data.views)) {
        const views = data.views.filter((id) => typeof id !== 'string' || !removed.has(id));
        data.views = views;
        if (typeof data.activeView !== 'string' || removed.has(data.activeView)) {
          data.activeView = views[0];
        }
        return views.length > 0;
      }
    }
    if (typeof popout.grid === 'object' && popout.grid !== null) {
      const popoutGrid = popout.grid as Record<string, unknown>;
      popoutGrid.root = pruneTransientPanels(popoutGrid.root, removed);
      return popoutGrid.root !== null;
    }
    return true;
  });
}

/** Removes panels from main or popout grids without mutating the input. */
export function removePanelsFromSerializedLayout(
  raw: unknown,
  removed: ReadonlySet<string>,
): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const layout = structuredClone(raw) as Record<string, unknown>;
  if (typeof layout.panels === 'object' && layout.panels !== null) {
    const panels = layout.panels as Record<string, unknown>;
    for (const panelId of removed) delete panels[panelId];
  }
  prunePanelIdsFromLayout(layout, removed);
  return layout;
}

/**
 * Normalize a raw SerializedDockview-shaped value BEFORE validation (save & load
 * share this): drop unsupported feature buckets (B4) and force renderer:'always'.
 * `params` is deliberately NOT stripped here — a params payload (a persisted
 * sessionId above all) must FAIL validation loudly: silently stripping it would
 * mask exactly the resurrection regression the strict schema exists to catch.
 * Returns a structured clone — never mutates the input.
 */
export function sanitizeSerializedLayout(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const layout = structuredClone(raw) as Record<string, unknown>;
  delete layout.floatingGroups;
  delete layout.edgeGroups;
  if (Array.isArray(layout.popoutGroups)) {
    layout.popoutGroups = layout.popoutGroups.map((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return candidate;
      const popout = candidate as Record<string, unknown>;
      // The URL is always rebuilt from the current trusted renderer origin.
      // Dockview's reference-group id can point at a stale main-grid group
      // after a restart, so restoration builds a fresh anchor instead.
      delete popout.url;
      delete popout.gridReferenceGroup;
      return popout;
    });
  }
  if (typeof layout.panels === 'object' && layout.panels !== null) {
    const panels = layout.panels as Record<string, unknown>;
    const transient = new Set<string>();
    for (const [panelId, panel] of Object.entries(panels)) {
      if (typeof panel === 'object' && panel !== null) {
        const record = panel as Record<string, unknown>;
        if (record.contentComponent === 'code-file'
          && typeof record.params === 'object'
          && record.params !== null) {
          const params = record.params as Record<string, unknown>;
          record.contentComponent = 'project-editor';
          record.params = {
            projectId: params.projectId,
            rootId: params.rootId,
            workspaceId: params.workspaceId ?? params.rootId,
            relativePath: params.relativePath,
          };
        } else if (record.contentComponent === 'code-diff'
          && typeof record.params === 'object'
          && record.params !== null) {
          const params = record.params as Record<string, unknown>;
          record.contentComponent = 'project-editor';
          if (typeof params.relativePath !== 'string' || params.relativePath.length === 0) {
            // The legacy review root was a destination rather than a file. It
            // has no honest path identity, so do not resurrect it as a second
            // kind of editor after the file-centric migration.
            transient.add(panelId);
          } else {
            const repositoryRelativePath = typeof params.repositoryRelativePath === 'string'
              ? params.repositoryRelativePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
              : '';
            const relativePath = params.relativePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
            record.params = {
              projectId: params.projectId,
              rootId: params.rootId,
              workspaceId: params.workspaceId ?? params.rootId,
              relativePath: repositoryRelativePath
                ? `${repositoryRelativePath}/${relativePath}`
                : relativePath,
            };
          }
        }
        if (record.contentComponent === 'project-editor'
          && typeof record.params === 'object'
          && record.params !== null) {
          const params = record.params as Record<string, unknown>;
          if (params.preview === true) transient.add(panelId);
          if (typeof params.relativePath === 'string' && params.relativePath.length > 0) {
            const legacyRepositoryPath = params.mode === 'review'
              && typeof params.repositoryRelativePath === 'string'
              ? params.repositoryRelativePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
              : '';
            const relativePath = params.relativePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
            // Comparison source, revision and presentation mode are transient.
            // Persist only the real file that owns the tab.
            record.params = {
              projectId: params.projectId,
              rootId: params.rootId,
              workspaceId: params.workspaceId ?? params.rootId,
              relativePath: legacyRepositoryPath
                ? `${legacyRepositoryPath}/${relativePath}`
                : relativePath,
            };
          } else if (params.mode === 'review') {
            transient.add(panelId);
          }
        }
        record.renderer = record.contentComponent === 'project-editor'
          || record.contentComponent === 'project-map'
          ? 'onlyWhenVisible'
          : 'always';
      }
    }
    for (const panelId of transient) delete panels[panelId];
    prunePanelIdsFromLayout(layout, transient);
  }
  return layout;
}

/**
 * Full read/write validation pipeline: sanitize -> parse -> app invariants.
 * Returns the validated envelope or null (callers route null to the corrupt
 * path on read, or log-and-drop on save — never throw across IPC).
 */
export function validateLayoutEnvelope(data: unknown): LayoutEnvelope | null {
  if (typeof data !== 'object' || data === null) return null;
  const candidate = data as Record<string, unknown>;
  const sanitized = { ...candidate, layout: sanitizeSerializedLayout(candidate.layout) };
  const parsed = LayoutEnvelopeSchema.safeParse(sanitized);
  if (!parsed.success) return null;
  const { panels } = parsed.data.layout;
  const entries = Object.entries(panels);
  if (entries.length === 0 || entries.length > MAX_PANELS) return null; // zero-panel layouts are corrupt (gate e2e f)
  for (const [key, panel] of entries) {
    if (key !== panel.id) return null; // record key must equal panel id (B5)
  }
  const mainOccurrences = collectSerializedPanelIdOccurrences(parsed.data.layout.grid.root);
  const mainPanelIds = new Set(mainOccurrences);
  if (mainPanelIds.size !== mainOccurrences.length) return null;
  const popoutPanelIds = new Set<string>();
  for (const popout of parsed.data.layout.popoutGroups ?? []) {
    const occurrences = popout.data
      ? popout.data.views
      : collectSerializedPanelIdOccurrences(popout.grid!.root);
    const ids = new Set(occurrences);
    if (ids.size !== occurrences.length) return null;
    if (ids.size === 0) return null;
    for (const id of ids) {
      const panel = panels[id];
      if (
        !panel
        || !isDetachablePanelComponent(panel.contentComponent)
        || mainPanelIds.has(id)
        || popoutPanelIds.has(id)
      ) {
        return null;
      }
      popoutPanelIds.add(id);
    }
  }
  return parsed.data;
}

/**
 * Collect panel ids from Dockview's recursive grid without trusting any other
 * leaf data. Runtime preflight remains the authority for full grid validity.
 */
export function collectSerializedPanelIds(root: unknown): Set<string> {
  return new Set(collectSerializedPanelIdOccurrences(root));
}

export function collectSerializedPanelIdOccurrences(root: unknown): string[] {
  const result: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const candidate = node as Record<string, unknown>;
    if (candidate.type === 'branch' && Array.isArray(candidate.data)) {
      for (const child of candidate.data) visit(child);
      return;
    }
    if (
      candidate.type !== 'leaf'
      || typeof candidate.data !== 'object'
      || candidate.data === null
    ) {
      return;
    }
    const views = (candidate.data as Record<string, unknown>).views;
    if (!Array.isArray(views)) return;
    for (const id of views) {
      if (typeof id === 'string') result.push(id);
    }
  };
  visit(root);
  return result;
}

/** SAVE path: wrap a raw api.toJSON() result into a validated envelope. */
export function buildLayoutEnvelope(rawLayout: unknown, savedAt: string): LayoutEnvelope | null {
  return validateLayoutEnvelope({
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    savedAt,
    layout: rawLayout,
  });
}

/**
 * Highest numeric suffix among restored `tab-N` panel ids (F6): the renderer
 * re-seeds its tab counter past this before fromJSON, or the next addPanel
 * would mint a duplicate id and dockview throws. Non-matching ids are ignored.
 */
export function maxTabSuffix(layout: SerializedLayout): number {
  let max = 0;
  for (const id of Object.keys(layout.panels)) {
    const m = id.match(/^tab-(\d+)$/);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max;
}
