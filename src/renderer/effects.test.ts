/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  EFFECT_CATALOG,
  MOVING_EFFECT_IDS,
  applyEffectIntensity,
  applyEffects,
  resolveActiveEffects,
  type EffectId,
} from './effects';
import type { ThemeDefinition } from './themes';

function theme(effects?: EffectId[]): ThemeDefinition {
  return {
    id: 't',
    name: 'T',
    cssVars: {},
    xterm: {},
    fontFamily: 'monospace',
    fontSize: 13,
    effects,
  };
}

const ALL_OFF: Record<EffectId, boolean> = {
  scanlines: false,
  'phosphor-glow': false,
  flicker: false,
  'crt-curvature': false,
  'crt-rollbar': false,
  'scanline-scroll': false,
  'jitter-burst': false,
  'micro-jitter': false,
  'static-noise': false,
};
const ALL_ON: Record<EffectId, boolean> = {
  scanlines: true,
  'phosphor-glow': true,
  flicker: true,
  'crt-curvature': true,
  'crt-rollbar': true,
  'scanline-scroll': true,
  'jitter-burst': true,
  'micro-jitter': true,
  'static-noise': true,
};

describe('EFFECT_CATALOG', () => {
  it('declares exactly the known ids', () => {
    expect(Object.keys(EFFECT_CATALOG).sort()).toEqual(
      [
        'crt-curvature',
        'crt-rollbar',
        'flicker',
        'phosphor-glow',
        'scanline-scroll',
        'scanlines',
        'jitter-burst',
        'micro-jitter',
        'static-noise',
      ].sort(),
    );
  });

  it('defaults the restrained Matrix CRT Signature effects on', () => {
    const defaultsOn = Object.values(EFFECT_CATALOG)
      .filter((entry) => entry.defaultOn)
      .map((entry) => entry.id);
    expect(defaultsOn).toEqual(['scanlines', 'phosphor-glow', 'crt-rollbar']);
  });
});

describe('resolveActiveEffects — gating truth table', () => {
  it('declared + toggle on -> active', () => {
    const active = resolveActiveEffects(theme(['scanlines']), { scanlines: true }, ALL_OFF);
    expect(active.has('scanlines')).toBe(true);
  });

  it('declared + toggle off -> inactive', () => {
    const active = resolveActiveEffects(theme(['scanlines']), { scanlines: false }, ALL_ON);
    expect(active.has('scanlines')).toBe(false);
  });

  it('NOT declared + toggle on -> inactive regardless of toggle (AC-E4)', () => {
    const active = resolveActiveEffects(theme([]), { scanlines: true }, ALL_ON);
    expect(active.has('scanlines')).toBe(false);
  });

  it('a theme with no effects field activates nothing', () => {
    expect(resolveActiveEffects(theme(undefined), ALL_ON, ALL_ON).size).toBe(0);
  });

  it('declared + no user toggle -> falls back to platformDefaults', () => {
    const active = resolveActiveEffects(theme(['scanlines']), {}, { ...ALL_OFF, scanlines: true });
    expect(active.has('scanlines')).toBe(true);
    const inactive = resolveActiveEffects(theme(['scanlines']), {}, ALL_OFF);
    expect(inactive.has('scanlines')).toBe(false);
  });

  it('gates the new interference ids exactly like the originals', () => {
    const declared = theme(['jitter-burst', 'micro-jitter', 'static-noise']);
    const active = resolveActiveEffects(declared, { 'jitter-burst': true }, ALL_OFF);
    expect(active.has('jitter-burst')).toBe(true);
    expect(active.has('micro-jitter')).toBe(false); // declared but defaulted off
    const undeclared = resolveActiveEffects(theme([]), { 'static-noise': true }, ALL_ON);
    expect(undeclared.has('static-noise')).toBe(false); // AC-E4
  });
});

describe('applyEffects', () => {
  it('sets data-effect-<id>=on for active effects and removes it for inactive ones', () => {
    applyEffects(new Set(['scanlines', 'flicker']));
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-flicker')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-phosphor-glow')).toBeNull();
    expect(document.documentElement.getAttribute('data-effect-crt-curvature')).toBeNull();
  });

  it('removes a previously-set attribute when no longer active', () => {
    applyEffects(new Set(['scanlines']));
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    applyEffects(new Set());
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBeNull();
  });

  it('uses the handoff intensity curve and suppresses motion below level 5', () => {
    applyEffects(new Set(['scanlines', 'phosphor-glow', 'crt-rollbar']));
    for (const [level, opacity] of [[0, 0.1], [4, 0.5], [5, 0.6], [7, 0.8], [10, 1]] as const) {
      applyEffectIntensity(level);
      expect(document.documentElement.dataset.effectIntensity).toBe(String(level));
      expect(document.documentElement.style.getPropertyValue('--ui-effect-intensity')).toBe(String(opacity));
    }

    applyEffectIntensity(4);
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-crt-rollbar')).toBeNull();

    applyEffectIntensity(0);
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBeNull();

    applyEffectIntensity(7);
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-crt-rollbar')).toBe('on');
  });

  it('keeps intensity zero authoritative across later theme and toggle applications', () => {
    applyEffects(new Set(['scanlines', 'phosphor-glow', 'crt-rollbar']));
    applyEffectIntensity(0);

    applyEffects(new Set(['scanlines', 'crt-curvature', 'static-noise']));
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBeNull();
    expect(document.documentElement.getAttribute('data-effect-crt-curvature')).toBeNull();
    expect(document.documentElement.getAttribute('data-effect-static-noise')).toBeNull();

    applyEffectIntensity(7);
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-crt-curvature')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-static-noise')).toBe('on');
  });

  it('force-disables every moving effect while reduced motion is requested', () => {
    let changeListener: (() => void) | undefined;
    const mediaQuery = {
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        changeListener = listener as () => void;
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    } as MediaQueryList;
    window.matchMedia = () => mediaQuery;

    applyEffects(new Set(Object.keys(EFFECT_CATALOG) as EffectId[]));
    expect(document.documentElement.getAttribute('data-effect-scanlines')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-phosphor-glow')).toBe('on');
    expect(document.documentElement.getAttribute('data-effect-crt-curvature')).toBe('on');
    for (const id of MOVING_EFFECT_IDS) {
      expect(document.documentElement.getAttribute(`data-effect-${id}`), id).toBeNull();
    }

    Object.defineProperty(mediaQuery, 'matches', { configurable: true, value: false });
    changeListener?.();
    for (const id of MOVING_EFFECT_IDS) {
      expect(document.documentElement.getAttribute(`data-effect-${id}`), id).toBe('on');
    }
  });
});
