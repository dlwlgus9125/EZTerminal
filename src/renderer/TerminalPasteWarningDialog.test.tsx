// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from './i18n';
import { TerminalPasteWarningDialog } from './TerminalPasteWarningDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <TerminalPasteWarningDialog
          risk={{ multiline: true, large: true, lineCount: 3, byteLength: 6001, shouldWarn: true }}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      )}
    </AppI18nProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('TerminalPasteWarningDialog', () => {
  it('shows only paste metadata and gives Cancel initial focus', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    act(() => opener.click());

    const dialog = document.querySelector('[data-testid="terminal-paste-warning-dialog"]')!;
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="terminal-paste-warning-cancel"]')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('3 lines');
    expect(dialog.textContent).toContain('6001 UTF-8 bytes');
    expect(document.activeElement).toBe(cancel);
  });

  it('treats Escape as cancel and restores the previous focus', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    act(() => opener.click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(document.querySelector('[data-testid="terminal-paste-warning-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
