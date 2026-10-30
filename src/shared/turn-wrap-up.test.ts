import { describe, expect, it } from 'vitest';

import { parseTranscriptPayload } from './transcript-payload';
import {
  DEFAULT_TURN_WRAP_UP_SETTINGS, nextPromptText, NEXT_PROMPT_MAX_CHARS, parseTurnWrapUpSettings, RECAP_INSTRUCTION, recapQuestion, recapStoppedNote,
  suggestedTaskBranch, suggestedTaskBranches, TASK_SUGGESTION_LIMITS, TURN_RECAP_LIMITS,
} from './turn-wrap-up';

describe('recap prompt', () => {
  it('scopes the recap to the latest request and forbids claims that did not happen', () => {
    expect(RECAP_INSTRUCTION).toMatch(/latest request/u);
    expect(RECAP_INSTRUCTION).toMatch(/never claim an action, file change or test that did not happen/u);
  });

  it('asks the plain instruction at a turn’s end, and says what is open first when the turn stopped', () => {
    expect(recapQuestion()).toBe(RECAP_INSTRUCTION);
    const waiting = 'an approval for a file change to src/cart.ts.';
    const stopped = recapQuestion(waiting);
    expect(stopped.startsWith(recapStoppedNote(waiting))).toBe(true);
    expect(stopped.endsWith(RECAP_INSTRUCTION)).toBe(true);
    // Without the note Codex reports the stopped turn as aborted (probe P5).
    expect(stopped).toMatch(/not finished: an approval for a file change to src\/cart\.ts\. It is still open/u);
    expect(stopped).toMatch(/nothing was aborted/u);
  });
});

describe('nextPromptText', () => {
  it('keeps one line as the composer shows it', () => {
    expect(nextPromptText('  Add a unit test for formatPrice.\n')).toBe('Add a unit test for formatPrice.');
    expect(nextPromptText('Run the tests\n\nThen commit')).toBe('Run the tests');
    expect(nextPromptText('음수 금액도 괄호로 표시해 주세요')).toBe('음수 금액도 괄호로 표시해 주세요');
  });

  it('reads no suggestion from the AI’s "(none)", from nothing, and from an answer too long to be a next message', () => {
    for (const text of ['(none)', ' (None) ', '(none).', 'none', '', '   \n ', null, undefined, 'x'.repeat(NEXT_PROMPT_MAX_CHARS + 1)]) {
      expect(nextPromptText(text), String(text)).toBeUndefined();
    }
    expect(nextPromptText('x'.repeat(NEXT_PROMPT_MAX_CHARS))).toHaveLength(NEXT_PROMPT_MAX_CHARS);
    // A real next message that merely starts with the word stays.
    expect(nextPromptText('None of those, try again')).toBe('None of those, try again');
  });
});

describe('turn wrap-up transcript payloads', () => {
  const recap = { v: 1, type: 'recap', turnId: 't1', providerId: 'claude', trigger: 'unattended', state: 'complete', text: 'Changed src/cart.ts.' } as const;
  const task = { v: 1, type: 'task-suggestion', taskId: 'task-1', turnId: 't1', providerId: 'codex', title: 'Fix the role check', rationale: 'It is always true.', prompt: 'Fix src/auth.ts.' } as const;
  const start = {
    where: { kind: 'new-worktree', branch: 'suggest/fix-the-role-check', workspaceId: 'ws-1' },
    agent: { providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard' },
    settings: 'Claude · Opus 5.5 · 높음 · 승인 후 실행',
  } as const;

  it('reads a recap in each state, and a stopped one with what it waits on', () => {
    expect(parseTranscriptPayload(recap)).toEqual(recap);
    const empty = { v: 1, type: 'recap', turnId: 't1', providerId: 'claude', trigger: 'unattended' } as const;
    expect(parseTranscriptPayload({ ...empty, state: 'generating' })).toMatchObject({ state: 'generating' });
    expect(parseTranscriptPayload({ ...recap, trigger: 'waiting', waiting: 'approval', decisionId: 'approval-1' })).toMatchObject({ waiting: 'approval', decisionId: 'approval-1' });
    expect(parseTranscriptPayload({ ...empty, state: 'failed', failure: 'usage-limit' })).toMatchObject({ failure: 'usage-limit' });
  });

  it('holds recaps and tasks to the shared limits', () => {
    expect(parseTranscriptPayload({ ...recap, text: 'x'.repeat(TURN_RECAP_LIMITS.text) })).toBeDefined();
    expect(parseTranscriptPayload({ ...recap, text: 'x'.repeat(TURN_RECAP_LIMITS.text + 1) })).toBeUndefined();
    expect(parseTranscriptPayload(task)).toEqual(task);
    expect(parseTranscriptPayload({ ...task, worktree: true })).toMatchObject({ worktree: true });
    for (const field of ['title', 'prompt', 'rationale'] as const) {
      expect(parseTranscriptPayload({ ...task, [field]: 'x'.repeat(TASK_SUGGESTION_LIMITS[field] + 1) }), field).toBeUndefined();
    }
    expect(parseTranscriptPayload({ ...task, surprise: 1 })).toBeUndefined();
    expect(parseTranscriptPayload({ ...recap, trigger: 'someday' })).toBeUndefined();
  });

  it('keeps what a started task became and what a refused start asked for', () => {
    const status = { v: 1, type: 'task-suggestion-status', taskId: 'task-1', turnId: 't1' } as const;
    expect(parseTranscriptPayload({ ...status, outcome: 'dismissed' })).toMatchObject({ outcome: 'dismissed' });
    expect(parseTranscriptPayload({ ...status, outcome: 'open' })).toMatchObject({ outcome: 'open' });
    expect(parseTranscriptPayload({ ...status, outcome: 'started', sessionId: 'agent-child', branch: 'suggest/fix' }))
      .toMatchObject({ sessionId: 'agent-child', branch: 'suggest/fix' });
    // 다시 시도 repeats exactly what was asked: the where, the four settings and their words.
    const failed = { ...status, outcome: 'start-failed', reason: 'Child rate limit.', start, branchTaken: true };
    expect(parseTranscriptPayload(failed)).toEqual(failed);
    expect(parseTranscriptPayload({ ...failed, start: { ...start, where: { kind: 'this-folder', branch: 'x' } } })).toBeUndefined();
    expect(parseTranscriptPayload({ ...status, outcome: 'queued' })).toBeUndefined();
  });

  it('counts the calls past the cap and marks the user row of a task sent here', () => {
    expect(parseTranscriptPayload({ v: 1, type: 'task-suggestions-dropped', turnId: 't1', count: 3 })).toMatchObject({ count: 3 });
    expect(parseTranscriptPayload({ v: 1, type: 'task-suggestions-dropped', turnId: 't1', count: -1 })).toBeUndefined();
    expect(parseTranscriptPayload({ v: 1, type: 'task-suggestion-send', taskId: 'task-1', turnId: 't1' })).toMatchObject({ taskId: 'task-1' });
  });
});

describe('parseTurnWrapUpSettings', () => {
  it('accepts exactly the settings, and refuses anything else', () => {
    expect(parseTurnWrapUpSettings(DEFAULT_TURN_WRAP_UP_SETTINGS)).toEqual(DEFAULT_TURN_WRAP_UP_SETTINGS);
    for (const value of [null, {}, { ...DEFAULT_TURN_WRAP_UP_SETTINGS, recaps: 'yes' }, { ...DEFAULT_TURN_WRAP_UP_SETTINGS, surprise: true },
      { ...DEFAULT_TURN_WRAP_UP_SETTINGS, suggestions: { claude: true } }]) {
      expect(parseTurnWrapUpSettings(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

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
