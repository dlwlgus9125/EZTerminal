import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AgentProjectSummary } from '../shared/agent-history';
import type { ProjectDocumentDirectoryRequest, ProjectDocumentIdentity } from '../shared/project-workspace';
import { AppI18nProvider } from './i18n';
import { ProjectWorkspacePanel } from './ProjectWorkspacePanel';
import './index.css';

const project: AgentProjectSummary = {
  projectId: 'project-story',
  name: 'EZTerminal',
  primaryRoot: 'C:\\Working\\EZTerminal',
  additionalRoots: [],
  pinned: true,
  saved: true,
  sessionCount: 2,
  providers: ['codex'],
  lastActiveAt: Date.now(),
};

function storyDocument(
  relativePath: string,
  workspaceId = 'main-story',
): ProjectDocumentIdentity {
  return {
    key: `${project.projectId}\u0000root-story\u0000${workspaceId}\u0000${relativePath}`,
    id: {
      projectId: project.projectId,
      rootId: 'root-story',
      workspaceId,
      relativePath,
    },
  };
}

function ProjectWorkspaceStory({ external }: { readonly external: boolean }): JSX.Element {
  const [installed] = useState(() => {
    const desktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        describeProjectWorkspace: async () => ({
          ok: true as const,
          project: {
            projectId: project.projectId,
            name: project.name,
            roots: [{
              rootId: 'root-story',
              name: 'EZTerminal',
              displayPath: project.primaryRoot,
              primary: true,
            }],
            workspaces: [{
              workspaceId: external ? 'external-story' : 'main-story',
              rootId: 'root-story',
              name: external ? 'review/sidebar' : 'EZTerminal (main)',
              displayPath: external ? 'D:\\reviews\\sidebar' : project.primaryRoot,
              kind: external ? 'external' as const : 'main' as const,
              access: external ? 'authorization-required' as const : 'granted' as const,
              branch: external ? 'review/sidebar' : 'main',
              head: '9d2b18f7c662db9193048383fb06890778e3f35e',
              repositoryId: 'repo-story',
            }],
          },
        }),
        listProjectDocumentDirectory: async (request: ProjectDocumentDirectoryRequest) => ({
          ok: true as const,
          directory: storyDocument(request.relativePath, request.workspaceId),
          parent: request.relativePath ? '' : null,
          entries: request.relativePath
            ? [
                {
                  name: 'App.tsx',
                  relativePath: 'src/renderer/App.tsx',
                  kind: 'file' as const,
                  size: 62_400,
                  mtimeMs: Date.now(),
                  sensitive: false,
                  document: storyDocument('src/renderer/App.tsx', request.workspaceId),
                  status: 'modified' as const,
                  additions: 6,
                  deletions: 2,
                },
                {
                  name: 'ProjectWorkspacePanel.tsx',
                  relativePath: 'src/renderer/ProjectWorkspacePanel.tsx',
                  kind: 'file' as const,
                  size: 31_200,
                  mtimeMs: Date.now(),
                  sensitive: false,
                  document: storyDocument('src/renderer/ProjectWorkspacePanel.tsx', request.workspaceId),
                  status: 'modified' as const,
                  additions: 182,
                  deletions: 12,
                },
              ]
            : [
                {
                  name: 'src',
                  relativePath: 'src',
                  kind: 'directory' as const,
                  size: 0,
                  mtimeMs: Date.now(),
                  sensitive: false,
                  document: storyDocument('src', request.workspaceId),
                },
                {
                  name: 'package.json',
                  relativePath: 'package.json',
                  kind: 'file' as const,
                  size: 4_200,
                  mtimeMs: Date.now(),
                  sensitive: false,
                  document: storyDocument('package.json', request.workspaceId),
                },
                {
                  name: 'README.md',
                  relativePath: 'README.md',
                  kind: 'file' as const,
                  size: 6_400,
                  mtimeMs: Date.now(),
                  sensitive: false,
                  document: storyDocument('README.md', request.workspaceId),
                  status: 'modified' as const,
                  additions: 6,
                  deletions: 2,
                },
              ],
        }),
      } as typeof window.ezterminalDesktop,
    });
    return { desktop };
  });
  useEffect(() => () => {
    if (installed.desktop) Object.defineProperty(window, 'ezterminalDesktop', installed.desktop);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [installed]);
  return (
    <AppI18nProvider>
      <div style={{ width: 390, height: 760, border: '1px solid var(--ui-border-strong)' }}>
        <ProjectWorkspacePanel
          project={project}
          onBack={() => undefined}
          onOpenDocument={() => undefined}
          onNewSession={() => undefined}
          onManage={() => undefined}
        />
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Project Explorer',
  component: ProjectWorkspaceStory,
  parameters: { layout: 'centered' },
  args: { external: false },
} satisfies Meta<typeof ProjectWorkspaceStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Files: Story = {};
export const ExternalApproval: Story = { args: { external: true } };
