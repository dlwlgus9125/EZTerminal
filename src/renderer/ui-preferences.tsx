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
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { AppI18nProvider } from './i18n';

interface UiPreferencesContextValue {
  readonly preferences: UiPreferences;
  readonly ready: boolean;
  readonly updatePreferences: (partial: UiPreferencesPatch) => Promise<void>;
}

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function DesktopUiPreferencesProvider({
  children,
  capabilities = rendererCapabilities,
}: {
  readonly children: ReactNode;
  readonly capabilities?: CapabilityAccess;
}): JSX.Element {
  const [preferences, setPreferences] = useState<UiPreferences>(() => ({ ...DEFAULT_UI_PREFERENCES }));
  const [ready, setReady] = useState(false);
  const [languages, setLanguages] = useState<readonly string[]>(() => navigatorLanguages());
  const preferencesRef = useRef(preferences);
  const revisionRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    if (capabilities.snapshot().desktop === 'unavailable') {
      setReady(true);
      return () => { alive = false; };
    }
    void capabilities.uiPreferences.load().then((stored) => {
      if (!alive) return;
      setReady(true);
      if (!stored) return;
      if (revisionRef.current !== 0) return;
      preferencesRef.current = stored;
      setPreferences(stored);
    }, () => {
      if (alive) setReady(true);
    });
    return () => { alive = false; };
  }, [capabilities]);

  useEffect(() => {
    const onLanguageChange = (): void => {
      setLanguages(navigatorLanguages());
      if (preferencesRef.current.locale === 'system') {
        void capabilities.uiPreferences.refreshNativeMenuLocale().catch(() => undefined);
      }
    };
    window.addEventListener('languagechange', onLanguageChange);
    return () => window.removeEventListener('languagechange', onLanguageChange);
  }, [capabilities]);

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

    if (capabilities.snapshot().desktop === 'unavailable') return Promise.resolve();
    const run = writeQueueRef.current.then(async () => {
      try {
        const saved = await capabilities.uiPreferences.save(patch.data);
        if (!saved) return;
        const persisted = UiPreferencesSchema.parse(saved);
        if (revisionRef.current === revision) {
          preferencesRef.current = persisted;
          setPreferences(persisted);
        }
      } catch (error) {
        if (revisionRef.current === revision) {
          try {
            const stored = await capabilities.uiPreferences.load();
            if (!stored) throw new Error('Desktop UI preferences are unavailable.');
            const persisted = UiPreferencesSchema.parse(stored);
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
  }, [capabilities]);

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
