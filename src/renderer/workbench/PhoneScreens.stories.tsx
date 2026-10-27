import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { MobileFeedView } from '../../../mobile/src/feed/MobileFeedView';
import { MobileSessionView } from '../../../mobile/src/MobileSessionView';
import { MobileStructuredAgentSession } from '../../../mobile/src/MobileStructuredAgentSession';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { StructuredAgentChildTrack } from '../StructuredAgentSession';
import { feedConversations, feedFlows, feedProjects, feedWaiting, type FeedScope } from '../../../mobile/src/feed/feed-model';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import type { AgentActivity } from '../../shared/agent';
import type { HostAttention } from '../../shared/host-attention';
import { CONVERSATION_VIEWS_KEY } from '../conversation-views';
import { AppI18nProvider } from '../i18n';
import { shellSnapshot, shellWorkflow } from '../shell/shell-fixtures';
import { createTerminalAiHost } from '../terminal/terminal-ai-host';
import { CWD, START, scriptedClock, snapshotWithProvider, storyHost } from '../terminal/terminal-story-host';
import { Glyph, Menu, MenuItem, glyphIcon } from '../ui';
import '../mobile-shared.css';
import '../structured-agent.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import './phone-screens.css';

/**
 * The phone's 2.0 screens (I4, layout A chosen 2026-10-27: no tab bar, as the approved prototype b180f95), built from
 * the real phone components in a 412×915 frame. FeedReference, ChatReference and TerminalReference are the approved
 * 2.0 references phone-feed, phone-chat and phone-terminal (docs/ux/reference/2.0/manifest.json).
 */
const meta = {
  title: 'Production/Phone/Phone screens',
  parameters: { layout: 'centered', a11y: { test: 'error' } },

} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const attention: HostAttention = {
  version: 1, digest: 'mockup',
  items: [
    { id: 'flow-1', kind: 'flow-approval', projectId: 'p-ez', title: '승인', since: '2026-10-24T09:25:00.000Z', subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4' },
  ],
};

const terminalAgents: readonly AgentActivity[] = [];

/** The reference stories follow the Storybook locale (the approved-surface checker opens them in both). */
function storyLocale(globals: Record<string, unknown>): 'ko' | 'en' {
  return globals.locale === 'en' ? 'en' : 'ko';
}

function Phone({ children, locale = 'ko' }: { readonly children: ReactNode; readonly locale?: 'ko' | 'en' }): JSX.Element {
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNavigationHistoryProvider>
        <MobileToastProvider>
          <div className="phone-i4-frame mobile-workbench-coordinator" data-testid="phone-i4-frame">{children}</div>
        </MobileToastProvider>
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>
  );
}

/** Variant A's header buttons: the prototype's terminal and PC-control buttons, plus ⋯ for the rest. */
function HeaderIconsA(): JSX.Element {
  return (
    <span className="phone-i4-icons">
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" aria-label="터미널"><Glyph name="term" size={20} /></button>
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" aria-label="PC 화면 제어"><Glyph name="pc" size={20} /></button>
      <Menu
        label="더보기"
        placement="bottom-end"
        trigger={<button type="button" className="mob-icon-btn mob-icon-btn--plate" aria-label="더보기" data-testid="phone-i4-more"><Glyph name="more" size={20} /></button>}
      >
        <MenuItem icon={glyphIcon('clock')} onSelect={() => undefined}>이전 대화 · CLI 기록</MenuItem>
        <MenuItem icon={glyphIcon('list')} onSelect={() => undefined}>터미널 세션</MenuItem>
        <MenuItem icon={glyphIcon('file')} onSelect={() => undefined}>파일</MenuItem>
        <MenuItem icon={glyphIcon('mon')} onSelect={() => undefined}>모니터</MenuItem>
        <MenuItem icon={glyphIcon('claw')} onSelect={() => undefined}>OpenClaw</MenuItem>
        <MenuItem icon={glyphIcon('palette')} onSelect={() => undefined}>테마</MenuItem>
        <MenuItem icon={glyphIcon('set')} onSelect={() => undefined}>설정</MenuItem>
      </Menu>
    </span>
  );
}

function Feed({ initialScope = null, headerActions, locale, projectScreens = false }: { readonly initialScope?: FeedScope; readonly headerActions?: ReactNode; readonly locale?: 'ko' | 'en'; readonly projectScreens?: boolean }): JSX.Element {
  const [scope, setScope] = useState<FeedScope>(initialScope);
  const daemon = useMemo(() => ({ ...shellSnapshot(), attention, providerUsage: { claude: { fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 21 } } } }), []);
  const projects = feedProjects(daemon);
  const workflows = new Map([['p-ez', shellWorkflow()]]);
  const waiting = feedWaiting(daemon, terminalAgents, workflows);
  const waitingSessions = new Set(waiting.flatMap((item) => item.sessionId ? [item.sessionId] : []));
  return (
    <Phone locale={locale}>
      <MobileFeedView
        projects={projects}
        scope={scope}
        onScopeChange={setScope}
        host={{ tone: 'on', label: '작업 PC · 18ms' }}
        headerActions={headerActions}
        waiting={waiting}
        flows={feedFlows(workflows, scope, projects)}
        conversations={feedConversations(daemon, scope, { waitingSessions, limit: 5 })}
        usage={daemon.providerUsage.claude}
        onDecide={async () => ({ ok: true })}
        onOpenWaiting={() => undefined}
        onOpenConversation={() => undefined}
        onOpenFlow={() => undefined}
        onSeeAllConversations={() => undefined}
        onNewConversation={() => undefined}
        {...(projectScreens ? { onOpenProjectScreen: () => undefined } : {})}
      />
    </Phone>
  );
}

/** A: no tab bar. The feed is the only first screen; terminal, PC control and ⋯ sit in its header. */
export const FeedReference: Story = { render: (_args, context) => <Feed headerActions={<HeaderIconsA />} projectScreens locale={storyLocale(context.globals)} /> };

/** A: the header ▾ — the scope of flows and conversations, and the way to the project screens. */
export const FeedAScopeMenu: Story = {
  render: () => <Feed initialScope="p-ez" headerActions={<HeaderIconsA />} projectScreens />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('mobile-feed-scope'));
    await waitFor(() => expect(within(canvasElement).getByTestId('mobile-feed-open-project')).toBeVisible());
  },
};

/** A: the header ⋯ — what the tab bar's 더보기 holds today, plus history. */
export const FeedAMoreMenu: Story = {
  render: () => <Feed headerActions={<HeaderIconsA />} projectScreens />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('phone-i4-more'));
    await waitFor(() => expect(within(canvasElement).getByRole('menu')).toBeVisible());
  },
};

/** The same feed narrowed to one project from the header ▾. */
export const FeedOneProject: Story = { render: () => <Feed initialScope="p-ez" headerActions={<HeaderIconsA />} projectScreens /> };

export const FeedEnglish: Story = { render: () => <Feed headerActions={<HeaderIconsA />} locale="en" /> };

/** The phone terminal on the stories' fake host: blocks in the instrument look, Shell | AI over the prompt line. */
function PhoneTerminal({ sessionId, locale }: { readonly sessionId: string; readonly locale?: 'ko' | 'en' }): JSX.Element {
  const clock = useMemo(scriptedClock, []);
  const [ready, setReady] = useState(false);
  const aiHost = useMemo(() => {
    const created = createTerminalAiHost({ openConversation: () => undefined, notifySent: () => undefined });
    created.set(snapshotWithProvider());
    return created;
  }, []);
  useLayoutEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(window, 'ezterminal');
    Object.defineProperty(window, 'ezterminal', { configurable: true, value: storyHost(clock) });
    // The last conversation looked at: the AI input sends there.
    const viewed = localStorage.getItem(CONVERSATION_VIEWS_KEY);
    localStorage.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify({ sessions: { 's-font': new Date(START).toISOString() }, last: 's-font' }));
    setReady(true);
    return () => {
      if (previous) Object.defineProperty(window, 'ezterminal', previous);
      else Reflect.deleteProperty(window, 'ezterminal');
      if (viewed === null) localStorage.removeItem(CONVERSATION_VIEWS_KEY);
      else localStorage.setItem(CONVERSATION_VIEWS_KEY, viewed);
    };
  }, [clock]);
  return (
    <Phone locale={locale}>
      <div className="phone-i4-terminal">
        {ready && <MobileSessionView sessionId={sessionId} cwd={CWD} active connected aiHost={aiHost} />}
      </div>
    </Phone>
  );
}

async function runCommand(canvas: ReturnType<typeof within>, command: string, count: number): Promise<void> {
  const input = await canvas.findByTestId('cmd-input');
  await waitFor(() => expect(input).not.toBeDisabled());
  await userEvent.click(input);
  await userEvent.type(input, `${command}{Enter}`);
  await waitFor(() => expect(canvas.getAllByTestId('block-status').filter((status: HTMLElement) => status.getAttribute('data-status') === 'done')).toHaveLength(count));
}

/** The phone terminal in the shell: two commands as instrument blocks. */
export const TerminalShell: Story = {
  render: () => <PhoneTerminal sessionId="phone-terminal-shell" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await runCommand(canvas, 'git status --short', 1);
    await runCommand(canvas, 'git log --oneline -3', 2);
  },
};

/** AI: the last conversation's own message box, the newest block attached as a chip. */
export const TerminalReference: Story = {
  render: (_args, context) => <PhoneTerminal sessionId="phone-terminal-ai" locale={storyLocale(context.globals)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await runCommand(canvas, 'git status --short', 1);
    await runCommand(canvas, 'git log --oneline -3', 2);
    await userEvent.click(canvas.getByTestId('terminal-mode-ai'));
    await waitFor(() => expect(canvas.getByTestId('terminal-ai-chip')).toBeInTheDocument());
    await expect(canvas.getByTestId('terminal-ai-target')).toHaveTextContent('설정 화면 글꼴 미리보기');
  },
};

const NOW = '2026-10-24T09:28:00.000Z';
function chatItem(id: string, sequence: number, kind: DaemonTranscriptItem['kind'], text: string): DaemonTranscriptItem {
  return { id, sessionId: 's-notify', turnId: 'turn-notify', sequence, kind, text, isDelta: false, isSensitive: false, createdAt: NOW };
}

/** The conversation on the phone: one header row, the approval as thumb buttons, sub-agent chips, two rows of chips. */
export const ChatReference: Story = {
  render: (_args, context) => {
    const snapshot = shellSnapshot();
    const approval = snapshot.approvals.find((candidate) => candidate.id === 'a-command')!;
    return (
      <Phone locale={storyLocale(context.globals)}>
        <MobileStructuredAgentSession
          sessionId="s-notify"
          title="Android 승인 알림이 두 번 뜨는 문제"
          providerId="claude"
          providerLabel="Claude"
          workspace={{ id: 'p-ez-main', label: 'main', kind: 'local', path: CWD }}
          model="claude-opus-5-5"
          modelOptions={[{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5', label: 'Sonnet 5' }]}
          effortSupported
          reasoningEffort="xhigh"
          permissionPreset="standard"
          state="blocked"
          approvals={[approval]}
          approvalResponses
          items={[
            chatItem('u1', 1, 'user-message', '알림이 두 번 뜨는 원인을 찾아서 고쳐 줘.'),
            chatItem('a1', 2, 'assistant-message', '호스트가 계산한 요청 요약 하나를 두 기기가 같이 쓰게 바꿨습니다. 테스트를 돌려 확인하겠습니다.'),
            chatItem('t1', 3, 'tool-call', 'pnpm --dir mobile test -- notifications'),
            chatItem('ap1', 4, 'approval', approval.title),
          ]}
          usage={{ fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 21 }, contextPercent: 38 }}
          childTrack={<StructuredAgentChildTrack items={[
            { sessionId: 's-dedupe', title: '중복 제거 테스트 작성', providerLabel: 'Claude', state: 'working', owner: 'provider-native' },
            { sessionId: 's-trace', title: '알림 경로 추적', providerLabel: 'Claude', state: 'done', owner: 'provider-native' },
          ]} onSelectSession={() => undefined} />}
          onSend={async () => ({ ok: true })}
          onChangeSettings={async () => ({ ok: true })}
          onResolveApproval={async () => ({ ok: true })}
          onOpenHistory={() => undefined}
          onDetach={async () => ({ ok: true })}
          onArchive={async () => ({ ok: true })}
          onBack={() => undefined}
        />
      </Phone>
    );
  },
};
