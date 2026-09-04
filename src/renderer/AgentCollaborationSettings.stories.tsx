import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

import type { AgentOrchestrationSnapshot } from '../shared/agent-orchestration';
import type { EzTerminalDesktopApi } from '../shared/ipc';
import { AgentCollaborationSettings } from './AgentCollaborationSettings';
import { AppI18nProvider } from './i18n';
import './index.css';

const snapshot: AgentOrchestrationSnapshot = {
  revision: 4,
  providers: [
    { providerId: 'codex', kind: 'builtin', displayName: 'Codex' },
    { providerId: 'claude', kind: 'builtin', displayName: 'Claude Code' },
  ],
  profiles: [
    {
      profileId: 'builtin:codex:read', providerId: 'codex', launcherId: 'codex',
      name: 'Codex · Read & verify', description: 'Read-only investigation and independent verification.',
      permissionMode: 'read-only', capabilities: ['lead', 'worker', 'read', 'verify', 'parent-events'],
      available: true, revision: 1,
    },
    {
      profileId: 'builtin:codex:write', providerId: 'codex', launcherId: 'codex',
      name: 'Codex · Workspace writer', description: 'Writes inside a dedicated managed worktree.',
      permissionMode: 'workspace-write', capabilities: ['lead', 'worker', 'read', 'write', 'parent-events'],
      available: true, revision: 1,
    },
    {
      profileId: 'builtin:claude:read', providerId: 'claude', launcherId: 'claude',
      name: 'Claude Code · Read & verify', description: 'Plan-mode investigation and verification.',
      permissionMode: 'plan', capabilities: ['lead', 'worker', 'read', 'verify', 'parent-events'],
      available: false, revision: 1,
    },
  ],
  policies: [],
  runs: [],
  events: [],
  migration: { required: false, catalogItemCount: 0, runCount: 0 },
};

function StorySurface(): JSX.Element {
  const [previous] = useState(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        getAgentOrchestrationSnapshot: async () => snapshot,
        onAgentOrchestrationSnapshot: () => () => undefined,
        confirmLegacyTeamMigration: async () => snapshot.migration,
        getAgentAdapterSnapshot: async () => ({ revision: 0, adapters: [], trustedPublishers: [] }),
        onAgentAdapterSnapshot: () => () => undefined,
        selectAgentAdapterBundle: async () => null,
      } as EzTerminalDesktopApi,
    });
    return descriptor;
  });
  useEffect(() => () => {
    if (previous) Object.defineProperty(window, 'ezterminalDesktop', previous);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [previous]);
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 420, padding: 16, background: 'var(--ui-surface-base)' }}>
        <AgentCollaborationSettings />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Settings/Lead Collaboration',
  component: StorySurface,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof StorySurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConfiguredProfiles: Story = {};
