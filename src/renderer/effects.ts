import type { ThemeDefinition } from './themes';

// Effect catalog (theme-effects-font M0/M1) — a curated, finite set of visual
// effects a theme MAY declare (`ThemeDefinition.effects`) and the user MAY
// toggle independently. External mods can only ever reference these ids
// (shared/theme-schema.ts drops anything else, with a warning) — no
// arbitrary CSS ships with a mod. The CSS worker keys selectors off these
// exact ids: `html[data-effect-<id>='on']` (index.css).

export type EffectId =
  | 'scanlines'
  | 'phosphor-glow'
  | 'flicker'
  | 'crt-curvature'
  | 'crt-rollbar'
  | 'scanline-scroll'
  | 'jitter-burst'
  | 'micro-jitter'
  | 'static-noise';

export interface EffectCatalogEntry {
  readonly id: EffectId;
  readonly label: string;
  /** Catalog-level default-on guidance (e.g. for a caller seeding its own
   * `platformDefaults` map) — NOT read by `resolveActiveEffects` itself,
   * which takes `platformDefaults` explicitly from its caller instead. */
  readonly defaultOn: boolean;
}

export const EFFECT_CATALOG: Readonly<Record<EffectId, EffectCatalogEntry>> = {
  scanlines: { id: 'scanlines', label: 'Scanlines', defaultOn: true },
  'phosphor-glow': { id: 'phosphor-glow', label: 'Phosphor Glow', defaultOn: true },
  flicker: { id: 'flicker', label: 'Flicker', defaultOn: false },
  'crt-curvature': { id: 'crt-curvature', label: 'CRT Curvature', defaultOn: false },
  'crt-rollbar': { id: 'crt-rollbar', label: 'CRT Roll Bar', defaultOn: true },
  'scanline-scroll': { id: 'scanline-scroll', label: 'Scanline Scroll', defaultOn: true },
  // CRT interference trio (crt-interference): intrusive by design, so all
  // three ship defaultOn:false on every platform — strictly opt-in, like
  // flicker/crt-curvature above. Params live in effect-params.ts
  // (InterferenceParams), which also parameterizes the upgraded flicker.
  'jitter-burst': { id: 'jitter-burst', label: 'Burst Jitter', defaultOn: false },
  'micro-jitter': { id: 'micro-jitter', label: 'Micro Jitter', defaultOn: false },
  'static-noise': { id: 'static-noise', label: 'Static Noise', defaultOn: false },
};

const EFFECT_IDS = Object.keys(EFFECT_CATALOG) as EffectId[];

/**
 * Which effects should actually be active right now: gated by (the active
 * theme DECLARES the effect) AND (the user's toggle is on, defaulting to
 * `platformDefaults[id]` when the user hasn't set one). An effect the theme
 * doesn't declare is never active regardless of toggle state (AC-E4) — a
 * leftover toggle from a since-switched theme, or a mod that lists an effect
 * it doesn't actually use, can't leak it into the wrong theme.
 */
export function resolveActiveEffects(
  theme: ThemeDefinition,
  userToggles: Record<string, boolean>,
  platformDefaults: Record<EffectId, boolean>,
): Set<EffectId> {
  const declared = new Set(theme.effects ?? []);
  const active = new Set<EffectId>();
  for (const id of EFFECT_IDS) {
    if (!declared.has(id)) continue;
    const on = userToggles[id] ?? platformDefaults[id];
    if (on) active.add(id);
  }
  return active;
}

/** Write the active-effects set onto <html> as `data-effect-<id>='on'`, and
 * remove the attribute for everything else — the CSS worker's selectors key
 * off exactly this attribute (scanlines -> `::after`, crt-curvature ->
 * `::before`, phosphor-glow -> text-shadow, flicker -> an opacity keyframe). */
export function applyEffects(active: Set<EffectId>): void {
  for (const id of EFFECT_IDS) {
    const attr = `data-effect-${id}`;
    if (active.has(id)) {
      document.documentElement.setAttribute(attr, 'on');
    } else {
      document.documentElement.removeAttribute(attr);
    }
  }
}
