import { RESUME_TIMING } from '../shared/long-run';

/** What the coordinator waits. The 6-hour rule is not one of them: a spec controls the reset it reports instead. */
export type ResumeTiming = { readonly [K in 'afterResetMs' | 'retryAfterRefusalMs' | 'lineGapMs']: number };

const NAMES = ['afterResetMs', 'retryAfterRefusalMs', 'lineGapMs'] as const;

/**
 * `EZTERMINAL_E2E_LONG_RUN_TIMING`: shorter waits, so a spec need not sit through the real ones. A packaged app ignores
 * it: the waits are what the card promises a person, and only a test may run on another clock.
 */
export function e2eResumeTiming(packaged: boolean, value: string | undefined): ResumeTiming | undefined {
  if (packaged || !value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  const valid = entries.every(([name, wait]) => (NAMES as readonly string[]).includes(name) && typeof wait === 'number' && Number.isFinite(wait) && wait >= 0);
  return valid ? { afterResetMs: RESUME_TIMING.afterResetMs, retryAfterRefusalMs: RESUME_TIMING.retryAfterRefusalMs, lineGapMs: RESUME_TIMING.lineGapMs, ...Object.fromEntries(entries) } : undefined;
}
