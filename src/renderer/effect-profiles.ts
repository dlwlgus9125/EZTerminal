import { EFFECT_CATALOG, type EffectId } from './effects';
import type { ThemeDefinition } from './themes';

export const EFFECT_PROFILE_IDS = ['clean', 'static', 'crt-signature', 'full-crt'] as const;

export type EffectProfileId = (typeof EFFECT_PROFILE_IDS)[number];
export type ResolvedEffectProfileId = EffectProfileId | 'custom';

type EffectTheme = Pick<ThemeDefinition, 'effects'>;
type EffectToggleRecord = Readonly<Record<string, boolean>>;
type PlatformEffectDefaults = Partial<Record<EffectId, boolean>>;

const STATIC_EFFECT_IDS: ReadonlySet<EffectId> = new Set(['scanlines', 'phosphor-glow']);
const CRT_SIGNATURE_EFFECT_IDS: ReadonlySet<EffectId> = new Set([...STATIC_EFFECT_IDS, 'crt-rollbar']);

function isEffectId(value: string): value is EffectId {
  return Object.prototype.hasOwnProperty.call(EFFECT_CATALOG, value);
}

function declaredEffectIds(theme: EffectTheme): EffectId[] {
  return [...new Set((theme.effects ?? []).filter(isEffectId))];
}

function profileEnablesEffect(profile: EffectProfileId, effectId: EffectId): boolean {
  switch (profile) {
    case 'clean':
      return false;
    case 'static':
      return STATIC_EFFECT_IDS.has(effectId);
    case 'crt-signature':
      return CRT_SIGNATURE_EFFECT_IDS.has(effectId);
    case 'full-crt':
      return true;
  }
}

/**
 * Resolve the active theme's effective effect state to a named profile.
 * Effects absent from the active theme (including unknown custom-theme ids)
 * are intentionally ignored because the runtime cannot activate them.
 *
 * Some custom themes declare too few effects to distinguish every profile.
 * In that case the least intensive matching profile wins in
 * EFFECT_PROFILE_IDS order.
 */
export function resolveEffectProfile(
  theme: EffectTheme,
  userToggles: EffectToggleRecord,
  platformDefaults: PlatformEffectDefaults,
): ResolvedEffectProfileId {
  const declared = declaredEffectIds(theme);

  for (const profile of EFFECT_PROFILE_IDS) {
    const matches = declared.every((effectId) => {
      const effectiveValue = userToggles[effectId] ?? platformDefaults[effectId] ?? false;
      return effectiveValue === profileEnablesEffect(profile, effectId);
    });
    if (matches) return profile;
  }

  return 'custom';
}

/**
 * Merge a named profile into the persisted toggle record without mutating it.
 * Only known effects declared by the active theme are changed. Undeclared
 * known effects and forward-compatible/unknown toggle keys are preserved.
 */
export function mergeEffectProfileToggles(
  theme: EffectTheme,
  currentToggles: EffectToggleRecord,
  profile: EffectProfileId,
): Record<string, boolean> {
  const next = { ...currentToggles };
  for (const effectId of declaredEffectIds(theme)) {
    next[effectId] = profileEnablesEffect(profile, effectId);
  }
  return next;
}

/**
 * A named profile is available only when applying it to this theme resolves
 * back to the same name. Sparse custom themes can otherwise expose multiple
 * menu choices that all produce one indistinguishable effect state.
 */
export function isEffectProfileAvailable(theme: EffectTheme, profile: EffectProfileId): boolean {
  const selectedState = mergeEffectProfileToggles(theme, {}, profile);
  return resolveEffectProfile(theme, selectedState, {}) === profile;
}
