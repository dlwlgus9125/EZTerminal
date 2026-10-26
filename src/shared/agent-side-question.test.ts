import { describe, expect, it } from 'vitest';
import {
  AgentSideQuestionRequestSchema,
  AgentSideQuestionResultSchema,
  boundedSideQuestionHistory,
  SIDE_QUESTION_HISTORY_LIMIT,
  SIDE_QUESTION_HISTORY_MAX_CHARS,
  SIDE_QUESTION_MAX_QUESTION_CHARS,
} from './agent-side-question';

const request = { requestId: 'r1', sessionId: 's1', question: 'what file was that?', history: [] };

describe('agent side question contract', () => {
  it('accepts a bounded request and rejects extra keys, blank and oversized questions', () => {
    expect(AgentSideQuestionRequestSchema.safeParse(request).success).toBe(true);
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, question: '   ' }).success).toBe(false);
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, question: 'x'.repeat(SIDE_QUESTION_MAX_QUESTION_CHARS + 1) }).success).toBe(false);
  });

  it('rejects a history over the count or the size budget', () => {
    const entry = { question: 'q', answer: 'a' };
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, history: Array(SIDE_QUESTION_HISTORY_LIMIT).fill(entry) }).success).toBe(true);
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, history: Array(SIDE_QUESTION_HISTORY_LIMIT + 1).fill(entry) }).success).toBe(false);
    const big = { question: 'q', answer: 'a'.repeat(19_000) };
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, history: Array(7).fill(big) }).success).toBe(false);
  });

  it('keeps the newest exchanges that fit', () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({ question: `q${index}`, answer: 'a' }));
    const bounded = boundedSideQuestionHistory(entries);
    expect(bounded).toHaveLength(SIDE_QUESTION_HISTORY_LIMIT);
    expect(bounded[0]?.question).toBe('q5');
    const large = Array.from({ length: 8 }, (_, index) => ({ question: `q${index}`, answer: 'a'.repeat(19_000) }));
    const trimmed = boundedSideQuestionHistory(large);
    expect(trimmed.at(-1)?.question).toBe('q7');
    expect(trimmed.reduce((total, entry) => total + entry.question.length + entry.answer.length, 0)).toBeLessThanOrEqual(SIDE_QUESTION_HISTORY_MAX_CHARS);
    expect(AgentSideQuestionRequestSchema.safeParse({ ...request, history: trimmed }).success).toBe(true);
  });

  it('validates results without free-form error text', () => {
    expect(AgentSideQuestionResultSchema.safeParse({ ok: true, answer: 'config.ts', synthetic: false }).success).toBe(true);
    expect(AgentSideQuestionResultSchema.safeParse({ ok: true, answer: null, synthetic: false }).success).toBe(true);
    expect(AgentSideQuestionResultSchema.safeParse({ ok: false, code: 'timeout' }).success).toBe(true);
    expect(AgentSideQuestionResultSchema.safeParse({ ok: false, code: 'timeout', message: 'echo' }).success).toBe(false);
    expect(AgentSideQuestionResultSchema.safeParse({ ok: false, code: 'other' }).success).toBe(false);
  });
});
