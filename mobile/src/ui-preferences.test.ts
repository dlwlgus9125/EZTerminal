import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMobileUiPreferences, saveMobileUiPreferences } from './ui-preferences';

describe('mobile UI preferences', () => {
  beforeEach(() => localStorage.clear());

  it('defaults locally without contacting the remote transport', () => {
    expect(loadMobileUiPreferences()).toEqual({
      locale: 'system',
      density: 'adaptive',
      sidebarWidth: 320,
      effectIntensity: 7,
      resourceProfile: 'balanced',
    });
  });

  it('round-trips the complete device-local snapshot', () => {
    const preferences = {
      locale: 'ko',
      density: 'compact',
      sidebarWidth: 380,
      effectIntensity: 7,
      resourceProfile: 'low-resource',
    } as const;
    expect(saveMobileUiPreferences(preferences)).toBe(true);
    expect(loadMobileUiPreferences()).toEqual(preferences);
    expect(JSON.parse(localStorage.getItem('ezterminal-mobile-ui-preferences') ?? '{}')).toEqual({
      version: 3,
      preferences,
    });
  });

  it('migrates the legacy v1 snapshot without discarding valid device choices', () => {
    localStorage.setItem('ezterminal-mobile-ui-preferences', JSON.stringify({
      version: 1,
      preferences: {
        locale: 'ko',
        density: 'compact',
        sidebarWidth: 380,
      },
    }));

    expect(loadMobileUiPreferences()).toEqual({
      locale: 'ko',
      density: 'compact',
      sidebarWidth: 380,
      effectIntensity: 7,
      resourceProfile: 'balanced',
    });
    expect(JSON.parse(localStorage.getItem('ezterminal-mobile-ui-preferences') ?? '{}')).toEqual({
      version: 3,
      preferences: {
        locale: 'ko',
        density: 'compact',
        sidebarWidth: 380,
        effectIntensity: 7,
        resourceProfile: 'balanced',
      },
    });
  });

  it('migrates a v2 snapshot by adding only the resource profile default', () => {
    localStorage.setItem('ezterminal-mobile-ui-preferences', JSON.stringify({
      version: 2,
      preferences: {
        locale: 'en',
        density: 'comfortable',
        sidebarWidth: 400,
        effectIntensity: 4,
      },
    }));

    expect(loadMobileUiPreferences()).toEqual({
      locale: 'en',
      density: 'comfortable',
      sidebarWidth: 400,
      effectIntensity: 4,
      resourceProfile: 'balanced',
    });
  });

  it('ignores a corrupt or invalid stored payload', () => {
    localStorage.setItem('ezterminal-mobile-ui-preferences', '{bad json');
    expect(loadMobileUiPreferences().locale).toBe('system');
    localStorage.setItem('ezterminal-mobile-ui-preferences', JSON.stringify({
      version: 1,
      preferences: { locale: 'ko', density: 'tiny', sidebarWidth: 320 },
    }));
    expect(loadMobileUiPreferences().density).toBe('adaptive');
  });

  it('fails closed when storage is unavailable', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(() => { throw new Error('blocked'); }),
    };
    expect(loadMobileUiPreferences(storage).density).toBe('adaptive');
    expect(saveMobileUiPreferences({
      locale: 'en',
      density: 'comfortable',
      sidebarWidth: 320,
      effectIntensity: 7,
      resourceProfile: 'balanced',
    }, storage)).toBe(false);
  });
});
