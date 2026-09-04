// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentApproval } from '../shared/agent';
import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  type AgentOrchestrationSnapshot,
} from '../shared/agent-orchestration';
import { LeadWorkersStrip } from './LeadWorkersStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: AgentOrchestrationSnapshot = {
  revision: 1,
  providers: [],
  profiles: [],
  policies: [],
  events: [],
  migration: { required: false, catalogItemCount: 0, runCount: 0 },
  runs: [{
    schemaVersion: AGENT_ORCHESTRATION_SCHEMA_VERSION,
    runId: 'run-1', revision: 1, projectId: 'project-1',
    leadSessionId: 'lead-session', leadActivityId: 'lead-activity', policyRevision: 1,
    state: 'needs-attention', createdAt: 1, updatedAt: 2, expiresAt: 60_001,
    tasks: [{
      taskId: 'task-1', revision: 2, title: 'Scoped writer', brief: 'Edit only src/.',
      mode: 'write', dependsOn: [], writeScopes: ['src/'], profileId: 'builtin:codex:write',
      state: 'blocked', createdAt: 1, updatedAt: 2,
      worker: {
        workerId: 'worker-1', taskId: 'task-1', profileId: 'builtin:codex:write',
        providerId: 'codex', sessionId: 'worker-session', activityId: 'worker-activity',
      },
    }],
  }],
};

const approval: AgentApproval = {
  approvalId: 'approval-1',
  toolName: 'shell',
  command: 'pnpm test',
  risk: 'write',
  pending: true,
  requestedAt: 1,
  expiresAt: 60_001,
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

describe('LeadWorkersStrip', () => {
  it('keeps a worker permission actionable from the Lead strip without a composer', async () => {
    const onDecideApproval = vi.fn(async () => ({ ok: true as const }));
    act(() => root.render(
      <LeadWorkersStrip
        snapshot={snapshot}
        leadSessionId="lead-session"
        approvalsByActivity={new Map([['worker-activity', approval]])}
        onDecideApproval={onDecideApproval}
      />,
    ));

    act(() => container.querySelector<HTMLButtonElement>('.lead-workers__toggle')!.click());
    expect(container.querySelector('[data-testid="lead-worker-approval"]')?.textContent).toContain('pnpm test');
    expect(container.querySelector('[data-testid="agent-followup-input"]')).toBeNull();

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.lead-workers__approval button'));
    await act(async () => buttons[0]!.click());
    expect(onDecideApproval).toHaveBeenCalledWith('worker-activity', 'approval-1', 'allow');
  });
});
