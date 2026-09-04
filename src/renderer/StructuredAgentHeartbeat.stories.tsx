import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { AppI18nProvider } from './i18n';
import { StructuredAgentHeartbeat } from './StructuredAgentHeartbeat';
import './index.css';
import './structured-agent.css';

const NOW = '2026-09-04T09:30:00.000Z';

const meta = {
  title: 'Agents/Structured heartbeat',
  component: StructuredAgentHeartbeat,
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
  },
  decorators: [
    (Story) => (
      <AppI18nProvider locale="en" languages={['en']}>
        <div className="structured-agent" style={{ width: 'min(92vw, 760px)' }}><Story /></div>
      </AppI18nProvider>
    ),
  ],
  args: {
    sessionId: 'agent-session-demo',
    automationReady: true,
    onSave: fn(async () => ({ ok: true as const })),
    onRunNow: fn(async () => ({ ok: true as const })),
    onEnableHost: fn(async () => ({ ok: true as const })),
  },
} satisfies Meta<typeof StructuredAgentHeartbeat>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotConfigured: Story = {};

export const Active: Story = {
  args: {
    value: {
      sessionId: 'agent-session-demo',
      prompt: 'Check blockers and report only meaningful changes.',
      cron: '*/15 * * * *',
      timezone: 'Asia/Seoul',
      enabled: true,
      pending: false,
      nextRunAt: '2026-09-04T10:00:00.000Z',
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    },
  },
};

export const Pending: Story = {
  args: {
    value: {
      sessionId: 'agent-session-demo',
      prompt: 'Check blockers and report only meaningful changes.',
      cron: '*/15 * * * *',
      timezone: 'Asia/Seoul',
      enabled: true,
      pending: true,
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
    },
  },
};

export const HostPaused: Story = {
  args: {
    automationReady: false,
    value: {
      sessionId: 'agent-session-demo',
      prompt: 'Check blockers and report only meaningful changes.',
      cron: '*/15 * * * *',
      timezone: 'Asia/Seoul',
      enabled: true,
      pending: false,
      revision: 5,
      createdAt: NOW,
      updatedAt: NOW,
    },
  },
};
