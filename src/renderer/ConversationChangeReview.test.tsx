// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_DRAFT_LIMIT } from './agent-results/results-format';
import { mixedSelfReview, MIXED_REVIEW_ID, REVIEW_ROOT, REVIEW_SESSION } from './chat/review/review-fixtures';
import { ConversationChangeReview } from './ConversationChangeReview';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { clearSessionViewStates(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
const byTestId = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function show(props: Partial<Parameters<typeof ConversationChangeReview>[0]> = {}): void {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}>
    <ConversationChangeReview sessionId={REVIEW_SESSION} items={fixture.items} turns={fixture.turns} workspaceRoot={REVIEW_ROOT} wide={false} mobile={false} hideTrigger {...props} />
  </AppI18nProvider>));
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

  it('sends selected lines with a note as their own message', async () => {
    const onSendComments = vi.fn(async () => ({ ok: true as const, queued: false }));
    show({ openRequest: 1, onSendComments, onQuote: vi.fn() });
    const line = [...document.querySelectorAll<HTMLButtonElement>('button.conversation-review__line')].find((button) => button.textContent?.includes('let i = 0; i <= items.length'))!;
    act(() => line.click());
    const note = byTestId('conversation-review-note') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { setter.call(note, '<로 돌려 주세요'); note.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => byTestId('conversation-review-send')!.click());
    // The latest changed turn renamed the loop variable; the comment quotes its new line.
    expect(onSendComments).toHaveBeenCalledWith('검토 의견 (1)\n- src\\cart.ts:5 — <로 돌려 주세요\n  > +  for (let i = 0; i <= items.length; i += 1) {\n\n');
    expect(byTestId('conversation-review-sent')?.textContent).toBe('대화에 보냈습니다.');
    expect(REVIEW_DRAFT_LIMIT).toBe(8_000);
  });
});
