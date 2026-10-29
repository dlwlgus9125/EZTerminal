import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import {
  CLAUDE_DISCOUNT, CLAUDE_FORMAT, MIXED_REVIEW_ID, mixedSelfReview, otherAiReview, reviewerConversation, reviewPayload, withId,
} from '../review/review-fixtures';
import { buildChatModel } from './build-chat-model';
import { findRows, rowSearchText } from './find';
import type { ChatRow } from './types';

const AT = '2026-10-29T00:40:00.000Z';

function item(sequence: number, kind: DaemonTranscriptItem['kind'], text: string, overrides: Partial<DaemonTranscriptItem> = {}): DaemonTranscriptItem {
  return { id: `i${String(sequence)}`, sessionId: 's', sequence, kind, text, isDelta: false, isSensitive: false, createdAt: AT, ...overrides };
}

function turn(id: string, state: DaemonTurn['state']): DaemonTurn {
  return { id, sessionId: 's', commandId: `c-${id}`, state, revision: 1, createdAt: AT, updatedAt: AT, startedAt: AT };
}

const FORMAT = withId('r1', CLAUDE_FORMAT);
const DISCOUNT = withId('r1', CLAUDE_DISCOUNT);

function review(sequence: number, state: 'queued' | 'running' | 'complete', findings = [FORMAT, DISCOUNT], createdAt = AT): DaemonTranscriptItem {
  return item(sequence, 'notice', `Review (Claude) ${state}`, {
    createdAt,
    payload: reviewPayload({ reviewId: 'r1', reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, state, ...(state === 'complete' ? { findings } : {}) }),
  });
}

function reviewRows(rows: readonly ChatRow[]): Extract<ChatRow, { kind: 'review' }>[] {
  return rows.filter((row): row is Extract<ChatRow, { kind: 'review' }> => row.kind === 'review');
}

describe('review cards in the chat model', () => {
  it('keeps one card per review at its first row and shows its latest row', () => {
    const model = buildChatModel({
      items: [
        item(1, 'user-message', 'change prices', { turnId: 't1' }),
        review(2, 'queued'),
        item(3, 'assistant-message', 'done', { turnId: 't1' }),
        review(4, 'running', [], '2026-10-29T00:41:00.000Z'),
        review(5, 'complete'),
      ],
      turns: [turn('t1', 'completed')],
    });
    const cards = reviewRows(model.rows);
    expect(cards).toHaveLength(1);
    expect(model.rows.map((row) => row.kind)).toEqual(['user', 'turn-status', 'review', 'assistant']);
    expect(cards[0]!.id).toBe('review:r1');
    expect(cards[0]!.review.state).toBe('complete');
    expect(cards[0]!.review.findings.map((finding) => finding.status)).toEqual(['open', 'open']);
    // The elapsed clock starts at the first running row.
    expect(cards[0]!.review.startedAt).toBe('2026-10-29T00:41:00.000Z');
  });

  it('does not end the run of tool lines it is updated inside', () => {
    const model = buildChatModel({
      items: [
        review(1, 'running'),
        item(2, 'tool-call', 'Read', { turnId: 't1', payload: { v: 1, type: 'tool', callId: 'a', name: 'Read', category: 'read', phase: 'call', target: 'x.ts' } }),
        review(3, 'complete'),
        item(4, 'tool-call', 'Read', { turnId: 't1', payload: { v: 1, type: 'tool', callId: 'b', name: 'Read', category: 'read', phase: 'call', target: 'y.ts' } }),
      ],
    });
    expect(model.rows.map((row) => row.kind)).toEqual(['review', 'activity']);
    const activity = model.rows[1] as Extract<ChatRow, { kind: 'activity' }>;
    expect(activity.entries).toHaveLength(2);
  });

  it('leaves a running turn’s status after the turn when a card was asked for inside it', () => {
    const model = buildChatModel({
      items: [
        item(1, 'user-message', 'add tests', { turnId: 't2' }),
        review(2, 'queued'),
        item(3, 'assistant-message', 'adding cases…', { turnId: 't2', isDelta: true }),
      ],
      turns: [turn('t2', 'working')],
    });
    expect(model.rows.map((row) => row.kind)).toEqual(['user', 'review', 'assistant', 'turn-status']);
  });

  it('keeps showing rows without a review payload as before (old hosts)', () => {
    const model = buildChatModel({ items: [item(1, 'notice', 'Review (Claude): 2 problems — src/format.ts:2, src/discount.ts:4')] });
    expect(model.rows.map((row) => row.kind)).toEqual(['notice']);
  });

  it('applies the latest dismissal or reopening per finding and hides those rows', () => {
    const status = (sequence: number, state: 'dismissed' | 'open', ids = [DISCOUNT.id]): DaemonTranscriptItem =>
      item(sequence, 'notice', 'status', { payload: { v: 1, type: 'review-status', reviewId: 'r1', findingIds: ids, state } });
    const dismissed = buildChatModel({ items: [review(1, 'complete'), status(2, 'dismissed')] });
    expect(dismissed.rows).toHaveLength(1);
    expect(reviewRows(dismissed.rows)[0]!.review.findings.map((finding) => finding.status)).toEqual(['open', 'dismissed']);
    const reopened = buildChatModel({ items: [review(1, 'complete'), status(2, 'dismissed'), status(3, 'open')] });
    expect(reviewRows(reopened.rows)[0]!.review.findings.map((finding) => finding.status)).toEqual(['open', 'open']);
  });

  it('shows a fix turn as a chip and follows that turn for the fix state', () => {
    const fix = (sequence: number, turnId: string): DaemonTranscriptItem =>
      item(sequence, 'user-message', 'Fix only the review findings below…', { turnId, payload: { v: 1, type: 'review-fix', reviewId: 'r1', findingIds: [FORMAT.id] } });
    const states: [DaemonTurn['state'] | undefined, string][] = [
      ['queued', 'requested'], ['submitting', 'requested'], ['delivery-uncertain', 'requested'], ['working', 'fixing'], ['blocked', 'fixing'],
      ['completed', 'fixed'], ['failed', 'fix-stopped'], ['interrupted', 'fix-stopped'], [undefined, 'requested'],
    ];
    for (const [state, expected] of states) {
      const model = buildChatModel({ items: [review(1, 'complete'), fix(2, 'fix-turn')], turns: state ? [turn('fix-turn', state)] : [] });
      const card = reviewRows(model.rows)[0]!;
      expect(card.review.findings[0]!.status, String(state)).toBe(expected);
      expect(card.review.findings[0]!.fixTurnId).toBe('fix-turn');
      expect(card.review.findings[1]!.status).toBe('open');
      const user = model.rows.find((row) => row.kind === 'user');
      expect(user).toMatchObject({ origin: 'review-fix', review: { reviewId: 'r1', findingIds: [FORMAT.id] } });
    }
  });

  it('lets the latest event win between a fix and a dismissal', () => {
    const model = buildChatModel({
      items: [
        review(1, 'complete'),
        item(2, 'user-message', 'fix', { turnId: 'fix', payload: { v: 1, type: 'review-fix', reviewId: 'r1', findingIds: [DISCOUNT.id] } }),
        item(3, 'notice', 'status', { payload: { v: 1, type: 'review-status', reviewId: 'r1', findingIds: [DISCOUNT.id], state: 'dismissed' } }),
      ],
      turns: [turn('fix', 'interrupted')],
    });
    expect(reviewRows(model.rows)[0]!.review.findings[1]!.status).toBe('dismissed');
  });

  it('marks a finding stale when its file changes after the review, unless it is being fixed', () => {
    const fixture = mixedSelfReview(Date.parse(AT));
    const model = buildChatModel({ items: fixture.items, turns: fixture.turns });
    const card = reviewRows(model.rows).find((row) => row.review.reviewId === MIXED_REVIEW_ID)!;
    const byFile = Object.fromEntries(card.review.findings.map((finding) => [finding.file, finding]));
    expect(byFile['src/format.ts']).toMatchObject({ status: 'fixing' });
    expect(byFile['src/format.ts']!.stale).toBeUndefined();
    expect(byFile['src/discount.ts']).toMatchObject({ status: 'dismissed' });
    expect(byFile['src/discount.ts']!.stale).toBeUndefined();
    expect(byFile['src/cart.ts']).toMatchObject({ status: 'open', stale: true });
    // Its place is the first review row, before the later turns.
    const kinds = model.rows.map((row) => row.kind);
    expect(kinds.indexOf('review')).toBeLessThan(kinds.lastIndexOf('user'));
  });

  it('shows an other-AI reviewer request as a chip in the reviewer conversation', () => {
    const model = buildChatModel({ items: reviewerConversation() });
    expect(model.rows[0]).toMatchObject({ kind: 'user', origin: 'review-request', review: { target: { kind: 'base-branch', baseRef: 'main' }, focus: '금액 계산과 권한 검사' } });
  });

  it('makes findings searchable by place and title', () => {
    const model = buildChatModel({ items: otherAiReview().items });
    const card = reviewRows(model.rows)[0]!;
    expect(rowSearchText(card)).toContain('src/auth.ts:6 The access check is always true');
    expect(findRows(model.rows, 'always true')).toEqual([card.id]);
  });
});
