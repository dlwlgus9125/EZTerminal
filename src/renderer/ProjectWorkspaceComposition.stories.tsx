import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentProjectSummary } from '../shared/agent-history';
import type {
  ProjectDocumentDirectoryRequest,
  ProjectDocumentIdentity,
  ProjectDocumentSnapshot,
} from '../shared/project-workspace';
import { AppI18nProvider } from './i18n';
import './index.css';
import { ProjectEditorPanel } from './ProjectEditorPanel';
import { ProjectWorkspacePanel } from './ProjectWorkspacePanel';
import { applyProjectReviewLayout, type ProjectReviewLayoutMode } from './project-review-layout';

const PROJECT_ID = 'project-workspace-story';
const ROOT_ID = 'root-workspace-story';
const WORKSPACE_ID = 'workspace-story';
const FILE_PATH = 'src/app.ts';

const project: AgentProjectSummary = {
  projectId: PROJECT_ID,
  name: 'EZTerminal',
  primaryRoot: 'C:\\Working\\EZTerminal',
  additionalRoots: [],
  pinned: true,
  saved: true,
  sessionCount: 3,
  providers: ['codex'],
  lastActiveAt: 1_786_000_000_000,
};

function identity(relativePath: string): ProjectDocumentIdentity {
  return {
    key: `${PROJECT_ID}\u0000${ROOT_ID}\u0000${WORKSPACE_ID}\u0000${relativePath}`,
    id: {
      projectId: PROJECT_ID,
      rootId: ROOT_ID,
      workspaceId: WORKSPACE_ID,
      relativePath,
    },
  };
}

const fileIdentity = identity(FILE_PATH);
const currentContent = [
  "import { createWorkspace } from './workspace';",
  '',
  'export function openProject(root: string): Workspace {',
  '  const workspace = createWorkspace(root);',
  '  workspace.showFileTree();',
  '  workspace.keepTerminalAlive();',
  '  return workspace;',
  '}',
  '',
].join('\n');

const previousContent = currentContent.replace(
  '  workspace.showFileTree();\n  workspace.keepTerminalAlive();',
  '  workspace.showChanges();',
);

const documentSnapshot: ProjectDocumentSnapshot = {
  document: fileIdentity,
  lens: { kind: 'current' },
  current: {
    relativePath: FILE_PATH,
    content: currentContent,
    version: 'current-story-version',
    byteLength: currentContent.length,
    language: 'typescript',
    sensitive: false,
  },
  comparison: {
    lens: { kind: 'current' },
    source: 'git',
    title: 'Current changes',
    repositoryName: 'EZTerminal',
    language: 'typescript',
    revision: 'a'.repeat(64),
    change: {
      relativePath: FILE_PATH,
      kind: 'modified',
      additions: 2,
      deletions: 1,
      binary: false,
    },
    originalPath: FILE_PATH,
    modifiedPath: FILE_PATH,
    view: {
      kind: 'full-diff',
      coverage: 'full-file',
      original: previousContent,
      modified: currentContent,
    },
  },
  state: 'text',
  revision: 'current-story-version',
};

function directoryEntries(request: ProjectDocumentDirectoryRequest) {
  if (request.relativePath === 'src') {
    return [
      {
        name: 'app.ts',
        relativePath: FILE_PATH,
        kind: 'file' as const,
        size: currentContent.length,
        mtimeMs: 1_786_000_000_000,
        sensitive: false,
        document: fileIdentity,
        status: 'modified' as const,
        additions: 2,
        deletions: 1,
      },
      {
        name: 'workspace.ts',
        relativePath: 'src/workspace.ts',
        kind: 'file' as const,
        size: 2_914,
        mtimeMs: 1_786_000_000_000,
        sensitive: false,
        document: identity('src/workspace.ts'),
        status: 'added' as const,
        additions: 84,
        deletions: 0,
      },
      {
        name: 'workspace.spec.ts',
        relativePath: 'src/workspace.spec.ts',
        kind: 'file' as const,
        size: 1_842,
        mtimeMs: 1_786_000_000_000,
        sensitive: false,
        document: identity('src/workspace.spec.ts'),
      },
    ];
  }
  return [
    {
      name: 'src',
      relativePath: 'src',
      kind: 'directory' as const,
      size: 0,
      mtimeMs: 1_786_000_000_000,
      sensitive: false,
      document: identity('src'),
    },
    {
      name: 'package.json',
      relativePath: 'package.json',
      kind: 'file' as const,
      size: 4_826,
      mtimeMs: 1_786_000_000_000,
      sensitive: false,
      document: identity('package.json'),
    },
    {
      name: 'README.md',
      relativePath: 'README.md',
      kind: 'file' as const,
      size: 6_412,
      mtimeMs: 1_786_000_000_000,
      sensitive: false,
      document: identity('README.md'),
      status: 'renamed' as const,
      additions: 5,
      deletions: 3,
      previousRelativePath: 'docs/README.md',
    },
    {
      name: 'Dockerfile',
      relativePath: 'Dockerfile',
      kind: 'file' as const,
      size: 724,
      mtimeMs: 1_786_000_000_000,
      sensitive: false,
      document: identity('Dockerfile'),
    },
    {
      name: 'terminal-preview.svg',
      relativePath: 'terminal-preview.svg',
      kind: 'file' as const,
      size: 12_400,
      mtimeMs: 1_786_000_000_000,
      sensitive: false,
      document: identity('terminal-preview.svg'),
    },
  ];
}

function StoryTerminalPanel(): JSX.Element {
  return (
    <section className="project-workspace-story-terminal" data-testid="pane" aria-label="PowerShell terminal">
      <header>
        <strong>PowerShell</strong>
        <span data-testid="block-status" data-status="running">Running</span>
      </header>
      <div data-testid="pty-block" role="log" aria-label="Terminal output" aria-live="off">
        <pre><span>PS C:\Working\EZTerminal&gt; </span>pnpm test</pre>
        <pre className="project-workspace-story-terminal__success">Tests  42 passed</pre>
        <pre><span>PS C:\Working\EZTerminal&gt; </span><span className="project-workspace-story-terminal__caret">_</span></pre>
      </div>
    </section>
  );
}

const dockComponents = {
  'project-editor': ProjectEditorPanel,
  terminal: () => <StoryTerminalPanel />,
};

function currentMode(): ProjectReviewLayoutMode {
  return window.matchMedia('(min-width: 1024px)').matches ? 'wide' : 'narrow';
}

function IntegratedProjectWorkspace(): JSX.Element {
  const [mode, setMode] = useState<ProjectReviewLayoutMode>(() => currentMode());
  const apiRef = useRef<DockviewApi | null>(null);
  const [installed] = useState(() => {
    const desktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(window.ezterminalDesktop ?? {}),
        describeProjectWorkspace: async () => ({
          ok: true as const,
          project: {
            projectId: PROJECT_ID,
            name: 'EZTerminal',
            roots: [{
              rootId: ROOT_ID,
              name: 'EZTerminal',
              displayPath: project.primaryRoot,
              primary: true,
            }],
            workspaces: [{
              workspaceId: WORKSPACE_ID,
              rootId: ROOT_ID,
              name: 'EZTerminal (main)',
              displayPath: project.primaryRoot,
              kind: 'main' as const,
              access: 'granted' as const,
              branch: 'main',
              head: 'a'.repeat(40),
              repositoryId: 'repository-story',
            }],
          },
        }),
        listProjectDocumentDirectory: async (request: ProjectDocumentDirectoryRequest) => ({
          ok: true as const,
          directory: identity(request.relativePath),
          parent: request.relativePath ? '' : null,
          entries: directoryEntries(request),
          statusRevision: 'a'.repeat(64),
        }),
        readProjectDocument: async () => ({ ok: true as const, snapshot: documentSnapshot }),
        searchProjectWorkspace: async () => ({
          ok: true as const,
          matches: [],
          truncated: false,
          scannedFiles: 4,
          scannedBytes: 12_000,
        }),
        cancelProjectWorkspaceSearch: () => undefined,
      } as typeof window.ezterminalDesktop,
    });
    return { desktop };
  });

  useEffect(() => () => {
    if (installed.desktop) Object.defineProperty(window, 'ezterminalDesktop', installed.desktop);
    else Reflect.deleteProperty(window, 'ezterminalDesktop');
  }, [installed]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const changed = (): void => setMode(media.matches ? 'wide' : 'narrow');
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    const editor = api?.getPanel('project-story-editor');
    if (api && editor) applyProjectReviewLayout(api, editor, mode);
  }, [mode]);

  const onReady = useCallback((event: DockviewReadyEvent): void => {
    apiRef.current = event.api;
    const terminal = event.api.addPanel({
      id: 'project-story-terminal',
      component: 'terminal',
      title: 'PowerShell',
      renderer: 'always',
    });
    const editor = event.api.addPanel({
      id: 'project-story-editor',
      component: 'project-editor',
      title: 'app.ts',
      params: {
        ...fileIdentity.id,
        documentKey: fileIdentity.key,
      },
      renderer: 'onlyWhenVisible',
      position: { referencePanel: terminal.id },
    });
    applyProjectReviewLayout(event.api, editor, mode);
  }, [mode]);

  return (
    <AppI18nProvider>
      <div className="project-workspace-composition" data-testid="project-workspace-composition">
        <aside className="project-workspace-composition__explorer">
          <ProjectWorkspacePanel
            project={project}
            explorerState={{
              expandedPaths: ['__root__', 'src'],
              selectedPath: FILE_PATH,
              query: '',
              searchMode: 'files',
            }}
            onExplorerStateChange={() => undefined}
            onBack={() => undefined}
            onOpenDocument={() => undefined}
            onNewSession={() => undefined}
            onManage={() => undefined}
          />
        </aside>
        <main className="dock-host" data-project-layout={mode} aria-label="Project documents and terminal">
          <DockviewReact
            className="dockview-theme-dark ez-dock"
            components={dockComponents}
            onReady={onReady}
            disableFloatingGroups
          />
        </main>
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Project Workspace',
  component: IntegratedProjectWorkspace,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof IntegratedProjectWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IntegratedWorkspace: Story = {};
