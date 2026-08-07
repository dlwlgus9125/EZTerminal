import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type {
  ProjectDocumentLens,
  ProjectDocumentSnapshot,
  ProjectReviewTextView,
} from '../shared/project-workspace';
import { ProjectEditorPanel } from './ProjectEditorPanel';
import { AppI18nProvider } from './i18n';
import './index.css';

type ReviewMode = 'full-diff' | 'current-record' | 'record-only' | 'deleted';
const REVIEW_PATH = 'src/renderer/ProjectEditorPanel.tsx';
const DOCUMENT_KEY = 'project-story\0root-story\0workspace-story\0src/renderer/ProjectEditorPanel.tsx';

const CURRENT_FILE = [
  "export const firstLineContext = 'complete current file — first line';",
  '',
  'export interface ReviewState {',
  "  readonly status: 'idle' | 'ready';",
  '}',
  '',
  'export const state: ReviewState = {',
  "  status: 'ready',",
  '};',
  '',
  'export function describe(): string {',
  '  return `review:${state.status}`;',
  '}',
  '',
  "export const lastLineContext = 'complete current file — last line';",
  '',
].join('\n');

const currentLens = { kind: 'current' } as const;
const agentLens = {
  kind: 'agent-turn',
  historyId: 'history-story',
  turnId: 'turn-story',
} as const;

function reviewView(mode: ReviewMode): ProjectReviewTextView {
  if (mode === 'full-diff') {
    return {
      kind: 'full-diff',
      coverage: 'full-file',
      original: CURRENT_FILE.replace("status: 'ready'", "status: 'idle'"),
      modified: CURRENT_FILE,
    };
  }
  if (mode === 'deleted') {
    return {
      kind: 'full-diff',
      coverage: 'full-file',
      original: CURRENT_FILE,
      modified: '',
    };
  }
  const sections = [{
    anchorLine: 8,
    lines: [
      { kind: 'meta' as const, text: '@@ -8 +8 @@' },
      { kind: 'removed' as const, text: "  status: 'idle'," },
      { kind: 'added' as const, text: "  status: 'ready'," },
    ],
  }];
  return mode === 'current-record'
    ? { kind: 'current-with-record', current: CURRENT_FILE, sections }
    : { kind: 'record-only', sections: sections.map(({ lines }) => ({ lines })) };
}

function lensFor(mode: ReviewMode): ProjectDocumentLens {
  return mode === 'current-record' || mode === 'record-only' ? agentLens : currentLens;
}

function snapshotFor(mode: ReviewMode): ProjectDocumentSnapshot {
  const lens = lensFor(mode);
  const deleted = mode === 'deleted';
  const recordOnly = mode === 'record-only';
  return {
    document: {
      id: {
        projectId: 'project-story',
        rootId: 'root-story',
        workspaceId: 'workspace-story',
        relativePath: REVIEW_PATH,
      },
      key: DOCUMENT_KEY,
    },
    lens,
    current: deleted || recordOnly
      ? null
      : {
          relativePath: REVIEW_PATH,
          content: CURRENT_FILE,
          version: 'story-current-version',
          byteLength: new TextEncoder().encode(CURRENT_FILE).byteLength,
          language: 'typescript',
          sensitive: false,
        },
    state: deleted ? 'deleted' : recordOnly ? 'record-only' : 'text',
    revision: deleted || recordOnly ? `story-${mode}-revision` : 'story-current-version',
    comparison: {
      lens,
      source: lens.kind === 'agent-turn' ? 'claude' : 'git',
      title: lens.kind === 'agent-turn' ? 'Selected completed turn' : 'Current changes',
      language: 'typescript',
      revision: 'a'.repeat(64),
      change: {
        relativePath: REVIEW_PATH,
        kind: deleted ? 'deleted' : 'modified',
        additions: deleted ? 0 : 1,
        deletions: 1,
        binary: false,
      },
      originalPath: REVIEW_PATH,
      modifiedPath: REVIEW_PATH,
      view: reviewView(mode),
    },
  };
}

function ProjectReviewStory({ mode }: { readonly mode: ReviewMode }): JSX.Element {
  const [installed] = useState(() => {
    const desktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        readProjectDocument: async () => ({
          ok: true as const,
          snapshot: snapshotFor(mode),
        }),
      } as typeof window.ezterminalDesktop,
    });
    const api = {
      id: `project-review-${mode}`,
      width: Math.max(320, window.innerWidth - 48),
      onDidDimensionsChange: () => ({ dispose: () => undefined }),
      onDidParametersChange: () => ({ dispose: () => undefined }),
      getParameters: () => ({}),
      setTitle: () => undefined,
      updateParameters: () => undefined,
    } as unknown as IDockviewPanelProps['api'];
    return { api, desktop };
  });
  useEffect(() => () => {
    if (installed.desktop) Object.defineProperty(window, 'ezterminalDesktop', installed.desktop);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [installed]);
  const props = {
    api: installed.api,
    params: {
      projectId: 'project-story',
      rootId: 'root-story',
      workspaceId: 'workspace-story',
      relativePath: REVIEW_PATH,
      documentKey: DOCUMENT_KEY,
      lens: lensFor(mode),
    },
  } as unknown as IDockviewPanelProps;
  return (
    <AppI18nProvider>
      <div style={{
        width: 'calc(100vw - 32px)',
        height: 'calc(100vh - 32px)',
        border: '1px solid var(--ui-border-strong)',
      }}>
        <ProjectEditorPanel {...props} />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Project Review',
  component: ProjectReviewStory,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ProjectReviewStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentFileWithRecord: Story = { args: { mode: 'current-record' } };
export const FullDiff: Story = { args: { mode: 'full-diff' } };
export const RecordOnly: Story = { args: { mode: 'record-only' } };
export const DeletedFile: Story = { args: { mode: 'deleted' } };
