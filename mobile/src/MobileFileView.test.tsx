import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileFileView } from './MobileFileView';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

vi.mock('./download-storage', () => ({
  saveDownloadToDevice: vi.fn(async (name: string) => ({ name, uri: 'content://download' })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTransport(): WsEzTerminalTransport {
  return {
    listFiles: vi.fn(async () => ({
      ok: true,
      path: '/work',
      parent: '/',
      entries: [{ name: 'notes.txt', kind: 'file', isSymlink: false, size: 12, mtimeMs: 0 }],
    })),
    listFileRoots: vi.fn(async () => ['/']),
    readFilePreview: vi.fn(async () => ({
      ok: true,
      kind: 'text',
      name: 'notes.txt',
      mime: 'text/plain',
      content: 'hello',
      truncated: false,
      fileSize: 12,
    })),
    createFolder: vi.fn(),
    renameFile: vi.fn(),
    trashFile: vi.fn(async () => ({ ok: true })),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
  } as unknown as WsEzTerminalTransport;
}

let host: HTMLDivElement;
let root: Root;
let transport: WsEzTerminalTransport;

beforeEach(async () => {
  window.history.replaceState({}, '');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  transport = makeTransport();
  await act(async () => {
    root.render(
      <MobileNavigationHistoryProvider>
        <MobileFileView
          transport={transport}
          initialPath="/work"
          onClose={vi.fn()}
          onOpenTerminalAt={vi.fn()}
          onPastePath={vi.fn()}
        />
      </MobileNavigationHistoryProvider>,
    );
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState({}, '');
});

describe('MobileFileView accessibility', () => {
  it('uses a keyboard-operable file button and opens the shared action sheet', () => {
    const row = host.querySelector<HTMLButtonElement>('[data-testid="mobile-file-entry"]')!;
    expect(row.tagName).toBe('BUTTON');

    row.focus();
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })));

    const sheet = host.querySelector<HTMLElement>('[data-testid="mobile-file-sheet"]');
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('[data-testid="sheet-copy-path"]'));
  });

  it('keeps delete confirmation in the same history-aware sheet and focuses Cancel', async () => {
    const row = host.querySelector<HTMLButtonElement>('[data-testid="mobile-file-entry"]')!;
    row.focus();
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="sheet-delete"]')!.click());

    const dialog = host.querySelector<HTMLElement>('[data-testid="mobile-delete-confirm-dialog"]');
    const descriptionId = dialog?.getAttribute('aria-describedby');
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(descriptionId && document.getElementById(descriptionId)).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="delete-confirm-cancel"]'));

    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(host.querySelector('[data-testid="mobile-delete-confirm-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('blocks a rapid repeat download before React can disable the control', async () => {
    let resolveDownload!: (value: { name: string; bytes: Uint8Array }) => void;
    vi.mocked(transport.downloadFile).mockImplementation(() => new Promise((resolve) => {
      resolveDownload = resolve;
    }));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="mobile-file-entry"]')!.click();
      await Promise.resolve();
    });
    const download = host.querySelector<HTMLButtonElement>('[data-testid="viewer-download"]')!;
    act(() => {
      download.click();
      download.click();
    });

    expect(transport.downloadFile).toHaveBeenCalledTimes(1);
    expect(download.disabled).toBe(true);
    expect(host.querySelector('[data-testid="mobile-file-progress"]')).not.toBeNull();

    await act(async () => {
      resolveDownload({ name: 'notes.txt', bytes: new Uint8Array([1, 2, 3]) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(download.disabled).toBe(false);
  });

  it('keeps the transfer lock when Android Back unmounts and reopens the file page', async () => {
    let resolveDownload!: (value: { name: string; bytes: Uint8Array }) => void;
    vi.mocked(transport.downloadFile).mockImplementation(() => new Promise((resolve) => {
      resolveDownload = resolve;
    }));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="mobile-file-entry"]')!.click();
      await Promise.resolve();
    });
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="viewer-download"]')!.click());
    expect(transport.downloadFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<MobileNavigationHistoryProvider><div data-testid="terminal-page" /></MobileNavigationHistoryProvider>);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <MobileNavigationHistoryProvider key="reopened">
          <MobileFileView
            transport={transport}
            initialPath="/work"
            onClose={vi.fn()}
            onOpenTerminalAt={vi.fn()}
            onPastePath={vi.fn()}
          />
        </MobileNavigationHistoryProvider>,
      );
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="mobile-file-entry"]')!.click();
      await Promise.resolve();
    });
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="viewer-download"]')!.click());

    expect(transport.downloadFile).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="mobile-file-progress"]')).toBeNull();

    await act(async () => {
      resolveDownload({ name: 'notes.txt', bytes: new Uint8Array([1, 2, 3]) });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
