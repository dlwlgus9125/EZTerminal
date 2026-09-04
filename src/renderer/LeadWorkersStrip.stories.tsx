import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AgentOrchestrationSnapshot } from '../shared/agent-orchestration';
import { AppI18nProvider } from './i18n';
import { LeadWorkersStrip } from './LeadWorkersStrip';
import './index.css';

const now = Date.now();
const snapshot: AgentOrchestrationSnapshot = {
  revision: 8,
  providers: [{ providerId: 'codex', kind: 'builtin', displayName: 'Codex' }],
  profiles: [{
    profileId: 'builtin:codex:write', providerId: 'codex', launcherId: 'codex',
    name: 'Codex · Workspace writer', description: 'Managed writer', permissionMode: 'workspace-write',
    capabilities: ['worker', 'read', 'write', 'parent-events'], available: true, revision: 1,
  }],
  policies: [],
  events: [],
  migration: { required: false, catalogItemCount: 0, runCount: 0 },
  runs: [{
    schemaVersion: 1, runId: 'run-story', revision: 4, projectId: 'project-story',
    leadSessionId: 'lead-story', leadActivityId: 'activity-story', policyRevision: 1,
    state: 'active', createdAt: now - 20_000, updatedAt: now, expiresAt: now + 3_600_000,
    tasks: [{
      taskId: 'task-story', revision: 2, title: 'Implement settings', brief: 'Build the settings surface.',
      mode: 'write', dependsOn: [], writeScopes: ['src/renderer/'], profileId: 'builtin:codex:write',
      state: 'working', createdAt: now - 20_000, updatedAt: now,
      worker: {
        workerId: 'worker-story', taskId: 'task-story', profileId: 'builtin:codex:write',
        providerId: 'codex', sessionId: 'worker-session', activityId: 'worker-activity', startedAt: now - 19_000,
      },
    }],
  }],
};

function StorySurface(): JSX.Element {
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <div style={{ width: 760, padding: 16, background: 'var(--ui-surface-base)' }}>
        <LeadWorkersStrip snapshot={snapshot} leadSessionId="lead-story" />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Agents/Lead worker strip',
  component: StorySurface,
} satisfies Meta<typeof StorySurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};
