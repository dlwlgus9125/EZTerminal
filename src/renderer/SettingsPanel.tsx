import { Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { OpenClawMode, TerminalRendererPreference, ThemeName } from '../shared/layout-schema';
import { AgentIntegrationSettings } from './AgentIntegrationSettings';
import { EFFECT_CATALOG, type EffectId } from './effects';
import type { InterferenceParams, RollbarParams } from './effect-params';
import { EffectParamSliders, isInterferenceEffectId } from './EffectParamSliders';
import { FONT_CATALOG } from './fonts';
import { useAppTranslation } from './i18n';
import { SCROLLBACK_MAX, SCROLLBACK_MIN } from './scrollback';
import type { ThemeDefinition } from './themes';
import { Button, Field, IconButton, Input, Select, Switch, Tooltip } from './ui';
import { UI_SCALE_DEFAULT } from './ui-scale';
import { useUiPreferences } from './ui-preferences';

export type SettingsCategory = 'general' | 'appearance' | 'terminal' | 'agents' | 'integrations' | 'about';

const SETTINGS_CATEGORIES = [
  { id: 'general', labelKey: 'settings.general' },
  { id: 'appearance', labelKey: 'settings.appearance' },
  { id: 'terminal', labelKey: 'settings.terminalSafety' },
  { id: 'agents', labelKey: 'settings.agents' },
  { id: 'integrations', labelKey: 'settings.integrations' },
  { id: 'about', labelKey: 'settings.diagnostics' },
] as const satisfies readonly { readonly id: SettingsCategory; readonly labelKey: string }[];

const EFFECT_LABEL_KEYS = {
  scanlines: 'settings.effectScanlines',
  'phosphor-glow': 'settings.effectPhosphorGlow',
  flicker: 'settings.effectFlicker',
  'crt-curvature': 'settings.effectCrtCurvature',
  'crt-rollbar': 'settings.effectCrtRollbar',
  'scanline-scroll': 'settings.effectScanlineScroll',
  'jitter-burst': 'settings.effectJitterBurst',
  'micro-jitter': 'settings.effectMicroJitter',
  'static-noise': 'settings.effectStaticNoise',
} as const satisfies Record<EffectId, string>;

const EFFECT_PARAM_LABEL_KEYS = {
  'jitter-burst.period': 'settings.burstPeriod',
  'jitter-burst.duration': 'settings.burstLength',
  'jitter-burst.intensity': 'settings.intensity',
  'micro-jitter.speed': 'settings.jitterSpeed',
  'micro-jitter.amplitude': 'settings.amplitude',
  'static-noise.density': 'settings.grainDensity',
  'static-noise.opacity': 'settings.noiseOpacity',
  'static-noise.speed': 'settings.shuffleSpeed',
  'flicker.frequency': 'settings.frequency',
  'flicker.depth': 'settings.depth',
} as const;

/**
 * Settings drawer (v0.2.0 M2; theme/font/effects added in theme-effects-font
 * M3): UI scale stepper, remote bridge toggle, theme picker + import, font
 * picker, per-effect toggles. Right-edge overlay reusing StatusPanel/
 * ConnectionInfoPanel's `status-drawer`/`status-section` chrome — same slot
 * family, different content, so it shares App.tsx's stats/pairing mutual-
 * exclusion group.
 */
interface SettingsPanelProps {
  readonly requestedCategory?: SettingsCategory;
  readonly categoryRequestId?: number;
  readonly uiScale: number;
  readonly onChangeUiScale: (percent: number) => void;
  readonly scrollback: number;
  readonly onChangeScrollback: (lines: number) => void;
  readonly terminalRendererPreference: TerminalRendererPreference;
  readonly onChangeTerminalRendererPreference: (preference: TerminalRendererPreference) => void;
  readonly confirmRiskyPaneClose: boolean;
  readonly onChangeConfirmRiskyPaneClose: (enabled: boolean) => void;
  readonly allowOsc52Clipboard: boolean;
  readonly onChangeAllowOsc52Clipboard: (enabled: boolean) => void;
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
  /** CRT-interference params (crt-interference) — sliders render beneath each
   * of the four parameterized effects' toggles when the theme declares them. */
  readonly interference: InterferenceParams;
  readonly onChangeEffectParams: (
    effectId: keyof InterferenceParams,
    partial: Record<string, number | boolean>,
  ) => void;
}

export function SettingsPanel({
  requestedCategory = 'general',
  categoryRequestId = 0,
  uiScale,
  onChangeUiScale,
  scrollback,
  onChangeScrollback,
  terminalRendererPreference,
  onChangeTerminalRendererPreference,
  confirmRiskyPaneClose,
  onChangeConfirmRiskyPaneClose,
  allowOsc52Clipboard,
  onChangeAllowOsc52Clipboard,
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
  interference,
  onChangeEffectParams,
}: SettingsPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const { preferences: uiPreferences, updatePreferences } = useUiPreferences();
  const [remoteEnabled, setRemoteEnabled] = useState<boolean | null>(null);
  const [remotePort, setRemotePort] = useState<number | null>(null);
  const [remoteSecurityError, setRemoteSecurityError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [openclawMode, setOpenclawModeState] = useState<OpenClawMode | null>(null);
  const [category, setCategory] = useState<SettingsCategory>(requestedCategory);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  useEffect(() => {
    setCategory(requestedCategory);
  }, [categoryRequestId, requestedCategory]);

  const updateUiPreference = (partial: Parameters<typeof updatePreferences>[0]): void => {
    setPreferenceError(null);
    void updatePreferences(partial).catch(() => setPreferenceError(t('settings.preferenceSaveFailed')));
  };

  useEffect(() => {
    let alive = true;
    void window.ezterminal.getRemoteEnabled().then((v) => {
      if (alive) setRemoteEnabled(v);
    });
    void window.ezterminal.getRemoteConnectionInfo().then((info) => {
      if (alive) setRemotePort(info.port);
    });
    void window.ezterminal.getRemoteSecurityStatus().then((status) => {
      if (alive) {
        setRemoteSecurityError(status.error);
        if (status.state === 'error') setRemoteEnabled(false);
      }
    });
    void window.ezterminalDesktop?.getOpenClawMode().then((mode) => {
      if (alive) setOpenclawModeState(mode);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleRemoteToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.checked;
    setRemoteSecurityError(null);
    void window.ezterminal.setRemoteEnabled(next).then(
      (running) => setRemoteEnabled(running),
      () => {
        setRemoteEnabled(false);
        setRemoteSecurityError(t('settings.remoteStartFailed'));
      },
    );
  }, [t]);

  // OpenClaw visibility mode (openclaw-stabilization M2): the visibility-
  // changed push (main.ts's `openclaw:visibility-changed`) updates App's
  // gating on every window independently — this just fires the set and
  // reflects the new mode locally.
  const handleOpenclawModeChange = useCallback((mode: OpenClawMode): void => {
    setOpenclawModeState(mode);
    void window.ezterminalDesktop?.setOpenClawMode(mode);
  }, []);

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file after a failed import
      if (!file) return;
      void file.text().then(async (text) => {
        const result = await onImportTheme(text);
        setImportError(result.ok ? null : (result.error ?? t('settings.themeImportFailed')));
      });
    },
    [onImportTheme, t],
  );

  const remoteLoading = remoteEnabled === null || remotePort === null;
  const systemDefaultFontId = FONT_CATALOG.find((f) => f.systemDefault)?.id ?? FONT_CATALOG[0].id;

  // Scrollback input (WT-parity M5 fix): a local text draft so typing a
  // multi-digit value doesn't clamp+persist on every keystroke — the
  // committed value only propagates (via onChangeScrollback) on blur/Enter.
  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollback));
  useEffect(() => {
    setScrollbackDraft(String(scrollback));
  }, [scrollback]);
  const commitScrollback = (): void => {
    const n = Number(scrollbackDraft);
    if (Number.isFinite(n) && scrollbackDraft.trim() !== '') onChangeScrollback(n);
    else setScrollbackDraft(String(scrollback));
  };

  const formatEffectParamLabel = useCallback((effectId: keyof InterferenceParams, key: string, value: number): string => {
    const compositeKey = `${effectId}.${key}` as keyof typeof EFFECT_PARAM_LABEL_KEYS;
    const labelKey = EFFECT_PARAM_LABEL_KEYS[compositeKey];
    return labelKey ? t(labelKey, { value }) : String(value);
  }, [t]);

  return (
    <div className="status-drawer settings-workbench" data-testid="settings-panel">
      <nav className="settings-category-nav" aria-label={t('settings.title')}>
        {SETTINGS_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="settings-category-button"
            aria-current={category === item.id ? 'page' : undefined}
            onClick={() => setCategory(item.id)}
            data-testid={`settings-category-${item.id}`}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>
      <div className="settings-category-content" data-active-category={category}>
      <section className="status-section" hidden={category !== 'general'}>
        <Field
          className="settings-field-row"
          label={t('settings.language')}
          description={t('settings.languageDescription')}
        >
          <Select
            value={uiPreferences.locale}
            onChange={(event) => updateUiPreference({ locale: event.target.value as typeof uiPreferences.locale })}
            data-testid="settings-locale"
          >
            <option value="system">{t('settings.systemLanguage')}</option>
            <option value="ko">{t('settings.korean')}</option>
            <option value="en">{t('settings.english')}</option>
          </Select>
        </Field>
        <Field className="settings-field-row" label={t('settings.density')}>
          <Select
            value={uiPreferences.density}
            onChange={(event) => updateUiPreference({ density: event.target.value as typeof uiPreferences.density })}
            data-testid="settings-density"
          >
            <option value="adaptive">{t('settings.adaptive')}</option>
            <option value="compact">{t('settings.compact')}</option>
            <option value="comfortable">{t('settings.comfortable')}</option>
          </Select>
        </Field>
        {preferenceError && <div className="settings-theme-import-error" role="alert">{preferenceError}</div>}
      </section>
      <section className="status-section" hidden={category !== 'general'}>
        <h2 className="status-section-title">{t('settings.uiScale')}</h2>
        <div className="settings-scale-stepper">
          <Tooltip content={t('settings.decreaseScale')} side="bottom">
            <IconButton
              icon={Minus}
              onClick={() => onChangeUiScale(uiScale - 10)}
              aria-label={t('settings.decreaseScale')}
              data-testid="settings-scale-dec"
            />
          </Tooltip>
          <span className="settings-scale-value" data-testid="settings-scale-value">
            {uiScale}%
          </span>
          <Tooltip content={t('settings.increaseScale')} side="bottom">
            <IconButton
              icon={Plus}
              onClick={() => onChangeUiScale(uiScale + 10)}
              aria-label={t('settings.increaseScale')}
              data-testid="settings-scale-inc"
            />
          </Tooltip>
          <Button
            onClick={() => onChangeUiScale(UI_SCALE_DEFAULT)}
            aria-label={t('common.reset')}
            data-testid="settings-scale-reset"
          >
            {t('common.reset')}
          </Button>
        </div>
      </section>

      <section className="status-section" hidden={category !== 'terminal'}>
        <Field label={t('settings.scrollbackLines')}>
          <Input
            type="number"
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            value={scrollbackDraft}
            onChange={(e) => setScrollbackDraft(e.target.value)}
            onBlur={commitScrollback}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitScrollback();
                (e.target as HTMLInputElement).blur();
              }
            }}
            data-testid="settings-scrollback-input"
          />
        </Field>
      </section>

      <section className="status-section" hidden={category !== 'terminal'}>
        <Field label={t('settings.terminalRenderer')}>
          <Select
            value={terminalRendererPreference}
            onChange={(event) => onChangeTerminalRendererPreference(event.target.value as TerminalRendererPreference)}
            data-testid="settings-terminal-renderer"
          >
            <option value="auto">{t('settings.rendererAuto')}</option>
            <option value="dom">{t('settings.rendererCompatibility')}</option>
          </Select>
        </Field>
      </section>

      <section className="status-section" hidden={category !== 'appearance'}>
        <Field label={t('settings.theme')}>
          <Select
            value={theme}
            onChange={(e) => onSelectTheme(e.target.value)}
            data-testid="settings-theme-select"
          >
            {availableThemes.map((themeDefinition) => (
              <option key={themeDefinition.id} value={themeDefinition.id}>
                {themeDefinition.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="settings-theme-import">
          <input
            type="file"
            accept="application/json,.json"
            ref={importInputRef}
            style={{ display: 'none' }}
            onChange={handleImportFile}
            data-testid="settings-theme-import-file"
          />
          <Button
            onClick={() => importInputRef.current?.click()}
            data-testid="settings-theme-import-btn"
          >
            {t('settings.importTheme')}
          </Button>
          {importError && (
            <div className="settings-theme-import-error" data-testid="settings-theme-import-error">
              {importError}
            </div>
          )}
        </div>
      </section>

      <section className="status-section" hidden={category !== 'appearance'}>
        <Field label={t('settings.terminalFont')}>
          <Select
            value={fontId ?? systemDefaultFontId}
            onChange={(e) => onSelectFont(e.target.value)}
            data-testid="settings-font-select"
          >
            {FONT_CATALOG.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <section className="status-section" hidden={category !== 'appearance'}>
        <h2 className="status-section-title">{t('settings.crtEffects')}</h2>
        {activeThemeEffects.length === 0 ? (
          <div className="status-loading" data-testid="settings-effects-empty">
            {t('settings.noEffects')}
          </div>
        ) : (
          activeThemeEffects.map((id) => {
            const entry = EFFECT_CATALOG[id as EffectId];
            if (!entry) return null;
            const on = effectToggles[id] ?? entry.defaultOn;
            return (
              <div key={id}>
                <Switch
                  checked={on}
                  onChange={(e) => onToggleEffect(id, e.target.checked)}
                  label={t(EFFECT_LABEL_KEYS[entry.id])}
                  data-testid={`settings-effect-${id}`}
                />
                {id === 'crt-rollbar' && (
                  <div className="settings-rollbar-params" data-testid="settings-rollbar-params">
                    <label className="settings-rollbar-row">
                      <span>{t('settings.lineThickness', { value: rollbar.thickness })}</span>
                      <input
                        type="range"
                        min={1}
                        max={200}
                        step={1}
                        value={rollbar.thickness}
                        onChange={(e) => onChangeRollbar({ thickness: Number(e.target.value) })}
                        data-testid="settings-rollbar-thickness"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>{t('settings.lineSpacing', { value: rollbar.gap })}</span>
                      <input
                        type="range"
                        min={1}
                        max={100}
                        step={1}
                        value={rollbar.gap}
                        onChange={(e) => onChangeRollbar({ gap: Number(e.target.value) })}
                        data-testid="settings-rollbar-gap"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>{t('settings.lineColor')}</span>
                      <input
                        type="color"
                        value={rollbar.color}
                        onChange={(e) => onChangeRollbar({ color: e.target.value })}
                        data-testid="settings-rollbar-color"
                      />
                    </label>
                    <label className="settings-rollbar-row">
                      <span>{t('settings.rollSpeed', { value: rollbar.speed })}</span>
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
                      <span>{t('settings.barOpacity', { value: rollbar.opacity })}</span>
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
                      <span>{t('settings.lineGradient', { value: rollbar.softness })}</span>
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
                {isInterferenceEffectId(id) && (
                  <EffectParamSliders
                    effectId={id}
                    params={interference}
                    onChange={onChangeEffectParams}
                    formatLabel={formatEffectParamLabel}
                    flashLabel={t('settings.noiseFlash')}
                  />
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="status-section" hidden={category !== 'agents'}>
        <h2 className="status-section-title">{t('settings.agentIntegrations')}</h2>
        <AgentIntegrationSettings />
      </section>

      <section className="status-section" hidden={category !== 'integrations'}>
        <h2 className="status-section-title">{t('settings.remoteAccess')}</h2>
        {remoteLoading ? (
          <div className="status-loading">{t('common.loading')}</div>
        ) : (
          <>
            <Switch
              checked={remoteEnabled}
              onChange={handleRemoteToggle}
              label={t('settings.enableRemoteAccess')}
              data-testid="settings-remote-toggle"
            />
            <div className="status-metric">
              {t('settings.bridgeStatus', {
                port: remotePort,
                state: remoteEnabled ? t('settings.running') : t('settings.off'),
              })}
            </div>
            {remoteSecurityError && (
              <div className="status-loading" role="alert" data-testid="settings-remote-security-error">
                {remoteSecurityError}
              </div>
            )}
          </>
        )}
      </section>

      <section className="status-section" hidden={category !== 'integrations'}>
        <h2 className="status-section-title">{t('rail.openClaw')}</h2>
        {openclawMode === null ? (
          <div className="status-loading">{t('common.loading')}</div>
        ) : (
          <>
            <label className="settings-radio-row">
              <input
                type="radio"
                name="openclaw-mode"
                checked={openclawMode === 'auto'}
                onChange={() => handleOpenclawModeChange('auto')}
                data-testid="settings-openclaw-mode-auto"
              />
              <span>{t('settings.openClawAuto')}</span>
            </label>
            <label className="settings-radio-row">
              <input
                type="radio"
                name="openclaw-mode"
                checked={openclawMode === 'on'}
                onChange={() => handleOpenclawModeChange('on')}
                data-testid="settings-openclaw-mode-on"
              />
              <span>{t('settings.openClawAlwaysOn')}</span>
            </label>
            <label className="settings-radio-row">
              <input
                type="radio"
                name="openclaw-mode"
                checked={openclawMode === 'off'}
                onChange={() => handleOpenclawModeChange('off')}
                data-testid="settings-openclaw-mode-off"
              />
              <span>{t('settings.openClawAlwaysOff')}</span>
            </label>
          </>
        )}
      </section>
      <section className={'status-section'} hidden={category !== 'terminal'}>
        <h2 className={'status-section-title'}>{t('settings.sessionSafety')}</h2>
        <Switch
          checked={confirmRiskyPaneClose}
          onChange={(event) => onChangeConfirmRiskyPaneClose(event.target.checked)}
          label={t('settings.confirmRiskyPaneClose')}
          data-testid="settings-confirm-risky-pane-close"
        />
        <Switch
          checked={allowOsc52Clipboard}
          onChange={(event) => onChangeAllowOsc52Clipboard(event.target.checked)}
          label={t('settings.allowOsc52Clipboard')}
          data-testid="settings-allow-osc52-clipboard"
        />
      </section>
      <section className="status-section" hidden={category !== 'about'}>
        <h2 className="status-section-title">{t('settings.about')}</h2>
        <div className="settings-diagnostic-grid">
          <span>{t('settings.electron')}</span>
          <code>{window.ezterminal?.versions?.electron ?? t('common.unavailable')}</code>
          <span>{t('settings.chromium')}</span>
          <code>{window.ezterminal?.versions?.chrome ?? t('common.unavailable')}</code>
          <span>{t('settings.node')}</span>
          <code>{window.ezterminal?.versions?.node ?? t('common.unavailable')}</code>
          <span>{t('settings.terminalRenderer')}</span>
          <code>{terminalRendererPreference}</code>
        </div>
      </section>
      </div>
    </div>
  );
}
