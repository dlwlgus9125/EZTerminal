import { describe, expect, it } from 'vitest';

import {
  RESOURCE_PROFILE_POLICY,
  UiResourceProfileSchema,
  observationalIntervalMs,
} from './resource-profile';

describe('resource profile policy', () => {
  it('keeps the three persisted values and their preload strategies explicit', () => {
    expect(UiResourceProfileSchema.options).toEqual([
      'balanced',
      'low-resource',
      'high-responsiveness',
    ]);
    expect(RESOURCE_PROFILE_POLICY).toEqual({
      balanced: { preload: 'idle', observationalIntervalFactor: 1 },
      'low-resource': { preload: 'intent', observationalIntervalFactor: 2 },
      'high-responsiveness': { preload: 'eager', observationalIntervalFactor: 1 },
    });
  });

  it('slows only allow-listed observations in low-resource mode', () => {
    expect(observationalIntervalMs(2_000, 'balanced')).toBe(2_000);
    expect(observationalIntervalMs(2_000, 'high-responsiveness')).toBe(2_000);
    expect(observationalIntervalMs(2_000, 'low-resource')).toBe(4_000);
    expect(observationalIntervalMs(0.5, 'low-resource')).toBe(2);
  });
});
