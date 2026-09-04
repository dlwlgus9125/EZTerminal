import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentCoordinationSnapshot,
  AgentProjectCoordinationInput,
} from '../../src/shared/agent-coordination';
import type { AgentProjectSummary } from '../../src/shared/agent-history';
import {
  DEFAULT_COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_MERGE_POLICY,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import { MobileCollaborationPolicySheet } from './MobileCollaborationPolicySheet';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: AgentProjectSummary = {
  projectId: 'project-1',
  name: 'EZTerminal',
  primaryRoot: 'C:\\Working\\EZTerminal',
  additionalRoots: [],
  pinned: true,
  saved: true,
  sessionCount: 1,
  providers: ['codex'],
  lastActiveAt: 10,
};

const validation = {
  id: 'unit',
  name: 'Unit tests',
  command: 'pnpm test:unit',
  timeoutMs: 300_000,
};

const coordinationSnapshot: AgentCoordinationSnapshot = {
  revision: 2,
  activityRevision: 0,
  activities: [],
  projects: [{
    projectId: project.projectId,
    goal: 'Ship reliable collaboration',
    defaultTargetBranch: 'main',
    validationCommands: [validation],
    configRevision: 2,
    counts: {
      starting: 0,
      working: 0,
      blocked: 0,
      done: 0,
      idle: 0,
      error: 0,
      unknown: 0,
    },
    participants: [],
    pendingMergeCount: 0,
  }],
  mergeRequests: [],
};

const orchestrationSnapshot: AgentOrchestrationSnapshot = {
  revision: 3,
  providers: [{ providerId: 'builtin:codex', kind: 'builtin', displayName: 'Codex' }],
  profiles: [{
    profileId: 'builtin:codex:read',
    providerId: 'builtin:codex',
    launcherId: 'codex',
    name: 'Codex reader',
    description: 'Read-only worker',
    permissionMode: 'read-only',
    capabilities: ['worker', 'read'],
    available: true,
    revision: 1,
  }],
  policies: [{
    schemaVersion: 1,
    projectId: project.projectId,
    enabled: true,
    permissionMode: 'ask',
    allowedWorkerProfileIds: ['builtin:codex:read'],
    limits: DEFAULT_COLLABORATION_LIMITS,
    mergePolicy: {
      ...DEFAULT_COLLABORATION_MERGE_POLICY,
      targetBranches: ['main'],
      allowPaths: ['src/'],
      requiredValidationIds: ['unit'],
    },
    revision: 3,
    updatedAt: 10,
  }],
  runs: [],
  events: [],
  migration: { required: false, catalogItemCount: 0, runCount: 0 },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobileCollaborationPolicySheet', () => {
  it('directs unavailable built-in profiles to desktop integration settings', () => {
    const transport = {
      saveAgentCoordinationProject: vi.fn(),
      saveCollaborationPolicy: vi.fn(),
      confirmLegacyTeamMigration: vi.fn(),
    } as unknown as WsEzTerminalTransport;

    act(() => root.render(
      <MobileNavigationHistoryProvider>
        <MobileCollaborationPolicySheet
          project={project}
          coordinationSnapshot={coordinationSnapshot}
          snapshot={{
            ...orchestrationSnapshot,
            profiles: orchestrationSnapshot.profiles.map((profile) => ({ ...profile, available: false })),
          }}
          transport={transport}
          onClose={vi.fn()}
        />
      </MobileNavigationHistoryProvider>,
    ));

    expect(container.querySelector('.mobile-collaboration-policy__integration-hint')).not.toBeNull();
  });

  it('saves coordination before policy with the revisions captured when the sheet opened', async () => {
    const calls: string[] = [];
    const saveAgentCoordinationProject = vi.fn(async (input: AgentProjectCoordinationInput) => {
      calls.push('coordination');
      return {
        ok: true as const,
        value: {
          projectId: input.projectId,
          goal: input.goal,
          defaultTargetBranch: input.defaultTargetBranch,
          validationCommands: input.validationCommands,
          configRevision: 3,
          participants: [],
          updatedAt: 20,
        },
      };
    });
    const saveCollaborationPolicy = vi.fn(async () => {
      calls.push('policy');
      return { ok: true as const, value: orchestrationSnapshot.policies[0]! };
    });
    const onClose = vi.fn();
    const transport = {
      saveAgentCoordinationProject,
      saveCollaborationPolicy,
      confirmLegacyTeamMigration: vi.fn(),
    } as unknown as WsEzTerminalTransport;

    act(() => root.render(
      <MobileNavigationHistoryProvider>
        <MobileCollaborationPolicySheet
          project={project}
          coordinationSnapshot={coordinationSnapshot}
          snapshot={orchestrationSnapshot}
          transport={transport}
          onClose={onClose}
        />
      </MobileNavigationHistoryProvider>,
    ));

    expect((container.querySelector('[data-testid="mobile-collaboration-goal"]') as HTMLTextAreaElement).value)
      .toBe('Ship reliable collaboration');
    act(() => root.render(
      <MobileNavigationHistoryProvider>
        <MobileCollaborationPolicySheet
          project={project}
          coordinationSnapshot={{
            ...coordinationSnapshot,
            revision: 8,
            projects: [{ ...coordinationSnapshot.projects[0]!, configRevision: 8 }],
          }}
          snapshot={{
            ...orchestrationSnapshot,
            revision: 9,
            policies: [{ ...orchestrationSnapshot.policies[0]!, revision: 9 }],
          }}
          transport={transport}
          onClose={onClose}
        />
      </MobileNavigationHistoryProvider>,
    ));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-collaboration-save"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toEqual(['coordination', 'policy']);
    expect(saveAgentCoordinationProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      goal: 'Ship reliable collaboration',
      defaultTargetBranch: 'main',
      expectedRevision: 2,
      validationCommands: [validation],
    }));
    expect(saveCollaborationPolicy).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      expectedRevision: 3,
      mergePolicy: expect.objectContaining({
        targetBranches: ['main'],
        requiredValidationIds: ['unit'],
      }),
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
