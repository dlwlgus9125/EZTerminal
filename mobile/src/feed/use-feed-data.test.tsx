// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivity } from '../../../src/shared/agent';
import type { DaemonSnapshot } from '../../../src/shared/daemon-protocol';
import type { WorkflowSnapshot } from '../../../src/shared/workflow';
import { shellSnapshot, shellWorkflow } from '../../../src/renderer/shell/shell-fixtures';
import { FEED_FLOW_READ_MS, useFeedData, type FeedData } from './use-feed-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: FeedData;

type Props = Parameters<typeof useFeedData>[0];

function Probe(props: Props): null {
  latest = useFeedData(props);
  return null;
}

function transport(version = 17) {
  return {
    negotiatedRemoteProtocolVersion: version,
    getWorkflowSnapshot: vi.fn<(projectId: string) => Promise<{ ok: true; snapshot: WorkflowSnapshot }>>(async () => ({ ok: true as const, snapshot: shellWorkflow() as WorkflowSnapshot })),
  };
}

function render(props: Props): void {
  act(() => root.render(<Probe {...props} />));
}

const daemon: DaemonSnapshot = shellSnapshot();
const base = (overrides: Partial<Props> = {}): Props => ({
  transport: transport(), daemon, liveDaemon: daemon, terminalAgents: [], connected: true, active: true, authority: 'pc-a', ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('useFeedData', () => {
  it('remembers the chosen project per PC and falls back to every project when it is gone', () => {
    render(base({ active: false }));
    expect(latest.scope).toBeNull();
    act(() => latest.setScope('p-ez'));
    expect(latest.scope).toBe('p-ez');
    render(base({ active: false, authority: 'pc-b' }));
    expect(latest.scope).toBeNull();
    render(base({ active: false, authority: 'pc-a' }));
    expect(latest.scope).toBe('p-ez');
    const archived = { ...daemon, projects: daemon.projects.map((project) => project.id === 'p-ez' ? { ...project, archivedAt: daemon.generatedAt } : project) };
    render(base({ active: false, daemon: archived }));
    expect(latest.scope).toBeNull();
  });

  it('reads flows only while the feed is on screen and the PC reports them, then again on its cadence', async () => {
    vi.useFakeTimers();
    const pc = transport();
    localStorage.setItem('ezterminal-feed-scope-v1:pc-a', JSON.stringify({ scope: 'p-ez' }));
    render(base({ transport: pc, active: false }));
    expect(pc.getWorkflowSnapshot).not.toHaveBeenCalled();
    render(base({ transport: pc, active: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pc.getWorkflowSnapshot.mock.calls.map((call) => call[0])).toEqual(['p-ez']);
    expect(latest.flows.length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_FLOW_READ_MS.one); });
    expect(pc.getWorkflowSnapshot).toHaveBeenCalledTimes(2);
    render(base({ transport: pc, active: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_FLOW_READ_MS.all * 2); });
    expect(pc.getWorkflowSnapshot).toHaveBeenCalledTimes(2);
    const old = transport(13);
    render(base({ transport: old, active: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_FLOW_READ_MS.all); });
    expect(old.getWorkflowSnapshot).not.toHaveBeenCalled();
    expect(latest.flowsAvailable).toBe(false);
  });

  it('reads at most six projects for every project, and keeps the last flows when a read fails', async () => {
    vi.useFakeTimers();
    const many = { ...daemon, projects: Array.from({ length: 9 }, (_, index) => ({ ...daemon.projects[0]!, id: `p-${index}`, name: `P${index}` })) };
    const pc = transport();
    render(base({ transport: pc, daemon: many, liveDaemon: many }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pc.getWorkflowSnapshot).toHaveBeenCalledTimes(6);
    const flows = latest.flows.length;
    pc.getWorkflowSnapshot.mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_FLOW_READ_MS.all); });
    expect(latest.flows.length).toBe(flows);
  });
  it('offers nothing to answer while disconnected, a blocked terminal agent included', () => {
    const blocked = {
      id: 'activity-1', sessionId: 'pty-1', provider: 'claude', providerLabel: 'Claude', cwd: 'C:/Working', state: 'blocked', status: 'blocked',
      stateSeq: 3, live: true, interactiveReady: true, stateSource: 'hook', createdAt: 1, updatedAt: 2,
      approval: { approvalId: 'gate-1', toolName: 'Bash', command: 'rm -rf dist', risk: 'danger', pending: true, requestedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER },
    } as unknown as AgentActivity;
    render(base({ active: false, liveDaemon: null, terminalAgents: [blocked], connected: true }));
    expect(latest.waiting.map((item) => item.kind)).toEqual(['terminal-agent']);
    render(base({ active: false, liveDaemon: null, terminalAgents: [blocked], connected: false }));
    expect(latest.waiting).toEqual([]);
  });
});
