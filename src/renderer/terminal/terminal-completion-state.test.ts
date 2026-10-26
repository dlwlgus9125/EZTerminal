import { describe, expect, it } from 'vitest';

import type { TerminalCompletionResult } from '../../shared/terminal-completion';
import { applyCompletion, chooseCandidate, moveActive, wantsCompletion } from './terminal-completion-state';

const result = (overrides: Partial<Extract<TerminalCompletionResult, { ok: true }>> = {}): TerminalCompletionResult => ({
  ok: true, replaceStart: 3, replaceEnd: 5, commonText: 'sr', truncated: false,
  candidates: [{ label: 'src\\', kind: 'directory', insertText: 'src\\' }],
  ...overrides,
});

describe('wantsCompletion', () => {
  it('completes only right after a word', () => {
    expect(wantsCompletion('cd sr', 5)).toBe(true);
    expect(wantsCompletion('cd ', 3)).toBe(false);
    expect(wantsCompletion('', 0)).toBe(false);
    expect(wantsCompletion('cd sr', 0)).toBe(false);
  });
});

describe('applyCompletion', () => {
  it('fills a single candidate in and keeps the text after the caret', () => {
    const line = { line: 'cd sr && ls', caret: 5 };
    expect(applyCompletion(line, line, result())).toEqual({ edit: { line: 'cd src\\ && ls', caret: 7 }, list: null });
  });

  it('fills the shared part of several and opens the list from there', () => {
    const line = { line: 'cat s', caret: 5 };
    const answer = result({ replaceStart: 4, replaceEnd: 5, commonText: 'sc', candidates: [
      { label: 'scripts\\', kind: 'directory', insertText: 'scripts\\' },
      { label: 'scratch.txt', kind: 'file', insertText: 'scratch.txt ' },
    ] });
    const applied = applyCompletion(line, line, answer);
    expect(applied.edit).toEqual({ line: 'cat sc', caret: 6 });
    expect(applied.list).toMatchObject({ active: 0, replaceStart: 4, replaceEnd: 6 });
    expect(chooseCandidate('cat sc', applied.list!, 1)).toEqual({ line: 'cat scratch.txt ', caret: 16 });
  });

  it('only lists when there is no shared part beyond what was typed', () => {
    const line = { line: 'g', caret: 1 };
    const applied = applyCompletion(line, line, result({ replaceStart: 0, replaceEnd: 1, commonText: 'g', candidates: [
      { label: 'gh', kind: 'executable', insertText: 'gh ' }, { label: 'git', kind: 'executable', insertText: 'git ' },
    ] }));
    expect(applied.edit).toBeNull();
    expect(applied.list?.replaceEnd).toBe(1);
  });

  it('leaves the caret inside a quoted folder and replaces through its closing quote next time', () => {
    const line = { line: 'cd Pro', caret: 6 };
    const first = applyCompletion(line, line, result({
      replaceStart: 3, replaceEnd: 6, commonText: '"Program Files\\\\"', commonCaretBack: 1,
      candidates: [{ label: 'Program Files\\', kind: 'directory', insertText: '"Program Files\\\\"', caretBack: 1 }],
    }));
    expect(first.edit).toEqual({ line: 'cd "Program Files\\\\"', caret: 19 });
    // Several matches inside it: the shared part closes the quote, a chosen one replaces all of it.
    const inside = { line: 'cd "Program Files\\\\"', caret: 19 };
    const second = applyCompletion(inside, inside, result({
      replaceStart: 3, replaceEnd: 20, commonText: '"Program Files\\\\T"', commonCaretBack: 1, candidates: [
        { label: 'Tool\\', kind: 'directory', insertText: '"Program Files\\\\Tool\\\\"', caretBack: 1 },
        { label: 'Tests\\', kind: 'directory', insertText: '"Program Files\\\\Tests\\\\"', caretBack: 1 },
      ],
    }));
    expect(second.edit).toEqual({ line: 'cd "Program Files\\\\T"', caret: 20 });
    expect(chooseCandidate(second.edit!.line, second.list!, 0)).toEqual({ line: 'cd "Program Files\\\\Tool\\\\"', caret: 25 });
  });

  it('ignores an answer for a line or caret that moved, and a refusal', () => {
    expect(applyCompletion({ line: 'cd sr', caret: 5 }, { line: 'cd src', caret: 6 }, result())).toEqual({ edit: null, list: null });
    expect(applyCompletion({ line: 'cd sr', caret: 5 }, { line: 'cd sr', caret: 5 }, { ok: false, reason: 'busy' })).toEqual({ edit: null, list: null });
  });
});

describe('moveActive', () => {
  it('wraps around both ways', () => {
    const list = {
      candidates: [{ label: 'a', kind: 'file' as const, insertText: 'a ' }, { label: 'b', kind: 'file' as const, insertText: 'b ' }],
      active: 0, replaceStart: 0, replaceEnd: 0, truncated: false,
    };
    expect(moveActive(list, -1).active).toBe(1);
    expect(moveActive(moveActive(list, 1), 1).active).toBe(0);
  });
});
