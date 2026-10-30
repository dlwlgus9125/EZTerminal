import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useMemo, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { DaemonTranscriptItem, DaemonTurn } from '../../shared/daemon-protocol';
import type { GitDirectoryStatus } from '../../shared/git-status';
import type { ChatReviewAction } from '../chat/ChatContext';
import { HighlighterProvider } from '../chat/markdown/HighlighterProvider';
import { buildChatModel } from '../chat/model/build-chat-model';
import {
  applyReviewAction, BRANCH_DIFF, deletedFileReview, inSession, mixedSelfReview, otherAiReview, REVIEW_FILES, REVIEW_ROOT, UNCOMMITTED_DIFF, walkFindingId,
  type ReviewFixture,
} from '../chat/review/review-fixtures';
import { AppI18nProvider } from '../i18n';
import { ConversationResults } from './ConversationResults';
import type { ResultsNavigation, ResultsReviewStart, ResultsSendResult, ResultsSource } from './results-source-store';
import type { ResultsServices } from './results-services';
import '../index.css';
import '../structured-agent.css';

/**
 * 시안 (2026-10-29), Results › Changes for the review loop: stepping through an AI review problem by problem, sending
 * collected comments straight to the conversation (queued behind a running turn), and comparing a worktree with its
 * base branch. The Results tab alone, fed by the same fixtures as Production/ReviewLoop/Mockup.
 */

interface Args {
  readonly reviewAction: (action: ChatReviewAction) => void;
  readonly sendNow: (text: string) => Promise<ResultsSendResult>;
  readonly openReviewStart: (start?: ResultsReviewStart) => void;
}

const meta = {
  title: 'Production/ReviewLoop/Results',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: {
    reviewAction: fn(),
    sendNow: fn(async (): Promise<ResultsSendResult> => ({ ok: true, queued: true, position: 2 })),
    openReviewStart: fn(),
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const STATUS: GitDirectoryStatus = { availability: 'ready', tracked: true, branch: 'review/cart-kit', changes: [], truncated: false };

function services(): ResultsServices {
  return {
    getGitStatus: async () => STATUS,
    getGitDiff: async () => ({ ok: true, text: UNCOMMITTED_DIFF, truncated: false, omissions: [] }),
    getWorktreeBaseDiff: async () => ({ ok: true, text: BRANCH_DIFF, truncated: false, omissions: [], baseRef: 'main', mergeBase: 'a1b2c3d', ahead: 1 }),
    readFilePreview: async (path) => {
      const relative = path.replace(REVIEW_ROOT, '').replace(/^[\\/]+/u, '').replace(/\\/gu, '/');
      const content = REVIEW_FILES[relative];
      return content === undefined ? { ok: false, error: `ENOENT: ${path}` } : { ok: true, kind: 'text', name: relative.split('/').at(-1)!, mime: 'text/plain', content, truncated: false, fileSize: content.length };
    },
  };
}

function Results({ id, make, args, review, findingIndex, worktree = true, turnActive = false, locale = 'ko', width = 560, height = '100vh' }: {
  readonly id: string;
  readonly make: (now: number) => ReviewFixture;
  readonly args: Args;
  /** Step through the fixture's review (from its n-th problem). */
  readonly review?: boolean;
  readonly findingIndex?: number;
  readonly worktree?: boolean;
  readonly turnActive?: boolean;
  readonly locale?: 'ko' | 'en';
  /** The Results tab's width: 560 beside a conversation, 385 in a narrow group. */
  readonly width?: number;
  readonly height?: number | string;
}): JSX.Element {
  const sessionId = `review-results-${id}`;
  const [fixture] = useState(() => inSession(make(Date.parse('2026-10-29T00:50:00.000Z')), sessionId));
  const [state, setState] = useState<{ readonly items: readonly DaemonTranscriptItem[]; readonly turns: readonly DaemonTurn[] }>(() => ({ items: fixture.items, turns: fixture.turns }));
  const [hostServices] = useState(services);
  const reviewAction = useCallback((action: ChatReviewAction) => {
    args.reviewAction(action);
    setState((current) => applyReviewAction(current, action, Date.now()));
  }, [args]);
  const model = useMemo(() => buildChatModel({ items: state.items, turns: state.turns }), [state]);
  const source: ResultsSource & { sessionId: string } = {
    ownerPanelId: `review-results-panel-${id}`, sessionId, title: '가격 표시와 할인 함수', providerLabel: 'Claude', workspaceRoot: REVIEW_ROOT,
    items: state.items, model, children: [], transcriptFloor: 0, loaded: true, baselineSequence: 0, historyOnly: false, turnActive,
    ...(worktree ? { baseRef: 'main', workspaceId: 'ws-cart' } : {}),
    insertIntoDraft: fn(), sendNow: args.sendNow, reviewAction, openReviewStart: args.openReviewStart, focusDecision: fn(),
  };
  const [navigation] = useState<ResultsNavigation>(() => ({
    sequence: 1, section: 'changes',
    ...(review ? { review: { reviewId: fixture.reviewId, ...(findingIndex !== undefined ? { findingId: walkFindingId(fixture, findingIndex)! } : {}) } } : {}),
  }));
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <HighlighterProvider>
        <div style={{ width, height, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--ui-border-subtle)' }}>
          <ConversationResults source={source} services={hostServices} navigation={navigation} />
        </div>
      </HighlighterProvider>
    </AppI18nProvider>
  );
}

const position = (canvasElement: HTMLElement): Promise<HTMLElement> => waitFor(() => {
  const element = within(canvasElement).getByTestId('results-walkthrough-position');
  expect(element).toBeVisible();
  return element;
}, { timeout: 10_000 });

/** The review on the branch since main, at its first problem: the strip, the problem under its line, the file list's counts. */
export const Walkthrough: Story = {
  render: (args) => <Results id="walk" make={() => otherAiReview()} args={args} review />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await position(canvasElement)).toHaveTextContent('문제 1/5');
    await userEvent.click(canvas.getByRole('button', { name: '다음 문제' }));
    await expect(canvas.getByTestId('results-walkthrough-position')).toHaveTextContent('문제 2/5');
    await userEvent.click(canvas.getByRole('button', { name: '다음 문제' }));
    await expect(canvas.getByTestId('results-walkthrough-announce')).toHaveTextContent('문제 3/5 · src/cart.ts:5 · 높음');
    await userEvent.click(canvas.getByRole('button', { name: 'src/cart.ts:5 무시' }));
    await waitFor(() => expect(args.reviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dismiss' })));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'src/cart.ts:5 다시 열기' })).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: '이전 문제' }));
    await expect(canvas.getByTestId('results-walkthrough-position')).toHaveTextContent('문제 2/5');
  },
};
/**
 * The strip stays at the top of the Changes scroll area while the change scrolls under it (wide and narrow), and the
 * problem's line it steps to is never hidden beneath it.
 */
async function stripStaysInView(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await position(canvasElement);
  const strip = canvas.getByTestId('results-walkthrough');
  const scroller = strip.closest<HTMLElement>('.conversation-results__panel')!;
  await userEvent.click(canvas.getByTestId('results-walkthrough-next'));
  await userEvent.click(canvas.getByTestId('results-walkthrough-next'));
  scroller.scrollTop = scroller.scrollHeight;
  await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
  const inView = (): void => {
    const box = scroller.getBoundingClientRect();
    const rect = strip.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(box.top - 1);
    expect(rect.bottom).toBeLessThanOrEqual(box.bottom + 1);
  };
  await waitFor(inView);
  // Stepping back to the first problem scrolls its line into view below the strip, not under it.
  await userEvent.click(canvas.getByTestId('results-walkthrough-previous'));
  await userEvent.click(canvas.getByTestId('results-walkthrough-previous'));
  await expect(canvas.getByTestId('results-walkthrough-position')).toHaveTextContent('문제 1/5');
  await waitFor(() => {
    const line = canvasElement.querySelector<HTMLElement>('.results-patch__line[data-focus="true"]');
    expect(line).not.toBeNull();
    expect(line!.getBoundingClientRect().top).toBeGreaterThanOrEqual(strip.getBoundingClientRect().bottom - 1);
  });
  inView();
}
/** Beside the conversation (560 px), scrolled down: 문제 n/m · 이전/다음 · 고치기/무시 · 닫기 stay at the top. */
export const WalkthroughScrolled: Story = {
  render: (args) => <Results id="walk-scrolled" make={() => otherAiReview()} args={args} review height={560} />,
  play: async ({ canvasElement }) => stripStaysInView(canvasElement),
};
/** The same in a narrow group (385 px). */
export const WalkthroughScrolledNarrow: Story = {
  render: (args) => <Results id="walk-scrolled-narrow" make={() => otherAiReview()} args={args} review width={385} height={640} />,
  play: async ({ canvasElement }) => stripStaysInView(canvasElement),
};
/** A problem on a line the change does not touch: 변경 범위 밖, and the file at that line. */
export const WalkthroughOutside: Story = {
  render: (args) => <Results id="walk-outside" make={() => otherAiReview()} args={args} review findingIndex={1} />,
  play: async ({ canvasElement }) => {
    await expect(await position(canvasElement)).toHaveTextContent('문제 2/5');
    await expect(within(canvasElement).getByTestId('results-walkthrough-outside')).toHaveTextContent('src/cart.ts:1 줄은 지금 보는 변경에 없습니다.');
  },
};
/**
 * The AI's own records (이 대화 전체): a later turn rewrote the cart loop, so line 5 holds other code — 이 줄을 찾을 수
 * 없음, the lines the review read and 파일에서 보기; nothing is marked in the diff.
 */
export const WalkthroughMissing: Story = {
  render: (args) => <Results id="walk-missing" make={(now) => mixedSelfReview(now)} args={args} review findingIndex={2} worktree={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await position(canvasElement)).toHaveTextContent('문제 3/3');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: '변경 범위' }), 'all');
    await waitFor(() => expect(canvas.getByTestId('results-walkthrough-missing')).toHaveTextContent('이 줄을 찾을 수 없음'));
    await expect(canvasElement.querySelector('.results-patch__line[data-focus="true"]')).toBeNull();
    await expect(canvas.getByTestId('results-walkthrough-announce')).toHaveTextContent('이 줄을 찾을 수 없음');
  },
};
/**
 * A later turn deleted src/discount.ts (이 대화 전체): 파일이 지워짐 and the lines the review read — never the line in the
 * older patch that created the file, and no way to a file that is gone.
 */
export const WalkthroughDeleted: Story = {
  render: (args) => <Results id="walk-deleted" make={(now) => deletedFileReview(now)} args={args} review findingIndex={1} worktree={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await position(canvasElement)).toHaveTextContent('문제 2/3');
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: '변경 범위' }), 'all');
    await waitFor(() => expect(canvas.getByTestId('results-walkthrough-deleted')).toHaveTextContent('파일이 지워짐'));
    await expect(canvasElement.querySelector('.results-patch__line[data-focus="true"]')).toBeNull();
    await expect(within(canvas.getByTestId('results-walkthrough-deleted')).queryByRole('button')).toBeNull();
  },
};
/** Claude's uncommitted-changes review in the working folder scope, on the problem being fixed. */
export const WalkthroughUncommitted: Story = {
  render: (args) => <Results id="walk-uncommitted" make={(now) => mixedSelfReview(now)} args={args} review worktree={false} />,
  play: async ({ canvasElement }) => {
    await expect(await position(canvasElement)).toHaveTextContent('문제 1/3');
    await expect(within(canvasElement).getByTestId('results-walkthrough')).toHaveTextContent('고치는 중');
  },
};

async function addComment(canvasElement: HTMLElement, note: string): Promise<void> {
  const canvas = within(canvasElement);
  const line = await waitFor(() => { const element = canvasElement.querySelector<HTMLButtonElement>('.results-patch__line[data-focus="true"]'); expect(element).not.toBeNull(); return element!; }, { timeout: 10_000 });
  await userEvent.click(line);
  await userEvent.click(canvas.getByRole('button', { name: '의견 추가' }));
  await userEvent.type(canvas.getByRole('textbox', { name: /의견/u }), note);
  await userEvent.click(canvas.getAllByRole('button', { name: '의견 추가' }).at(-1)!);
}
/** Comments go straight to the conversation; while it answers, the button says they join the queue. */
export const CommentSend: Story = {
  render: (args) => <Results id="send" make={() => otherAiReview()} args={args} review turnActive />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await addComment(canvasElement, '역할 순서를 비교하기 전에 알 수 없는 역할은 거부해 주세요');
    const send = canvas.getByTestId('results-send-comments');
    await expect(send).toHaveTextContent('보내기 · 대기열에 추가');
    await userEvent.click(send);
    await waitFor(() => expect(args.sendNow).toHaveBeenCalledWith(expect.stringContaining('검토 의견 (1)')));
    await waitFor(() => expect(canvas.getByTestId('results-send-status')).toHaveTextContent('대기열 2번째'));
  },
};
/** The host did not say where in the queue: 대기열에 추가됨, no number made up. */
export const CommentQueued: Story = {
  args: { sendNow: fn(async (): Promise<ResultsSendResult> => ({ ok: true, queued: true })) },
  render: (args) => <Results id="send-queued" make={() => otherAiReview()} args={args} review turnActive />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await addComment(canvasElement, '역할 순서를 비교하기 전에 알 수 없는 역할은 거부해 주세요');
    await userEvent.click(canvas.getByTestId('results-send-comments'));
    await waitFor(() => expect(canvas.getByTestId('results-send-status')).toHaveTextContent('대기열에 추가됨'));
  },
};
/** Not sent: the reason, and the comments stay. */
export const CommentSendFailed: Story = {
  args: { sendNow: fn(async (): Promise<ResultsSendResult> => ({ ok: false, message: 'PC와 연결이 끊겼습니다' })) },
  render: (args) => <Results id="send-failed" make={() => otherAiReview()} args={args} review />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await addComment(canvasElement, '여기도 확인해 주세요');
    await userEvent.click(canvas.getByTestId('results-send-comments'));
    await waitFor(() => expect(canvas.getByTestId('results-send-error')).toHaveTextContent('보내지 못했습니다: PC와 연결이 끊겼습니다'));
    await expect(canvasElement.querySelectorAll('.results-tray__item')).toHaveLength(1);
  },
};
/** 기준 브랜치와 비교 (main): commits, uncommitted and new files since the worktree left main; 검토 starts on the same. */
export const BranchScope: Story = {
  render: (args) => <Results id="branch" make={() => otherAiReview()} args={args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: '변경 범위' }), 'base');
    await waitFor(() => expect(canvas.getByText('커밋 안 한 변경 포함 · main에서 갈라진 지점부터 · 앞선 커밋 1', { exact: false })).toBeVisible());
    await expect(canvas.getByRole('button', { name: /^src\/auth\.ts/u })).toBeVisible();
    await userEvent.click(canvas.getByTestId('results-start-review'));
    await expect(args.openReviewStart).toHaveBeenCalledWith({ target: { kind: 'base-branch', baseRef: 'main' } });
  },
};
/** Not a worktree: no base-branch scope; 검토 starts a review from here. */
export const NotWorktree: Story = {
  render: (args) => <Results id="local" make={() => otherAiReview()} args={args} worktree={false} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const scope = await canvas.findByRole('combobox', { name: '변경 범위' });
    await expect([...scope.querySelectorAll('option')].map((option) => option.value)).not.toContain('base');
    await userEvent.click(canvas.getByTestId('results-start-review'));
    await expect(args.openReviewStart).toHaveBeenCalledTimes(1);
  },
};
/** English. */
export const WalkthroughEnglish: Story = {
  render: (args) => <Results id="walk-en" make={() => otherAiReview()} args={args} review locale="en" />,
};
