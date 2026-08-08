import { z } from 'zod';

/** Device-local resource policy. It never crosses the remote wire. */
export const UiResourceProfileSchema = z.enum([
  'balanced',
  'low-resource',
  'high-responsiveness',
]);
export type UiResourceProfile = z.infer<typeof UiResourceProfileSchema>;

export type FeaturePreloadMode = 'intent' | 'idle' | 'eager';

export interface ResourceProfilePolicy {
  readonly preload: FeaturePreloadMode;
  /** Applies only to explicitly allow-listed observational refresh work. */
  readonly observationalIntervalFactor: 1 | 2;
}

export const RESOURCE_PROFILE_POLICY: Readonly<Record<UiResourceProfile, ResourceProfilePolicy>> =
  Object.freeze({
    balanced: Object.freeze({ preload: 'idle', observationalIntervalFactor: 1 }),
    'low-resource': Object.freeze({ preload: 'intent', observationalIntervalFactor: 2 }),
    'high-responsiveness': Object.freeze({ preload: 'eager', observationalIntervalFactor: 1 }),
  });

/** Resolve one allow-listed observation cadence without changing correctness timers. */
export function observationalIntervalMs(
  baseMs: number,
  profile: UiResourceProfile,
): number {
  const safeBaseMs = Math.max(1, Math.trunc(baseMs));
  return safeBaseMs * RESOURCE_PROFILE_POLICY[profile].observationalIntervalFactor;
}
