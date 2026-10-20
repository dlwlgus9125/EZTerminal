import { describe, expect, it } from 'vitest';

import {
  fileViewKind,
  formatReviewComments,
  isInsideWorkspace,
  lineRangeLabel,
  resolveWorkspacePath,
  samePath,
  type ReviewComment,
} from './results-format';

describe('review comments for the draft', () => {
  const comment = (overrides: Partial<ReviewComment>): ReviewComment => ({ id: 'c', path: 'src/app.ts', lines: '12-14', quote: ['+a', ' b'], text: 'Use a guard', ...overrides });

  it('formats a heading and one entry per comment, quoting the selected lines', () => {
    expect(formatReviewComments([comment({}), comment({ id: 'd', path: 'notes.md', lines: '', quote: ['+x'], text: '' })], 'ko')).toBe(
      '검토 의견 (2)\n- src/app.ts:12-14 — Use a guard\n  > +a\n  >  b\n- notes.md\n  > +x\n\n',
    );
    expect(formatReviewComments([comment({ text: 'two\nlines' })], 'en')).toContain('Review comments (1)\n- src/app.ts:12-14 — two lines');
    expect(formatReviewComments([], 'en')).toBe('');
  });

  it('quotes at most twelve lines per comment', () => {
    const text = formatReviewComments([comment({ quote: Array.from({ length: 20 }, (_, index) => `+${String(index)}`) })], 'en');
    expect(text.match(/ {2}> \+/gu)).toHaveLength(12);
    expect(text).toContain('…(+8)');
  });

  it('labels the new-side line range, or the old side for a pure removal, or nothing when unnumbered', () => {
    expect(lineRangeLabel([{ text: '+a', kind: 'add', after: 4 }, { text: ' b', kind: 'context', before: 3, after: 5 }])).toBe('4-5');
    expect(lineRangeLabel([{ text: '-a', kind: 'remove', before: 9 }])).toBe('−9');
    expect(lineRangeLabel([{ text: '+a', kind: 'add' }])).toBe('');
  });
});

describe('paths in the working folder', () => {
  it('makes relative paths absolute under the working folder and refuses escapes', () => {
    expect(resolveWorkspacePath('src/app.ts', 'C:\\work\\demo')).toBe('C:\\work\\demo\\src\\app.ts');
    expect(resolveWorkspacePath('./src/app.ts', '/home/me/demo/')).toBe('/home/me/demo/src/app.ts');
    expect(resolveWorkspacePath('C:\\other\\x.ts', 'C:\\work')).toBe('C:\\other\\x.ts');
    expect(resolveWorkspacePath('../secret.txt', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('~/x', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('src/app.ts')).toBeUndefined();
  });

  it('compares Windows paths regardless of separators and case', () => {
    expect(isInsideWorkspace('C:/Work/Demo/src/a.ts', 'c:\\work\\demo')).toBe(true);
    expect(isInsideWorkspace('C:\\work\\demo-other\\a.ts', 'C:\\work\\demo')).toBe(false);
    expect(samePath('<WORKSPACE>\\src\\app.ts', 'src/APP.ts')).toBe(true);
  });

  it('chooses a view by extension', () => {
    expect(fileViewKind('a/README.md')).toBe('markdown');
    expect(fileViewKind('report.HTML')).toBe('html');
    expect(fileViewKind('doc.pdf')).toBe('pdf');
    expect(fileViewKind('shot.png')).toBe('image');
    expect(fileViewKind('src/app.ts')).toBe('code');
  });
});
