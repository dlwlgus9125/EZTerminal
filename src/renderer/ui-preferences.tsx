import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  DEFAULT_UI_PREFERENCES,
  UiPreferencesPatchSchema,
  UiPreferencesSchema,
  navigatorLanguages,
  type UiPreferences,
  type UiPreferencesPatch,
} from '../shared/ui-preferences';
import { AppI18nProvider } from './i18n';

interface UiPreferencesContextValue {
  readonly preferences: UiPreferences;
  readonly ready: boolean;
  readonly updatePreferences: (partial: UiPreferencesPatch) => Promise<void>;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function DesktopUiPreferencesProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [preferences, setPreferences] = useState<UiPreferences>(() => ({ ...DEFAULT_UI_PREFERENCES }));
  const [ready, setReady] = useState(false);
  const [languages, setLanguages] = useState<readonly string[]>(() => navigatorLanguages());
  const preferencesRef = useRef(preferences);
  const revisionRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    const desktop = window.ezterminalDesktop;
    if (!desktop?.getUiPreferences) {
      setReady(true);
      return () => { alive = false; };
    }
    void desktop.getUiPreferences().then((stored) => {
      if (!alive) return;
      setReady(true);
      if (revisionRef.current !== 0) return;
      preferencesRef.current = stored;
      setPreferences(stored);
    }, () => {
      if (alive) setReady(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onLanguageChange = (): void => {
      setLanguages(navigatorLanguages());
      if (preferencesRef.current.locale === 'system') {
        void window.ezterminalDesktop?.refreshNativeMenuLocale().catch(() => undefined);
      }
    };
    window.addEventListener('languagechange', onLanguageChange);
    return () => window.removeEventListener('languagechange', onLanguageChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = preferences.density;
  }, [preferences.density]);

  const updatePreferences = useCallback((partial: UiPreferencesPatch): Promise<void> => {
    const patch = UiPreferencesPatchSchema.safeParse(partial);
    if (!patch.success) return Promise.reject(new Error('Invalid UI preference update.'));
    const parsed = UiPreferencesSchema.safeParse({ ...preferencesRef.current, ...patch.data });
    if (!parsed.success) return Promise.reject(new Error('Invalid UI preference value.'));
    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    preferencesRef.current = parsed.data;
    setPreferences(parsed.data);

    const desktop = window.ezterminalDesktop;
    if (!desktop?.setUiPreferences) return Promise.resolve();
    const run = writeQueueRef.current.then(async () => {
      try {
        const persisted = UiPreferencesSchema.parse(await desktop.setUiPreferences(patch.data));
        if (revisionRef.current === revision) {
          preferencesRef.current = persisted;
          setPreferences(persisted);
        }
      } catch (error) {
        if (revisionRef.current === revision) {
          try {
            const persisted = UiPreferencesSchema.parse(await desktop.getUiPreferences());
            preferencesRef.current = persisted;
            setPreferences(persisted);
          } catch {
            // Keep the optimistic session value when authoritative recovery is unavailable.
          }
        }
        throw error;
      }
    });
    // The caller observes its own failure, while the shared tail always heals so
    // a transient IPC rejection cannot prevent later preference writes.
    writeQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const value = useMemo<UiPreferencesContextValue>(() => ({
    preferences,
    ready,
    updatePreferences,
  }), [preferences, ready, updatePreferences]);

  return (
    <UiPreferencesContext.Provider value={value}>
      <AppI18nProvider locale={preferences.locale} languages={languages}>
        {children}
      </AppI18nProvider>
    </UiPreferencesContext.Provider>
  );
}

export function useUiPreferences(): UiPreferencesContextValue {
  const value = useContext(UiPreferencesContext);
  if (!value) throw new Error('useUiPreferences must be used inside DesktopUiPreferencesProvider.');
  return value;
}
