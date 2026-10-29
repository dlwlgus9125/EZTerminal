// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDirectoryStatus } from '../../shared/git-status';
import { buildChatModel } from '../chat/model/build-chat-model';
import { AppI18nProvider } from '../i18n';
import {
  BRANCH_DIFF, mixedSelfReview, otherAiReview, OTHER_REVIEW_ID, REVIEW_ROOT, UNCOMMITTED_DIFF, type ReviewFixture,
} from '../chat/review/review-fixtures';
import { clearSessionViewStates } from '../session-view-state';
import { ConversationResults } from './ConversationResults';
import type { ResultsNavigation, ResultsSendResult, ResultsSource } from './results-source-store';
import type { ResultsServices } from './results-services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  // jsdom has no layout: scrolling a line into view is a no-op here.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const STATUS: GitDirectoryStatus = { availability: 'ready', tracked: true, branch: 'review/cart-kit', changes: [], truncated: false };
const services = (): ResultsServices => ({
  getGitStatus: vi.fn(async () => STATUS),
  getGitDiff: vi.fn(async () => ({ ok: true as const, text: UNCOMMITTED_DIFF, truncated: false, omissions: [] })),
  getWorktreeBaseDiff: vi.fn(async (_root: string, baseRef: string) => ({ ok: true as const, text: BRANCH_DIFF, truncated: false, omissions: [], baseRef, ahead: 1 })),
  readFilePreview: vi.fn(),
});

async function show(fixture: ReviewFixture, navigation: ResultsNavigation, extra: Partial<ResultsSource> = {}, hostServices = services()): Promise<void> {
  const model = buildChatModel({ items: fixture.items, turns: fixture.turns });
  const source: ResultsSource & { sessionId: string } = {
    ownerPanelId: 'panel-review', sessionId: `s-${fixture.reviewId}`, workspaceRoot: REVIEW_ROOT, items: fixture.items, model, children: [],
    transcriptFloor: 0, loaded: true, baselineSequence: 0, historyOnly: false, turnActive: false, baseRef: 'main', ...extra,
  };
  await act(async () => root.render(<AppI18nProvider locale="ko" languages={['ko']}><ConversationResults source={source} services={hostServices} navigation={navigation} /></AppI18nProvider>));
  await act(async () => { await Promise.resolve(); });
}

const text = (testId: string): string => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
const click = async (testId: string): Promise<void> => act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());

describe('stepping through an AI review in Changes', () => {
  it('opens the review’s own scope at the problem and steps on, announcing each one', async () => {
    const reviewAction = vi.fn();
    await show(otherAiReview(), { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } }, { reviewAction });
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('base');
    expect(container.textContent).toContain('커밋 안 한 변경 포함 · main에서 갈라진 지점부터 · 앞선 커밋 1');
    expect(text('results-walkthrough-position')).toBe('문제 1/5');
    expect(text('results-walkthrough-announce')).toBe('문제 1/5 · src/auth.ts:6 · 치명 · The access check is always true');
    // The problem sits under its line, which takes the list's tab stop.
    const focused = container.querySelector<HTMLElement>('.results-patch__line[data-focus="true"]')!;
    expect(focused.getAttribute('aria-label')).toContain('6번 줄');
    expect(focused.tabIndex).toBe(0);
    expect(text('results-finding-current')).toContain('canAccess("guest", "admin") returns true');

    await click('results-walkthrough-next');
    expect(text('results-walkthrough-position')).toBe('문제 2/5');
    // src/cart.ts:1 is outside the branch's hunk: said so, with the way to the file.
    expect(text('results-walkthrough-outside')).toContain('src/cart.ts:1 줄은 지금 보는 변경에 없습니다.');
    expect(text('results-walkthrough-announce')).toContain('변경 범위 밖');

    await click('results-walkthrough-next');
    expect(text('results-walkthrough-position')).toBe('문제 3/5');
    expect(container.querySelector('[data-testid="results-walkthrough-outside"]')).toBeNull();
    await click('results-walkthrough-fix');
    expect(reviewAction).toHaveBeenCalledWith({ kind: 'fix', reviewId: OTHER_REVIEW_ID, findingIds: [expect.stringMatching(/^f-/u)] });
    await click('results-walkthrough-previous');
    expect(text('results-walkthrough-position')).toBe('문제 2/5');
    await click('results-walkthrough-close');
    expect(container.querySelector('[data-testid="results-walkthrough"]')).toBeNull();
  });

  it('opens an uncommitted-changes review in the working folder scope', async () => {
    const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
    await show(fixture, { sequence: 1, section: 'changes', review: { reviewId: fixture.reviewId } }, { baseRef: undefined });
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('git');
    expect([...container.querySelectorAll('select option')].map((option) => option.getAttribute('value'))).not.toContain('base');
    expect(text('results-walkthrough-position')).toBe('문제 1/3');
  });

  it('sends the collected comments as their own message and clears them only once taken', async () => {
    let answer: ResultsSendResult = { ok: false, message: '대화가 끝났습니다' };
    const sendNow = vi.fn(async () => answer);
    await show(otherAiReview(), { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } }, { sendNow, turnActive: true, insertIntoDraft: vi.fn() });
    const line = container.querySelector<HTMLButtonElement>('.results-patch__line[data-focus="true"]')!;
    await act(async () => line.click());
    const quote = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '줄만 인용')!;
    await act(async () => quote.click());
    const send = container.querySelector<HTMLButtonElement>('[data-testid="results-send-comments"]')!;
    expect(send.textContent).toBe('보내기 · 대기열에 추가');
    await act(async () => send.click());
    expect(sendNow).toHaveBeenCalledWith(expect.stringContaining('검토 의견 (1)\n- src/auth.ts:6'));
    expect(text('results-send-error')).toBe('보내지 못했습니다: 대화가 끝났습니다');
    expect(container.querySelectorAll('.results-tray__item')).toHaveLength(1);
    answer = { ok: true, queued: true, position: 2 };
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="results-send-comments"]')!.click());
    expect(container.querySelectorAll('.results-tray__item')).toHaveLength(0);
    expect(text('results-send-status')).toBe('대기열 2번째에 넣었습니다.');
  });

  it('offers to start a review from the toolbar when the conversation can', async () => {
    const openReviewStart = vi.fn();
    await show(otherAiReview(), { sequence: 1, section: 'changes' }, { openReviewStart });
    await click('results-start-review');
    expect(openReviewStart).toHaveBeenCalledTimes(1);
  });
});
