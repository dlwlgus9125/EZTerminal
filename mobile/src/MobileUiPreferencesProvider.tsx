import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { AppI18nProvider } from '../../src/renderer/i18n';
import {
  DEFAULT_UI_PREFERENCES,
  navigatorLanguages,
  type UiPreferences,
} from '../../src/shared/ui-preferences';
import { loadMobileUiPreferences, saveMobileUiPreferences } from './ui-preferences';

export interface MobileUiPreferencesValue {
  readonly preferences: UiPreferences;
  /** Applies immediately and reports whether device-local persistence succeeded. */
  readonly setPreferences: (preferences: UiPreferences) => boolean;
}

const defaultValue: MobileUiPreferencesValue = {
  preferences: { ...DEFAULT_UI_PREFERENCES },
  setPreferences: () => false,
};

const MobileUiPreferencesContext = createContext<MobileUiPreferencesValue>(defaultValue);

export function MobileUiPreferencesProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [preferences, setPreferenceState] = useState(() => loadMobileUiPreferences());
  const [languages, setLanguages] = useState<readonly string[]>(() => navigatorLanguages());

  const setPreferences = useCallback((next: UiPreferences): boolean => {
    const persisted = saveMobileUiPreferences(next);
    setPreferenceState(next);
    return persisted;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = preferences.density;
    return () => {
      if (document.documentElement.dataset.density === preferences.density) {
        delete document.documentElement.dataset.density;
      }
    };
  }, [preferences.density]);

  useEffect(() => {
    const onLanguageChange = (): void => setLanguages(navigatorLanguages());
    window.addEventListener('languagechange', onLanguageChange);
    return () => window.removeEventListener('languagechange', onLanguageChange);
  }, []);

  const value = useMemo(() => ({ preferences, setPreferences }), [preferences, setPreferences]);

  return (
    <MobileUiPreferencesContext.Provider value={value}>
      <AppI18nProvider locale={preferences.locale} languages={languages}>{children}</AppI18nProvider>
    </MobileUiPreferencesContext.Provider>
  );
}

export function useMobileUiPreferences(): MobileUiPreferencesValue {
  return useContext(MobileUiPreferencesContext);
}
