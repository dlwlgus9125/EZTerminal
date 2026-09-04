import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivitySnapshot } from '../../src/shared/agent';
import {
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import { MobileLeadWorkersStrip } from './MobileLeadWorkersStrip';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const orchestration: AgentOrchestrationSnapshot = {
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
      taskId: 'task-1', revision: 2, title: 'Worker', brief: 'Do bounded work.',
      mode: 'read-only', dependsOn: [], writeScopes: [], profileId: 'builtin:codex:read',
      state: 'blocked', createdAt: 1, updatedAt: 2,
      worker: {
        workerId: 'worker-1', taskId: 'task-1', profileId: 'builtin:codex:read',
        providerId: 'codex', sessionId: 'worker-session', activityId: 'worker-activity',
      },
    }],
  }],
};

const activities: AgentActivitySnapshot = {
  revision: 1,
  items: [{
    id: 'worker-activity', sessionId: 'worker-session', provider: 'codex', cwd: 'C:\\worker',
    state: 'blocked', status: 'blocked', stateSeq: 2, live: true, interactiveReady: true,
    stateSource: 'provider-hook', createdAt: 1, updatedAt: 2,
    approval: {
      approvalId: 'approval-1', toolName: 'shell', command: 'pnpm test', risk: 'write',
      pending: true, requestedAt: 1, expiresAt: 60_001,
    },
  }],
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

describe('MobileLeadWorkersStrip', () => {
  it('answers a hidden worker permission from the Lead sheet', async () => {
    const decideAgentApproval = vi.fn(async () => ({ ok: true as const }));
    const transport = {
      decideAgentApproval,
      archiveOrchestrationWorker: vi.fn(),
      cancelOrchestrationWorker: vi.fn(),
      stopOrchestrationRun: vi.fn(),
    } as unknown as WsEzTerminalTransport;
    act(() => root.render(
      <MobileNavigationHistoryProvider>
        <MobileLeadWorkersStrip
          snapshot={orchestration}
          activitySnapshot={activities}
          leadSessionId="lead-session"
          transport={transport}
          connected
        />
      </MobileNavigationHistoryProvider>,
    ));

    act(() => container.querySelector<HTMLButtonElement>('.mobile-lead-workers__summary')!.click());
    expect(container.querySelector('[data-testid="mobile-lead-worker-approval"]')?.textContent).toContain('pnpm test');
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.mobile-lead-worker-row__approval button'));
    await act(async () => buttons[0]!.click());
    expect(decideAgentApproval).toHaveBeenCalledWith('worker-activity', 'approval-1', 'allow');
  });
});
