import {
  DEFAULT_UI_PREFERENCES,
  UiPreferencesSchema,
  type UiPreferences,
} from '../../src/shared/ui-preferences';

const MOBILE_UI_PREFERENCES_KEY = 'ezterminal-mobile-ui-preferences';
const MOBILE_UI_PREFERENCES_VERSION = 1;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaults(): UiPreferences {
  return { ...DEFAULT_UI_PREFERENCES };
}

/**
 * Mobile preferences are device-local by design. They never cross the remote
 * transport and cannot alter the paired desktop's settings.json.
 */
export function loadMobileUiPreferences(
  storage: StorageLike | null = browserStorage(),
): UiPreferences {
  if (!storage) return defaults();
  try {
    const raw = storage.getItem(MOBILE_UI_PREFERENCES_KEY);
    if (!raw) return defaults();
    const envelope = JSON.parse(raw) as { version?: unknown; preferences?: unknown };
    if (envelope.version !== MOBILE_UI_PREFERENCES_VERSION) return defaults();
    const parsed = UiPreferencesSchema.safeParse(envelope.preferences);
    return parsed.success ? parsed.data : defaults();
  } catch {
    return defaults();
  }
}

/** Validate and atomically replace the complete device-local snapshot. */
export function saveMobileUiPreferences(
  preferences: UiPreferences,
  storage: StorageLike | null = browserStorage(),
): boolean {
  const parsed = UiPreferencesSchema.safeParse(preferences);
  if (!storage || !parsed.success) return false;
  try {
    storage.setItem(MOBILE_UI_PREFERENCES_KEY, JSON.stringify({
      version: MOBILE_UI_PREFERENCES_VERSION,
      preferences: parsed.data,
    }));
    return true;
  } catch {
    return false;
  }
}
