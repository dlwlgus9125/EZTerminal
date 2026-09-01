import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

import type { EzTerminalDesktopApi } from '../shared/ipc';
import type { AgentTeamDesktopSnapshot } from '../shared/agent-team';
import { AgentTeamSettings } from './AgentTeamSettings';
import { AppI18nProvider } from './i18n';
import './index.css';

const PLANNER_ID = '123e4567-e89b-12d3-a456-426614174000';
const IMPLEMENTER_ID = '123e4567-e89b-12d3-a456-426614174001';
const snapshot: AgentTeamDesktopSnapshot = {
  revision: 1,
  catalog: {
    revision: 3,
    capabilities: [
      {
        provider: 'codex', available: true, supportsModel: true,
        effortValues: [], permissionValues: ['read-only', 'workspace-write'], modelAvailability: 'launch-time',
      },
      {
        provider: 'claude', available: true, supportsModel: true,
        effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
        permissionValues: ['plan', 'manual', 'acceptEdits'], modelAvailability: 'launch-time',
      },
    ],
    personas: [
      {
        personaId: PLANNER_ID,
        revision: 1,
        name: 'Planner',
        preset: 'planner',
        icon: 'search',
        role: 'Breaks one goal into safe parallel slices',
        instructions: 'Propose bounded assignments and exclude unsafe splits.',
        launch: { provider: 'codex', sandbox: 'read-only' },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        personaId: IMPLEMENTER_ID,
        revision: 1,
        name: 'Implementer',
        preset: 'implementer',
        icon: 'code',
        role: 'Implements an approved bounded slice',
        instructions: 'Stay inside the approved scope and report overlap.',
        launch: { provider: 'claude', effort: 'high', permissionMode: 'acceptEdits' },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    teams: [{
      teamId: '123e4567-e89b-12d3-a456-426614174010',
      revision: 1,
      name: 'Product pair',
      description: 'One Planner and one bounded implementer',
      instructions: 'Prefer one clean seam and preserve user changes.',
      defaultGoal: {
        outcome: 'Ship one reviewable product improvement',
        acceptanceCriteria: ['The configured checks pass.', 'The reviewed scope contains no unrelated changes.'],
      },
      personaIds: [PLANNER_ID, IMPLEMENTER_ID],
      plannerPersonaId: PLANNER_ID,
      createdAt: 1,
      updatedAt: 1,
    }],
  },
  runRevision: 0,
  runs: [],
};

function StorySurface(): JSX.Element {
  const [previous] = useState(() => {
    const previous = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        getAgentTeamSnapshot: async () => snapshot,
        onAgentTeamSnapshot: () => () => undefined,
      } as EzTerminalDesktopApi,
    });
    return previous;
  });
  useEffect(() => () => {
    if (previous) Object.defineProperty(window, 'ezterminalDesktop', previous);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [previous]);
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 380, padding: 16, background: 'var(--ui-surface-base)' }}>
        <AgentTeamSettings />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Settings/Agent Personas and Teams',
  component: StorySurface,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof StorySurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {};
