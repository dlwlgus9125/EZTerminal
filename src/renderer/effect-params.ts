import { isColorValue } from '../shared/theme-schema';

// Rollbar effect params (rollbar-params) — user-configurable crt-rollbar line
// count/thickness/gap/color, mirroring the effectToggles/font lifecycle:
// persisted per-platform (desktop: settings.json via layout-store.ts; mobile:
// localStorage in mobile/theme.ts), applied live via CSS custom properties
// index.css's crt-rollbar block reads (with matching fallback defaults, so
// the effect still looks right before JS ever sets a var).

export interface RollbarParams {
  readonly count: number;
  /** Per-line thickness in px. */
  readonly thickness: number;
  /** Spread 0..100 (%): how far apart the lines sit. At 100 the FIRST line is
   * at the very top of the screen and the LAST at the very bottom (band =
   * full viewport, lines evenly distributed between); at 0 the lines touch. */
  readonly gap: number;
  readonly color: string;
  /** Roll speed 1..20 (higher = faster); mapped to the sweep animation
   * duration in `applyRollbarParams` (duration = 24 / speed seconds). */
  readonly speed: number;
  /** Per-bar opacity 0..100 (%). */
  readonly opacity: number;
  /** Per-line gradient softness 0..100 (%): 0 = hard solid edges, 100 = a
   * full fade-in/out triangle (no solid core). Every line gets the SAME
   * gradient — this shapes it. */
  readonly softness: number;
}

export const DEFAULT_ROLLBAR_PARAMS: RollbarParams = {
  count: 10,
  thickness: 2,
  gap: 100,
  color: '#c8ffe6',
  speed: 4,
  opacity: 90,
  softness: 70,
};

const COUNT_MIN = 1;
const COUNT_MAX = 40;
const THICKNESS_MIN = 1;
const THICKNESS_MAX = 10;
const GAP_MIN = 0;
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
    count: clampInt(partial.count, COUNT_MIN, COUNT_MAX, DEFAULT_ROLLBAR_PARAMS.count),
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
 * defaults) to size/space/color its repeating-gradient lines and set the
 * sweep duration.
 *
 * The band geometry is derived HERE as calc() strings (not in CSS) so the
 * count=1 edge case can't divide by zero and older calc() engines never
 * have to divide by a var:
 *  - height: `count*thickness px` at gap=0 (lines touching) growing linearly
 *    to `100vh` at gap=100 — so at max spread the FIRST line sits at the very
 *    top of the screen and the LAST at the very bottom.
 *  - period: (height - thickness) / (count - 1) — the pitch between line
 *    STARTS; the last line's bottom edge lands exactly on the band's bottom.
 *  - count=1: a single line (band = one thickness; period = thickness so the
 *    repeating gradient paints exactly one line). */
export function applyRollbarParams(params: RollbarParams): void {
  const root = document.documentElement;
  const { count, thickness, gap } = params;
  const linesPx = count * thickness;
  const spread = (gap / 100).toFixed(4);
  const height =
    count === 1
      ? `${thickness}px`
      : `calc(${linesPx}px + ${spread} * (100vh - ${linesPx}px))`;
  const period =
    count === 1
      ? `${thickness}px`
      : `calc((${linesPx}px + ${spread} * (100vh - ${linesPx}px) - ${thickness}px) / ${count - 1})`;
  root.style.setProperty('--fx-rollbar-count', String(count));
  root.style.setProperty('--fx-rollbar-thickness', String(thickness));
  root.style.setProperty('--fx-rollbar-gap', String(gap));
  root.style.setProperty('--fx-rollbar-height', height);
  root.style.setProperty('--fx-rollbar-period', period);
  root.style.setProperty('--fx-rollbar-color', params.color);
  // Higher speed = shorter sweep duration; the CSS animation reads this var.
  root.style.setProperty('--fx-rollbar-duration', `${(24 / params.speed).toFixed(2)}s`);
  root.style.setProperty('--fx-rollbar-opacity', (params.opacity / 100).toFixed(2));
  // Gradient softness -> the two color-stop offsets INSIDE each line's
  // thickness: fade-in ends at t*softness/200, fade-out starts mirrored.
  // softness 0 -> stops at 0/t (hard edges); 100 -> both at t/2 (triangle).
  const fadePx = (thickness * params.softness) / 200;
  root.style.setProperty('--fx-rollbar-grad-in', `${fadePx.toFixed(2)}px`);
  root.style.setProperty('--fx-rollbar-grad-out', `${(thickness - fadePx).toFixed(2)}px`);
}
