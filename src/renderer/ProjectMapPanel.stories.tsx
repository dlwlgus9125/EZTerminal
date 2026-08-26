import type { Meta, StoryObj } from '@storybook/react-vite';
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { expect, within } from 'storybook/test';
import { useCallback, useEffect, useState } from 'react';

import architectureJson from '../../.ezterminal/project-map/maps/runtime-architecture.architecture.json';
import dataflowJson from '../../.ezterminal/project-map/maps/remote-session-dataflow.dataflow.json';
import workflowJson from '../../.ezterminal/project-map/maps/human-agent-collaboration.workflow.json';
import sequenceJson from '../../.ezterminal/project-map/maps/terminal-pty-sequence.sequence.json';
import lifecycleJson from '../../.ezterminal/project-map/maps/workbench-lifecycle.lifecycle.json';
import {
  type ProjectMapCollectionDescriptor,
  type ProjectMapDocument,
  type ProjectMapSpec,
  validateProjectMapSpec,
} from '../shared/project-map';
import { layoutProjectMap } from '../shared/project-map-layout';
import { AppI18nProvider } from './i18n';
import { ProjectMapPanel } from './ProjectMapPanel';
import './index.css';

const PROJECT_ID = 'project-map-story';
const ROOT_ID = 'root-map-story';
const WORKSPACE_ID = 'workspace-map-story';

const sources = [architectureJson, sequenceJson, lifecycleJson, dataflowJson, workflowJson];
const specs = sources.map((source) => {
  const result = validateProjectMapSpec(source);
  if (!result.value) throw new Error(`Invalid Project Map story fixture: ${JSON.stringify(result.diagnostics)}`);
  return result.value;
});

function documentFor(spec: ProjectMapSpec): ProjectMapDocument {
  const layout = layoutProjectMap(spec).layout;
  return {
    collectionId: 'ezterminal-system',
    mapId: spec.id,
    mapPath: `.ezterminal/project-map/maps/${spec.id}.${spec.type}.json`,
    state: 'valid',
    spec,
    layout,
    provenance: {
      kind: 'worktree-snapshot',
      roots: [{
        rootAlias: 'app',
        head: '9d2b18f7c662db9193048383fb06890778e3f35e',
        dirty: true,
        snapshotHash: `sha256:${'3'.repeat(64)}`,
      }],
    },
    verification: {
      quality: 'production',
      fingerprint: `sha256:${'5'.repeat(64)}`,
      verifiedAt: '2026-08-19T12:00:00.000Z',
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
}

const documents = new Map(specs.map((spec) => [spec.id, documentFor(spec)]));
const collection: ProjectMapCollectionDescriptor = {
  projectId: PROJECT_ID,
  collectionId: 'ezterminal-system',
  state: 'valid',
  overviewMapId: 'runtime-architecture',
  ownerRootAlias: 'app',
  roots: [{ alias: 'app', label: 'EZTerminal' }],
  bindings: [{ rootAlias: 'app', rootId: ROOT_ID, workspaceId: WORKSPACE_ID }],
  maps: specs.map((spec) => ({ id: spec.id, type: spec.type, title: spec.title })),
  diagnostics: [],
};

const emptyCollection: ProjectMapCollectionDescriptor = {
  projectId: PROJECT_ID,
  collectionId: 'ezterminal-system',
  state: 'empty',
  roots: [],
  bindings: [],
  maps: [],
  diagnostics: [],
};

function ProjectMapStoryPanel(props: IDockviewPanelProps): JSX.Element {
  return <ProjectMapPanel {...props} onLaunchAgent={() => true} />;
}

function ProjectMapStory({
  locale,
  mapId,
  scenario,
}: {
  readonly locale: 'en' | 'ko';
  readonly mapId: string;
  readonly scenario: 'valid' | 'empty' | 'delivery' | 'cold' | 'background' | 'candidate' | 'job' | 'stale' | 'last-approved';
}): JSX.Element {
  const [installed] = useState(() => {
    const emptyScenario = scenario === 'empty' || scenario === 'delivery';
    const base = Object.getOwnPropertyDescriptor(window, 'ezterminal');
    const desktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        ...(window.ezterminal ?? {}),
        listAgentProjectLaunchers: async () => [{
          launcherId: 'codex',
          provider: 'codex' as const,
          name: 'Codex',
          supportsAdditionalRoots: true,
        }],
        prepareAgentLaunch: async () => ({
          ok: true as const,
          target: {
            kind: 'project' as const,
            projectId: PROJECT_ID,
            rootId: ROOT_ID,
            workspaceId: WORKSPACE_ID,
          },
          launcherId: 'codex',
          provider: 'codex' as const,
          name: 'Codex',
          cwd: 'C:\\Working\\EZTerminal',
          roots: ['C:\\Working\\EZTerminal'],
          ignoredAdditionalRootCount: 0,
          revision: 'story-launch-revision',
        }),
      },
    });
    const baseDocument = documents.get(mapId ?? collection.overviewMapId!)!;
    const storyDocument = scenario === 'stale'
      ? {
          ...baseDocument,
          state: 'stale' as const,
          verification: {
            ...baseDocument.verification,
            checks: baseDocument.verification.checks.map((check) => check.name === 'inputs'
              ? { ...check, status: 'warning' as const }
              : check),
            diagnostics: [{
              severity: 'warning' as const,
              code: 'inputs.review-required',
              subject: baseDocument.mapId,
              message: 'Authoritative inputs changed after review.',
            }],
          },
        }
      : baseDocument;
    const candidateDocument = scenario === 'last-approved'
      ? {
          ...baseDocument,
          verification: { ...baseDocument.verification, fingerprint: `sha256:${'6'.repeat(64)}` },
          spec: { ...baseDocument.spec, summary: `${baseDocument.spec.summary} Candidate update.` },
        }
      : storyDocument;
    const storySnapshot = scenario === 'delivery'
      ? {
          collection: emptyCollection,
          freshness: 'empty' as const,
          verificationPending: false,
          activeJob: {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: PROJECT_ID,
            ownerRootId: ROOT_ID,
            ownerWorkspaceId: WORKSPACE_ID,
            type: 'architecture' as const,
            intent: 'create' as const,
            activityId: 'activity-dedicated-map-author',
            dispatch: 'dedicated-session' as const,
            agentLabel: 'Codex',
            phase: 'queued' as const,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        }
      : scenario === 'empty'
        ? {
          collection: emptyCollection,
          freshness: 'empty' as const,
          verificationPending: false,
        }
      : scenario === 'cold'
        ? { collection, freshness: 'cache' as const, verificationPending: true }
        : {
          collection,
          map: storyDocument,
          candidate: candidateDocument,
          displaySource: scenario === 'candidate'
            ? 'candidate-preview' as const
            : scenario === 'last-approved'
              ? 'last-approved' as const
              : 'approved' as const,
          freshness: 'verified' as const,
          ...(scenario === 'candidate' ? {} : { approval: {
            mapId: storyDocument.mapId,
            fingerprint: storyDocument.verification.fingerprint,
            approvedAt: '2026-08-20T00:00:00.000Z',
          } }),
          verificationPending: scenario === 'background',
          ...(scenario === 'job' ? { activeJob: {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: PROJECT_ID,
            ownerRootId: ROOT_ID,
            ownerWorkspaceId: WORKSPACE_ID,
            mapId: storyDocument.mapId,
            type: storyDocument.spec.type,
            intent: 'update' as const,
            activityId: 'activity-map-author',
            dispatch: 'dedicated-session' as const,
            agentLabel: 'Codex',
            phase: 'validating-production' as const,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:01:00.000Z',
          } } : {}),
          ...(scenario === 'last-approved' ? { diff: {
            fromFingerprint: storyDocument.verification.fingerprint,
            toFingerprint: candidateDocument.verification.fingerprint,
            semantic: [{ kind: 'changed' as const, id: storyDocument.mapId, fields: ['summary'] }],
            evidence: [],
          } } : {}),
        };
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        describeProjectMapCollection: async () => ({
          ok: true as const,
          collection: emptyScenario ? emptyCollection : collection,
        }),
        readProjectMap: async (request: { readonly mapId?: string }) => ({
          ok: true as const,
          map: documents.get(request.mapId ?? collection.overviewMapId!)!,
        }),
        refreshProjectMap: async (request: { readonly mapId?: string }) => ({
          ok: true as const,
          map: documents.get(request.mapId ?? collection.overviewMapId!)!,
        }),
        openProjectMap: async () => ({ ok: true as const, snapshot: storySnapshot }),
        refreshProjectMapSnapshot: async () => ({ ok: true as const, snapshot: storySnapshot }),
        approveProjectMap: async () => ({ ok: true as const, snapshot: storySnapshot }),
        startProjectMapJob: async (request: { readonly type: ProjectMapSpec['type']; readonly intent: 'create' | 'update'; readonly activityId: string }) => ({
          ok: true as const,
          job: {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: PROJECT_ID,
            ownerRootId: ROOT_ID,
            ownerWorkspaceId: WORKSPACE_ID,
            type: request.type,
            intent: request.intent,
            activityId: request.activityId,
            phase: 'queued' as const,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        }),
        cancelProjectMapJob: async () => ({ ok: false as const, error: 'not-found' }),
        selectProjectMapExportDirectory: async () => ({ ok: false as const, error: 'canceled' }),
        exportProjectMap: async () => ({ ok: false, error: 'not-exported' }),
        setProjectMapBindings: async () => ({ ok: true as const, collection }),
        onProjectMapChanged: () => () => undefined,
        describeProjectWorkspace: async () => ({
          ok: true as const,
          project: {
            projectId: PROJECT_ID,
            name: 'EZTerminal',
            roots: [{ rootId: ROOT_ID, name: 'EZTerminal', displayPath: 'C:\\Working\\EZTerminal', primary: true }],
            workspaces: [{
              rootId: ROOT_ID,
              workspaceId: WORKSPACE_ID,
              name: 'EZTerminal (main)',
              displayPath: 'C:\\Working\\EZTerminal',
              kind: 'main' as const,
              access: 'granted' as const,
              branch: 'main',
            }],
          },
        }),
      },
    });
    return { base, desktop };
  });

  useEffect(() => () => {
    if (installed.base) Object.defineProperty(window, 'ezterminal', installed.base);
    if (installed.desktop) Object.defineProperty(window, 'ezterminalDesktop', installed.desktop);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [installed]);

  const onReady = useCallback((event: DockviewReadyEvent): void => {
    event.api.addPanel({
      id: 'project-map-story-panel',
      component: 'project-map',
      title: 'Project Map',
      renderer: 'onlyWhenVisible',
      params: {
        projectId: PROJECT_ID,
        ownerRootId: ROOT_ID,
        ownerWorkspaceId: WORKSPACE_ID,
        mapId,
      },
    });
  }, [mapId]);

  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <main className="project-map-story">
        <DockviewReact
          className="dockview-theme-dark ez-dock"
          components={{ 'project-map': ProjectMapStoryPanel }}
          onReady={onReady}
          disableFloatingGroups
        />
      </main>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Project Map',
  component: ProjectMapStory,
  parameters: { layout: 'fullscreen' },
  args: { locale: 'en', mapId: 'runtime-architecture', scenario: 'valid' },
} satisfies Meta<typeof ProjectMapStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Architecture: Story = {};
export const ArchitectureKorean: Story = { args: { locale: 'ko' } };
export const Workflow: Story = { args: { mapId: 'human-agent-collaboration' } };
export const WorkflowKorean: Story = { args: { locale: 'ko', mapId: 'human-agent-collaboration' } };
export const Sequence: Story = { args: { mapId: 'terminal-pty-sequence' } };
export const SequenceKorean: Story = { args: { locale: 'ko', mapId: 'terminal-pty-sequence' } };
export const Dataflow: Story = { args: { mapId: 'remote-session-dataflow' } };
export const DataflowKorean: Story = { args: { locale: 'ko', mapId: 'remote-session-dataflow' } };
export const Lifecycle: Story = { args: { mapId: 'workbench-lifecycle' } };
export const LifecycleKorean: Story = { args: { locale: 'ko', mapId: 'workbench-lifecycle' } };
export const BackgroundVerification: Story = { args: { scenario: 'background' } };
export const ColdOpen: Story = { args: { scenario: 'cold' } };
export const ActiveJob: Story = { args: { scenario: 'job' } };
export const CandidatePreview: Story = { args: { scenario: 'candidate' } };
export const Approved: Story = { args: { scenario: 'valid' } };
export const Stale: Story = { args: { scenario: 'stale' } };
export const LastApprovedWithCandidate: Story = { args: { scenario: 'last-approved' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const EmptyCreate: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-testid="project-map-create"]')?.click();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  },
};
export const EmptyCreateKorean: Story = {
  args: { locale: 'ko', scenario: 'empty' },
  play: EmptyCreate.play,
};
export const QueuedDelivery: Story = {
  args: { scenario: 'delivery' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = await canvas.findByTestId('project-map-delivery-status');
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-phase', 'queued');
  },
};
export const QueuedDeliveryKorean: Story = {
  args: { locale: 'ko', scenario: 'delivery' },
  play: QueuedDelivery.play,
};
