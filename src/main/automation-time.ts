import { CronExpressionParser } from 'cron-parser';

import type { DaemonSnapshot } from '../shared/daemon-protocol';

/**
 * Time rules shared by the daemon's agent schedules and the workflow repeat schedules: IANA zones only, five-field
 * cron in that zone (cron-parser's DST handling), and automation only while the app keeps running from login.
 */
export class AutomationInputError extends Error {}

export interface CanonicalCron {
  readonly cron: string;
  readonly timezone: string;
  readonly nextRunAt: string;
}

export function canonicalTimezone(value: string): string {
  const timezone = value.trim();
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
    if (/^[+-]/u.test(canonical)) throw new Error('fixed offsets are not IANA zones');
    return canonical;
  } catch {
    throw new AutomationInputError(`Timezone ${JSON.stringify(value)} is not a supported IANA timezone.`);
  }
}

export function canonicalCron(
  expression: string,
  timezoneValue: string,
  after: Date,
  hashSeed: string,
): CanonicalCron {
  const normalized = expression.trim().replace(/\s+/gu, ' ');
  if (normalized.split(' ').length !== 5) {
    throw new AutomationInputError('Automation cron expressions must contain exactly five fields.');
  }
  const timezone = canonicalTimezone(timezoneValue);
  try {
    const parsed = CronExpressionParser.parse(normalized, {
      currentDate: after,
      tz: timezone,
      hashSeed,
    });
    return {
      cron: parsed.stringify(false),
      timezone,
      nextRunAt: parsed.next().toDate().toISOString(),
    };
  } catch (error) {
    throw new AutomationInputError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function automationEnabled(snapshot: Pick<DaemonSnapshot, 'runtime'>): boolean {
  return snapshot.runtime.keepRunning && snapshot.runtime.startAtLogin;
}
