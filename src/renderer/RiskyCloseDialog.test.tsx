// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from './i18n';
import { RiskyCloseDialog } from './RiskyCloseDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness({ locale = 'en' }: { readonly locale?: 'en' | 'ko' }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <RiskyCloseDialog
          title="Close active terminal?"
          description="A command is still running."
          confirmLabel="Close terminal"
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

describe('RiskyCloseDialog', () => {
  // The dialog renders through the shared Dialog primitive, which portals to
  // document.body. The opener stays in the harness container; the dialog's own
  // nodes are queried from the document.

  it('is modal, gives Cancel the initial focus, and restores focus on cancel', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    act(() => opener.click());

    const dialog = document.querySelector('[role="alertdialog"]')!;
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="risky-close-cancel"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(cancel);

    act(() => cancel.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('treats Escape as the safe Cancel action', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    act(() => opener.click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps keyboard focus inside the modal', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    act(() => opener.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="risky-close-cancel"]')!;
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="risky-close-confirm"]')!;

    // Containment is the contract, not a fixed cycle length: the shared dialog
    // also offers a header close, and asserting an exact two-stop loop would
    // break every time the panel gains or loses chrome.
    confirm.focus();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })));
    expect(dialog.contains(document.activeElement)).toBe(true);

    cancel.focus();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true })));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('localizes the safe Cancel action through the application i18n provider', () => {
    act(() => root.render(<Harness locale="ko" />));
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    act(() => opener.click());

    expect(document.querySelector('[data-testid="risky-close-cancel"]')?.textContent).toBe('취소');
  });
});
