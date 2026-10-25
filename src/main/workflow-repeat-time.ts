import { createHash } from 'node:crypto';

import type { WorkflowRepeat } from '../shared/workflow';
import { canonicalCron } from './automation-time';

/** The repeat as a five-field cron in its zone (cron-parser applies the zone's DST rules). */
export function repeatCron(repeat: Pick<WorkflowRepeat, 'cadence' | 'weekday' | 'time'>): string {
  const [hours, minutes] = repeat.time.split(':').map(Number);
  return `${minutes} ${hours} * * ${repeat.cadence === 'weekly' ? repeat.weekday : '*'}`;
}

/**
 * The first occurrence strictly after `after`, as the real instant: a time a spring-forward skips moves to the
 * zone's next valid time (02:30 → 03:30), and a time a fall-back repeats runs once (its first instant).
 */
export function nextRepeatAt(repeat: WorkflowRepeat, after: Date): Date {
  return new Date(canonicalCron(repeatCron(repeat), repeat.timezone, after, 'workflow-repeat').nextRunAt);
}

/** The local date (YYYY-MM-DD) an occurrence belongs to: a flow runs at most once per local day. */
export function occurrenceKey(repeat: Pick<WorkflowRepeat, 'timezone'>, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: repeat.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Changes exactly when what decides the occurrences changes (turning it back on re-arms it too: see WorkflowRepeatService). */
export function repeatConfigDigest(repeat: WorkflowRepeat): string {
  return createHash('sha256').update(JSON.stringify([repeat.cadence, repeat.weekday ?? null, repeat.time, repeat.timezone])).digest('hex').slice(0, 32);
}
