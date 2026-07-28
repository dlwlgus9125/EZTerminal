import { describe, expect, it } from 'vitest';

import { resolveActiveEffects, type EffectId } from '../../src/renderer/effects';
import { THEMES } from '../../src/renderer/themes';
import { isEffectOn } from './MobileSettingsView';
import { MOBILE_EFFECT_DEFAULTS } from './theme';

/**
 * The settings switch and the thing it claims to switch must agree.
 *
 * "Is this effect on?" is answered in two places: the apply path, through
 * `resolveActiveEffects(theme, userToggles, platformDefaults)`, and the
 * settings view, for the button's `aria-pressed`. While every platform default
 * was false those two agreed by coincidence. Promoting the CRT Signature
 * profile broke the coincidence and the switch began reporting "off" about an
 * effect that was visibly on — found on an emulator, not by any unit test,
 * which is exactly why this one exists.
 */

/** The settings view's own rule — imported, not re-implemented. A copy here
 * would pass no matter what the component did. */
const shownInSettings = isEffectOn;

const matrix = THEMES.matrix;
const declared = (matrix.effects ?? []) as EffectId[];

describe('mobile effect toggle state', () => {
  it('shows exactly what the apply path activates, on an untouched install', () => {
    const active = resolveActiveEffects(matrix, {}, MOBILE_EFFECT_DEFAULTS as Record<EffectId, boolean>);
    for (const id of declared) {
      expect({ id, shown: shownInSettings({}, id) }).toEqual({ id, shown: active.has(id) });
    }
  });

  it('still agrees once the user has overridden some of them', () => {
    const toggles: Record<string, boolean> = { scanlines: false, flicker: true };
    const active = resolveActiveEffects(matrix, toggles, MOBILE_EFFECT_DEFAULTS as Record<EffectId, boolean>);
    for (const id of declared) {
      expect({ id, shown: shownInSettings(toggles, id) }).toEqual({ id, shown: active.has(id) });
    }
  });

  it('lets one tap turn a defaulted-on effect off', () => {
    // The write path negates the RESOLVED state. Negating the STORED value
    // would write `true` over an implicit `true` and appear to do nothing.
    const stored: Record<string, boolean> = {};
    expect(shownInSettings(stored, 'scanlines')).toBe(true);

    const next = { ...stored, scanlines: !shownInSettings(stored, 'scanlines') };
    expect(shownInSettings(next, 'scanlines')).toBe(false);
    expect(
      resolveActiveEffects(matrix, next, MOBILE_EFFECT_DEFAULTS as Record<EffectId, boolean>).has('scanlines'),
    ).toBe(false);
  });
});
