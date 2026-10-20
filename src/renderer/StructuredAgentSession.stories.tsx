import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { ReactNode } from 'react';

import type { AgentCapabilitiesClient } from '../shared/agent-capabilities';
import type { DaemonApproval, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { encodeFileChanges } from '../shared/conversation-changes';
import {
  StructuredAgentChildTrack,
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentSessionPanelProps,
} from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';
import { ChatRecoveryNotice } from './ChatRecoveryNotice';
import './index.css';
import './structured-agent.css';
import './session-start.css';

const NOW = '2026-09-04T09:30:00.000Z';

function item(
  id: string,
  sequence: number,
  kind: DaemonTranscriptItem['kind'],
  text: string,
  overrides: Partial<DaemonTranscriptItem> = {},
): DaemonTranscriptItem {
  return {
    id,
    sessionId: 'agent-session-demo',
    turnId: 'turn-demo',
    sequence,
    kind,
    text,
    isDelta: false,
    isSensitive: false,
    createdAt: NOW,
    ...overrides,
  };
}

const approval: DaemonApproval = {
  id: 'approval-1',
  sessionId: 'agent-session-demo',
  turnId: 'turn-demo',
  providerRequestId: 'provider-request-1',
  risk: 'write',
  title: 'Allow write to src/renderer/AgentPanel.tsx?',
  detail: 'The Agent wants to update one file in the selected worktree.',
  state: 'pending',
  revision: 12,
  createdAt: NOW,
  updatedAt: NOW,
};

const base: StructuredAgentSessionPanelProps = {
  sessionId: 'agent-session-demo',
  title: 'Implement structured Agent session UI',
  providerId: 'codex',
  providerLabel: 'Codex',
  workspace: {
    id: 'workspace-stage2',
    label: 'agent/orchestration-v2-s2-agent-ui',
    kind: 'worktree',
    path: 'C:\\Working\\EZTerminal-worktrees\\stage2-agent-ui',
  },
  model: 'gpt-5.6-codex',
  modelOptions: [
    { id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex' },
    { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' },
  ],
  permissionPreset: 'standard',
  state: 'idle',
  queuedCount: 0,
  items: [],
  onSend: fn(async () => ({ ok: true as const })),
  onInterruptAndSend: fn(async () => ({ ok: true as const })),
  onChangeSettings: fn(async () => ({ ok: true as const })),
  onResolveApproval: fn(async () => ({ ok: true as const })),
};

function Frame({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 'min(calc(100vw - 32px), 1040px)', height: 'min(88vh, 760px)' }}>{children}</div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Agents/Structured session',
  component: StructuredAgentSessionPanel,
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
  },
  args: base,
  render: (args) => <Frame><StructuredAgentSessionPanel {...args} /></Frame>,
} satisfies Meta<typeof StructuredAgentSessionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Draft: Story = {
  render: () => (
    <Frame>
      <StructuredAgentDraftPanel
        providers={[
          { id: 'codex', label: 'Codex', models: base.modelOptions ?? [] },
          { id: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet' }] },
        ]}
        workspaces={[base.workspace]}
        onCreate={fn(async () => ({ ok: true as const }))}
      />
    </Frame>
  ),
};

/** Starting a conversation in plan mode: the plan switch, then the access level the approved plan runs with. */
export const DraftPlanMode: Story = {
  render: () => (
    <Frame>
      <StructuredAgentDraftPanel
        providers={[{ id: 'codex', label: 'Codex', models: base.modelOptions ?? [] }]}
        workspaces={[base.workspace]}
        initialPermissionPreset="plan"
        onCreate={fn(async () => ({ ok: true as const }))}
      />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const settings = canvasElement.querySelector<HTMLDetailsElement>('.structured-agent-draft-settings')!;
    settings.open = true;
    await expect(within(canvasElement).getByTestId('structured-agent-start-in-plan')).toBeChecked();
  },
};

/** Plan mode is a switch beside the composer settings; the permission pill keeps only access levels. */
export const PlanModeOn: Story = {
  args: {
    permissionPreset: 'plan',
    items: [item('user-plan', 1, 'user-message', 'Plan how to add a farewell(name) function next to greet.')],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('structured-agent-live-plan')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByTestId('structured-agent-live-permission'));
    const options = await within(document.body).findAllByRole('menuitemradio');
    await expect(options).toHaveLength(2);
    await userEvent.keyboard('{Escape}');
  },
};

function NarrowKorean({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <div style={{ width: 520, height: 560, display: 'flex' }}>{children}</div>
    </AppI18nProvider>
  );
}

/** A split pane: the title and state stay readable, the settings fit one row, and a failure reads as a banner. */
export const NarrowPaneSettingFailed: Story = {
  args: {
    title: '로그인 오류 메시지 개선', effortSupported: true, reasoningEffort: 'high',
    items: [item('user-narrow', 1, 'user-message', '로그인 실패 문구를 바꿔 줘.')],
    onChangeSettings: fn(async () => ({ ok: false as const, message: 'Expected revision 41, but current revision is 42.' })),
  },
  render: (args) => <NarrowKorean><StructuredAgentSessionPanel {...args} /></NarrowKorean>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('structured-agent-composer-hint')).toHaveTextContent('Shift+Tab 계획');
    await userEvent.click(canvas.getByTestId('structured-agent-live-plan'));
    await expect(await canvas.findByTestId('structured-agent-session-error')).toHaveTextContent('설정을 바꾸지 못했습니다.');
  },
};

/** During a turn the locked settings say why under the message box. */
export const NarrowPaneWorking: Story = {
  args: {
    title: '로그인 오류 메시지 개선', state: 'working', effortSupported: true, reasoningEffort: 'high',
    items: [item('user-narrow', 1, 'user-message', '로그인 실패 문구를 바꿔 줘.')],
  },
  render: (args) => <NarrowKorean><StructuredAgentSessionPanel {...args} /></NarrowKorean>,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('structured-agent-composer-hint')).toHaveTextContent('이 작업이 끝난 뒤');
  },
};

function WideKorean({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <div style={{ width: 760, height: 560, display: 'flex' }}>{children}</div>
    </AppI18nProvider>
  );
}

const codexModels = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol' }, { id: 'gpt-6-luna', label: 'GPT-6-Luna' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
];

/** The message box says whose model it is: the AI's colour on its edge and its name on the model pill and menu. */
export const ComposerCodex: Story = {
  args: { title: '로그인 오류 메시지 개선', model: 'gpt-6-astra', modelOptions: codexModels, effortSupported: true,
    items: [item('user-codex', 1, 'user-message', '로그인 실패 문구를 바꿔 줘.')] },
  render: (args) => <WideKorean><StructuredAgentSessionPanel {...args} /></WideKorean>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('.chat-composer')).toHaveAttribute('data-provider', 'codex');
    await expect(canvas.getByTestId('structured-agent-live-model')).toHaveTextContent('Codex·GPT-6-Astra');
    await expect(canvas.getByTestId('structured-agent-live-model')).toHaveAccessibleName('Codex 모델: GPT-6-Astra');
  },
};

export const ComposerClaude: Story = {
  args: { ...ComposerCodex.args, providerId: 'claude', providerLabel: 'Claude Agent', model: 'claude-opus-5-5',
    modelOptions: [{ id: 'default', label: 'Default (recommended)' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
  render: (args) => <WideKorean><StructuredAgentSessionPanel {...args} /></WideKorean>,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('structured-agent-live-model')).toHaveAccessibleName('Claude 모델: Opus 5.5');
  },
};

const loadingCatalog: AgentCapabilitiesClient = {
  list: () => new Promise(() => undefined),
  manage: async () => ({ ok: false, code: 'unavailable', message: 'Not in this story.' }),
};

/** Before the AI's catalog arrives the menu says the models are still loading instead of looking incomplete. */
export const ComposerModelsLoading: Story = {
  args: { ...ComposerCodex.args, model: undefined, modelOptions: [], capabilityClient: loadingCatalog },
  render: (args) => <WideKorean><StructuredAgentSessionPanel {...args} /></WideKorean>,
  play: async ({ canvasElement }) => {
    const pill = within(canvasElement).getByTestId('structured-agent-live-model');
    await expect(pill).toHaveAccessibleName('Codex 모델: 기본 모델');
    await userEvent.click(pill);
    const menu = await within(document.body).findByRole('menu');
    await expect(within(menu).getByRole('status')).toHaveTextContent('모델 불러오는 중…');
    await userEvent.keyboard('{Escape}');
  },
};

const MINUTE = 60_000;
const in2h10m = Date.now() + 130 * MINUTE + 30_000;
const in2d5h = Date.now() + (53 * 60) * MINUTE + 30_000;

/** The settings row carries the AI's plan limits and this conversation's context as gauges; the details open from it. */
export const ComposerUsageClaude: Story = {
  args: { ...ComposerClaude.args, usage: {
    fiveHour: { usedPercent: 12, resetsAt: in2h10m }, weekly: { usedPercent: 26, resetsAt: in2d5h }, limitsObservedAt: Date.now() - 3 * MINUTE,
    contextPercent: 34, contextObservedAt: Date.now(),
  } },
  render: (args) => <WideKorean><StructuredAgentSessionPanel {...args} /></WideKorean>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pill = canvas.getByTestId('structured-agent-usage');
    await expect(pill).toHaveAccessibleName(/^Claude 사용량: 5시간 한도 12% 사용\(2h\d+m 후 초기화\), 주간 한도 26% 사용\(2d\d+h 후 초기화\), 컨텍스트 34% 사용$/);
    await userEvent.click(pill);
    const details = await within(document.body).findByRole('dialog', { name: 'Claude 사용량' });
    await expect(details).toHaveTextContent(/5시간12%2h\d+m 후 초기화/);
    await expect(details).toHaveTextContent('컨텍스트34%');
    await expect(details).toHaveTextContent(/갱신 3분 전/);
  },
};

/** Near a limit the gauge turns amber from 70% and red from 90%; a window the account does not have is not shown. */
export const ComposerUsageCodexNearLimit: Story = {
  args: { ...ComposerCodex.args, usage: { weekly: { usedPercent: 92, resetsAt: in2d5h }, limitsObservedAt: Date.now(), contextPercent: 74, contextObservedAt: Date.now() } },
  render: (args) => <WideKorean><StructuredAgentSessionPanel {...args} /></WideKorean>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByTestId('structured-agent-usage-fiveHour')).toBeNull();
    await expect(canvas.getByTestId('structured-agent-usage-weekly')).toHaveAttribute('data-level', 'danger');
    await expect(canvas.getByTestId('structured-agent-usage-context')).toHaveAttribute('data-level', 'warning');
    await userEvent.click(canvas.getByTestId('structured-agent-usage'));
    await expect(await within(document.body).findByRole('dialog', { name: 'Codex 사용량' })).toHaveTextContent('주간92%');
  },
};

/** An API-key session has no plan limits: only the context gauge is shown. */
export const ComposerUsageContextOnly: Story = {
  args: { ...ComposerClaude.args, usage: { contextPercent: 8, contextObservedAt: Date.now() } },
  render: (args) => <WideKorean><StructuredAgentSessionPanel {...args} /></WideKorean>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('structured-agent-usage')).toHaveAccessibleName('Claude 사용량: 컨텍스트 8% 사용');
    await expect(canvas.queryByTestId('structured-agent-usage-weekly')).toBeNull();
  },
};

/** In a split pane the settings keep one row and the gauges stay in it. */
export const NarrowPaneUsage: Story = {
  args: { ...ComposerUsageClaude.args },
  render: (args) => <NarrowKorean><StructuredAgentSessionPanel {...args} /></NarrowKorean>,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('structured-agent-usage')).toBeVisible();
  },
};

/** An ended conversation shows its settings as text: plan mode, then the access level. */
export const PlanModeReadOnly: Story = { args: { permissionPreset: 'plan', state: 'done', items: [item('user-plan', 1, 'user-message', 'Plan the release notes.')] } };

export const Streaming: Story = {
  args: {
    state: 'working',
    queuedCount: 2,
    items: [
      item('user-1', 1, 'user-message', 'Build the structured Agent experience and keep the old PTY history intact.'),
      item('reasoning-1', 2, 'reasoning', 'I will first inspect the existing visual contract and panel routing.'),
      item('assistant-delta-1', 3, 'assistant-message', 'I added the semantic transcript, ', { isDelta: true }),
      item('assistant-delta-2', 4, 'assistant-message', 'approval cards, and a FIFO composer.', { isDelta: true }),
    ],
  },
};

export const Approval: Story = {
  args: {
    state: 'blocked',
    approvals: [approval],
    items: [
      item('user-1', 1, 'user-message', 'Apply the renderer changes.'),
      item('tool-1', 2, 'tool-call', 'apply_patch src/renderer/AgentPanel.tsx'),
      item('approval-1', 3, 'approval', approval.title),
    ],
  },
};

export const Error: Story = {
  args: {
    state: 'error',
    transcriptError: 'The newest transcript page could not be loaded. Existing messages are still shown.',
    items: [
      item('user-1', 1, 'user-message', 'Continue the implementation.'),
      item('error-1', 2, 'error', 'Provider process exited before the turn completed.'),
    ],
  },
};

export const Empty: Story = {
  args: {
    state: 'idle',
    items: [],
  },
};

export const ArchivedHistory: Story = {
  args: {
    state: 'archived',
    historyOnly: true,
    items: [
      item('user-archived', 1, 'user-message', 'Capture the failure before provider startup.'),
      item('error-archived', 2, 'error', 'The provider executable was unavailable.'),
    ],
  },
  render: (args) => (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 'min(100vw, 390px)', height: 'min(88vh, 720px)' }}>
        <StructuredAgentSessionPanel {...args} variant="mobile" />
      </div>
    </AppI18nProvider>
  ),
};

export const ChildAgentsAndLifecycle: Story = {
  args: {
    state: 'idle',
    items: [
      item('child-update', 1, 'child-summary', 'The accessibility review is ready.', {
        relatedSessionId: 'agent-child-a11y',
      }),
    ],
    childTrack: (
      <StructuredAgentChildTrack
        items={[
          {
            sessionId: 'agent-child-a11y',
            title: 'Review keyboard and screen reader flow',
            providerLabel: 'Codex',
            state: 'idle',
            owner: 'managed',
          },
          {
            sessionId: 'agent-child-native',
            title: 'Provider search worker',
            providerLabel: 'Claude Code',
            state: 'working',
            owner: 'provider-native',
          },
        ]}
        onSelectSession={fn()}
      />
    ),
    onOpenRelatedSession: fn(),
    onArchive: fn(async () => ({ ok: true as const })),
    onDetach: fn(async () => ({ ok: true as const })),
  },
};

export const NotStarted: Story = { args: { title: 'Codex', awaitingFirstMessage: true } };
export const MobileNotStarted: Story = { args: { title: 'Codex', awaitingFirstMessage: true, variant: 'mobile' } };

const skinConversation: DaemonTranscriptItem[] = [
  item('skin-user', 1, 'user-message', 'Keep the chat features and show this conversation with a CLI skin.'),
  item('skin-tool', 2, 'tool-result', 'Checked message identity, attachments, composer state and approval actions.'),
  item('skin-agent', 3, 'assistant-message', 'The conversation uses the same messages in both skins.\n\nAttachments, replies and explicit approval remain available.'),
];
const composeDraft = {
  text: 'Make the input area a little more compact.',
  replyTo: { messageId: 'skin-agent', text: 'The conversation uses the same messages in both skins.' },
  attachments: [{ id: 'reference-1', name: 'chat-requirements.md', mimeType: 'text/markdown', kind: 'text' as const,
    data: '# Chat requirements\nKeep the existing terminal and use one conversation in both skins.' }],
};

export const BubbleConversation: Story = { args: { items: skinConversation, skin: 'bubble', supportsMessageContext: true } };
export const CliConversation: Story = { args: { items: skinConversation, skin: 'cli', supportsMessageContext: true } };
export const BubbleCompose: Story = { args: { items: skinConversation, skin: 'bubble', supportsMessageContext: true, draftState: composeDraft } };
export const CliCompose: Story = { args: { ...BubbleCompose.args, skin: 'cli' } };
export const DraftStorageConflict: Story = { args: { ...CliCompose.args, sendDisabled: true,
  recoveryControl: <ChatRecoveryNotice controller={null} view={{ status: 'conflict', draft: composeDraft,
    conflict: { version: 1, scope: { projectId: 'project', sessionId: 'agent-session-demo' }, revision: 3, updatedAt: NOW,
      state: { draft: { text: 'The draft changed in another window. Keep the reply and attachments visible in both skins.' } } } }} />,
} };
export const CliStreaming: Story = { args: { ...Streaming.args, skin: 'cli', supportsMessageContext: true } };
export const CliApproval: Story = { args: { ...Approval.args, skin: 'cli', supportsMessageContext: true } };
export const DeliveryUncertain: Story = { args: {
  items: skinConversation, skin: 'cli', draftState: composeDraft, supportsMessageContext: true,
  deliveryUncertain: true, onReconcileDelivery: fn(async () => ({ ok: false as const, message: 'The host receipt is still unavailable.', deliveryUncertain: true })),
} };
export const MobileCliCompose: Story = {
  args: { ...CliCompose.args, variant: 'mobile' },
  parameters: { layout: 'fullscreen' },
  render: (args) => <AppI18nProvider locale="ko" languages={['ko']}>
    <div style={{ width: 'min(100vw, 390px)', height: 'min(100vh, 844px)' }}><StructuredAgentSessionPanel {...args} /></div>
  </AppI18nProvider>,
};
export const MobileBubbleCompose: Story = { ...MobileCliCompose, args: { ...MobileCliCompose.args, skin: 'bubble' } };
/** On the phone the usage pill sits with the other settings. */
export const MobileCliComposeUsage: Story = { ...MobileCliCompose, args: { ...MobileCliCompose.args, usage: ComposerUsageClaude.args?.usage },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('structured-agent-usage')).toBeVisible();
  } };
export const MobileOfflineDraft: Story = { ...MobileCliCompose, args: {
  ...MobileCliCompose.args, disabled: true, allowDraftWhenDisabled: true, sendDisabled: true,
  sendDisabledReason: '오프라인입니다. 초안은 기기에 보관되며 다시 연결한 뒤 직접 전송하세요.',
} };

export const ChangeReview: Story = {
  args: { ...BubbleCompose.args, title: '대화 화면 개선', items: [
    item('review-user', 1, 'user-message', '입력창의 포커스 표시를 개선해 주세요.'),
    item('review-patch', 2, 'tool-result', encodeFileChanges([{ path: 'src/renderer/conversation.css', coverage: 'patch', patch: '@@ -12,3 +12,3 @@\n .composer:focus-within {\n-  border-color: var(--ui-border);\n+  border-color: var(--ui-focus);\n }' }])!),
    item('review-answer', 3, 'assistant-message', '입력 중인 영역이 분명하게 보이도록 포커스 색상을 적용했습니다. 변경 검토에서 패치를 확인할 수 있습니다.'),
  ] },
  render: args => <AppI18nProvider locale="ko" languages={['ko']}><div style={{ width: '100vw', height: '100vh' }}><StructuredAgentSessionPanel {...args} /></div></AppI18nProvider>,
  parameters: { layout: 'fullscreen' },
};
export const MobileChangeReview: Story = { ...ChangeReview, args: { ...ChangeReview.args, variant: 'mobile' } };
export const QueuedRequests: Story = { ...ChangeReview, args: { ...ChangeReview.args, state: 'working', queuedCount: 2, queueItems: [
  { turnId: 'queue-a', revision: 4, text: '모바일에서도 Enter는 줄바꿈으로 유지해 주세요.' },
  { turnId: 'queue-b', revision: 5, text: '라이트 테마의 포커스도 확인해 주세요.' },
], onQueueAction: fn(async () => ({ ok: true as const })) } };
