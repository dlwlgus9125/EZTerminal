import type { ThemeName } from '../../src/shared/layout-schema';

// Mobile's own theme choice — independent of the desktop's settings.json
// persistence (no bridge protocol extension per the mobile-parity plan D6).
// `applyTheme` mirrors the desktop App.tsx's `applyTheme`/`ez:theme` pattern so
// the reused PtyBlock (which listens for `ez:theme` and re-skins its xterm
// instance from `THEMES[getActiveThemeName()]`) needs no mobile-specific code.

const THEME_KEY = 'ezterminal-mobile-theme';

export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'high-contrast', 'matrix'];

function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/** Reads the persisted choice, defaulting to 'dark' for anything absent,
 * unrecognized, or on a storage error (private browsing / quota). */
export function loadTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw !== null && isThemeName(raw) ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(name: ThemeName): void {
  try {
    localStorage.setItem(THEME_KEY, name);
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}

/** Applies `name` to the document + notifies open PtyBlocks to re-theme. Also
 * logs an `[ez-e2e]` marker (mirrors MobileSessionView's output marker) —
 * Android's WebView forwards console.log to logcat, which `mobile/e2e/parity.ts`
 * greps to assert a theme switch actually took effect. */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  window.dispatchEvent(new Event('ez:theme'));
  console.log('[ez-e2e] theme:', name);
}
