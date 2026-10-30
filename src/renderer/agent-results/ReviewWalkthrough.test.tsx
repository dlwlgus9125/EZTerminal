// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDirectoryStatus } from '../../shared/git-status';
import type { CleanedFolderState } from '../../shared/run-retention';
import { buildChatModel } from '../chat/model/build-chat-model';
import { AppI18nProvider } from '../i18n';
import {
  BRANCH_DIFF, deletedFileReview, mixedSelfReview, otherAiReview, OTHER_REVIEW_ID, REVIEW_ROOT, REVIEW_SESSION, UNCOMMITTED_DIFF, walkFindingId, type ReviewFixture,
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
  getWorktreeBaseDiff: vi.fn(async () => ({ ok: true as const, text: BRANCH_DIFF, truncated: false, omissions: [], baseRef: 'main', mergeBase: 'a1b2c3d', ahead: 1 })),
  readFilePreview: vi.fn(),
});

async function show(fixture: ReviewFixture, navigation: ResultsNavigation, extra: Partial<ResultsSource> = {}, hostServices = services()): Promise<void> {
  const model = buildChatModel({ items: fixture.items, turns: fixture.turns });
  const source: ResultsSource & { sessionId: string } = {
    ownerPanelId: 'panel-review', sessionId: `s-${fixture.reviewId}`, workspaceRoot: REVIEW_ROOT, items: fixture.items, model, children: [],
    transcriptFloor: 0, loaded: true, baselineSequence: 0, historyOnly: false, turnActive: false, baseRef: 'main', workspaceId: 'ws-cart', ...extra,
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
    // The pressed button may go with the new state: focus is on the problem's title, which stays.
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="results-walkthrough"] [data-finding-title]'));
    await click('results-walkthrough-previous');
    expect(text('results-walkthrough-position')).toBe('문제 2/5');
    await click('results-walkthrough-close');
    expect(container.querySelector('[data-testid="results-walkthrough"]')).toBeNull();
  });

  it('never puts a problem on a line whose code changed: says it cannot find it and shows what the review read', async () => {
    // Only the AI's records: the cart loop was rewritten in a later turn, so line 5 now holds other code.
    const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
    const readFilePreview = vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const }));
    await show(fixture, { sequence: 1, section: 'changes', review: { reviewId: fixture.reviewId, findingId: walkFindingId(fixture, 2)! } }, { baseRef: undefined, sessionId: REVIEW_SESSION },
      { readFilePreview } as ResultsServices);
    expect(text('results-walkthrough-position')).toBe('문제 3/3');
    const missing = text('results-walkthrough-missing');
    expect(missing).toContain('이 줄을 찾을 수 없음');
    expect(missing).toContain('for (let index = 0; index <= items.length; index += 1) {');
    expect(text('results-walkthrough-announce')).toContain('이 줄을 찾을 수 없음');
    expect(container.querySelector('.results-patch__line[data-focus="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-finding-current"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-walkthrough-outside"]')).toBeNull();
    const view = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="results-walkthrough-missing"] button')].find((button) => button.textContent === '파일에서 보기')!;
    await act(async () => view.click());
    expect(container.querySelector('[data-testid="results-files"]')).not.toBeNull();
  });

  it('never falls back to an older patch once the file was deleted: 파일이 지워짐, the review’s lines, no way to a file', async () => {
    const fixture = deletedFileReview(Date.parse('2026-10-29T00:50:00.000Z'));
    await show(fixture, { sequence: 1, section: 'changes', review: { reviewId: fixture.reviewId, findingId: walkFindingId(fixture, 1)! } }, { baseRef: undefined, sessionId: REVIEW_SESSION },
      { readFilePreview: vi.fn() } as ResultsServices);
    expect(text('results-walkthrough-position')).toBe('문제 2/3');
    const deleted = text('results-walkthrough-deleted');
    expect(deleted).toContain('파일이 지워짐');
    expect(deleted).toContain('return total - total * percent;');
    expect(container.querySelector('[data-testid="results-walkthrough-deleted"] button')).toBeNull();
    expect([...container.querySelectorAll('.results-diff__actions button')].map((button) => button.textContent)).not.toContain('파일 보기');
    expect(text('results-walkthrough-announce')).toContain('파일이 지워짐');
    expect(container.querySelector('.results-patch__line[data-focus="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-finding-current"]')).toBeNull();
  });

  it('reads 기준 브랜치와 비교 for the conversation’s workspace, and says when it is not a worktree any more', async () => {
    const gone = { ...services(), getWorktreeBaseDiff: vi.fn(async () => ({ ok: false as const, error: 'invalid-path' as const })) };
    await show(otherAiReview(), { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } }, {}, gone);
    expect(gone.getWorktreeBaseDiff).toHaveBeenCalledWith('ws-cart');
    expect(container.textContent).toContain('이 대화의 작업 공간이 없어졌거나 워크트리가 아니라 기준 브랜치와 비교할 수 없습니다.');
    expect(container.textContent).not.toContain('작업 폴더를 읽지 못했습니다');
  });

  it('opens an uncommitted-changes review in the working folder scope', async () => {
    const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
    await show(fixture, { sequence: 1, section: 'changes', review: { reviewId: fixture.reviewId } }, { baseRef: undefined });
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('git');
    expect([...container.querySelectorAll('select option')].map((option) => option.getAttribute('value'))).not.toContain('base');
    expect(text('results-walkthrough-position')).toBe('문제 1/3');
  });

  it('opens the review’s scope also from a Results tab that is still asking whether its folder may be read', async () => {
    // The walkthrough opened the tab: the host has not said yet that the working folder is live.
    const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
    let answer: (state: CleanedFolderState) => void = () => undefined;
    const asking = { ...services(), cleanedFolder: vi.fn(() => new Promise<CleanedFolderState>((resolve) => { answer = resolve; })) };
    await show(fixture, { sequence: 1, section: 'changes', review: { reviewId: fixture.reviewId } }, { baseRef: undefined }, asking);
    expect(asking.getGitDiff).not.toHaveBeenCalled();
    await act(async () => { answer({ state: 'live' }); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('git');
    expect(text('results-walkthrough-position')).toBe('문제 1/3');
    expect(container.querySelector('.results-patch__line[data-focus="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-walkthrough-outside"]')).toBeNull();
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
    expect(text('results-send-status')).toBe('대기열 2번째');
  });

  it('takes off only the comments that were sent, and names a queue place only when the host gave one', async () => {
    let finish: (result: ResultsSendResult) => void = () => undefined;
    const sendNow = vi.fn(() => new Promise<ResultsSendResult>((resolve) => { finish = resolve; }));
    await show(otherAiReview(), { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } }, { sendNow, turnActive: true, insertIntoDraft: vi.fn() });
    const quoteLine = async (line: HTMLButtonElement): Promise<void> => {
      await act(async () => line.click());
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '줄만 인용')!.click());
    };
    const lines = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('.results-patch__line')];
    await quoteLine(lines().find((line) => line.dataset.focus === 'true')!);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="results-send-comments"]')!.click());
    expect(sendNow).toHaveBeenCalledTimes(1);
    // While it is on its way, another comment is collected: it stays when the first one went.
    await quoteLine(lines().find((line) => line.dataset.focus !== 'true')!);
    expect(container.querySelectorAll('.results-tray__item')).toHaveLength(2);
    await act(async () => { finish({ ok: true, queued: true }); await Promise.resolve(); });
    const left = [...container.querySelectorAll('.results-tray__item')];
    expect(left).toHaveLength(1);
    expect(left[0]!.textContent).not.toContain('src/auth.ts:6');
    expect(text('results-send-status')).toBe('대기열에 추가됨');
  });

  it('says the comments wait in the queue only until their turn starts', async () => {
    const sendNow = vi.fn(async (comments: string): Promise<ResultsSendResult> => ({ ok: true, queued: comments.length > 0 }));
    const nav: ResultsNavigation = { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } };
    await show(otherAiReview(), nav, { sendNow, turnActive: true, insertIntoDraft: vi.fn() });
    await act(async () => container.querySelector<HTMLButtonElement>('.results-patch__line[data-focus="true"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '줄만 인용')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="results-send-comments"]')!.click());
    expect(text('results-send-status')).toBe('대기열에 추가됨');
    const sent = sendNow.mock.calls[0]![0];
    await show(otherAiReview(), nav, { sendNow, turnActive: true, insertIntoDraft: vi.fn(), queuedTexts: [sent] });
    expect(text('results-send-status')).toBe('대기열에 추가됨');
    // The earlier turn ended and this one runs: it left the queue.
    await show(otherAiReview(), nav, { sendNow, turnActive: true, insertIntoDraft: vi.fn(), queuedTexts: [] });
    expect(text('results-send-status')).toBe('대화에 보냈습니다.');
  });

  it('keeps comments from going both ways: while sending, they cannot be put in the message or removed', async () => {
    let finish: (result: ResultsSendResult) => void = () => undefined;
    const sendNow = vi.fn(() => new Promise<ResultsSendResult>((resolve) => { finish = resolve; }));
    const insertIntoDraft = vi.fn();
    await show(otherAiReview(), { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } }, { sendNow, turnActive: true, insertIntoDraft });
    await act(async () => container.querySelector<HTMLButtonElement>('.results-patch__line[data-focus="true"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '줄만 인용')!.click());
    const insert = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="results-insert-comments"]')!;
    const removers = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('.results-tray__item button')];
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="results-send-comments"]')!.click());
    expect(insert().disabled).toBe(true);
    expect(removers().every((button) => button.disabled)).toBe(true);
    await act(async () => insert().click());
    expect(insertIntoDraft).not.toHaveBeenCalled();
    // Not sent: they can go into the message again.
    await act(async () => { finish({ ok: false, message: '대화가 끝났습니다' }); await Promise.resolve(); });
    expect(insert().disabled).toBe(false);
    expect(removers().every((button) => !button.disabled)).toBe(true);
  });

  it('starts a review from the toolbar on the changes being viewed', async () => {
    const openReviewStart = vi.fn();
    // The branch since it left main: the review reads the same.
    await show(otherAiReview(), { sequence: 1, section: 'changes', review: { reviewId: OTHER_REVIEW_ID } }, { openReviewStart });
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('base');
    await click('results-start-review');
    expect(openReviewStart).toHaveBeenLastCalledWith({ target: { kind: 'base-branch', baseRef: 'main' } });
    // The working folder: the uncommitted changes.
    const fixture = mixedSelfReview(Date.parse('2026-10-29T00:50:00.000Z'));
    await show(fixture, { sequence: 2, section: 'changes', review: { reviewId: fixture.reviewId } }, { openReviewStart, baseRef: undefined });
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('git');
    await click('results-start-review');
    expect(openReviewStart).toHaveBeenLastCalledWith({ target: { kind: 'uncommitted' } });
  });
});
