import { useCallback, useState } from 'react';

import { EFFECT_CATALOG, type EffectId } from '../../src/renderer/effects';
import {
  applyInterferenceParams,
  applyRollbarParams,
  clampInterferenceParams,
  clampRollbarParams,
  type InterferenceParams,
  type RollbarParams,
} from '../../src/renderer/effect-params';
import { EffectParamSliders, isInterferenceEffectId } from '../../src/renderer/EffectParamSliders';
import { FONT_CATALOG } from '../../src/renderer/fonts';
import { applyThemeVarsAndEffects, setUserFontId } from '../../src/renderer/theme-runtime';
import { getActiveTheme, getActiveThemeName } from '../../src/renderer/themes';
import {
  UI_SCALE_DEFAULT,
  UI_SCALE_STEP,
  applyUiScale,
  clampUiScale,
} from '../../src/renderer/ui-scale';
import {
  MOBILE_EFFECT_DEFAULTS,
  loadEffectParams,
  loadEffectToggles,
  loadFont,
  loadRollbar,
  saveEffectParams,
  saveEffectToggles,
  saveFont,
  saveRollbar,
} from './theme';
import { loadUiScale, saveUiScale } from './ui-scale';

const CONNECTION_STORAGE_KEY = 'ezterminal-mobile-connection';

/** Best-effort read of the saved connection's server URL for display only
 * (see App.tsx's `loadSaved`/`STORAGE_KEY` for the persisted shape) — any
 * parse failure just shows the empty-state dash, same as App.tsx's own
 * corrupt-value handling. */
function readConnectionUrl(): string {
  try {
    const raw = localStorage.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    const url = (parsed as { url?: unknown } | null)?.url;
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

// MobileSettingsView — full-screen settings overlay (v0.2.0 M4). Modeled on
// MobileStatsView.tsx's structure (standalone view, own header, `.btn`/
// `--term-*` styling). Reached only from the authed MobileWorkspace, so
// "Connection" always reflects a live session — there is no disconnected
// state to render here.
interface MobileSettingsViewProps {
  readonly onClose: () => void;
  readonly onDisconnect: () => void;
}

export function MobileSettingsView({
  onClose,
  onDisconnect,
}: MobileSettingsViewProps): JSX.Element {
  const [uiScale, setUiScale] = useState(() => loadUiScale());
  const [connectionUrl] = useState(() => readConnectionUrl());

  // clamp -> applyUiScale (live) -> saveUiScale (persist) -> state, per plan D1/D5.
  const setScale = useCallback((percent: number) => {
    const clamped = clampUiScale(percent);
    applyUiScale(clamped);
    saveUiScale(clamped);
    setUiScale(clamped);
  }, []);

  const dec = useCallback(() => setScale(uiScale - UI_SCALE_STEP), [setScale, uiScale]);
  const inc = useCallback(() => setScale(uiScale + UI_SCALE_STEP), [setScale, uiScale]);
  const reset = useCallback(() => setScale(UI_SCALE_DEFAULT), [setScale]);

  // ── Font (theme-effects-font Wave 3) ────────────────────────────────────
  const [fontId, setFontId] = useState(() => loadFont());
  const selectFont = useCallback((id: string) => {
    saveFont(id);
    setUserFontId(id);
    setFontId(id);
    window.dispatchEvent(new Event('ez:theme')); // PtyBlock's applyTypography listens for this
  }, []);

  // ── Effects (theme-effects-font Wave 3) ─────────────────────────────────
  // Filtered to the ACTIVE theme's own declared effects (AC-E4) — nothing
  // changes theme while this view is open (there's no route to ThemeMenu from
  // here), so reading it once per render (no state) is safe.
  const activeTheme = getActiveTheme();
  const declaredEffects = (activeTheme.effects ?? []) as EffectId[];
  const [effectToggles, setEffectToggles] = useState(() => loadEffectToggles());
  const toggleEffect = useCallback((id: EffectId) => {
    setEffectToggles((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? false) };
      saveEffectToggles(next);
      applyThemeVarsAndEffects(getActiveThemeName(), {
        effectToggles: next,
        platformDefaults: MOBILE_EFFECT_DEFAULTS,
      });
      return next;
    });
  }, []);

  // crt-rollbar line params (rollbar-params) — same load/clamp/save shape as
  // font/effects above.
  const [rollbar, setRollbar] = useState(() => clampRollbarParams(loadRollbar()));
  const changeRollbar = useCallback((partial: Partial<RollbarParams>) => {
    setRollbar((prev) => {
      const next = clampRollbarParams({ ...prev, ...partial });
      saveRollbar(next);
      applyRollbarParams(next);
      return next;
    });
  }, []);

  // CRT-interference params (crt-interference) — same load/clamp/save shape.
  const [interference, setInterference] = useState(() => clampInterferenceParams(loadEffectParams()));
  const changeEffectParams = useCallback(
    (effectId: keyof InterferenceParams, partial: Record<string, number | boolean>) => {
      setInterference((prev) => {
        const next = clampInterferenceParams({ ...prev, [effectId]: { ...prev[effectId], ...partial } });
        saveEffectParams(next);
        applyInterferenceParams(next);
        return next;
      });
    },
    [],
  );

  return (
    <div className="mobile-settings-view" data-testid="mobile-settings-view">
      <header className="mobile-settings-head">
        <button
          type="button"
          className="btn"
          onClick={onClose}
          aria-label="Close settings"
          data-testid="mobile-settings-close"
        >
          ✕
        </button>
        <h2 className="mobile-settings-title">Settings</h2>
      </header>

      <div className="mobile-settings-body">
        <section className="status-section">
          <h2 className="status-section-title">UI Scale</h2>
          <div className="settings-scale-stepper">
            <button
              type="button"
              className="btn"
              onClick={dec}
              aria-label="Decrease UI scale"
              data-testid="settings-scale-dec"
            >
              −
            </button>
            <span className="settings-scale-value" data-testid="settings-scale-value">
              {uiScale}%
            </span>
            <button
              type="button"
              className="btn"
              onClick={inc}
              aria-label="Increase UI scale"
              data-testid="settings-scale-inc"
            >
              +
            </button>
            <button
              type="button"
              className="btn"
              onClick={reset}
              aria-label="Reset UI scale"
              data-testid="settings-scale-reset"
            >
              Reset
            </button>
          </div>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">Font</h2>
          <div className="status-metric" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {FONT_CATALOG.map((font) => (
              <button
                key={font.id}
                type="button"
                className="btn"
                aria-pressed={fontId === font.id}
                onClick={() => selectFont(font.id)}
                data-testid={`settings-font-${font.id}`}
              >
                {fontId === font.id ? '✓ ' : ''}
                {font.label}
              </button>
            ))}
          </div>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">Effects</h2>
          {declaredEffects.length === 0 ? (
            <div className="status-metric" data-testid="settings-effects-empty">
              No effects for this theme
            </div>
          ) : (
            <div className="status-metric" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {declaredEffects.map((id) => {
                const on = effectToggles[id] ?? false;
                return (
                  <button
                    key={id}
                    type="button"
                    className="btn"
                    aria-pressed={on}
                    onClick={() => toggleEffect(id)}
                    data-testid={`settings-effect-${id}`}
                  >
                    {on ? '✓ ' : ''}
                    {EFFECT_CATALOG[id].label}
                  </button>
                );
              })}
            </div>
          )}
          {declaredEffects.includes('crt-rollbar') && (
            <div className="settings-rollbar-params" data-testid="settings-rollbar-params">
              <label className="settings-rollbar-row">
                <span>Line thickness: {rollbar.thickness}px</span>
                <input
                  type="range"
                  min={1}
                  max={200}
                  step={1}
                  value={rollbar.thickness}
                  onChange={(e) => changeRollbar({ thickness: Number(e.target.value) })}
                  data-testid="settings-rollbar-thickness"
                />
              </label>
              <label className="settings-rollbar-row">
                <span>Line spacing: {rollbar.gap}%</span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={rollbar.gap}
                  onChange={(e) => changeRollbar({ gap: Number(e.target.value) })}
                  data-testid="settings-rollbar-gap"
                />
              </label>
              <label className="settings-rollbar-row">
                <span>Line color</span>
                <input
                  type="color"
                  value={rollbar.color}
                  onChange={(e) => changeRollbar({ color: e.target.value })}
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
                  onChange={(e) => changeRollbar({ speed: Number(e.target.value) })}
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
                  onChange={(e) => changeRollbar({ opacity: Number(e.target.value) })}
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
                  onChange={(e) => changeRollbar({ softness: Number(e.target.value) })}
                  data-testid="settings-rollbar-softness"
                />
              </label>
            </div>
          )}
          {declaredEffects.filter(isInterferenceEffectId).map((id) => (
            <EffectParamSliders key={id} effectId={id} params={interference} onChange={changeEffectParams} />
          ))}
        </section>

        <section className="status-section">
          <h2 className="status-section-title">Connection</h2>
          <div className="status-metric" data-testid="settings-connection-url">
            {connectionUrl || '—'}
          </div>
          <div className="status-metric" data-testid="settings-connection-status">
            Connected
          </div>
          <button
            type="button"
            className="btn"
            onClick={onDisconnect}
            data-testid="settings-disconnect-btn"
          >
            Disconnect
          </button>
        </section>
      </div>
    </div>
  );
}
