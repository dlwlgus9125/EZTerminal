// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../i18n';
import { clearSessionViewStates } from '../../session-view-state';
import { ChatProvider, type ChatReviewAction, type ChatSkin } from '../ChatContext';
import { ChatRowView } from '../ChatRowView';
import { buildChatModel } from '../model/build-chat-model';
import type { ChatRow } from '../model/types';
import {
  failedReview, mixedSelfReview, MIXED_REVIEW_ID, queuedOtherReview, unsupportedReview, type ReviewFixture,
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

const NOW = Date.parse('2026-10-29T00:50:00.000Z');

function rows(fixture: ReviewFixture): readonly ChatRow[] {
  return buildChatModel({ items: fixture.items, turns: fixture.turns }).rows;
}

function render(list: readonly ChatRow[], { skin = 'bubble', onReviewAction }: { readonly skin?: ChatSkin; readonly onReviewAction?: (action: ChatReviewAction) => void } = {}): void {
  const node: ReactNode = (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <ChatProvider skin={skin} locale="ko" {...(onReviewAction ? { onReviewAction } : {})}>
        {list.map((row) => <ChatRowView key={row.id} row={row} providerLabel="Claude" />)}
      </ChatProvider>
    </AppI18nProvider>
  );
  act(() => root.render(node));
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name);
  if (!found) throw new Error(`no button "${name}" in: ${[...container.querySelectorAll('button')].map((element) => element.getAttribute('aria-label') ?? element.textContent).join(' | ')}`);
  return found;
}

describe('the AI review card', () => {
  it('shows a reason it does not know as the host wrote it', () => {
    const fixture = unsupportedReview();
    const items = fixture.items.map((entry) => (entry.payload?.type === 'review' ? { ...entry, payload: { ...entry.payload, reason: 'Codex 0.160 cannot fork read-only' } } : entry));
    render(buildChatModel({ items, turns: fixture.turns }).rows);
    expect(container.textContent).toContain('이 AI는 여기서 검토할 수 없습니다: Codex 0.160 cannot fork read-only');
  });

  it('reads as a result with each problem by file, its state and the person’s choices', () => {
    render(rows(mixedSelfReview(NOW)), { onReviewAction: vi.fn() });
    const card = container.querySelector<HTMLElement>('[data-testid="chat-review-card"]')!;
    expect(card.getAttribute('aria-label')).toBe('AI 검토 결과 · Claude · 검토 끝');
    expect(card.querySelector('.ez-ui-led')?.getAttribute('data-tone')).toBe('ok');
    expect(card.textContent).toContain('커밋 안 한 변경');
    expect(card.querySelector('[data-testid="chat-review-counts"]')?.textContent).toBe('문제 3 · 고치는 중 1 · 무시 1');
    expect([...card.querySelectorAll('.chat-review-file__path')].map((element) => element.textContent)).toEqual(['src/format.ts', 'src/discount.ts', 'src/cart.ts']);
    const statuses = [...card.querySelectorAll('[data-testid="chat-review-finding"]')].map((element) => element.getAttribute('data-status'));
    expect(statuses).toEqual(['fixing', 'dismissed', 'open']);
    expect(card.textContent).toContain('고치는 중');
    expect(card.textContent).toContain('무시함');
    expect(card.querySelector('[data-stale] .chat-review-stale')?.textContent).toBe('검토 뒤에 바뀜');
    expect(card.querySelector('.chat-action-card__stale')?.textContent).toBe('검토 뒤에 파일이 바뀌었습니다. 표시한 줄이 달라졌을 수 있습니다.');
    // Severity is a word, never only a colour.
    expect([...card.querySelectorAll('.chat-review-severity')].map((element) => element.textContent)).toEqual(['심각도 치명', '심각도 높음', '심각도 높음']);
    // Nothing on a result waits for the person: no amber lamp, no attention mark.
    expect(card.querySelector('[data-tone="amber"]')).toBeNull();
  });

  it('sends fix, fix-all, dismiss, reopen and walkthrough for the right problems', () => {
    const onReviewAction = vi.fn();
    const fixture = mixedSelfReview(NOW);
    render(rows(fixture), { onReviewAction });
    const card = rows(fixture).find((row): row is Extract<ChatRow, { kind: 'review' }> => row.kind === 'review')!;
    const id = (file: string): string => card.review.findings.find((finding) => finding.file === file)!.id;
    act(() => button('src/cart.ts:5 고치기').click());
    act(() => button('src/discount.ts:4 다시 열기').click());
    act(() => button('src/format.ts:2 변경에서 보기').click());
    act(() => button('모두 고치기 (1)').click());
    act(() => button('변경에서 차례로 보기').click());
    act(() => button('다시 검토').click());
    expect(onReviewAction.mock.calls.map(([action]) => action)).toEqual([
      { kind: 'fix', reviewId: MIXED_REVIEW_ID, findingIds: [id('src/cart.ts')] },
      { kind: 'reopen', reviewId: MIXED_REVIEW_ID, findingIds: [id('src/discount.ts')] },
      { kind: 'walkthrough', reviewId: MIXED_REVIEW_ID, findingIds: [id('src/format.ts')] },
      { kind: 'fix-all', reviewId: MIXED_REVIEW_ID, findingIds: [id('src/cart.ts')] },
      { kind: 'walkthrough', reviewId: MIXED_REVIEW_ID },
      { kind: 'retry', reviewId: MIXED_REVIEW_ID },
    ]);
    // A problem being fixed offers nothing more.
    expect(container.querySelector('[aria-label="src/format.ts:2 고치기"]')).toBeNull();
  });

  it('expands a problem to its explanation and how it goes wrong', () => {
    render(rows(mixedSelfReview(NOW)), { onReviewAction: vi.fn() });
    const title = [...container.querySelectorAll<HTMLButtonElement>('.chat-review-finding__title')].find((element) => element.textContent?.startsWith('The loop runs'))!;
    expect(title.getAttribute('aria-expanded')).toBe('false');
    act(() => title.click());
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('문제가 생기는 경우');
    expect(container.textContent).toContain("cartTotal([{ price: 500, quantity: 2 }]) throws");
  });

  it('is read-only without a host for its actions', () => {
    render(rows(mixedSelfReview(NOW)));
    expect(container.querySelector('.chat-review-finding__action')).toBeNull();
    expect(container.querySelector('.chat-action-card__actions')).toBeNull();
    expect(container.querySelector('button.chat-review-finding__where')).toBeNull();
    expect(container.querySelector('span.chat-review-finding__where')?.textContent).toBe(':2');
  });

  it('shows the CLI skin as ⏺ name(reviewer), a ⎿ line per problem and ✻ actions you can press', () => {
    const onReviewAction = vi.fn();
    render(rows(mixedSelfReview(NOW)), { skin: 'cli', onReviewAction });
    const card = container.querySelector<HTMLElement>('.chat-cli-action-card')!;
    expect(card.querySelector('.chat-cli-action-card__head')?.textContent).toContain('검토(Claude) 문제 3개');
    const lines = [...card.querySelectorAll('.chat-cli-review-finding')].map((element) => element.querySelector('.chat-cli-result__line')?.textContent ?? '');
    expect(lines[2]).toMatch(/^src\/cart\.ts:5 \[심각도 높음\] The loop runs .* · 검토 뒤에 바뀜자세히고치기 · 무시$/u);
    act(() => button('src/cart.ts:5 자세히').click());
    expect(card.textContent).toContain("문제가 생기는 경우: cartTotal([{ price: 500, quantity: 2 }]) throws");
    expect(card.querySelector('.chat-cli-action-card__actions')?.textContent).toContain('✻');
    act(() => button('src/cart.ts:5 무시').click());
    expect(onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dismiss' }));
  });

  it('shows the fix turn as a chip whose full message opens on demand', () => {
    render(rows(mixedSelfReview(NOW)));
    const chip = container.querySelector<HTMLElement>('.chat-review-turn[data-origin="review-fix"]')!;
    expect(chip.textContent).toContain('검토 결과 고치기 · 1개');
    expect(chip.querySelector('.chat-review-turn__text')).toBeNull();
    act(() => chip.querySelector<HTMLButtonElement>('.chat-review-turn__toggle')!.click());
    expect(chip.querySelector('.chat-review-turn__text')?.textContent).toContain('Fix only the review findings below');
  });

  it('keeps the reviewer’s answer under 원문 보기 when a complete review had text cut', () => {
    const fixture = mixedSelfReview(NOW);
    const raw = '{"findings":[{"file":"src/format.ts","body":"a very long explanation"}]}';
    const items = fixture.items.map((entry) => (entry.payload?.type === 'review' ? { ...entry, payload: { ...entry.payload, clipped: true, rawText: raw } } : entry));
    render(buildChatModel({ items, turns: fixture.turns }).rows);
    const card = container.querySelector<HTMLElement>(`[data-testid="chat-review-card"]`)!;
    expect(card.textContent).toContain('일부 설명은 길어서 잘렸습니다. 검토자의 원래 답은 원문 보기에서 볼 수 있습니다.');
    act(() => button('원문 보기').click());
    expect(card.querySelector('.chat-review-raw')?.textContent).toBe(raw);
    // A review with nothing cut shows neither.
    render(rows(mixedSelfReview(NOW)));
    expect(container.textContent).not.toContain('일부 설명은 길어서 잘렸습니다');
    expect(container.querySelector('.chat-review-raw-block')).toBeNull();
  });

  it('says why a review stopped and how to go on', () => {
    const onReviewAction = vi.fn();
    render(rows(failedReview()), { onReviewAction });
    const failed = container.querySelector<HTMLElement>('[data-testid="chat-review-card"]')!;
    expect(failed.querySelector('.ez-ui-led')?.getAttribute('data-tone')).toBe('red');
    // A stop leads with its glyph and says so in words; the plate's colour only follows.
    const reason = failed.querySelector<HTMLElement>('.chat-action-card__message[data-tone="danger"]')!;
    expect(reason.querySelector('svg')).not.toBeNull();
    expect(reason.querySelector('.chat-action-card__message-label')?.textContent).toBe('검토 실패');
    // The reason is a code; the card says it in the reader's words.
    expect(reason.textContent).toBe('검토 실패검토자가 정해진 형식으로 답하지 않았습니다.');
    act(() => button('원문 보기').click());
    expect(failed.querySelector('.chat-review-raw')?.textContent).toContain('I reviewed the diff.');
    act(() => button('다시 검토').click());
    expect(onReviewAction).toHaveBeenLastCalledWith({ kind: 'retry', reviewId: 'review-claude-failed' });

    render(rows(unsupportedReview()), { onReviewAction });
    expect(container.textContent).toContain('설치된 Codex 버전은 읽기 전용 검토를 지원하지 않습니다. 업데이트하세요.');
    act(() => button('다른 AI로 검토').click());
    expect(onReviewAction).toHaveBeenLastCalledWith({ kind: 'review-with-other', reviewId: 'review-codex-unsupported' });

    render(rows(queuedOtherReview(NOW)), { onReviewAction });
    const queued = container.querySelector<HTMLElement>('[data-testid="chat-review-card"]')!;
    expect(queued.querySelector('.ez-ui-led')?.getAttribute('data-tone')).toBe('idle');
    expect(queued.textContent).toContain('응답이 끝나면 검토합니다.');
    expect(queued.textContent).toContain('Codex · 다른 AI');
    expect(queued.textContent).toContain('main 이후 변경');
    act(() => button('취소').click());
    expect(onReviewAction).toHaveBeenLastCalledWith({ kind: 'cancel', reviewId: 'review-codex-queued' });
  });
});
