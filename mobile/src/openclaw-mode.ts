import type { OpenClawMode } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';

/** Shared by every surface that shows the gateway state as a word (the More
 * sheet row, the Settings index preview) so they can never drift apart. */
export const OPENCLAW_STATE_LABEL_KEY = {
  'not-installed': 'mobile.openClaw.stateNotInstalled',
  stopped: 'mobile.openClaw.stateStopped',
  starting: 'mobile.openClaw.stateStarting',
  running: 'mobile.openClaw.stateRunning',
  unknown: 'mobile.openClaw.stateUnknown',
} as const satisfies Record<OpenClawStatus['state'], string>;

// Mobile's own OpenClaw visibility choice (openclaw-stabilization M3) —
// independent of the desktop's settings.json persistence, same mobile-only
// localStorage pattern as ui-scale.ts (split out of theme.ts the same way:
// a single small pref unrelated to theme). Default 'auto' matches the
// desktop's own default (LayoutStore.getOpenClawMode).

const OPENCLAW_MODE_KEY = 'ezterminal-mobile-openclaw-mode';

function isOpenClawMode(value: string): value is OpenClawMode {
  return value === 'auto' || value === 'on' || value === 'off';
}

/** Reads the persisted mode, defaulting to 'auto' for anything absent,
 * unrecognized, or on a storage error (private browsing / quota). */
export function loadOpenClawMode(): OpenClawMode {
  try {
    const raw = localStorage.getItem(OPENCLAW_MODE_KEY);
    return raw !== null && isOpenClawMode(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveOpenClawMode(mode: OpenClawMode): void {
  try {
    localStorage.setItem(OPENCLAW_MODE_KEY, mode);
  } catch {
    // best-effort — a private-browsing/quota failure only costs persistence next time
  }
}
