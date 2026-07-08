import { useCallback, useEffect, useRef, useState } from 'react';

import type { ThemeName } from '../shared/layout-schema';
import { EFFECT_CATALOG, type EffectId } from './effects';
import type { RollbarParams } from './effect-params';
import { FONT_CATALOG } from './fonts';
import type { ThemeDefinition } from './themes';
import { UI_SCALE_DEFAULT } from './ui-scale';

/**
 * Settings drawer (v0.2.0 M2; theme/font/effects added in theme-effects-font
 * M3): UI scale stepper, remote bridge toggle, theme picker + import, font
 * picker, per-effect toggles. Right-edge overlay reusing StatusPanel/
 * ConnectionInfoPanel's `status-drawer`/`status-section` chrome — same slot
 * family, different content, so it shares App.tsx's stats/pairing mutual-
 * exclusion group.
 */
interface SettingsPanelProps {
  readonly uiScale: number;
  readonly onChangeUiScale: (percent: number) => void;
  readonly theme: ThemeName;
  readonly onSelectTheme: (name: ThemeName) => void;
  readonly availableThemes: readonly ThemeDefinition[];
  readonly onImportTheme: (json: string) => Promise<{ ok: boolean; error?: string }>;
  readonly fontId: string | undefined;
  readonly onSelectFont: (id: string) => void;
  /** The ACTIVE theme's declared effect ids only (renderer/themes.ts's
   * ThemeDefinition.effects) — an effect the theme doesn't declare has
   * nothing to toggle (AC-E4). */
  readonly activeThemeEffects: readonly string[];
  readonly effectToggles: Record<string, boolean>;
  readonly onToggleEffect: (id: string, on: boolean) => void;
  /** crt-rollbar line params (rollbar-params) — controls render beneath the
   * crt-rollbar toggle only when the active theme declares that effect. */
  readonly rollbar: RollbarParams;
  readonly onChangeRollbar: (partial: Partial<RollbarParams>) => void;
}

export function SettingsPanel({
  uiScale,
  onChangeUiScale,
  theme,
  onSelectTheme,
  availableThemes,
  onImportTheme,
  fontId,
  onSelectFont,
  activeThemeEffects,
  effectToggles,
  onToggleEffect,
  rollbar,
  onChangeRollbar,
}: SettingsPanelProps): JSX.Element {
  const [remoteEnabled, setRemoteEnabled] = useState<boolean | null>(null);
  const [remotePort, setRemotePort] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.ezterminal.getRemoteEnabled().then((v) => {
      if (alive) setRemoteEnabled(v);
    });
    void window.ezterminal.getRemoteConnectionInfo().then((info) => {
      if (alive) setRemotePort(info.port);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleRemoteToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.checked;
    void window.ezterminal.setRemoteEnabled(next).then((running) => setRemoteEnabled(running));
  }, []);

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file after a failed import
      if (!file) return;
      void file.text().then(async (text) => {
        const result = await onImportTheme(text);
        setImportError(result.ok ? null : (result.error ?? 'Import failed'));
      });
    },
    [onImportTheme],
  );

  const remoteLoading = remoteEnabled === null || remotePort === null;
  const systemDefaultFontId = FONT_CATALOG.find((f) => f.systemDefault)?.id ?? FONT_CATALOG[0].id;

  return (
    <div className="status-drawer" data-testid="settings-panel">
      <section className="status-section">
        <h2 className="status-section-title">UI Scale</h2>
        <div className="settings-scale-stepper">
          <button
            type="button"
            className="btn btn-split"
            onClick={() => onChangeUiScale(uiScale - 10)}
            data-testid="settings-scale-dec"
          >
            −
          </button>
          <span className="settings-scale-value" data-testid="settings-scale-value">
            {uiScale}%
          </span>
          <button
            type="button"
            className="btn btn-split"
            onClick={() => onChangeUiScale(uiScale + 10)}
            data-testid="settings-scale-inc"
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-split"
            onClick={() => onChangeUiScale(UI_SCALE_DEFAULT)}
            data-testid="settings-scale-reset"
          >
            Reset
          </button>
        </div>
      </section>

      <section className="status-section">
        <h2 className="status-section-title">Theme</h2>
        <select
          className="settings-theme-select"
          value={theme}
          onChange={(e) => onSelectTheme(e.target.value)}
          data-testid="settings-theme-select"
        >
          {availableThemes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="settings-theme-import">
          <input
            type="file"
            accept="application/json,.json"
            ref={importInputRef}
            style={{ display: 'none' }}
            onChange={handleImportFile}
            data-testid="settings-theme-import-file"
          />
          <button
            type="button"
            className="btn btn-split"
            onClick={() => importInputRef.current?.click()}
            data-testid="settings-theme-import-btn"
          >
            Import theme…
          </button>
          {importError && (
            <div className="settings-theme-import-error" data-testid="settings-theme-import-error">
              {importError}
            </div>
          )}
        </div>
      </section>

      <section className="status-section">
        <h2 className="status-section-title">Font</h2>
        <select
          className="settings-font-select"
          value={fontId ?? systemDefaultFontId}
          onChange={(e) => onSelectFont(e.target.value)}
          data-testid="settings-font-select"
        >
          {FONT_CATALOG.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </section>

      <section className="status-section">
        <h2 className="status-section-title">Effects</h2>
        {activeThemeEffects.length === 0 ? (
          <div className="status-loading" data-testid="settings-effects-empty">
            No effects for this theme
          </div>
        ) : (
          activeThemeEffects.map((id) => {
            const entry = EFFECT_CATALOG[id as EffectId];
            if (!entry) return null;
            const on = effectToggles[id] ?? entry.defaultOn;
            return (
              <div key={id}>
                <label className="settings-radio-row">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => onToggleEffect(id, e.target.checked)}
                    data-testid={`settings-effect-${id}`}
                  />
                  <span>{entry.label}</span>
                </label>
                {id === 'crt-rollbar' && (
                  <div className="settings-rollbar-params" data-testid="settings-rollbar-params">
                    <label className="settings-rollbar-row">
                      <span>Line count: {rollbar.count}</span>
                      <input
                        type="range"
                        min={1}
                        max={40}
                        step={1}
                        value={rollbar.count}
                        onChange={(e) => onChangeRollbar({ count: Number(e.target.value) })}
                        data-testid="settings-rollbar-count"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>Line thickness: {rollbar.thickness}px</span>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        step={1}
                        value={rollbar.thickness}
                        onChange={(e) => onChangeRollbar({ thickness: Number(e.target.value) })}
                        data-testid="settings-rollbar-thickness"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>Line spread: {rollbar.gap}%</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={rollbar.gap}
                        onChange={(e) => onChangeRollbar({ gap: Number(e.target.value) })}
                        data-testid="settings-rollbar-gap"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>Line color</span>
                      <input
                        type="color"
                        value={rollbar.color}
                        onChange={(e) => onChangeRollbar({ color: e.target.value })}
                        data-testid="settings-rollbar-color"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>Roll speed: {rollbar.speed}</span>
                      <input
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={rollbar.speed}
                        onChange={(e) => onChangeRollbar({ speed: Number(e.target.value) })}
                        data-testid="settings-rollbar-speed"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>Bar opacity: {rollbar.opacity}%</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={rollbar.opacity}
                        onChange={(e) => onChangeRollbar({ opacity: Number(e.target.value) })}
                        data-testid="settings-rollbar-opacity"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>Line gradient: {rollbar.softness}%</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={rollbar.softness}
                        onChange={(e) => onChangeRollbar({ softness: Number(e.target.value) })}
                        data-testid="settings-rollbar-softness"
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="status-section">
        <h2 className="status-section-title">Remote Access</h2>
        {remoteLoading ? (
          <div className="status-loading">Loading…</div>
        ) : (
          <>
            <label className="settings-radio-row">
              <input
                type="checkbox"
                checked={remoteEnabled}
                onChange={handleRemoteToggle}
                data-testid="settings-remote-toggle"
              />
              <span>Enable remote access</span>
            </label>
            <div className="status-metric">
              WS bridge on port {remotePort} — {remoteEnabled ? 'running' : 'off'}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
