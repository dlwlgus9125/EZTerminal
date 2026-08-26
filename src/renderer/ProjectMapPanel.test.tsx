// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationSnapshot,
} from '../shared/agent-coordination';
import type { AgentProjectLauncherSummary } from '../shared/agent-history';
import type {
  ProjectMapCollectionDescriptor,
  ProjectMapDocument,
  ProjectMapEvidence,
  ProjectMapJob,
  ProjectMapSnapshot,
  ProjectMapSpec,
  ProjectMapType,
} from '../shared/project-map';
import { layoutProjectMap } from '../shared/project-map-layout';
import { AppI18nProvider } from './i18n';
import { ProjectMapPanel, type ProjectMapEvidenceTarget } from './ProjectMapPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const evidence: ProjectMapEvidence[] = [{
  rootAlias: 'app',
  relativePath: 'src/main/main.ts',
  startLine: 4,
  endLine: 8,
  lineDigest: `sha256:${'a'.repeat(64)}`,
  claim: 'Main owns the runtime authority.',
}];

const spec: ProjectMapSpec = {
  schemaVersion: 2,
  id: 'runtime',
  type: 'architecture',
  title: 'Runtime architecture',
  summary: 'Renderer requests cross one trusted main boundary.',
  contentLocale: 'en',
  layoutIntent: { density: 'balanced', emphasisIds: ['renderer', 'main'] },
  chapters: [{
    id: 'request-path',
    title: 'Request path',
    summary: 'Follow one request.',
    focusIds: ['renderer', 'main'],
  }],
  groups: [{ id: 'desktop', label: 'Desktop' }],
  nodes: [
    { id: 'renderer', label: 'Renderer', kind: 'surface', group: 'desktop', rank: 0, order: 0, evidence },
    { id: 'main', label: 'Main process', kind: 'service', group: 'desktop', rank: 1, order: 0, evidence },
  ],
  relations: [{
    id: 'renderer-to-main',
    from: 'renderer',
    to: 'main',
    label: 'typed IPC',
    kind: 'primary',
    evidence,
  }],
  mainPath: ['renderer', 'main'],
};

const mapDocument: ProjectMapDocument = {
  collectionId: 'ezterminal',
  mapId: spec.id,
  mapPath: '.ezterminal/project-map/maps/runtime.architecture.json',
  state: 'valid',
  spec,
  layout: layoutProjectMap(spec).layout,
  provenance: {
    kind: 'commit-pinned',
    roots: [{ rootAlias: 'app', head: 'b'.repeat(40), dirty: false }],
  },
  verification: {
    quality: 'production',
    fingerprint: `sha256:${'f'.repeat(64)}`,
    verifiedAt: '2026-08-19T00:00:00.000Z',
    manifestHash: `sha256:${'1'.repeat(64)}`,
    specHash: `sha256:${'2'.repeat(64)}`,
    inputHash: `sha256:${'3'.repeat(64)}`,
    layoutHash: `sha256:${'4'.repeat(64)}`,
    checks: [
      { name: 'schema', status: 'passed' },
      { name: 'semantics', status: 'passed' },
      { name: 'evidence', status: 'passed' },
      { name: 'inputs', status: 'passed' },
      { name: 'layout', status: 'passed' },
      { name: 'routes', status: 'passed' },
      { name: 'labels', status: 'passed' },
      { name: 'containment', status: 'passed' },
      { name: 'accessibility', status: 'passed' },
      { name: 'provenance', status: 'passed' },
    ],
    diagnostics: [],
  },
  fromLastGood: false,
};

function collection(state: ProjectMapCollectionDescriptor['state'] = 'valid'): ProjectMapCollectionDescriptor {
  return {
    projectId: 'project-1',
    collectionId: 'ezterminal',
    state,
    overviewMapId: 'runtime',
    ownerRootAlias: 'app',
    roots: [{ alias: 'app', label: 'Application' }],
    bindings: state === 'binding-required'
      ? []
      : [{ rootAlias: 'app', rootId: 'root-1', workspaceId: 'workspace-1' }],
    maps: [{ id: 'runtime', type: 'architecture', title: 'Runtime architecture' }],
    diagnostics: [],
  };
}

function panelProps(): IDockviewPanelProps {
  return {
    api: {
      id: 'project-map-panel',
      onDidParametersChange: vi.fn(() => ({ dispose: vi.fn() })),
      updateParameters: vi.fn(),
    },
    params: {
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      mapId: 'runtime',
    },
  } as unknown as IDockviewPanelProps;
}

let container: HTMLDivElement;
let root: Root;
let originalBase: PropertyDescriptor | undefined;
let originalDesktop: PropertyDescriptor | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installApis(options: {
  readonly descriptor?: ProjectMapCollectionDescriptor;
  readonly projectMapSnapshot?: ProjectMapSnapshot;
  readonly snapshot?: AgentCoordinationSnapshot;
  readonly launchers?: readonly AgentProjectLauncherSummary[];
}) {
  const sendAgentPrompt = vi.fn(async () => ({ ok: true as const }));
  const listAgentProjectLaunchers = vi.fn(async () => options.launchers ?? ([{
    launcherId: 'codex',
    provider: 'codex' as const,
    name: 'Codex',
    supportsAdditionalRoots: true,
  }]));
  const prepareAgentLaunch = vi.fn(async () => ({
    ok: true as const,
    target: {
      kind: 'project' as const,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    },
    launcherId: 'codex',
    provider: 'codex' as const,
    name: 'Codex',
    cwd: 'C:\\Project',
    roots: ['C:\\Project'],
    ignoredAdditionalRootCount: 0,
    revision: 'launch-revision-1',
  }));
  const setProjectMapBindings = vi.fn(async () => ({ ok: true as const, collection: collection() }));
  const describeProjectMapCollection = vi.fn(async () => ({
    ok: true as const,
    collection: options.descriptor ?? collection(),
  }));
  const descriptor = options.descriptor ?? collection();
  const snapshot = options.projectMapSnapshot ?? {
    collection: descriptor,
    ...(descriptor.state === 'valid' ? {
      map: mapDocument,
      candidate: mapDocument,
      displaySource: 'approved' as const,
      approval: {
        mapId: mapDocument.mapId,
        fingerprint: mapDocument.verification.fingerprint,
        approvedAt: '2026-08-20T00:00:00.000Z',
      },
    } : {}),
    freshness: descriptor.state === 'empty' ? 'empty' as const : 'verified' as const,
    verificationPending: false,
  };
  const openProjectMap = vi.fn(async () => ({ ok: true as const, snapshot }));
  const startProjectMapJob = vi.fn(async (request: { readonly mapId?: string; readonly type: ProjectMapType; readonly intent: 'create' | 'update'; readonly activityId: string }) => ({
    ok: true as const,
    job: {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      ...(request.mapId ? { mapId: request.mapId } : {}),
      type: request.type,
      intent: request.intent,
      activityId: request.activityId,
      phase: 'queued' as const,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
  }));
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: {
      ...(window.ezterminal ?? {}),
      getAgentCoordinationSnapshot: async () => options.snapshot ?? EMPTY_AGENT_COORDINATION_SNAPSHOT,
      onAgentCoordinationSnapshot: () => () => undefined,
      sendAgentPrompt,
      listAgentProjectLaunchers,
      prepareAgentLaunch,
    },
  });
  Object.defineProperty(window, 'ezterminalDesktop', {
    configurable: true,
    value: {
      describeProjectMapCollection,
      readProjectMap: async () => ({ ok: true as const, map: mapDocument }),
      refreshProjectMap: async () => ({ ok: true as const, map: mapDocument }),
      openProjectMap,
      refreshProjectMapSnapshot: openProjectMap,
      approveProjectMap: openProjectMap,
      startProjectMapJob,
      cancelProjectMapJob: async () => ({ ok: false as const, error: 'not-found' }),
      selectProjectMapExportDirectory: async () => ({ ok: false as const, error: 'canceled' }),
      exportProjectMap: async () => ({ ok: false, error: 'not-exported' }),
      setProjectMapBindings,
      onProjectMapChanged: () => () => undefined,
      describeProjectWorkspace: async () => ({
        ok: true as const,
        project: {
          projectId: 'project-1',
          name: 'Project',
          roots: [{ rootId: 'root-1', name: 'Project', displayPath: 'C:\\Project', primary: true }],
          workspaces: [{
            rootId: 'root-1',
            workspaceId: 'workspace-1',
            name: 'Project main',
            displayPath: 'C:\\Project',
            kind: 'main' as const,
            access: 'granted' as const,
          }],
        },
      }),
    } as unknown as typeof window.ezterminalDesktop,
  });
  return {
    describeProjectMapCollection,
    openProjectMap,
    sendAgentPrompt,
    setProjectMapBindings,
    startProjectMapJob,
    listAgentProjectLaunchers,
    prepareAgentLaunch,
  };
}

async function render(
  onOpenEvidence?: (target: ProjectMapEvidenceTarget) => void,
  onLaunchAgent?: (bootstrap: unknown, projectSession?: unknown) => void,
): Promise<void> {
  await act(async () => {
    root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <ProjectMapPanel
          {...panelProps()}
          onOpenEvidence={onOpenEvidence}
          {...(onLaunchAgent ? { onLaunchAgent } : {})}
        />
      </AppI18nProvider>,
    );
  });
  await flush();
  await flush();
}

beforeEach(() => {
  originalBase = Object.getOwnPropertyDescriptor(window, 'ezterminal');
  originalDesktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalBase) Object.defineProperty(window, 'ezterminal', originalBase);
  if (originalDesktop) Object.defineProperty(window, 'ezterminalDesktop', originalDesktop);
  else Reflect.deleteProperty(window, 'ezterminalDesktop');
  vi.restoreAllMocks();
});

describe('ProjectMapPanel', () => {
  it('starts an empty collection through an explicit, editable Agent creation brief', async () => {
    const participant = {
      participantId: 'participant-1',
      projectId: 'project-1',
      activityId: 'activity-1',
      sessionId: 'session-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
      alias: 'Builder',
      role: 'implementation',
      task: 'Create project maps',
      provider: 'codex' as const,
      joined: true,
      joinedAt: 1,
      updatedAt: 2,
    };
    const snapshot: AgentCoordinationSnapshot = {
      revision: 1,
      activityRevision: 1,
      activities: [],
      projects: [{
        projectId: 'project-1',
        goal: 'Document the system',
        defaultTargetBranch: 'main',
        validationCommands: [],
        configRevision: 1,
        counts: { starting: 0, working: 1, blocked: 0, done: 0, idle: 0, error: 0, unknown: 0 },
        participants: [participant],
        pendingMergeCount: 0,
      }],
      mergeRequests: [],
    };
    const emptyCollection: ProjectMapCollectionDescriptor = {
      projectId: 'project-1',
      collectionId: 'ezterminal',
      state: 'empty',
      roots: [],
      bindings: [],
      maps: [],
      diagnostics: [],
    };
    const api = installApis({ descriptor: emptyCollection, snapshot });
    const onLaunchAgent = vi.fn(() => true);
    await render(undefined, onLaunchAgent);

    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
    const create = container.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]');
    expect(create?.textContent).toContain('Create Project Map');
    await act(async () => { create?.click(); });

    const type = container.querySelector<HTMLSelectElement>('[data-testid="project-map-create-type"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(type, 'workflow');
      type.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('.project-map__creator textarea')!;
    expect(textarea.value).toContain('ezterminal-agent map guide workflow');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Create a verified workflow map for this repository.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = container.querySelector<HTMLButtonElement>('[data-testid="project-map-send-creation"]');
    expect(send?.disabled).toBe(false);
    await act(async () => { send?.click(); });
    await flush();

    expect(api.prepareAgentLaunch).toHaveBeenCalledWith(
      {
        kind: 'project',
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      },
      'codex',
    );
    expect(onLaunchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'new-chat',
        launcherId: 'codex',
        projectMapRequest: expect.objectContaining({
          type: 'workflow',
          intent: 'create',
          brief: 'Create a verified workflow map for this repository.',
        }),
      }),
      expect.objectContaining({
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      }),
    );
    expect(api.startProjectMapJob).not.toHaveBeenCalled();
    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Opened a dedicated Codex session');
  });

  it('keeps a tracked request visible after its dedicated Agent session starts', async () => {
    const descriptor: ProjectMapCollectionDescriptor = {
      projectId: 'project-1',
      collectionId: 'ezterminal',
      state: 'empty',
      roots: [],
      bindings: [],
      maps: [],
      diagnostics: [],
    };
    const activeJob: ProjectMapJob = {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      type: 'architecture',
      intent: 'create',
      activityId: 'activity-new-session',
      dispatch: 'dedicated-session',
      agentLabel: 'Codex',
      phase: 'queued',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    installApis({
      descriptor,
      projectMapSnapshot: {
        collection: descriptor,
        freshness: 'empty',
        verificationPending: false,
        activeJob,
      },
    });
    await render();

    const status = container.querySelector<HTMLElement>('[data-testid="project-map-delivery-status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('Codex session started');
    expect(status?.textContent).toContain('Request saved');
    expect(status?.textContent).toContain('Dedicated session');
    expect(status?.textContent).toContain('waiting for its first progress report');
    expect(status?.querySelector<HTMLButtonElement>('button')?.textContent).toContain('Cancel');
  });

  it('opens a dedicated Agent session instead of leaving the request behind a busy existing Agent', async () => {
    const snapshot: AgentCoordinationSnapshot = {
      revision: 1,
      activityRevision: 1,
      activities: [],
      projects: [{
        projectId: 'project-1',
        goal: 'Document the system',
        defaultTargetBranch: 'main',
        validationCommands: [],
        configRevision: 1,
        counts: { starting: 0, working: 1, blocked: 0, done: 0, idle: 0, error: 0, unknown: 0 },
        participants: [{
          participantId: 'participant-1',
          projectId: 'project-1',
          activityId: 'activity-1',
          sessionId: 'session-1',
          rootId: 'root-1',
          workspaceId: 'workspace-1',
          alias: 'Busy Builder',
          role: 'implementation',
          task: 'Finish the current turn',
          provider: 'codex',
          joined: true,
          joinedAt: 1,
          updatedAt: 2,
        }],
        pendingMergeCount: 0,
      }],
      mergeRequests: [],
    };
    const emptyCollection: ProjectMapCollectionDescriptor = {
      projectId: 'project-1',
      collectionId: 'ezterminal',
      state: 'empty',
      roots: [],
      bindings: [],
      maps: [],
      diagnostics: [],
    };
    const api = installApis({ descriptor: emptyCollection, snapshot });
    api.sendAgentPrompt.mockImplementation(() => new Promise<{ ok: true }>(() => undefined));
    const onLaunchAgent = vi.fn();
    await render(undefined, onLaunchAgent);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]')?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="project-map-send-creation"]')?.click();
    });
    await flush();

    expect(onLaunchAgent).toHaveBeenCalledOnce();
    expect(api.prepareAgentLaunch).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    }, 'codex');
    expect(onLaunchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'new-chat',
        launcherId: 'codex',
        projectMapRequest: expect.objectContaining({
          projectId: 'project-1',
          ownerRootId: 'root-1',
          ownerWorkspaceId: 'workspace-1',
          type: 'architecture',
          intent: 'create',
          brief: expect.stringContaining('Create the initial EZTerminal-native Project Map collection'),
        }),
      }),
      {
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
        projectName: 'Project',
        titleMode: 'generated',
      },
    );
    expect(api.startProjectMapJob).not.toHaveBeenCalled();
    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
  });

  it('restores a persisted queued job on the empty collection after the panel reopens', async () => {
    const descriptor: ProjectMapCollectionDescriptor = {
      projectId: 'project-1',
      collectionId: 'ezterminal',
      state: 'empty',
      roots: [],
      bindings: [],
      maps: [],
      diagnostics: [],
    };
    const activeJob: ProjectMapJob = {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      type: 'architecture',
      intent: 'create',
      activityId: 'activity-1',
      phase: 'queued',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    installApis({
      descriptor,
      projectMapSnapshot: {
        collection: descriptor,
        freshness: 'empty',
        verificationPending: false,
        activeJob,
      },
    });
    await render();

    const status = container.querySelector<HTMLElement>('[data-testid="project-map-delivery-status"]');
    expect(status?.textContent).toContain('Queued for active Agent');
    expect(status?.textContent).toContain('Waiting for the Agent to accept it or report progress');
    const create = container.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]');
    expect(create?.disabled).toBe(true);
    expect(create?.textContent).toContain('Request in progress');
  });

  it('offers a configured launcher regardless of existing coordination membership', async () => {
    const snapshot: AgentCoordinationSnapshot = {
      revision: 1,
      activityRevision: 1,
      activities: [{
        id: 'activity-1',
        sessionId: 'session-1',
        provider: 'codex',
        providerLabel: 'Codex CLI',
        cwd: 'C:\\Project',
        state: 'working',
        status: 'working',
        stateSeq: 1,
        live: true,
        interactiveReady: true,
        stateSource: 'provider-hook',
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
        createdAt: 1,
        updatedAt: 2,
      }],
      projects: [{
        projectId: 'project-1',
        goal: 'Document the system',
        defaultTargetBranch: 'main',
        validationCommands: [],
        configRevision: 1,
        counts: { starting: 0, working: 1, blocked: 0, done: 0, idle: 0, error: 0, unknown: 0 },
        participants: [],
        pendingMergeCount: 0,
      }],
      mergeRequests: [],
    };
    const api = installApis({ descriptor: collection('empty'), snapshot });
    const onLaunchAgent = vi.fn(() => true);
    await render(undefined, onLaunchAgent);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]')?.click();
    });

    const participant = container.querySelector<HTMLSelectElement>(
      '[data-testid="project-map-create-participant"]',
    );
    const send = container.querySelector<HTMLButtonElement>('[data-testid="project-map-send-creation"]');
    expect(participant?.value).not.toBe('');
    expect(send?.disabled).toBe(false);
    await act(async () => { send?.click(); });
    await flush();

    expect(onLaunchAgent).toHaveBeenCalledOnce();
    expect(api.prepareAgentLaunch).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    }), 'codex');
    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
  });

  it('keeps creation disabled until a supported Agent launcher is configured', async () => {
    const emptyCollection: ProjectMapCollectionDescriptor = {
      projectId: 'project-1',
      collectionId: 'ezterminal',
      state: 'empty',
      roots: [],
      bindings: [],
      maps: [],
      diagnostics: [],
    };
    const api = installApis({ descriptor: emptyCollection, launchers: [] });
    await render(undefined, vi.fn(() => true));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]')?.click();
    });

    const send = container.querySelector<HTMLButtonElement>('[data-testid="project-map-send-creation"]');
    expect(send?.disabled).toBe(true);
    expect(container.textContent).toContain('Configure Codex or Claude under Settings > Agents');
    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
  });

  it('does not open a session when the editable brief is empty', async () => {
    installApis({ descriptor: collection('empty') });
    const onLaunchAgent = vi.fn(() => true);
    await render(undefined, onLaunchAgent);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]')?.click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('.project-map__creator textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '   ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const send = container.querySelector<HTMLButtonElement>('[data-testid="project-map-send-creation"]');
    expect(send?.disabled).toBe(true);
    expect(onLaunchAgent).not.toHaveBeenCalled();
  });

  it('renders verified native SVG and opens a selected evidence anchor', async () => {
    installApis({});
    const onOpenEvidence = vi.fn();
    await render(onOpenEvidence);

    expect(container.querySelector('svg.project-map__canvas')).not.toBeNull();
    const mainNode = [...container.querySelectorAll<SVGGElement>('[data-map-item]')]
      .find((node) => node.dataset.mapItem === 'main');
    expect(mainNode).toBeDefined();
    await act(async () => { mainNode?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('Main owns the runtime authority.');

    const source = [...container.querySelectorAll<HTMLButtonElement>('.project-map__evidence-list button')]
      .find((button) => button.textContent?.includes('src/main/main.ts'));
    await act(async () => { source?.click(); });
    expect(onOpenEvidence).toHaveBeenCalledWith({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
      relativePath: 'src/main/main.ts',
      line: 4,
    });
  });

  it('persists root bindings only after the explicit Save bindings action', async () => {
    const api = installApis({ descriptor: collection('binding-required') });
    await render();
    expect(api.setProjectMapBindings).not.toHaveBeenCalled();
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Save bindings'));
    expect(save?.disabled).toBe(false);
    await act(async () => { save?.click(); });
    await flush();
    expect(api.setProjectMapBindings).toHaveBeenCalledWith({
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      bindings: [{ rootAlias: 'app', rootId: 'root-1', workspaceId: 'workspace-1' }],
    });
  });

  it('opens a dedicated owning-workspace Agent session for an editable update brief', async () => {
    const participant = {
      participantId: 'participant-1',
      projectId: 'project-1',
      activityId: 'activity-1',
      sessionId: 'session-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
      alias: 'Builder',
      role: 'implementation',
      task: 'Update maps',
      provider: 'codex' as const,
      joined: true,
      joinedAt: 1,
      updatedAt: 2,
    };
    const snapshot: AgentCoordinationSnapshot = {
      revision: 1,
      activityRevision: 1,
      activities: [],
      projects: [{
        projectId: 'project-1',
        goal: 'Document the system',
        defaultTargetBranch: 'main',
        validationCommands: [],
        configRevision: 1,
        counts: { starting: 0, working: 1, blocked: 0, done: 0, idle: 0, error: 0, unknown: 0 },
        participants: [participant],
        pendingMergeCount: 0,
      }],
      mergeRequests: [],
    };
    const api = installApis({ snapshot });
    const onLaunchAgent = vi.fn(() => true);
    await render(undefined, onLaunchAgent);
    const details = container.querySelector<HTMLDetailsElement>('.project-map__authoring');
    expect(details).not.toBeNull();
    details!.open = true;
    const textarea = details!.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Review and update only this map.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...details!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Update in new Agent session'));
    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
    await act(async () => { send?.click(); });
    await flush();
    expect(api.prepareAgentLaunch).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    }, 'codex');
    expect(onLaunchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'new-chat',
        launcherId: 'codex',
        projectMapRequest: expect.objectContaining({
          mapId: 'runtime',
          type: 'architecture',
          intent: 'update',
          brief: 'Review and update only this map.',
        }),
      }),
      expect.objectContaining({
        projectId: 'project-1',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
      }),
    );
    expect(api.sendAgentPrompt).not.toHaveBeenCalled();
    expect(api.startProjectMapJob).not.toHaveBeenCalled();
  });
});
