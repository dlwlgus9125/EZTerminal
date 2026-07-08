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

// ── CRT interference params (crt-interference) ──────────────────────────────
// Four more parameterized effects sharing the rollbar lifecycle above:
// persisted per-platform as ONE `effectParams` blob (desktop: settings.json
// `effectParams` via layout-store; mobile: localStorage
// `ezterminal-mobile-effect-params`), clamped on every read/set, applied as
// `--fx-*` custom properties that index.css reads with matching fallbacks.
// `flicker` predates this set in the catalog but gets its params here too
// (the old CSS was an unparameterized stub coupled to scanlines).

// The interference param shapes are TYPE ALIASES (not interfaces) on purpose:
// aliases get an implicit index signature, so InterferenceParams is directly
// assignable to the loose EffectParamsSettings wire Record without casts.
export type BurstJitterParams = {
  /** Seconds between bursts (1..30) — the full animation cycle length; the
   * screen is at rest for everything past the burst window. */
  readonly period: number;
  /** Burst length in ms (50..1000): how long each interference burst shakes
   * the screen. Capped in the keyframe generator at 50% of the cycle — a
   * burst that never rests is micro-jitter's job. */
  readonly duration: number;
  /** Peak displacement in px (1..20), scaled through a fixed offset table. */
  readonly intensity: number;
  /** Also flash the static-noise texture during the burst window (same
   * animation clock, so it is always frame-locked to the shake). */
  readonly flash: boolean;
};

export type MicroJitterParams = {
  /** Jump rate 1..20 (higher = faster): one 10-jump cycle takes 4/speed s. */
  readonly speed: number;
  /** Displacement of every jump in px (1..5). */
  readonly amplitude: number;
};

export type NoiseParams = {
  /** Grain fineness 1..100 (higher = finer): tile renders at
   * 64+(100-density)*2 px, so 100 -> 64px (fine) and 1 -> 262px (coarse). */
  readonly density: number;
  /** Overlay opacity 1..100 (%). */
  readonly opacity: number;
  /** Shuffle rate 1..20: one 8-jump position cycle takes 4/speed s. */
  readonly speed: number;
};

export type FlickerParams = {
  /** Flicker rate in Hz (1..30): one bright→dim→bright cycle per 1/f s. */
  readonly frequency: number;
  /** Dim depth 1..40 (%): the dim phase drops #root opacity to 1-depth/100. */
  readonly depth: number;
};

// Defaults tuned subtle: a 250ms 6px bump every 5s, 1px trembles, a faint
// (12%) mid-grain snow, and the flicker stub's original feel (the old CSS
// hardcoded 0.15s / 0.92 — 8Hz/8% keeps that character, now adjustable).
export const DEFAULT_BURST_PARAMS: BurstJitterParams = { period: 5, duration: 250, intensity: 6, flash: true };
export const DEFAULT_MICRO_PARAMS: MicroJitterParams = { speed: 8, amplitude: 1 };
export const DEFAULT_NOISE_PARAMS: NoiseParams = { density: 60, opacity: 12, speed: 10 };
export const DEFAULT_FLICKER_PARAMS: FlickerParams = { frequency: 8, depth: 8 };

export function clampBurstJitterParams(partial: Partial<BurstJitterParams>): BurstJitterParams {
  return {
    period: clampInt(partial.period, 1, 30, DEFAULT_BURST_PARAMS.period),
    duration: clampInt(partial.duration, 50, 1000, DEFAULT_BURST_PARAMS.duration),
    intensity: clampInt(partial.intensity, 1, 20, DEFAULT_BURST_PARAMS.intensity),
    flash: typeof partial.flash === 'boolean' ? partial.flash : DEFAULT_BURST_PARAMS.flash,
  };
}

export function clampMicroJitterParams(partial: Partial<MicroJitterParams>): MicroJitterParams {
  return {
    speed: clampInt(partial.speed, 1, 20, DEFAULT_MICRO_PARAMS.speed),
    amplitude: clampInt(partial.amplitude, 1, 5, DEFAULT_MICRO_PARAMS.amplitude),
  };
}

export function clampNoiseParams(partial: Partial<NoiseParams>): NoiseParams {
  return {
    density: clampInt(partial.density, 1, 100, DEFAULT_NOISE_PARAMS.density),
    opacity: clampInt(partial.opacity, 1, 100, DEFAULT_NOISE_PARAMS.opacity),
    speed: clampInt(partial.speed, 1, 20, DEFAULT_NOISE_PARAMS.speed),
  };
}

export function clampFlickerParams(partial: Partial<FlickerParams>): FlickerParams {
  return {
    frequency: clampInt(partial.frequency, 1, 30, DEFAULT_FLICKER_PARAMS.frequency),
    depth: clampInt(partial.depth, 1, 40, DEFAULT_FLICKER_PARAMS.depth),
  };
}

const FX_KEYFRAMES_STYLE_ID = 'ez-fx-keyframes';

/** Lazily create the single `#ez-fx-keyframes` <style> node (same idempotent
 * shape as theme-runtime.ts's ensureThemeVarsStyleEl). Appended to <head>
 * after index.css's bundled sheet, so keyframes written here override the
 * static default `fx-jitter-burst`/`fx-burst-flash` blocks index.css ships
 * (for @keyframes the last definition of a name wins the cascade). */
export function ensureFxKeyframesStyleEl(): HTMLStyleElement {
  const existing = document.getElementById(FX_KEYFRAMES_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement('style');
  style.id = FX_KEYFRAMES_STYLE_ID;
  document.head.appendChild(style);
  return style;
}

/** Fixed displacement pattern (multipliers of `intensity`), y-biased for the
 * vertical-hold CRT feel; the final entry returns to rest. Deterministic on
 * purpose (rollbar precedent) — "random enough" at 5 jumps in <=1s, and unit
 * tests / phase-frozen pixel checks can assert exact offsets. */
const BURST_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [-0.6, -1],
  [0.4, 0.7],
  [0, -0.5],
  [-0.3, 0.3],
  [0, 0],
];

/** Keyframe % stops cannot be var()-driven, so period/duration changes need
 * regenerated keyframes: the burst occupies the first `f`% of the cycle
 * (f = duration/period, floored to 1, capped at 50), with the offset table
 * spread evenly across it, then rest until 100%. The flash timeline shares
 * the same window so it stays locked to the shake. */
export function buildBurstKeyframes(params: BurstJitterParams): string {
  const { period, duration, intensity, flash } = params;
  const f = Math.min(50, Math.max(1, (duration / 1000 / period) * 100));
  const steps = BURST_OFFSETS.map(([mx, my], i) => {
    const at = ((f * i) / (BURST_OFFSETS.length - 1)).toFixed(2);
    const x = Math.round(mx * intensity);
    const y = Math.round(my * intensity);
    return `  ${at}% { transform: translate(${x}px, ${y}px); }`;
  }).join('\n');
  return [
    '@keyframes fx-jitter-burst {',
    steps,
    '  100% { transform: translate(0px, 0px); }',
    '}',
    '@keyframes fx-burst-flash {',
    `  0% { opacity: ${flash ? '0.25' : '0'}; }`,
    `  ${f.toFixed(2)}% { opacity: 0; }`,
    '  100% { opacity: 0; }',
    '}',
  ].join('\n');
}

export function applyBurstJitterParams(params: BurstJitterParams): void {
  document.documentElement.style.setProperty('--fx-burst-period', `${params.period}s`);
  ensureFxKeyframesStyleEl().textContent = buildBurstKeyframes(params);
}

export function applyMicroJitterParams(params: MicroJitterParams): void {
  const root = document.documentElement;
  root.style.setProperty('--fx-micro-duration', `${(4 / params.speed).toFixed(2)}s`);
  root.style.setProperty('--fx-micro-amp', `${params.amplitude}px`);
}

export function applyNoiseParams(params: NoiseParams): void {
  const root = document.documentElement;
  root.style.setProperty('--fx-noise-size', `${64 + (100 - params.density) * 2}px`);
  root.style.setProperty('--fx-noise-opacity', (params.opacity / 100).toFixed(2));
  root.style.setProperty('--fx-noise-duration', `${(4 / params.speed).toFixed(2)}s`);
}

export function applyFlickerParams(params: FlickerParams): void {
  const root = document.documentElement;
  root.style.setProperty('--fx-flicker-duration', `${(1 / params.frequency).toFixed(3)}s`);
  root.style.setProperty('--fx-flicker-min', (1 - params.depth / 100).toFixed(2));
}

/** The four interference param sets as one unit — the shape both platforms
 * persist (loosely, as a Record blob) and the settings UIs edit. Keys are the
 * effect ids so the UI can index by the catalog entry it is rendering. */
export type InterferenceParams = {
  readonly 'jitter-burst': BurstJitterParams;
  readonly 'micro-jitter': MicroJitterParams;
  readonly 'static-noise': NoiseParams;
  readonly flicker: FlickerParams;
};

export const DEFAULT_INTERFERENCE_PARAMS: InterferenceParams = {
  'jitter-burst': DEFAULT_BURST_PARAMS,
  'micro-jitter': DEFAULT_MICRO_PARAMS,
  'static-noise': DEFAULT_NOISE_PARAMS,
  flicker: DEFAULT_FLICKER_PARAMS,
};

/** Clamp an untyped persisted/IPC-relayed blob (or anything else) into a
 * fully-defaulted InterferenceParams — same read/set double-clamp contract
 * as clampRollbarParams, extended to survive a non-object entirely. */
export function clampInterferenceParams(partial: unknown): InterferenceParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>;
  return {
    'jitter-burst': clampBurstJitterParams((p['jitter-burst'] ?? {}) as Partial<BurstJitterParams>),
    'micro-jitter': clampMicroJitterParams((p['micro-jitter'] ?? {}) as Partial<MicroJitterParams>),
    'static-noise': clampNoiseParams((p['static-noise'] ?? {}) as Partial<NoiseParams>),
    flicker: clampFlickerParams((p.flicker ?? {}) as Partial<FlickerParams>),
  };
}

export function applyInterferenceParams(params: InterferenceParams): void {
  applyBurstJitterParams(params['jitter-burst']);
  applyMicroJitterParams(params['micro-jitter']);
  applyNoiseParams(params['static-noise']);
  applyFlickerParams(params.flicker);
}
