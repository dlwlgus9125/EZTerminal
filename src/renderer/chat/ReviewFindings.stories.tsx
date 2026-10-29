import type { Meta, StoryObj } from '@storybook/react-vite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MobileConversationReviewProvider } from '../../../mobile/src/MobileConversationReviewProvider';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileStructuredAgentSession } from '../../../mobile/src/MobileStructuredAgentSession';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../shared/daemon-protocol';
import type { GitDirectoryStatus } from '../../shared/git-status';
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
  applyReviewAction, BRANCH_DIFF, emptyReview, failedReview, inSession, interruptedReview, mixedSelfReview, otherAiReview, queuedOtherReview,
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

const START_OPTIONS: ReviewStartOptions = { self: { providerId: 'claude' }, others: [{ providerId: 'codex' }], baseRef: 'main' };
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
    await waitFor(() => expect(review.querySelector('[data-testid="chat-review-counts"]')).toHaveTextContent('문제 3 · 고침 2 · 무시 1'));
    // Reopen the dismissed one, then dismiss it again.
    await userEvent.click(canvas.getByRole('button', { name: 'src/discount.ts:4 다시 열기' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'src/discount.ts:4 무시' })).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'src/discount.ts:4 무시' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'src/discount.ts:4 다시 열기' })).toBeVisible());
    // A title opens what the reviewer said and how it goes wrong.
    const title = canvas.getByRole('button', { name: /^The loop runs to index/u });
    await userEvent.click(title);
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await expect(review).toHaveTextContent('어떻게 틀리나');
    await showCard(canvasElement);
  },
};
/** Codex, as the other AI, on the branch since main: five problems, and the review conversation can be opened. */
export const CodexOtherComplete: Story = chat('codex-other', otherAiReview);
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
    const notes = (await card(canvasElement)).querySelector<HTMLElement>('.chat-action-card__notes');
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
function StartScreen({ args, options, fixture = emptyReview }: { readonly args: Args; readonly options: ReviewStartOptions; readonly fixture?: (now: number) => ReviewFixture }): JSX.Element {
  const locale = useContext(StoryLocale);
  const [open, setOpen] = useState(true);
  const [items] = useState(() => inSession(fixture(Date.now()), 'review-story-start'));
  return (
    <Desk>
      <StructuredAgentSessionPanel {...panelProps('review-story-start', items, items.state, locale)} items={items.items.filter((entry) => entry.payload?.type !== 'review')}
        reviewStart={{ options, onStart: args.onStart }} />
      <ReviewStartDialog open={open} onOpenChange={setOpen} options={options} onStart={args.onStart} />
    </Desk>
  );
}
/** `/review`, ⋯ › 검토… or Results › 검토: this AI by default, the scope, an optional focus — and the cost of a long Claude conversation. */
export const StartMenu: Story = {
  render: (args) => <StartScreen args={args} options={{ ...START_OPTIONS, contextTokens: 182_000 }} />,
  play: async ({ args }) => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect(dialog.getByRole('radio', { name: /이 AI · Claude/u })).toBeChecked();
    await expect(dialog.getByTestId('review-start-cost')).toHaveTextContent('대화 맥락 약 18만 토큰');
    await userEvent.type(dialog.getByRole('textbox'), '금액 계산과 권한 검사');
    await userEvent.click(dialog.getByRole('button', { name: '검토 시작' }));
    await expect(args.onStart).toHaveBeenCalledWith({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'uncommitted' }, focus: '금액 계산과 권한 검사' });
  },
};
/** Another AI on the branch since main. */
export const StartMenuOtherAi: Story = {
  render: (args) => <StartScreen args={args} options={START_OPTIONS} />,
  play: async () => {
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="review-start-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await userEvent.click(dialog.getByRole('radio', { name: /다른 AI · Codex/u }));
    await userEvent.click(dialog.getByRole('radio', { name: /기준 브랜치와 비교 \(main\)/u }));
    await expect(dialog.queryByTestId('review-start-cost')).toBeNull();
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
  return (
    <Phone width={width} height={height}>
      <MobileStructuredAgentSession {...panelProps(sessionId, host, fixture.state, locale)} folders={undefined}
        onReviewAction={host.onReviewAction} reviewStart={{ options: START_OPTIONS, onStart: args.onStart }} onBack={fn()} />
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
/** Phone: tapping a location opens the review sheet on that problem — ‹ ›, the recorded lines around it, 고치기 / 무시. */
export const PhoneFindingsSheet: Story = {
  render: (args) => <PhoneScreen id="phone-sheet" make={mixedSelfReview} args={args} width={412} height={915} />,
  play: async ({ canvasElement, args }) => {
    const sheet = await openFindingSheet(canvasElement, 'src/cart.ts:5');
    await expect(sheet.querySelector('.conversation-review__position')).toHaveTextContent('문제 3/3');
    await userEvent.click(within(sheet).getByRole('button', { name: '이전 문제' }));
    await expect(sheet.querySelector('.conversation-review__position')).toHaveTextContent('문제 2/3');
    await userEvent.click(within(sheet).getByRole('button', { name: '다음 문제' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'src/cart.ts:5 고치기' }));
    await waitFor(() => expect(args.onReviewAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix' })));
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
