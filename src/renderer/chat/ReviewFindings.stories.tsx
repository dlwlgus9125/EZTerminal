import type { Meta, StoryObj } from '@storybook/react-vite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MobileConversationReviewProvider } from '../../../mobile/src/MobileConversationReviewProvider';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileStructuredAgentSession } from '../../../mobile/src/MobileStructuredAgentSession';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../shared/daemon-protocol';
import type { GitDirectoryStatus } from '../../shared/git-status';
import type { ReviewTarget } from '../../shared/review-findings';
import { AgentResultsOwnerContext, type AgentResultsOwner } from '../agent-results/AgentResultsContext';
import { ConversationResults } from '../agent-results/ConversationResults';
import {
  publishResultsDock, requestResultsNavigation, retractResultsSource, useResultsNavigation, useResultsSource, type ResultsSendResult,
} from '../agent-results/results-source-store';
import type { ResultsServices } from '../agent-results/results-services';
import { AppI18nProvider } from '../i18n';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from '../StructuredAgentSession';
import { DialogPortalContext } from '../ui/Dialog';
import type { ChatReviewAction } from './ChatContext';
import type { ChatSkin } from '../chat-view-state';
import { HighlighterProvider } from './markdown/HighlighterProvider';
import {
  applyReviewAction, BRANCH_DIFF, deletedFileReview, emptyReview, failedReview, fixOutcomesReview, inSession, interruptedReview, mixedSelfReview, otherAiReview,
  queuedOtherReview, slotQueuedReview,
  REVIEW_FILES, REVIEW_ROOT, reviewerConversation, REVIEWER_SESSION, runningSelfReview, truncatedReview, UNCOMMITTED_DIFF, unsupportedReview,
  type FixtureLanguage, type ReviewFixture,
} from './review/review-fixtures';
import { ReviewStartDialog, type ReviewStartOptions, type ReviewStartRequest } from './review/ReviewStartMenu';
import '../index.css';
import '../structured-agent.css';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import '../workbench/phone-screens.css';

/**
 * 시안 (2026-10-29): the review loop — an AI reviews the conversation's changes (this AI in a read-only fork, or
 * another AI in a read-only conversation of its own), the result comes back as one card per review, fixes go to this
 * conversation as ordinary turns, and the changes can be stepped through problem by problem. Everything here is the
 * production renderer fed by fixtures; the host side (running reviews, fix turns) is simulated by `applyReviewAction`.
 * The findings for src/format.ts:2 and src/discount.ts:4 are what Claude and Codex answered in the 2026-10-29 probes.
 */

interface Args {
  readonly onReviewAction: (action: ChatReviewAction) => void;
  readonly onStart: (request: ReviewStartRequest) => void;
  readonly sendNow: (text: string) => Promise<ResultsSendResult>;
}

const meta = {
  title: 'Production/ReviewLoop/Mockup',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: {
    onReviewAction: fn(),
    onStart: fn(),
    sendNow: fn(async (): Promise<ResultsSendResult> => ({ ok: true, queued: true, position: 2 })),
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** The mockups speak Korean; the reference variants follow the Storybook locale. */
const StoryLocale = createContext<'ko' | 'en'>('ko');

function Desk({ children, width = 1100, height = 780 }: { readonly children: ReactNode; readonly width?: number; readonly height?: number }): JSX.Element {
  const locale = useContext(StoryLocale);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <HighlighterProvider>
        <div style={{ width: `min(${String(width + 24)}px, 100vw)`, height: `min(${String(height + 24)}px, 100vh)`, boxSizing: 'border-box', padding: 12, overflow: 'hidden' }}>
          {children}
        </div>
      </HighlighterProvider>
    </AppI18nProvider>
  );
}

/** D8: this AI with the conversation's model and effort, the other with its 단계 연결 review agent. */
const START_OPTIONS: ReviewStartOptions = {
  self: { providerId: 'claude', settingsText: 'Opus 5.5 · 높음' },
  others: [{ providerId: 'codex', settingsText: '검토 에이전트 코드 리뷰어 · gpt-6.1-sol · 높음' }],
  baseRef: 'main',
};
/** One empty list for every render: a fresh `[]` would rebuild the model each time the Results source re-renders the panel. */
const NO_APPROVALS: readonly DaemonApproval[] = [];

function panelProps(sessionId: string, fixture: { readonly items: readonly DaemonTranscriptItem[]; readonly turns: readonly DaemonTurn[] }, state: StructuredAgentSessionPanelProps['state'], locale: 'ko' | 'en'): StructuredAgentSessionPanelProps {
  return {
    sessionId, title: locale === 'ko' ? '가격 표시와 할인 함수' : 'Price display and discounts', providerId: 'claude', providerLabel: 'Claude',
    workspace: { id: 'ws-cart', label: 'review/cart-kit', kind: 'worktree', path: REVIEW_ROOT },
    folders: { primary: REVIEW_ROOT, additional: [], missing: [] },
    model: 'claude-opus-5-5', modelOptions: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
    permissionPreset: 'standard', state, items: fixture.items, turns: fixture.turns, approvals: NO_APPROVALS, queueSettings: true,
    effortSupported: true, reasoningEffort: 'high',
    usage: { fiveHour: { usedPercent: 31 }, weekly: { usedPercent: 24 }, contextPercent: 41 },
    onSend: fn(async () => ({ ok: true as const })), onInterruptAndSend: fn(async () => ({ ok: true as const })),
    onChangeSettings: fn(async () => ({ ok: true as const })), onResolveApproval: fn(async () => ({ ok: true as const })),
    onCancel: fn(async () => ({ ok: true as const })), onDelegate: fn(), onOpenRelatedSession: fn(),
  };
}

/** A host that answers card actions the way the real one will: the transcript grows and the card follows it. */
function useStoryHost(fixture: ReviewFixture, report: (action: ChatReviewAction) => void): {
  readonly items: readonly DaemonTranscriptItem[];
  readonly turns: readonly DaemonTurn[];
  readonly onReviewAction: (action: ChatReviewAction) => void;
} {
  const [state, setState] = useState(() => ({ items: fixture.items, turns: fixture.turns }));
  const onReviewAction = useCallback((action: ChatReviewAction) => {
    report(action);
    setState((current) => applyReviewAction(current, action, Date.now()));
  }, [report]);
  return { ...state, onReviewAction };
}

interface ChatOptions {
  readonly skin?: ChatSkin;
  readonly width?: number;
  readonly height?: number;
  readonly lang?: FixtureLanguage;
}

function ChatScreen({ id, make, args, skin = 'bubble', width = 1100, height = 780 }: ChatOptions & {
  readonly id: string;
  readonly make: (now: number) => ReviewFixture;
  readonly args: Args;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `review-story-${id}`;
  const [fixture] = useState(() => inSession(make(Date.now()), sessionId));
  const host = useStoryHost(fixture, args.onReviewAction);
  return (
    <Desk width={width} height={height}>
      <StructuredAgentSessionPanel {...panelProps(sessionId, host, fixture.state, locale)} skin={skin}
        onReviewAction={host.onReviewAction} reviewStart={{ options: START_OPTIONS, onStart: args.onStart }} />
    </Desk>
  );
}

async function card(canvasElement: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const element = canvasElement.querySelector<HTMLElement>('[data-testid="chat-review-card"]');
    expect(element).not.toBeNull();
    return element!;
  });
}

/** The transcript follows its newest row; scroll it (only it) so the card's top shows. */
async function showCard(canvasElement: HTMLElement): Promise<void> {
  scrollToTop(await card(canvasElement));
}
function scrollToTop(element: HTMLElement): void {
  const scroller = element.closest<HTMLElement>('.chat-viewport__scroll');
  if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
}

function chat(id: string, make: (now: number) => ReviewFixture, options: ChatOptions = {}): Story {
  return { render: (args) => <ChatScreen id={id} make={make} args={args} {...options} />, play: async ({ canvasElement }) => showCard(canvasElement) };
}

// ── 1. The card in the transcript (bubble) ───────────────────────────────────────────────────────────
/** This conversation's AI reviews its own uncommitted changes in a read-only fork: elapsed time and 중지. */
export const SameAiRunning: Story = chat('same-running', runningSelfReview);
/** Codex is asked while Claude still answers: the review waits for the turn to finish (no amber — nothing waits on the person). */
export const OtherAiQueued: Story = chat('other-queued', queuedOtherReview);
/** The conversation is idle but too many conversations already run: the review says it waits for its turn to run, not for a reply. */
export const OtherAiQueuedSlot: Story = {
  ...chat('other-queued-slot', slotQueuedReview),
  play: async ({ canvasElement }) => {
    const review = await card(canvasElement);
    await expect(review).toHaveTextContent('동시에 실행 중인 대화가 많아 차례를 기다립니다.');
    await showCard(canvasElement);
  },
};
/**
 * Claude's result, a while later: the format problem is being fixed (a normal turn of this conversation), the
 * discount one was dismissed, and src/cart.ts changed after the review (검토 뒤에 바뀜).
 */
export const ClaudeComplete: Story = {
  ...chat('claude-complete', mixedSelfReview),
  play: async ({ canvasElement, args }) => {
    const review = await card(canvasElement);
    const canvas = within(review);
    // Fix one: the host takes it as a turn of this conversation, queued behind the running fix.
    await userEvent.click(canvas.getByRole('button', { name: 'src/cart.ts:5 고치기' }));
    await waitFor(() => expect(args.onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix' })));
    // Sent, not fixed yet: counted apart from 고침. The pressed button went; focus is on the problem's title, and the change is said once.
    await waitFor(() => expect(review.querySelector('[data-testid="chat-review-counts"]')).toHaveTextContent('문제 3 · 고치는 중 2 · 무시 1'));
    await waitFor(() => expect(document.activeElement).toBe(canvas.getByRole('button', { name: /^The loop runs to index/u })));
    await expect(canvas.getByTestId('chat-review-announce')).toHaveTextContent('src/cart.ts:5 · 고침 요청됨');
    // Reopen the dismissed one, then dismiss it again.
    await userEvent.click(canvas.getByRole('button', { name: 'src/discount.ts:4 다시 열기' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'src/discount.ts:4 무시' })).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'src/discount.ts:4 무시' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'src/discount.ts:4 다시 열기' })).toBeVisible());
    // A title opens what the reviewer said and how it goes wrong.
    const title = canvas.getByRole('button', { name: /^The loop runs to index/u });
    await userEvent.click(title);
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await expect(review).toHaveTextContent('문제가 생기는 경우');
    await showCard(canvasElement);
  },
};
/** Codex, as the other AI, on the branch since main: five problems, and the review conversation can be opened. */
export const CodexOtherComplete: Story = chat('codex-other', otherAiReview);
/**
 * After a fix turn, each problem says what came of it, never more: 고침 only where the reply said fixed, 안 고침 with
 * the AI's reason (다시 고치기 or 무시), 응답 끝 · 확인 필요 where the reply did not say; 고치는 중 is counted apart.
 */
export const FixOutcomes: Story = {
  ...chat('fix-outcomes', fixOutcomesReview),
  play: async ({ canvasElement }) => {
    const review = await card(canvasElement);
    await expect(within(review).getByTestId('chat-review-counts')).toHaveTextContent('문제 5 · 고침 1 · 고치는 중 1 · 안 고침 1 · 확인 필요 1 · 무시 1');
    await expect(review).toHaveTextContent('이유: 호출하는 쪽이 이미 0.15 같은 비율을 넘깁니다.');
    await expect(within(review).getByRole('button', { name: 'src/discount.ts:4 다시 고치기' })).toBeVisible();
    // 고침 can be reopened (and then fixed again).
    await expect(within(review).getByRole('button', { name: 'src/auth.ts:6 다시 열기' })).toBeVisible();
    await showCard(canvasElement);
  },
};
/** Nothing found. */
export const Empty: Story = chat('empty', emptyReview);
/** The reviewer answered in prose: the reason, its own words on request, and 다시 검토. */
export const Failed: Story = {
  ...chat('failed', failedReview),
  play: async ({ canvasElement }) => {
    const review = await card(canvasElement);
    scrollToTop(review);
    await userEvent.click(within(review).getByRole('button', { name: '원문 보기' }));
    await expect(review.querySelector('.chat-review-raw')).toHaveTextContent('I reviewed the diff.');
  },
};
/** This AI cannot review here; the other one can. */
export const Unsupported: Story = chat('unsupported', unsupportedReview);
/** EZTerminal closed while the review ran. */
export const Interrupted: Story = chat('interrupted', interruptedReview);
/** A large change: more than a card keeps, and three paths outside the working folder. */
export const Truncated: Story = {
  ...chat('truncated', truncatedReview),
  play: async ({ canvasElement }) => {
    const review = await card(canvasElement);
    // The fix message for all 32 does not fit: 모두 고치기 becomes the first batch that does, naming what is left.
    await expect(within(review).getByRole('button', { name: /^처음 \d+개 고치기 · 나머지 \d+개$/u })).toBeVisible();
    const notes = review.querySelector<HTMLElement>('.chat-action-card__notes');
    if (notes) scrollToTop(notes);
  },
};
/** A narrow conversation (520 px): the header wraps, actions drop under the title. */
export const Narrow: Story = chat('narrow', mixedSelfReview, { width: 520, height: 900 });
/** English. */
export const English: Story = {
  render: (args) => <StoryLocale.Provider value="en"><ChatScreen id="english" make={(now) => mixedSelfReview(now, 'en')} args={args} /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => showCard(canvasElement),
};

// ── 2. The same rows in the CLI skin ─────────────────────────────────────────────────────────────────
export const CliSameAiRunning: Story = chat('cli-running', runningSelfReview, { skin: 'cli' });
export const CliOtherAiQueued: Story = chat('cli-queued', queuedOtherReview, { skin: 'cli' });
/** `⏺ 검토(Claude) 문제 3개`, a `⎿` line per problem with 고치기 · 무시, `✻` actions — real buttons, keyboard reachable. */
export const CliClaudeComplete: Story = {
  ...chat('cli-claude-complete', mixedSelfReview, { skin: 'cli' }),
  play: async ({ canvasElement, args }) => {
    const review = await waitFor(() => { const element = canvasElement.querySelector<HTMLElement>('.chat-cli-action-card'); expect(element).not.toBeNull(); return element!; });
    const fix = within(review).getByRole('button', { name: 'src/cart.ts:5 고치기' });
    fix.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(args.onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix' })));
    await showCard(canvasElement);
  },
};
export const CliCodexOtherComplete: Story = chat('cli-codex-other', otherAiReview, { skin: 'cli' });
export const CliFixOutcomes: Story = chat('cli-fix-outcomes', fixOutcomesReview, { skin: 'cli' });
export const CliEmpty: Story = chat('cli-empty', emptyReview, { skin: 'cli' });
export const CliFailed: Story = chat('cli-failed', failedReview, { skin: 'cli' });
export const CliUnsupported: Story = chat('cli-unsupported', unsupportedReview, { skin: 'cli' });
export const CliInterrupted: Story = chat('cli-interrupted', interruptedReview, { skin: 'cli' });
export const CliTruncated: Story = chat('cli-truncated', truncatedReview, { skin: 'cli' });

/** The other AI's own read-only conversation: the request it received is a chip, its answer below. */
export const ReviewerConversation: Story = {
  render: () => <ReviewerScreen />,
};
function ReviewerScreen(): JSX.Element {
  const locale = useContext(StoryLocale);
  return (
    <Desk>
      <StructuredAgentSessionPanel {...panelProps(REVIEWER_SESSION, { items: reviewerConversation(), turns: [] }, 'done', locale)}
        title={locale === 'ko' ? '검토 · 가격 표시와 할인 함수' : 'Review · Price display and discounts'} providerId="codex" providerLabel="Codex"
        model="gpt-6.1-sol" modelOptions={[{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }]} permissionPreset="plan" historyOnly />
    </Desk>
  );
}

// ── 3. Starting a review ─────────────────────────────────────────────────────────────────────────────
function StartScreen({ args, options, fixture = emptyReview, initialTarget }: {
  readonly args: Args;
  readonly options: ReviewStartOptions;
  readonly fixture?: (now: number) => ReviewFixture;
  readonly initialTarget?: ReviewTarget;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const [open, setOpen] = useState(true);
  const [items] = useState(() => inSession(fixture(Date.now()), 'review-story-start'));
  return (
    <Desk>
      <StructuredAgentSessionPanel {...panelProps('review-story-start', items, items.state, locale)} items={items.items.filter((entry) => entry.payload?.type !== 'review')}
        reviewStart={{ options, onStart: args.onStart }} />
      <ReviewStartDialog open={open} onOpenChange={setOpen} options={options} onStart={args.onStart} {...(initialTarget ? { initialTarget } : {})} />
    </Desk>
  );
}
/** `/review`, ⋯ › 검토… or Results › 검토: this AI by default, the scope, an optional focus, and what each reviewer uses (D8). */
export const StartMenu: Story = {
  render: (args) => <StartScreen args={args} options={START_OPTIONS} />,
  play: async ({ args }) => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect(dialog.getByRole('radio', { name: /이 AI · Claude/u })).toBeChecked();
    await expect(dialog.getByTestId('review-start-self-settings')).toHaveTextContent('사용: Opus 5.5 · 높음');
    await userEvent.type(dialog.getByRole('textbox'), '금액 계산과 권한 검사');
    await userEvent.click(dialog.getByRole('button', { name: '검토 시작' }));
    await expect(args.onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, focus: '금액 계산과 권한 검사' });
  },
};
/** From Results › Changes on 기준 브랜치와 비교 (main): the form opens on the branch and says exactly what the review reads. */
export const StartMenuFromBranch: Story = {
  render: (args) => <StartScreen args={args} options={START_OPTIONS} initialTarget={{ kind: 'base-branch', baseRef: 'main' }} />,
  play: async () => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect(dialog.getByRole('radio', { name: /기준 브랜치와 비교/u })).toBeChecked();
    await expect(dialog.getByTestId('review-start-target')).toHaveTextContent('main에서 갈라진 지점 이후 + 커밋 안 한 변경 + 새 파일');
  },
};
/** Another AI on the branch since main. */
export const StartMenuOtherAi: Story = {
  render: (args) => <StartScreen args={args} options={START_OPTIONS} />,
  play: async () => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await userEvent.click(dialog.getByRole('radio', { name: /다른 AI · Codex/u }));
    await userEvent.click(dialog.getByRole('radio', { name: /기준 브랜치와 비교 \(main\)/u }));
    await expect(dialog.getByTestId('review-start-other-settings')).toHaveTextContent('검토 에이전트 코드 리뷰어');
  },
};
/** Not a worktree: comparing with a base branch is shown, disabled, with the reason. */
export const StartMenuNotWorktree: Story = {
  render: (args) => <StartScreen args={args} options={{ self: { providerId: 'claude' }, others: [{ providerId: 'codex' }] }} />,
  play: async () => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect(dialog.getByRole('radio', { name: /기준 브랜치와 비교/u })).toBeDisabled();
    await waitFor(() => expect(dialog.getByText('워크트리에서 일하는 대화에서만 쓸 수 있습니다.')).toBeVisible());
  },
};
/** No review can run here: the reason, and 검토 시작 stays off. */
export const StartMenuDisabled: Story = {
  render: (args) => <StartScreen args={args} options={{ ...START_OPTIONS, disabledReason: '이 작업 폴더는 Git 저장소가 아니라 바뀐 내용을 읽을 수 없습니다.' }} />,
  play: async () => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect(dialog.getByTestId('review-start-reason')).toHaveTextContent('Git 저장소가 아니라');
    await expect(dialog.getByRole('button', { name: '검토 시작' })).toBeDisabled();
  },
};
/** A Codex conversation whose Codex is too old to fork read-only: the other AI is picked, with the reason shown. */
export const StartMenuReviewerUnavailable: Story = {
  render: (args) => <StartScreen args={args} options={{ self: { providerId: 'codex', unavailableReason: 'Codex 0.160은 대화를 읽기 전용으로 분기할 수 없습니다. 0.165 이상으로 업데이트하세요.' }, others: [{ providerId: 'claude' }], baseRef: 'main' }} />,
  play: async () => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect(dialog.getByRole('radio', { name: /이 AI · Codex/u })).toBeDisabled();
    await expect(dialog.getByRole('radio', { name: /다른 AI · Claude/u })).toBeChecked();
    await expect(dialog.getByRole('button', { name: '검토 시작' })).toBeEnabled();
  },
};

// ── 4. The desk: the card leads into Results › Changes ────────────────────────────────────────────────
const STATUS: GitDirectoryStatus = { availability: 'ready', tracked: true, branch: 'review/cart-kit', changes: [], truncated: false };
function storyServices(): ResultsServices {
  return {
    getGitStatus: async () => STATUS,
    getGitDiff: async () => ({ ok: true, text: UNCOMMITTED_DIFF, truncated: false, omissions: [] }),
    getWorktreeBaseDiff: async (_root, baseRef) => ({ ok: true, text: BRANCH_DIFF, truncated: false, omissions: [], baseRef, ahead: 1 }),
    readFilePreview: async (path) => {
      const relative = path.replace(REVIEW_ROOT, '').replace(/^[\\/]+/u, '').replace(/\\/gu, '/');
      const content = REVIEW_FILES[relative];
      return content === undefined ? { ok: false, error: `ENOENT: ${path}` } : { ok: true, kind: 'text', name: relative.split('/').at(-1)!, mime: 'text/plain', content, truncated: false, fileSize: content.length };
    },
  };
}

function DeskScreen({ id, make, args, walk = false, skin = 'bubble' }: {
  readonly id: string;
  readonly make: (now: number) => ReviewFixture;
  readonly args: Args;
  /** Open with the walkthrough at the review's first problem (as the card's 변경에서 차례로 보기 does). */
  readonly walk?: boolean;
  readonly skin?: ChatSkin;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `review-story-${id}`;
  const ownerPanelId = `review-story-panel-${id}`;
  const [fixture] = useState(() => inSession(make(Date.now()), sessionId));
  const host = useStoryHost(fixture, args.onReviewAction);
  const [services] = useState(storyServices);
  const owner = useMemo<AgentResultsOwner>(() => ({ ownerPanelId, open: (request) => { if (request?.target) requestResultsNavigation(ownerPanelId, request.target); } }), [ownerPanelId]);
  const props = panelProps(sessionId, host, fixture.state, locale);
  // What the conversation's dock publishes in the app: the transcript and where it works.
  useEffect(() => {
    publishResultsDock(ownerPanelId, {
      sessionId, title: props.title, providerLabel: 'Claude', workspaceRoot: REVIEW_ROOT, items: host.items, children: [], transcriptFloor: 0,
      loaded: true, baselineSequence: 0, historyOnly: false, turnActive: fixture.state === 'working', baseRef: 'main',
    });
  }, [fixture.state, host.items, ownerPanelId, props.title, sessionId]);
  useEffect(() => () => retractResultsSource(ownerPanelId), [ownerPanelId]);
  useEffect(() => {
    if (!walk) return;
    const review = [...fixture.items].reverse().find((entry) => entry.payload?.type === 'review');
    if (review?.payload?.type !== 'review') return;
    requestResultsNavigation(ownerPanelId, { section: 'changes', review: { reviewId: review.payload.reviewId } });
  }, [walk, fixture.items, ownerPanelId]);
  const source = useResultsSource(ownerPanelId);
  const navigation = useResultsNavigation(ownerPanelId);
  return (
    <Desk width={1400} height={820}>
      <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>
          <AgentResultsOwnerContext.Provider value={owner}>
            <StructuredAgentSessionPanel {...props} skin={skin} onReviewAction={host.onReviewAction} reviewStart={{ options: START_OPTIONS, onStart: args.onStart }} />
          </AgentResultsOwnerContext.Provider>
        </div>
        <div style={{ flex: '0 0 560px', display: 'flex', flexDirection: 'column', minHeight: 0, borderLeft: '1px solid var(--ui-border-subtle)' }}>
          {source?.sessionId && <ConversationResults source={{ ...source, sessionId: source.sessionId }} services={services} {...(navigation ? { navigation } : {})} />}
        </div>
      </div>
    </Desk>
  );
}

/**
 * The desk: the card's `:6` opened Results › Changes on the branch since main, at the first problem; ‹ 이전 · 다음 ›
 * steps on (a line outside the change says so and offers the file), 고치기 · 무시 act on the one on screen.
 */
export const DeskWalkthrough: Story = {
  render: (args) => <DeskScreen id="desk-walk" make={() => otherAiReview()} args={args} walk />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId('results-walkthrough-position')).toHaveTextContent('문제 1/5'), { timeout: 10_000 });
    await userEvent.click(canvas.getByTestId('results-walkthrough-next'));
    await expect(canvas.getByTestId('results-walkthrough-position')).toHaveTextContent('문제 2/5');
    await waitFor(() => expect(canvas.getByTestId('results-walkthrough-outside')).toBeVisible());
    await userEvent.click(canvas.getByTestId('results-walkthrough-previous'));
    await expect(canvas.getByTestId('results-walkthrough-announce')).toHaveTextContent('문제 1/5 · src/auth.ts:6');
    await userEvent.click(canvas.getByTestId('results-walkthrough-fix'));
    await waitFor(() => expect(args.onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix' })));
    await waitFor(() => expect(canvas.getByTestId('results-walkthrough')).toHaveTextContent('고치는 중'));
  },
};
/** The card's location link opens the walkthrough at that problem. */
export const DeskCardOpensWalkthrough: Story = {
  render: (args) => <DeskScreen id="desk-card" make={(now) => mixedSelfReview(now)} args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'src/cart.ts:5 변경에서 보기' }));
    await waitFor(() => expect(canvas.getByTestId('results-walkthrough-position')).toHaveTextContent('문제 3/3'), { timeout: 10_000 });
    await expect(canvas.getByTestId('results-finding-current')).toHaveTextContent('The loop runs to index <= items.length');
  },
};

// ── 5. Android (the shared conversation panel, variant="mobile") ───────────────────────────────────────
function Phone({ children, width, height }: { readonly children: ReactNode; readonly width: number; readonly height: number }): JSX.Element {
  const locale = useContext(StoryLocale);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNavigationHistoryProvider>
        <MobileConversationReviewProvider>
          <MobileToastProvider>
            <div className="phone-i4-frame mobile-workbench-coordinator" data-testid="phone-review-frame" style={{ width, height }}>{children}</div>
          </MobileToastProvider>
        </MobileConversationReviewProvider>
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>
  );
}
function PhoneScreen({ id, make, args, width, height }: {
  readonly id: string;
  readonly make: (now: number) => ReviewFixture;
  readonly args: Args;
  readonly width: number;
  readonly height: number;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `review-story-${id}`;
  const [fixture] = useState(() => inSession(make(Date.now()), sessionId));
  const host = useStoryHost(fixture, args.onReviewAction);
  const [openFiles] = useState(() => fn());
  return (
    <Phone width={width} height={height}>
      <MobileStructuredAgentSession {...panelProps(sessionId, host, fixture.state, locale)} folders={undefined}
        onReviewAction={host.onReviewAction} reviewStart={{ options: START_OPTIONS, onStart: args.onStart }} onBack={fn()} onOpenProjectFiles={openFiles} />
    </Phone>
  );
}
/** Phone 360×800: the card in the transcript; a problem stacks (marks, then its title across the width); every action is a thumb target. */
export const PhoneCard360: Story = {
  render: (args) => <PhoneScreen id="phone-360" make={mixedSelfReview} args={args} width={360} height={800} />,
  play: async ({ canvasElement }) => {
    const review = await card(canvasElement);
    scrollToTop(review);
    const first = review.querySelector<HTMLElement>('[data-testid="chat-review-finding"]')!;
    const severity = first.querySelector<HTMLElement>('.chat-review-severity')!.getBoundingClientRect();
    const title = first.querySelector<HTMLElement>('.chat-review-finding__title')!.getBoundingClientRect();
    await expect(title.top).toBeGreaterThanOrEqual(severity.bottom);
    await expect(title.width).toBeGreaterThan(review.getBoundingClientRect().width * 0.7);
  },
};
/** Phone 412×915: Codex's review as the other AI. */
export const PhoneCard412: Story = {
  render: (args) => <PhoneScreen id="phone-412" make={() => otherAiReview()} args={args} width={412} height={915} />,
  play: async ({ canvasElement }) => showCard(canvasElement),
};
async function openFindingSheet(canvasElement: HTMLElement, where: string): Promise<HTMLElement> {
  const review = await card(canvasElement);
  await userEvent.click(within(review).getByRole('button', { name: `${where} 변경에서 보기` }));
  return waitFor(() => {
    const sheet = document.querySelector<HTMLElement>('[data-testid="conversation-change-review"][data-mode="findings"]');
    expect(sheet).not.toBeNull();
    return sheet!;
  });
}
/**
 * Phone: tapping a location opens the review sheet on that problem — ‹ ›, 고치기 / 무시. The cart loop was rewritten after
 * the review, so its line 5 holds other code now: 이 줄을 찾을 수 없음, the lines the review read (unmarked) and the
 * way to the files, never a mark on today's line 5. After 고치기 the buttons go; focus moves to the problem's title.
 */
export const PhoneFindingsSheet: Story = {
  render: (args) => <PhoneScreen id="phone-sheet" make={mixedSelfReview} args={args} width={412} height={915} />,
  play: async ({ canvasElement, args }) => {
    const sheet = await openFindingSheet(canvasElement, 'src/cart.ts:5');
    await expect(sheet.querySelector('.conversation-review__position')).toHaveTextContent('문제 3/3');
    await userEvent.click(within(sheet).getByRole('button', { name: '이전 문제' }));
    await expect(sheet.querySelector('.conversation-review__position')).toHaveTextContent('문제 2/3');
    await userEvent.click(within(sheet).getByRole('button', { name: '다음 문제' }));
    await expect(within(sheet).getByTestId('conversation-review-missing')).toHaveTextContent('이 줄을 찾을 수 없음');
    await expect(within(sheet).getByRole('button', { name: '파일에서 보기' })).toBeVisible();
    await expect(sheet.querySelector('.conversation-review__line[data-focus]')).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: 'src/cart.ts:5 고치기' }));
    await waitFor(() => expect(args.onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix' })));
    await waitFor(() => expect(document.activeElement).toBe(sheet.querySelector('[data-finding-title]')));
    await expect(within(sheet).getByTestId('conversation-review-status')).toHaveTextContent('src/cart.ts:5 · 고침 요청됨');
  },
};
/** Phone: the discount helper was deleted after the review — 파일이 지워짐, the lines the review read, no way to a file. */
export const PhoneFindingsSheetDeleted: Story = {
  render: (args) => <PhoneScreen id="phone-sheet-deleted" make={deletedFileReview} args={args} width={412} height={915} />,
  play: async ({ canvasElement }) => {
    const sheet = await openFindingSheet(canvasElement, 'src/discount.ts:4');
    await expect(within(sheet).getByTestId('conversation-review-deleted')).toHaveTextContent('파일이 지워짐');
    await expect(sheet.querySelector('.conversation-review__line[data-focus]')).toBeNull();
    await expect(within(sheet).queryByRole('button', { name: '파일에서 보기' })).toBeNull();
  },
};
/** Phone: a problem whose line the recorded change still holds — the lines around it, its line marked (being fixed: no buttons). */
export const PhoneFindingsSheetLines: Story = {
  render: (args) => <PhoneScreen id="phone-sheet-lines" make={mixedSelfReview} args={args} width={412} height={915} />,
  play: async ({ canvasElement }) => {
    const sheet = await openFindingSheet(canvasElement, 'src/format.ts:2');
    await expect(sheet.querySelector('.conversation-review__line[data-focus]')).toHaveTextContent('const dollars = cents / 10;');
  },
};
/**
 * Phone 360×800: comments without Shift. A tap starts a range (범위 선택 중, with 취소), the next tap ends it and the
 * comment joins the tray, which sends them together; every line, the selection's controls and the tray are 44px targets.
 */
export const PhoneComments360: Story = {
  render: (args) => <PhoneScreen id="phone-comments-360" make={mixedSelfReview} args={args} width={360} height={800} />,
  play: async ({ canvasElement }) => {
    await card(canvasElement);
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('[data-testid="structured-agent-review-changes"]')!);
    const sheet = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="conversation-change-review"][data-mode="changes"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const line = (text: string): HTMLButtonElement => [...sheet.querySelectorAll<HTMLButtonElement>('button.conversation-review__line')].find((element) => element.textContent?.includes(text))!;
    await userEvent.click(line('+  for (let i = 0'));
    await userEvent.click(line('+    total += items[i]'));
    await userEvent.type(within(sheet).getByTestId('conversation-review-note'), '<로 돌려 주세요');
    await userEvent.click(within(sheet).getByTestId('conversation-review-add'));
    await expect(sheet.querySelectorAll('.results-tray__item')).toHaveLength(1);
    // The next range is being tapped out: its first line and 취소.
    await userEvent.click(line('   let total = 0;'));
    await expect(within(sheet).getByTestId('conversation-review-selecting')).toHaveTextContent('범위 선택 중');
    const targets = [
      ...sheet.querySelectorAll<HTMLElement>('button.conversation-review__line'),
      within(sheet).getByTestId('conversation-review-selecting-cancel'),
      ...sheet.querySelectorAll<HTMLElement>('.results-tray button'),
    ];
    // 44 CSS px (2.75rem); at some UI scales layout lands a hair under it (43.99997).
    for (const target of targets) await expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.99);
  },
};
/**
 * Phone 360×800: the same sheet on the narrowest supported screen, on the excerpt fallback (Codex's branch review). Long
 * lines scroll sideways in a focusable region, like chat code blocks; 줄 바꿈 wraps them (pressed here).
 */
export const PhoneFindingsSheet360: Story = {
  render: (args) => <PhoneScreen id="phone-sheet-360" make={() => otherAiReview()} args={args} width={360} height={800} />,
  play: async ({ canvasElement }) => {
    const sheet = await openFindingSheet(canvasElement, 'src/auth.ts:6');
    const region = within(sheet).getByRole('region', { name: 'src/auth.ts:6 검토 때 읽은 줄' });
    await expect(region).toHaveAttribute('tabindex', '0');
    await userEvent.click(within(sheet).getByRole('button', { name: '줄 바꿈' }));
    await expect(within(sheet).getByRole('button', { name: '줄 바꿈' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1));
  },
};

// ── Reference variants (the Storybook locale picks the language) ───────────────────────────────────────
function ReferenceFrame({ locale, children }: { readonly locale: 'ko' | 'en'; readonly children: ReactNode }): JSX.Element {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <StoryLocale.Provider value={locale}>
      {portal && <DialogPortalContext.Provider value={portal}>{children}</DialogPortalContext.Provider>}
      <div ref={setPortal} />
    </StoryLocale.Provider>
  );
}
function reference(story: Story, play?: Story['play']): Story {
  const render = story.render!;
  return { ...story, play, render: (args, context) => <ReferenceFrame locale={context.globals.locale === 'en' ? 'en' : 'ko'}>{render(args, context)}</ReferenceFrame> };
}
const showCardPlay: Story['play'] = async ({ canvasElement }) => showCard(canvasElement);
export const ClaudeCompleteReference = reference(ClaudeComplete, showCardPlay);
export const CliClaudeCompleteReference = reference(CliClaudeComplete, showCardPlay);
export const CodexOtherCompleteReference = reference(CodexOtherComplete, showCardPlay);
export const StartMenuReference = reference(StartMenu);
export const DeskWalkthroughReference: Story = {
  ...reference(DeskWalkthrough),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByTestId('results-walkthrough')).toBeVisible(), { timeout: 10_000 });
  },
};
export const PhoneCard360Reference: Story = { ...reference(PhoneCard360), play: PhoneCard360.play };
