// @vitest-environment jsdom

import { act, useCallback, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import { composeFixPrompt, type ReviewFinding } from '../../../shared/review-findings';
import { AppI18nProvider } from '../../i18n';
import { clearSessionViewStates } from '../../session-view-state';
import { ChatProvider, type ChatReviewAction, type ChatSkin } from '../ChatContext';
import { ChatRowView } from '../ChatRowView';
import { buildChatModel } from '../model/build-chat-model';
import type { ChatRow } from '../model/types';
import {
  applyReviewAction, CLAUDE_CART, CLAUDE_DISCOUNT, CLAUDE_FORMAT, CODEX_AUTH, CODEX_ITEM, CODEX_DISCOUNT, mixedSelfReview, queuedOtherReview,
  reviewPayload, truncatedReview, withId,
} from '../review/review-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const AT = '2026-10-29T00:40:00.000Z';
function item(sequence: number, kind: DaemonTranscriptItem['kind'], text: string, overrides: Partial<DaemonTranscriptItem> = {}): DaemonTranscriptItem {
  return { id: `i${String(sequence)}`, sessionId: 's', sequence, kind, text, isDelta: false, isSensitive: false, createdAt: AT, ...overrides };
}
function turn(id: string, state: DaemonTurn['state']): DaemonTurn {
  return { id, sessionId: 's', commandId: `c-${id}`, state, revision: 1, createdAt: AT, updatedAt: AT, startedAt: AT };
}

function show(list: readonly ChatRow[], onReviewAction?: (action: ChatReviewAction) => void, skin: ChatSkin = 'bubble'): void {
  act(() => root.render(
    <AppI18nProvider locale="ko" languages={['ko']}>
      <ChatProvider skin={skin} locale="ko" {...(onReviewAction ? { onReviewAction } : {})}>
        {list.map((row) => <ChatRowView key={row.id} row={row} providerLabel="Claude" />)}
      </ChatProvider>
    </AppI18nProvider>,
  ));
}

function byName(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name);
  if (!found) throw new Error(`no button "${name}": ${[...container.querySelectorAll('button')].map((element) => element.getAttribute('aria-label') ?? element.textContent).join(' | ')}`);
  return found;
}

/** Six problems, one in each state a fix can leave behind. */
function outcomes(): readonly ChatRow[] {
  const findings: ReviewFinding[] = [CLAUDE_FORMAT, CLAUDE_DISCOUNT, CLAUDE_CART, CODEX_AUTH, CODEX_DISCOUNT, CODEX_ITEM]
    .map((draft, index) => withId('r1', { ...draft, title: `${draft.title} (${String(index)})` }));
  const [fixed, notChanged, unconfirmed, fixing, dismissed] = findings;
  return buildChatModel({
    items: [
      item(1, 'notice', 'review', { payload: reviewPayload({ reviewId: 'r1', reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, state: 'complete', findings }) }),
      item(2, 'user-message', 'fix', { turnId: 'a', payload: { v: 1, type: 'review-fix', reviewId: 'r1', findingIds: [fixed!.id, notChanged!.id, unconfirmed!.id] } }),
      item(3, 'assistant-message', `${fixed!.id}: fixed\n${notChanged!.id}: not changed (callers already pass a fraction)`, { turnId: 'a' }),
      item(4, 'user-message', 'fix', { turnId: 'b', payload: { v: 1, type: 'review-fix', reviewId: 'r1', findingIds: [fixing!.id] } }),
      item(5, 'notice', 'dismissed', { payload: { v: 1, type: 'review-status', reviewId: 'r1', findingIds: [dismissed!.id], state: 'dismissed' } }),
    ],
    turns: [turn('a', 'completed'), turn('b', 'working')],
  }).rows;
}

describe('what a fix turn left behind', () => {
  it('counts only confirmed fixes as 고침 and shows the rest apart', () => {
    show(outcomes(), vi.fn());
    expect(container.querySelector('[data-testid="chat-review-counts"]')?.textContent).toBe('문제 6 · 고침 1 · 고치는 중 1 · 안 고침 1 · 확인 필요 1 · 무시 1');
    const statuses = [...container.querySelectorAll('.chat-review-status')].map((element) => element.textContent);
    expect(statuses).toEqual(expect.arrayContaining(['고침', '안 고침', '응답 끝 · 확인 필요', '고치는 중', '무시함']));
    expect(container.textContent).not.toContain('고침 끝');
  });

  it('says why the AI left a problem and offers to fix it again or dismiss it', () => {
    const onReviewAction = vi.fn();
    show(outcomes(), onReviewAction);
    const left = [...container.querySelectorAll<HTMLElement>('[data-testid="chat-review-finding"]')].find((element) => element.dataset.status === 'not-changed')!;
    expect(left.querySelector('.chat-review-finding__reason')?.textContent).toBe('이유: callers already pass a fraction');
    const again = [...left.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === '다시 고치기')!;
    expect(left.querySelector('[data-action="dismiss"]')).not.toBeNull();
    act(() => again.click());
    expect(onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix', findingIds: [expect.stringMatching(/^f-/u)] }));
  });
});

describe('모두 고치기 over the fix message limit', () => {
  it('offers the first batch that fits, names how many are left, and sends only those', () => {
    const onReviewAction = vi.fn();
    const fixture = truncatedReview();
    const list = buildChatModel({ items: fixture.items, turns: fixture.turns }).rows;
    const review = list.find((row): row is Extract<ChatRow, { kind: 'review' }> => row.kind === 'review')!.review;
    const prompt = composeFixPrompt({ reviewerLabel: 'Codex', findings: review.findings });
    expect(prompt.ok).toBe(false);
    const fits = prompt.ok ? review.findings.length : prompt.fits;
    expect(fits).toBeGreaterThan(0);
    show(list, onReviewAction);
    act(() => byName(`처음 ${String(fits)}개 고치기 · 나머지 ${String(review.findings.length - fits)}개`).click());
    expect(onReviewAction).toHaveBeenCalledWith({ kind: 'fix-all', reviewId: review.reviewId, findingIds: review.findings.slice(0, fits).map((finding) => finding.id) });
  });

  it('offers the next batch once the first was sent', () => {
    const onReviewAction = vi.fn();
    const fixture = truncatedReview();
    const reviewOf = (list: readonly ChatRow[]) => list.find((row): row is Extract<ChatRow, { kind: 'review' }> => row.kind === 'review')!.review;
    const findings = reviewOf(buildChatModel(fixture).rows).findings;
    const first = composeFixPrompt({ reviewerLabel: 'Codex', findings });
    const fits = first.ok ? findings.length : first.fits;
    const sent = applyReviewAction(fixture, { kind: 'fix-all', reviewId: fixture.reviewId, findingIds: findings.slice(0, fits).map((finding) => finding.id) }, Date.parse(AT));
    const rest = findings.slice(fits);
    const next = composeFixPrompt({ reviewerLabel: 'Codex', findings: rest });
    const batch = next.ok ? rest : rest.slice(0, next.fits);
    show(buildChatModel(sent).rows, onReviewAction);
    act(() => byName(next.ok ? `모두 고치기 (${String(rest.length)})` : `처음 ${String(next.fits)}개 고치기 · 나머지 ${String(rest.length - next.fits)}개`).click());
    expect(onReviewAction).toHaveBeenCalledWith({ kind: 'fix-all', reviewId: fixture.reviewId, findingIds: batch.map((finding) => finding.id) });
  });
});

describe('focus and announcements after a finding action', () => {
  function Host({ skin }: { readonly skin: ChatSkin }): JSX.Element {
    const [state, setState] = useState(() => { const fixture = mixedSelfReview(Date.parse(AT)); return { items: fixture.items, turns: fixture.turns }; });
    const onReviewAction = useCallback((action: ChatReviewAction) => setState((current) => applyReviewAction(current, action, Date.parse(AT))), []);
    const list = useMemo(() => buildChatModel(state).rows, [state]);
    return (
      <ChatProvider skin={skin} locale="ko" onReviewAction={onReviewAction}>
        {list.map((row) => <ChatRowView key={row.id} row={row} providerLabel="Claude" />)}
      </ChatProvider>
    );
  }
  async function frame(): Promise<void> {
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
  }

  for (const skin of ['bubble', 'cli'] as const) {
    it(`moves focus to the problem's title and announces the change once (${skin})`, async () => {
      act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}><Host skin={skin} /></AppI18nProvider>));
      const live = container.querySelector<HTMLElement>('[data-testid="chat-review-announce"]')!;
      expect(live.getAttribute('aria-live')).toBe('polite');
      expect(live.textContent).toBe('');
      act(() => byName('src/cart.ts:5 고치기').click());
      await frame();
      const finding = [...container.querySelectorAll<HTMLElement>('[data-testid="chat-review-finding"]')].find((element) => element.textContent?.includes('src/cart.ts:5') || element.querySelector('.chat-review-finding__title')?.textContent?.startsWith('The loop runs'))!;
      expect(document.activeElement).toBe(finding.querySelector('[data-finding-title]'));
      expect(live.textContent).toBe('src/cart.ts:5 · 고침 요청됨');
      act(() => byName('src/discount.ts:4 다시 열기').click());
      await frame();
      expect(live.textContent).toBe('src/discount.ts:4 · 다시 열림');
    });
  }
});

describe('a queued review', () => {
  it('says what it waits for', () => {
    const fixture = queuedOtherReview(Date.parse(AT));
    show(buildChatModel(fixture).rows, vi.fn());
    expect(container.textContent).toContain('응답이 끝나면 검토합니다.');
    const slot = fixture.items.map((entry) => (entry.payload?.type === 'review' ? { ...entry, payload: { ...entry.payload, waitingFor: 'slot' as const } } : entry));
    show(buildChatModel({ items: slot, turns: fixture.turns }).rows, vi.fn());
    expect(container.textContent).toContain('동시에 실행 중인 대화가 많아 차례를 기다립니다.');
  });
});
