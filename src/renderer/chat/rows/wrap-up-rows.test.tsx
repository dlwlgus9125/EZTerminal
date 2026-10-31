// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../i18n';
import { ChatProvider, type ChatContextValue, type ChatWrapUpAction } from '../ChatContext';
import { ChatRowView } from '../ChatRowView';
import { buildChatModel } from '../model/build-chat-model';
import { cartStory, formatStory, waitingStory, type WrapUpFixture } from '../wrap-up/wrap-up-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const TASK_START = { settings: 'Claude · Opus 5.5 · 높음 · 승인 후 실행', folder: 'cart-kit', phone: false };

function render(fixture: WrapUpFixture, context: Partial<Omit<ChatContextValue, 'isExpanded' | 'setExpanded'>> = {}): void {
  const { rows } = buildChatModel({ items: fixture.items, turns: fixture.turns });
  act(() => root.render(
    <AppI18nProvider locale="ko" languages={['ko']}>
      <ChatProvider skin="bubble" locale="ko" taskStart={TASK_START} {...context}>
        {rows.map((row) => <ChatRowView key={row.id} row={row} providerLabel="Claude" />)}
      </ChatProvider>
    </AppI18nProvider>,
  ));
}

const byTestId = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttons = (): string[] => [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');

describe('a recap that could not be written', () => {
  const failed = formatStory('ko', 'claude', { recap: 'failed', failure: 'disconnected', suggestion: false });

  it('offers 다시 만들기 while the session is attached', () => {
    const onWrapUpAction = vi.fn();
    render(failed, { onWrapUpAction, recapRetry: true });
    expect(byTestId('chat-recap-line')?.textContent).toContain('요약을 만들지 못했습니다 · 연결 끊김');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '다시 만들기')!.click());
    expect(onWrapUpAction).toHaveBeenCalledWith({ kind: 'recap-retry', turnId: 'turn-plan' });
  });

  it('keeps its reason and offers no button that could only fail once the session is gone', () => {
    render(failed, { onWrapUpAction: vi.fn() });
    expect(byTestId('chat-recap-line')?.textContent).toContain('요약을 만들지 못했습니다 · 연결 끊김');
    expect(buttons()).not.toContain('다시 만들기');
  });
});

describe('a recap written while the AI waited, once the turn ran on', () => {
  it.each(['bubble', 'cli'] as const)('stays above what came after the answer and says it was answered (%s)', (skin) => {
    render(waitingStory('ko', { answered: true }), { skin, onFocusDecision: () => true });
    const page = container.textContent ?? '';
    expect(byTestId('chat-recap-card')?.textContent).toContain('답을 기다렸던 턴');
    expect(page.indexOf('답을 기다렸던 턴')).toBeLessThan(page.indexOf('음수는 괄호로 표시하기로 하고'));
    expect(byTestId('chat-recap-answer')).toBeNull();
  });
});

describe('the suggested-task card', () => {
  it('reads as a record where nothing can be pressed: no line about what one click starts', () => {
    render(cartStory('ko', 'claude'));
    expect(byTestId('chat-task-card')).not.toBeNull();
    expect(byTestId('chat-task-defaults')).toBeNull();
    expect(byTestId('chat-task-start-all')).toBeNull();
    expect(container.querySelector('[data-action]')).toBeNull();
  });

  it('shows a command in flight on an open task and takes its button away', () => {
    const onWrapUpAction = vi.fn<(action: ChatWrapUpAction) => void>();
    render(cartStory('ko', 'claude'), { onWrapUpAction, wrapUpPending: new Map([['task-claude-1', 'starting'], ['task-claude-2', 'sending']]) });
    const [first, second] = [...container.querySelectorAll('[data-testid="chat-task"]')];
    expect(first?.getAttribute('data-outcome')).toBe('starting');
    expect(first?.querySelector('[data-action="task-start"]')).toBeNull();
    expect(second?.getAttribute('data-outcome')).toBe('sending');
    // Two of three are on their way: 모두 시작 counts what is left, and one left is no batch.
    expect(byTestId('chat-task-start-all')).toBeNull();
  });

  it('lets what the host confirmed win over a command still in flight', () => {
    render(cartStory('ko', 'claude', 'states'), { onWrapUpAction: vi.fn(), wrapUpPending: new Map([['task-claude-1', 'starting']]) });
    expect(container.querySelector('[data-testid="chat-task"]')?.getAttribute('data-outcome')).toBe('started');
  });

  it('shows the same in flight over a failed start being repeated', () => {
    render(cartStory('ko', 'claude', 'retry'), { onWrapUpAction: vi.fn(), wrapUpPending: new Map([['task-claude-1', 'starting']]) });
    expect(container.querySelector('[data-testid="chat-task"]')?.getAttribute('data-outcome')).toBe('starting');
  });
});
