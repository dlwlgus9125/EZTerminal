import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileFileView } from './MobileFileView';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

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
    readFilePreview: vi.fn(),
    createFolder: vi.fn(),
    renameFile: vi.fn(),
    trashFile: vi.fn(async () => ({ ok: true })),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
  } as unknown as WsEzTerminalTransport;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.history.replaceState({}, '');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MobileFileView
        transport={makeTransport()}
        initialPath="/work"
        onClose={vi.fn()}
        onOpenTerminalAt={vi.fn()}
        onPastePath={vi.fn()}
      />,
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

    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(host.querySelector('[data-testid="mobile-delete-confirm-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
