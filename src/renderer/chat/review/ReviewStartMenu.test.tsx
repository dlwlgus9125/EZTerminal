// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../i18n';
import { ReviewStartForm, type ReviewStartOptions, type ReviewStartTarget } from './ReviewStartMenu';

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

function render(options: ReviewStartOptions, onStart = vi.fn(), initialTarget?: ReviewStartTarget, initialFocus?: string): typeof onStart {
  act(() => root.render(<AppI18nProvider locale="ko" languages={['ko']}>
    <ReviewStartForm key={JSON.stringify([options, initialTarget, initialFocus])} options={options} onStart={onStart} onCancel={vi.fn()}
      {...(initialTarget ? { initialTarget } : {})} {...(initialFocus ? { initialFocus } : {})} />
  </AppI18nProvider>));
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

  it('opens on the changes the person was viewing and says exactly what the review reads', () => {
    const target = (): string => container.querySelector('[data-testid="review-start-target"]')!.textContent!;
    const onStart = render({ ...BASE, baseRef: 'main' }, vi.fn(), { kind: 'base-branch', baseRef: 'main' });
    expect(get('review-start-branch').checked).toBe(true);
    expect(target()).toBe('검토 대상main에서 갈라진 지점 이후 + 커밋 안 한 변경 + 새 파일');
    act(() => get('review-start-uncommitted').click());
    expect(target()).toBe('검토 대상커밋 안 한 변경 + 새 파일');
    act(() => get('review-start-branch').click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="review-start-submit"]')!.click());
    expect(onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'base-branch', baseRef: 'main' } });
    // The working folder: the uncommitted changes, even where a base branch is offered.
    render({ ...BASE, baseRef: 'main' }, vi.fn(), { kind: 'uncommitted' });
    expect(get('review-start-uncommitted').checked).toBe(true);
    expect(target()).toBe('검토 대상커밋 안 한 변경 + 새 파일');
  });

  it('opens with the text of `/review <text>` as its focus (D3), and starts only when sent', () => {
    const onStart = render(BASE, vi.fn(), undefined, '금액 계산과 권한 검사');
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="review-start-focus"]')!.value).toBe('금액 계산과 권한 검사');
    expect(onStart).not.toHaveBeenCalled();
    act(() => get('review-start-submit').click());
    expect(onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, focus: '금액 계산과 권한 검사' });
  });

  it('offers the branch of a worktree whose base the host finds, without naming it', () => {
    const onStart = render({ ...BASE, worktree: true });
    expect(get('review-start-branch').disabled).toBe(false);
    expect(container.textContent).toContain('기준 브랜치에서 갈라진 지점 이후의 커밋까지');
    act(() => get('review-start-branch').click());
    expect(container.querySelector('[data-testid="review-start-target"]')!.textContent).toBe('검토 대상기준 브랜치에서 갈라진 지점 이후 + 커밋 안 한 변경 + 새 파일');
    act(() => get('review-start-submit').click());
    expect(onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'base-branch' } });
  });

  it('says which model and effort each reviewer uses (D8), and nothing about cost', () => {
    render({ self: { providerId: 'claude', settingsText: 'Opus 5.5 · 높음' }, others: [{ providerId: 'codex', settingsText: '검토 에이전트 코드 리뷰어 · gpt-6.1-sol · 높음' }] });
    expect(container.querySelector('[data-testid="review-start-self-settings"]')?.textContent).toBe('사용: Opus 5.5 · 높음');
    expect(container.querySelector('[data-testid="review-start-other-settings"]')?.textContent).toBe('사용: 검토 에이전트 코드 리뷰어 · gpt-6.1-sol · 높음');
    expect(container.textContent).not.toContain('토큰');
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
