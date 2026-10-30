import { describe, expect, it } from 'vitest';

import type { SuggestedTaskOutcome, SuggestedTaskState } from '../../../shared/turn-wrap-up';
import { chatCopy } from '../copy';
import { aiLines, outcomeText, taskCountText } from './wrap-up-presentation';

const ko = chatCopy('ko');
const en = chatCopy('en');
const start = { where: { kind: 'new-worktree', branch: 'suggest/fix-auth' }, settings: 'Claude · Opus 5.5' } as const;

function tasks(outcomes: readonly SuggestedTaskOutcome[]): SuggestedTaskState[] {
  return outcomes.map((outcome, index) => ({ id: String(index), title: 'Task', rationale: 'Why', prompt: 'Do it', outcome }));
}

describe('taskCountText', () => {
  it('stays a plain count until something came of a task', () => {
    expect(taskCountText(tasks([{ kind: 'open' }, { kind: 'open' }]), ko)).toBe('2개');
    expect(taskCountText(tasks([{ kind: 'starting' }, { kind: 'sending' }]), en)).toBe('2');
  });

  it('counts sent, queued and failed apart: a queued instruction was not sent yet', () => {
    const all = tasks([
      { kind: 'started', sessionId: 'child' },
      { kind: 'sent' },
      { kind: 'queued', position: 2 },
      { kind: 'dismissed' },
      { kind: 'start-failed', reason: 'No space', start },
    ]);
    expect(taskCountText(all, ko)).toBe('5개 · 시작함 1 · 이 대화에 보냄 1 · 대기열 1 · 무시 1 · 시작 실패 1');
    expect(taskCountText(all, en)).toBe('5 · 1 started · 1 sent here · 1 queued · 1 dismissed · 1 failed to start');
  });
});

describe('outcomeText', () => {
  it('says where a failed start tried', () => {
    expect(outcomeText({ kind: 'start-failed', reason: 'No space', start }, ko)).toBe('시작하지 못함 · 새 워크트리 suggest/fix-auth');
    expect(outcomeText({ kind: 'start-failed', reason: 'Limit', start: { ...start, where: { kind: 'this-folder' } } }, ko)).toBe('시작하지 못함');
  });
});

describe('aiLines', () => {
  it('keeps the AI’s lines and drops only its list markers', () => {
    expect(aiLines('- first `code`\n* second\n\n1. third  \nfourth')).toEqual(['first `code`', 'second', 'third', 'fourth']);
  });
});
