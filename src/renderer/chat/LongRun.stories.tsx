import type { Meta, StoryObj } from '@storybook/react-vite';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MobileFeedView } from '../../../mobile/src/feed/MobileFeedView';
import type { FeedConversation, FeedWaitingItem } from '../../../mobile/src/feed/feed-model';
import { MobileConversationReviewProvider } from '../../../mobile/src/MobileConversationReviewProvider';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileStructuredAgentSession } from '../../../mobile/src/MobileStructuredAgentSession';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import type { ChatComposerDraft } from '../../shared/chat-message';
import { resumeDue, type LongRunSettings } from '../../shared/long-run';
import { TURN_WRAP_UP_CAPABILITY, type TurnWrapUpSettings } from '../../shared/turn-wrap-up';
import type { CapabilityAccess, LongRunAccess, TurnWrapUpAccess } from '../capability-access';
import type { ChatSkin } from '../chat-view-state';
import { conversationQueue } from '../conversation-queue';
import { AppI18nProvider } from '../i18n';
import { LiveList } from '../shell/LiveList';
import { shellSnapshot } from '../shell/shell-fixtures';
import { SettingsFixture, storyCapabilities } from '../shell/tool-screen-fixtures';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps, type StructuredAgentUiResult } from '../StructuredAgentSession';
import { DialogPortalContext } from '../ui/Dialog';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { SidebarShell } from '../workbench/SidebarShell';
import type { ChatLongRunAction } from './ChatContext';
import { chatCopy, formatClock } from './copy';
import {
  acceptSteer, applyLongRunAction, clockSends, dropSteer, inLongSession, landSteer, LIMIT_STOP, limitStory, LINE_AT, listConversations, listWaiting, LONG_ROOT, LATER_RESET_AT, personSends, queueAside, queueSteer, RESET_AT, RESUME_AT, RETRY_AT, settingOff, steerStory, WEEKLY_RESUME_AT,
  type LongLanguage, type LongProvider, type LongRunFixture,
} from './long-run/long-run-fixtures';
import { limitStatus } from './long-run/long-run-presentation';
import { HighlighterProvider } from './markdown/HighlighterProvider';
import { latestLimit } from './model/long-run-rows';
import '../index.css';
import '../structured-agent.css';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import '../workbench/phone-screens.css';
import '../workbench/workbench.css';
import '../shell/shell.css';

/**
 * Long-run continuity. A: Enter while a turn runs puts the message into that turn instead of stopping it, and falls back
 * to the queue when it cannot land. B: a turn that stopped at a usage limit gets one card, and the app sends "Continue."
 * when the reset passes. C: where a waiting conversation shows. D: the one setting. E: the phone. Everything here is the
 * production renderer reading the rows a host writes; only the host is simulated. No real limit was ever seen: the shapes
 * behind the states come from stub runs of the real CLIs and Claude's real records.
 */

interface Args {
  readonly onLongRunAction: (action: ChatLongRunAction) => void;
  /** The app sent "Continue." by itself: what the virtual clock checks never happens after a cancel. */
  readonly onResumeSent: (turnId: string) => void;
  readonly onSteer: (prompt: string) => void;
  readonly onSend: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly onInterruptAndSend: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly onOpenRelatedSession: (sessionId: string) => void;
}

const meta = {
  title: 'Production/LongRun/Mockup',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: {
    onLongRunAction: fn(),
    onResumeSent: fn(),
    onSteer: fn(),
    onSend: fn(async (): Promise<StructuredAgentUiResult> => ({ ok: true })),
    onInterruptAndSend: fn(async (): Promise<StructuredAgentUiResult> => ({ ok: true })),
    onOpenRelatedSession: fn(),
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** The mockups speak Korean; the reference variants follow the Storybook locale. */
const StoryLocale = createContext<LongLanguage>('ko');

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

function Phone({ children, width, height }: { readonly children: ReactNode; readonly width: number; readonly height: number }): JSX.Element {
  const locale = useContext(StoryLocale);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNavigationHistoryProvider>
        <MobileConversationReviewProvider>
          <MobileToastProvider>
            <div className="phone-i4-frame mobile-workbench-coordinator" data-testid="phone-long-run-frame" style={{ width, height }}>{children}</div>
          </MobileToastProvider>
        </MobileConversationReviewProvider>
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>
  );
}

// ── The story host: answers the way the real one will ─────────────────────────────────────────────────
const SETTLING: ReadonlySet<ChatLongRunAction['kind']> = new Set(['limit-try-now', 'limit-resume']);
/** A play moves time with this: the host checks its schedule, as the app will when its timer fires. */
const CLOCK = 'long-run-story-clock';
const passTime = (iso: string): void => { window.dispatchEvent(new CustomEvent<number>(CLOCK, { detail: Date.parse(iso) })); };

interface StoryHost {
  readonly state: LongRunFixture;
  readonly onAction: (action: ChatLongRunAction) => void;
  readonly onSend: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly steer: NonNullable<NonNullable<StructuredAgentSessionPanelProps['longRun']>['steer']>;
  readonly settingOff: () => void;
}

function useStoryHost(fixture: LongRunFixture, provider: LongProvider, args: Args, landAfter?: number, personRefused = false): StoryHost {
  const [state, setState] = useState(fixture);
  const timers = useRef<number[]>([]);
  const next = useRef(1);
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => () => { timers.current.forEach((timer) => window.clearTimeout(timer)); }, []);
  useEffect(() => {
    const tick = (event: Event): void => {
      const limit = latestLimit(latest.current.items);
      if (!limit || !resumeDue(limit, (event as CustomEvent<number>).detail)) return;
      args.onResumeSent(limit.turnId);
      // Twice in one tick would be a double send: the state a send leaves must not be due.
      latest.current = clockSends(latest.current);
      setState(latest.current);
    };
    window.addEventListener(CLOCK, tick);
    return () => window.removeEventListener(CLOCK, tick);
  }, [args]);
  const onAction = useCallback((action: ChatLongRunAction) => {
    args.onLongRunAction(action);
    setState((current) => applyLongRunAction(current, action, false));
    if (SETTLING.has(action.kind)) timers.current.push(window.setTimeout(() => setState((current) => applyLongRunAction(current, action, true)), 900));
  }, [args]);
  const onSteer = useCallback(async (prompt: string): Promise<StructuredAgentUiResult> => {
    args.onSteer(prompt);
    const id = `steer-sent-${String(next.current)}`;
    next.current += 1;
    setState((current) => acceptSteer(current, prompt, id));
    if (landAfter !== undefined) timers.current.push(window.setTimeout(() => setState((current) => landSteer(current, id, provider)), landAfter));
    return { ok: true };
  }, [args, landAfter, provider]);
  const onSend = useCallback(async (prompt: string): Promise<StructuredAgentUiResult> => {
    const result = await args.onSend(prompt);
    setState((current) => personSends(queueAside(current, prompt), prompt, personRefused));
    return result;
  }, [args, personRefused]);
  const turnOff = useCallback(() => setState((current) => settingOff(current)), []);
  const steer = useMemo(() => ({
    onSteer,
    ...(state.steered ? { messages: state.steered } : {}),
    onToQueue: (message: { readonly id: string }): void => setState((current) => queueSteer(current, message.id)),
    onToBox: (message: { readonly id: string }): void => setState((current) => dropSteer(current, message.id)),
  }), [onSteer, state.steered]);
  return { state, onAction, onSend, steer, settingOff: turnOff };
}

const MODELS: Readonly<Record<LongProvider, { readonly id: string; readonly label: string }>> = {
  claude: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  codex: { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
};
const TITLE = { ko: '장바구니 테스트 고치기', en: 'Fix the cart tests' } as const;
const PARENT = { ko: '장바구니 전체 정리', en: 'Clean up the cart' } as const;

function panelProps(sessionId: string, host: StoryHost, provider: LongProvider, locale: LongLanguage, args: Args): StructuredAgentSessionPanelProps {
  const { state } = host;
  const limit = latestLimit(state.items);
  const status = limit && limit.phase !== 'skipped' ? limitStatus(limit, chatCopy(locale).longRun.limit, locale) : undefined;
  const clockRuns = limit !== undefined && (limit.phase === 'waiting' || limit.phase === 'scheduled' || limit.phase === 'retrying');
  const queueItems = conversationQueue(sessionId, state.turns, state.items);
  return {
    queuedCount: queueItems.length, queueItems, onQueueAction: fn(async () => ({ ok: true as const })),
    sessionId, title: TITLE[locale], providerId: provider, providerLabel: provider === 'claude' ? 'Claude' : 'Codex',
    workspace: { id: 'ws-cart', label: 'cart-kit', kind: 'local', path: LONG_ROOT },
    folders: { primary: LONG_ROOT, additional: [], missing: [] },
    model: MODELS[provider].id, modelOptions: [MODELS[provider]],
    permissionPreset: 'standard', state: state.state, items: state.items, turns: state.turns, approvals: state.approvals ?? [], queueSettings: true,
    approvalResponses: true, effortSupported: true, reasoningEffort: 'high',
    usage: limit ? { fiveHour: { usedPercent: 100 }, weekly: { usedPercent: limit.window === 'weekly' ? 100 : 38 }, contextPercent: 41 } : { fiveHour: { usedPercent: 61 }, weekly: { usedPercent: 24 }, contextPercent: 41 },
    onSend: host.onSend, onInterruptAndSend: args.onInterruptAndSend,
    onChangeSettings: fn(async () => ({ ok: true as const })), onResolveApproval: fn(async () => ({ ok: true as const })),
    onCancel: fn(async () => ({ ok: true as const })), onOpenRelatedSession: args.onOpenRelatedSession,
    ...(status ? { statusLabel: status.text } : {}),
    longRun: { ...(limit && state.line ? { openLimit: { ...limit, line: state.line } } : {}), onAction: host.onAction, steer: host.steer, ...(status?.asks ? { asks: true } : {}), ...(clockRuns ? { limitHint: true } : {}) },
  };
}

interface ChatOptions {
  readonly provider?: LongProvider;
  readonly skin?: ChatSkin;
  readonly width?: number;
  readonly height?: number;
  /** After this many ms a message put into the turn lands (the stories that follow one all the way). */
  readonly landAfter?: number;
  /** A child conversation (D7). */
  readonly child?: boolean;
  /** What the person sends before the reset is refused. */
  readonly personRefused?: boolean;
  /** What is in the message box when the screen opens. */
  readonly draft?: ChatComposerDraft;
}

function childProps(child: ChatOptions['child'], locale: LongLanguage): Pick<StructuredAgentSessionPanelProps, 'owner' | 'parent'> | undefined {
  return child ? { owner: 'managed', parent: { sessionId: 'long-run-parent', title: PARENT[locale] } } : undefined;
}

function ChatScreen({ id, make, args, provider = 'claude', skin = 'bubble', width = 1100, height = 780, landAfter, child, personRefused = false, draft }: ChatOptions & {
  readonly id: string;
  readonly make: (lang: LongLanguage) => LongRunFixture;
  readonly args: Args;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `long-run-story-${id}`;
  const [fixture] = useState(() => inLongSession(make(locale), sessionId));
  const host = useStoryHost(fixture, provider, args, landAfter, personRefused);
  return (
    <Desk width={width} height={height}>
      <StructuredAgentSessionPanel {...panelProps(sessionId, host, provider, locale, args)} skin={skin}
        {...childProps(child, locale)}
        {...(draft ? { draftState: draft, supportsMessageContext: true } : {})} />
    </Desk>
  );
}

function PhoneScreen({ id, make, args, provider = 'claude', width, height, skin = 'bubble', landAfter, child, draft }: ChatOptions & {
  readonly id: string;
  readonly make: (lang: LongLanguage) => LongRunFixture;
  readonly args: Args;
  readonly width: number;
  readonly height: number;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `long-run-story-${id}`;
  const [fixture] = useState(() => inLongSession(make(locale), sessionId));
  const host = useStoryHost(fixture, provider, args, landAfter);
  return (
    <Phone width={width} height={height}>
      <MobileStructuredAgentSession {...panelProps(sessionId, host, provider, locale, args)} skin={skin} folders={undefined} onBack={fn()}
        {...childProps(child, locale)}
        {...(draft ? { draftState: draft, supportsMessageContext: true } : {})} />
    </Phone>
  );
}

// ── Helpers for the play functions ────────────────────────────────────────────────────────────────────
const CARD = '[data-testid="chat-usage-limit-card"]';
const TRAY = '[data-testid="chat-steer-tray"]';
const INPUT = '[data-testid="structured-agent-composer-input"]';
async function findIn(canvasElement: HTMLElement, selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const element = canvasElement.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    return element!;
  }, { timeout: 6_000 });
}
const composer = (canvasElement: HTMLElement): Promise<HTMLTextAreaElement> => findIn(canvasElement, INPUT) as Promise<HTMLTextAreaElement>;
/** The transcript follows its newest row; scroll it (only it) so a card's top shows. */
function scrollToTop(element: HTMLElement): void {
  const scroller = element.closest<HTMLElement>('.chat-viewport__scroll');
  if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
}
const showCard: Story['play'] = async ({ canvasElement }) => { scrollToTop(await findIn(canvasElement, CARD)); };
const showTray: Story['play'] = async ({ canvasElement }) => { await findIn(canvasElement, TRAY); };
const header = (canvasElement: HTMLElement): HTMLElement => canvasElement.querySelector<HTMLElement>('.structured-agent-state')!;
const clockOf = (iso: string, locale: LongLanguage = 'ko'): string => formatClock(iso, locale);
/** Every target a thumb has to hit is at least 44 px either way. */
async function thumbTargets(elements: Iterable<HTMLElement>): Promise<void> {
  for (const element of elements) {
    const box = element.getBoundingClientRect();
    await expect(box.height).toBeGreaterThanOrEqual(43.99);
    await expect(box.width).toBeGreaterThanOrEqual(43.99);
  }
}

function chat(id: string, make: (lang: LongLanguage) => LongRunFixture, options: ChatOptions = {}, play?: Story['play']): Story {
  return { render: (args) => <ChatScreen id={id} make={make} args={args} {...options} />, ...(play ? { play } : {}) };
}
function english(id: string, make: (lang: LongLanguage) => LongRunFixture, options: ChatOptions = {}, play?: Story['play']): Story {
  return { render: (args) => <StoryLocale.Provider value="en"><ChatScreen id={id} make={make} args={args} {...options} /></StoryLocale.Provider>, ...(play ? { play } : {}) };
}
function phone(id: string, make: (lang: LongLanguage) => LongRunFixture, width: number, height: number, options: ChatOptions = {}, play?: Story['play']): Story {
  return { render: (args) => <PhoneScreen id={id} make={make} args={args} width={width} height={height} {...options} />, ...(play ? { play } : {}) };
}

// ── A. An instruction into a running turn ──────────────────────────────────────────────────────────────
/** A long tool runs. The empty box says what Enter does now (D1), and that it does not stop the turn. */
export const BusyClaude: Story = chat('busy-claude', (lang) => steerStory(lang, 'busy'), {}, async ({ canvasElement }) => {
  const input = await composer(canvasElement);
  await expect(input).toHaveAttribute('placeholder', '실행 중에 보낼 지시를 입력하세요 (Esc로 중단)');
  await expect(input).toHaveAccessibleDescription(expect.stringContaining('Enter 끼워넣기') as unknown as string);
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]')).toHaveTextContent('Enter 끼워넣기 · 도구가 끝나면 이 턴에, 글을 쓰는 중이면 그 글이 끝난 뒤 새 턴으로 들어갑니다 · Esc 멈춤');
});
/** Codex: text being written is dropped and redone, tools are not cut; the hint says so rather than promising otherwise. */
export const BusyCodex: Story = chat('busy-codex', (lang) => steerStory(lang, 'busy'), { provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await composer(canvasElement)).toHaveAccessibleDescription(expect.stringContaining('글을 쓰는 중이면 버리고 다시 쓰고') as unknown as string);
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]')).toHaveTextContent('이 턴에 들어갑니다. 글을 쓰는 중이면 버리고 다시 쓰고, 도구는 끊지 않습니다');
});
/** With a draft: 끊고 보내기 and the round button are two different things, and each says which. */
export const BusyDraft: Story = chat('busy-draft', (lang) => steerStory(lang, 'busy'), {}, async ({ canvasElement }) => {
  await userEvent.type(await composer(canvasElement), '`src/cart.test.ts`만 돌려도 돼.');
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-send"]')).toHaveAttribute('aria-label', '실행 중에 끼워넣기');
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-send"]')).toHaveAttribute('data-kind', 'steer');
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-interrupt-send"]')).toHaveTextContent('끊고 보내기');
});
/** Enter puts it in: never the queue, never a stop. It waits in the tray, then lands at its real place with a quiet mark. */
export const EnterSteers: Story = chat('enter-steers', (lang) => steerStory(lang, 'busy'), { landAfter: 900 }, async ({ canvasElement, args }) => {
  const input = await composer(canvasElement);
  await userEvent.type(input, '그 파일만 돌려 줘.');
  await userEvent.keyboard('{Enter}');
  await expect(args.onSteer).toHaveBeenCalledWith('그 파일만 돌려 줘.');
  await expect(args.onSend).not.toHaveBeenCalled();
  await expect(args.onInterruptAndSend).not.toHaveBeenCalled();
  await expect(input).toHaveValue('');
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('곧 들어갑니다 · 지금 도구가 끝나면 이 턴에');
  // Nothing says it arrived until it does.
  await expect(canvasElement.querySelector('[data-testid="chat-steer-landed"]')).toBeNull();
  await findIn(canvasElement, '[data-testid="chat-steer-landed"]');
  await expect(canvasElement.querySelector(TRAY)).toBeNull();
  await waitFor(() => expect(canvasElement.querySelector('[data-testid="chat-steer-announce"]')).toHaveTextContent('메시지가 전달됐습니다.'));
});
/** While Claude writes, Enter still adds it, and the tray says it will be a new turn; that is what lands. */
export const EnterWhileWriting: Story = chat('enter-while-writing', (lang) => steerStory(lang, 'writing'), { landAfter: 900 }, async ({ canvasElement, args }) => {
  await userEvent.type(await composer(canvasElement), '그 파일만 돌려 줘.{Enter}');
  await expect(args.onSteer).toHaveBeenCalledWith('그 파일만 돌려 줘.');
  await expect(await findIn(canvasElement, TRAY)).toHaveTextContent('곧 들어갑니다 · 지금 글이 끝나면 새 턴으로 전달');
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('실행 중에 보냄 · 앞 글이 끝난 뒤 새 턴으로 전달됨');
});
/** 끊고 보내기 is the only way that stops the turn, and it stays a separate, named action. */
export const InterruptSend: Story = chat('interrupt-send', (lang) => steerStory(lang, 'busy'), {}, async ({ canvasElement, args }) => {
  await userEvent.type(await composer(canvasElement), '멈추고 이것부터 해 줘.');
  await userEvent.click(await findIn(canvasElement, '[data-testid="structured-agent-interrupt-send"]'));
  await expect(args.onInterruptAndSend).toHaveBeenCalledWith('멈추고 이것부터 해 줘.');
  await expect(args.onSteer).not.toHaveBeenCalled();
});
/** On its way: a long tool holds it. It has no place in the transcript yet, so it sits above the box. */
export const SteerOnItsWay: Story = chat('steer-on-its-way', (lang) => steerStory(lang, 'on-its-way'), {}, showTray);
/** Claude while it writes: measured, that text ends its turn and the message starts a new one, so the tray does not say "this turn". */
export const SteerOnItsWayText: Story = chat('steer-on-its-way-text', (lang) => steerStory(lang, 'on-its-way-text'), {}, showTray);
/** Codex while it writes: the promise it can keep. */
export const SteerOnItsWayCodex: Story = chat('steer-on-its-way-codex', (lang) => steerStory(lang, 'on-its-way-text'), { provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, TRAY)).toHaveTextContent('곧 들어갑니다 · 쓰던 글은 버리고 이 턴에서 다시 씁니다');
});
/** Codex behind a tool: it does not cut tools, so nothing is dropped and the tray does not say so. */
export const SteerOnItsWayCodexTool: Story = chat('steer-on-its-way-codex-tool', (lang) => steerStory(lang, 'on-its-way'), { provider: 'codex' }, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('곧 들어갑니다 · 지금 도구가 끝나면 이 턴에');
  await expect(tray).not.toHaveTextContent('버리고');
});
/** Landed: an ordinary message of the person's, where it arrived, between the tool before it and the work it changed. */
export const SteerLanded: Story = chat('steer-landed', (lang) => steerStory(lang, 'landed'), {}, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('실행 중에 끼워넣음');
  await expect(canvasElement.querySelector(TRAY)).toBeNull();
});
/** Landed on Claude after text: its own turn, right after the text that ended the last one. */
export const SteerLandedNewTurn: Story = chat('steer-landed-new-turn', (lang) => steerStory(lang, 'landed-new-turn'), {}, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('실행 중에 보냄 · 앞 글이 끝난 뒤 새 턴으로 전달됨');
});
/** Landed on Codex, which had been writing: the text is gone, and the mark says so. */
export const SteerLandedCodex: Story = chat('steer-landed-codex', (lang) => steerStory(lang, 'landed-rewritten'), { provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('쓰던 글은 버리고 다시 씀');
});
/** Landed on Codex at a tool's end: nothing was dropped, so the mark says nothing of the kind. */
export const SteerLandedCodexTool: Story = chat('steer-landed-codex-tool', (lang) => steerStory(lang, 'landed'), { provider: 'codex' }, async ({ canvasElement }) => {
  const mark = await findIn(canvasElement, '[data-testid="chat-steer-landed"]');
  await expect(mark).toHaveTextContent('실행 중에 끼워넣음');
  await expect(mark).not.toHaveTextContent('버리고');
});
/** An approval is open: it stays open, the message goes in after the answer. The amber stays on the decision. */
export const SteerBehindApproval: Story = chat('steer-behind-approval', (lang) => steerStory(lang, 'behind-approval'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('승인 뒤에 전달됩니다');
  await userEvent.click(within(tray).getByRole('button', { name: '답하러 가기' }));
  await waitFor(() => expect(document.activeElement?.closest('.chat-dock')).not.toBeNull());
});
/** The box while a decision waits: Enter still adds, and the hint says when it lands. */
export const SteerBehindApprovalComposer: Story = chat('steer-behind-approval-composer', (lang) => ({ ...steerStory(lang, 'behind-approval'), steered: [] }), {}, async ({ canvasElement, args }) => {
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]')).toHaveTextContent('승인에 답한 뒤 들어갑니다');
  await userEvent.type(await composer(canvasElement), '그 파일만 돌려 줘.{Enter}');
  await expect(args.onSteer).toHaveBeenCalledWith('그 파일만 돌려 줘.');
  await expect(await findIn(canvasElement, TRAY)).toHaveTextContent('승인 뒤에 전달됩니다');
});
/** A review turn takes nothing in (measured on Codex): it waits in the queue, which says why. */
export const SteerFellBackReview: Story = chat('steer-fell-back-review', (lang) => steerStory(lang, 'review-turn'), { provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-queue-fallback"]')).toHaveTextContent('검토 턴에는 끼워넣을 수 없어 대기열에 넣었습니다.');
});
export const SteerFellBackCompact: Story = chat('steer-fell-back-compact', (lang) => steerStory(lang, 'compact-turn'), { provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-queue-fallback"]')).toHaveTextContent('압축 중에는 끼워넣을 수 없어 대기열에 넣었습니다.');
});
/** The race with the end of the turn: the message is not lost, it is the next turn. */
export const SteerFellBackEnded: Story = chat('steer-fell-back-ended', (lang) => steerStory(lang, 'turn-ended'), { provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-queue-fallback"]')).toHaveTextContent('턴이 막 끝나 대기열에 넣었습니다.');
});
/** Refused: it can go to the queue or back to the box. No 다시 시도: neither AI drops a repeat for us. */
export const SteerFailed: Story = chat('steer-failed', (lang) => steerStory(lang, 'failed'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('끼워넣지 못했습니다 · AI가 받지 않았습니다');
  await expect(within(tray).queryByRole('button', { name: /다시/u })).toBeNull();
});
/** 대기열에 넣기: an ordinary queued request. */
export const SteerFailedToQueue: Story = chat('steer-failed-to-queue', (lang) => steerStory(lang, 'failed'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await userEvent.click(within(tray).getByTestId('chat-steer-to-queue'));
  await waitFor(() => expect(canvasElement.querySelector('.chat-queue__item')).not.toBeNull());
  await expect(canvasElement.querySelector(TRAY)).toBeNull();
});
/** Not connected: there is no queue to reach, so only the box. */
export const SteerFailedDisconnected: Story = chat('steer-failed-disconnected', (lang) => steerStory(lang, 'failed-disconnected'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(within(tray).queryByTestId('chat-steer-to-queue')).toBeNull();
});
/** 입력창으로 되돌리기: its text comes back, added to what is typed, and nothing is sent. */
export const SteerFailedToBox: Story = chat('steer-failed-to-box', (lang) => steerStory(lang, 'failed-disconnected'), {}, async ({ canvasElement, args }) => {
  const tray = await findIn(canvasElement, TRAY);
  await userEvent.click(within(tray).getByTestId('chat-steer-to-box'));
  await expect(args.onSteer).not.toHaveBeenCalled();
  await expect((await composer(canvasElement)).value).toContain('src/cart.test.ts');
  await expect(canvasElement.querySelector(TRAY)).toBeNull();
});
/** The host cannot say: the AI may have read it, so the person decides, and the card says why it does not simply resend. */
export const SteerUnconfirmed: Story = chat('steer-unconfirmed', (lang) => steerStory(lang, 'unconfirmed'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('전달됐는지 확인하지 못했습니다');
  await expect(tray).toHaveTextContent('다시 보내면 두 번 읽을 수 있습니다');
  await expect(within(tray).queryByTestId('chat-steer-to-queue')).toBeNull();
});
const NOTES = { id: 'note-1', name: 'notes.txt', mimeType: 'text/plain', kind: 'text' as const, data: 'cart notes' };
/** Only plain text was measured going in: the rest queues as it does today, and the box says so before it is sent. */
function notPlain(id: string, draft: ChatComposerDraft, options: ChatOptions = {}): Story {
  return chat(id, (lang) => steerStory(lang, 'busy'), { ...options, draft }, async ({ canvasElement }) => {
    const hint = await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]');
    await expect(hint).toHaveTextContent('첨부·답장·/ 명령은 아직 끼워넣을 수 없어 대기열에 넣습니다.');
    await expect(await findIn(canvasElement, '[data-testid="structured-agent-send"]')).toHaveAttribute('data-kind', 'queue');
  });
}
export const SteerNotPlainAttachment: Story = notPlain('steer-not-plain-attachment', { text: '이 메모도 같이 봐 줘.', attachments: [NOTES] });
export const SteerNotPlainReply: Story = notPlain('steer-not-plain-reply', { text: '이 부분 다시 봐 줘.', replyTo: { messageId: 'm-1', text: '실패 세 개 가운데 둘은 cartTotal 루프가 원인입니다.' } });
export const SteerNotPlainCommand: Story = notPlain('steer-not-plain-command', { text: '/compact' });
/** Sent: it waits in the queue, which says why, and nothing went into the turn. */
export const SteerNotPlainQueued: Story = chat('steer-not-plain-queued', (lang) => steerStory(lang, 'busy'), { draft: { text: '이 메모도 같이 봐 줘.', attachments: [NOTES] } }, async ({ canvasElement, args }) => {
  (await composer(canvasElement)).focus();
  await userEvent.keyboard('{Enter}');
  await expect(args.onSend).toHaveBeenCalled();
  await expect(args.onSteer).not.toHaveBeenCalled();
  await expect(await findIn(canvasElement, '[data-testid="chat-queue-fallback"]')).toHaveTextContent('글만 끼워넣을 수 있어 대기열에 넣었습니다.');
  await expect(canvasElement.querySelector(TRAY)).toBeNull();
});
/** The person stopped the turn with a message on its way. What became of it was never measured, so nothing claims either way, and the box is the way back. */
export const SteerCaughtByStop: Story = chat('steer-caught-by-stop', (lang) => steerStory(lang, 'caught-stop'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('턴이 멈춰 전달됐는지 확인하지 못했습니다');
  await expect(tray).toHaveTextContent('세션에 남았다면 다음 턴에서 AI가 읽을 수 있습니다.');
  await expect(within(tray).getByTestId('chat-steer-to-box')).toBeVisible();
  await expect(within(tray).queryByTestId('chat-steer-to-queue')).toBeNull();
});
/** The limit stopped the turn with a message on its way: the card is below it, and the message may be read on continuing. */
export const SteerCaughtByLimit: Story = chat('steer-caught-by-limit', (lang) => steerStory(lang, 'caught-limit'), {}, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  await expect(tray).toHaveTextContent('한도로 턴이 멈춰 전달됐는지 확인하지 못했습니다');
  await expect(tray).toHaveTextContent('세션에 남았다면 이어서 할 때 AI가 읽을 수 있습니다.');
  await findIn(canvasElement, CARD);
});
/** The host saw it land, and the limit refused that turn: measured, it stays in the session and is read on continuing. */
export const SteerLandedThenLimit: Story = chat('steer-landed-then-limit', (lang) => steerStory(lang, 'landed-then-limit'), {}, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('한도로 멈춘 턴에 남음, 이어서 할 때 AI가 읽습니다');
  await findIn(canvasElement, CARD);
});
/** A narrow conversation (520 px): the buttons stay on the box's row, the tray wraps. */
export const SteerNarrow: Story = chat('steer-narrow', (lang) => steerStory(lang, 'on-its-way'), { width: 520, height: 860 }, async ({ canvasElement }) => {
  await userEvent.type(await composer(canvasElement), '그 파일만 돌려 줘.');
  const box = await findIn(canvasElement, '.chat-composer__box');
  const send = await findIn(canvasElement, '[data-testid="structured-agent-send"]');
  await expect(send.getBoundingClientRect().right).toBeLessThanOrEqual(box.getBoundingClientRect().right);
});
export const BusyEnglish: Story = english('busy-en', (lang) => steerStory(lang, 'on-its-way'), {}, showTray);
export const BusyEnglishCodex: Story = english('busy-en-codex', (lang) => steerStory(lang, 'landed-rewritten'), { provider: 'codex' });
/** CLI skin: the same words after the `›` prompt, the tray in the same place. */
export const CliBusy: Story = chat('cli-busy', (lang) => steerStory(lang, 'busy'), { skin: 'cli' });
export const CliSteerOnItsWay: Story = chat('cli-steer-on-its-way', (lang) => steerStory(lang, 'on-its-way'), { skin: 'cli' }, showTray);
export const CliSteerLandedNewTurn: Story = chat('cli-steer-landed-new-turn', (lang) => steerStory(lang, 'landed-new-turn'), { skin: 'cli' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('새 턴으로 전달됨');
});
/** CLI skin: the person's `›` line and a `⎿` mark under it. */
export const CliSteerLanded: Story = chat('cli-steer-landed', (lang) => steerStory(lang, 'landed-rewritten'), { skin: 'cli', provider: 'codex' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-steer-landed"]')).toHaveTextContent('실행 중에 끼워넣음 · 쓰던 글은 버리고 다시 씀');
});
export const CliSteerBehindApproval: Story = chat('cli-steer-behind-approval', (lang) => steerStory(lang, 'behind-approval'), { skin: 'cli' }, showTray);
export const CliSteerFellBack: Story = chat('cli-steer-fell-back', (lang) => steerStory(lang, 'review-turn'), { skin: 'cli', provider: 'codex' });
export const CliSteerNotPlain: Story = notPlain('cli-steer-not-plain', { text: '/compact' }, { skin: 'cli' });
export const CliSteerFailed: Story = chat('cli-steer-failed', (lang) => steerStory(lang, 'failed'), { skin: 'cli' }, showTray);

// ── B. The usage limit card ────────────────────────────────────────────────────────────────────────────
/**
 * A known reset within hours: what happens and when, what it sends, and what an early try costs. No amber: this waits
 * on a clock, not on the person. The header and the box say the same.
 */
export const LimitWaiting: Story = chat('limit-waiting', (lang) => limitStory(lang, 'waiting'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  scrollToTop(card);
  await expect(card).toHaveTextContent(`5시간 한도 · ${clockOf(RESET_AT)} 해제 예정`);
  await expect(card).toHaveTextContent(`${clockOf(RESUME_AT)}에 자동으로 재개를 시도합니다`);
  await expect(card).toHaveTextContent('해제 예정 시각이 6시간 안이라 자동으로 시도합니다.');
  await expect(card).toHaveTextContent('지금 시도가 거절되면 거절된 턴이 대화에 그대로 남습니다.');
  await expect(within(card).getByRole('button', { name: '지금 시도. 거절되면 거절된 턴이 대화에 그대로 남습니다.' })).toBeVisible();
  await expect(header(canvasElement)).toHaveTextContent(`한도 대기 · ${clockOf(RESUME_AT)}`);
  await expect(header(canvasElement)).not.toHaveAttribute('data-state', 'blocked');
  await expect(await composer(canvasElement)).toHaveAccessibleDescription(expect.stringContaining('해제 예정 시각 전에 보낸 메시지는 거절되어') as unknown as string);
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]')).toHaveTextContent('해제 예정 시각 전에 보낸 메시지는 거절되어 대화에 남고');
});
export const LimitWaitingCodex: Story = chat('limit-waiting-codex', (lang) => limitStory(lang, 'waiting', { provider: 'codex' }), { provider: 'codex' }, showCard);
/** 지금 시도 before the reset: refused, so the refused turn stays, and the card still waits for its clock. */
export const LimitTryNow: Story = chat('limit-try-now', (lang) => limitStory(lang, 'waiting'), {}, async ({ canvasElement, args }) => {
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-try-now"]'));
  await expect(args.onLongRunAction).toHaveBeenCalledWith({ kind: 'limit-try-now', stopId: LIMIT_STOP });
  await waitFor(() => expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toHaveTextContent('앱이 보냄 · 지금 시도를 누름'), { timeout: 4_000 });
  const card = await findIn(canvasElement, CARD);
  await waitFor(() => expect(card).toHaveTextContent('지금 시도가 거절됐습니다. 거절된 턴이 대화에 남아 있습니다.'));
  await expect(card).toHaveTextContent(`${clockOf(RESUME_AT)}에 자동으로 재개를 시도합니다`);
  scrollToTop(card);
});
/** 자동 재개 끄기: for this conversation only, says so, and can be undone; focus goes to the card's title. */
export const LimitAutoOff: Story = chat('limit-auto-off', (lang) => limitStory(lang, 'waiting'), {}, async ({ canvasElement }) => {
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-auto-off"]'));
  const card = await findIn(canvasElement, CARD);
  await waitFor(() => expect(card).toHaveTextContent('이 대화는 자동으로 이어서 하지 않습니다. 설정은 그대로입니다.'));
  await waitFor(() => expect(document.activeElement).toBe(card.querySelector('[data-card-heading]')));
  await expect(card).not.toHaveTextContent('자동으로 재개를 시도합니다');
  await expect(canvasElement.querySelector('[data-testid="chat-limit-announce"]')).toHaveTextContent('자동 재개 끔');
  await expect(header(canvasElement)).toHaveTextContent('한도로 멈춤');
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-auto-on"]'));
  await waitFor(() => expect(card).toHaveTextContent('자동으로 재개를 시도합니다'));
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-auto-off"]'));
});
/**
 * The control for the three below: with the schedule standing, the virtual clock sends once, at the scheduled time and not
 * at the expected reset, and passing that time again sends nothing more.
 */
export const ClockSends: Story = chat('clock-sends', (lang) => limitStory(lang, 'waiting'), {}, async ({ canvasElement, args }) => {
  await findIn(canvasElement, CARD);
  passTime(RESET_AT);
  await expect(args.onResumeSent).not.toHaveBeenCalled();
  passTime(RESUME_AT);
  await expect(args.onResumeSent).toHaveBeenCalledTimes(1);
  await expect(args.onResumeSent).toHaveBeenCalledWith('turn-limit');
  await expect(await findIn(canvasElement, '[data-testid="chat-app-sent"]')).toHaveTextContent('앱이 보냄 · 예약 시각이 되어');
  passTime(RESUME_AT);
  await expect(args.onResumeSent).toHaveBeenCalledTimes(1);
});
/** 자동 재개 끄기, then the time passes: nothing goes out. */
export const ClockAutoOff: Story = chat('clock-auto-off', (lang) => limitStory(lang, 'waiting'), {}, async ({ canvasElement, args }) => {
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-auto-off"]'));
  await waitFor(() => expect(canvasElement.querySelector(CARD)).toHaveTextContent('이 대화는 자동으로 이어서 하지 않습니다.'));
  passTime(RESUME_AT);
  await expect(args.onResumeSent).not.toHaveBeenCalled();
  await expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toBeNull();
  scrollToTop(await findIn(canvasElement, CARD));
});
/** 그때 이어서 하기 stands until 취소, and then the time passes with nothing sent. */
export const ClockUnscheduled: Story = chat('clock-unscheduled', (lang) => limitStory(lang, 'ask-reset', { window: 'weekly' }), {}, async ({ canvasElement, args }) => {
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-schedule"]'));
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-unschedule"]'));
  await findIn(canvasElement, '[data-testid="chat-limit-limit-schedule"]');
  passTime(WEEKLY_RESUME_AT);
  await expect(args.onResumeSent).not.toHaveBeenCalled();
  scrollToTop(await findIn(canvasElement, CARD));
});
/** The person sends first: the card says so, and the time passes with nothing sent. */
export const ClockPersonFirst: Story = chat('clock-person-first', (lang) => limitStory(lang, 'waiting'), {}, async ({ canvasElement, args }) => {
  await userEvent.type(await composer(canvasElement), '내가 먼저 보낼게.{Enter}');
  await expect(args.onSend).toHaveBeenCalledWith('내가 먼저 보낼게.');
  await waitFor(() => expect(canvasElement.querySelector(CARD)).toHaveTextContent('직접 보낸 메시지가 있어 이 턴을 이어서 하지 않습니다.'));
  passTime(RESUME_AT);
  await expect(args.onResumeSent).not.toHaveBeenCalled();
});
/** The person sends before the reset and the limit refuses it: the schedule stays cancelled, the message stays in the conversation, and the time passes with nothing sent. */
export const ClockPersonRefused: Story = chat('clock-person-refused', (lang) => limitStory(lang, 'waiting'), { personRefused: true }, async ({ canvasElement, args }) => {
  await userEvent.type(await composer(canvasElement), '내가 먼저 보낼게.{Enter}');
  const card = await findIn(canvasElement, CARD);
  await waitFor(() => expect(card).toHaveTextContent('직접 보낸 메시지가 한도로 거절됐습니다. 자동 재개는 취소됐습니다.'));
  passTime(RESUME_AT);
  await expect(args.onResumeSent).not.toHaveBeenCalled();
  await expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toBeNull();
  scrollToTop(card);
});
/** Being sent now: nothing says it arrived. */
export const LimitResuming: Story = chat('limit-resuming', (lang) => limitStory(lang, 'resuming'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('예약 시각이 되어 "Continue."를 보내는 중입니다.');
  await expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toBeNull();
});
/** Resumed: the row after the card is exactly what went out, and it says it was the app (D3). */
export const LimitResumed: Story = chat('limit-resumed', (lang) => limitStory(lang, 'resumed'), {}, async ({ canvasElement }) => {
  const row = await findIn(canvasElement, '[data-testid="chat-app-sent"]');
  await expect(row).toHaveTextContent('Continue.');
  await expect(row).toHaveTextContent('앱이 보냄 · 예약 시각이 되어');
  await expect(row).toHaveAccessibleName('사람이 아니라 앱이 보낸 메시지');
  // The conversation has moved on: the header is its own again, not the limit's.
  await expect(header(canvasElement)).not.toHaveTextContent('한도');
  scrollToTop(await findIn(canvasElement, CARD));
});
/** D4: refused although the reset had passed: one later try, ten minutes on. */
export const LimitRetrying: Story = chat('limit-retrying', (lang) => limitStory(lang, 'retrying'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent(`${clockOf(RETRY_AT)}에 한 번 더 시도합니다. 그래도 거절되면 멈추고 묻습니다.`);
  // The refused row above must not claim the limit lifted.
  await expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toHaveTextContent('앱이 보냄 · 예약 시각이 되어');
  await expect(header(canvasElement)).toHaveTextContent(`한도 대기 · ${clockOf(RETRY_AT)}`);
  scrollToTop(card);
});
/** D4: refused twice: the app stops and asks. This waits on the person. */
export const LimitGaveUp: Story = chat('limit-gave-up', (lang) => limitStory(lang, 'gave-up'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('앱은 더 시도하지 않습니다.');
  await expect(header(canvasElement)).toHaveTextContent('한도 · 답 기다림');
  await expect(header(canvasElement)).toHaveAttribute('data-state', 'blocked');
  await expect(canvasElement.querySelectorAll('[data-testid="chat-app-sent"]')).toHaveLength(2);
  scrollToTop(card);
});
/** A weekly limit: the reset is days away, so the app asks first (D2). */
export const LimitWeekly: Story = chat('limit-weekly', (lang) => limitStory(lang, 'ask-reset', { window: 'weekly' }), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('주간 한도');
  await expect(card).toHaveTextContent('주간 한도는 먼저 묻습니다.');
  await expect(within(card).getByRole('button', { name: '그때 이어서 하기' })).toBeVisible();
  await expect(header(canvasElement)).toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/** 그때 이어서 하기: now it waits for that clock, and that can be cancelled. */
export const LimitWeeklyScheduled: Story = chat('limit-weekly-scheduled', (lang) => limitStory(lang, 'ask-reset', { window: 'weekly' }), {}, async ({ canvasElement, args }) => {
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-schedule"]'));
  await expect(args.onLongRunAction).toHaveBeenCalledWith({ kind: 'limit-schedule', stopId: LIMIT_STOP });
  const card = await findIn(canvasElement, CARD);
  await waitFor(() => expect(card).toHaveTextContent('앱이 "Continue."를 보내 재개를 시도합니다.'));
  await expect(await findIn(canvasElement, '[data-testid="chat-limit-limit-unschedule"]')).toBeVisible();
  await expect(header(canvasElement)).not.toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/** A known reset, but 8 hours off: past the 6 hours the app tries by itself, so it asks first and says why (D2). */
export const LimitLater: Story = chat('limit-later', (lang) => limitStory(lang, 'ask-reset', { window: 'unknown', later: true }), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('해제 예정 시각이 6시간보다 멀어 먼저 묻습니다.');
  await expect(card).toHaveTextContent(`${clockOf(LATER_RESET_AT)} 해제 예정`);
  await expect(header(canvasElement)).toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/** No reset time known: nothing to wait for, and 이어서 하기 says what an early try costs. */
export const LimitUnknown: Story = chat('limit-unknown', (lang) => limitStory(lang, 'ask-unknown', { window: 'unknown' }), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('해제 예정 시각을 알 수 없습니다.');
  await expect(card).toHaveTextContent('아직 한도면 거절된 턴이 대화에 그대로 남습니다.');
  await expect(header(canvasElement)).toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/** The person sent a message first (after the reset, so it went through): the app sends nothing. */
export const LimitCancelled: Story = chat('limit-cancelled', (lang) => limitStory(lang, 'cancelled'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('직접 보낸 메시지가 있어 이 턴을 이어서 하지 않습니다.');
  await expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toBeNull();
  scrollToTop(card);
});
/** The same refused message as a resting screen: its row, 한도로 거절됨, the card under it, and how it can go on. */
export const LimitPersonRefused: Story = chat('limit-person-refused', (lang) => limitStory(lang, 'person-refused'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('그 메시지는 대화에 남아 있어, 이어서 하면 AI가 함께 읽습니다.');
  await expect(within(card).getByRole('button', { name: '이어서 하기' })).toBeVisible();
  scrollToTop(card);
});
/** An approval was open when the time came: skipped, and the card leads to it. */
export const LimitSkipped: Story = chat('limit-skipped', (lang) => limitStory(lang, 'skipped'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('승인을 기다리는 동안은 이어서 하지 않습니다.');
  await userEvent.click(within(card).getByRole('button', { name: '답하러 가기' }));
  await waitFor(() => expect(document.activeElement?.closest('.chat-dock')).not.toBeNull());
});
/** D5: the reset passed while the app was closed: it asks on reopen and sends nothing by itself. */
export const LimitReopened: Story = chat('limit-reopened', (lang) => limitStory(lang, 'ask-reopened'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('PC 앱을 열었다고 저절로 보내지 않습니다.');
  await expect(header(canvasElement)).toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/** D6: several conversations, one at a time, 60 s apart, the longest-stopped first. This one is second. */
export const LimitLine: Story = chat('limit-line', (lang) => limitStory(lang, 'waiting', { line: { position: 2, total: 3 } }), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('대화 3개에 차례로 보냅니다 · 이 대화는 2번째');
  await expect(card).toHaveTextContent('앞 대화가 끝나기를 기다리지 않습니다.');
  await expect(card).toHaveTextContent(`${clockOf(LINE_AT)}에 자동으로 재개를 시도합니다`);
  scrollToTop(card);
});
/** `usage_not_included`: nothing resets, so nothing is offered. */
export const LimitNotIncluded: Story = chat('limit-not-included', (lang) => limitStory(lang, 'not-included', { provider: 'codex', window: 'unknown' }), { provider: 'codex' }, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('이 요금제에는 Codex 사용량이 포함되어 있지 않습니다.');
  await expect(within(card).queryAllByRole('button')).toHaveLength(0);
  await expect(header(canvasElement)).toHaveTextContent('한도로 멈춤');
  await expect(header(canvasElement)).not.toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/**
 * D7: a managed child never resumes by itself. 이어서 하기 is there only if that path proves supported at implementation, so
 * this is the card if it does (Claude only: a Codex child was not measured).
 */
export const LimitChild: Story = chat('limit-child', (lang) => limitStory(lang, 'child'), { child: true }, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('하위 대화는 자동으로 이어서 하지 않습니다.');
  await expect(card).not.toHaveTextContent('자동으로 재개를 시도합니다');
  await expect(within(card).getByRole('button', { name: '이어서 하기' })).toBeVisible();
  scrollToTop(card);
});
/** D7: the card if that path does not prove supported: no button. */
export const LimitChildUnsupported: Story = chat('limit-child-unsupported', (lang) => limitStory(lang, 'child', { childKind: 'managed' }), { child: true }, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('이 하위 대화는 여기서 이어서 할 수 없습니다.');
  await expect(within(card).queryAllByRole('button')).toHaveLength(0);
  scrollToTop(card);
});
/** The send itself failed: the one state that is an error, with its reason and a retry. */
export const LimitFailed: Story = chat('limit-failed', (lang) => limitStory(lang, 'failed', { failure: 'disconnected' }), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('"Continue."를 보내지 못했습니다');
  await expect(card).toHaveTextContent('아무것도 보내지 않았습니다.');
  scrollToTop(card);
});
/** 이어서 하기 on an asking card: being sent, then the row, marked as pressed. */
export const LimitResumePressed: Story = chat('limit-resume-pressed', (lang) => limitStory(lang, 'ask-reopened'), {}, async ({ canvasElement, args }) => {
  await userEvent.click(await findIn(canvasElement, '[data-testid="chat-limit-limit-resume"]'));
  await expect(args.onLongRunAction).toHaveBeenCalledWith({ kind: 'limit-resume', stopId: LIMIT_STOP });
  await waitFor(() => expect(canvasElement.querySelector('[data-testid="chat-app-sent"]')).toHaveTextContent('앱이 보냄 · 이어서 하기를 누름'), { timeout: 4_000 });
  scrollToTop(await findIn(canvasElement, CARD));
});
/** The host cannot say whether "Continue." arrived: not the same as nothing having gone out, so it asks, and says what sending again risks. */
export const LimitUnconfirmed: Story = chat('limit-unconfirmed', (lang) => limitStory(lang, 'unconfirmed'), {}, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, CARD);
  await expect(card).toHaveTextContent('"Continue."가 전달됐는지 확인하지 못했습니다.');
  await expect(card).toHaveTextContent('다시 보내면 두 번 읽을 수 있습니다.');
  await expect(card).not.toHaveTextContent('아무것도 보내지 않았습니다');
  await expect(header(canvasElement)).toHaveAttribute('data-state', 'blocked');
  scrollToTop(card);
});
/** A narrow conversation (520 px). */
export const LimitNarrow: Story = chat('limit-narrow', (lang) => limitStory(lang, 'waiting'), { width: 520, height: 860 }, showCard);
export const LimitEnglish: Story = english('limit-en', (lang) => limitStory(lang, 'waiting'), {}, showCard);
export const LimitEnglishCodex: Story = english('limit-en-codex', (lang) => limitStory(lang, 'ask-reset', { provider: 'codex', window: 'weekly' }), { provider: 'codex' }, showCard);
/** CLI skin: `⏺` neutral, `⎿` lines, the buttons as text you can press. */
export const CliLimitWaiting: Story = chat('cli-limit-waiting', (lang) => limitStory(lang, 'waiting'), { skin: 'cli' }, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, '.chat-cli-action-card[data-kind="usage-limit"]');
  await expect(card.querySelector('.chat-cli-glyph')).toHaveAttribute('data-tone', 'muted');
  await expect(within(card).getByRole('button', { name: '이 대화의 자동 재개 끄기' })).toBeVisible();
  scrollToTop(card);
});
export const CliLimitResumed: Story = chat('cli-limit-resumed', (lang) => limitStory(lang, 'resumed'), { skin: 'cli' }, async ({ canvasElement }) => {
  await expect(await findIn(canvasElement, '[data-testid="chat-app-sent"]')).toHaveTextContent('Continue.');
  const card = await findIn(canvasElement, '.chat-cli-action-card[data-kind="usage-limit"]');
  await expect(card.querySelector('.chat-cli-glyph')).toHaveAttribute('data-tone', 'muted');
});
export const CliLimitUnconfirmed: Story = chat('cli-limit-unconfirmed', (lang) => limitStory(lang, 'unconfirmed'), { skin: 'cli' }, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, '.chat-cli-action-card[data-kind="usage-limit"]');
  // Not known is not an error.
  await expect(card.querySelector('.chat-cli-glyph')).toHaveAttribute('data-tone', 'muted');
});
export const CliLimitWeekly: Story = chat('cli-limit-weekly', (lang) => limitStory(lang, 'ask-reset', { window: 'weekly' }), { skin: 'cli' });
export const CliLimitRetrying: Story = chat('cli-limit-retrying', (lang) => limitStory(lang, 'retrying'), { skin: 'cli' });
export const CliLimitNotIncluded: Story = chat('cli-limit-not-included', (lang) => limitStory(lang, 'not-included', { provider: 'codex', window: 'unknown' }), { skin: 'cli', provider: 'codex' });
/** CLI skin: the only state with a danger tone. */
export const CliLimitFailed: Story = chat('cli-limit-failed', (lang) => limitStory(lang, 'failed', { failure: 'disconnected' }), { skin: 'cli' }, async ({ canvasElement }) => {
  const card = await findIn(canvasElement, '.chat-cli-action-card[data-kind="usage-limit"]');
  await expect(card.querySelector('.chat-cli-glyph')).toHaveAttribute('data-tone', 'danger');
});

// ── C. Where a waiting conversation shows ──────────────────────────────────────────────────────────────
function ListScreen({ onOpen }: { readonly onOpen?: (sessionId: string) => void }): JSX.Element {
  const locale = useContext(StoryLocale);
  const conversations = listConversations(locale, { first: clockOf(RESUME_AT, locale), second: clockOf(LINE_AT, locale) });
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <div className="ez-shell" style={{ width: 'min(1100px, 100vw)', height: 'min(760px, 100vh)' }} data-testid="long-run-list">
        <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <LiveList projectName="cart-kit" conversations={conversations} waiting={listWaiting(locale)} flows={[]} terminals={[]} focus="c-first" others={[]} tools={[]} activeTool={null}
            onBoard={() => undefined} onOpenConversation={onOpen ?? (() => undefined)} onNewConversation={() => undefined} onOpenWaiting={() => undefined} onInbox={() => undefined}
            onOpenFlow={() => undefined} onOpenTerminal={() => undefined} onNewTerminal={() => undefined} onAllConversations={() => undefined} onOtherProject={() => undefined} onTool={() => undefined} />
          <div style={{ flex: 1 }} aria-hidden="true" />
        </div>
      </div>
    </AppI18nProvider>
  );
}
/** Two on a clock (no amber, not in 나를 기다리는 것), one that asks (amber and there), one stopped for good. */
export const ListDesktop: Story = {
  render: (args) => <ListScreen onOpen={args.onOpenRelatedSession} />,
  play: async ({ canvasElement }) => {
    const rows = await waitFor(() => { const found = within(canvasElement).getAllByTestId('shell-live-row'); expect(found).toHaveLength(6); return found; });
    await expect(rows[1]).toHaveTextContent(`Claude · 한도 대기 · ${clockOf(RESUME_AT)}`);
    await expect(rows[1]).not.toHaveAttribute('data-need');
    await expect(rows[3]).toHaveTextContent('Claude · 한도 · 답 기다림');
    await expect(rows[3]).toHaveAttribute('data-need', 'true');
    await expect(rows[4]).toHaveTextContent('Codex · 한도로 멈춤');
    await expect(within(canvasElement).getAllByTestId('shell-live-waiting')).toHaveLength(1);
  },
};
export const ListDesktopEnglish: Story = { render: (args) => <StoryLocale.Provider value="en"><ListScreen onOpen={args.onOpenRelatedSession} /></StoryLocale.Provider> };

// ── D. Settings › 에이전트 ─────────────────────────────────────────────────────────────────────────────
const WRAP_ON: TurnWrapUpSettings = { suggestions: { claude: true, codex: true }, recaps: true, tasks: true, pauseNearLimit: true };

function SettingsScreen({ autoResume = true, args = meta.args }: { readonly autoResume?: boolean; readonly args?: Args }): JSX.Element {
  const locale = useContext(StoryLocale);
  const [on, setOn] = useState(autoResume);
  const capabilities = useMemo((): CapabilityAccess => {
    const base = storyCapabilities(locale);
    const snapshot = shellSnapshot();
    let wrap = WRAP_ON;
    let long: LongRunSettings = { autoResume };
    const turnWrapUp: TurnWrapUpAccess = { load: async () => ({ settings: wrap, paused: [] }), save: async (next) => { wrap = next; return wrap; } };
    const longRun: LongRunAccess = { load: async () => long, save: async (next) => { long = next; setOn(next.autoResume); return long; } };
    return { ...base, daemon: { ...base.daemon, getSnapshot: async () => ({ ...snapshot, capabilities: [...(snapshot.capabilities ?? []), TURN_WRAP_UP_CAPABILITY] }) }, turnWrapUp, longRun };
  }, [autoResume, locale]);
  return (
    <Desk>
      <DesktopUiPreferencesProvider capabilities={capabilities}>
        <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
          <SidebarShell destination="settings" title={locale === 'ko' ? '설정' : 'Settings'} width={440} overlayBelow={0} onClose={() => undefined} onWidthChange={() => undefined}>
            <SettingsFixture requestedCategory="agents" capabilities={capabilities} />
          </SidebarShell>
          <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
            <ChatBeside autoResume={on} args={args} />
          </div>
        </div>
      </DesktopUiPreferencesProvider>
    </Desk>
  );
}
/** The conversation beside Settings: the switch reaches it, as it must reach every card with a schedule. */
function ChatBeside({ autoResume, args = meta.args }: { readonly autoResume: boolean; readonly args?: Args }): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = 'long-run-story-settings-chat';
  const [fixture] = useState(() => inLongSession(limitStory(locale, 'waiting'), sessionId));
  const host = useStoryHost(fixture, 'claude', args, undefined);
  const { settingOff: turnOff } = host;
  useEffect(() => { if (!autoResume) turnOff(); }, [autoResume, turnOff]);
  return <StructuredAgentSessionPanel {...panelProps(sessionId, host, 'claude', locale, args)} />;
}
async function showSwitch(canvasElement: HTMLElement): Promise<HTMLElement> {
  // The test id sits on the switch's input, which is drawn by its label.
  const toggle = await waitFor(() => within(canvasElement).getByTestId('long-run-auto-resume').closest<HTMLElement>('.ez-ui-switch')!, { timeout: 10_000 });
  await waitFor(() => expect(toggle).toBeVisible(), { timeout: 10_000 });
  toggle.scrollIntoView({ block: 'center' });
  return toggle;
}
/** D9: its own short section right after 턴 마무리, whose promise (nothing goes out until you press) stays true. */
export const SettingsLongRun: Story = {
  render: () => <SettingsScreen />,
  play: async ({ canvasElement }) => {
    const toggle = await showSwitch(canvasElement);
    const section = within(canvasElement).getByTestId('long-run-settings');
    await expect(section).toHaveTextContent('사람이 누르지 않아도 메시지가 나가는 유일한 곳입니다.');
    await expect(section).toHaveTextContent('앱이 그 대화에 "Continue."를 보냅니다.');
    await expect(section).toHaveTextContent('사람이 보낸 최상위 대화에만, 해제 예정 시각을 알고 6시간 안인 한도에만');
    await expect(section).toHaveTextContent('주간 한도, 더 먼 시각, 시각을 모르는 한도는 먼저 묻습니다.');
    await expect(within(canvasElement).getByTestId('turn-wrap-up-settings')).toHaveTextContent('누르기 전에는 아무것도 보내거나 실행하지 않습니다.');
    const control = within(section).getByRole('switch');
    await expect(control).toBeChecked();
    await userEvent.click(control);
    await expect(control).not.toBeChecked();
    await userEvent.click(control);
    toggle.scrollIntoView({ block: 'center' });
  },
};
/** Off: nothing waits on a clock. The card beside it has no schedule, says why, and can be continued by hand. */
export const SettingsOff: Story = {
  render: () => <SettingsScreen autoResume={false} />,
  play: async ({ canvasElement }) => {
    await showSwitch(canvasElement);
    await expect(within(within(canvasElement).getByTestId('long-run-settings')).getByRole('switch')).not.toBeChecked();
    const card = await findIn(canvasElement, CARD);
    await waitFor(() => expect(card).toHaveTextContent('설정에서 자동 재개를 꺼서 이 예약을 취소했습니다.'));
    await expect(card).not.toHaveTextContent('자동으로 재개를 시도합니다');
    await expect(within(card).getByRole('button', { name: '이어서 하기' })).toBeVisible();
    await expect(header(canvasElement)).toHaveTextContent('한도로 멈춤');
  },
};
/** Turning it off cancels a schedule that stands: the card changes, turning it back on does not bring that one back, and the time passes with nothing sent. */
export const SettingsTurnOff: Story = {
  render: (args) => <SettingsScreen args={args} />,
  play: async ({ canvasElement, args }) => {
    await showSwitch(canvasElement);
    const card = await findIn(canvasElement, CARD);
    await expect(card).toHaveTextContent('자동으로 재개를 시도합니다');
    const control = within(within(canvasElement).getByTestId('long-run-settings')).getByRole('switch');
    await userEvent.click(control);
    await waitFor(() => expect(card).toHaveTextContent('설정에서 자동 재개를 꺼서 이 예약을 취소했습니다.'));
    passTime(RESUME_AT);
    await expect(args.onResumeSent).not.toHaveBeenCalled();
    await userEvent.click(control);
    await expect(control).toBeChecked();
    await expect(card).toHaveTextContent('설정에서 자동 재개를 꺼서 이 예약을 취소했습니다.');
    passTime(RESUME_AT);
    await expect(args.onResumeSent).not.toHaveBeenCalled();
  },
};
export const SettingsEnglish: Story = {
  render: () => <StoryLocale.Provider value="en"><SettingsScreen /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => { await showSwitch(canvasElement); },
};

// ── E. Android (the shared panel, variant="mobile") ────────────────────────────────────────────────────
/** Phone 360×800: no Enter here, so the hint names the send button, and 끊고 보내기 and 끼워넣기 stay thumb targets. */
export const PhoneBusyDraft360: Story = phone('phone-busy-360', (lang) => steerStory(lang, 'busy'), 360, 800, {}, async ({ canvasElement, args }) => {
  const input = await composer(canvasElement);
  await expect(input).toHaveAttribute('placeholder', '실행 중에 보낼 지시를 입력하세요');
  await userEvent.type(input, '그 파일만 돌려 줘.');
  const hint = await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]');
  await expect(hint).toHaveTextContent('보내기로 끼워넣기');
  await expect(hint).not.toHaveTextContent('Enter');
  await expect(input).toHaveAccessibleDescription(expect.stringContaining('보내기로 끼워넣기') as unknown as string);
  const send = await findIn(canvasElement, '[data-testid="structured-agent-send"]');
  await thumbTargets([send, await findIn(canvasElement, '[data-testid="structured-agent-interrupt-send"]'), await findIn(canvasElement, '[data-testid="structured-agent-stop"]')]);
  // Its own row: the settings chips keep their words.
  await expect(canvasElement.querySelector('.chat-pill-pair')!.getBoundingClientRect().width).toBeGreaterThan(90);
  await userEvent.click(send);
  await expect(args.onSteer).toHaveBeenCalledWith('그 파일만 돌려 줘.');
  await expect(args.onSend).not.toHaveBeenCalled();
  await findIn(canvasElement, TRAY);
});
/** Phone 360×800, the box as the turn runs. */
export const PhoneBusy360: Story = phone('phone-busy-empty-360', (lang) => steerStory(lang, 'busy'), 360, 800);
export const PhoneBusyDraft412: Story = phone('phone-busy-412', (lang) => steerStory(lang, 'busy'), 412, 915, { provider: 'codex' }, async ({ canvasElement }) => {
  await userEvent.type(await composer(canvasElement), '그 파일만 돌려 줘.');
  await thumbTargets([await findIn(canvasElement, '[data-testid="structured-agent-send"]'), await findIn(canvasElement, '[data-testid="structured-agent-interrupt-send"]')]);
});
export const PhoneSteerOnItsWay360: Story = phone('phone-steer-on-its-way', (lang) => steerStory(lang, 'on-its-way'), 360, 800, {}, showTray);
export const PhoneSteerLandedNewTurn360: Story = phone('phone-steer-landed-new-turn', (lang) => steerStory(lang, 'landed-new-turn'), 360, 800);
export const PhoneSteerLanded360: Story = phone('phone-steer-landed', (lang) => steerStory(lang, 'landed-rewritten'), 360, 800, { provider: 'codex' });
export const PhoneSteerBehindApproval360: Story = phone('phone-steer-behind', (lang) => steerStory(lang, 'behind-approval'), 360, 800, {}, async ({ canvasElement }) => {
  await thumbTargets(within(await findIn(canvasElement, TRAY)).getAllByRole('button'));
});
export const PhoneSteerFailed360: Story = phone('phone-steer-failed', (lang) => steerStory(lang, 'failed'), 360, 800, {}, async ({ canvasElement }) => {
  await thumbTargets(within(await findIn(canvasElement, TRAY)).getAllByRole('button'));
});
export const PhoneSteerCaughtByLimit360: Story = phone('phone-steer-caught-limit', (lang) => steerStory(lang, 'caught-limit'), 360, 800, {}, async ({ canvasElement }) => {
  await thumbTargets(within(await findIn(canvasElement, TRAY)).getAllByRole('button'));
});
export const PhoneSteerNotPlain360: Story = phone('phone-steer-not-plain', (lang) => steerStory(lang, 'busy'), 360, 800, { draft: { text: '이 메모도 같이 봐 줘.', attachments: [NOTES] } }, async ({ canvasElement, args }) => {
  await expect(await findIn(canvasElement, '[data-testid="structured-agent-composer-hint"]')).toHaveTextContent('아직 끼워넣을 수 없어 대기열에 넣습니다');
  await userEvent.click(await findIn(canvasElement, '[data-testid="structured-agent-send"]'));
  await expect(args.onSteer).not.toHaveBeenCalled();
  await expect(args.onSend).toHaveBeenCalled();
});
export const PhoneSteerFellBack360: Story = phone('phone-steer-fell-back', (lang) => steerStory(lang, 'review-turn'), 360, 800, { provider: 'codex' }, async ({ canvasElement }) => {
  await findIn(canvasElement, '[data-testid="chat-queue-fallback"]');
});
const phoneCard = (selector = CARD): Story['play'] => async ({ canvasElement }) => {
  const card = await findIn(canvasElement, selector);
  scrollToTop(card);
  await thumbTargets(within(card).queryAllByRole('button'));
};
/** Phone 360×800 (D8): the same card, actions stacked, each a thumb target. */
export const PhoneLimitWaiting360: Story = phone('phone-limit-waiting-360', (lang) => limitStory(lang, 'waiting'), 360, 800, {}, async (context) => {
  await phoneCard()!(context);
  const buttons = within(await findIn(context.canvasElement, CARD)).getAllByRole('button');
  await expect(buttons).toHaveLength(2);
  // Stacked: one above the other.
  await expect(buttons[1]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(buttons[0]!.getBoundingClientRect().bottom);
});
export const PhoneLimitWaiting412: Story = phone('phone-limit-waiting-412', (lang) => limitStory(lang, 'waiting', { provider: 'codex' }), 412, 915, { provider: 'codex' }, phoneCard());
export const PhoneLimitWeekly360: Story = phone('phone-limit-weekly', (lang) => limitStory(lang, 'ask-reset', { window: 'weekly' }), 360, 800, {}, phoneCard());
export const PhoneLimitUnknown360: Story = phone('phone-limit-unknown', (lang) => limitStory(lang, 'ask-unknown', { window: 'unknown' }), 360, 800, {}, phoneCard());
export const PhoneLimitPersonRefused360: Story = phone('phone-limit-person-refused', (lang) => limitStory(lang, 'person-refused'), 360, 800, {}, phoneCard());
export const PhoneLimitUnconfirmed360: Story = phone('phone-limit-unconfirmed', (lang) => limitStory(lang, 'unconfirmed'), 360, 800, {}, phoneCard());
export const PhoneLimitReopened360: Story = phone('phone-limit-reopened', (lang) => limitStory(lang, 'ask-reopened'), 360, 800, {}, phoneCard());
export const PhoneLimitResumed360: Story = phone('phone-limit-resumed', (lang) => limitStory(lang, 'resumed'), 360, 800, {}, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="chat-app-sent"]'); });
export const PhoneLimitLine412: Story = phone('phone-limit-line', (lang) => limitStory(lang, 'waiting', { line: { position: 2, total: 3 } }), 412, 915, {}, phoneCard());
export const PhoneLimitChild360: Story = phone('phone-limit-child', (lang) => limitStory(lang, 'child'), 360, 800, { child: true }, phoneCard());
export const PhoneLimitNotIncluded360: Story = phone('phone-limit-not-included', (lang) => limitStory(lang, 'not-included', { provider: 'codex', window: 'unknown' }), 360, 800, { provider: 'codex' }, phoneCard());
/** Phone, CLI skin: the text-styled buttons stacked too. */
export const PhoneLimitCli360: Story = phone('phone-limit-cli', (lang) => limitStory(lang, 'waiting'), 360, 800, { skin: 'cli' }, phoneCard('.chat-cli-action-card[data-kind="usage-limit"]'));

function FeedScreen({ width, height }: { readonly width: number; readonly height: number }): JSX.Element {
  const locale = useContext(StoryLocale);
  const items = listConversations(locale, { first: clockOf(RESUME_AT, locale), second: clockOf(LINE_AT, locale) }).map((item): FeedConversation => ({ ...item, projectId: 'p-cart', projectName: 'cart-kit' }));
  const waiting = listWaiting(locale).map((item): FeedWaitingItem => ({ key: item.approvalId, kind: 'usage-limit', at: item.at, title: item.title, detail: item.detail, providerId: item.providerId, sessionId: item.sessionId, projectId: 'p-cart', projectName: 'cart-kit' }));
  return (
    <Phone width={width} height={height}>
      <MobileFeedView projects={[{ id: 'p-cart', name: 'cart-kit' }]} scope="p-cart" onScopeChange={() => undefined} host={{ tone: 'on', label: locale === 'ko' ? '작업 PC · 18ms' : 'Work PC · 18ms' }} waiting={waiting} flows={[]}
        conversations={{ items, total: items.length }} usage={{ fiveHour: { usedPercent: 100 }, weekly: { usedPercent: 38 } }}
        onDecide={async () => ({ ok: true })} onOpenWaiting={() => undefined} onOpenConversation={() => undefined} onOpenFlow={() => undefined} onSeeAllConversations={() => undefined} onNewConversation={() => undefined} />
    </Phone>
  );
}
/** Phone: the feed says the same as the desktop list: a clock is a line on a conversation, only an ask-first case waits for me. */
export const PhoneFeed360: Story = {
  render: () => <FeedScreen width={360} height={800} />,
  play: async ({ canvasElement }) => {
    const waiting = within(canvasElement).getAllByTestId('mobile-feed-waiting');
    await expect(waiting).toHaveLength(1);
    await expect(waiting[0]).toHaveTextContent('사용량 한도 · Claude');
    await expect(within(canvasElement).getAllByTestId('mobile-feed-conversation')[1]).toHaveTextContent(`Claude · 한도 대기 · ${clockOf(RESUME_AT)}`);
  },
};
export const PhoneFeed412: Story = { render: () => <FeedScreen width={412} height={915} /> };

/** The tray never takes the box or a decision off the screen: its list is capped and scrolls inside, and a long message folds. */
async function trayLeavesRoom(canvasElement: HTMLElement, frameHeight: number): Promise<void> {
  const frame = await findIn(canvasElement, '[data-testid="phone-long-run-frame"]');
  const tray = await findIn(canvasElement, TRAY);
  const bottom = frame.getBoundingClientRect().bottom + 1;
  const boxStays = async (): Promise<void> => {
    await expect((await findIn(canvasElement, '.chat-composer__box')).getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
    await expect((await composer(canvasElement)).getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
  };
  const toggle = await waitFor(() => {
    const folded = tray.querySelector<HTMLElement>('[data-testid="chat-steer-toggle"]');
    if (frameHeight < 560) expect(folded).not.toBeNull();
    return folded;
  });
  if (toggle) {
    // A short panel: one line, and the newest state still says what matters.
    await expect(tray.querySelector('ol')).toBeNull();
    await expect(tray.getBoundingClientRect().height).toBeLessThanOrEqual(64);
    await boxStays();
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  const list = await waitFor(() => { const element = tray.querySelector<HTMLElement>('ol'); expect(element).not.toBeNull(); return element!; });
  await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
  await expect(tray.getBoundingClientRect().height).toBeLessThanOrEqual(Math.max(frameHeight * 0.34, 190));
  await boxStays();
}
/** Phone 360×800: four long messages. */
export const PhoneSteerLong360: Story = phone('phone-steer-long', (lang) => steerStory(lang, 'long-messages'), 360, 800, {}, async ({ canvasElement }) => {
  await trayLeavesRoom(canvasElement, 800);
});
/** The same with the keyboard open (about 420 px left): the box stays. */
export const PhoneSteerLongKeyboard: Story = phone('phone-steer-long-keyboard', (lang) => steerStory(lang, 'long-messages'), 360, 420, {}, async ({ canvasElement }) => {
  await trayLeavesRoom(canvasElement, 420);
});
/** Keyboard open with a decision waiting: the decision's buttons and the box both stay. */
export const PhoneSteerLongApproval: Story = phone('phone-steer-long-approval', (lang) => steerStory(lang, 'long-behind-approval'), 360, 420, {}, async ({ canvasElement }) => {
  const frame = await findIn(canvasElement, '[data-testid="phone-long-run-frame"]');
  const allow = await waitFor(() => within(canvasElement).getByRole('button', { name: '허용' }));
  // The decision has the room: one still line that says what happens to the messages, and nothing to open over it.
  const line = await findIn(canvasElement, '[data-testid="chat-steer-line"]');
  await expect(line).toHaveTextContent('승인 뒤에 전달됩니다');
  await expect(canvasElement.querySelector('[data-testid="chat-steer-toggle"]')).toBeNull();
  await expect(canvasElement.querySelector(`${TRAY} ol`)).toBeNull();
  const bottom = frame.getBoundingClientRect().bottom + 1;
  await waitFor(() => expect(allow.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom));
  await expect(allow.getBoundingClientRect().top).toBeGreaterThanOrEqual(frame.getBoundingClientRect().top);
  await expect((await findIn(canvasElement, '.chat-composer__box')).getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
});
/** A long message folds to two lines, and 전체 보기 opens it in place, inside the capped list. */
export const SteerLongExpand: Story = chat('steer-long-expand', (lang) => steerStory(lang, 'long-messages'), { width: 520, height: 860 }, async ({ canvasElement }) => {
  const tray = await findIn(canvasElement, TRAY);
  const first = within(tray).getAllByTestId('chat-steer-message')[0]!;
  const text = first.querySelector<HTMLElement>('.chat-steer__text')!;
  const folded = text.getBoundingClientRect().height;
  const toggle = within(first).getByRole('button', { name: '전체 보기' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(toggle);
  await waitFor(() => expect(text.getBoundingClientRect().height).toBeGreaterThan(folded));
  await expect(within(first).getByRole('button', { name: '접기' })).toHaveAttribute('aria-expanded', 'true');
});

/**
 * The WebView 74 floor: `overflow-wrap: anywhere` needs Chrome 80, so there the declared `break-word` fallback is what
 * runs, and it does not lower a flex item's min-content. This style forces that case in a current browser.
 */
const WEBVIEW_74_WRAP = '.phone-i4-frame * { overflow-wrap: break-word !important; }';
const LONG_MESSAGE = '`src/very/deeply/nested/folder/structure/with/a/long/path/that/never/breaks/cart.discount.calculation.test.ts`만돌려줘전체테스트는오래걸리니까그파일만돌리면돼';
async function fitsWithin(box: HTMLElement): Promise<void> {
  const right = box.getBoundingClientRect().right + 1;
  for (const element of box.querySelectorAll<HTMLElement>('*')) await expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(right);
}
/** Phone 360×800: an unbroken path in the tray stays inside it. */
export const PhoneLongWords360: Story = {
  render: (args) => (
    <>
      <style>{WEBVIEW_74_WRAP}</style>
      <PhoneScreen id="phone-long-words" make={(lang) => {
        const fixture = steerStory(lang, 'failed');
        return { ...fixture, steered: fixture.steered?.map((message) => ({ ...message, text: LONG_MESSAGE })) };
      }} args={args} width={360} height={800} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const tray = await findIn(canvasElement, TRAY);
    await fitsWithin(tray);
    await expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth + 1);
  },
};

// ── Reference variants (the Storybook locale picks the language) ───────────────────────────────────────
function ReferenceFrame({ locale, children }: { readonly locale: LongLanguage; readonly children: ReactNode }): JSX.Element {
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
const typed: Story['play'] = async ({ canvasElement }) => { await userEvent.type(await composer(canvasElement), canvasElement.ownerDocument.documentElement.lang.startsWith('en') ? 'Just that file.' : '그 파일만 돌려 줘.'); };
export const BusyDraftReference = reference(BusyDraft, typed);
export const SteerOnItsWayReference = reference(SteerOnItsWay, showTray);
export const SteerLandedReference = reference(SteerLanded, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="chat-steer-landed"]'); });
export const SteerBehindApprovalReference = reference(SteerBehindApproval, showTray);
export const SteerFellBackReviewReference = reference(SteerFellBackReview, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="chat-queue-fallback"]'); });
export const CliSteerOnItsWayReference = reference(CliSteerOnItsWay, showTray);
export const LimitWaitingReference = reference(LimitWaiting, showCard);
export const LimitResumedReference = reference(LimitResumed, showCard);
export const LimitWeeklyReference = reference(LimitWeekly, showCard);
export const LimitRetryingReference = reference(LimitRetrying, showCard);
export const CliLimitWaitingReference = reference(CliLimitWaiting, async ({ canvasElement }) => { scrollToTop(await findIn(canvasElement, '.chat-cli-action-card[data-kind="usage-limit"]')); });
export const ListDesktopReference = reference(ListDesktop, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="shell-live-row"]'); });
export const SettingsLongRunReference = reference(SettingsLongRun, async ({ canvasElement }) => { await showSwitch(canvasElement); });
export const PhoneBusyDraftReference = reference(PhoneBusyDraft360, typed);
export const PhoneLimitWaitingReference = reference(PhoneLimitWaiting360, phoneCard());
export const PhoneFeedReference = reference(PhoneFeed360, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="mobile-feed-waiting"]'); });
