import { useCallback, useState } from 'react';

import { EFFECT_CATALOG, type EffectId } from '../../src/renderer/effects';
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
  loadEffectToggles,
  loadFont,
  saveEffectToggles,
  saveFont,
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
