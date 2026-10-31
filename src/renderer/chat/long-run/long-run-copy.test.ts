import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { chatCopy } from '../copy';

/** Every string the long-run copy says, with sample arguments for the ones that are functions. */
function strings(value: unknown, path = 'longRun'): readonly (readonly [string, string])[] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') return [[path, String((value as (...args: unknown[]) => unknown)('A', 'B'))]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => strings(entry, `${path}.${key}`));
  return [];
}

const all = (locale: 'ko' | 'en'): readonly (readonly [string, string])[] => strings(chatCopy(locale).longRun);
const settings = readFileSync(resolve(process.cwd(), 'src/renderer/LongRunSettings.tsx'), 'utf8');
const LIFTED = /풀립|풀려|풀렸|풀림|풀리기|풀리면|풀리는|lifted|lifts/iu;

describe('long-run wording', () => {
  it('never says a limit has lifted: nothing signals it, so it is an expected time', () => {
    for (const locale of ['ko', 'en'] as const) for (const [path, text] of all(locale)) expect(text, `${locale} ${path}`).not.toMatch(LIFTED);
    expect(settings).not.toMatch(LIFTED);
  });

  it('never words a resume as a guarantee', () => {
    const ko = chatCopy('ko').longRun.limit;
    expect(ko.resumesAt('15:12')).toContain('시도');
    expect(ko.retry('15:22')).toContain('시도');
    const en = chatCopy('en').longRun.limit;
    expect(en.resumesAt('15:12').toLowerCase()).toContain('try');
    expect(en.retry('15:22').toLowerCase()).toContain('try');
  });

  it('says which app it means where a phone could read it as itself', () => {
    expect(chatCopy('ko').longRun.limit.reopened('15:10')).toContain('PC 앱');
    expect(chatCopy('ko').longRun.limit.reopenedWhy).toContain('PC 앱');
    expect(chatCopy('en').longRun.limit.reopened('15:10')).toContain('PC app');
  });

  it('tells a screen at the scheduled time apart from a confirmed lift', () => {
    expect(chatCopy('ko').longRun.appSent.why['scheduled-time']).toBe('앱이 보냄 · 예약 시각이 되어');
    expect(chatCopy('en').longRun.appSent.why['scheduled-time']).toBe('Sent by the app · at the scheduled time');
  });
});
