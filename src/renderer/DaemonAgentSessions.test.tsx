// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonEvent,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import {
  DaemonAgentSessions,
  type DaemonAgentSessionListAccess,
  projectDaemonAgentSessions,
} from './DaemonAgentSessions';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T10:30:00.000Z';

function snapshotOf(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    revision: 3,
    eventSequence: 5,
    generatedAt: NOW,
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [{
      id: 'project', name: 'Product', rootPath: 'C:\\Product', source: 'native',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    workspaces: [{
      id: 'workspace', projectId: 'project', name: 'main', kind: 'local', rootPath: 'C:\\Product',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    sessions: [{
      id: 'lead', projectId: 'project', workspaceId: 'workspace', kind: 'agent',
      title: 'Lead session', state: 'running', source: 'structured',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'managed-child', projectId: 'project', workspaceId: 'workspace', kind: 'agent',
      title: 'Managed child', state: 'idle', source: 'structured',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'native-child', projectId: 'project', workspaceId: 'workspace', kind: 'agent',
      title: 'Native child', state: 'running', source: 'structured',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'legacy', projectId: 'project', workspaceId: 'workspace', kind: 'agent',
      title: 'Legacy import', state: 'idle', source: 'legacy-import',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    agents: [{
      sessionId: 'lead', providerId: 'codex', model: 'gpt-test', permissionPreset: 'standard',
      state: 'working', queuedTurnCount: 0, orchestrationEnabled: true,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      sessionId: 'managed-child', providerId: 'claude', permissionPreset: 'plan',
      state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      sessionId: 'native-child', providerId: 'claude', permissionPreset: 'plan',
      state: 'working', queuedTurnCount: 0, orchestrationEnabled: false,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      sessionId: 'legacy', providerId: 'codex', permissionPreset: 'standard',
      state: 'idle', queuedTurnCount: 0, orchestrationEnabled: false,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [{
      id: 'relation-managed', treeId: 'tree', parentSessionId: 'lead', childSessionId: 'managed-child',
      owner: 'managed', depth: 1, revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'relation-native', treeId: 'tree', parentSessionId: 'lead', childSessionId: 'native-child',
      owner: 'provider-native', depth: 1, revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [{
      id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex',
      executableVersion: '1', argv: ['app-server'], environmentVariableNames: [], capabilities: [],
      enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'claude', displayName: 'Claude Code', protocol: 'claude-agent-sdk', executablePath: 'claude',
      executableVersion: '1', argv: ['-p'], environmentVariableNames: [], capabilities: [],
      enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
}

function daemonEvent(sequence: number, revision: number): DaemonEvent {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    revision,
    occurredAt: NOW,
    kind: 'entity.upserted',
    payload: { entityType: 'session', entityId: 'lead' },
  };
}

function transcriptEvent(sequence: number, revision: number): DaemonEvent {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    eventId: `transcript-${sequence}`,
    sequence,
    revision,
    occurredAt: NOW,
    kind: 'transcript.appended',
    payload: { sessionId: 'lead', fromSequence: 1, toSequence: sequence },
  };
}

function turnEvent(sequence: number, revision: number): DaemonEvent {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    eventId: `turn-${sequence}`,
    sequence,
    revision,
    occurredAt: NOW,
    kind: 'entity.upserted',
    payload: { entityType: 'turn', entityId: 'turn-1' },
  };
}

function commandEvent(sequence: number, revision: number): DaemonEvent {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    eventId: `command-${sequence}`,
    sequence,
    revision,
    occurredAt: NOW,
    kind: 'command.changed',
    payload: { commandId: 'command-1', state: 'applied' },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

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
  vi.restoreAllMocks();
});

async function renderSessions(
  access: DaemonAgentSessionListAccess,
  onOpenSession = vi.fn(),
): Promise<typeof onOpenSession> {
  act(() => {
    root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <DaemonAgentSessions access={access} onOpenSession={onOpenSession} />
      </AppI18nProvider>,
    );
  });
  await flush();
  return onOpenSession;
}

describe('projectDaemonAgentSessions', () => {
  it('keeps attached children under their parent and omits legacy sessions', () => {
    const groups = projectDaemonAgentSessions(snapshotOf());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Product');
    expect(groups[0]?.workspaces[0]?.label).toBe('main');
    expect(groups[0]?.workspaces[0]?.sessions.map((node) => node.session.id)).toEqual(['lead']);
    expect(groups[0]?.workspaces[0]?.sessions[0]?.children.map((node) => ({
      id: node.session.id,
      owner: node.relation?.owner,
    }))).toEqual([
      { id: 'native-child', owner: 'provider-native' },
      { id: 'managed-child', owner: 'managed' },
    ]);
  });

  it('keeps a cross-workspace managed child in its owning Workspace with parent provenance', () => {
    const base = snapshotOf();
    const otherWorkspace: DaemonSnapshot['workspaces'][number] = {
      id: 'workspace-review',
      projectId: 'project',
      name: 'review-worktree',
      kind: 'worktree',
      rootPath: 'C:\\Product-review',
      sourceWorkspaceId: 'workspace',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const groups = projectDaemonAgentSessions(snapshotOf({
      workspaces: [...base.workspaces, otherWorkspace],
      sessions: base.sessions.map((session) => session.id === 'managed-child'
        ? { ...session, workspaceId: otherWorkspace.id }
        : session),
    }));

    const main = groups[0]?.workspaces.find((workspace) => workspace.id === 'workspace');
    const review = groups[0]?.workspaces.find((workspace) => workspace.id === otherWorkspace.id);
    expect(main?.sessions[0]?.children.map((node) => node.session.id)).toEqual(['native-child']);
    expect(review?.sessions.map((node) => node.session.id)).toEqual(['managed-child']);
    expect(review?.sessions[0]?.relation?.owner).toBe('managed');
    expect(review?.sessions[0]?.parentTitle).toBe('Lead session');
  });

  it('promotes a detached managed child but never duplicates an attached provider child at the top level', () => {
    const base = snapshotOf();
    const groups = projectDaemonAgentSessions(snapshotOf({
      agentRelations: base.agentRelations.map((relation) => relation.id === 'relation-managed'
        ? { ...relation, detachedAt: NOW }
        : relation),
    }));
    const roots = groups[0]?.workspaces[0]?.sessions ?? [];
    expect(roots.map((node) => node.session.id)).toEqual(['lead', 'managed-child']);
    expect(roots.flatMap((node) => node.children).map((node) => node.session.id))
      .toEqual(['native-child']);
    expect(roots.some((node) => node.session.id === 'native-child')).toBe(false);
  });
});

describe('DaemonAgentSessions', () => {
  it('opens a persisted child through the normal structured session callback', async () => {
    const stop = vi.fn();
    const onOpenSession = await renderSessions({
      getSnapshot: vi.fn(async () => snapshotOf()),
      observeEvents: vi.fn(() => stop),
    });

    const native = container.querySelector<HTMLButtonElement>(
      '[data-session-id="native-child"]',
    );
    expect(native).not.toBeNull();
    expect(native?.closest('.daemon-agent-session-children')).not.toBeNull();
    expect(container.querySelectorAll('[data-session-id="native-child"]')).toHaveLength(1);
    expect(native?.textContent).toContain('Claude Code');
    expect(native?.textContent).toContain('Provider-owned child of Lead session');
    expect(native?.textContent).toContain('Read only');

    act(() => native!.click());
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: 'native-child',
      title: 'Native child',
      providerLabel: 'Claude Code',
    });

    act(() => root.unmount());
    expect(stop).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('consumes contiguous transcript, turn, and command events without refreshing the projection', async () => {
    let listener: ((event: DaemonEvent) => void) | undefined;
    let resolveRelevant: ((value: DaemonSnapshot) => void) | undefined;
    const relevantSnapshot = new Promise<DaemonSnapshot>((resolve) => { resolveRelevant = resolve; });
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshotOf())
      .mockImplementationOnce(() => relevantSnapshot);
    await renderSessions({
      getSnapshot,
      observeEvents: (next) => {
        listener = next;
        return () => undefined;
      },
    });

    act(() => {
      listener?.(transcriptEvent(6, 3));
      listener?.(turnEvent(7, 4));
      listener?.(commandEvent(8, 4));
    });
    await flush();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    act(() => listener?.(daemonEvent(9, 5)));
    await flush();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Restoring the live Agent session list');

    await act(async () => resolveRelevant?.(snapshotOf({ revision: 5, eventSequence: 9 })));
    await flush();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing projection while an event gap is recovered authoritatively', async () => {
    let listener: ((event: DaemonEvent) => void) | undefined;
    let resolveRecovery: ((value: DaemonSnapshot) => void) | undefined;
    const recovery = new Promise<DaemonSnapshot>((resolve) => { resolveRecovery = resolve; });
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshotOf())
      .mockImplementationOnce(() => recovery);
    await renderSessions({
      getSnapshot,
      observeEvents: (next) => {
        listener = next;
        return () => undefined;
      },
    });

    act(() => listener?.(daemonEvent(7, 4)));
    expect(container.textContent).toContain('Restoring the live Agent session list');
    expect(container.querySelector('[data-session-id="lead"]')).not.toBeNull();

    await act(async () => resolveRecovery?.(snapshotOf({ revision: 4, eventSequence: 7 })));
    await flush();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Restoring the live Agent session list');

    act(() => listener?.(daemonEvent(7, 4)));
    await flush();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('shows a recoverable error and an honest empty state after retry', async () => {
    const empty = snapshotOf({ sessions: [], agents: [], agentRelations: [] });
    const getSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(empty);
    await renderSessions({
      getSnapshot,
      observeEvents: () => () => undefined,
    });

    expect(container.textContent).toContain('Could not load structured Agent sessions');
    const retry = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Retry'));
    expect(retry).toBeDefined();
    act(() => retry!.click());
    await flush();

    expect(container.textContent).toContain('No saved structured Agent sessions yet');
    expect(container.getAttribute('aria-busy')).not.toBe('true');
  });
});
