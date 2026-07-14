// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RiskyCloseDialog } from '../RiskyCloseDialog';
import { SidebarShell } from './SidebarShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function pressEscape(prevented = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Escape',
  });
  if (prevented) event.preventDefault();
  act(() => document.dispatchEvent(event));
  return event;
}

function SidebarHarness({ withDialog = false }: { readonly withDialog?: boolean }): JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(withDialog);
  return (
    <>
      {sidebarOpen && (
        <SidebarShell
          destination="explorer"
          title="Explorer"
          width={320}
          onClose={() => setSidebarOpen(false)}
          onWidthChange={vi.fn()}
        >
          Files
        </SidebarShell>
      )}
      {dialogOpen && (
        <RiskyCloseDialog
          title="Close active terminal?"
          description="A command is still running."
          confirmLabel="Close terminal"
          onCancel={() => setDialogOpen(false)}
          onConfirm={() => setDialogOpen(false)}
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
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SidebarShell Escape ownership', () => {
  it('lets the open modal consume Escape without also closing the sidebar', () => {
    act(() => root.render(<SidebarHarness withDialog />));

    pressEscape();

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="workbench-sidebar"]')).not.toBeNull();
  });

  it('still closes the sidebar when no modal owns Escape', () => {
    act(() => root.render(<SidebarHarness />));

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('[data-testid="workbench-sidebar"]')).toBeNull();
  });

  it('does not close for an Escape event already consumed elsewhere', () => {
    act(() => root.render(<SidebarHarness />));

    pressEscape(true);

    expect(container.querySelector('[data-testid="workbench-sidebar"]')).not.toBeNull();
  });
});
