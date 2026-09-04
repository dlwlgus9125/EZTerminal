import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import {
  DaemonAgentSessions,
  type DaemonAgentSessionListAccess,
} from './DaemonAgentSessions';
import { AppI18nProvider } from './i18n';
import './index.css';

const NOW = '2026-09-04T10:30:00.000Z';

const snapshot: DaemonSnapshot = {
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  revision: 18,
  eventSequence: 32,
  generatedAt: NOW,
  runtime: {
    keepRunning: false,
    startAtLogin: false,
    orchestrationToolsEnabled: true,
    browserEnabled: false,
  },
  projects: [{
    id: 'ezterminal',
    name: 'EZTerminal',
    rootPath: 'C:\\Working\\EZTerminal',
    source: 'native',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  workspaces: [{
    id: 'workspace-main',
    projectId: 'ezterminal',
    name: 'main',
    kind: 'local',
    rootPath: 'C:\\Working\\EZTerminal',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  sessions: [
    ...[
      ['lead', 'Ship durable Agent navigation', 'running'],
      ['child', 'Review accessibility states', 'idle'],
      ['native', 'Search provider documentation', 'running'],
    ].map(([id, title, state]) => ({
      id,
      projectId: 'ezterminal',
      workspaceId: 'workspace-main',
      kind: 'agent' as const,
      title,
      state: state as 'running' | 'idle',
      source: 'structured' as const,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    {
      id: 'archived-child',
      projectId: 'ezterminal',
      workspaceId: 'workspace-main',
      kind: 'agent',
      title: 'Inspect archived provider failure',
      state: 'archived',
      source: 'structured',
      archivedAt: NOW,
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  agents: [{
    sessionId: 'lead',
    providerId: 'codex',
    model: 'gpt-5.6-codex',
    permissionPreset: 'standard',
    state: 'working',
    queuedTurnCount: 0,
    orchestrationEnabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    sessionId: 'child',
    providerId: 'claude',
    model: 'sonnet',
    permissionPreset: 'plan',
    state: 'idle',
    queuedTurnCount: 0,
    orchestrationEnabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    sessionId: 'native',
    providerId: 'claude',
    permissionPreset: 'plan',
    state: 'working',
    queuedTurnCount: 0,
    orchestrationEnabled: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    sessionId: 'archived-child',
    providerId: 'codex',
    permissionPreset: 'standard',
    state: 'archived',
    queuedTurnCount: 0,
    orchestrationEnabled: true,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  agentRelations: [{
    id: 'lead-child',
    treeId: 'lead',
    parentSessionId: 'lead',
    childSessionId: 'child',
    owner: 'managed',
    depth: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    id: 'lead-native',
    treeId: 'lead',
    parentSessionId: 'lead',
    childSessionId: 'native',
    owner: 'provider-native',
    depth: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    id: 'lead-archived-child',
    treeId: 'lead',
    parentSessionId: 'lead',
    childSessionId: 'archived-child',
    owner: 'managed',
    depth: 1,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  turns: [],
  transcriptHeads: [],
  approvals: [],
  providers: [{
    id: 'codex',
    displayName: 'Codex',
    protocol: 'codex-app-server',
    executablePath: 'C:\\Tools\\codex.exe',
    executableVersion: '1.0.0',
    argv: ['app-server'],
    environmentVariableNames: [],
    capabilities: [],
    enabled: true,
    health: 'ready',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    id: 'claude',
    displayName: 'Claude Code',
    protocol: 'claude-agent-sdk',
    executablePath: 'C:\\Tools\\claude.exe',
    executableVersion: '1.0.0',
    argv: ['-p'],
    environmentVariableNames: [],
    capabilities: [],
    enabled: true,
    health: 'ready',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  schedules: [],
  heartbeats: [],
};

const access: DaemonAgentSessionListAccess = {
  getSnapshot: async () => snapshot,
  observeEvents: () => () => undefined,
};

function StorySurface(): JSX.Element {
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 390, minHeight: 620, padding: 12, background: 'var(--ui-surface)' }}>
        <DaemonAgentSessions access={access} onOpenSession={fn()} />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Agents/Persisted structured sessions',
  component: StorySurface,
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
  },
} satisfies Meta<typeof StorySurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectWorkspaceHierarchy: Story = {};

export const ArchivedHistory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('daemon-agent-sessions-archived'));
    await expect(await canvas.findByText('Inspect archived provider failure')).toBeVisible();
    await expect(canvas.getByText('Managed child of Ship durable Agent navigation')).toBeVisible();
  },
};
