import { describe, expect, it } from 'vitest';

import { readXtermText } from './xterm-text';

const buffer = (rows: ReadonlyArray<string | [string, boolean]>) => ({
  length: rows.length,
  getLine: (index: number) => {
    const row = rows[index];
    if (row === undefined) return undefined;
    const [text, isWrapped] = typeof row === 'string' ? [row, false] : row;
    return { translateToString: () => text, isWrapped };
  },
});

describe('readXtermText', () => {
  it('joins rows, merges soft-wrapped rows and drops trailing blank rows', () => {
    expect(readXtermText(buffer(['a', 'long li', ['ne', true], '', '']))).toBe('a\nlong line');
  });

  it('reads only the newest rows', () => {
    expect(readXtermText(buffer(['1', '2', '3', '4']), 2)).toBe('3\n4');
  });
});
