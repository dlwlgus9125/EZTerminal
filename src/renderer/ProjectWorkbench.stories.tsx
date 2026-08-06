import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AgentProjectPage } from '../shared/agent-history';
import type { ProjectDirectoryResult } from '../shared/project-workspace';
import { AppI18nProvider } from './i18n';
import { ProjectExplorerPanel } from './ProjectExplorerPanel';
import './index.css';

type StoryState = 'content' | 'loading' | 'empty' | 'error';

const PROJECTS: AgentProjectPage = {
  items: [{
    projectId: 'project-story',
    name: 'EZTerminal',
    primaryRoot: 'C:\\Working\\EZTerminal',
    additionalRoots: ['C:\\Working\\Shared'],
    pinned: true,
    saved: true,
    sessionCount: 2,
    providers: ['codex', 'claude'],
    lastActiveAt: Date.now(),
  }],
  nextCursor: null,
};

function listing(state: StoryState, _rootId: string, relativePath: string): Promise<ProjectDirectoryResult> {
  if (state === 'loading') return new Promise(() => undefined);
  if (state === 'error') return Promise.resolve({ ok: false, error: 'io-error' });
  if (state === 'empty') return Promise.resolve({ ok: true, relativePath, parent: null, entries: [] });
  const entries = relativePath === ''
    ? [
      { name: 'src', relativePath: 'src', kind: 'directory' as const, size: 0, mtimeMs: 0, sensitive: false },
      { name: 'package.json', relativePath: 'package.json', kind: 'file' as const, size: 2190, mtimeMs: 0, sensitive: false },
      { name: '.env.local', relativePath: '.env.local', kind: 'file' as const, size: 90, mtimeMs: 0, sensitive: true },
    ]
    : [
      { name: 'main.ts', relativePath: `${relativePath}/main.ts`, kind: 'file' as const, size: 4210, mtimeMs: 0, sensitive: false },
      { name: 'renderer', relativePath: `${relativePath}/renderer`, kind: 'directory' as const, size: 0, mtimeMs: 0, sensitive: false },
    ];
  return Promise.resolve({ ok: true, relativePath, parent: relativePath ? '' : null, entries });
}

function ProjectWorkbenchStory({ state }: { readonly state: StoryState }): JSX.Element {
  const [installed] = useState(() => {
    const ezterminal = Object.getOwnPropertyDescriptor(window, 'ezterminal');
    const desktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        ...(window.ezterminal ?? {}),
        listAgentProjects: async () => PROJECTS,
      } as typeof window.ezterminal,
    });
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        describeProjectWorkspace: async () => ({
          ok: true as const,
          project: {
            projectId: 'project-story',
            name: 'EZTerminal',
            roots: [
              { rootId: 'root-main', name: 'EZTerminal', displayPath: 'C:\\Working\\EZTerminal', primary: true },
              { rootId: 'root-shared', name: 'Shared', displayPath: 'C:\\Working\\Shared', primary: false },
            ],
          },
        }),
        listProjectDirectory: async (request: { rootId: string; relativePath: string }) =>
          listing(state, request.rootId, request.relativePath),
        searchProjectWorkspace: async () => ({ ok: true as const, matches: [], truncated: false, scannedFiles: 3, scannedBytes: 0 }),
        cancelProjectWorkspaceSearch: () => undefined,
      } as typeof window.ezterminalDesktop,
    });
    return { ezterminal, desktop };
  });
  useEffect(() => () => {
    if (installed.ezterminal) Object.defineProperty(window, 'ezterminal', installed.ezterminal);
    else Reflect.deleteProperty(window, 'ezterminal');
    if (installed.desktop) Object.defineProperty(window, 'ezterminalDesktop', installed.desktop);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [installed]);
  return (
    <AppI18nProvider>
      <div style={{ width: 360, height: 680, border: '1px solid var(--ui-border-strong)' }}>
        <ProjectExplorerPanel onOpenFile={() => undefined} onOpenReview={() => undefined} />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Project Workbench',
  component: ProjectWorkbenchStory,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ProjectWorkbenchStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Content: Story = { args: { state: 'content' } };
export const Loading: Story = { args: { state: 'loading' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Error: Story = { args: { state: 'error' } };
