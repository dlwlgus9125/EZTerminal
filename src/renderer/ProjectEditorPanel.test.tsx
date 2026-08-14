// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelProps } from 'dockview-react';

import type {
  ProjectDocumentLens,
  ProjectDocumentSnapshot,
  ProjectReviewTextView,
} from '../shared/project-workspace';
import { AppI18nProvider } from './i18n';
import { ProjectEditorPanel } from './ProjectEditorPanel';
import { requestProjectCodeFocus } from './project-code-navigation';
import type { ProjectEditorDocument } from './project-editor-model';

const monacoMocks = vi.hoisted(() => {
  const addZone = vi.fn(() => 'recorded-zone');
  const model = () => ({
    dispose: vi.fn(),
    getLineCount: vi.fn(() => 3),
    getLineMaxColumn: vi.fn(() => 80),
  });
  const codeEditor = () => ({
    changeViewZones: vi.fn((callback: (accessor: { addZone: typeof addZone }) => void) => callback({ addZone })),
    dispose: vi.fn(),
    focus: vi.fn(),
    getAction: vi.fn(() => ({ run: vi.fn() })),
    getModel: vi.fn(model),
    layout: vi.fn(),
    onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    revealPositionInCenter: vi.fn(),
    restoreViewState: vi.fn(),
    saveViewState: vi.fn(() => ({ cursorState: [], viewState: {} })),
    setPosition: vi.fn(),
    updateOptions: vi.fn(),
  });
  const createCodeEditor = vi.fn(codeEditor);
  const createDiffEditor = vi.fn(() => {
    const modified = codeEditor();
    const original = codeEditor();
    return {
      dispose: vi.fn(),
      getModifiedEditor: vi.fn(() => modified),
      getOriginalEditor: vi.fn(() => original),
      goToDiff: vi.fn(),
      layout: vi.fn(),
      restoreViewState: vi.fn(),
      saveViewState: vi.fn(() => ({ original: {}, modified: {} })),
      setModel: vi.fn(),
    };
  });
  const createModel = vi.fn(model);
  return { addZone, createCodeEditor, createDiffEditor, createModel };
});

vi.mock('./monaco-runtime', () => ({
  monaco: {
    Uri: { from: vi.fn((value: unknown) => value) },
    editor: {
      create: monacoMocks.createCodeEditor,
      createDiffEditor: monacoMocks.createDiffEditor,
      createModel: monacoMocks.createModel,
      setTheme: vi.fn(),
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): ResizeObserverEntry[] { return []; }
  unobserve(): void {}
}

const identity = {
  id: {
    projectId: 'project-1',
    rootId: 'root-1',
    workspaceId: 'workspace-1',
    relativePath: 'src/app.ts',
  },
  key: 'project-1\0root-1\0workspace-1\0src/app.ts',
} as const;

const currentFile = {
  relativePath: 'src/app.ts',
  content: 'header\nconst value = 2;\nfooter\n',
  version: 'current-version',
  byteLength: 39,
  language: 'typescript',
  sensitive: false,
} as const;

const currentLens = { kind: 'current' } as const;
const agentLens = {
  kind: 'agent-turn',
  historyId: 'history-1',
  turnId: 'turn-1',
} as const;

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

function dockProps(document: ProjectEditorDocument): {
  readonly props: IDockviewPanelProps;
  readonly updateParameters: ReturnType<typeof vi.fn>;
} {
  const updateParameters = vi.fn();
  return {
    props: {
      api: {
        id: 'project-file-editor',
        onDidParametersChange: vi.fn(() => ({ dispose: vi.fn() })),
        setTitle: vi.fn(),
        updateParameters,
      },
      params: document,
    } as unknown as IDockviewPanelProps,
    updateParameters,
  };
}

function comparison(
  lens: ProjectDocumentLens,
  view: ProjectReviewTextView,
): NonNullable<ProjectDocumentSnapshot['comparison']> {
  return {
    lens,
    source: lens.kind === 'agent-turn' ? 'codex' : 'git',
    title: lens.kind === 'agent-turn' ? 'Agent turn' : 'Current changes',
    language: 'typescript',
    revision: 'a'.repeat(64),
    change: {
      relativePath: identity.id.relativePath,
      kind: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
    },
    originalPath: identity.id.relativePath,
    modifiedPath: identity.id.relativePath,
    view,
  };
}

function snapshot(
  overrides: Partial<ProjectDocumentSnapshot> = {},
): ProjectDocumentSnapshot {
  return {
    document: identity,
    lens: currentLens,
    current: currentFile,
    state: 'text',
    revision: currentFile.version,
    ...overrides,
  };
}

function installDesktop(documentSnapshot: ProjectDocumentSnapshot) {
  const readProjectDocument = vi.fn(async () => ({
    ok: true as const,
    snapshot: documentSnapshot,
  }));
  Object.defineProperty(window, 'ezterminalDesktop', {
    configurable: true,
    value: { readProjectDocument } as unknown as typeof window.ezterminalDesktop,
  });
  return { readProjectDocument };
}

async function renderPanel(document: ProjectEditorDocument): Promise<ReturnType<typeof dockProps>> {
  const dock = dockProps(document);
  await act(async () => {
    root.render(
      <AppI18nProvider>
        <ProjectEditorPanel {...dock.props} />
      </AppI18nProvider>,
    );
  });
  await flush();
  await flush();
  await flush();
  return dock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  originalDesktop = window.ezterminalDesktop;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (originalDesktop) {
    Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: originalDesktop });
  } else {
    Reflect.deleteProperty(window, 'ezterminalDesktop');
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProjectEditorPanel document snapshots', () => {
  const pathDocument = {
    ...identity.id,
    documentKey: identity.key,
  } as const;

  it('renders the full current file and its current changes as one inline document', async () => {
    const desktop = installDesktop(snapshot({
      comparison: comparison(currentLens, {
        kind: 'full-diff',
        coverage: 'full-file',
        original: 'header\nconst value = 1;\nfooter\n',
        modified: currentFile.content,
      }),
    }));
    await renderPanel(pathDocument);

    expect(desktop.readProjectDocument).toHaveBeenCalledWith({
      document: identity.id,
      lens: currentLens,
    });
    expect(container.querySelector('[data-testid="project-editor-panel"]')).toMatchObject({
      dataset: {
        path: 'src/app.ts',
        documentKey: identity.key,
        comparison: 'current',
        documentState: 'text',
      },
    });
    expect(monacoMocks.createDiffEditor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      renderSideBySide: false,
      hideUnchangedRegions: { enabled: false },
      readOnly: true,
    }));
    expect(monacoMocks.createModel).toHaveBeenCalledWith(currentFile.content, 'typescript', expect.anything());
    expect(container.textContent).not.toContain('Add lines');
    expect(container.textContent).not.toContain('Add with snippet');
    expect(container.textContent).not.toContain('Ask about code');
  });

  it('hands a canonical focus request to the mounted inline Monaco editor', async () => {
    installDesktop(snapshot({
      comparison: comparison(currentLens, {
        kind: 'full-diff',
        coverage: 'full-file',
        original: 'header\nconst value = 1;\nfooter\n',
        modified: currentFile.content,
      }),
    }));
    await renderPanel(pathDocument);

    requestProjectCodeFocus(pathDocument);
    const diffEditor = monacoMocks.createDiffEditor.mock.results[0]?.value;

    expect(diffEditor?.getModifiedEditor().focus).toHaveBeenCalledOnce();
  });

  it('uses an Agent-turn lens without changing identity and closes it back to current', async () => {
    installDesktop(snapshot({
      lens: agentLens,
      comparison: comparison(agentLens, {
        kind: 'current-with-record',
        current: currentFile.content,
        sections: [{
          anchorLine: 2,
          lines: [
            { kind: 'removed', text: 'const value = 1;' },
            { kind: 'added', text: 'const value = 2;' },
          ],
        }],
      }),
    }));
    const dock = await renderPanel({ ...pathDocument, lens: agentLens });

    expect(container.querySelector('[data-testid="project-editor-panel"]')).toMatchObject({
      dataset: {
        documentKey: identity.key,
        comparison: 'agent-turn',
        documentState: 'text',
      },
    });
    expect(monacoMocks.createCodeEditor).toHaveBeenCalledOnce();
    expect(monacoMocks.addZone).toHaveBeenCalledOnce();

    const closeLens = container.querySelector<HTMLButtonElement>(
      '.project-editor__source--dismissible',
    );
    expect(closeLens?.textContent).toContain('Agent turn');
    act(() => closeLens?.click());
    expect(dock.updateParameters).toHaveBeenCalledOnce();
    expect(dock.updateParameters).toHaveBeenCalledWith({
      ...pathDocument,
      lens: currentLens,
    });
  });

  it('keeps the current file readable when an Agent comparison is unavailable', async () => {
    installDesktop(snapshot({
      lens: agentLens,
      comparisonError: 'not-found',
    }));
    await renderPanel({ ...pathDocument, lens: agentLens });

    expect(monacoMocks.createCodeEditor).toHaveBeenCalledOnce();
    expect(monacoMocks.createDiffEditor).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="project-editor-panel"]')).toMatchObject({
      dataset: { comparison: 'agent-turn', documentState: 'text' },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('not-found');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows an Agent record-only snapshot in the same path panel', async () => {
    installDesktop(snapshot({
      lens: agentLens,
      current: null,
      state: 'record-only',
      revision: 'record-revision',
      comparison: comparison(agentLens, {
        kind: 'record-only',
        sections: [{ lines: [{ kind: 'added', text: 'export const created = true;' }] }],
      }),
    }));
    await renderPanel({ ...pathDocument, lens: agentLens });

    expect(container.querySelector('[data-testid="project-editor-panel"]')).toMatchObject({
      dataset: { path: 'src/app.ts', documentState: 'record-only' },
    });
    expect(container.querySelector('.project-editor__record-only')?.textContent)
      .toContain('export const created = true;');
    expect(monacoMocks.createCodeEditor).not.toHaveBeenCalled();
    expect(monacoMocks.createDiffEditor).not.toHaveBeenCalled();
  });

  it('renders a deleted path as a full inline deletion without inventing current text', async () => {
    const deletedView = {
      kind: 'full-diff',
      coverage: 'full-file',
      original: 'export const removed = true;\n',
      modified: '',
    } as const;
    installDesktop(snapshot({
      current: null,
      state: 'deleted',
      revision: 'deleted-revision',
      comparison: {
        ...comparison(currentLens, deletedView),
        change: {
          relativePath: identity.id.relativePath,
          kind: 'deleted',
          additions: 0,
          deletions: 1,
          binary: false,
        },
      },
    }));
    await renderPanel(pathDocument);

    expect(container.querySelector('[data-testid="project-editor-panel"]')).toMatchObject({
      dataset: { path: 'src/app.ts', documentState: 'deleted', comparison: 'current' },
    });
    expect(monacoMocks.createDiffEditor).toHaveBeenCalledOnce();
    expect(monacoMocks.createModel).toHaveBeenCalledWith('', 'typescript', expect.anything());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
