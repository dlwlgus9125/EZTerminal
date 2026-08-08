import {
  DEFAULT_UI_PREFERENCES,
  UiPreferencesSchema,
  type UiPreferences,
} from '../../src/shared/ui-preferences';

const MOBILE_UI_PREFERENCES_KEY = 'ezterminal-mobile-ui-preferences';
const MOBILE_UI_PREFERENCES_VERSION = 3;
const LEGACY_MOBILE_UI_PREFERENCES_VERSIONS = new Set([1, 2]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storeSnapshot(storage: StorageLike, preferences: UiPreferences): boolean {
  try {
    storage.setItem(MOBILE_UI_PREFERENCES_KEY, JSON.stringify({
      version: MOBILE_UI_PREFERENCES_VERSION,
      preferences,
    }));
    return true;
  } catch {
    return false;
  }
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
    if (envelope.version === MOBILE_UI_PREFERENCES_VERSION) {
      const parsed = UiPreferencesSchema.safeParse(envelope.preferences);
      return parsed.success ? parsed.data : defaults();
    }
    if (
      typeof envelope.version === 'number'
      && LEGACY_MOBILE_UI_PREFERENCES_VERSIONS.has(envelope.version)
      && isRecord(envelope.preferences)
    ) {
      const parsed = UiPreferencesSchema.safeParse({
        effectIntensity: DEFAULT_UI_PREFERENCES.effectIntensity,
        resourceProfile: DEFAULT_UI_PREFERENCES.resourceProfile,
        ...envelope.preferences,
      });
      if (parsed.success) {
        // Best-effort in-place migration. A blocked write must not discard a
        // valid device-local choice that was already read successfully.
        storeSnapshot(storage, parsed.data);
        return parsed.data;
      }
    }
    return defaults();
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
  return storeSnapshot(storage, parsed.data);
}
