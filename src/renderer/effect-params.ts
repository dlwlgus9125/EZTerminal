import { isColorValue } from '../shared/theme-schema';

// Rollbar effect params (rollbar-params) — user-configurable crt-rollbar line
// count/thickness/gap/color, mirroring the effectToggles/font lifecycle:
// persisted per-platform (desktop: settings.json via layout-store.ts; mobile:
// localStorage in mobile/theme.ts), applied live via CSS custom properties
// index.css's crt-rollbar block reads (with matching fallback defaults, so
// the effect still looks right before JS ever sets a var).

export interface RollbarParams {
  readonly count: number;
  readonly thickness: number;
  readonly gap: number;
  readonly color: string;
  /** Roll speed 1..20 (higher = faster); mapped to the sweep animation
   * duration in `applyRollbarParams` (duration = 24 / speed seconds). */
  readonly speed: number;
}

export const DEFAULT_ROLLBAR_PARAMS: RollbarParams = {
  count: 10,
  thickness: 2,
  gap: 4,
  color: '#c8ffe6',
  speed: 4,
};

const COUNT_MIN = 1;
const COUNT_MAX = 40;
const THICKNESS_MIN = 1;
const THICKNESS_MAX = 10;
const GAP_MIN = 0;
const GAP_MAX = 30;
const SPEED_MIN = 1;
const SPEED_MAX = 20;

/** Round + clamp to [min, max]; a non-finite input (absent/corrupt) falls
 * back to `fallback` — same double-clamp shape as ui-scale.ts's clampUiScale. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Clamp a partial (persisted or IPC-relayed) rollbar params object into a
 * fully-defaulted, bounds-safe `RollbarParams` — applied on both read and
 * set, so an out-of-range or corrupt value can never reach the DOM/CSS. The
 * color reuses theme-schema.ts's `isColorValue` (the same guard cssVars
 * values go through) and falls back to the default swatch when invalid. */
export function clampRollbarParams(partial: Partial<RollbarParams>): RollbarParams {
  return {
    count: clampInt(partial.count, COUNT_MIN, COUNT_MAX, DEFAULT_ROLLBAR_PARAMS.count),
    thickness: clampInt(partial.thickness, THICKNESS_MIN, THICKNESS_MAX, DEFAULT_ROLLBAR_PARAMS.thickness),
    gap: clampInt(partial.gap, GAP_MIN, GAP_MAX, DEFAULT_ROLLBAR_PARAMS.gap),
    color:
      typeof partial.color === 'string' && isColorValue(partial.color)
        ? partial.color
        : DEFAULT_ROLLBAR_PARAMS.color,
    speed: clampInt(partial.speed, SPEED_MIN, SPEED_MAX, DEFAULT_ROLLBAR_PARAMS.speed),
  };
}

/** Write the params onto <html> as `--fx-rollbar-*` custom properties —
 * index.css's crt-rollbar block reads these (with matching fallback
 * defaults) to size/space/color its repeating-gradient lines and set the
 * sweep duration. */
export function applyRollbarParams(params: RollbarParams): void {
  const root = document.documentElement;
  root.style.setProperty('--fx-rollbar-count', String(params.count));
  root.style.setProperty('--fx-rollbar-thickness', String(params.thickness));
  root.style.setProperty('--fx-rollbar-gap', String(params.gap));
  root.style.setProperty('--fx-rollbar-color', params.color);
  // Higher speed = shorter sweep duration; the CSS animation reads this var.
  root.style.setProperty('--fx-rollbar-duration', `${(24 / params.speed).toFixed(2)}s`);
}
