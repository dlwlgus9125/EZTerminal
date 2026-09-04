import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';

import type { AgentOrchestrationSnapshot, CollaborationPolicy } from '../shared/agent-orchestration';
import {
  DEFAULT_COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_MERGE_POLICY,
} from '../shared/agent-orchestration';
import type { AgentProjectSummary } from '../shared/agent-history';
import type { EzTerminalApi, EzTerminalDesktopApi } from '../shared/ipc';
import { AgentHub } from './AgentHub';
import { AppI18nProvider } from './i18n';
import './index.css';

const project: AgentProjectSummary = {
  projectId: 'integration-recovery',
  name: 'Paseo-style collaboration',
  primaryRoot: 'C:\\Working\\Project',
  additionalRoots: [],
  pinned: true,
  saved: true,
  sessionCount: 0,
  providers: ['codex', 'claude'],
  lastActiveAt: 20,
};

const policy: CollaborationPolicy = {
  schemaVersion: 1,
  projectId: project.projectId,
  enabled: true,
  permissionMode: 'ask',
  allowedWorkerProfileIds: [],
  limits: DEFAULT_COLLABORATION_LIMITS,
  mergePolicy: DEFAULT_COLLABORATION_MERGE_POLICY,
  revision: 1,
  updatedAt: 20,
};

const orchestrationSnapshot: AgentOrchestrationSnapshot = {
  revision: 1,
  providers: [
    { providerId: 'codex', kind: 'builtin', displayName: 'Codex' },
    { providerId: 'claude', kind: 'builtin', displayName: 'Claude Code' },
  ],
  profiles: [{
    profileId: 'builtin:codex:read', providerId: 'codex', launcherId: 'codex',
    name: 'Codex · Read & verify', description: 'Read-only investigation and independent verification.',
    permissionMode: 'read-only', capabilities: ['lead', 'worker', 'read', 'verify'],
    available: false, revision: 1,
  }, {
    profileId: 'builtin:claude:read', providerId: 'claude', launcherId: 'claude',
    name: 'Claude Code · Read & verify', description: 'Plan-mode investigation and independent verification.',
    permissionMode: 'plan', capabilities: ['lead', 'worker', 'read', 'verify'],
    available: false, revision: 1,
  }],
  policies: [policy],
  runs: [],
  events: [],
  migration: { required: false, catalogItemCount: 0, runCount: 0 },
};

function StorySurface(): JSX.Element {
  const [previous] = useState(() => {
    const descriptors = {
      api: Object.getOwnPropertyDescriptor(window, 'ezterminal'),
      desktop: Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop'),
    };
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        ...(window.ezterminal ?? {}),
        listAgentProjects: async () => ({ items: [project], nextCursor: null }),
      } as EzTerminalApi,
    });
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        listAgentIntegrations: async () => ([
          { provider: 'codex', configPath: 'C:\\Users\\me\\.codex\\hooks.json', enabled: false, drift: false, needsTrust: false, blockers: [] },
          { provider: 'claude', configPath: 'C:\\Users\\me\\.claude\\settings.json', enabled: false, drift: false, needsTrust: false, blockers: [] },
        ]),
        setAgentIntegrationEnabled: async (provider) => ({
          ok: true,
          status: { provider, configPath: '', enabled: true, drift: false, needsTrust: provider === 'codex', blockers: [] },
        }),
        } as EzTerminalDesktopApi,
    });
    return descriptors;
  });
  useEffect(() => () => {
    if (previous.api) Object.defineProperty(window, 'ezterminal', previous.api);
    else Reflect.deleteProperty(window, 'ezterminal');
    if (previous.desktop) Object.defineProperty(window, 'ezterminalDesktop', previous.desktop);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [previous]);

  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 420, height: 760, background: 'var(--ui-surface-base)' }}>
        <AgentHub
          snapshot={{ revision: 0, items: [] }}
          orchestrationSnapshot={orchestrationSnapshot}
          onFocusSession={() => undefined}
          onSendFollowup={async () => ({ ok: true })}
          onSaveCoordinationProject={async () => ({ ok: false, error: 'unavailable', message: 'Story only' })}
          onSaveCollaborationPolicy={async () => ({ ok: true, value: policy })}
        />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Agents/Project collaboration',
  component: StorySurface,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof StorySurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectSettingsRetired: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(async () => {
      await expect(await canvas.findByText(project.name)).toBeVisible();
    });
    await expect(canvas.queryByRole('button', { name: 'Configure collaboration' })).not.toBeInTheDocument();
  },
};
