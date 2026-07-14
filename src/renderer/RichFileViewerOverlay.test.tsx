// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RichFileViewerOverlay } from './RichFileViewerOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const preview = {
  ok: true,
  kind: 'text',
  name: 'notes.txt',
  mime: 'text/plain',
  content: 'hello',
  truncated: false,
  fileSize: 5,
} as const;

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

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Preview</button>
      {open && (
        <RichFileViewerOverlay
          path="C:\\workspace\\notes.txt"
          result={preview}
          onClose={() => setOpen(false)}
          onInsert={vi.fn()}
          onRetry={vi.fn()}
          onOpen={vi.fn()}
          onReveal={vi.fn()}
        />
      )}
    </>
  );
}

function openViewer(): { opener: HTMLButtonElement; dialog: HTMLElement; close: HTMLButtonElement } {
  const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
  opener.focus();
  act(() => opener.click());
  return {
    opener,
    dialog: document.body.querySelector<HTMLElement>('[role="dialog"]')!,
    close: document.body.querySelector<HTMLButtonElement>('[data-testid="viewer-close"]')!,
  };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('RichFileViewerOverlay modal behavior', () => {
  it('uses an aria-modal dialog and moves focus inside when opened', () => {
    const { dialog, close } = openViewer();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).not.toBeNull();
    expect(document.activeElement).toBe(close);
  });

  it('traps Tab focus within the preview', () => {
    const { dialog } = openViewer();
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    press(document, 'Tab');
    expect(document.activeElement).toBe(first);
    first.focus();
    press(document, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('closes with Escape and restores focus to the invoker', () => {
    const { opener } = openViewer();
    press(document, 'Escape');

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
