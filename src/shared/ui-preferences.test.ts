import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UI_PREFERENCES,
  UiPreferencesPatchSchema,
  UiPreferencesSchema,
  navigatorLanguages,
  resolveUiLocale,
} from './ui-preferences';

describe('UI preferences', () => {
  it('ships the approved adaptive defaults', () => {
    expect(DEFAULT_UI_PREFERENCES).toEqual({
      locale: 'system',
      density: 'adaptive',
      sidebarWidth: 320,
    });
  });

  it('accepts every supported preference and bounds sidebar width', () => {
    for (const locale of ['system', 'ko', 'en']) {
      for (const density of ['adaptive', 'compact', 'comfortable']) {
        expect(UiPreferencesSchema.safeParse({ locale, density, sidebarWidth: 280 }).success).toBe(true);
        expect(UiPreferencesSchema.safeParse({ locale, density, sidebarWidth: 440 }).success).toBe(true);
      }
    }
    expect(UiPreferencesSchema.safeParse({ ...DEFAULT_UI_PREFERENCES, sidebarWidth: 279 }).success).toBe(false);
    expect(UiPreferencesSchema.safeParse({ ...DEFAULT_UI_PREFERENCES, sidebarWidth: 441 }).success).toBe(false);
  });

  it('accepts only non-empty partial IPC updates with known fields', () => {
    expect(UiPreferencesPatchSchema.safeParse({ locale: 'ko' }).success).toBe(true);
    expect(UiPreferencesPatchSchema.safeParse({ density: 'compact', sidebarWidth: 360 }).success).toBe(true);
    expect(UiPreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(UiPreferencesPatchSchema.safeParse({ locale: 'ko', extra: true }).success).toBe(false);
  });

  it('uses Korean only when the first applicable system language is Korean', () => {
    expect(resolveUiLocale('system', ['ko-KR', 'en-US'])).toBe('ko');
    expect(resolveUiLocale('system', ['en-US', 'ko-KR'])).toBe('en');
    expect(resolveUiLocale('system', ['', 'ko_KR'])).toBe('ko');
    expect(resolveUiLocale('system', [])).toBe('en');
    expect(resolveUiLocale('ko', ['en-US'])).toBe('ko');
    expect(resolveUiLocale('en', ['ko-KR'])).toBe('en');
  });

  it('prefers navigator.languages and falls back to navigator.language', () => {
    expect(navigatorLanguages({ language: 'en-US', languages: ['ko-KR', 'en-US'] })).toEqual([
      'ko-KR',
      'en-US',
    ]);
    expect(navigatorLanguages({ language: 'ko-KR', languages: [] })).toEqual(['ko-KR']);
    expect(navigatorLanguages({ language: '', languages: [] })).toEqual([]);
  });
});
