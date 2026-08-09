// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProjectSummary } from '../shared/agent-history';
import type {
  ProjectDocumentDirectoryEntry,
  ProjectDocumentIdentity,
  ProjectWorkspaceDescriptor,
} from '../shared/project-workspace';
import { AppI18nProvider } from './i18n';
import { ProjectWorkspacePanel, type ProjectExplorerState } from './ProjectWorkspacePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: AgentProjectSummary = {
  projectId: 'project-1',
  name: 'Review project',
  primaryRoot: 'C:\\Review',
  additionalRoots: [],
  pinned: true,
  saved: true,
  sessionCount: 0,
  providers: [],
  lastActiveAt: 20,
};

function descriptor(
  access: 'granted' | 'authorization-required' = 'granted',
  external = false,
): ProjectWorkspaceDescriptor {
  return {
    projectId: project.projectId,
    name: project.name,
    roots: [{ rootId: 'root-1', name: 'Review', displayPath: project.primaryRoot, primary: true }],
    workspaces: [{
      workspaceId: external ? 'external-1' : 'main-1',
      rootId: 'root-1',
      name: external ? 'review/external' : 'Review (main)',
      displayPath: external ? 'D:\\External Review' : project.primaryRoot,
      kind: external ? 'external' : 'main',
      access,
      branch: external ? 'review/external' : 'main',
      head: 'a'.repeat(40),
      repositoryId: 'repo-1',
    }],
  };
}

function descriptorWithTwoWorkspaces(): ProjectWorkspaceDescriptor {
  return {
    projectId: project.projectId,
    name: project.name,
    roots: [
      { rootId: 'root-1', name: 'Review', displayPath: project.primaryRoot, primary: true },
      { rootId: 'root-2', name: 'Branch', displayPath: 'D:\\Branch', primary: false },
    ],
    workspaces: [
      {
        workspaceId: 'main-1',
        rootId: 'root-1',
        name: 'Review (main)',
        displayPath: project.primaryRoot,
        kind: 'main',
        access: 'granted',
        branch: 'main',
      },
      {
        workspaceId: 'managed-2',
        rootId: 'root-2',
        name: 'Branch',
        displayPath: 'D:\\Branch',
        kind: 'managed',
        access: 'granted',
        branch: 'feature/workspace',
      },
    ],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function documentIdentity(relativePath: string, workspaceId = 'main-1'): ProjectDocumentIdentity {
  return {
    id: {
      projectId: project.projectId,
      rootId: 'root-1',
      workspaceId,
      relativePath,
    },
    key: [project.projectId, 'root-1', workspaceId, relativePath].join('\0'),
  };
}

const decoratedEntries: readonly ProjectDocumentDirectoryEntry[] = [
  {
    name: 'README.md',
    relativePath: 'README.md',
    kind: 'file',
    size: 20,
    mtimeMs: 1,
    sensitive: false,
    document: documentIdentity('README.md'),
    status: 'modified',
    additions: 4,
    deletions: 2,
  },
  {
    name: 'app.ts',
    relativePath: 'src/app.ts',
    kind: 'file',
    size: 31,
    mtimeMs: 2,
    sensitive: false,
    document: documentIdentity('src/app.ts'),
    status: 'renamed',
    additions: 3,
    deletions: 1,
    previousRelativePath: 'src/old-app.ts',
  },
  {
    name: 'obsolete.ts',
    relativePath: 'src/obsolete.ts',
    kind: 'file',
    size: 0,
    mtimeMs: 0,
    sensitive: false,
    document: {
      id: {
        projectId: 'resolved-project',
        rootId: 'resolved-root',
        workspaceId: 'resolved-workspace',
        relativePath: 'src/obsolete.ts',
      },
      key: 'resolved-document-key',
    },
    status: 'deleted',
    additions: 0,
    deletions: 12,
    virtual: true,
  },
  {
    name: 'legacy.ts',
    relativePath: 'src/legacy.ts',
    kind: 'file',
    size: 0,
    mtimeMs: 0,
    sensitive: false,
    document: documentIdentity('src/legacy.ts'),
    status: 'renamed',
    additions: 0,
    deletions: 0,
    renamedToRelativePath: 'src/current.ts',
    virtual: true,
  },
];

let container: HTMLDivElement;
let root: Root;
let originalDesktop: typeof window.ezterminalDesktop | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  originalDesktop = window.ezterminalDesktop;
  localStorage.clear();
  vi.useRealTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (originalDesktop) {
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: originalDesktop,
    });
  } else {
    Reflect.deleteProperty(window, 'ezterminalDesktop');
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderPanel(
  onOpenDocument = vi.fn(),
  explorerState?: ProjectExplorerState,
  onNewSession = vi.fn(),
): void {
  act(() => {
    root.render(
      <AppI18nProvider>
        <ProjectWorkspacePanel
          project={project}
          onBack={vi.fn()}
          onOpenDocument={onOpenDocument}
          onNewSession={onNewSession}
          onManage={vi.fn()}
          explorerState={explorerState}
        />
      </AppI18nProvider>,
    );
  });
}

function installGrantedDesktop(overrides: Record<string, unknown> = {}) {
  const listProjectDocumentDirectory = vi.fn(async (request: { relativePath: string }) => ({
    ok: true as const,
    directory: documentIdentity(request.relativePath),
    parent: null,
    entries: request.relativePath === '' ? decoratedEntries : [],
    statusRevision: 'a'.repeat(64),
  }));
  Object.defineProperty(window, 'ezterminalDesktop', {
    configurable: true,
    value: {
      describeProjectWorkspace: vi.fn(async () => ({ ok: true as const, project: descriptor() })),
      listProjectDocumentDirectory,
      ...overrides,
    } as unknown as typeof window.ezterminalDesktop,
  });
  return { listProjectDocumentDirectory };
}

function treeRow(name: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
    .find((button) => button.textContent?.includes(name))!;
}

describe('ProjectWorkspacePanel', () => {
  it('opens a new session against the selected opaque workspace identity', async () => {
    installGrantedDesktop();
    const onNewSession = vi.fn();
    renderPanel(vi.fn(), undefined, onNewSession);
    await flush();

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="project-workspace-new-session"]',
    )!.click());

    expect(onNewSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'main-1',
    }, 'C:\\Review');
  });

  it('does not offer a session for a workspace whose approval is still required', async () => {
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace: vi.fn(async () => ({
          ok: true as const,
          project: descriptor('authorization-required', true),
        })),
        listProjectDocumentDirectory: vi.fn(),
      } as unknown as typeof window.ezterminalDesktop,
    });
    renderPanel();
    await flush();

    expect(container.querySelector<HTMLButtonElement>(
      '[data-testid="project-workspace-new-session"]',
    )?.disabled).toBe(true);
  });

  it('shows one decorated project tree immediately and opens virtual paths with one click', async () => {
    const { listProjectDocumentDirectory } = installGrantedDesktop();
    const onOpenDocument = vi.fn();
    renderPanel(onOpenDocument);
    await flush();
    await flush();

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelector('#project-review-source')).toBeNull();
    expect(container.textContent).not.toContain('Sessions');
    expect(listProjectDocumentDirectory).toHaveBeenCalledWith({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'main-1',
      relativePath: '',
    });

    const modified = treeRow('README.md');
    expect(modified.dataset.entryKind).toBe('file');
    expect(modified.querySelector('.file-system-entry-icon')?.getAttribute('data-icon'))
      .toBe('document');
    expect(modified.querySelector('.file-system-entry-icon')?.getAttribute('data-category'))
      .toBe('document');
    expect(modified.querySelector('.project-file-change')?.textContent).toBe('M');
    expect(modified.querySelector('.project-file-change-count')?.textContent).toBe('+4 −2');

    const renamed = treeRow('app.ts');
    expect(renamed.querySelector('.file-system-entry-icon')?.getAttribute('data-icon')).toBe('code');
    expect(renamed.querySelector('.project-file-change')?.textContent).toBe('R');
    expect(renamed.querySelector('.project-file-previous')?.textContent).toContain('src/old-app.ts');

    const deleted = treeRow('obsolete.ts');
    expect(deleted.querySelector('.project-file-change')?.textContent).toBe('D');
    expect(deleted.querySelector('.project-file-change-count')?.textContent).toBe('+0 −12');
    act(() => deleted.click());
    expect(onOpenDocument).toHaveBeenCalledOnce();
    expect(onOpenDocument).toHaveBeenCalledWith({
      projectId: 'resolved-project',
      rootId: 'resolved-root',
      workspaceId: 'resolved-workspace',
      relativePath: 'src/obsolete.ts',
      documentKey: 'resolved-document-key',
    }, undefined);

    expect(treeRow('legacy.ts').querySelector('.project-file-previous')?.textContent)
      .toContain('→ src/current.ts');

    act(() => deleted.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onOpenDocument).toHaveBeenCalledOnce();
  });

  it('discards a stale directory response after switching workspace and root', async () => {
    const staleMain = deferred<{
      readonly ok: true;
      readonly directory: ProjectDocumentIdentity;
      readonly parent: null;
      readonly entries: readonly ProjectDocumentDirectoryEntry[];
    }>();
    const mainEntry: ProjectDocumentDirectoryEntry = {
      name: 'from-main.ts',
      relativePath: 'from-main.ts',
      kind: 'file',
      size: 1,
      mtimeMs: 1,
      sensitive: false,
      document: documentIdentity('from-main.ts'),
    };
    const managedDocument: ProjectDocumentIdentity = {
      id: {
        projectId: project.projectId,
        rootId: 'root-2',
        workspaceId: 'managed-2',
        relativePath: 'from-managed.ts',
      },
      key: 'managed-document',
    };
    const managedEntry: ProjectDocumentDirectoryEntry = {
      name: 'from-managed.ts',
      relativePath: 'from-managed.ts',
      kind: 'file',
      size: 1,
      mtimeMs: 1,
      sensitive: false,
      document: managedDocument,
    };
    const listProjectDocumentDirectory = vi.fn((request: { workspaceId?: string }) => {
      if (request.workspaceId === 'main-1') return staleMain.promise;
      return Promise.resolve({
        ok: true as const,
        directory: { ...managedDocument, id: { ...managedDocument.id, relativePath: '' } },
        parent: null,
        entries: [managedEntry],
      });
    });
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace: vi.fn(async () => ({
          ok: true as const,
          project: descriptorWithTwoWorkspaces(),
        })),
        listProjectDocumentDirectory,
      } as unknown as typeof window.ezterminalDesktop,
    });

    renderPanel();
    await flush();
    const selector = container.querySelector<HTMLSelectElement>('#project-workspace-select')!;
    act(() => {
      selector.value = 'managed-2';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(treeRow('from-managed.ts')).toBeTruthy();

    await act(async () => {
      staleMain.resolve({
        ok: true,
        directory: documentIdentity(''),
        parent: null,
        entries: [mainEntry],
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('from-managed.ts');
    expect(container.textContent).not.toContain('from-main.ts');
  });

  it('reloads every restored expanded directory and preserves successful rows while refreshing', async () => {
    const srcDirectory: ProjectDocumentDirectoryEntry = {
      name: 'src',
      relativePath: 'src',
      kind: 'directory',
      size: 0,
      mtimeMs: 1,
      sensitive: false,
      document: documentIdentity('src'),
    };
    const oldChild: ProjectDocumentDirectoryEntry = {
      name: 'old.ts',
      relativePath: 'src/old.ts',
      kind: 'file',
      size: 1,
      mtimeMs: 1,
      sensitive: false,
      document: documentIdentity('src/old.ts'),
    };
    const newChild: ProjectDocumentDirectoryEntry = {
      name: 'new.ts',
      relativePath: 'src/new.ts',
      kind: 'file',
      size: 2,
      mtimeMs: 2,
      sensitive: false,
      document: documentIdentity('src/new.ts'),
    };
    const refreshRoot = deferred<{
      readonly ok: true;
      readonly directory: ProjectDocumentIdentity;
      readonly parent: null;
      readonly entries: readonly ProjectDocumentDirectoryEntry[];
      readonly statusError: 'git-failed';
    }>();
    const refreshSrc = deferred<{
      readonly ok: true;
      readonly directory: ProjectDocumentIdentity;
      readonly parent: string;
      readonly entries: readonly ProjectDocumentDirectoryEntry[];
    }>();
    let phase: 'initial' | 'refresh' | 'failure' = 'initial';
    const listProjectDocumentDirectory = vi.fn((request: { relativePath: string }) => {
      if (phase === 'refresh') {
        return request.relativePath === '' ? refreshRoot.promise : refreshSrc.promise;
      }
      if (phase === 'failure') {
        return Promise.resolve({ ok: false as const, error: 'io-error' as const });
      }
      return Promise.resolve({
        ok: true as const,
        directory: documentIdentity(request.relativePath),
        parent: request.relativePath ? '' : null,
        entries: request.relativePath === '' ? [srcDirectory] : [oldChild],
      });
    });
    installGrantedDesktop({ listProjectDocumentDirectory });
    renderPanel(vi.fn(), {
      expandedPaths: ['__root__', 'src'],
      selectedPath: null,
      query: '',
      searchMode: 'files',
    });
    await flush();
    await flush();

    expect(listProjectDocumentDirectory).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: '',
    }));
    expect(listProjectDocumentDirectory).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'src',
    }));
    expect(treeRow('old.ts')).toBeTruthy();
    expect(treeRow('src').dataset.expanded).toBe('true');
    expect(treeRow('src').querySelector('.file-system-entry-icon')?.getAttribute('data-icon'))
      .toBe('folder-open');
    expect(treeRow('old.ts').style.getPropertyValue('--project-tree-depth')).toBe('1');

    phase = 'refresh';
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    act(() => refresh.click());

    expect(container.querySelector('[role="tree"]')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(treeRow('old.ts')).toBeTruthy();
    expect(listProjectDocumentDirectory.mock.calls.filter(([request]) => (
      request as { relativePath: string }
    ).relativePath === '')).toHaveLength(2);
    expect(listProjectDocumentDirectory.mock.calls.filter(([request]) => (
      request as { relativePath: string }
    ).relativePath === 'src')).toHaveLength(2);

    await act(async () => {
      refreshRoot.resolve({
        ok: true,
        directory: documentIdentity(''),
        parent: null,
        entries: [{ ...newChild, relativePath: 'replacement.ts' }],
        statusError: 'git-failed',
      });
      await Promise.resolve();
    });
    expect(treeRow('old.ts')).toBeTruthy();
    expect(container.textContent).not.toContain('replacement.ts');
    expect(container.querySelector('.project-view-notice')?.textContent).toContain('git-failed');

    await act(async () => {
      refreshSrc.resolve({
        ok: true,
        directory: documentIdentity('src'),
        parent: '',
        entries: [newChild],
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('new.ts');
    expect(container.textContent).not.toContain('old.ts');
    expect(container.querySelector('[role="tree"]')?.getAttribute('aria-busy')).toBeNull();

    phase = 'failure';
    act(() => refresh.click());
    await flush();
    expect(container.textContent).toContain('new.ts');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('io-error');
  });

  it('forwards a content search result path, line, and column to the document opener', async () => {
    vi.useFakeTimers();
    const searchProjectWorkspace = vi.fn(async () => ({
      ok: true as const,
      matches: [{
        rootId: 'root-1',
        relativePath: 'README.md',
        line: 17,
        column: 5,
        preview: 'matching text',
        sensitive: false,
      }],
      truncated: false,
      scannedFiles: 1,
      scannedBytes: 20,
    }));
    installGrantedDesktop({
      searchProjectWorkspace,
      cancelProjectWorkspaceSearch: vi.fn(),
    });
    const onOpenDocument = vi.fn();
    renderPanel(onOpenDocument, {
      expandedPaths: ['__root__'],
      selectedPath: null,
      query: 'matching',
      searchMode: 'content',
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await flush();

    expect(searchProjectWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'main-1',
      query: 'matching',
      mode: 'content',
    }));
    const result = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((button) => button.textContent?.includes('README.md'))!;
    act(() => result.click());
    expect(onOpenDocument).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'main-1',
      relativePath: 'README.md',
    }, { line: 17, column: 5 });
  });

  it('discards stale search matches after switching workspace and root', async () => {
    vi.useFakeTimers();
    const staleMain = deferred<{
      readonly ok: true;
      readonly matches: readonly [{
        readonly rootId: 'root-1';
        readonly relativePath: 'from-main.ts';
        readonly sensitive: false;
      }];
      readonly truncated: false;
      readonly scannedFiles: 1;
      readonly scannedBytes: 1;
    }>();
    const managed = deferred<{
      readonly ok: true;
      readonly matches: readonly [{
        readonly rootId: 'root-2';
        readonly relativePath: 'from-managed.ts';
        readonly sensitive: false;
      }];
      readonly truncated: false;
      readonly scannedFiles: 1;
      readonly scannedBytes: 1;
    }>();
    const searchProjectWorkspace = vi.fn((request: { workspaceId?: string }) => (
      request.workspaceId === 'main-1' ? staleMain.promise : managed.promise
    ));
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace: vi.fn(async () => ({
          ok: true as const,
          project: descriptorWithTwoWorkspaces(),
        })),
        listProjectDocumentDirectory: vi.fn(async (request: { relativePath: string }) => ({
          ok: true as const,
          directory: documentIdentity(request.relativePath),
          parent: null,
          entries: [],
        })),
        searchProjectWorkspace,
        cancelProjectWorkspaceSearch: vi.fn(),
      } as unknown as typeof window.ezterminalDesktop,
    });
    renderPanel(vi.fn(), {
      expandedPaths: ['__root__'],
      selectedPath: null,
      query: 'needle',
      searchMode: 'files',
    });
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(searchProjectWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'main-1',
    }));

    const selector = container.querySelector<HTMLSelectElement>('#project-workspace-select')!;
    act(() => {
      selector.value = 'managed-2';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(searchProjectWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      rootId: 'root-2',
      workspaceId: 'managed-2',
    }));

    await act(async () => {
      managed.resolve({
        ok: true,
        matches: [{ rootId: 'root-2', relativePath: 'from-managed.ts', sensitive: false }],
        truncated: false,
        scannedFiles: 1,
        scannedBytes: 1,
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('from-managed.ts');

    await act(async () => {
      staleMain.resolve({
        ok: true,
        matches: [{ rootId: 'root-1', relativePath: 'from-main.ts', sensitive: false }],
        truncated: false,
        scannedFiles: 1,
        scannedBytes: 1,
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('from-managed.ts');
    expect(container.textContent).not.toContain('from-main.ts');
  });

  it('shows the exact external worktree identity before granting persisted read-only access', async () => {
    let granted = false;
    const describeProjectWorkspace = vi.fn(async () => ({
      ok: true as const,
      project: descriptor(granted ? 'granted' : 'authorization-required', true),
    }));
    const approveProjectWorkspace = vi.fn(async () => {
      granted = true;
      return {
        ok: true as const,
        workspace: descriptor('granted', true).workspaces![0]!,
      };
    });
    const listProjectDocumentDirectory = vi.fn(async () => ({
      ok: true as const,
      directory: documentIdentity('', 'external-1'),
      parent: null,
      entries: [],
    }));
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace,
        approveProjectWorkspace,
        listProjectDocumentDirectory,
      } as unknown as typeof window.ezterminalDesktop,
    });
    renderPanel();
    await flush();

    const reviewAccess = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Review access')!;
    act(() => reviewAccess.click());
    expect(document.body.querySelector('[data-testid="project-workspace-approval"]')?.textContent)
      .toContain('D:\\External Review');
    const approve = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Approve read-only access')!;
    act(() => approve.click());
    await flush();
    await flush();

    expect(approveProjectWorkspace).toHaveBeenCalledWith({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'external-1',
    });
    expect(describeProjectWorkspace).toHaveBeenCalledTimes(2);
    expect(listProjectDocumentDirectory).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'external-1',
      relativePath: '',
    }));
  });
});
