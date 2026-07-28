// @vitest-environment jsdom

import { act, useLayoutEffect, useRef, useState, type RefObject } from 'react';
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

function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Tab',
    shiftKey,
  });
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
          <button type="button" onClick={() => setDialogOpen(true)}>Sidebar action</button>
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

function TransientCommandCenter({
  invokerRef,
  onOpenExplorer,
}: {
  readonly invokerRef: RefObject<HTMLButtonElement>;
  readonly onOpenExplorer: () => void;
}): JSX.Element {
  useLayoutEffect(() => () => invokerRef.current?.focus(), [invokerRef]);
  return <button type="button" onClick={onOpenExplorer}>Open Explorer</button>;
}

function TransientInvokerHarness(): JSX.Element {
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const commandCenterRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={commandCenterRef} type="button" onClick={() => setCommandCenterOpen(true)}>
        Command Center
      </button>
      {commandCenterOpen && (
        <TransientCommandCenter
          invokerRef={commandCenterRef}
          onOpenExplorer={() => {
            setCommandCenterOpen(false);
            setSidebarOpen(true);
          }}
        />
      )}
      {sidebarOpen && (
        <SidebarShell
          destination="explorer"
          title="Explorer"
          width={320}
          onClose={() => setSidebarOpen(false)}
          onWidthChange={vi.fn()}
        >
          <button type="button">Sidebar action</button>
        </SidebarShell>
      )}
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 1199px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[data-sidebar-test-background]').forEach((element) => element.remove());
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

describe('SidebarShell narrow overlay focus contract', () => {
  it('isolates the background from the accessibility and focus trees', () => {
    const background = document.createElement('button');
    background.textContent = 'Background';
    background.dataset.sidebarTestBackground = '';
    document.body.insertBefore(background, container);

    act(() => root.render(<SidebarHarness />));

    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
  });

  it('initially focuses the close action', () => {
    act(() => root.render(<SidebarHarness />));

    const sidebar = container.querySelector<HTMLElement>('[data-testid="workbench-sidebar"]');
    const close = sidebar?.querySelector<HTMLButtonElement>('button');
    expect(close).not.toBeNull();
    expect(document.activeElement).toBe(close);
  });

  it('does not steal initial focus from a nested modal when animation frames race', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const background = document.createElement('button');
    background.textContent = 'Background';
    background.dataset.sidebarTestBackground = '';
    document.body.insertBefore(background, container);

    act(() => root.render(<SidebarHarness withDialog />));
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    const dialogBackdrop = dialog?.closest<HTMLElement>('.ez-ui-dialog-backdrop');
    expect(dialog).not.toBeNull();
    expect(dialogBackdrop?.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('inert')).toBe(true);
    expect(background.hasAttribute('inert')).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(2);

    // A browser may run the dialog's passive-effect frame before the
    // sidebar's layout-effect frame. The modal must retain focus either way.
    act(() => {
      [...frames].reverse().forEach((callback) => callback(0));
    });

    expect(dialog?.contains(document.activeElement)).toBe(true);

    const cancel = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'Cancel');
    expect(cancel).toBeDefined();
    act(() => cancel?.click());

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('inert')).toBe(true);
  });

  it('restores nested-modal focus inside the sidebar after reapplying its isolation', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const background = document.createElement('button');
    background.textContent = 'Background';
    background.dataset.sidebarTestBackground = '';
    document.body.insertBefore(background, container);

    act(() => root.render(<SidebarHarness />));
    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });
    const sidebar = container.querySelector<HTMLElement>('[data-testid="workbench-sidebar"]');
    const action = Array.from(sidebar?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'Sidebar action');
    expect(action).toBeDefined();

    act(() => {
      action?.focus();
      action?.click();
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });
    expect(dialog?.contains(document.activeElement)).toBe(true);

    const cancel = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'Cancel');
    act(() => cancel?.click());
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('inert')).toBe(true);

    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });
    expect(document.activeElement).toBe(action);
    expect(sidebar?.contains(document.activeElement)).toBe(true);
  });

  it('wraps focus in both directions', () => {
    act(() => root.render(<SidebarHarness />));

    const sidebar = container.querySelector<HTMLElement>('[data-testid="workbench-sidebar"]');
    const close = sidebar?.querySelector<HTMLButtonElement>('button');
    const lastAction = Array.from(sidebar?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'Sidebar action');
    expect(close).not.toBeNull();
    expect(lastAction).toBeDefined();
    act(() => lastAction?.focus());
    const forward = pressTab();
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    const backward = pressTab(true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(lastAction);
  });

  it('restores the stable Command Center invoker after its transient result unmounts', () => {
    act(() => root.render(<TransientInvokerHarness />));
    const commandCenter = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Command Center');
    expect(commandCenter).toBeDefined();

    act(() => {
      commandCenter?.focus();
      commandCenter?.click();
    });
    const transientResult = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Open Explorer');
    expect(transientResult).toBeDefined();

    act(() => {
      transientResult?.focus();
      transientResult?.click();
    });
    const sidebar = container.querySelector<HTMLElement>('[data-testid="workbench-sidebar"]');
    expect(sidebar?.contains(document.activeElement)).toBe(true);

    pressEscape();

    expect(container.querySelector('[data-testid="workbench-sidebar"]')).toBeNull();
    expect(document.activeElement).toBe(commandCenter);
  });
});
