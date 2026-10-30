import type { Meta, StoryObj } from '@storybook/react-vite';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MobileConversationReviewProvider } from '../../../mobile/src/MobileConversationReviewProvider';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileStructuredAgentSession } from '../../../mobile/src/MobileStructuredAgentSession';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import type { ChatAgentProfile } from '../../shared/chat-agent-profiles';
import { suggestedTaskBranch, type TurnWrapUpPause, type TurnWrapUpSettings } from '../../shared/turn-wrap-up';
import type { CapabilityAccess, TurnWrapUpAccess } from '../capability-access';
import type { ChatSkin } from '../chat-view-state';
import { DelegateAgentDialog, type DelegateAgentRequest } from '../DelegateAgentDialog';
import { AppI18nProvider, useAppTranslation } from '../i18n';
import { shellSnapshot } from '../shell/shell-fixtures';
import { SettingsFixture, storyCapabilities } from '../shell/tool-screen-fixtures';
import { conversationQueue } from '../conversation-queue';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps, type StructuredAgentUiResult } from '../StructuredAgentSession';
import { TurnWrapUpSettings as TurnWrapUpSection } from '../TurnWrapUpSettings';
import { DialogPortalContext } from '../ui/Dialog';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { SidebarShell } from '../workbench/SidebarShell';
import type { ChatWrapUpAction } from './ChatContext';
import { HighlighterProvider } from './markdown/HighlighterProvider';
import { RECOMMENDED_WRAP_UP_DECISIONS, WrapUpDecisionsProvider, type WrapUpDecisions } from './wrap-up/wrap-up-decisions';
import {
  applyWrapUpAction, cartStory, formatStory, inSession, waitingStory, WRAP_ROOT, WRAP_T0,
  type WrapLanguage, type WrapProvider, type WrapUpFixture,
} from './wrap-up/wrap-up-fixtures';
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
 * 시안 (2026-10-30): turn wrap-up — when a turn ends the AI proposes and the person acts. Its guess of the next message
 * waits as ghost text in the empty message box (a chip on the phone) and Tab fills it without sending; a turn nobody
 * watched (or one that stopped for the person) gets a recap card; work the AI noticed outside its task comes back as a
 * suggested-task card whose tasks start a sub-conversation, go to this conversation or are dismissed — only when the
 * person presses a button. Everything here is the production renderer fed by fixtures; the host is simulated by
 * `applyWrapUpAction`. The suggestions, recaps and tasks are what Claude and Codex wrote in the 2026-10-30 probes.
 */

interface Args {
  readonly onWrapUpAction: (action: ChatWrapUpAction) => void;
  readonly onSend: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly onChangeSettings: (settings: { readonly permissionPreset?: string }) => Promise<StructuredAgentUiResult>;
  readonly onOpenRelatedSession: (sessionId: string) => void;
  readonly onDelegate: (request: DelegateAgentRequest) => void;
}

const meta = {
  title: 'Production/TurnWrapUp/Mockup',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: {
    onWrapUpAction: fn(),
    onSend: fn(async (): Promise<StructuredAgentUiResult> => ({ ok: true })),
    onChangeSettings: fn(async (): Promise<StructuredAgentUiResult> => ({ ok: true })),
    onOpenRelatedSession: fn(),
    onDelegate: fn(),
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** The mockups speak Korean; the reference variants follow the Storybook locale. */
const StoryLocale = createContext<WrapLanguage>('ko');

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
            <div className="phone-i4-frame mobile-workbench-coordinator" data-testid="phone-wrap-up-frame" style={{ width, height }}>{children}</div>
          </MobileToastProvider>
        </MobileConversationReviewProvider>
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>
  );
}

// ── The story host: answers card actions the way the real one will ────────────────────────────────────
const SETTLING: ReadonlySet<ChatWrapUpAction['kind']> = new Set(['task-start', 'task-start-all', 'recap-retry']);

interface StoryHost {
  readonly state: WrapUpFixture;
  readonly onAction: (action: ChatWrapUpAction) => void;
  /** The task whose start form is open (바꿔서 시작…, or every start under D5 b). */
  readonly custom?: { readonly turnId: string; readonly taskId: string };
  readonly closeCustom: () => void;
  /** The start form started it: the task shows it started. */
  readonly startedViaForm: (taskId: string, branch?: string) => void;
}

function useStoryHost(fixture: WrapUpFixture, report: (action: ChatWrapUpAction) => void): StoryHost {
  const [state, setState] = useState(fixture);
  const [custom, setCustom] = useState<StoryHost['custom']>();
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((timer) => window.clearTimeout(timer)); }, []);
  const onAction = useCallback((action: ChatWrapUpAction) => {
    report(action);
    if (action.kind === 'task-start-custom') { setCustom({ turnId: action.turnId, taskId: action.taskId }); return; }
    setState((current) => applyWrapUpAction(current, action, false));
    // A start or a recap takes the host a moment; then it says what happened.
    if (SETTLING.has(action.kind)) timers.current.push(window.setTimeout(() => setState((current) => applyWrapUpAction(current, action, true)), 900));
  }, [report]);
  const startedViaForm = useCallback((taskId: string, branch?: string) => {
    setState((current) => ({
      ...current,
      tasks: (current.tasks ?? []).map((card) => ({
        ...card,
        tasks: card.tasks.map((task) => (task.id === taskId ? { ...task, outcome: { kind: 'started' as const, sessionId: `child-${taskId}`, ...(branch ? { branch } : {}) } } : task)),
      })),
    }));
  }, []);
  return { state, onAction, ...(custom ? { custom } : {}), closeCustom: () => setCustom(undefined), startedViaForm };
}

/** What 바꿔서 시작… opens: the existing start form (맡기기), filled in from the task. */
const TASK_PROFILES: readonly ChatAgentProfile[] = [
  { id: 'profile-claude', name: 'Claude 구현', providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard', whenToUse: '이 대화와 같은 AI·모델로 고칠 때' },
  { id: 'profile-codex', name: 'Codex 구현', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'standard' },
];

function TaskStartForm({ host, args }: { readonly host: StoryHost; readonly args: Args }): JSX.Element {
  const tasks = (host.state.tasks ?? []).flatMap((card) => card.tasks);
  const index = host.custom ? tasks.findIndex((task) => task.id === host.custom!.taskId) : -1;
  const task = index >= 0 ? tasks[index] : undefined;
  const branch = task?.worktree ? suggestedTaskBranch(task.title, index) : undefined;
  return (
    <DelegateAgentDialog open={Boolean(task)} onOpenChange={(open) => { if (!open) host.closeCustom(); }} mode="handoff"
      profiles={TASK_PROFILES} providerLabels={{ claude: 'Claude', codex: 'Codex' }} workspaces={[{ id: 'ws-cart', label: 'cart-kit', kind: 'local' }]}
      defaultWorkspaceId="ws-cart" initialInstruction={task?.prompt ?? ''} {...(branch ? { initialWorkspace: { kind: 'new-worktree' as const, branch } } : {})}
      onSubmit={async (request) => {
        args.onDelegate(request);
        if (task) host.startedViaForm(task.id, request.workspace.kind === 'new-worktree' ? request.workspace.branch : undefined);
        return { ok: true };
      }} />
  );
}

const MODELS: Readonly<Record<WrapProvider, { readonly id: string; readonly label: string }>> = {
  claude: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  codex: { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
};
const TITLES = {
  format: { ko: '가격 표시 고치기', en: 'Fix the price display' },
  cart: { ko: '장바구니 합계 고치기', en: 'Fix the cart total' },
} as const;

type Topic = keyof typeof TITLES;

function panelProps(sessionId: string, host: StoryHost, provider: WrapProvider, topic: Topic, locale: WrapLanguage, args: Args): StructuredAgentSessionPanelProps {
  const { state } = host;
  // What waits in the conversation's queue, as the host lists it (여기서 하기 while a turn runs lands there).
  const queueItems = conversationQueue(sessionId, state.turns, state.items);
  return {
    queuedCount: queueItems.length, queueItems,
    sessionId, title: TITLES[topic][locale], providerId: provider, providerLabel: provider === 'claude' ? 'Claude' : 'Codex',
    workspace: { id: 'ws-cart', label: 'cart-kit', kind: 'local', path: WRAP_ROOT },
    folders: { primary: WRAP_ROOT, additional: [], missing: [] },
    model: MODELS[provider].id, modelOptions: [MODELS[provider]],
    permissionPreset: 'standard', state: state.state, items: state.items, turns: state.turns, approvals: state.approvals ?? [], queueSettings: true,
    approvalResponses: true, effortSupported: true, reasoningEffort: 'high',
    usage: { fiveHour: { usedPercent: 31 }, weekly: { usedPercent: 24 }, contextPercent: 41 },
    onSend: args.onSend, onInterruptAndSend: fn(async () => ({ ok: true as const })),
    onChangeSettings: args.onChangeSettings, onResolveApproval: fn(async () => ({ ok: true as const })),
    onCancel: fn(async () => ({ ok: true as const })), onOpenRelatedSession: args.onOpenRelatedSession,
    wrapUp: {
      ...(state.suggestion ? { suggestion: state.suggestion } : {}),
      ...(state.recaps ? { recaps: state.recaps } : {}),
      ...(state.tasks ? { tasks: state.tasks } : {}),
      onAction: host.onAction,
    },
  };
}

interface ChatOptions {
  readonly provider?: WrapProvider;
  readonly skin?: ChatSkin;
  readonly permissionPreset?: StructuredAgentSessionPanelProps['permissionPreset'];
  readonly width?: number;
  readonly height?: number;
  readonly decisions?: Partial<WrapUpDecisions>;
}

function ChatScreen({ id, topic, make, args, provider = 'claude', skin = 'bubble', width = 1100, height = 780, decisions, permissionPreset }: ChatOptions & {
  readonly id: string;
  readonly topic: Topic;
  readonly make: (lang: WrapLanguage) => WrapUpFixture;
  readonly args: Args;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `wrap-up-story-${id}`;
  const [fixture] = useState(() => inSession(make(locale), sessionId));
  const host = useStoryHost(fixture, args.onWrapUpAction);
  return (
    <WrapUpDecisionsProvider value={{ ...RECOMMENDED_WRAP_UP_DECISIONS, ...decisions }}>
      <Desk width={width} height={height}>
        <StructuredAgentSessionPanel {...panelProps(sessionId, host, provider, topic, locale, args)} skin={skin} {...(permissionPreset ? { permissionPreset } : {})} />
        <TaskStartForm host={host} args={args} />
      </Desk>
    </WrapUpDecisionsProvider>
  );
}

function PhoneScreen({ id, topic, make, args, provider = 'claude', width, height }: {
  readonly id: string;
  readonly topic: Topic;
  readonly make: (lang: WrapLanguage) => WrapUpFixture;
  readonly args: Args;
  readonly provider?: WrapProvider;
  readonly width: number;
  readonly height: number;
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const sessionId = `wrap-up-story-${id}`;
  const [fixture] = useState(() => inSession(make(locale), sessionId));
  const host = useStoryHost(fixture, args.onWrapUpAction);
  return (
    <Phone width={width} height={height}>
      <MobileStructuredAgentSession {...panelProps(sessionId, host, provider, topic, locale, args)} folders={undefined} onBack={fn()} />
    </Phone>
  );
}

// ── Helpers for the play functions ────────────────────────────────────────────────────────────────────
async function findIn(canvasElement: HTMLElement, selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const element = canvasElement.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    return element!;
  });
}
const composer = (canvasElement: HTMLElement): Promise<HTMLTextAreaElement> => findIn(canvasElement, '[data-testid="structured-agent-composer-input"]') as Promise<HTMLTextAreaElement>;
/** The transcript follows its newest row; scroll it (only it) so a card's top shows. */
function scrollToTop(element: HTMLElement): void {
  const scroller = element.closest<HTMLElement>('.chat-viewport__scroll');
  if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
}
async function showCard(canvasElement: HTMLElement, selector = '[data-testid="chat-task-card"], .chat-cli-action-card[data-kind="task-suggestions"]'): Promise<HTMLElement> {
  const card = await findIn(canvasElement, selector);
  scrollToTop(card);
  return card;
}
const tasksOf = (card: HTMLElement): HTMLElement[] => within(card).getAllByTestId('chat-task');

function chat(id: string, topic: Topic, make: (lang: WrapLanguage) => WrapUpFixture, options: ChatOptions = {}): Story {
  return { render: (args) => <ChatScreen id={id} topic={topic} make={make} args={args} {...options} /> };
}

// ── 1. Desktop: the turn ended while nobody watched — recap + the next-message suggestion ─────────────────
/**
 * Claude's recap of a turn no screen was showing (자리를 비운 사이) after its last message, and its guess of the next
 * message as ghost text in the empty box with its key. Both are the AI's words; the card's header and the box's key
 * hint are the app's.
 */
export const AwayClaude: Story = {
  ...chat('away-claude', 'format', (lang) => formatStory(lang, 'claude')),
  play: async ({ canvasElement }) => {
    await findIn(canvasElement, '[data-testid="chat-recap-card"]');
    await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]');
  },
};
/** Codex: its recap, and its longer Korean guess on one line (the whole text is read out and fills on Tab). */
export const AwayCodex: Story = {
  ...chat('away-codex', 'format', (lang) => formatStory(lang, 'codex'), { provider: 'codex' }),
  play: async ({ canvasElement }) => {
    await findIn(canvasElement, '[data-testid="chat-recap-card"]');
    await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]');
  },
};
/** English, Codex: its recap and its guess after the fix. */
export const AwayCodexEnglish: Story = {
  render: (args) => <StoryLocale.Provider value="en"><ChatScreen id="away-codex-en" topic="format" make={(lang) => formatStory(lang, 'codex')} args={args} provider="codex" /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]'); },
};
/** English: Claude after the fix, asking about a unit test. */
export const AwayEnglish: Story = {
  render: (args) => <StoryLocale.Provider value="en"><ChatScreen id="away-en" topic="format" make={(lang) => formatStory(lang, 'claude')} args={args} /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]'); },
};

// ── 2. The next-message suggestion in the message box ──────────────────────────────────────────────────
/** Tab fills the box with the suggestion — editable, caret at its end — and sends nothing; it is described to screen readers. */
export const SuggestionTabFill: Story = {
  ...chat('tab-fill', 'format', (lang) => formatStory(lang, 'claude', { recap: false })),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = await composer(canvasElement);
    await waitFor(() => expect(canvas.getByTestId('structured-agent-suggestion')).toHaveTextContent('괄호 표시로 바꿔 주세요, 0원은 $0.00으로요'));
    await expect(input).toHaveAccessibleDescription('제안: 괄호 표시로 바꿔 주세요, 0원은 $0.00으로요 · Tab으로 채우기');
    await expect(input).toHaveAttribute('placeholder', '');
    input.focus();
    await userEvent.keyboard('{Tab}');
    await expect(input).toHaveValue('괄호 표시로 바꿔 주세요, 0원은 $0.00으로요');
    await expect(document.activeElement).toBe(input);
    await expect(input.selectionStart).toBe(input.value.length);
    await expect(args.onSend).not.toHaveBeenCalled();
    await expect(canvas.queryByTestId('structured-agent-suggestion')).toBeNull();
  },
};
/** Typing puts it away at once, and it stays away after the box is emptied (until the next turn's). */
export const SuggestionTyping: Story = {
  ...chat('typing', 'format', (lang) => formatStory(lang, 'claude', { recap: false })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await composer(canvasElement);
    await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]');
    await userEvent.type(input, '음');
    await expect(canvas.queryByTestId('structured-agent-suggestion')).toBeNull();
    await userEvent.clear(input);
    await expect(canvas.queryByTestId('structured-agent-suggestion')).toBeNull();
    await expect(input).not.toHaveAttribute('placeholder', '');
  },
};
/** Esc while nothing runs dismisses it; the box is today's box again. */
export const SuggestionEscape: Story = {
  ...chat('escape', 'format', (lang) => formatStory(lang, 'claude', { recap: false })),
  play: async ({ canvasElement }) => {
    const input = await composer(canvasElement);
    await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]');
    input.focus();
    await userEvent.keyboard('{Escape}');
    await expect(within(canvasElement).queryByTestId('structured-agent-suggestion')).toBeNull();
    await expect(input).toHaveValue('');
  },
};
/** Shift+Tab is still the plan switch: in plan mode there is no suggestion; turned off again, it is back. */
export const SuggestionShiftTabPlan: Story = {
  ...chat('shift-tab', 'format', (lang) => formatStory(lang, 'claude', { recap: false })),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = await composer(canvasElement);
    await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]');
    input.focus();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await waitFor(() => expect(args.onChangeSettings).toHaveBeenCalledWith({ permissionPreset: 'plan' }));
    await waitFor(() => expect(canvas.queryByTestId('structured-agent-suggestion')).toBeNull());
    await expect(input).toHaveValue('');
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await waitFor(() => expect(args.onChangeSettings).toHaveBeenCalledWith({ permissionPreset: 'standard' }));
    await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]');
  },
};
/** Plan mode is on: no suggestion (the box shows the plan switch on, as today). */
export const SuggestionPlanMode: Story = {
  render: (args) => <ChatScreen id="plan-mode" topic="format" make={(lang) => formatStory(lang, 'claude', { recap: false })} args={args} permissionPreset="plan" />,
  play: async ({ canvasElement }) => {
    await composer(canvasElement);
    await expect(within(canvasElement).queryByTestId('structured-agent-suggestion')).toBeNull();
  },
};
/** No suggestion (Codex said "(none)", or automatic calls are paused near the usage limit): exactly today's box. */
export const SuggestionNone: Story = {
  ...chat('none', 'format', (lang) => formatStory(lang, 'codex', { recap: false, suggestion: false }), { provider: 'codex' }),
  play: async ({ canvasElement }) => {
    const input = await composer(canvasElement);
    await expect(within(canvasElement).queryByTestId('structured-agent-suggestion')).toBeNull();
    await expect(input.getAttribute('placeholder')).not.toBe('');
  },
};
/** While a turn runs there is none (the guess belongs to the turn that ended). */
export const SuggestionWhileWorking: Story = {
  ...chat('working', 'format', (lang) => {
    const base = formatStory(lang, 'claude', { recap: false });
    const at = new Date(WRAP_T0 + 200_000).toISOString();
    return {
      ...base, state: 'working',
      items: [...base.items, { ...base.items[0]!, id: `${base.items[0]!.sessionId}:90`, sequence: 90, turnId: 'turn-next', text: lang === 'ko' ? '괄호 표시로 바꿔 주세요.' : 'Use parentheses, then.', createdAt: at }],
      turns: [...base.turns, { id: 'turn-next', sessionId: base.turns[0]!.sessionId, commandId: 'command-next', state: 'working', revision: 1, startedAt: at, createdAt: at, updatedAt: at }],
    };
  }),
  play: async ({ canvasElement }) => {
    await composer(canvasElement);
    await expect(within(canvasElement).queryByTestId('structured-agent-suggestion')).toBeNull();
  },
};
/** D2 option B: Tab, or → at the end of the empty box, fills it (the key hint shows both). */
export const SuggestionTabOrArrow: Story = {
  ...chat('tab-arrow', 'format', (lang) => formatStory(lang, 'claude', { recap: false }), { decisions: { acceptKeys: 'tab-arrow' } }),
  play: async ({ canvasElement }) => {
    const input = await composer(canvasElement);
    await expect(await findIn(canvasElement, '.chat-composer__ghost-keys')).toHaveTextContent('Tab→채우기');
    await expect(input).toHaveAccessibleDescription('제안: 괄호 표시로 바꿔 주세요, 0원은 $0.00으로요 · Tab 또는 →로 채우기');
    input.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(input).toHaveValue('괄호 표시로 바꿔 주세요, 0원은 $0.00으로요');
  },
};
/** A narrow conversation (520 px): the longer Codex guess shortens; the key stays at the end. */
export const SuggestionNarrow: Story = {
  ...chat('narrow-suggestion', 'format', (lang) => formatStory(lang, 'codex', { recap: false }), { provider: 'codex', width: 520, height: 860 }),
  play: async ({ canvasElement }) => {
    const keys = await findIn(canvasElement, '.chat-composer__ghost-keys');
    const box = canvasElement.querySelector<HTMLElement>('.chat-composer__box')!;
    await expect(keys.getBoundingClientRect().right).toBeLessThanOrEqual(box.getBoundingClientRect().right);
    // One line: the text ends in an ellipsis instead of growing the box.
    const ghost = canvasElement.querySelector<HTMLElement>('.chat-composer__ghost-text')!;
    await expect(ghost.scrollWidth).toBeGreaterThan(ghost.clientWidth);
  },
};
/** CLI skin: the same suggestion after the `›` prompt, in the terminal face. */
export const CliSuggestion: Story = {
  ...chat('cli-suggestion', 'format', (lang) => formatStory(lang, 'claude'), { skin: 'cli' }),
  play: async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]'); },
};

// ── 3. The recap card ─────────────────────────────────────────────────────────────────────────────────
/** The AI stopped for the person (a question in the dock) while nobody watched: the recap says so and 답하러 가기 leads there. */
export const RecapWaiting: Story = {
  ...chat('recap-waiting', 'format', (lang) => waitingStory(lang)),
  play: async ({ canvasElement }) => {
    const card = await findIn(canvasElement, '[data-testid="chat-recap-card"]');
    await expect(card).toHaveTextContent('멈추고 답을 기다림');
    await expect(card).toHaveTextContent('AI가 답을 기다립니다');
    await userEvent.click(within(card).getByRole('button', { name: '답하러 가기' }));
    await waitFor(() => expect(document.activeElement?.closest('.chat-dock')).not.toBeNull());
  },
};
/** While Claude writes it: one quiet line where the card goes. */
export const RecapGenerating: Story = chat('recap-generating', 'format', (lang) => formatStory(lang, 'claude', { recap: 'generating', suggestion: false }));
/** D4 option b: it could not be written — one small line and 다시 만들기. */
export const RecapFailedLine: Story = {
  ...chat('recap-failed', 'format', (lang) => formatStory(lang, 'claude', { recap: 'failed', suggestion: false })),
  play: async ({ canvasElement }) => {
    const line = await findIn(canvasElement, '[data-testid="chat-recap-line"]');
    await expect(line).toHaveTextContent('요약을 만들지 못했습니다');
    await expect(within(line).getByRole('button', { name: '다시 만들기' })).toBeVisible();
  },
};
/** 다시 만들기 asks the host again: the line says it is being written, then the card comes. */
export const RecapRetry: Story = {
  ...chat('recap-retry', 'format', (lang) => formatStory(lang, 'claude', { recap: 'failed', suggestion: false })),
  play: async ({ canvasElement, args }) => {
    const line = await findIn(canvasElement, '[data-testid="chat-recap-line"]');
    await userEvent.click(within(line).getByRole('button', { name: '다시 만들기' }));
    await expect(args.onWrapUpAction).toHaveBeenCalledWith({ kind: 'recap-retry', turnId: 'turn-plan' });
    await waitFor(() => expect(canvasElement.querySelector('[data-testid="chat-recap-line"]')).toHaveTextContent('요약 만드는 중'));
    await findIn(canvasElement, '[data-testid="chat-recap-card"]');
  },
};
/** D4 option a: it could not be written — nothing at all (the turn reads as it did before this feature). */
export const RecapFailedSilent: Story = {
  ...chat('recap-silent', 'format', (lang) => formatStory(lang, 'claude', { recap: false, suggestion: false })),
  play: async ({ canvasElement }) => {
    await composer(canvasElement);
    await expect(canvasElement.querySelector('[data-testid="chat-recap-card"], [data-testid="chat-recap-line"]')).toBeNull();
  },
};
/** D3 option A: every recap says 자리를 비운 사이, also when it was written because the AI stopped for an answer. */
export const RecapHeadingAway: Story = {
  ...chat('heading-away', 'format', (lang) => waitingStory(lang), { decisions: { recapHeading: 'away' } }),
  play: async ({ canvasElement }) => { await expect(await findIn(canvasElement, '[data-testid="chat-recap-card"]')).toHaveTextContent('자리를 비운 사이'); },
};
/** D3 option B: every recap says 이번 턴 요약 (true either way, says less). */
export const RecapHeadingTurn: Story = {
  ...chat('heading-turn', 'format', (lang) => waitingStory(lang), { decisions: { recapHeading: 'turn' } }),
  play: async ({ canvasElement }) => { await expect(await findIn(canvasElement, '[data-testid="chat-recap-card"]')).toHaveTextContent('이번 턴 요약'); },
};
/** CLI skin: `⏺ 요약(Claude) 자리를 비운 사이`, the AI's lines as `⎿` lines. */
export const CliRecap: Story = chat('cli-recap', 'format', (lang) => formatStory(lang, 'codex', { suggestion: false }), { skin: 'cli', provider: 'codex' });
/** CLI skin: the waiting recap — its line, and 답하러 가기 as a real button. */
export const CliRecapWaiting: Story = chat('cli-recap-waiting', 'format', (lang) => waitingStory(lang), { skin: 'cli' });
/** CLI skin: the one-line states. */
export const CliRecapGenerating: Story = chat('cli-recap-generating', 'format', (lang) => formatStory(lang, 'claude', { recap: 'generating', suggestion: false }), { skin: 'cli' });
export const CliRecapFailed: Story = chat('cli-recap-failed', 'format', (lang) => formatStory(lang, 'claude', { recap: 'failed', suggestion: false }), { skin: 'cli' });

// ── 4. The suggested-task card ────────────────────────────────────────────────────────────────────────
/**
 * Claude fixed only the cart loop and suggested the three bugs it saw instead of fixing them: one card after the turn's
 * last message, its suggest_task calls folded in. Each task: what, why, the exact instruction on request, and the
 * buttons. The line on top says what one click starts.
 */
export const TasksClaude: Story = {
  ...chat('tasks-claude', 'cart', (lang) => cartStory(lang, 'claude')),
  play: async ({ canvasElement, args }) => {
    const card = await showCard(canvasElement);
    await expect(within(card).getByTestId('chat-task-defaults')).toHaveTextContent('새 하위 대화: Claude · Opus 5.5 · 높음 · 승인 후 실행 · 이 폴더');
    // The suggest_task calls are not tool rows.
    await expect(canvasElement.querySelector('.chat-viewport__scroll')).not.toHaveTextContent('suggest_task');
    const [first, second, third] = tasksOf(card);
    await userEvent.click(within(first!).getByTestId('chat-task-prompt-toggle'));
    await expect(within(first!).getByTestId('chat-task-prompt')).toHaveTextContent('In src/auth.ts, canAccess returns');
    await userEvent.click(within(first!).getByRole('button', { name: '새 하위 대화로 시작: Fix the always-true role check in src/auth.ts' }));
    await expect(args.onWrapUpAction).toHaveBeenCalledWith({ kind: 'task-start', turnId: 'turn-cart', taskId: 'task-claude-1' });
    await waitFor(() => expect(within(first!).getByTestId('chat-task-outcome')).toHaveTextContent('시작하는 중'));
    await waitFor(() => expect(document.activeElement).toBe(first!.querySelector('[data-task-title]')));
    await waitFor(() => expect(within(first!).getByTestId('chat-task-outcome')).toHaveTextContent('시작함'), { timeout: 4_000 });
    await userEvent.click(within(first!).getByRole('button', { name: '하위 대화 열기: Fix the always-true role check in src/auth.ts' }));
    await expect(args.onOpenRelatedSession).toHaveBeenCalled();
    await userEvent.click(within(third!).getByRole('button', { name: '무시: Fix percentage math in applyDiscount (src/discount.ts)' }));
    await waitFor(() => expect(within(third!).getByTestId('chat-task-outcome')).toHaveTextContent('무시함'));
    await userEvent.click(within(third!).getByRole('button', { name: '다시 열기: Fix percentage math in applyDiscount (src/discount.ts)' }));
    await waitFor(() => expect(within(third!).queryByTestId('chat-task-outcome')).toBeNull());
    await userEvent.click(within(second!).getByRole('button', { name: '여기서 하기: Fix cents-to-dollars conversion in src/format.ts' }));
    await waitFor(() => expect(within(second!).getByTestId('chat-task-outcome')).toHaveTextContent('이 대화에 보냄'));
    await waitFor(() => expect(within(card).getByTestId('chat-task-announce')).not.toBeEmptyDOMElement());
    scrollToTop(card);
  },
};
/** Codex's three suggestions (its own words). */
export const TasksCodex: Story = {
  ...chat('tasks-codex', 'cart', (lang) => cartStory(lang, 'codex'), { provider: 'codex' }),
  play: async ({ canvasElement }) => { await showCard(canvasElement); },
};
/**
 * After the person acted, each task says only what the host confirmed: 시작함 (하위 대화 열기), 대기열에 넣음 · 2번째 (여기서
 * 하기 while a turn runs), 무시함 (다시 열기), and a start the host refused with its reason (다시 시도 · 무시).
 */
export const TasksStates: Story = {
  ...chat('tasks-states', 'cart', (lang) => cartStory(lang, 'claude', 'states')),
  play: async ({ canvasElement }) => {
    const card = await showCard(canvasElement);
    await expect(card.querySelector('.chat-action-card__state')).toHaveTextContent('4개 · 시작함 1 · 여기서 함 1 · 무시 1');
    const tasks = tasksOf(card);
    await expect(within(tasks[1]!).getByTestId('chat-task-outcome')).toHaveTextContent('대기열에 넣음 · 2번째');
    await expect(within(tasks[3]!).getByTestId('chat-task-outcome')).toHaveTextContent('이미 있는 브랜치입니다: suggest/reject-negative-and-fractional');
    // 여기서 하기 put task 2's instruction second in the queue the message box shows.
    const queued = canvasElement.querySelectorAll('.chat-queue__item');
    await expect(queued).toHaveLength(2);
    await expect(queued[1]).toHaveTextContent('In src/format.ts, formatPrice divides cents by 10');
  },
};
/** One task the AI recommends a worktree for (Claude's first run put the three bugs in one). */
export const TasksWorktree: Story = {
  ...chat('tasks-worktree', 'cart', (lang) => cartStory(lang, 'claude', 'combined')),
  play: async ({ canvasElement }) => { await expect(within(await showCard(canvasElement)).getByTestId('chat-task-worktree')).toHaveTextContent('워크트리 권장'); },
};
/**
 * D6: 모두 시작 asks first — each open task, where it works (this folder, or a new worktree on its `suggest/…` branch;
 * a worktree-recommended task starts there unless changed), the settings each starts with, and the four-at-once limit.
 */
export const TasksStartAll: Story = {
  ...chat('tasks-start-all', 'cart', (lang) => cartStory(lang, 'claude', 'mixed')),
  play: async ({ canvasElement, args }) => {
    const card = await showCard(canvasElement);
    await userEvent.click(within(card).getByRole('button', { name: '모두 시작 (4)' }));
    const dialog = await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="task-start-all-dialog"]'); expect(element).not.toBeNull(); return element!; });
    const tasks = within(dialog).getAllByTestId('task-start-all-task');
    await expect(tasks).toHaveLength(4);
    await expect(within(tasks[3]!).getByTestId('task-start-all-worktree')).toBeChecked();
    await expect(tasks[3]).toHaveTextContent('suggest/reject-negative-and-fractional');
    await expect(dialog).toHaveTextContent('동시에 실행할 수 있는 대화는 4개');
    await userEvent.click(within(tasks[0]!).getByTestId('task-start-all-worktree'));
    await userEvent.click(within(dialog).getByRole('button', { name: '4개 시작' }));
    await expect(args.onWrapUpAction).toHaveBeenCalledWith({
      kind: 'task-start-all', turnId: 'turn-cart', starts: [
        { taskId: 'task-claude-1', where: { kind: 'new-worktree', branch: 'suggest/fix-the-always-true-role-check' } },
        { taskId: 'task-claude-2', where: { kind: 'this-folder' } },
        { taskId: 'task-claude-3', where: { kind: 'this-folder' } },
        { taskId: 'task-claude-4', where: { kind: 'new-worktree', branch: 'suggest/reject-negative-and-fractional' } },
      ],
    });
    await waitFor(() => expect(within(card).getAllByTestId('chat-task-outcome')).toHaveLength(4));
  },
};
/** D5 option a's way out: 바꿔서 시작… opens the existing start form (맡기기) filled from the task — instruction and worktree. */
export const TasksChangeAndStart: Story = {
  ...chat('tasks-change', 'cart', (lang) => cartStory(lang, 'claude', 'combined')),
  play: async ({ canvasElement, args }) => {
    const card = await showCard(canvasElement);
    await userEvent.click(within(card).getByRole('button', { name: /^바꿔서 시작…: Fix logic bugs/u }));
    await expect(args.onWrapUpAction).toHaveBeenCalledWith({ kind: 'task-start-custom', turnId: 'turn-cart', taskId: 'task-claude-1' });
    const dialog = within(await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="delegate-agent-dialog"]'); expect(element).not.toBeNull(); return element!; }));
    await expect((dialog.getByTestId('delegate-agent-instruction') as HTMLTextAreaElement).value).toContain('Fix three bugs in src/:');
    await expect(dialog.getByTestId('delegate-agent-branch')).toHaveValue('suggest/fix-logic-bugs-in-auth-format');
  },
};
/** D5 option b: every start opens the form (no defaults line, no one-click start). */
export const TasksStartViaForm: Story = {
  ...chat('tasks-via-form', 'cart', (lang) => cartStory(lang, 'claude'), { decisions: { taskStart: 'dialog' } }),
  play: async ({ canvasElement }) => {
    const card = await showCard(canvasElement);
    await expect(within(card).queryByTestId('chat-task-defaults')).toBeNull();
    await expect(within(card).getAllByRole('button', { name: /^새 하위 대화로 시작…: /u })).toHaveLength(3);
  },
};
/** D7: at most 8 per turn — the rest are left out and the card says how many. */
export const TasksCap: Story = {
  ...chat('tasks-cap', 'cart', (lang) => cartStory(lang, 'claude', 'cap'), { height: 900 }),
  play: async ({ canvasElement }) => {
    const card = await findIn(canvasElement, '[data-testid="chat-task-card"]');
    await expect(tasksOf(card)).toHaveLength(8);
    await expect(card).toHaveTextContent('그 밖의 제안 3개는 버렸습니다');
  },
};
/** A narrow conversation (520 px): titles wrap, the buttons go under the task. */
export const TasksNarrow: Story = {
  ...chat('tasks-narrow', 'cart', (lang) => cartStory(lang, 'claude', 'mixed'), { width: 520, height: 900 }),
  play: async ({ canvasElement }) => { await showCard(canvasElement); },
};
/** English, Codex. */
export const TasksCodexEnglish: Story = {
  render: (args) => <StoryLocale.Provider value="en"><ChatScreen id="tasks-codex-en" topic="cart" make={(lang) => cartStory(lang, 'codex')} args={args} provider="codex" /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => { await showCard(canvasElement); },
};
/** English. */
export const TasksEnglish: Story = {
  render: (args) => <StoryLocale.Provider value="en"><ChatScreen id="tasks-en" topic="cart" make={(lang) => cartStory(lang, 'claude', 'mixed')} args={args} /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => { await showCard(canvasElement); },
};
/** CLI skin: `⏺ 제안 작업(Claude) 3개`, a `⎿` block per task, the buttons as text you can press. */
export const CliTasks: Story = {
  ...chat('cli-tasks', 'cart', (lang) => cartStory(lang, 'claude'), { skin: 'cli' }),
  play: async ({ canvasElement, args }) => {
    const card = await showCard(canvasElement);
    const start = within(card).getByRole('button', { name: '새 하위 대화로 시작: Fix the always-true role check in src/auth.ts' });
    start.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onWrapUpAction).toHaveBeenCalledWith({ kind: 'task-start', turnId: 'turn-cart', taskId: 'task-claude-1' });
    scrollToTop(card);
  },
};
export const CliTasksStates: Story = {
  ...chat('cli-tasks-states', 'cart', (lang) => cartStory(lang, 'claude', 'states'), { skin: 'cli' }),
  play: async ({ canvasElement }) => { await showCard(canvasElement); },
};

// ── 5. Android (the shared conversation panel, variant="mobile") ───────────────────────────────────────
/** Phone 360×800: the suggestion is a chip above the box; a tap fills the box and sends nothing (× dismisses it). */
export const PhoneSuggestion360: Story = {
  render: (args) => <PhoneScreen id="phone-chip-360" topic="format" make={(lang) => formatStory(lang, 'claude')} args={args} width={360} height={800} />,
  play: async ({ canvasElement, args }) => {
    const fill = await findIn(canvasElement, '[data-testid="structured-agent-suggestion-fill"]');
    const dismiss = canvasElement.querySelector<HTMLElement>('[data-testid="structured-agent-suggestion-dismiss"]')!;
    for (const target of [fill, dismiss]) await expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.99);
    await expect(dismiss.getBoundingClientRect().width).toBeGreaterThanOrEqual(43.99);
    await userEvent.click(fill);
    await expect(await composer(canvasElement)).toHaveValue('괄호 표시로 바꿔 주세요, 0원은 $0.00으로요');
    await expect(args.onSend).not.toHaveBeenCalled();
    await expect(canvasElement.querySelector('[data-testid="structured-agent-suggestion-chip"]')).toBeNull();
  },
};
/** Phone 412×915: Codex's longer guess ends in an ellipsis; × puts it away. */
export const PhoneSuggestion412: Story = {
  render: (args) => <PhoneScreen id="phone-chip-412" topic="format" make={(lang) => formatStory(lang, 'codex', { recap: false })} args={args} provider="codex" width={412} height={915} />,
  play: async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="structured-agent-suggestion-chip"]'); },
};
/** Phone: the recap card, and the chip under it. */
export const PhoneRecap360: Story = {
  render: (args) => <PhoneScreen id="phone-recap" topic="format" make={(lang) => formatStory(lang, 'claude')} args={args} width={360} height={800} />,
  play: async ({ canvasElement }) => { scrollToTop(await findIn(canvasElement, '[data-testid="chat-recap-card"]')); },
};
/**
 * Phone 360×800 (D8): the same card, tasks stacked, every action a thumb target. The phone starts in this folder only
 * (it cannot create worktrees) and has no start form, so a worktree-recommended task says the desktop can pick one.
 */
export const PhoneTasks360: Story = {
  render: (args) => <PhoneScreen id="phone-tasks-360" topic="cart" make={(lang) => cartStory(lang, 'claude', 'mixed')} args={args} width={360} height={800} />,
  play: async ({ canvasElement }) => {
    const card = await showCard(canvasElement);
    await expect(within(card).getByTestId('chat-task-worktree-desktop')).toHaveTextContent('새 워크트리는 데스크톱에서 고를 수 있습니다');
    await expect(within(card).queryByRole('button', { name: /^바꿔서 시작…/u })).toBeNull();
    const targets = [...card.querySelectorAll<HTMLElement>('.chat-task__actions button, .chat-task__toggle')];
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      await expect(box.height).toBeGreaterThanOrEqual(43.99);
      await expect(box.width).toBeGreaterThanOrEqual(43.99);
    }
  },
};
/** Phone 412×915: Codex's suggestions. */
export const PhoneTasks412: Story = {
  render: (args) => <PhoneScreen id="phone-tasks-412" topic="cart" make={(lang) => cartStory(lang, 'codex')} args={args} provider="codex" width={412} height={915} />,
  play: async ({ canvasElement }) => { await showCard(canvasElement); },
};
/** Phone: 모두 시작 as a sheet — everything starts in this folder there. */
export const PhoneStartAll: Story = {
  render: (args) => <PhoneScreen id="phone-start-all" topic="cart" make={(lang) => cartStory(lang, 'claude', 'mixed')} args={args} width={412} height={915} />,
  play: async ({ canvasElement }) => {
    const card = await showCard(canvasElement);
    await userEvent.click(within(card).getByTestId('chat-task-start-all'));
    const dialog = await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-testid="task-start-all-dialog"]'); expect(element).not.toBeNull(); return element!; });
    await expect(within(dialog).getByTestId('task-start-all-phone')).toHaveTextContent('새 워크트리는 데스크톱에서 고를 수 있습니다');
    await expect(within(dialog).queryAllByTestId('task-start-all-worktree')).toHaveLength(0);
  },
};

// ── 6. Settings › 에이전트 › 턴 마무리 ─────────────────────────────────────────────────────────────────────
const SETTINGS_ON: TurnWrapUpSettings = { suggestions: { claude: true, codex: true }, recaps: true, tasks: true, pauseNearLimit: true };
/** 15:10 in Korea: when the 5-hour window of the paused fixture resets. */
const RESUME_AT = Date.parse('2026-10-30T06:10:00.000Z');
const PAUSED: readonly TurnWrapUpPause[] = [{ providerId: 'claude', window: 'five-hour', usedPercent: 92, resetsAt: RESUME_AT }];

function wrapUpAccess(settings: TurnWrapUpSettings, paused: readonly TurnWrapUpPause[]): TurnWrapUpAccess {
  let current = settings;
  return { load: async () => ({ settings: current, paused }), save: async (next) => { current = next; return current; } };
}
function settingsCapabilities(locale: WrapLanguage, access?: TurnWrapUpAccess): CapabilityAccess {
  const base = storyCapabilities(locale);
  return { ...base, daemon: { ...base.daemon, getSnapshot: async () => shellSnapshot() }, ...(access ? { turnWrapUp: access } : {}) };
}

function SettingsScreen({ settings = SETTINGS_ON, paused = [], placement = 'section' }: {
  readonly settings?: TurnWrapUpSettings;
  readonly paused?: readonly TurnWrapUpPause[];
  /** D9: its own section on the page (A), or inside the AI 대화 group (B, drawn for comparison). */
  readonly placement?: 'section' | 'ai-chat';
}): JSX.Element {
  const locale = useContext(StoryLocale);
  const access = useMemo(() => wrapUpAccess(settings, paused), [settings, paused]);
  const capabilities = useMemo(() => settingsCapabilities(locale, placement === 'section' ? access : undefined), [access, locale, placement]);
  return (
    <Desk>
      <DesktopUiPreferencesProvider capabilities={capabilities}>
        <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
          <SidebarShell destination="settings" title={locale === 'ko' ? '설정' : 'Settings'} width={440} overlayBelow={0} onClose={() => undefined} onWidthChange={() => undefined}>
            {placement === 'section'
              ? <SettingsFixture requestedCategory="agents" capabilities={capabilities} />
              : <AiChatGroup access={access} />}
          </SidebarShell>
          <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
            <AwayChat paused={paused.length > 0} />
          </div>
        </div>
      </DesktopUiPreferencesProvider>
    </Desk>
  );
}
/** D9 option B, drawn for comparison: the same section inside the AI 대화 group (closed by default in the app). */
function AiChatGroup({ access }: { readonly access: TurnWrapUpAccess }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <details className="status-section" open>
      <summary>{t('agentSettings.structuredProvidersTitle')}</summary>
      <TurnWrapUpSection access={access} />
    </details>
  );
}
/** The conversation beside Settings; while the automatic calls are paused it has no guess and no recap, and its usage says why. */
function AwayChat({ paused }: { readonly paused: boolean }): JSX.Element {
  const locale = useContext(StoryLocale);
  const [fixture] = useState(() => inSession(formatStory(locale, 'claude', paused ? { recap: false, suggestion: false } : {}), 'wrap-up-story-settings-chat'));
  const host = useStoryHost(fixture, fn());
  return (
    <StructuredAgentSessionPanel {...panelProps('wrap-up-story-settings-chat', host, 'claude', 'format', locale, meta.args)}
      {...(paused ? { usage: { fiveHour: { usedPercent: 92, resetsAt: RESUME_AT }, weekly: { usedPercent: 61 }, contextPercent: 41 } } : {})} />
  );
}
async function showSettings(canvasElement: HTMLElement, at = '[data-testid="turn-wrap-up-settings"]'): Promise<HTMLElement> {
  const section = await waitFor(() => { const element = within(canvasElement).getByTestId('turn-wrap-up-settings'); expect(element).toBeVisible(); return element; }, { timeout: 10_000 });
  const target = await findIn(canvasElement, at);
  target.scrollIntoView({ block: at === '[data-testid="turn-wrap-up-settings"]' ? 'start' : 'center' });
  return section;
}
/** D9 option A (and D1 on): its own section on Settings › 에이전트, after 에이전트 협업. Every switch says what it costs. */
export const SettingsTurnWrapUp: Story = {
  render: () => <SettingsScreen />,
  play: async ({ canvasElement }) => {
    const section = await showSettings(canvasElement);
    await expect(within(section).getByRole('switch', { name: /Codex/u })).toBeChecked();
    await userEvent.click(within(section).getByRole('switch', { name: /요약 카드/u }));
    await expect(within(section).getByRole('switch', { name: /요약 카드/u })).not.toBeChecked();
    await userEvent.click(within(section).getByRole('switch', { name: /요약 카드/u }));
  },
};
/** D1 option: Codex suggestions start off (one more call per turn, half of them empty). */
export const SettingsCodexOff: Story = {
  render: () => <SettingsScreen settings={{ ...SETTINGS_ON, suggestions: { claude: true, codex: false } }} />,
  play: async ({ canvasElement }) => {
    const section = await showSettings(canvasElement);
    await expect(within(section).getByRole('switch', { name: /Codex/u })).not.toBeChecked();
  },
};
/** Near the limit: the pause in force, in words, and when the automatic calls come back. */
export const SettingsPaused: Story = {
  render: () => <SettingsScreen paused={PAUSED} />,
  play: async ({ canvasElement }) => {
    const section = await showSettings(canvasElement, '[data-testid="turn-wrap-up-paused"]');
    await expect(within(section).getByTestId('turn-wrap-up-paused')).toHaveTextContent('지금 Claude 5시간 사용량 92% — 자동 호출을 멈췄습니다');
  },
};
/** D9 option B: inside the AI 대화 group. */
export const SettingsInAiChat: Story = {
  render: () => <SettingsScreen placement="ai-chat" />,
  play: async ({ canvasElement }) => { await showSettings(canvasElement); },
};
/** English. */
export const SettingsEnglish: Story = {
  render: () => <StoryLocale.Provider value="en"><SettingsScreen paused={PAUSED} /></StoryLocale.Provider>,
  play: async ({ canvasElement }) => { await showSettings(canvasElement); },
};

// ── Reference variants (the Storybook locale picks the language) ───────────────────────────────────────
function ReferenceFrame({ locale, children }: { readonly locale: WrapLanguage; readonly children: ReactNode }): JSX.Element {
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
const showRecap: Story['play'] = async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="chat-recap-card"]'); await findIn(canvasElement, '[data-testid="structured-agent-suggestion"]'); };
const showTasks: Story['play'] = async ({ canvasElement }) => { await showCard(canvasElement); };
export const AwayClaudeReference = reference(AwayClaude, showRecap);
export const CliSuggestionReference = reference(CliSuggestion, showRecap);
export const RecapWaitingReference = reference(RecapWaiting, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="chat-recap-card"]'); });
export const TasksClaudeReference = reference(TasksClaude, showTasks);
export const CliTasksReference = reference(CliTasks, showTasks);
export const TasksStartAllReference = reference(TasksStartAll, async ({ canvasElement }) => {
  const card = await showCard(canvasElement);
  await userEvent.click(within(card).getByTestId('chat-task-start-all'));
  await waitFor(() => expect(document.querySelector('[data-testid="task-start-all-dialog"]')).not.toBeNull());
});
export const PhoneSuggestionReference = reference(PhoneSuggestion360, async ({ canvasElement }) => { await findIn(canvasElement, '[data-testid="structured-agent-suggestion-chip"]'); });
export const PhoneTasksReference = reference(PhoneTasks360, showTasks);
export const SettingsTurnWrapUpReference = reference(SettingsTurnWrapUp, async ({ canvasElement }) => { await showSettings(canvasElement); });
