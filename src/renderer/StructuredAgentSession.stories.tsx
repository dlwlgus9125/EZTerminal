import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { ReactNode } from 'react';

import type { DaemonApproval, DaemonTranscriptItem } from '../shared/daemon-protocol';
import {
  StructuredAgentChildTrack,
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentSessionPanelProps,
} from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';
import './index.css';
import './structured-agent.css';

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
      <div style={{ width: 'min(100vw, 1040px)', height: 'min(88vh, 760px)' }}>{children}</div>
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
