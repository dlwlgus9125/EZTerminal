// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentResultsOwnerContext } from './agent-results/AgentResultsContext';
import { readResultsSource, resetResultsSourcesForTests } from './agent-results/results-source-store';
import { mixedSelfReview, MIXED_REVIEW_ID, REVIEW_ROOT } from './chat/review/review-fixtures';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from './StructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  clearSessionViewStates();
  resetResultsSourcesForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}>{node}</AppI18nProvider>));
}

const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
const reviewStart = { options: { self: { providerId: 'claude' }, others: [{ providerId: 'codex' }] }, onStart: vi.fn() };

function panel(overrides: Partial<StructuredAgentSessionPanelProps> = {}): JSX.Element {
  return (
    <StructuredAgentSessionPanel sessionId="review-chat" title="가격 표시" providerId="claude" providerLabel="Claude"
      workspace={{ id: 'ws', label: 'cart-kit', kind: 'local', path: REVIEW_ROOT }} model="claude-opus-5-5" permissionPreset="standard"
      state="idle" items={fixture.items} turns={fixture.turns} onSend={async () => ({ ok: true })} {...overrides} />
  );
}

function type(control: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const composer = (): HTMLTextAreaElement => container.querySelector('[data-testid="structured-agent-composer-input"]')!;
const openMenu = (): void => act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-menu"]')!.click());

describe('reviews in the conversation panel', () => {
  it('offers 검토… in place of 검토 맡기기… where the host reviews', () => {
    render(panel({ onDelegate: vi.fn() }));
    openMenu();
    expect(document.querySelector('[data-testid="structured-agent-delegate-review"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="structured-agent-review"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    render(panel({ onDelegate: vi.fn(), reviewStart }));
    openMenu();
    expect(document.querySelector('[data-testid="structured-agent-delegate-review"]')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="structured-agent-review"]')!.click());
    expect(document.querySelector('[data-testid="review-start-dialog"]')).not.toBeNull();
  });

  it('/review opens the form and /review <focus> starts this AI on the uncommitted changes', () => {
    const onStart = vi.fn();
    const onSend = vi.fn(async () => ({ ok: true as const }));
    render(panel({ reviewStart: { ...reviewStart, onStart }, onSend }));
    type(composer(), '/review 금액 계산');
    act(() => composer().closest('form')!.requestSubmit());
    expect(onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, focus: '금액 계산' });
    expect(onSend).not.toHaveBeenCalled();
    type(composer(), '/review');
    act(() => composer().closest('form')!.requestSubmit());
    expect(document.querySelector('[data-testid="review-start-dialog"]')).not.toBeNull();
  });

  it('passes card actions to the host and opens a problem here (the sheet without a Results tab)', () => {
    const onReviewAction = vi.fn();
    render(panel({ onReviewAction }));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="src/cart.ts:5 고치기"]')!.click());
    expect(onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix', reviewId: MIXED_REVIEW_ID }));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="src/discount.ts:4 변경에서 보기"]')!.click());
    expect(onReviewAction).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="conversation-change-review"][data-mode="findings"] .conversation-review__position')?.textContent)
      .toBe('문제 2/3src/discount.ts:4');
  });

  it('with a Results tab, steps through there and publishes send, review actions and the start form', () => {
    const open = vi.fn();
    render(<AgentResultsOwnerContext.Provider value={{ ownerPanelId: 'panel-1', open }}>{panel({ onReviewAction: vi.fn(), reviewStart })}</AgentResultsOwnerContext.Provider>);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="src/format.ts:2 변경에서 보기"]')!.click());
    expect(open).toHaveBeenCalledWith({ activate: true, target: { section: 'changes', review: { reviewId: MIXED_REVIEW_ID, findingId: expect.stringMatching(/^f-/u) } } });
    const source = readResultsSource('panel-1');
    expect(source?.sendNow).toBeTypeOf('function');
    expect(source?.reviewAction).toBeTypeOf('function');
    expect(source?.openReviewStart).toBeTypeOf('function');
  });

  it('keeps the cards read-only in history', () => {
    render(panel({ historyOnly: true, onReviewAction: vi.fn(), reviewStart }));
    expect(container.querySelector('[data-testid="chat-review-card"]')).not.toBeNull();
    expect(container.querySelector('.chat-review-finding__action')).toBeNull();
  });
});
