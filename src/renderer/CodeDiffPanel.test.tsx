// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelProps } from 'dockview-react';

import type { ProjectReviewTextView } from '../shared/project-workspace';
import { CodeDiffPanel } from './CodeDiffPanel';
import { AppI18nProvider } from './i18n';

const monacoMocks = vi.hoisted(() => {
  const addZone = vi.fn((zone: unknown) => {
    void zone;
    return 'recorded-zone';
  });
  const createCodeEditor = vi.fn(() => ({
    changeViewZones: vi.fn((callback: (accessor: { addZone: typeof addZone }) => void) => callback({ addZone })),
    dispose: vi.fn(),
    layout: vi.fn(),
    revealLineInCenter: vi.fn(),
  }));
  const createDiffEditor = vi.fn(() => ({
    dispose: vi.fn(),
    layout: vi.fn(),
    setModel: vi.fn(),
    updateOptions: vi.fn(),
  }));
  const createModel = vi.fn(() => ({ dispose: vi.fn() }));
  return { addZone, createCodeEditor, createDiffEditor, createModel };
});

vi.mock('./monaco-runtime', () => ({
  monaco: {
    Uri: { from: vi.fn((value: unknown) => value) },
    editor: {
      create: monacoMocks.createCodeEditor,
      createModel: monacoMocks.createModel,
      createDiffEditor: monacoMocks.createDiffEditor,
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

let container: HTMLDivElement;
let root: Root;
let desktopDescriptor: PropertyDescriptor | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function dockProps(scope: 'working-tree' | 'last-turn' = 'working-tree'): IDockviewPanelProps {
  return {
    api: {
      id: 'working-tree-diff',
      width: 1000,
      onDidDimensionsChange: vi.fn(() => ({ dispose: vi.fn() })),
      setTitle: vi.fn(),
      updateParameters: vi.fn(),
    },
    params: {
      projectId: 'project-1',
      rootId: 'root-1',
      repositoryRelativePath: 'out/manual-test-project',
      scope,
      ...(scope === 'last-turn' ? { historyId: 'history-1', reviewTurnId: 'turn-1' } : {}),
    },
  } as unknown as IDockviewPanelProps;
}

function installReview(
  view: ProjectReviewTextView,
  scope: 'working-tree' | 'last-turn',
): ReturnType<typeof vi.fn> {
  const getProjectReviewFile = vi.fn(async () => ({
    ok: true as const,
    relativePath: 'src/app.ts',
    originalPath: 'src/app.ts',
    modifiedPath: 'src/app.ts',
    language: 'typescript',
    binary: false as const,
    view,
    sensitive: false,
  }));
  Object.defineProperty(window, 'ezterminalDesktop', {
    configurable: true,
    value: {
      getProjectReview: vi.fn(async () => ({
        ok: true as const,
        scope,
        source: scope === 'last-turn' ? 'claude' as const : 'git' as const,
        title: scope === 'last-turn' ? 'Last completed turn' : 'Working tree',
        repositoryName: 'manual-test-project',
        revision: 'a'.repeat(64),
        changes: [{
          relativePath: 'src/app.ts',
          kind: 'modified' as const,
          additions: 1,
          deletions: 1,
          binary: false,
        }],
      })),
      getProjectReviewFile,
    } as unknown as typeof window.ezterminalDesktop,
  });
  return getProjectReviewFile;
}

async function renderPanel(scope: 'working-tree' | 'last-turn'): Promise<void> {
  await act(async () => {
    root.render(
      <AppI18nProvider>
        <CodeDiffPanel {...dockProps(scope)} />
      </AppI18nProvider>,
    );
  });
  await flush();
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  desktopDescriptor = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (desktopDescriptor) Object.defineProperty(window, 'ezterminalDesktop', desktopDescriptor);
  else Reflect.deleteProperty(window, 'ezterminalDesktop');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CodeDiffPanel single-surface review', () => {
  it('shows a complete Working tree diff without a second file-open action', async () => {
    const getProjectReviewFile = installReview({
      kind: 'full-diff',
      coverage: 'full-file',
      original: 'header\nconst value = 1;\nfooter\n',
      modified: 'header\nconst value = 2;\nfooter\n',
    }, 'working-tree');
    await renderPanel('working-tree');

    expect(getProjectReviewFile).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="open-current-project-file"]')).toBeNull();
    expect(monacoMocks.createDiffEditor).toHaveBeenCalledOnce();
    expect(container.querySelector('.diff-panel__current-context-status')).toBeNull();
  });

  it('labels a strictly rehydrated Last turn model as current context', async () => {
    installReview({
      kind: 'full-diff',
      coverage: 'current-context',
      original: 'header\nconst value = 1;\nfooter\n',
      modified: 'header\nconst value = 2;\nfooter\n',
    }, 'last-turn');
    await renderPanel('last-turn');

    expect(container.querySelector('.diff-panel__current-context-status')).not.toBeNull();
    expect(container.querySelector('.diff-panel__selected-turn-status')).not.toBeNull();
    expect(container.querySelector('[data-testid="open-current-project-file"]')).toBeNull();
  });

  it('places an exact provider record inside the complete current file', async () => {
    const current = 'header\nconst value = 2;\nfooter\n';
    installReview({
      kind: 'current-with-record',
      current,
      sections: [{
        anchorLine: 2,
        lines: [
          { kind: 'removed', text: 'const value = 1;' },
          { kind: 'added', text: 'const value = 2;' },
        ],
      }],
    }, 'last-turn');
    await renderPanel('last-turn');

    expect(container.querySelector('.diff-panel__current-record-status')).not.toBeNull();
    expect(monacoMocks.createCodeEditor).toHaveBeenCalledOnce();
    expect(monacoMocks.createModel).toHaveBeenCalledWith(current, 'typescript', expect.anything());
    expect(monacoMocks.addZone).toHaveBeenCalledOnce();
    const zone = monacoMocks.addZone.mock.calls[0]?.[0] as { afterLineNumber: number; domNode: HTMLElement };
    expect(zone.afterLineNumber).toBe(1);
    expect(zone.domNode.textContent).toContain('const value = 1;');
    expect(zone.domNode.textContent).toContain('const value = 2;');
  });

  it('shows the recorded change directly when the current file is unavailable', async () => {
    installReview({
      kind: 'record-only',
      sections: [{
        lines: [{ kind: 'added', text: 'export const created = true;' }],
      }],
    }, 'last-turn');
    await renderPanel('last-turn');

    expect(container.querySelector('.diff-panel__record-only-status')).not.toBeNull();
    expect(container.querySelector('.diff-panel__record-only')?.textContent).toContain('export const created = true;');
    expect(monacoMocks.createCodeEditor).not.toHaveBeenCalled();
    expect(monacoMocks.createDiffEditor).not.toHaveBeenCalled();
  });
});
