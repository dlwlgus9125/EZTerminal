// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from './i18n';
import { ProjectExplorerPanel } from './ProjectExplorerPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let ezterminalDescriptor: PropertyDescriptor | undefined;
let desktopDescriptor: PropertyDescriptor | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  ezterminalDescriptor = Object.getOwnPropertyDescriptor(window, 'ezterminal');
  desktopDescriptor = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (ezterminalDescriptor) Object.defineProperty(window, 'ezterminal', ezterminalDescriptor);
  else Reflect.deleteProperty(window, 'ezterminal');
  if (desktopDescriptor) Object.defineProperty(window, 'ezterminalDesktop', desktopDescriptor);
  else Reflect.deleteProperty(window, 'ezterminalDesktop');
  vi.restoreAllMocks();
});

describe('ProjectExplorerPanel', () => {
  it('loads a registered root and opens files through the project descriptor', async () => {
    const onOpenFile = vi.fn();
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        listAgentProjects: vi.fn(async () => ({
          items: [{
            projectId: 'project-1',
            name: 'Project One',
            primaryRoot: 'C:\\Project',
            additionalRoots: [],
            pinned: true,
            saved: true,
            sessionCount: 0,
            providers: [],
            lastActiveAt: null,
          }],
          nextCursor: null,
        })),
      } as unknown as typeof window.ezterminal,
    });
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace: vi.fn(async () => ({
          ok: true as const,
          project: {
            projectId: 'project-1',
            name: 'Project One',
            roots: [{ rootId: 'root-1', name: 'Project', displayPath: 'C:\\Project', primary: true }],
          },
        })),
        listProjectDirectory: vi.fn(async () => ({
          ok: true as const,
          relativePath: '',
          parent: null,
          entries: [{
            name: 'app.ts',
            relativePath: 'src/app.ts',
            kind: 'file' as const,
            size: 12,
            mtimeMs: 0,
            sensitive: false,
          }],
        })),
        cancelProjectWorkspaceSearch: vi.fn(),
      } as unknown as typeof window.ezterminalDesktop,
    });

    act(() => {
      root.render(
        <StrictMode>
          <AppI18nProvider>
            <ProjectExplorerPanel onOpenFile={onOpenFile} onOpenReview={vi.fn()} />
          </AppI18nProvider>
        </StrictMode>,
      );
    });
    await flush();
    await flush();
    const file = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('app.ts'));
    expect(file).toBeDefined();
    act(() => file!.click());
    expect(onOpenFile).toHaveBeenCalledWith('project-1', 'root-1', 'src/app.ts');
    expect(localStorage.getItem('ezterminal.project-workbench.selected-project')).toBe('project-1');
  });
});
