// @vitest-environment jsdom

import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileActionSheet } from './MobileActionSheet';
import { MobileHeaderMoreActions } from './MobileHeaderMoreActions';
import { MobileWorkbenchCoordinator } from './MobileWorkbenchCoordinator';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState({}, '');
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState({}, '');
  vi.restoreAllMocks();
});

function MoreToSettingsHarness(): JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <MobileWorkbenchCoordinator
      terminal={(
        <button
          ref={triggerRef}
          type="button"
          data-testid="open-more"
          onClick={() => setMoreOpen(true)}
        >
          More
        </button>
      )}
      page={settingsOpen ? (
        <div data-testid="settings-page">
          settings
          <button type="button" data-testid="close-settings" onClick={() => setSettingsOpen(false)}>Close</button>
        </div>
      ) : undefined}
      overlays={moreOpen ? (
        <MobileHeaderMoreActions
          wide
          connected
          themeName="dark"
          openclawVisible
          triggerRef={triggerRef}
          onClose={() => setMoreOpen(false)}
          onOpenSessions={() => undefined}
          onOpenFiles={() => undefined}
          onOpenStats={() => undefined}
          onOpenTheme={() => undefined}
          onOpenClaw={() => undefined}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : undefined}
      onRequestTerminal={() => setSettingsOpen(false)}
    />
  );
}

function NestedSheetsHarness(): JSX.Element {
  const [firstOpen, setFirstOpen] = useState(true);
  const [secondOpen, setSecondOpen] = useState(false);

  return (
    <MobileWorkbenchCoordinator
      terminal={<button type="button" data-testid="background-control">Terminal</button>}
      overlays={(
        <>
          {firstOpen && (
            <MobileActionSheet
              title="First sheet"
              onClose={() => setFirstOpen(false)}
              testId="first-sheet"
            >
              <button type="button" data-testid="open-second-sheet" onClick={() => setSecondOpen(true)}>
                Open second sheet
              </button>
            </MobileActionSheet>
          )}
          {secondOpen && (
            <MobileActionSheet
              title="Second sheet"
              onClose={() => setSecondOpen(false)}
              testId="second-sheet"
            >
              <button type="button">Second action</button>
            </MobileActionSheet>
          )}
        </>
      )}
      onRequestTerminal={() => undefined}
    />
  );
}

describe('MobileWorkbenchCoordinator', () => {
  it('preserves terminal DOM identity and makes it inert under an auxiliary page', () => {
    const render = (page?: JSX.Element): void => {
      act(() => root.render(
        <MobileWorkbenchCoordinator
          terminal={<div data-testid="terminal-instance">terminal</div>}
          page={page}
          onRequestTerminal={vi.fn()}
        />,
      ));
    };

    render();
    const terminal = host.querySelector('[data-testid="terminal-instance"]');
    const layer = host.querySelector<HTMLElement>('[data-testid="mobile-terminal-layer"]');
    expect(layer?.style.display).toBe('');

    render(<div data-testid="settings-page">settings</div>);
    expect(host.querySelector('[data-testid="terminal-instance"]')).toBe(terminal);
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.hasAttribute('inert')).toBe(true);
    expect(layer?.style.display).toBe('');

    render();
    expect(host.querySelector('[data-testid="terminal-instance"]')).toBe(terminal);
    expect(layer?.hasAttribute('aria-hidden')).toBe(false);
    expect(layer?.hasAttribute('inert')).toBe(false);
  });

  it('maps browser or Android Back history to the terminal page', () => {
    const onRequestTerminal = vi.fn();
    act(() => root.render(
      <MobileWorkbenchCoordinator
        terminal={<div>terminal</div>}
        page={<div>files</div>}
        onRequestTerminal={onRequestTerminal}
      />,
    ));

    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(onRequestTerminal).toHaveBeenCalledTimes(1);
  });

  it('keeps the auxiliary page open when Back dismisses its top sheet', () => {
    const onRequestTerminal = vi.fn();
    const onCloseSheet = vi.fn();
    const render = (overlays?: JSX.Element): void => {
      act(() => root.render(
        <MobileWorkbenchCoordinator
          terminal={<div>terminal</div>}
          page={<div>files</div>}
          overlays={overlays}
          onRequestTerminal={onRequestTerminal}
        />,
      ));
    };

    render();
    const pageState = window.history.state;
    render(
      <MobileActionSheet title="File actions" onClose={onCloseSheet}>
        <button type="button">Copy path</button>
      </MobileActionSheet>,
    );

    act(() => {
      window.history.replaceState(pageState, '');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(onCloseSheet).toHaveBeenCalledTimes(1);
    expect(onRequestTerminal).not.toHaveBeenCalled();
  });

  it('isolates the background and only exposes the top action sheet', () => {
    act(() => root.render(<NestedSheetsHarness />));

    const terminalLayer = host.querySelector<HTMLElement>('.mobile-terminal-layer')!;
    const firstBackdrop = host.querySelector<HTMLElement>('[data-testid="first-sheet-backdrop"]')!;
    expect(terminalLayer.hasAttribute('inert')).toBe(true);
    expect(terminalLayer.getAttribute('aria-hidden')).toBe('true');
    expect(firstBackdrop.hasAttribute('inert')).toBe(false);

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="open-second-sheet"]')!.click());
    const secondBackdrop = host.querySelector<HTMLElement>('[data-testid="second-sheet-backdrop"]')!;
    expect(firstBackdrop.hasAttribute('inert')).toBe(true);
    expect(firstBackdrop.getAttribute('aria-hidden')).toBe('true');
    expect(secondBackdrop.hasAttribute('inert')).toBe(false);

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="second-sheet"] .mobile-action-sheet-cancel')!.click());
    expect(host.querySelector('[data-testid="second-sheet"]')).toBeNull();
    expect(firstBackdrop.hasAttribute('inert')).toBe(false);
    expect(firstBackdrop.hasAttribute('aria-hidden')).toBe(false);
    expect(terminalLayer.hasAttribute('inert')).toBe(true);

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-sheet"] .mobile-action-sheet-cancel')!.click());
    expect(host.querySelector('[data-testid="first-sheet"]')).toBeNull();
    expect(terminalLayer.hasAttribute('inert')).toBe(false);
    expect(terminalLayer.hasAttribute('aria-hidden')).toBe(false);
  });

  it('isolates dynamically added background siblings until the complete sheet stack closes', async () => {
    act(() => root.render(<NestedSheetsHarness />));

    const dynamicBackground = document.createElement('aside');
    dynamicBackground.inert = false;
    dynamicBackground.setAttribute('aria-hidden', 'false');
    document.body.append(dynamicBackground);
    await act(async () => Promise.resolve());

    expect(dynamicBackground.inert).toBe(true);
    expect(dynamicBackground.hasAttribute('inert')).toBe(true);
    expect(dynamicBackground.getAttribute('aria-hidden')).toBe('true');

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="open-second-sheet"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="second-sheet"] .mobile-action-sheet-cancel')!.click());
    expect(dynamicBackground.inert).toBe(true);
    expect(dynamicBackground.getAttribute('aria-hidden')).toBe('true');

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-sheet"] .mobile-action-sheet-cancel')!.click());
    expect(dynamicBackground.inert).toBe(false);
    expect(dynamicBackground.hasAttribute('inert')).toBe(false);
    expect(dynamicBackground.getAttribute('aria-hidden')).toBe('false');

    dynamicBackground.remove();
  });

  it('keeps a More destination mounted after the sheet history traversal would run', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
      queueMicrotask(() => {
        window.history.replaceState({}, '');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    });

    act(() => root.render(<MoreToSettingsHarness />));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="open-more"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="more-settings"]')!.click());

    expect(host.querySelector('[data-testid="settings-page"]')).not.toBeNull();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('[data-testid="settings-page"]')).not.toBeNull();
    expect(back).not.toHaveBeenCalled();
  });

  it('repeats sheet-to-page replacement without ghost history entries', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
      queueMicrotask(() => {
        window.history.replaceState({}, '');
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      });
    });
    act(() => root.render(<MoreToSettingsHarness />));

    for (let index = 0; index < 20; index += 1) {
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="open-more"]')!.click());
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="more-settings"]')!.click());
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect(host.querySelector('[data-testid="settings-page"]')).not.toBeNull();

      act(() => host.querySelector<HTMLButtonElement>('[data-testid="close-settings"]')!.click());
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect(host.querySelector('[data-testid="settings-page"]')).toBeNull();
    }

    expect(back).toHaveBeenCalledTimes(20);
  });

  it('consumes its owned history entry when disconnect unmounts the coordinator', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.history.replaceState({}, '');
    });
    act(() => root.render(
      <MobileWorkbenchCoordinator
        terminal={<div>terminal</div>}
        page={<div>settings</div>}
        onRequestTerminal={vi.fn()}
      />,
    ));
    expect(window.history.state.ezterminalNavigation).toBeDefined();

    act(() => root.render(<div data-testid="disconnected">disconnected</div>));

    expect(back).toHaveBeenCalledTimes(1);
    expect(window.history.state.ezterminalNavigation).toBeUndefined();
  });
});
