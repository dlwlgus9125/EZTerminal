// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileActionSheet } from './MobileActionSheet';
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
});

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
});
