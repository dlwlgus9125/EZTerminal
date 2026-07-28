import {
  Check,
  ChevronRight,
  Info,
  Keyboard,
  Minus,
  Palette,
  Plus,
  Server,
  SlidersHorizontal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { OpenClawMode, ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
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
import { getActiveTheme, getActiveThemeName, listThemes } from '../../src/renderer/themes';
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
import { formatEndpointHost, formatUptime } from './mobile-endpoint';
import { MobilePageHeader } from './MobilePageHeader';
import { useMobileNavigationHistory } from './MobileNavigationHistory';
import { OPENCLAW_STATE_LABEL_KEY } from './openclaw-mode';
import { TerminalAccessorySettings } from './TerminalAccessorySettings';
import { useTerminalAccessoryLayout } from './terminal-accessory-layout';
import { useMobileUiPreferences } from './MobileUiPreferencesProvider';
import { MOBILE_BUILD_INFO } from './build-info';

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

type MobileSettingsCategory =
  | 'general'
  | 'appearance'
  | 'terminal-input'
  | 'integrations'
  | 'connection-about';

function SettingsCategoryButton({
  icon: Icon,
  title,
  preview,
  previewSuffix,
  testId,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  /** Handoff §6: every row states its CURRENT value, so the index answers
   * "what is this set to?" without opening the category. */
  readonly preview: string;
  /** The part of the preview that changes with every build — the version and
   * the build SHA — split out so a visual snapshot can mask it instead of
   * pinning one build. Anything derived from the release contract belongs here,
   * or the baseline has to be refreshed on every version bump. */
  readonly previewSuffix?: string;
  readonly testId: string;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="mob-settings-row" onClick={onClick} data-testid={testId}>
      <span className="mob-settings-row__icon" aria-hidden="true"><Icon /></span>
      <span>
        <span className="mob-settings-row__title">{title}</span>
        <span className="mob-settings-row__preview">
          {preview}
          {previewSuffix && (
            <span data-build-stamp>{preview ? ` ${previewSuffix}` : previewSuffix}</span>
          )}
        </span>
      </span>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

interface MobileSettingsViewProps {
  readonly connectionUrl?: string;
  /** Epoch ms of the current authenticated link, for the card's uptime. */
  readonly connectedSince?: number | null;
  readonly openclawState?: OpenClawStatus['state'];
  readonly onClose: () => void;
  readonly onDisconnect: () => void;
  /** OpenClaw tri-state visibility (openclaw-stabilization M3) — lifted to
   * MobileWorkspace (like `currentTheme`/`handleThemeSelect`, ThemeMenu's own
   * precedent), since the mode also drives the entry button/dot elsewhere in
   * the workspace, not just this settings screen. */
  readonly openclawMode: OpenClawMode;
  readonly onOpenClawModeChange: (mode: OpenClawMode) => void;
  readonly currentTheme: ThemeName;
  readonly onOpenTheme: (trigger: HTMLElement) => void;
}

/**
 * Whether an effect is on, resolved the SAME way the apply path resolves it.
 *
 * `applyThemeVarsAndEffects` falls back to `MOBILE_EFFECT_DEFAULTS` when the
 * user has never touched a toggle. Reading `?? false` here instead was harmless
 * only while every platform default was also false; once the CRT Signature
 * profile became the default it made the switch say "off" about an effect that
 * was demonstrably on screen.
 */
export function isEffectOn(toggles: Record<string, boolean>, id: EffectId): boolean {
  return toggles[id] ?? MOBILE_EFFECT_DEFAULTS[id] ?? false;
}

/** A theme id is a storage key, not a name. The preview and the theme button
 * both show what the theme calls itself. */
function themeDisplayName(id: string): string {
  return listThemes().find((theme) => theme.id === id)?.name ?? id;
}

export function MobileSettingsView({
  connectionUrl = '',
  connectedSince = null,
  openclawState,
  onClose,
  onDisconnect,
  openclawMode,
  onOpenClawModeChange,
  currentTheme,
  onOpenTheme,
}: MobileSettingsViewProps): JSX.Element {
  const { t } = useAppTranslation();
  const { preferences, setPreferences } = useMobileUiPreferences();
  const navigation = useMobileNavigationHistory();
  const categoryLayerId = `mobile-settings-category-${useId()}`;
  const [category, setCategory] = useState<MobileSettingsCategory | null>(null);
  const categoryReturnTargetRef = useRef('settings-category-general');
  const restoreCategoryFocusRef = useRef(false);
  const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(false);
  const [uiScale, setUiScale] = useState(() => loadUiScale());

  const openCategory = useCallback((next: MobileSettingsCategory, returnTarget: string) => {
    categoryReturnTargetRef.current = returnTarget;
    setCategory(next);
  }, []);

  const closeCategory = useCallback(() => {
    restoreCategoryFocusRef.current = true;
    setCategory(null);
  }, []);

  useEffect(() => {
    if (category === null) return;
    return navigation.pushLayer({
      id: categoryLayerId,
      kind: 'page',
      onBack: closeCategory,
    });
  }, [category, categoryLayerId, closeCategory, navigation]);

  useEffect(() => {
    if (category !== null || !restoreCategoryFocusRef.current) return;
    restoreCategoryFocusRef.current = false;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-testid="${categoryReturnTargetRef.current}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [category]);
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
  // selecting a theme rerenders this view through the currentTheme prop, so
  // reading the active definition once per render needs no duplicate state.
  const activeTheme = getActiveTheme();
  const declaredEffects = (activeTheme.effects ?? []) as EffectId[];
  const [effectToggles, setEffectToggles] = useState(() => loadEffectToggles());
  const toggleEffect = useCallback((id: EffectId) => {
    setEffectToggles((prev) => {
      // Negate what is actually on, not what is stored. With a platform
      // default of true and nothing stored, `!(undefined ?? false)` is true —
      // so the first tap would write the state it already had and appear to do
      // nothing at all.
      const next = { ...prev, [id]: !isEffectOn(prev, id) };
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

  // ── Index value previews (handoff §6) ──────────────────────────────────
  // Everything here reads the SAME state the category screens below edit, so
  // a preview can never disagree with the setting it summarizes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const accessoryLayout = useTerminalAccessoryLayout();
  const localeLabel = preferences.locale === 'ko'
    ? t('settings.korean')
    : preferences.locale === 'en'
      ? t('settings.english')
      : t('settings.systemLanguage');
  const generalPreview = [
    localeLabel,
    t(`settings.${preferences.density}`),
    `${uiScale}%`,
  ].join(' · ');
  const activeEffectCount = declaredEffects.filter((id) => isEffectOn(effectToggles, id)).length;
  const appearancePreview = [
    themeDisplayName(currentTheme),
    t('mobile.settingsView.effectsOn', { value: activeEffectCount }),
    FONT_CATALOG.find((font) => font.id === fontId)?.label ?? t('mobile.settingsView.fontTheme'),
  ].join(' · ');
  const terminalInputPreview = t('mobile.settingsView.keysShown', {
    value: accessoryLayout.layout.visible.length,
  });
  const integrationsPreview = [
    'OpenClaw',
    openclawState ? t(OPENCLAW_STATE_LABEL_KEY[openclawState]) : t('mobile.moreActions.checking'),
    t(OPENCLAW_MODE_LABEL_KEY[openclawMode]),
  ].join(' · ');

  const categoryTitle = category === 'general'
    ? t('mobile.settingsView.categories.general')
    : category === 'appearance'
      ? t('mobile.settingsView.categories.appearance')
      : category === 'terminal-input'
        ? t('mobile.settingsView.categories.terminalInput')
        : category === 'integrations'
          ? t('mobile.settingsView.categories.integrations')
          : category === 'connection-about'
            ? t('mobile.settingsView.categories.connectionAbout')
            : t('settings.title');

  return (
    <div className="mobile-settings-view" data-testid="mobile-settings-view">
      <MobilePageHeader
        title={categoryTitle}
        backLabel={category === null ? t('mobile.settingsView.close') : t('common.back')}
        backTestId="mobile-settings-close"
        onBack={category === null ? onClose : closeCategory}
      />

      <div className="mobile-settings-body">
        {category === null && (
          <div className="mob-column mobile-settings-index" aria-label={t('mobile.settingsView.categories.indexLabel')}>
            <div className="mob-connection-card" data-testid="settings-connection-card">
              <span className="mob-connection-card__icon" aria-hidden="true"><Server /></span>
              <span className="mob-connection-card__copy">
                <span className="mob-connection-card__host">
                  {connectionUrl ? formatEndpointHost(connectionUrl) : t('state.connected')}
                </span>
                <span className="mob-connection-card__meta" title={connectionUrl}>
                  {[connectionUrl || null, connectedSince ? formatUptime(now - connectedSince) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <button
                type="button"
                className="mob-btn-danger"
                onClick={onDisconnect}
                data-testid="settings-disconnect-btn"
              >
                {t('mobile.settingsView.disconnect')}
              </button>
            </div>

            <SettingsCategoryButton
              icon={SlidersHorizontal}
              title={t('mobile.settingsView.categories.general')}
              preview={generalPreview}
              testId="settings-category-general"
              onClick={() => openCategory('general', 'settings-category-general')}
            />
            <SettingsCategoryButton
              icon={Palette}
              title={t('mobile.settingsView.categories.appearance')}
              preview={appearancePreview}
              testId="settings-category-appearance"
              onClick={() => openCategory('appearance', 'settings-category-appearance')}
            />
            <SettingsCategoryButton
              icon={Keyboard}
              title={t('mobile.settingsView.categories.terminalInput')}
              preview={terminalInputPreview}
              testId="settings-category-terminal-input"
              onClick={() => openCategory('terminal-input', 'settings-category-terminal-input')}
            />
            <SettingsCategoryButton
              icon={Wrench}
              title={t('mobile.settingsView.categories.integrations')}
              preview={integrationsPreview}
              testId="settings-category-integrations"
              onClick={() => openCategory('integrations', 'settings-category-integrations')}
            />
            <SettingsCategoryButton
              icon={Info}
              title={t('mobile.settingsView.categories.connectionAbout')}
              preview=""
              previewSuffix={`v${MOBILE_BUILD_INFO.appVersion} (${MOBILE_BUILD_INFO.buildSha})`}
              testId="settings-category-connection-about"
              onClick={() => openCategory('connection-about', 'settings-category-connection-about')}
            />
            <p className="mob-signal" aria-hidden="true">
              <span>EZT://SETTINGS</span>
              {/* The build stamp differs per build by design, so it is masked
                  out of the visual snapshot rather than pinned to one SHA. */}
              <span data-build-stamp>BUILD {MOBILE_BUILD_INFO.buildSha.toUpperCase()}</span>
            </p>
          </div>
        )}

        {category === 'general' && <section className="status-section">
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
        </section>}

        {category === 'general' && <section className="status-section">
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
        </section>}

        {category === 'general' && preferenceSaveFailed && (
          <div className="settings-theme-import-error" role="alert">
            {t('settings.preferenceSaveFailed')}
          </div>
        )}

        {category === 'terminal-input' && <TerminalAccessorySettings />}

        {category === 'general' && <section className="status-section">
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
        </section>}

        {category === 'appearance' && (
          <section className="status-section">
            <h2 className="status-section-title">{t('mobile.moreActions.theme')}</h2>
            <p>{t('mobile.settingsView.categories.themeDescription')}</p>
            <button
              type="button"
              className="btn"
              onClick={(event) => onOpenTheme(event.currentTarget)}
              data-testid="settings-open-theme"
            >
              {t('mobile.settingsView.categories.chooseTheme')}: {themeDisplayName(currentTheme)}
            </button>
          </section>
        )}

        {category === 'appearance' && <section className="status-section">
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
        </section>}

        {category === 'appearance' && <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.effects')}</h2>
          {declaredEffects.length === 0 ? (
            <div className="status-metric" data-testid="settings-effects-empty">
              {t('mobile.settingsView.noEffects')}
            </div>
          ) : (
            <div className="status-metric" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {declaredEffects.map((id) => {
                const on = isEffectOn(effectToggles, id);
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
        </section>}

        {category === 'integrations' && <section className="status-section">
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
        </section>}

        {category === 'connection-about' && <section className="status-section">
          <h2 className="status-section-title">{t('mobile.settingsView.connection')}</h2>
          <div className="status-metric" data-testid="settings-app-version">
            {t('settings.appVersion')}: {MOBILE_BUILD_INFO.appVersion}
          </div>
          <div className="status-metric" data-testid="settings-protocol-version">
            {t('settings.protocolVersion')}: {MOBILE_BUILD_INFO.protocolVersion}
          </div>
          <div className="status-metric" data-testid="settings-build-sha">
            {t('settings.buildSha')}: {MOBILE_BUILD_INFO.buildSha}
          </div>
          <div className="status-metric" data-testid="settings-connection-url">
            {connectionUrl || '—'}
          </div>
          <div className="status-metric" data-testid="settings-connection-status">
            {t('state.connected')}
          </div>
          {/* Disconnect now lives on the index's connection card (handoff §6),
              which is strictly more reachable than this sub-page. */}
        </section>}
      </div>
    </div>
  );
}
