import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type ThemeName } from '../shared/layout-schema';

import type { ThemeMod } from '../shared/theme-schema';

import { EFFECT_CATALOG, type EffectId } from './effects';
import {
  DEFAULT_INTERFERENCE_PARAMS,
  DEFAULT_ROLLBAR_PARAMS,
  applyInterferenceParams,
  applyRollbarParams,
  clampInterferenceParams,
  clampRollbarParams,
  type InterferenceParams,
  type RollbarParams,
} from './effect-params';

import { applyThemeVarsAndEffects, setUserFontId, themeModToDefinition } from './theme-runtime';
import { THEME_ORDER, THEMES, listThemes, registerTheme, type ThemeDefinition } from './themes';
import { applyScrollback, clampScrollback, SCROLLBACK_DEFAULT } from './scrollback';
import { applyUiScale, clampUiScale, UI_SCALE_DEFAULT } from './ui-scale';

import type { TFunction } from 'i18next';

const DESKTOP_EFFECT_DEFAULTS = Object.fromEntries(
  Object.values(EFFECT_CATALOG).map((entry) => [entry.id, entry.defaultOn]),
) as Record<EffectId, boolean>;

interface UseDesktopAppearanceOptions {
  readonly t: TFunction<"translation", undefined>;
}

export function useDesktopAppearance({ t }: UseDesktopAppearanceOptions) {
  const [theme, setThemeState] = useState<ThemeName>('matrix');
  const [availableThemes, setAvailableThemes] = useState<ThemeDefinition[]>(() => listThemes());
  // Guards the initial getTheme() fetch against a click that lands before its IPC
  // round-trip resolves — without this, a fast click could be silently overwritten
  // by the (now-stale) persisted value moments later.
  const userChangedThemeRef = useRef(false);

  // effectToggles needs to be read from INSIDE `applyTheme` (a stable, dep-free
  // callback — see below) without forcing it to change identity on every
  // toggle, so a ref mirrors the state (same shape as userChangedThemeRef).
  const [effectToggles, setEffectTogglesState] = useState<Record<string, boolean>>({});
  const effectTogglesRef = useRef<Record<string, boolean>>({});
  const setEffectToggles = useCallback((next: Record<string, boolean>): void => {
    effectTogglesRef.current = next;
    setEffectTogglesState(next);
  }, []);

  const [fontId, setFontId] = useState<string | undefined>(undefined);

  // crt-rollbar line params (rollbar-params) — same ref-mirrors-state shape
  // as effectToggles above, needed so onChangeRollbar (a stable, dep-free
  // callback) can read the latest value without becoming a moving target.
  const [rollbar, setRollbarState] = useState<RollbarParams>(DEFAULT_ROLLBAR_PARAMS);
  const rollbarRef = useRef<RollbarParams>(DEFAULT_ROLLBAR_PARAMS);
  const setRollbar = useCallback((next: RollbarParams): void => {
    rollbarRef.current = next;
    setRollbarState(next);
  }, []);

  // CRT-interference params (crt-interference) — same ref-mirrors-state shape
  // as rollbar above, one aggregate for the four parameterized effects.
  const [interference, setInterferenceState] = useState<InterferenceParams>(DEFAULT_INTERFERENCE_PARAMS);
  const interferenceRef = useRef<InterferenceParams>(DEFAULT_INTERFERENCE_PARAMS);
  const setInterference = useCallback((next: InterferenceParams): void => {
    interferenceRef.current = next;
    setInterferenceState(next);
  }, []);

  const applyTheme = useCallback((name: ThemeName): void => {
    document.documentElement.dataset.theme = name;
    applyThemeVarsAndEffects(name, {
      effectToggles: effectTogglesRef.current,
      platformDefaults: DESKTOP_EFFECT_DEFAULTS,
    });
    window.dispatchEvent(new Event('ez:theme'));
    setThemeState(name);
  }, []);

  const registerMods = useCallback((mods: ThemeMod[]): void => {
    for (const mod of mods) registerTheme(themeModToDefinition(mod));
    setAvailableThemes(listThemes());
  }, []);

  const refreshAvailableThemes = useCallback(async (): Promise<void> => {
    try {
      const mods = await window.ezterminalDesktop?.getAvailableThemes();
      if (mods) registerMods(mods);
    } catch {
      // Desktop bridge unavailable — built-ins still work via THEME_ORDER.
    }
  }, [registerMods]);

  const onImportTheme = useCallback(
    async (json: string): Promise<{ ok: boolean; error?: string; }> => {
      const result = await window.ezterminalDesktop?.importTheme(json);
      if (!result) return { ok: false, error: t('settings.themeImportUnavailable') };
      if (result.ok) await refreshAvailableThemes();
      return result;
    },
    [refreshAvailableThemes, t],
  );

  // Boot ordering (FOUC fix): custom theme mods must be registered, and the
  // persisted font/effect toggles loaded into state, BEFORE the first
  // `applyTheme(getTheme())` — otherwise a custom theme's `data-theme` value
  // resolves against an empty registry (getActiveTheme() falls back to
  // 'dark') and effects apply with an empty toggle map for one frame.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshAvailableThemes();
      if (cancelled) return;
      try {
        const [persistedFontId, persistedToggles, persistedRollbar, persistedEffectParams] = await Promise.all([
          window.ezterminalDesktop?.getFont(),
          window.ezterminalDesktop?.getEffectToggles(),
          window.ezterminalDesktop?.getRollbar(),
          window.ezterminalDesktop?.getEffectParams(),
        ]);
        if (cancelled) return;
        if (persistedFontId) {
          setUserFontId(persistedFontId);
          setFontId(persistedFontId);
        }
        if (persistedToggles) setEffectToggles(persistedToggles);
        if (persistedRollbar) {
          const clamped = clampRollbarParams(persistedRollbar);
          applyRollbarParams(clamped);
          setRollbar(clamped);
        }
        if (persistedEffectParams) {
          const clampedFx = clampInterferenceParams(persistedEffectParams);
          applyInterferenceParams(clampedFx);
          setInterference(clampedFx);
        }
      } catch {
        // Desktop bridge unavailable — no user font override, theme defaults for effects.
      }
      const name = await window.ezterminal.getTheme();
      if (!cancelled && !userChangedThemeRef.current) applyTheme(name);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyTheme, refreshAvailableThemes, setEffectToggles, setRollbar, setInterference]);

  const selectTheme = useCallback(
    (name: ThemeName): void => {
      userChangedThemeRef.current = true;
      applyTheme(name);
      void window.ezterminal.setTheme(name);
    },
    [applyTheme],
  );

  const cycleTheme = useCallback((): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    selectTheme(next);
  }, [theme, selectTheme]);

  const activeThemeDef = useMemo<ThemeDefinition>(
    () => availableThemes.find((t) => t.id === theme) ?? THEMES.dark,
    [availableThemes, theme],
  );

  const onSelectFont = useCallback((id: string): void => {
    setUserFontId(id);
    setFontId(id);
    void window.ezterminalDesktop?.setFont(id);
    window.dispatchEvent(new Event('ez:theme')); // re-applies typography (PtyBlock)
  }, []);

  const onToggleEffect = useCallback(
    (id: string, on: boolean): void => {
      const next = { ...effectTogglesRef.current, [id]: on };
      setEffectToggles(next);
      void window.ezterminalDesktop?.setEffectToggles(next).catch(() => undefined);
      applyThemeVarsAndEffects(theme, {
        effectToggles: next,
        platformDefaults: DESKTOP_EFFECT_DEFAULTS,
      });
    },
    [theme, setEffectToggles],
  );

  const onChangeRollbar = useCallback(
    (partial: Partial<RollbarParams>): void => {
      const next = clampRollbarParams({ ...rollbarRef.current, ...partial });
      setRollbar(next);
      applyRollbarParams(next);
      void window.ezterminalDesktop?.setRollbar(next);
    },
    [setRollbar],
  );

  const onChangeEffectParams = useCallback(
    (effectId: keyof InterferenceParams, partial: Record<string, number | boolean>): void => {
      const next = clampInterferenceParams({
        ...interferenceRef.current,
        [effectId]: { ...interferenceRef.current[effectId], ...partial },
      });
      setInterference(next);
      applyInterferenceParams(next);
      void window.ezterminalDesktop?.setEffectParams(next);
    },
    [setInterference],
  );

  // ── UI scale (v0.2.0 D1) ──────────────────────────────────────────────────
  // Mirrors the theme mechanism directly above: applyUiScaleState sets the CSS
  // var + notifies open PtyBlocks (ui-scale.ts's applyUiScale) AND the local
  // label state; the boot fetch guards against a fast user change the same way
  // userChangedThemeRef does.
  const [uiScale, setUiScaleState] = useState<number>(UI_SCALE_DEFAULT);
  const userChangedUiScaleRef = useRef(false);

  const applyUiScaleState = useCallback((percent: number): void => {
    applyUiScale(percent);
    setUiScaleState(clampUiScale(percent));
  }, []);

  useEffect(() => {
    void window.ezterminal.getUiScale().then((percent) => {
      if (!userChangedUiScaleRef.current) applyUiScaleState(percent);
    });
  }, [applyUiScaleState]);

  const changeUiScale = useCallback(
    (percent: number): void => {
      userChangedUiScaleRef.current = true;
      applyUiScaleState(percent);
      void window.ezterminal.setUiScale(clampUiScale(percent));
    },
    [applyUiScaleState],
  );

  // ── Scrollback (WT-parity M5) ──────────────────────────────────────────────
  // Mirrors the UI scale mechanism directly above: applyScrollbackState sets
  // dataset.scrollback + notifies open PtyBlocks (scrollback.ts's
  // applyScrollback) AND the local label state; the boot fetch guards against
  // a fast user change the same way userChangedUiScaleRef does.
  const [scrollback, setScrollbackState] = useState<number>(SCROLLBACK_DEFAULT);
  const userChangedScrollbackRef = useRef(false);

  const applyScrollbackState = useCallback((lines: number): void => {
    applyScrollback(lines);
    setScrollbackState(clampScrollback(lines));
  }, []);

  useEffect(() => {
    void window.ezterminal.getScrollback().then((lines) => {
      if (!userChangedScrollbackRef.current) applyScrollbackState(lines);
    });
  }, [applyScrollbackState]);

  const changeScrollback = useCallback(
    (lines: number): void => {
      userChangedScrollbackRef.current = true;
      applyScrollbackState(lines);
      void window.ezterminal.setScrollback(clampScrollback(lines));
    },
    [applyScrollbackState],
  );

  // ── Presets (A-M4) ────────────────────────────────────────────────────────

  return {
    cycleTheme,
    uiScale,
    changeUiScale,
    scrollback,
    changeScrollback,
    theme,
    selectTheme,
    availableThemes,
    onImportTheme,
    fontId,
    onSelectFont,
    activeThemeDef,
    effectToggles,
    onToggleEffect,
    rollbar,
    onChangeRollbar,
    interference,
    onChangeEffectParams,
  };
}
