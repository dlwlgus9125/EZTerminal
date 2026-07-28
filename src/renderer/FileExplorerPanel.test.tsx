// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../shared/ipc';
import type { FileEntry, FileListResult } from '../shared/files';
import { EMPTY_GIT_DIRECTORY_STATUS } from '../shared/git-status';
import { quoteEzArgument } from '../shared/quote-ez-argument';
import { createCapabilityAccess, type CapabilityAccess } from './capability-access';
import { FileExplorerPanel } from './FileExplorerPanel';
import { registerPaneInput, unregisterPaneInput } from './pane-registry';
import { ToastProvider } from './ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let listFiles: ReturnType<typeof vi.fn>;
let listFileRoots: ReturnType<typeof vi.fn>;
let readFilePreview: ReturnType<typeof vi.fn>;
let openFileInApp: ReturnType<typeof vi.fn>;
let revealFileInExplorer: ReturnType<typeof vi.fn>;
let clipboardWrite: ReturnType<typeof vi.fn>;
let onOpenTerminalAt: ReturnType<typeof vi.fn>;
let gitStatus: ReturnType<typeof vi.fn>;
let capabilities: CapabilityAccess;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function listing(entries: readonly FileEntry[], path = 'C:\\workspace', parent: string | null = 'C:\\'): FileListResult {
  return {
    ok: true,
    path,
    parent,
    entries,
  };
}

function file(name: string, size = 12): FileEntry {
  return { name, kind: 'file', isSymlink: false, size, mtimeMs: 0 };
}

function press(target: EventTarget, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      shiftKey,
    }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openContextMenu(row: HTMLButtonElement): void {
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    }));
  });
}

async function renderPanel(activePanelId: string | null = null): Promise<void> {
  act(() => {
    root.render(
      // The panel reports file operations through the shared toast system, so
      // it mounts under the provider here exactly as it does in the app.
      <ToastProvider>
        <FileExplorerPanel
          activePanelId={activePanelId}
          onOpenTerminalAt={onOpenTerminalAt}
          capabilities={capabilities}
        />
      </ToastProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  clipboardWrite = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', Object.assign(Object.create(window.navigator), {
    clipboard: { writeText: clipboardWrite },
  }));
  listFiles = vi.fn(async () => listing([
    { name: 'subdir', kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: 0 },
  ]));
  listFileRoots = vi.fn(async () => ['C:\\']);
  readFilePreview = vi.fn();
  openFileInApp = vi.fn(async () => undefined);
  revealFileInExplorer = vi.fn(async () => undefined);
  onOpenTerminalAt = vi.fn();
  gitStatus = vi.fn(async () => EMPTY_GIT_DIRECTORY_STATUS);
  const core = {
    getGitStatus: gitStatus,
    listFiles,
    listFileRoots,
    readFilePreview,
    createFolder: vi.fn(),
    renameFile: vi.fn(),
    trashFile: vi.fn(),
    openFileInApp,
    revealFileInExplorer,
  } as unknown as EzTerminalApi;
  capabilities = createCapabilityAccess({
    readCore: () => core,
    readDesktop: () => undefined,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unregisterPaneInput('panel-1');
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FileExplorerPanel file row accessibility', () => {
  it('renders each actionable row as a native button and opens it with Enter and Space', async () => {
    await renderPanel();
    let row = container.querySelector<HTMLButtonElement>('[data-testid="file-entry"]')!;

    expect(row.tagName).toBe('BUTTON');
    expect(row.type).toBe('button');
    row.focus();
    press(row, 'Enter');
    await flush();
    expect(listFiles).toHaveBeenCalledTimes(2);

    row = container.querySelector<HTMLButtonElement>('[data-testid="file-entry"]')!;
    row.focus();
    press(row, ' ');
    await flush();
    expect(listFiles).toHaveBeenCalledTimes(3);
  });

  it('opens the row menu with Shift+F10 and the Context Menu key, then restores row focus', async () => {
    await renderPanel();
    const row = container.querySelector<HTMLButtonElement>('[data-testid="file-entry"]')!;
    row.focus();

    press(row, 'F10', true);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    press(document.activeElement!, 'Escape');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(row);

    press(row, 'ContextMenu');
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe('FileExplorerPanel navigation and previews', () => {
  it('navigates to the reported parent directory', async () => {
    await renderPanel();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="file-up"]')!.click());
    await flush();

    expect(listFiles).toHaveBeenLastCalledWith('C:\\');
  });

  it('keeps a UNC share root intact when navigating with breadcrumbs', async () => {
    listFiles.mockResolvedValue(listing(
      [{ name: 'child', kind: 'dir', isSymlink: false, size: 0, mtimeMs: 0 }],
      '\\\\server\\share\\folder',
      '\\\\server\\share\\',
    ));
    await renderPanel();

    const shareRoot = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="file-breadcrumb-segment"]'),
    ).find((segment) => segment.textContent?.includes('share'));
    expect(shareRoot).toBeDefined();
    act(() => shareRoot!.click());
    await flush();

    expect(listFiles).toHaveBeenLastCalledWith('\\\\server\\share\\');
  });

  it('renders unsupported binary and truncated text preview states', async () => {
    listFiles.mockResolvedValue(listing([
      file('archive.bin', 1024),
      file('large.txt', 1_048_577),
    ]));
    readFilePreview.mockImplementation(async (path: string) => path.endsWith('archive.bin')
      ? {
        ok: true as const,
        kind: 'unsupported' as const,
        name: 'archive.bin',
        fileSize: 1024,
        reason: 'binary' as const,
      }
      : {
        ok: true as const,
        kind: 'text' as const,
        name: 'large.txt',
        mime: 'text/plain' as const,
        content: 'bounded preview',
        truncated: true,
        fileSize: 1_048_577,
      });
    await renderPanel();
    const rows = container.querySelectorAll<HTMLButtonElement>('[data-testid="file-entry"]');

    act(() => rows[0]!.click());
    await flush();
    expect(document.body.querySelector('[data-testid="file-viewer-overlay"]')).not.toBeNull();
    expect(document.body.querySelector('.file-preview-state')?.textContent).toContain('binary');

    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="viewer-close"]')!.click());
    act(() => rows[1]!.click());
    await flush();
    expect(document.body.querySelector('[data-testid="viewer-truncated"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="viewer-content"]')?.textContent).toBe('bounded preview');
  });
});

describe('FileExplorerPanel context actions', () => {
  it('offers the complete file action set and routes copy/paste through the owned seams', async () => {
    listFiles.mockResolvedValue(listing([file('my file.txt')]));
    const insertText = vi.fn();
    registerPaneInput('panel-1', insertText);
    await renderPanel('panel-1');
    const row = container.querySelector<HTMLButtonElement>('[data-testid="file-entry"]')!;

    openContextMenu(row);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .map((item) => item.dataset.testid),
    ).toEqual([
      'ctx-copy-path',
      'ctx-copy-name',
      'ctx-paste-path',
      'ctx-open-app',
      'ctx-reveal',
      'ctx-rename',
      'ctx-delete',
    ]);

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="ctx-copy-path"]')!.click());
    await flush();
    const fullPath = 'C:\\workspace\\my file.txt';
    expect(clipboardWrite).toHaveBeenCalledWith(fullPath);

    openContextMenu(row);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="ctx-paste-path"]')!.click());
    expect(insertText).toHaveBeenCalledWith(quoteEzArgument(fullPath));
  });

  it('tags listed files with what Git says changed about them', async () => {
    listFiles.mockResolvedValue(listing([file('changed.ts'), file('fresh.ts'), file('quiet.ts')]));
    gitStatus.mockResolvedValue({
      availability: 'ready',
      tracked: true,
      branch: 'main',
      truncated: false,
      changes: [
        { path: 'changed.ts', kind: 'modified', added: 18, removed: 6 },
        { path: 'fresh.ts', kind: 'untracked' },
        // A change one level down must not tag a sibling in this folder.
        { path: 'nested/other.ts', kind: 'modified', added: 1, removed: 1 },
      ],
    });
    await renderPanel();

    const tags = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="file-entry-change"]'));
    expect(tags.map((tag) => tag.textContent)).toEqual(['+18 \u22126', 'new']);
    expect(tags[1]?.dataset.kind).toBe('untracked');
  });

  it('does not carry a previous folder Git badge into a newly listed folder', async () => {
    const nextStatus = deferred<typeof EMPTY_GIT_DIRECTORY_STATUS>();
    listFiles.mockImplementation(async (path: string) => path === 'C:\\workspace\\other'
      ? listing([file('same.ts')], 'C:\\workspace\\other', 'C:\\workspace')
      : listing([
        { name: 'other', kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: 0 },
        file('same.ts'),
      ]));
    gitStatus.mockImplementation((path: string) => path === 'C:\\workspace\\other'
      ? nextStatus.promise
      : Promise.resolve({
        availability: 'ready' as const,
        tracked: true,
        branch: 'main',
        truncated: false,
        changes: [{ path: 'same.ts', kind: 'modified' as const, added: 4, removed: 1 }],
      }));
    await renderPanel();
    expect(container.querySelector('[data-testid="file-entry-change"]')?.textContent)
      .toBe('+4 \u22121');

    const destination = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="file-entry"]'),
    ).find((entry) => entry.textContent?.includes('other'));
    expect(destination).toBeDefined();
    act(() => destination!.click());
    await flush();

    expect(listFiles).toHaveBeenLastCalledWith('C:\\workspace\\other');
    expect(container.querySelector('[data-testid="file-entry"]')?.textContent).toContain('same.ts');
    expect(container.querySelector('[data-testid="file-entry-change"]')).toBeNull();

    nextStatus.resolve(EMPTY_GIT_DIRECTORY_STATUS);
    await flush();
  });

  it('leaves the listing alone when the folder is not in a work tree', async () => {
    listFiles.mockResolvedValue(listing([file('a.ts')]));
    await renderPanel();
    expect(container.querySelector('[data-testid="file-entry-change"]')).toBeNull();
  });

  it('does not disguise a Git reader failure as a clean folder', async () => {
    gitStatus.mockRejectedValue(new Error('git unavailable'));
    await renderPanel();
    expect(container.querySelector('[data-testid="file-git-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="file-entry-change"]')).toBeNull();
  });

  it('offers a parent row inside a folder but not at the roots', async () => {
    await renderPanel();
    const parent = container.querySelector<HTMLButtonElement>('[data-testid="file-entry-parent"]');
    expect(parent?.textContent).toContain('..');

    act(() => parent!.click());
    await flush();
    expect(listFiles).toHaveBeenCalledWith('C:\\');
  });
});
