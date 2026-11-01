import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { e2eResumeTiming } from './long-run-timing';

describe('the waits a spec may shorten', () => {
  it('a packaged app ignores them: a person never runs on a test\'s clock', () => {
    expect(e2eResumeTiming(true, JSON.stringify({ afterResetMs: 10 }))).toBeUndefined();
  });

  it('main hands over whether it is packaged, so that rule is the one that runs', () => {
    const main = readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
    expect(main).toContain('e2eResumeTiming(app.isPackaged, process.env.EZTERMINAL_E2E_LONG_RUN_TIMING)');
  });

  it('nothing set leaves the decided waits', () => {
    expect(e2eResumeTiming(false, undefined)).toBeUndefined();
    expect(e2eResumeTiming(false, '')).toBeUndefined();
  });

  it('takes the waits it names', () => {
    expect(e2eResumeTiming(false, JSON.stringify({ afterResetMs: 500, retryAfterRefusalMs: 1_500, lineGapMs: 3_000 }))).toEqual({ afterResetMs: 500, retryAfterRefusalMs: 1_500, lineGapMs: 3_000 });
  });

  it('keeps the decided value of a wait it does not name', () => {
    expect(e2eResumeTiming(false, JSON.stringify({ afterResetMs: 500 }))).toEqual({ afterResetMs: 500, retryAfterRefusalMs: 600_000, lineGapMs: 60_000 });
  });

  it.each([
    ['not JSON', 'soon'],
    ['not an object', '[1]'],
    ['a wait that is not a number', JSON.stringify({ afterResetMs: '500' })],
    ['a negative wait', JSON.stringify({ lineGapMs: -1 })],
    ['a wait it does not know', JSON.stringify({ autoWithinMs: 1 })],
  ])('drops %s rather than guess', (_name, value) => {
    expect(e2eResumeTiming(false, value)).toBeUndefined();
  });
});
