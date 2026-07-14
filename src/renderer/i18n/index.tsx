import { useEffect, useState, type ReactNode } from 'react';
import { createInstance, type i18n } from 'i18next';
import { I18nextProvider, setI18n, useTranslation } from 'react-i18next';

import {
  navigatorLanguages,
  resolveUiLocale,
  type ResolvedUiLocale,
  type UiLocalePreference,
} from '../../shared/ui-preferences';
import { appResources, defaultNamespace } from './resources';

export function createAppI18n(
  preference: UiLocalePreference = 'system',
  languages: readonly string[] = navigatorLanguages(),
): i18n {
  const instance = createInstance();
  void instance.init({
    resources: appResources,
    defaultNS: defaultNamespace,
    fallbackLng: 'en',
    lng: resolveUiLocale(preference, languages),
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return instance;
}

// Components rendered in isolation (unit tests and lightweight stories) still
// receive deterministic English strings. Product roots override this through
// AppI18nProvider with their persisted locale.
export const fallbackAppI18n = createAppI18n('en', []);
setI18n(fallbackAppI18n);

export function applyHtmlLanguage(
  locale: ResolvedUiLocale,
  target: Pick<Document, 'documentElement'> | undefined =
    typeof document === 'undefined' ? undefined : document,
): void {
  if (target) target.documentElement.lang = locale;
}

export interface AppI18nProviderProps {
  readonly locale?: UiLocalePreference;
  readonly languages?: readonly string[];
  readonly children: ReactNode;
}

/** Independent provider used by desktop, mobile, Storybook, and component tests. */
export function AppI18nProvider({
  locale = 'system',
  languages,
  children,
}: AppI18nProviderProps) {
  const deviceLanguages = languages ?? navigatorLanguages();
  const resolvedLocale = resolveUiLocale(locale, deviceLanguages);
  const [instance] = useState(() => createAppI18n(locale, deviceLanguages));

  useEffect(() => {
    applyHtmlLanguage(resolvedLocale);
    if (instance.resolvedLanguage !== resolvedLocale) {
      void instance.changeLanguage(resolvedLocale);
    }
  }, [instance, resolvedLocale]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

export function useAppTranslation() {
  return useTranslation(defaultNamespace);
}
