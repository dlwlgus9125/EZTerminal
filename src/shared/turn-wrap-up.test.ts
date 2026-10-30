import { describe, expect, it } from 'vitest';

import { suggestedTaskBranch, suggestedTaskBranches } from './turn-wrap-up';

describe('suggestedTaskBranch', () => {
  // Titles as Claude and Codex wrote them in the 2026-10-30 probes.
  it('names a branch from the title words, short and without a dangling filler word', () => {
    expect(suggestedTaskBranch('Fix the always-true role check in src/auth.ts', 0)).toBe('suggest/fix-the-always-true-role-check');
    expect(suggestedTaskBranch('Fix percentage math in applyDiscount (src/discount.ts)', 1)).toBe('suggest/fix-percentage-math');
    expect(suggestedTaskBranch('Fix cents conversion in src/format.ts', 2)).toBe('suggest/fix-cents-conversion-in-format');
    expect(suggestedTaskBranch('Correct percentage calculation in src/discount.ts', 0)).toBe('suggest/correct-percentage-calculation');
    // A path reads as its file's name.
    expect(suggestedTaskBranch('Fix logic bugs in src/auth.ts, src/format.ts, and src/discount.ts', 0)).toBe('suggest/fix-logic-bugs-in-auth-format');
  });

  it('stays a valid branch name for any title', () => {
    for (const title of ['음수 금액을 괄호로 표시', '', '!!!', 'A'.repeat(300), 'fix: auth/role (v2) — now']) {
      expect(suggestedTaskBranch(title, 4)).toMatch(/^suggest\/[a-z0-9-]{1,32}$/u);
    }
    expect(suggestedTaskBranch('음수 금액을 괄호로 표시', 4)).toBe('suggest/task-5');
  });

  it('keeps the names of one batch distinct', () => {
    expect(suggestedTaskBranches(['Fix the auth check', 'Fix the auth check', '할인 계산'])).toEqual([
      'suggest/fix-the-auth-check', 'suggest/fix-the-auth-check-2', 'suggest/task-3',
    ]);
  });
});
