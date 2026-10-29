import { describe, expect, it } from 'vitest';

import type { RecordedFileChange } from '../../shared/conversation-changes';
import {
  fileViewKind,
  formatReviewComments,
  isInsideWorkspace,
  lineRangeLabel,
  locateFinding,
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

  it('never resolves a network share, device or drive-relative path, so viewing cannot reach another machine', () => {
    expect(resolveWorkspacePath('\\\\attacker\\share\\x.md', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('//attacker/share/x.md', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('\\\\?\\C:\\work\\x.md', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('\\\\.\\pipe\\x', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('C:x.md', 'C:\\work')).toBeUndefined();
    expect(resolveWorkspacePath('/\\attacker/x', '/home')).toBeUndefined();
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

describe('where a review problem is in a recorded patch', () => {
  // The cart file as the review read it: line 5 is the loop it flagged (with a line of context each side).
  const EXCERPT = { startLine: 4, lines: ['  let total = 0;', '  for (let index = 0; index <= items.length; index += 1) {', '    total += items[index].price;'] } as const;
  const finding = { line: 5, endLine: 5, excerpt: EXCERPT };
  const patch = (body: string): RecordedFileChange => ({ path: 'C:\\Work\\cart-kit\\src\\cart.ts', patch: body, coverage: 'patch' });

  it('finds the line where the review read it', () => {
    const change = patch('@@ -3,4 +3,4 @@\n export function cartTotal(items) {\n   let total = 0;\n-  for (const item of items) {\n+  for (let index = 0; index <= items.length; index += 1) {\n     total += items[index].price;');
    expect(locateFinding(change, finding)).toEqual({ state: 'found', index: 4 });
  });

  it('follows the lines when they moved since the review', () => {
    const change = patch('@@ -1,5 +1,7 @@\n+// Totals in cents.\n+\n import { Item } from "./item";\n \n export function cartTotal(items) {\n   let total = 0;\n   for (let index = 0; index <= items.length; index += 1) {');
    expect(locateFinding(change, { ...finding, excerpt: { startLine: 4, lines: EXCERPT.lines.slice(0, 2) } })).toMatchObject({ state: 'found', moved: 7 });
  });

  it('never puts the problem on whatever code holds its old line number now', () => {
    // A later edit rewrote the loop: line 5 now holds other code, and the review's lines are nowhere in the patch.
    const change = patch('@@ -4,3 +4,3 @@\n   let total = 0;\n-  for (let index = 0; index <= items.length; index += 1) {\n-    total += items[index].price;\n+  for (const item of items) {\n+    total += item.price;');
    expect(locateFinding(change, finding)).toEqual({ state: 'missing' });
  });

  it('says the line is outside the patch when the patch does not show it', () => {
    const change = patch('@@ -20,2 +20,2 @@\n-export const VERSION = 1;\n+export const VERSION = 2;\n export default cartTotal;');
    expect(locateFinding(change, finding)).toEqual({ state: 'outside' });
  });

  it('anchors on the line number alone when the review kept no lines to check', () => {
    const change = patch('@@ -4,2 +4,2 @@\n   let total = 0;\n-  for (const item of items) {\n+  for (let index = 0; index <= items.length; index += 1) {');
    expect(locateFinding(change, { line: 5, endLine: 5 })).toEqual({ state: 'found', index: 3 });
    expect(locateFinding(change, { line: 9 })).toEqual({ state: 'outside' });
  });
});
