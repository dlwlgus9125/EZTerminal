// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../shared/ipc';
import type { FileEntry, FileListResult } from '../shared/files';
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
let capabilities: CapabilityAccess;

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
          onClose={vi.fn()}
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
  const core = {
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
});
