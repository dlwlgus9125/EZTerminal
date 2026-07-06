/**
 * Layout persistence schema (Track A ③, A-M1) — the app's first persistence layer.
 *
 * Versioned Zod envelope around dockview's SerializedDockview. Design + Codex gate:
 * `docs/design/layout-persistence-design.md`,
 * `docs/research/2026-07-02-codex-track-a-presets-review.md`.
 *
 * Strictness policy (gate B5), by security weight:
 *  - `params` is a STRICT empty object: ANY key (a persisted sessionId above all)
 *    fails validation loudly — B1/B5 as a checked invariant, not a convention.
 *  - `contentComponent` must be the literal 'terminal': an unknown component would
 *    make dockview-react throw at mount; rejecting here routes to the corrupt path.
 *  - Unsupported serialized feature buckets (floating/popout/edge groups) are
 *    STRIPPED by the sanitizer (gate B4) — we run with floating disabled and
 *    edge/popout unused, so persisted ones can only be stale or hostile.
 *  - Other unknown keys are silently STRIPPED (Zod object default), not rejected:
 *    a future dockview adding a benign key must not brick saved layouts.
 *  - `grid.root` gets a minimal shape check (gate B1): dockview's fromJSON calls
 *    clear() BEFORE the validation that its revert try/catch covers, so a malformed
 *    root must never reach fromJSON at all.
 */
import { z } from 'zod';

export const LAYOUT_SCHEMA_VERSION = 1 as const;

/** Upper bound on restorable panels (gate B5 — bounded input from disk/renderer). */
export const MAX_PANELS = 64;

const PanelSchema = z.object({
  id: z.string().min(1),
  contentComponent: z.literal('terminal'),
  title: z.string().optional(),
  // Serialized panels carry renderer:'always' (F1/F2); tolerate its absence and
  // let the sanitizer force it so restored panes always survive tab switches.
  renderer: z.literal('always').optional(),
  // STRICT empty: a sessionId-like key here is exactly the resurrection bug the
  // Track A P1 gate (B1/B5) forbids — fail loudly, never strip-and-continue.
  params: z.strictObject({}).optional(),
  tabComponent: z.string().optional(),
  minimumWidth: z.number().optional(),
  minimumHeight: z.number().optional(),
  maximumWidth: z.number().optional(),
  maximumHeight: z.number().optional(),
});

const GridSchema = z.looseObject({
  root: z.looseObject({
    type: z.literal('branch'),
    data: z.array(z.unknown()),
  }),
  width: z.number(),
  height: z.number(),
  orientation: z.string(),
});

const LayoutSchema = z.object({
  grid: GridSchema,
  panels: z.record(z.string(), PanelSchema),
  activeGroup: z.string().optional(),
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
/** Built-in theme names (E1) — persisted in settings.json, applied via the
 * `data-theme` DOM attribute + the matching xterm ITheme in renderer/themes.ts. */
export const ThemeNameSchema = z.enum(['dark', 'light', 'high-contrast', 'matrix']);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

export const SettingsSchema = z.object({
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  startup: StartupPrefSchema,
  // Optional + schemaVersion stays 1: settings.json files written before E1
  // still parse with theme absent; layout-store defaults absence to 'dark'.
  theme: ThemeNameSchema.optional(),
  // UI scale (v0.2.0 D1) — integer percent, absent defaults to 100 in layout-store.
  uiScale: z.number().int().min(80).max(150).optional(),
  // Remote WS bridge on/off (v0.2.0 D2) — absent defaults to true (pre-existing
  // always-on behavior) in layout-store.
  remoteEnabled: z.boolean().optional(),
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
  delete layout.popoutGroups;
  delete layout.edgeGroups;
  if (typeof layout.panels === 'object' && layout.panels !== null) {
    for (const panel of Object.values(layout.panels as Record<string, unknown>)) {
      if (typeof panel === 'object' && panel !== null) {
        (panel as Record<string, unknown>).renderer = 'always';
      }
    }
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
  return parsed.data;
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
