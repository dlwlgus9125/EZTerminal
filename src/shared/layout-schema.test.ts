import { describe, expect, it } from 'vitest';

import {
  BUILTIN_THEME_IDS,
  LAYOUT_SCHEMA_VERSION,
  MAX_PANELS,
  SettingsSchema,
  ThemeNameSchema,
  buildLayoutEnvelope,
  isBuiltinTheme,
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

  it('persists only bounded project-session identity and title mode on terminal panels', () => {
    const layout = makeLayout();
    (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].params = {
      projectSession: {
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'worktree-1',
        projectName: 'EZTerminal',
        titleMode: 'generated',
      },
    };

    expect(validateLayoutEnvelope(makeEnvelope(layout))?.layout.panels['tab-1'])
      .toMatchObject({
        params: {
          projectSession: {
            projectId: 'project-1',
            rootId: 'root-1',
            workspaceId: 'worktree-1',
            projectName: 'EZTerminal',
            titleMode: 'generated',
          },
        },
      });
  });

  it('rejects incomplete or executable project-terminal persistence fields', () => {
    const incomplete = makeLayout();
    (incomplete.panels as Record<string, Record<string, unknown>>)['tab-1'].params = {
      projectSession: {
        projectId: 'project-1',
        rootId: 'root-1',
        projectName: 'EZTerminal',
        titleMode: 'generated',
      },
    };
    expect(validateLayoutEnvelope(makeEnvelope(incomplete))).toBeNull();

    const executable = makeLayout();
    (executable.panels as Record<string, Record<string, unknown>>)['tab-1'].params = {
      projectSession: {
        projectId: 'project-1',
        projectName: 'EZTerminal',
        titleMode: 'generated',
      },
      cwd: 'C:\\private',
    };
    expect(validateLayoutEnvelope(makeEnvelope(executable))).toBeNull();
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

  it('ACCEPTS an openclaw-chat panel (openclaw-management M3 — additive union member)', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'openclaw-chat';
    panel.contentComponent = 'openclaw-chat';
    layout.panels = { 'openclaw-chat': panel };
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env).not.toBeNull();
    expect(env?.layout.panels['openclaw-chat'].contentComponent).toBe('openclaw-chat');
  });

  it('REJECTS a params payload on an openclaw-chat panel too (same strict-empty policy as terminal)', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'openclaw-chat';
    panel.contentComponent = 'openclaw-chat';
    panel.params = { sessionId: 'stale-session' };
    layout.panels = { 'openclaw-chat': panel };
    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('ACCEPTS an Agent history panel with a bounded historyId and public provider identity', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'agent-session-codex_0123456789abcdef01234567';
    panel.contentComponent = 'agent-session';
    panel.params = {
      historyId: 'codex_0123456789abcdef01234567',
      provider: 'codex',
      projectId: 'project_0123456789abcdef',
      rootId: 'root_0123456789abcdef',
      workspaceId: 'workspace_0123456789abcdef',
    };
    layout.panels = { [panel.id as string]: panel };

    const env = validateLayoutEnvelope(makeEnvelope(layout));

    expect(env?.layout.panels[panel.id as string]).toMatchObject({
      contentComponent: 'agent-session',
      params: {
        historyId: 'codex_0123456789abcdef01234567',
        provider: 'codex',
        projectId: 'project_0123456789abcdef',
        rootId: 'root_0123456789abcdef',
        workspaceId: 'workspace_0123456789abcdef',
      },
    });
  });

  it('REJECTS private provider thread ids or transcript data added to Agent history params', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.contentComponent = 'agent-session';
    panel.params = {
      historyId: 'codex_0123456789abcdef01234567',
      providerThreadId: 'private-thread-id',
    };

    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('an old terminal-only layout file (pre-M3) still parses unaffected', () => {
    const env = validateLayoutEnvelope(makeEnvelope(makeLayout(['tab-1', 'tab-2'])));
    expect(env).not.toBeNull();
    expect(env?.layout.panels['tab-1'].contentComponent).toBe('terminal');
    expect(env?.layout.panels['tab-2'].contentComponent).toBe('terminal');
  });

  it('strips floating/edge groups while preserving a validated terminal popout', () => {
    const layout = makeLayout(['tab-1', 'tab-2']);
    layout.floatingGroups = [{ anything: true }];
    layout.popoutGroups = [{
      data: { id: 'popout-1', views: ['tab-2'], activeView: 'tab-2' },
      position: { left: -800, top: 40, width: 900, height: 600 },
      url: 'https://hostile.invalid/',
      gridReferenceGroup: 'stale-group',
    }];
    layout.edgeGroups = [{ anything: true }];
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env).not.toBeNull();
    const persisted = env?.layout as unknown as Record<string, unknown>;
    expect(persisted.floatingGroups).toBeUndefined();
    expect(persisted.edgeGroups).toBeUndefined();
    expect(persisted.popoutGroups).toEqual([{
      data: { id: 'popout-1', views: ['tab-2'], activeView: 'tab-2' },
      position: { left: -800, top: 40, width: 900, height: 600 },
    }]);
  });

  it('accepts an Agent Session popout with only its bounded public identity', () => {
    const layout = makeLayout(['tab-1']);
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'agent-session-repro';
    panel.contentComponent = 'agent-session';
    panel.params = { historyId: 'codex_repro', provider: 'codex' };
    layout.panels = { 'agent-session-repro': panel };
    layout.popoutGroups = [{
      data: {
        id: 'popout-1',
        views: ['agent-session-repro'],
        activeView: 'agent-session-repro',
      },
      position: { left: 20, top: 20, width: 800, height: 600 },
    }];

    const env = validateLayoutEnvelope(makeEnvelope(layout));

    expect(env?.layout.popoutGroups?.[0]?.data?.views).toEqual([
      'agent-session-repro',
    ]);
  });

  it('accepts a registered OpenClaw native-surface popout', () => {
    const openClaw = makeLayout(['tab-1']);
    const panel = (openClaw.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'openclaw-chat';
    panel.contentComponent = 'openclaw-chat';
    openClaw.panels = { 'openclaw-chat': panel };
    openClaw.popoutGroups = [{
      data: { id: 'popout-1', views: ['openclaw-chat'] },
      position: { left: 20, top: 20, width: 800, height: 600 },
    }];

    expect(validateLayoutEnvelope(makeEnvelope(openClaw))?.layout.popoutGroups?.[0]
      ?.data?.views).toEqual(['openclaw-chat']);
  });

  it('rejects unknown, duplicate, or non-finite popout panel placement', () => {
    const unknown = makeLayout(['tab-1']);
    (unknown.panels as Record<string, Record<string, unknown>>)['tab-1'].contentComponent =
      'unregistered-native-panel';
    unknown.popoutGroups = [{
      data: { id: 'popout-1', views: ['tab-1'] },
      position: { left: 20, top: 20, width: 800, height: 600 },
    }];
    expect(validateLayoutEnvelope(makeEnvelope(unknown))).toBeNull();

    const duplicate = makeLayout(['tab-1']);
    duplicate.popoutGroups = [
      {
        data: { id: 'popout-1', views: ['tab-1'] },
        position: { left: 20, top: 20, width: 800, height: 600 },
      },
      {
        data: { id: 'popout-2', views: ['tab-1'] },
        position: { left: 40, top: 40, width: 800, height: 600 },
      },
    ];
    expect(validateLayoutEnvelope(makeEnvelope(duplicate))).toBeNull();

    const nonFinite = makeLayout(['tab-1']);
    nonFinite.popoutGroups = [{
      data: { id: 'popout-1', views: ['tab-1'] },
      position: { left: Number.NaN, top: 20, width: 800, height: 600 },
    }];
    expect(validateLayoutEnvelope(makeEnvelope(nonFinite))).toBeNull();
  });

  it('forces renderer:always on every panel (PTY survives tab switches)', () => {
    const layout = makeLayout();
    delete (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].renderer;
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['tab-1'].renderer).toBe('always');
  });

  it('sanitizer forces renderer:always on an openclaw-chat panel too (no hard-coded terminal assumption)', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'openclaw-chat';
    panel.contentComponent = 'openclaw-chat';
    delete panel.renderer;
    layout.panels = { 'openclaw-chat': panel };
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['openclaw-chat'].renderer).toBe('always');
  });

  it('persists only bounded Project Map collection identity and restores it lazily', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.contentComponent = 'project-map';
    panel.params = {
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      mapId: 'runtime-architecture',
    };
    delete panel.renderer;

    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['tab-1']).toMatchObject({
      contentComponent: 'project-map',
      renderer: 'onlyWhenVisible',
      params: {
        projectId: 'project-1',
        ownerRootId: 'root-1',
        ownerWorkspaceId: 'workspace-1',
        mapId: 'runtime-architecture',
      },
    });
  });

  it('rejects executable or non-portable Project Map panel parameters', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.contentComponent = 'project-map';
    panel.params = {
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      mapId: '../runtime',
      sourcePath: 'C:\\private\\map.json',
    };
    expect(validateLayoutEnvelope(makeEnvelope(layout))).toBeNull();
  });

  it('migrates a legacy code-file descriptor to one path-based editor', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'code-1';
    panel.contentComponent = 'code-file';
    panel.params = { projectId: 'project-1', rootId: 'root-1', relativePath: 'src/app.ts' };
    delete panel.renderer;
    layout.panels = { 'code-1': panel };
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['code-1']).toMatchObject({
      contentComponent: 'project-editor',
      renderer: 'onlyWhenVisible',
      params: {
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'root-1',
        relativePath: 'src/app.ts',
      },
    });
    expect(JSON.stringify(env)).not.toContain('file contents');
  });

  it('drops a legacy review destination that has no real file identity', () => {
    const layout = makeLayout(['tab-1', 'diff-1']);
    (layout.grid as { root: unknown }).root = {
      type: 'branch',
      data: [{
        type: 'leaf',
        data: { views: ['tab-1', 'diff-1'], activeView: 'diff-1' },
      }],
    };
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['diff-1'];
    panel.id = 'diff-1';
    panel.contentComponent = 'code-diff';
    panel.params = {
      projectId: 'project-1',
      rootId: 'root-1',
      scope: 'last-turn',
      historyId: 'history-1',
      reviewTurnId: 'turn-1',
    };
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env).not.toBeNull();
    expect(env?.layout.panels['diff-1']).toBeUndefined();
  });

  it('migrates a nested-repository diff to its project-relative file path', () => {
    const layout = makeLayout();
    const panel = (layout.panels as Record<string, Record<string, unknown>>)['tab-1'];
    panel.id = 'diff-nested';
    panel.contentComponent = 'code-diff';
    panel.params = {
      projectId: 'project-1',
      rootId: 'root-1',
      repositoryRelativePath: 'out/manual-test-project',
      repositoryName: 'manual-test-project',
      scope: 'working-tree',
      relativePath: 'src/app.ts',
    };
    layout.panels = { 'diff-nested': panel };
    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['diff-nested']).toMatchObject({
      contentComponent: 'project-editor',
      renderer: 'onlyWhenVisible',
      params: {
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'root-1',
        relativePath: 'out/manual-test-project/src/app.ts',
      },
    });
  });

  it('drops previews and persists only the path identity of a pinned editor', () => {
    const layout = makeLayout(['tab-1', 'preview-1', 'review-1']);
    (layout.grid as { root: unknown }).root = {
      type: 'branch',
      data: [{
        type: 'leaf',
        data: {
          views: ['tab-1', 'preview-1', 'review-1'],
          activeView: 'review-1',
        },
      }],
    };
    const panels = layout.panels as Record<string, Record<string, unknown>>;
    panels['preview-1'] = {
      id: 'preview-1',
      contentComponent: 'project-editor',
      renderer: 'onlyWhenVisible',
      params: {
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
        relativePath: 'src/preview.ts',
        preview: true,
      },
    };
    panels['review-1'] = {
      id: 'review-1',
      contentComponent: 'project-editor',
      renderer: 'onlyWhenVisible',
      params: {
        mode: 'review',
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
        sourceSelection: { kind: 'working-tree' },
        relativePath: 'src/app.ts',
        revision: 'a'.repeat(64),
        comparison: { sourceSelection: { kind: 'working-tree' } },
      },
    };

    const env = validateLayoutEnvelope(makeEnvelope(layout));
    expect(env?.layout.panels['preview-1']).toBeUndefined();
    expect(env?.layout.panels['review-1']).toMatchObject({
      renderer: 'onlyWhenVisible',
    });
    expect(env?.layout.panels['review-1'].params).toEqual({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
    });
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

describe('layout-schema — additive Adaptive Workbench preferences', () => {
  it('keeps schemaVersion 1 and accepts locale, density, and sidebar width', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: 1,
      startup: { mode: 'last' },
      locale: 'system',
      density: 'adaptive',
      sidebarWidth: 320,
    });
    expect(parsed.success).toBe(true);
  });

  it('continues to accept a pre-redesign settings file with all fields absent', () => {
    expect(SettingsSchema.safeParse({
      schemaVersion: 1,
      startup: { mode: 'last' },
    }).success).toBe(true);
  });

  it('rejects invalid preference values without changing the envelope version', () => {
    expect(SettingsSchema.safeParse({
      schemaVersion: 1,
      startup: { mode: 'last' },
      density: 'dense',
    }).success).toBe(false);
    expect(SettingsSchema.safeParse({
      schemaVersion: 1,
      startup: { mode: 'last' },
      sidebarWidth: 500,
    }).success).toBe(false);
  });

  it('clamps only persisted numeric effect intensity while keeping the IPC schema strict', () => {
    const above = SettingsSchema.parse({
      schemaVersion: 1,
      startup: { mode: 'last' },
      effectIntensity: 11,
    });
    const below = SettingsSchema.parse({
      schemaVersion: 1,
      startup: { mode: 'last' },
      effectIntensity: -2.4,
    });
    expect(above.effectIntensity).toBe(10);
    expect(below.effectIntensity).toBe(0);
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

  it('accepts a settings file with a valid built-in theme', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      theme: 'high-contrast',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.theme).toBe('high-contrast');
  });

  it('rejects an empty theme string', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      theme: '',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('layout-schema — ThemeNameSchema is an open string (theme-effects-font M0)', () => {
  it.each(BUILTIN_THEME_IDS)('back-compat: old built-in theme value %s still parses', (name) => {
    expect(ThemeNameSchema.safeParse(name).success).toBe(true);
  });

  it('accepts an arbitrary custom theme id (no longer a closed enum)', () => {
    // Pre-M0 this was rejected outright (closed z.enum of the 4 built-ins).
    // Custom/imported theme mods now carry their own id, so the schema is an
    // open, non-empty string — id-shape/safety is enforced separately by
    // shared/theme-schema.ts's validateThemeMod, not here.
    expect(ThemeNameSchema.safeParse('solarized').success).toBe(true);
    expect(ThemeNameSchema.safeParse('my-neon-mod').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(ThemeNameSchema.safeParse('').success).toBe(false);
  });
});

describe('layout-schema — isBuiltinTheme', () => {
  it('is true for exactly the 4 built-ins', () => {
    for (const id of BUILTIN_THEME_IDS) expect(isBuiltinTheme(id)).toBe(true);
  });

  it('is false for a custom/unknown id', () => {
    expect(isBuiltinTheme('my-neon-mod')).toBe(false);
    expect(isBuiltinTheme('')).toBe(false);
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

describe('layout-schema — SettingsSchema scrollback field (WT-parity M5)', () => {
  it('round-trips a settings file with scrollback present', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      scrollback: 20000,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.scrollback).toBe(20000);
  });

  it('round-trips a settings file with scrollback absent (pre-M5 files still parse)', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.scrollback).toBeUndefined();
  });

  it.each([99, 100001, 5000.5])('rejects an out-of-range or non-integer scrollback (%d)', (scrollback) => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      scrollback,
    });
    expect(parsed.success).toBe(false);
  });

  it.each([100, 5000, 100000])('accepts a boundary scrollback (%d)', (scrollback) => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      scrollback,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('layout-schema — SettingsSchema fontFamily + effectToggles fields (theme-effects-font M0)', () => {
  it('round-trips a settings file with both new fields present', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      fontFamily: 'jetbrains-mono',
      effectToggles: { scanlines: true, flicker: false },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fontFamily).toBe('jetbrains-mono');
    expect(parsed.success && parsed.data.effectToggles).toEqual({ scanlines: true, flicker: false });
  });

  it('round-trips a settings file with both new fields absent (pre-M0 files still parse)', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fontFamily).toBeUndefined();
    expect(parsed.success && parsed.data.effectToggles).toBeUndefined();
  });

  it('rejects an empty fontFamily string', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      fontFamily: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-boolean value inside effectToggles', () => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      startup: { mode: 'last' },
      effectToggles: { scanlines: 'on' },
    });
    expect(parsed.success).toBe(false);
  });
});
