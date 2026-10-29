// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../i18n';
import { ReviewStartForm, type ReviewStartOptions } from './ReviewStartMenu';

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

const BASE: ReviewStartOptions = { self: { providerId: 'claude' }, others: [{ providerId: 'codex' }] };

function render(options: ReviewStartOptions, onStart = vi.fn()): typeof onStart {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}><ReviewStartForm key={JSON.stringify(options)} options={options} onStart={onStart} onCancel={vi.fn()} /></AppI18nProvider>));
  return onStart;
}

const get = (testId: string): HTMLInputElement => container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
const reason = (): string | undefined => container.querySelector('[data-testid="review-start-reason"]')?.textContent ?? undefined;

function type(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the review start form', () => {
  it('starts this AI on the uncommitted changes by default, with the focus the person typed', () => {
    const onStart = render(BASE);
    expect(get('review-start-self').checked).toBe(true);
    expect(get('review-start-uncommitted').checked).toBe(true);
    type(container.querySelector<HTMLTextAreaElement>('[data-testid="review-start-focus"]')!, '  금액 계산  ');
    act(() => get('review-start-submit').click());
    expect(onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, focus: '금액 계산' });
  });

  it('offers the base branch only in a worktree, and says why otherwise', () => {
    render(BASE);
    expect(get('review-start-branch').disabled).toBe(true);
    expect(container.textContent).toContain('워크트리에서 일하는 대화에서만 쓸 수 있습니다.');
    const onStart = render({ ...BASE, baseRef: 'main' });
    expect(container.textContent).toContain('기준 브랜치와 비교 (main)');
    act(() => get('review-start-branch').click());
    act(() => get('review-start-other').click());
    act(() => get('review-start-submit').click());
    expect(onStart).toHaveBeenCalledWith({ reviewer: { mode: 'other', providerId: 'codex' }, target: { kind: 'base-branch', baseRef: 'main' } });
  });

  it('shows the cost of a long Claude conversation only for this AI', () => {
    render({ ...BASE, contextTokens: 182_000 });
    expect(container.querySelector('[data-testid="review-start-cost"]')?.textContent).toBe('대화 맥락 약 18만 토큰 — 길수록 검토 비용이 큽니다.');
    act(() => get('review-start-other').click());
    expect(container.querySelector('[data-testid="review-start-cost"]')).toBeNull();
  });

  it('cannot start, and says why, where no review can run or the reviewer is not available', () => {
    render({ ...BASE, disabledReason: '이 작업 폴더는 Git 저장소가 아닙니다.' });
    expect(reason()).toBe('이 작업 폴더는 Git 저장소가 아닙니다.');
    expect(get('review-start-submit').disabled).toBe(true);

    render({ self: { providerId: 'codex', unavailableReason: 'Codex 0.160은 읽기 전용 분기를 만들 수 없습니다.' }, others: [{ providerId: 'claude' }] });
    // The unavailable one cannot be picked; the other AI is chosen instead.
    expect(get('review-start-self').disabled).toBe(true);
    expect(get('review-start-other').checked).toBe(true);
    expect(get('review-start-submit').disabled).toBe(false);

    render({ self: { providerId: 'claude' }, others: [] });
    expect(get('review-start-other').disabled).toBe(true);
    expect(container.textContent).toContain('이 PC에서 검토할 수 있는 다른 AI가 없습니다.');
  });
});
