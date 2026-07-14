// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileExplorerPanel } from './FileExplorerPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let listFiles: ReturnType<typeof vi.fn>;

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

async function renderPanel(): Promise<void> {
  act(() => {
    root.render(
      <FileExplorerPanel
        activePanelId={null}
        onClose={vi.fn()}
        onOpenTerminalAt={vi.fn()}
      />,
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
  listFiles = vi.fn(async () => ({
    ok: true as const,
    path: 'C:\\workspace',
    parent: 'C:\\',
    entries: [
      { name: 'subdir', kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: 0 },
    ],
  }));
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: {
      listFiles,
      listFileRoots: vi.fn(async () => []),
      readFilePreview: vi.fn(),
      createFolder: vi.fn(),
      renameFile: vi.fn(),
      trashFile: vi.fn(),
      openFileInApp: vi.fn(),
      revealFileInExplorer: vi.fn(),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'ezterminal');
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
