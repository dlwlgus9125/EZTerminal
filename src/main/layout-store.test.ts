import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LayoutStore } from './layout-store';
import { LAYOUT_SCHEMA_VERSION } from '../shared/layout-schema';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-layout-store-'));
}

function makeLayout(panelIds: string[] = ['tab-1']): Record<string, unknown> {
  return {
    grid: {
      root: { type: 'branch', data: [] },
      width: 800,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels: Object.fromEntries(
      panelIds.map((id) => [id, { id, contentComponent: 'terminal', renderer: 'always' }]),
    ),
  };
}

describe('LayoutStore — layout save/load (A-M2)', () => {
  it('round-trips a layout through save -> flush -> load', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    store.saveLayout(makeLayout(['tab-1', 'tab-2']));
    await store.flush();
    const env = await store.loadLayout();
    expect(env?.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect(Object.keys(env?.layout.panels ?? {})).toEqual(['tab-1', 'tab-2']);
  });

  it('returns null when no layout was ever saved', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.loadLayout()).toBeNull();
  });

  it('collapses a save burst to the newest layout (latest-wins)', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    for (let i = 1; i <= 20; i++) store.saveLayout(makeLayout([`tab-${i}`]));
    await store.flush();
    const env = await store.loadLayout();
    expect(Object.keys(env?.layout.panels ?? {})).toEqual(['tab-20']);
  });

  it('drops an invalid layout save without touching the stored file', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    store.saveLayout(makeLayout(['tab-1']));
    await store.flush();
    store.saveLayout({ not: 'a layout' });
    await store.flush();
    const env = await store.loadLayout();
    expect(Object.keys(env?.layout.panels ?? {})).toEqual(['tab-1']); // unchanged
  });

  it('quarantines unparseable JSON to .corrupt and returns null', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'layout.json'), '{ not json !!!', 'utf8');
    expect(await store.loadLayout()).toBeNull();
    expect(existsSync(path.join(dir, 'layout.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'layout.json.corrupt'))).toBe(true);
  });

  it('quarantines a schema-invalid layout (persisted sessionId in params)', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    const layout = makeLayout(['tab-1']);
    (layout.panels as Record<string, Record<string, unknown>>)['tab-1'].params = {
      sessionId: 'stale',
    };
    writeFileSync(
      path.join(dir, 'layout.json'),
      JSON.stringify({ schemaVersion: 1, savedAt: 'x', layout }),
      'utf8',
    );
    expect(await store.loadLayout()).toBeNull();
    expect(existsSync(path.join(dir, 'layout.json.corrupt'))).toBe(true);
  });

  it('overwrites a previous .corrupt on re-quarantine (latest evidence wins)', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'layout.json.corrupt'), 'older evidence', 'utf8');
    writeFileSync(path.join(dir, 'layout.json'), 'newer garbage', 'utf8');
    expect(await store.loadLayout()).toBeNull();
    expect(readFileSync(path.join(dir, 'layout.json.corrupt'), 'utf8')).toBe('newer garbage');
  });

  it('init() removes crash-stale .tmp files', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'layout.json.tmp'), 'half-written', 'utf8');
    const store = new LayoutStore(dir);
    await store.init();
    expect(existsSync(path.join(dir, 'layout.json.tmp'))).toBe(false);
  });

  it('leaves no .tmp behind after a successful write', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    store.saveLayout(makeLayout());
    await store.flush();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('LayoutStore — presets & startup (A-M2)', () => {
  it('saves, lists, gets, and deletes presets', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.savePreset('dev 2-pane', makeLayout(['tab-1', 'tab-2']))).toBe(true);
    expect(await store.listPresets()).toEqual(['dev 2-pane']);
    const env = await store.getPreset('dev 2-pane');
    expect(Object.keys(env?.layout.panels ?? {})).toHaveLength(2);
    await store.deletePreset('dev 2-pane');
    expect(await store.listPresets()).toEqual([]);
  });

  it('rejects invalid preset names and layouts', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.savePreset('', makeLayout())).toBe(false);
    expect(await store.savePreset('x'.repeat(65), makeLayout())).toBe(false);
    expect(await store.savePreset('ok', { garbage: true })).toBe(false);
    expect(await store.listPresets()).toEqual([]);
  });

  it('startup pref defaults to last and round-trips a preset choice', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getStartup()).toEqual({ mode: 'last' });
    await store.setStartup({ mode: 'preset', presetName: 'dev 2-pane' });
    expect(await store.getStartup()).toEqual({ mode: 'preset', presetName: 'dev 2-pane' });
  });

  it('a corrupt presets file quarantines and reads as empty', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'presets.json'), 'garbage', 'utf8');
    expect(await store.listPresets()).toEqual([]);
    expect(existsSync(path.join(dir, 'presets.json.corrupt'))).toBe(true);
  });
});

describe('LayoutStore — theme (E1)', () => {
  it('defaults to matrix and round-trips a theme choice', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getTheme()).toBe('matrix');
    await store.setTheme('light');
    expect(await store.getTheme()).toBe('light');
  });

  it('setTheme preserves a previously-set startup pref (shared settings.json)', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    await store.setStartup({ mode: 'preset', presetName: 'dev 2-pane' });
    await store.setTheme('high-contrast');
    expect(await store.getStartup()).toEqual({ mode: 'preset', presetName: 'dev 2-pane' });
    expect(await store.getTheme()).toBe('high-contrast');
  });

  it('setStartup preserves a previously-set theme (shared settings.json)', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    await store.setTheme('light');
    await store.setStartup({ mode: 'preset', presetName: 'dev 2-pane' });
    expect(await store.getTheme()).toBe('light');
    expect(await store.getStartup()).toEqual({ mode: 'preset', presetName: 'dev 2-pane' });
  });
});

describe('LayoutStore — uiScale + remoteEnabled (v0.2.0 M1)', () => {
  it('defaults uiScale to 100 and round-trips a set value', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getUiScale()).toBe(100);
    await store.setUiScale(120);
    expect(await store.getUiScale()).toBe(120);
  });

  it('defaults remoteEnabled to false (opt-in) and round-trips a set value', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getRemoteEnabled()).toBe(false);
    await store.setRemoteEnabled(true);
    expect(await store.getRemoteEnabled()).toBe(true);
  });

  it('defaults scrollback to 5000 and round-trips a set value (WT-parity M5)', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getScrollback()).toBe(5000);
    await store.setScrollback(20000);
    expect(await store.getScrollback()).toBe(20000);
  });

  it('defaults terminal rendering to auto and preserves the compatibility choice', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getTerminalRenderer()).toBe('auto');
    await store.setTerminalRenderer('dom');
    expect(await store.getTerminalRenderer()).toBe('dom');
    await store.setTheme('light');
    expect(await store.getTerminalRenderer()).toBe('dom');
  });

  it('defaults risky pane close confirmation on and round-trips an opt-out', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getConfirmRiskyPaneClose()).toBe(true);
    await store.setConfirmRiskyPaneClose(false);
    expect(await store.getConfirmRiskyPaneClose()).toBe(false);
    await store.setTheme('light');
    expect(await store.getConfirmRiskyPaneClose()).toBe(false);
  });

  it('keeps OSC 52 clipboard writes opt-in and persists an explicit choice', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getAllowOsc52Clipboard()).toBe(false);
    await store.setAllowOsc52Clipboard(true);
    expect(await store.getAllowOsc52Clipboard()).toBe(true);
    await store.setTheme('light');
    expect(await store.getAllowOsc52Clipboard()).toBe(true);
  });

  it('interleaved setTheme/setUiScale/setRemoteEnabled all preserve each other (shared settings.json)', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    await store.setTheme('matrix');
    await store.setUiScale(130);
    await store.setRemoteEnabled(false);
    expect(await store.getTheme()).toBe('matrix');
    expect(await store.getUiScale()).toBe(130);
    expect(await store.getRemoteEnabled()).toBe(false);

    // Reorder: setRemoteEnabled first, theme last — still no clobber.
    await store.setRemoteEnabled(true);
    await store.setTheme('light');
    expect(await store.getUiScale()).toBe(130);
    expect(await store.getRemoteEnabled()).toBe(true);
    expect(await store.getTheme()).toBe('light');
  });
});

describe('LayoutStore — openclawMode (openclaw-stabilization M2)', () => {
  it('defaults openclawMode to auto and round-trips a set value', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    expect(await store.getOpenClawMode()).toBe('auto');
    await store.setOpenClawMode('on');
    expect(await store.getOpenClawMode()).toBe('on');
    await store.setOpenClawMode('off');
    expect(await store.getOpenClawMode()).toBe('off');
  });

  it('falls back to auto when the persisted settings.json is schema-invalid (whole file quarantines)', async () => {
    const dir = makeDir();
    const store = new LayoutStore(dir);
    await store.init();
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, openclawMode: 'bogus' }),
      'utf8',
    );
    expect(await store.getOpenClawMode()).toBe('auto');
    expect(existsSync(path.join(dir, 'settings.json.corrupt'))).toBe(true);
  });

  it('preserves openclawMode alongside other settings writes (shared settings.json)', async () => {
    const store = new LayoutStore(makeDir());
    await store.init();
    await store.setOpenClawMode('on');
    await store.setTheme('light');
    expect(await store.getOpenClawMode()).toBe('on');
    expect(await store.getTheme()).toBe('light');

    // Reorder: setTheme first, openclawMode last — still no clobber.
    await store.setTheme('high-contrast');
    await store.setOpenClawMode('off');
    expect(await store.getTheme()).toBe('high-contrast');
    expect(await store.getOpenClawMode()).toBe('off');
  });
});
