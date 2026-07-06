import { describe, expect, it } from 'vitest';

import {
  LAYOUT_SCHEMA_VERSION,
  MAX_PANELS,
  SettingsSchema,
  buildLayoutEnvelope,
  maxTabSuffix,
  sanitizeSerializedLayout,
  validateLayoutEnvelope,
} from './layout-schema';

/** Minimal valid SerializedDockview-shaped layout for tests. */
function makeLayout(panelIds: string[] = ['tab-1']): Record<string, unknown> {
  return {
    grid: {
      root: { type: 'branch', data: [] },
      width: 800,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels: Object.fromEntries(
      panelIds.map((id) => [
        id,
        { id, contentComponent: 'terminal', title: id, renderer: 'always' },
      ]),
    ),
    activeGroup: '1',
  };
}

function makeEnvelope(layout: unknown = makeLayout()): Record<string, unknown> {
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, savedAt: '2026-07-02T00:00:00.000Z', layout };
}

describe('layout-schema — validation pipeline (A-M1)', () => {
  it('round-trips a valid envelope', () => {
    const env = validateLayoutEnvelope(makeEnvelope());
    expect(env).not.toBeNull();
    expect(env?.layout.panels['tab-1'].contentComponent).toBe('terminal');
  });

  it('REJECTS a persisted sessionId in panel params (Codex B1/B5 — never resurrect)', () => {
    const layout = makeLayout();
    (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].params = {
      sessionId: 'stale-session',
    };
    // Loud failure, not silent strip: a params payload means a tampered file or
    // a resurrection regression — either way it routes to the corrupt path.
    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('tolerates an explicitly empty params object', () => {
    const layout = makeLayout();
    (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].params = {};
    expect(validateLayoutEnvelope(makeEnvelope(layout))).not.toBeNull();
  });

  it('REJECTS malformed grid.root (Codex B1 — the pre-revert fromJSON throw window)', () => {
    const layout = makeLayout();
    (layout.grid as Record<string, unknown>).root = { type: 'leaf', data: [] };
    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('REJECTS an unknown contentComponent (React would throw at mount)', () => {
    const layout = makeLayout();
    (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].contentComponent =
      'not-terminal';
    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('STRIPS floating/popout/edge groups instead of persisting them (Codex B4)', () => {
    const layout = makeLayout();
    layout.floatingGroups = [{ anything: true }];
    layout.popoutGroups = [{ anything: true }];
    layout.edgeGroups = [{ anything: true }];
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env).not.toBeNull();
    const persisted = env?.layout as unknown as Record<string, unknown>;
    expect(persisted.floatingGroups).toBeUndefined();
    expect(persisted.popoutGroups).toBeUndefined();
    expect(persisted.edgeGroups).toBeUndefined();
  });

  it('forces renderer:always on every panel (PTY survives tab switches)', () => {
    const layout = makeLayout();
    delete (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].renderer;
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['tab-1'].renderer).toBe('always');
  });

  it('REJECTS a zero-panel layout (gate e2e shape f)', () => {
    expect(validateLayoutEnvelope(makeEnvelope(makeLayout([])))).toBeNull();
  });

  it('REJECTS more than MAX_PANELS panels (bounded input, Codex B5)', () => {
    const ids = Array.from({ length: MAX_PANELS + 1 }, (_, i) => `tab-${i + 1}`);
    expect(validateLayoutEnvelope(makeEnvelope(makeLayout(ids)))).toBeNull();
  });

  it('REJECTS a panels record whose key differs from the panel id (Codex B5)', () => {
    const layout = makeLayout();
    const panels = layout.panels as Record<string, unknown>;
    panels['tab-9'] = { id: 'tab-1', contentComponent: 'terminal' };
    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('REJECTS a schemaVersion mismatch (routes to the corrupt/migration path)', () => {
    const env = makeEnvelope();
    env.schemaVersion = 99;
    expect(validateLayoutEnvelope(env)).toBeNull();
  });

  it('REJECTS garbage input without throwing', () => {
    expect(validateLayoutEnvelope(null)).toBeNull();
    expect(validateLayoutEnvelope('not json shaped')).toBeNull();
    expect(validateLayoutEnvelope({ schemaVersion: 1 })).toBeNull();
  });

  it('buildLayoutEnvelope wraps a raw toJSON() result (save path)', () => {
    const env = buildLayoutEnvelope(makeLayout(['tab-1', 'tab-2']), '2026-07-02T00:00:00.000Z');
    expect(env?.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect(Object.keys(env?.layout.panels ?? {})).toHaveLength(2);
  });

  it('sanitizeSerializedLayout never mutates its input', () => {
    const layout = makeLayout();
    layout.floatingGroups = [{ keep: 'me' }];
    sanitizeSerializedLayout(layout);
    expect(layout.floatingGroups).toEqual([{ keep: 'me' }]);
  });
});

describe('layout-schema — maxTabSuffix (F6 reseed)', () => {
  it('returns the highest tab-N suffix', () => {
    const env = validateLayoutEnvelope(makeEnvelope(makeLayout(['tab-2', 'tab-7', 'tab-3'])));
    expect(maxTabSuffix(env!.layout)).toBe(7);
  });

  it('ignores non tab-N ids and returns 0 when none match', () => {
    const layout = makeLayout(['tab-1']);
    const panels = layout.panels as Record<string, unknown>;
    panels['custom-pane'] = { id: 'custom-pane', contentComponent: 'terminal' };
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(maxTabSuffix(env!.layout)).toBe(1);

    const onlyCustom = makeLayout([]);
    (onlyCustom.panels as Record<string, unknown>)['x'] = { id: 'x', contentComponent: 'terminal' };
    const env2 = validateLayoutEnvelope(makeEnvelope(onlyCustom));
    expect(maxTabSuffix(env2!.layout)).toBe(0);
  });
});

describe('layout-schema — SettingsSchema theme field (E1)', () => {
  it('accepts a settings file with no theme (pre-E1 files still parse)', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.theme).toBeUndefined();
  });

  it('accepts a settings file with a valid theme', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      theme: 'high-contrast',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.theme).toBe('high-contrast');
  });

  it('rejects an unknown theme name', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      theme: 'solarized',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('layout-schema — SettingsSchema uiScale + remoteEnabled fields (v0.2.0 M1)', () => {
  it('round-trips a settings file with both new fields present', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      uiScale: 120,
      remoteEnabled: false,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.uiScale).toBe(120);
    expect(parsed.success && parsed.data.remoteEnabled).toBe(false);
  });

  it('round-trips a settings file with both new fields absent (pre-v0.2.0 files still parse)', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.uiScale).toBeUndefined();
    expect(parsed.success && parsed.data.remoteEnabled).toBeUndefined();
  });

  it.each([79, 151, 100.5])('rejects an out-of-range or non-integer uiScale (%d)', (uiScale) => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      uiScale,
    });
    expect(parsed.success).toBe(false);
  });

  it.each([80, 100, 150])('accepts a boundary uiScale (%d)', (uiScale) => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      uiScale,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-boolean remoteEnabled', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      remoteEnabled: 'yes',
    });
    expect(parsed.success).toBe(false);
  });
});
