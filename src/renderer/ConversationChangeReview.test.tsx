// @vitest-environment jsdom
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_DRAFT_LIMIT } from './agent-results/results-format';
import type { ChatReviewAction } from './chat/ChatContext';
import {
  applyReviewAction, deletedFileReview, fixOutcomesReview, mixedSelfReview, MIXED_REVIEW_ID, OUTCOMES_REVIEW_ID, REVIEW_ROOT, REVIEW_SESSION, walkFindingId,
} from './chat/review/review-fixtures';
import { ConversationChangeReview } from './ConversationChangeReview';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { clearSessionViewStates(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const NOW = Date.parse('2026-10-29T00:50:00.000Z');
const fixture = mixedSelfReview(NOW);
const byTestId = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
};

function show(props: Partial<Parameters<typeof ConversationChangeReview>[0]> = {}): void {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}>
    <ConversationChangeReview sessionId={REVIEW_SESSION} items={fixture.items} turns={fixture.turns} workspaceRoot={REVIEW_ROOT} wide={false} mobile={false} hideTrigger {...props} />
  </AppI18nProvider>));
}

function type(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('the review sheet with an AI review (findings mode)', () => {
  it('opens on the problem the card pointed at, with the recorded lines around it, and steps through', () => {
    const onReviewAction = vi.fn();
    show({ findingsRequest: { sequence: 1, reviewId: MIXED_REVIEW_ID }, onReviewAction });
    const view = document.querySelector<HTMLElement>('[data-testid="conversation-change-review"][data-mode="findings"]')!;
    expect(view.querySelector('.conversation-review__position')?.textContent).toBe('문제 1/3src/format.ts:2');
    const focus = view.querySelector('.conversation-review__line[data-focus]')!;
    expect(focus.textContent).toContain('+  const dollars = cents / 10;');
    // Long lines scroll in a named, focusable region (like chat code blocks) until 줄 바꿈 wraps them.
    const region = view.querySelector<HTMLElement>('[role="region"]')!;
    expect(region.getAttribute('aria-label')).toBe('src/format.ts:2 주변 변경');
    expect(region.tabIndex).toBe(0);
    act(() => byTestId('conversation-review-wrap')!.click());
    expect(region.hasAttribute('data-wrap')).toBe(true);
    expect(byTestId('conversation-review-wrap')?.getAttribute('aria-pressed')).toBe('true');
    // Being fixed: nothing to send again.
    expect(byTestId('conversation-review-fix')).toBeNull();
    act(() => byTestId('conversation-review-next')!.click());
    expect(document.querySelector('.conversation-review__position')?.textContent).toBe('문제 2/3src/discount.ts:4');
    act(() => byTestId('conversation-review-reopen')!.click());
    act(() => byTestId('conversation-review-next')!.click());
    act(() => byTestId('conversation-review-fix')!.click());
    expect(onReviewAction.mock.calls.map(([action]) => action.kind)).toEqual(['reopen', 'fix']);
    expect(byTestId('conversation-review-next')).toHaveProperty('disabled', true);
  });

  it('never puts a problem on a line whose code changed: says it cannot find it, shows what the review read, and leads to the file', () => {
    // The cart loop was rewritten in a later turn: its line 5 now holds other code.
    const onOpenProjectFiles = vi.fn();
    show({ findingsRequest: { sequence: 1, reviewId: MIXED_REVIEW_ID, findingId: walkFindingId(fixture, 2)! }, onOpenProjectFiles });
    expect(document.querySelector('.conversation-review__position')?.textContent).toBe('문제 3/3src/cart.ts:5');
    expect(byTestId('conversation-review-missing')?.textContent).toContain('이 줄을 찾을 수 없음');
    const region = document.querySelector<HTMLElement>('[role="region"]')!;
    expect(region.getAttribute('aria-label')).toBe('src/cart.ts:5 검토 때 읽은 줄');
    expect(region.textContent).toContain('for (let index = 0; index <= items.length; index += 1) {');
    expect(region.textContent).not.toContain('let i = 0');
    expect(document.querySelector('.conversation-review__line[data-focus]')).toBeNull();
    act(() => byTestId('conversation-review-view-file')!.click());
    expect(onOpenProjectFiles).toHaveBeenCalledTimes(1);
  });

  it('says the file was deleted instead of pointing into an older patch, keeping the review’s lines and no way to a file', () => {
    const deleted = deletedFileReview(NOW);
    show({ items: deleted.items, turns: deleted.turns, findingsRequest: { sequence: 1, reviewId: MIXED_REVIEW_ID, findingId: walkFindingId(deleted, 1)! }, onOpenProjectFiles: vi.fn() });
    expect(document.querySelector('.conversation-review__position')?.textContent).toBe('문제 2/3src/discount.ts:4');
    expect(byTestId('conversation-review-deleted')?.textContent).toContain('파일이 지워짐');
    const region = document.querySelector<HTMLElement>('[role="region"]')!;
    expect(region.textContent).toContain('return total - total * percent;');
    expect(document.querySelector('.conversation-review__line[data-focus]')).toBeNull();
    expect(byTestId('conversation-review-view-file')).toBeNull();
  });

  it('offers 다시 열기 on a fixed problem', () => {
    const outcomes = fixOutcomesReview(NOW);
    const onReviewAction = vi.fn();
    show({ items: outcomes.items, turns: outcomes.turns, findingsRequest: { sequence: 1, reviewId: OUTCOMES_REVIEW_ID, findingId: walkFindingId(outcomes, 0)! }, onReviewAction });
    expect(document.querySelector('.conversation-review__position')?.textContent).toBe('문제 1/5src/auth.ts:6');
    act(() => button('src/auth.ts:6 다시 열기').click());
    expect(onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reopen' }));
  });

  it('moves focus to the problem and says its new state once after 고치기', async () => {
    function Host(): JSX.Element {
      const [state, setState] = useState(() => ({ items: fixture.items, turns: fixture.turns }));
      const onReviewAction = useCallback((action: ChatReviewAction) => setState((current) => applyReviewAction(current, action, NOW)), []);
      return <ConversationChangeReview sessionId={REVIEW_SESSION} items={state.items} turns={state.turns} workspaceRoot={REVIEW_ROOT} wide={false} mobile={false} hideTrigger
        findingsRequest={{ sequence: 1, reviewId: MIXED_REVIEW_ID, findingId: walkFindingId(fixture, 2)! }} onReviewAction={onReviewAction} />;
    }
    act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}><Host /></AppI18nProvider>));
    const status = byTestId('conversation-review-status')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    act(() => button('src/cart.ts:5 고치기').click());
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(byTestId('conversation-review-fix')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-finding-title]'));
    expect(byTestId('conversation-review-status')!.textContent).toBe('src/cart.ts:5 · 고침 요청됨');
  });
});

describe('comments on a phone (no Shift)', () => {
  const line = (text: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button.conversation-review__line')].find((element) => element.textContent?.includes(text))!;

  it('taps out a range, collects comments and sends them together', async () => {
    const onSendComments = vi.fn(async () => ({ ok: true as const, queued: true }));
    show({ openRequest: 1, onSendComments, onQuote: vi.fn(), turnActive: true });
    // First tap: the range starts there, and says so with a way out.
    act(() => line('+  for (let i = 0').click());
    expect(byTestId('conversation-review-selecting')?.textContent).toContain('범위 선택 중');
    expect(line('+  for (let i = 0').getAttribute('aria-pressed')).toBe('true');
    // Second tap: the range ends there; a comment goes into the tray.
    act(() => line('+    total += items[i]').click());
    expect(byTestId('conversation-review-selecting')).toBeNull();
    type(byTestId('conversation-review-note') as HTMLTextAreaElement, '<로 돌려 주세요');
    act(() => byTestId('conversation-review-add')!.click());
    // One line: the same line twice; quoted without a note.
    act(() => line('   }').click());
    act(() => line('   }').click());
    act(() => byTestId('conversation-review-quote-only')!.click());
    expect(document.querySelectorAll('.results-tray__item')).toHaveLength(2);
    // 취소 leaves the range unstarted; a tap after a finished range clears it.
    act(() => line('   let total = 0;').click());
    act(() => button('범위 선택 취소').click());
    expect(byTestId('conversation-review-selecting')).toBeNull();
    act(() => line('   let total = 0;').click());
    act(() => line('   let total = 0;').click());
    expect(byTestId('conversation-review-note')).not.toBeNull();
    act(() => line('+  for (let i = 0').click());
    expect(byTestId('conversation-review-note')).toBeNull();
    expect([...document.querySelectorAll('button.conversation-review__line[aria-pressed="true"]')]).toHaveLength(0);

    const send = byTestId('results-send-comments')!;
    expect(send.textContent).toBe('보내기 · 대기열에 추가');
    await act(async () => send.click());
    // The latest changed turn renamed the loop variable; the comments quote its new lines.
    expect(onSendComments).toHaveBeenCalledWith('검토 의견 (2)\n- src\\cart.ts:5-6 — <로 돌려 주세요\n  > +  for (let i = 0; i <= items.length; i += 1) {\n  > +    total += items[i].price * items[i].quantity;\n- src\\cart.ts:7\n  >    }\n\n');
    expect(document.querySelectorAll('.results-tray__item')).toHaveLength(0);
    // No place in the queue from the host: none is made up.
    expect(byTestId('results-send-status')?.textContent).toBe('대기열에 추가됨');
    expect(REVIEW_DRAFT_LIMIT).toBe(8_000);
  });
});
