// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RiskyCloseDialog } from './RiskyCloseDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
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
    </>
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
  it('is modal, gives Cancel the initial focus, and restores focus on cancel', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    act(() => opener.click());

    const dialog = container.querySelector('[role="alertdialog"]')!;
    const cancel = container.querySelector<HTMLButtonElement>('[data-testid="risky-close-cancel"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(cancel);

    act(() => cancel.click());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('treats Escape as the safe Cancel action', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    act(() => opener.click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps keyboard focus inside the modal actions', () => {
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    act(() => opener.click());
    const cancel = container.querySelector<HTMLButtonElement>('[data-testid="risky-close-cancel"]')!;
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="risky-close-confirm"]')!;

    confirm.focus();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })));
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true })));
    expect(document.activeElement).toBe(confirm);
  });
});
