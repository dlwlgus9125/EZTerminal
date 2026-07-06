import { clampUiScale } from '../../src/renderer/ui-scale';

// Mobile's own UI scale choice — independent of the desktop's settings.json
// persistence (mirrors theme.ts's mobile-only localStorage pattern, D1). The
// clamp itself is the shared `clampUiScale` (src/renderer/ui-scale.ts) so both
// apps snap/bound to the same 80-150 step-10 range.

const UI_SCALE_KEY = 'ezterminal-mobile-ui-scale';

/** Reads the persisted percent, defaulting to 100 for anything absent,
 * non-numeric, or on a storage error (private browsing / quota) —
 * `clampUiScale` also falls back to 100 for a NaN/corrupt value. */
export function loadUiScale(): number {
  try {
    const raw = localStorage.getItem(UI_SCALE_KEY);
    return raw === null ? clampUiScale(100) : clampUiScale(Number(raw));
  } catch {
    return clampUiScale(100);
  }
}

export function saveUiScale(percent: number): void {
  try {
    localStorage.setItem(UI_SCALE_KEY, String(clampUiScale(percent)));
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}
