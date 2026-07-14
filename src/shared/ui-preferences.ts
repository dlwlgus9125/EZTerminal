import { z } from 'zod';

/** Persisted language choice. `system` is resolved independently per device. */
export const UiLocalePreferenceSchema = z.enum(['system', 'ko', 'en']);
export type UiLocalePreference = z.infer<typeof UiLocalePreferenceSchema>;

/**
 * Adaptive follows the current viewport/input defaults. Compact and
 * comfortable are explicit user overrides shared by desktop and mobile.
 */
export const UiDensitySchema = z.enum(['adaptive', 'compact', 'comfortable']);
export type UiDensity = z.infer<typeof UiDensitySchema>;

export const MIN_SIDEBAR_WIDTH = 280;
export const MAX_SIDEBAR_WIDTH = 440;
export const DEFAULT_SIDEBAR_WIDTH = 320;
export const SidebarWidthSchema = z.number().int().min(MIN_SIDEBAR_WIDTH).max(MAX_SIDEBAR_WIDTH);

/** Atomic UI preference payload crossing the desktop preload boundary. */
export const UiPreferencesSchema = z.object({
  locale: UiLocalePreferenceSchema,
  density: UiDensitySchema,
  sidebarWidth: SidebarWidthSchema,
});
export type UiPreferences = z.infer<typeof UiPreferencesSchema>;

/** Main-process merge payload. Every field is optional, but unknown keys and
 * empty updates are rejected at the preload/IPC trust boundary. */
export const UiPreferencesPatchSchema = UiPreferencesSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one UI preference is required.' },
);
export type UiPreferencesPatch = z.infer<typeof UiPreferencesPatchSchema>;

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
  locale: 'system',
  density: 'adaptive',
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
});

export type ResolvedUiLocale = 'ko' | 'en';

/**
 * Resolve the persisted preference without leaking a browser global into the
 * shared/main-process module. The first applicable language wins: Korean
 * (`ko` or `ko-*`) selects Korean; every other language selects English.
 */
export function resolveUiLocale(
  preference: UiLocalePreference,
  languages: readonly string[],
): ResolvedUiLocale {
  if (preference !== 'system') return preference;
  const first = languages.find((language) => language.trim().length > 0);
  return first?.trim().toLowerCase().split(/[-_]/, 1)[0] === 'ko' ? 'ko' : 'en';
}

/** Browser-facing language list, kept injectable for unit tests. */
export function navigatorLanguages(
  source: Pick<Navigator, 'language' | 'languages'> | undefined =
    typeof navigator === 'undefined' ? undefined : navigator,
): readonly string[] {
  if (!source) return [];
  if (source.languages.length > 0) return source.languages;
  return source.language ? [source.language] : [];
}
