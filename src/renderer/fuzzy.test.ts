import { describe, expect, it } from 'vitest';

import { subsequenceMatch } from './fuzzy';

describe('subsequenceMatch', () => {
  it('matches when the query characters appear in order, non-contiguously', () => {
    expect(subsequenceMatch('Split right', 'spr')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(subsequenceMatch('Split right', 'SPR')).toBe(true);
    expect(subsequenceMatch('SPLIT RIGHT', 'spr')).toBe(true);
  });

  it('rejects characters out of order or missing', () => {
    expect(subsequenceMatch('Split right', 'rps')).toBe(false);
    expect(subsequenceMatch('Split down', 'spr')).toBe(false);
  });

  it('treats an empty query as matching everything', () => {
    expect(subsequenceMatch('anything', '')).toBe(true);
    expect(subsequenceMatch('', '')).toBe(true);
  });

  it('rejects a non-empty query against empty text', () => {
    expect(subsequenceMatch('', 'a')).toBe(false);
  });

  it('matches a full exact substring', () => {
    expect(subsequenceMatch('Apply preset: work', 'Apply preset: work')).toBe(true);
  });
});
