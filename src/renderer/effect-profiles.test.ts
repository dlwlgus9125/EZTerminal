import { describe, expect, it } from 'vitest';

import type { EffectId } from './effects';
import {
  EFFECT_PROFILE_IDS,
  isEffectProfileAvailable,
  mergeEffectProfileToggles,
  resolveEffectProfile,
  type EffectProfileId,
} from './effect-profiles';
import type { ThemeDefinition } from './themes';

const ALL_EFFECT_IDS: readonly EffectId[] = [
  'scanlines',
  'phosphor-glow',
  'crt-rollbar',
  'scanline-scroll',
  'flicker',
  'crt-curvature',
  'jitter-burst',
  'micro-jitter',
  'static-noise',
];

const ALL_OFF: Record<EffectId, boolean> = Object.fromEntries(
  ALL_EFFECT_IDS.map((effectId) => [effectId, false]),
) as Record<EffectId, boolean>;

function theme(effects: readonly string[]): Pick<ThemeDefinition, 'effects'> {
  return { effects };
}

function enabledIds(toggles: Readonly<Record<string, boolean>>): string[] {
  return Object.entries(toggles)
    .filter(([, enabled]) => enabled)
    .map(([effectId]) => effectId);
}

describe('effect profiles', () => {
  it.each<readonly [EffectProfileId, readonly EffectId[]]>([
    ['clean', []],
    ['static', ['scanlines', 'phosphor-glow']],
    ['crt-signature', ['scanlines', 'phosphor-glow', 'crt-rollbar']],
    ['full-crt', ALL_EFFECT_IDS],
  ])('merges the %s profile across every declared catalog effect', (profile, enabled) => {
    const merged = mergeEffectProfileToggles(theme(ALL_EFFECT_IDS), {}, profile);

    expect(enabledIds(merged)).toEqual(enabled);
    expect(Object.keys(merged)).toHaveLength(ALL_EFFECT_IDS.length);
  });

  it.each(EFFECT_PROFILE_IDS)('resolves the effective %s profile from user toggles and defaults', (profile) => {
    const toggles = mergeEffectProfileToggles(theme(ALL_EFFECT_IDS), {}, profile);
    const userToggles = Object.fromEntries(Object.entries(toggles).filter(([, enabled]) => enabled));
    const platformDefaults = {
      ...ALL_OFF,
      ...Object.fromEntries(Object.entries(toggles).filter(([, enabled]) => !enabled)),
    };

    expect(resolveEffectProfile(theme(ALL_EFFECT_IDS), userToggles, platformDefaults)).toBe(profile);
  });

  it('uses explicit user toggles before platform defaults', () => {
    const allOn = Object.fromEntries(ALL_EFFECT_IDS.map((effectId) => [effectId, true])) as Record<EffectId, boolean>;

    expect(resolveEffectProfile(theme(ALL_EFFECT_IDS), ALL_OFF, allOn)).toBe('clean');
  });

  it('returns custom when the declared effective state matches no named profile', () => {
    expect(
      resolveEffectProfile(theme(ALL_EFFECT_IDS), { scanlines: true, 'phosphor-glow': false, flicker: true }, ALL_OFF),
    ).toBe('custom');
  });

  it('supports custom themes by filtering unknown and duplicate effect ids', () => {
    const customTheme = theme(['scanlines', 'vendor-bloom', 'scanlines', 'phosphor-glow']);

    expect(resolveEffectProfile(customTheme, {}, { ...ALL_OFF, scanlines: true, 'phosphor-glow': true })).toBe(
      'static',
    );
    expect(mergeEffectProfileToggles(customTheme, {}, 'full-crt')).toEqual({
      scanlines: true,
      'phosphor-glow': true,
    });
  });

  it.each([
    [['scanlines'], ['clean', 'static']],
    [['flicker'], ['clean', 'full-crt']],
    [['crt-rollbar'], ['clean', 'crt-signature']],
    [[], ['clean']],
  ] as const)('only exposes canonical profiles for a sparse theme declaring %j', (effects, available) => {
    expect(EFFECT_PROFILE_IDS.filter((profile) => isEffectProfileAvailable(theme(effects), profile))).toEqual(
      available,
    );
  });

  it('exposes every profile when the theme can distinguish all four states', () => {
    expect(EFFECT_PROFILE_IDS.filter((profile) => isEffectProfileAvailable(theme(ALL_EFFECT_IDS), profile))).toEqual(
      EFFECT_PROFILE_IDS,
    );
  });

  it('preserves undeclared and unknown toggles without mutating the input record', () => {
    const current = {
      scanlines: false,
      'phosphor-glow': false,
      flicker: true,
      'vendor-bloom': true,
    };

    const merged = mergeEffectProfileToggles(theme(['scanlines', 'phosphor-glow']), current, 'static');

    expect(merged).toEqual({
      scanlines: true,
      'phosphor-glow': true,
      flicker: true,
      'vendor-bloom': true,
    });
    expect(current).toEqual({
      scanlines: false,
      'phosphor-glow': false,
      flicker: true,
      'vendor-bloom': true,
    });
    expect(merged).not.toBe(current);
  });
});
