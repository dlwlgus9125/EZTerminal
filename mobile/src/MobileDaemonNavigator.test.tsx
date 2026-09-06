import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../src/renderer/i18n';
import type { DaemonSnapshot } from '../../src/shared/daemon-protocol';
import {
  MobileDaemonNavigator,
  type MobileDaemonNavigatorLocation,
} from './MobileDaemonNavigator';
import type { DaemonRuntimeViewState } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T00:00:00.000Z';

function snapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision: 7,
    eventSequence: 11,
    generatedAt: NOW,
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderNavigator(
  state: DaemonRuntimeViewState,
  options: {
    readonly onRetry?: () => void;
    readonly onSelectSession?: (sessionId: string) => void;
    readonly onCreateSession?: (workspaceId: string) => void;
    readonly initialLocation?: MobileDaemonNavigatorLocation;
    readonly onLocationChange?: (location: MobileDaemonNavigatorLocation) => void;
    readonly locale?: 'en' | 'ko';
  } = {},
): void {
  act(() => root.render(
    <AppI18nProvider locale={options.locale ?? 'en'} languages={[options.locale ?? 'en']}>
      <MobileDaemonNavigator
        state={state}
        onRetry={options.onRetry ?? (() => undefined)}
        onSelectSession={options.onSelectSession ?? (() => undefined)}
        initialLocation={options.initialLocation}
        onLocationChange={options.onLocationChange}
        {...(options.onCreateSession ? { onCreateSession: options.onCreateSession } : {})}
      />
    </AppI18nProvider>,
  ));
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => (
    candidate.textContent?.includes(text)
  ));
  if (!button) throw new Error(`Missing button containing ${text}`);
  return button;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobileDaemonNavigator', () => {
  it('renders loading, empty, and retryable error states truthfully', () => {
    const retry = vi.fn();
    renderNavigator({ status: 'loading', snapshot: null }, { onRetry: retry });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading projects');

    renderNavigator({ status: 'ready', snapshot: snapshot() }, { onRetry: retry });
    expect(container.querySelector('[data-testid="mobile-daemon-empty-projects"]')?.textContent)
      .toContain('No projects yet');

    renderNavigator(
      { status: 'error', snapshot: null, error: 'connection-lost' },
      { onRetry: retry },
    );
    act(() => buttonContaining('Retry').click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows terminal-only remediation without exposing a local recovery path or retry', () => {
    const retry = vi.fn();
    renderNavigator({
      status: 'safe-mode',
      snapshot: null,
      availability: {
        state: 'legacy-only-safe-mode',
        initializationCode: 'future-schema',
        databaseDisposition: 'preserved',
        supportedSchemaVersion: 3,
        currentSchemaVersion: 4,
      },
    }, { onRetry: retry });

    expect(container.querySelector('[data-testid="daemon-safe-mode"]')?.textContent)
      .toContain('Existing terminal sessions remain available');
    expect(container.textContent).toContain('Update EZTerminal');
    expect(container.textContent).not.toContain('Local recovery location');
    expect([...container.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('Retry'))).toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });

  it('navigates Project → Workspace → Session and emits the stable session id', () => {
    const onSelectSession = vi.fn();
    const onCreateSession = vi.fn();
    const model = snapshot({
      projects: [{
        id: 'project-1',
        name: 'EZTerminal',
        rootPath: 'C:\\Working\\EZTerminal',
        source: 'native',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      workspaces: [{
        id: 'workspace-main',
        projectId: 'project-1',
        name: 'Main checkout',
        kind: 'local',
        rootPath: 'C:\\Working\\EZTerminal',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }, {
        id: 'workspace-feature',
        projectId: 'project-1',
        name: 'Agent feature',
        kind: 'worktree',
        rootPath: 'C:\\Working\\EZTerminal-worktrees\\feature',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      sessions: [{
        id: 'agent-session-1',
        projectId: 'project-1',
        workspaceId: 'workspace-main',
        kind: 'agent',
        title: 'Codex implementation',
        state: 'running',
        source: 'structured',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }, {
        id: 'terminal-session-1',
        projectId: 'project-1',
        workspaceId: 'workspace-main',
        kind: 'terminal',
        title: 'PowerShell',
        state: 'idle',
        source: 'legacy-pty',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    });

    renderNavigator({ status: 'ready', snapshot: model }, { onSelectSession, onCreateSession });
    act(() => buttonContaining('EZTerminal').click());
    expect(container.querySelector('[data-testid="mobile-daemon-revision"]')?.textContent).toContain('7');
    const workspaceRows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="mobile-daemon-workspace"]'));
    expect(workspaceRows[0]?.dataset.workspaceKind).toBe('local');
    expect(workspaceRows[1]?.dataset.workspaceKind).toBe('worktree');

    act(() => buttonContaining('Main checkout').click());
    const createSession = container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-daemon-create-session"]',
    );
    expect(createSession?.classList.contains('mob-icon-btn')).toBe(true);
    expect(createSession?.classList.contains('mob-icon-btn--accent')).toBe(true);
    expect(createSession?.getAttribute('aria-label')).toBe('New session: Main checkout');
    expect(createSession?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[aria-label="Back to workspaces"]')).not.toBeNull();
    act(() => createSession?.click());
    expect(onCreateSession).toHaveBeenCalledWith('workspace-main');

    const agent = container.querySelector<HTMLButtonElement>('[data-session-id="agent-session-1"]');
    const terminal = container.querySelector<HTMLButtonElement>('[data-session-id="terminal-session-1"]');
    expect(agent?.dataset.sessionKind).toBe('agent');
    expect(agent?.getAttribute('aria-label')).toBe('Open session: Codex implementation');
    expect(terminal?.dataset.sessionKind).toBe('terminal');
    expect(terminal?.textContent).toContain('Terminal · Available');

    act(() => agent?.click());
    expect(onSelectSession).toHaveBeenCalledWith('agent-session-1');
  });

  it('keeps archived Agents out of current sessions and opens them from concise history navigation', () => {
    const onSelectSession = vi.fn();
    const onCreateSession = vi.fn();
    const model = snapshot({
      projects: [{
        id: 'project-1', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: 'workspace-main', projectId: 'project-1', name: 'Main checkout', kind: 'local',
        rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
      sessions: [{
        id: 'active-agent', projectId: 'project-1', workspaceId: 'workspace-main', kind: 'agent',
        title: 'Current Agent', state: 'idle', source: 'structured',
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        id: 'failed-before-provider', projectId: 'project-1', workspaceId: 'workspace-main', kind: 'agent',
        title: 'Failed before provider start', state: 'failed', source: 'structured', archivedAt: NOW,
        revision: 2, createdAt: NOW, updatedAt: NOW,
      }],
      agents: [{
        sessionId: 'active-agent', providerId: 'codex', permissionPreset: 'standard', state: 'idle',
        queuedTurnCount: 0, orchestrationEnabled: true,
        revision: 1, createdAt: NOW, updatedAt: NOW,
      }, {
        sessionId: 'failed-before-provider', providerId: 'codex', permissionPreset: 'standard', state: 'archived',
        queuedTurnCount: 0, orchestrationEnabled: true,
        revision: 2, createdAt: NOW, updatedAt: NOW,
      }],
    });

    renderNavigator({ status: 'ready', snapshot: model }, { onSelectSession, onCreateSession });
    expect(container.querySelector('[data-testid="mobile-daemon-archived"]')?.textContent)
      .toContain('Archived');
    act(() => buttonContaining('EZTerminal').click());
    act(() => buttonContaining('Main checkout').click());
    expect(container.querySelector('[data-session-id="active-agent"]')).not.toBeNull();
    expect(container.querySelector('[data-session-id="failed-before-provider"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back to workspaces"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back to projects"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-daemon-archived"]')!.click());
    expect(container.querySelector('h2')?.textContent).toBe('Archived');
    act(() => buttonContaining('EZTerminal').click());
    act(() => buttonContaining('Main checkout').click());
    expect(container.querySelector('[data-testid="mobile-daemon-create-session"]')).toBeNull();

    const archived = container.querySelector<HTMLButtonElement>(
      '[data-session-id="failed-before-provider"]',
    );
    expect(archived?.dataset.archived).toBe('true');
    expect(archived?.textContent).toContain('Agent · Archived');
    expect(container.querySelector('[data-session-id="active-agent"]')).toBeNull();
    act(() => archived!.click());
    expect(onSelectSession).toHaveBeenCalledWith('failed-before-provider');
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('localizes the create action and removes it when the active workspace becomes unavailable', () => {
    const onCreateSession = vi.fn();
    const model = snapshot({
      projects: [{
        id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1,
        createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: 'workspace-main', projectId: 'project-1', name: 'Main checkout', kind: 'local',
        rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    });

    renderNavigator(
      { status: 'ready', snapshot: model },
      { onCreateSession, locale: 'ko' },
    );
    act(() => buttonContaining('EZTerminal').click());
    act(() => buttonContaining('Main checkout').click());
    expect(container.querySelector('[data-testid="mobile-daemon-create-session"]')?.getAttribute('aria-label'))
      .toBe('새 세션: Main checkout');

    renderNavigator(
      { status: 'error', snapshot: model, error: 'connection-lost' },
      { onCreateSession, locale: 'ko' },
    );
    expect(container.querySelector('[data-testid="mobile-daemon-create-session"]')).toBeNull();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('restores a saved Workspace drill-down after the navigator remounts', () => {
    const model = snapshot({
      projects: [{
        id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1,
        createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: 'workspace-main', projectId: 'project-1', name: 'Main checkout', kind: 'local',
        rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    });

    renderNavigator({ status: 'ready', snapshot: model }, {
      initialLocation: { projectId: 'project-1', workspaceId: 'workspace-main' },
      onCreateSession: vi.fn(),
    });

    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Main checkout');
    expect(container.querySelector('[data-testid="mobile-daemon-create-session"]')).not.toBeNull();
  });

  it('does not offer contextual creation from a stale recovering snapshot', () => {
    const onCreateSession = vi.fn();
    const model = snapshot({
      projects: [{
        id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1,
        createdAt: NOW, updatedAt: NOW,
      }],
      workspaces: [{
        id: 'workspace-main', projectId: 'project-1', name: 'Main checkout', kind: 'local',
        rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    });

    renderNavigator({ status: 'recovering', snapshot: model, error: 'event-gap' }, {
      onCreateSession,
      initialLocation: { projectId: 'project-1', workspaceId: 'workspace-main' },
    });

    expect(container.querySelector('[data-testid="mobile-daemon-create-session"]')).toBeNull();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('keeps a stale projection visible while reporting event-gap recovery', () => {
    renderNavigator({
      status: 'recovering',
      snapshot: snapshot({
        projects: [{
          id: 'project-1',
          name: 'Visible stale project',
          source: 'native',
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }],
      }),
      lastContinuity: 'gap',
      error: 'event-gap',
    });

    expect(container.textContent).toContain('Visible stale project');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Some updates were missed');
  });
});
