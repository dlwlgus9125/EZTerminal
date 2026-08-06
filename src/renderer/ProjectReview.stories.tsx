import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { ProjectReviewTextView } from '../shared/project-workspace';
import { CodeDiffPanel } from './CodeDiffPanel';
import { AppI18nProvider } from './i18n';
import './index.css';

type ReviewMode = 'full-diff' | 'current-record' | 'record-only';

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
  "  return `review:${state.status}`;",
  '}',
  '',
  "export const lastLineContext = 'complete current file — last line';",
  '',
].join('\n');

function reviewView(mode: ReviewMode): ProjectReviewTextView {
  if (mode === 'full-diff') {
    return {
      kind: 'full-diff',
      coverage: 'current-context',
      original: CURRENT_FILE.replace("status: 'ready'", "status: 'idle'"),
      modified: CURRENT_FILE,
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

function ProjectReviewStory({ mode }: { readonly mode: ReviewMode }): JSX.Element {
  const [installed] = useState(() => {
    const desktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        getProjectReview: async () => ({
          ok: true as const,
          scope: 'last-turn' as const,
          source: 'claude' as const,
          title: 'Selected completed turn',
          repositoryName: 'EZTerminal',
          revision: 'a'.repeat(64),
          changes: [{
            relativePath: 'src/renderer/CodeDiffPanel.tsx',
            kind: 'modified' as const,
            additions: 1,
            deletions: 1,
            binary: false,
          }],
        }),
        getProjectReviewFile: async () => ({
          ok: true as const,
          relativePath: 'src/renderer/CodeDiffPanel.tsx',
          originalPath: 'src/renderer/CodeDiffPanel.tsx',
          modifiedPath: 'src/renderer/CodeDiffPanel.tsx',
          language: 'typescript',
          binary: false as const,
          view: reviewView(mode),
          sensitive: false,
        }),
      } as typeof window.ezterminalDesktop,
    });
    const api = {
      id: `project-review-${mode}`,
      width: Math.max(320, window.innerWidth - 48),
      onDidDimensionsChange: () => ({ dispose: () => undefined }),
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
      scope: 'last-turn',
      historyId: 'history-story',
      reviewTurnId: 'turn-story',
    },
  } as unknown as IDockviewPanelProps;
  return (
    <AppI18nProvider>
      <div style={{ width: 'calc(100vw - 32px)', height: 'calc(100vh - 32px)', border: '1px solid var(--ui-border-strong)' }}>
        <CodeDiffPanel {...props} />
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
