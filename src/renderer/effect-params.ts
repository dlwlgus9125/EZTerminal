import { isColorValue } from '../shared/theme-schema';

// Rollbar effect params (rollbar-params) — user-configurable crt-rollbar line
// count/thickness/gap/color, mirroring the effectToggles/font lifecycle:
// persisted per-platform (desktop: settings.json via layout-store.ts; mobile:
// localStorage in mobile/theme.ts), applied live via CSS custom properties
// index.css's crt-rollbar block reads (with matching fallback defaults, so
// the effect still looks right before JS ever sets a var).

export interface RollbarParams {
  /** Per-line thickness in px (1..200 — thick CRT bands welcome; opacity and
   * gradient softness scale with it since the stops are computed from it). */
  readonly thickness: number;
  /** Line spacing 1..100 (% of the screen height): the constant pitch from
   * one line's top to the next line's top. The stream is an endless conveyor
   * — there is no line count; as one line exits at the bottom the next enters
   * at the top, always exactly this far behind. 100 = one screen-height apart. */
  readonly gap: number;
  readonly color: string;
  /** Roll speed 1..20 (higher = faster): a line crosses the full screen in
   * 24/speed seconds, independent of the spacing. */
  readonly speed: number;
  /** Per-bar opacity 0..100 (%). */
  readonly opacity: number;
  /** Per-line gradient softness 0..100 (%): 0 = hard solid edges, 100 = a
   * full fade-in/out triangle (no solid core). Every line gets the SAME
   * gradient — this shapes it. */
  readonly softness: number;
}

// Default look: a very wide (120px), very faint (20%) fully-soft band in the
// Matrix foreground green (#5fe7ac = [data-theme='matrix'] --term-fg),
// drifting slowly (speed 1 -> a line crosses the screen in 24s) at a 70%
// screen-height pitch — a subtle old-CRT glow pass, not a hard stripe.
export const DEFAULT_ROLLBAR_PARAMS: RollbarParams = {
  thickness: 120,
  gap: 70,
  color: '#5fe7ac',
  speed: 1,
  opacity: 20,
  softness: 100,
};

const THICKNESS_MIN = 1;
const THICKNESS_MAX = 200;
const GAP_MIN = 1;
const GAP_MAX = 100;
const SPEED_MIN = 1;
const SPEED_MAX = 20;
const OPACITY_MIN = 0;
const OPACITY_MAX = 100;
const SOFTNESS_MIN = 0;
const SOFTNESS_MAX = 100;

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
    thickness: clampInt(partial.thickness, THICKNESS_MIN, THICKNESS_MAX, DEFAULT_ROLLBAR_PARAMS.thickness),
    gap: clampInt(partial.gap, GAP_MIN, GAP_MAX, DEFAULT_ROLLBAR_PARAMS.gap),
    color:
      typeof partial.color === 'string' && isColorValue(partial.color)
        ? partial.color
        : DEFAULT_ROLLBAR_PARAMS.color,
    speed: clampInt(partial.speed, SPEED_MIN, SPEED_MAX, DEFAULT_ROLLBAR_PARAMS.speed),
    opacity: clampInt(partial.opacity, OPACITY_MIN, OPACITY_MAX, DEFAULT_ROLLBAR_PARAMS.opacity),
    softness: clampInt(partial.softness, SOFTNESS_MIN, SOFTNESS_MAX, DEFAULT_ROLLBAR_PARAMS.softness),
  };
}

/** Write the params onto <html> as `--fx-rollbar-*` custom properties —
 * index.css's crt-rollbar block reads these (with matching fallback
 * defaults).
 *
 * SEAMLESS CONVEYOR geometry: the only geometric var is the PERIOD (the
 * pitch between line tops, `gap`% of the viewport = `${gap}vh`). CSS derives
 * the rest from it: the overlay is one period TALLER than the screen and
 * starts one period ABOVE it, and the sweep animation translates it DOWN by
 * exactly one period before looping — pattern period == travel distance, so
 * the loop reset is invisible: as a line exits at the bottom, the next line
 * is already entering at the top at the same constant pitch. The screen is
 * never empty and the spacing never varies.
 *
 * Duration is per-PERIOD: a line must cross the full screen in 24/speed
 * seconds regardless of spacing, so one period of travel takes
 * (24/speed) * (gap/100) seconds. */
export function applyRollbarParams(params: RollbarParams): void {
  const root = document.documentElement;
  const { thickness, gap } = params;
  root.style.setProperty('--fx-rollbar-thickness', String(thickness));
  root.style.setProperty('--fx-rollbar-period', `${gap}vh`);
  root.style.setProperty('--fx-rollbar-color', params.color);
  root.style.setProperty(
    '--fx-rollbar-duration',
    `${((24 / params.speed) * (gap / 100)).toFixed(2)}s`,
  );
  root.style.setProperty('--fx-rollbar-opacity', (params.opacity / 100).toFixed(2));
  // Gradient softness -> the two color-stop offsets INSIDE each line's
  // thickness: fade-in ends at t*softness/200, fade-out starts mirrored.
  // softness 0 -> stops at 0/t (hard edges); 100 -> both at t/2 (triangle).
  const fadePx = (thickness * params.softness) / 200;
  root.style.setProperty('--fx-rollbar-grad-in', `${fadePx.toFixed(2)}px`);
  root.style.setProperty('--fx-rollbar-grad-out', `${(thickness - fadePx).toFixed(2)}px`);
}
