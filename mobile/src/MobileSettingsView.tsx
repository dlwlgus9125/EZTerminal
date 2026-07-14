import { Check, Minus, Plus, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { OpenClawMode } from '../../src/shared/layout-schema';
import { UiDensitySchema, UiLocalePreferenceSchema } from '../../src/shared/ui-preferences';
import { useAppTranslation } from '../../src/renderer/i18n';
import type { EffectId } from '../../src/renderer/effects';
import {
  applyInterferenceParams,
  applyRollbarParams,
  clampInterferenceParams,
  clampRollbarParams,
  type InterferenceParams,
  type RollbarParams,
} from '../../src/renderer/effect-params';
import {
  EffectParamSliders,
  isInterferenceEffectId,
  type InterferenceEffectId,
} from '../../src/renderer/EffectParamSliders';
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
import { TerminalAccessorySettings } from './TerminalAccessorySettings';
import { useMobileUiPreferences } from './MobileUiPreferencesProvider';

// MobileSettingsView — full-screen settings overlay (v0.2.0 M4). Modeled on
// MobileStatsView.tsx's structure (standalone view, own header, `.btn`/
// `--term-*` styling). Reached only from the authed MobileWorkspace, so
// "Connection" always reflects a live session — there is no disconnected
// state to render here.
const EFFECT_LABEL_KEY = {
  scanlines: 'mobile.settingsView.effectScanlines',
  'phosphor-glow': 'mobile.settingsView.effectPhosphorGlow',
  flicker: 'mobile.settingsView.effectFlicker',
  'crt-curvature': 'mobile.settingsView.effectCrtCurvature',
  'crt-rollbar': 'mobile.settingsView.effectCrtRollbar',
  'scanline-scroll': 'mobile.settingsView.effectScanlineScroll',
  'jitter-burst': 'mobile.settingsView.effectJitterBurst',
  'micro-jitter': 'mobile.settingsView.effectMicroJitter',
  'static-noise': 'mobile.settingsView.effectStaticNoise',
} as const satisfies Record<EffectId, string>;

const OPENCLAW_MODE_LABEL_KEY = {
  auto: 'mobile.settingsView.modeAuto',
  on: 'mobile.settingsView.modeOn',
  off: 'mobile.settingsView.modeOff',
} as const satisfies Record<OpenClawMode, string>;

interface MobileSettingsViewProps {
  readonly connectionUrl?: string;
  readonly onClose: () => void;
  readonly onDisconnect: () => void;
  /** OpenClaw tri-state visibility (openclaw-stabilization M3) — lifted to
   * MobileWorkspace (like `currentTheme`/`handleThemeSelect`, ThemeMenu's own
   * precedent), since the mode also drives the entry button/dot elsewhere in
   * the workspace, not just this settings screen. */
  readonly openclawMode: OpenClawMode;
  readonly onOpenClawModeChange: (mode: OpenClawMode) => void;
}

export function MobileSettingsView({
  connectionUrl = '',
  onClose,
  onDisconnect,
  openclawMode,
  onOpenClawModeChange,
}: MobileSettingsViewProps): JSX.Element {
  const { t } = useAppTranslation();
  const { preferences, setPreferences } = useMobileUiPreferences();
  const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(false);
  const [uiScale, setUiScale] = useState(() => loadUiScale());
  const formatEffectParamLabel = useCallback((effectId: InterferenceEffectId, key: string, value: number): string => {
    const labelKey = {
      'jitter-burst:period': 'mobile.settingsView.burstPeriod',
      'jitter-burst:duration': 'mobile.settingsView.burstLength',
      'jitter-burst:intensity': 'mobile.settingsView.intensity',
      'micro-jitter:speed': 'mobile.settingsView.jitterSpeed',
      'micro-jitter:amplitude': 'mobile.settingsView.amplitude',
      'static-noise:density': 'mobile.settingsView.grainDensity',
      'static-noise:opacity': 'mobile.settingsView.noiseOpacity',
      'static-noise:speed': 'mobile.settingsView.shuffleSpeed',
      'flicker:frequency': 'mobile.settingsView.frequency',
      'flicker:depth': 'mobile.settingsView.depth',
    } as const;
    return t(labelKey[`${effectId}:${key}` as keyof typeof labelKey], { value });
  }, [t]);

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
          aria-label={t('mobile.settingsView.close')}
          data-testid="mobile-settings-close"
        >
          <X aria-hidden="true" size={18} />
        </button>
        <h2 className="mobile-settings-title">{t('settings.title')}</h2>
      </header>

      <div className="mobile-settings-body">
        <section className="status-section">
          <h2 className="status-section-title">{t('settings.language')}</h2>
          <p>{t('settings.languageDescription')}</p>
          <select
            className="mobile-file-path-input"
            value={preferences.locale}
            onChange={(event) => {
              const parsed = UiLocalePreferenceSchema.safeParse(event.target.value);
              if (parsed.success) {
                setPreferenceSaveFailed(!setPreferences({ ...preferences, locale: parsed.data }));
              }
            }}
            data-testid="settings-language"
          >
            <option value="system">{t('settings.systemLanguage')}</option>
            <option value="ko">{t('settings.korean')}</option>
            <option value="en">{t('settings.english')}</option>
          </select>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">{t('settings.density')}</h2>
          <select
            className="mobile-file-path-input"
            value={preferences.density}
            onChange={(event) => {
              const parsed = UiDensitySchema.safeParse(event.target.value);
              if (parsed.success) {
                setPreferenceSaveFailed(!setPreferences({ ...preferences, density: parsed.data }));
              }
            }}
            data-testid="settings-density"
          >
            <option value="adaptive">{t('settings.adaptive')}</option>
            <option value="compact">{t('settings.compact')}</option>
            <option value="comfortable">{t('settings.comfortable')}</option>
          </select>
        </section>

        {preferenceSaveFailed && (
          <div className="settings-theme-import-error" role="alert">
            {t('settings.preferenceSaveFailed')}
          </div>
        )}

        <TerminalAccessorySettings />

        <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.uiScale')}</h2>
          <div className="settings-scale-stepper">
            <button
              type="button"
              className="btn"
              onClick={dec}
              aria-label={t('mobile.settingsView.decreaseScale')}
              data-testid="settings-scale-dec"
            >
              <Minus aria-hidden="true" size={18} />
            </button>
            <span className="settings-scale-value" data-testid="settings-scale-value">
              {uiScale}%
            </span>
            <button
              type="button"
              className="btn"
              onClick={inc}
              aria-label={t('mobile.settingsView.increaseScale')}
              data-testid="settings-scale-inc"
            >
              <Plus aria-hidden="true" size={18} />
            </button>
            <button
              type="button"
              className="btn"
              onClick={reset}
              aria-label={t('mobile.settingsView.resetScale')}
              data-testid="settings-scale-reset"
            >
              {t('common.reset')}
            </button>
          </div>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.font')}</h2>
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
                {fontId === font.id && <Check aria-hidden="true" size={16} />}
                {font.label}
              </button>
            ))}
          </div>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.effects')}</h2>
          {declaredEffects.length === 0 ? (
            <div className="status-metric" data-testid="settings-effects-empty">
              {t('mobile.settingsView.noEffects')}
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
                    {on && <Check aria-hidden="true" size={16} />}
                    {t(EFFECT_LABEL_KEY[id])}
                  </button>
                );
              })}
            </div>
          )}
          {declaredEffects.includes('crt-rollbar') && (
            <div className="settings-rollbar-params" data-testid="settings-rollbar-params">
              <label className="settings-rollbar-row">
                <span>{t('mobile.settingsView.lineThickness', { value: rollbar.thickness })}</span>
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
                <span>{t('mobile.settingsView.lineSpacing', { value: rollbar.gap })}</span>
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
                <span>{t('mobile.settingsView.lineColor')}</span>
                <input
                  type="color"
                  value={rollbar.color}
                  onChange={(e) => changeRollbar({ color: e.target.value })}
                  data-testid="settings-rollbar-color"
                />
              </label>
              <label className="settings-rollbar-row">
                <span>{t('mobile.settingsView.rollSpeed', { value: rollbar.speed })}</span>
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
                <span>{t('mobile.settingsView.barOpacity', { value: rollbar.opacity })}</span>
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
                <span>{t('mobile.settingsView.lineGradient', { value: rollbar.softness })}</span>
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
            <EffectParamSliders
              key={id}
              effectId={id}
              params={interference}
              onChange={changeEffectParams}
              formatLabel={formatEffectParamLabel}
              flashLabel={t('mobile.settingsView.noiseFlash')}
            />
          ))}
        </section>

        <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.openClaw')}</h2>
          <div className="status-metric" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(['auto', 'on', 'off'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="btn"
                aria-pressed={openclawMode === mode}
                onClick={() => onOpenClawModeChange(mode)}
                data-testid={`settings-openclaw-mode-${mode}`}
              >
                {openclawMode === mode && <Check aria-hidden="true" size={16} />}
                {t(OPENCLAW_MODE_LABEL_KEY[mode])}
              </button>
            ))}
          </div>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.connection')}</h2>
          <div className="status-metric" data-testid="settings-connection-url">
            {connectionUrl || '—'}
          </div>
          <div className="status-metric" data-testid="settings-connection-status">
            {t('state.connected')}
          </div>
          <button
            type="button"
            className="btn"
            onClick={onDisconnect}
            data-testid="settings-disconnect-btn"
          >
            {t('mobile.settingsView.disconnect')}
          </button>
        </section>
      </div>
    </div>
  );
}
