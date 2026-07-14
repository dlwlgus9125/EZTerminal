import { act, StrictMode, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileHeaderMoreActions } from './MobileHeaderMoreActions';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  readonly wide: boolean;
  readonly connected: boolean;
  readonly onOpenSettings?: () => void;
}

function Harness({ wide, connected, onOpenSettings = () => undefined }: HarnessProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)} data-testid="trigger">More</button>
      {open && (
        <MobileHeaderMoreActions
          wide={wide}
          connected={connected}
          themeName="dark"
          openclawVisible
          openclawState="starting"
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          onOpenSessions={() => undefined}
          onOpenFiles={() => undefined}
          onOpenStats={() => undefined}
          onOpenTheme={() => undefined}
          onOpenClaw={() => undefined}
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function openSheet(props: HarnessProps): void {
  act(() => root.render(
    <StrictMode>
      <MobileNavigationHistoryProvider>
        <Harness {...props} />
      </MobileNavigationHistoryProvider>
    </StrictMode>,
  ));
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!.click());
}

describe('MobileHeaderMoreActions', () => {
  it('moves narrow-only remote actions into the sheet and disables them offline', () => {
    openSheet({ wide: false, connected: false });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="more-sessions"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="more-files"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="more-stats"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="more-theme"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="more-settings"]')?.disabled).toBe(false);
    expect(container.textContent).toContain('Offline');
  });

  it('omits Sessions and Files from the sheet at the wide breakpoint', () => {
    openSheet({ wide: true, connected: true });
    expect(container.querySelector('[data-testid="more-sessions"]')).toBeNull();
    expect(container.querySelector('[data-testid="more-files"]')).toBeNull();
    expect(container.querySelector('[data-testid="more-stats"]')).toBeTruthy();
  });

  it('closes before dispatching a selected action', () => {
    const onOpenSettings = vi.fn(() => {
      expect(container.querySelector('[data-testid="workspace-more-sheet"]')).toBeNull();
    });
    openSheet({ wide: false, connected: true, onOpenSettings });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="more-settings"]')!.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="workspace-more-sheet"]')).toBeNull();
  });

  it('dismisses on Escape and restores focus to More', async () => {
    openSheet({ wide: false, connected: true });
    const sheet = container.querySelector<HTMLElement>('[data-testid="workspace-more-sheet"]')!;
    act(() => sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(container.querySelector('[data-testid="workspace-more-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="trigger"]'));
  });

  it('treats a history pop as Android Back dismissal', async () => {
    openSheet({ wide: false, connected: true });
    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(container.querySelector('[data-testid="workspace-more-sheet"]')).toBeNull();
  });
});
