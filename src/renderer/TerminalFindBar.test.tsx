// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalFindBar, type TerminalFindBarProps } from './TerminalFindBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderFind(overrides: Partial<TerminalFindBarProps> = {}): {
  readonly element: HTMLDivElement;
  readonly props: TerminalFindBarProps;
} {
  const props: TerminalFindBarProps = {
    query: 'needle',
    caseSensitive: false,
    results: { resultIndex: 1, resultCount: 4 },
    onQueryChange: vi.fn(),
    onCaseSensitiveChange: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<TerminalFindBar {...props} />));
  return { element: container, props };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('TerminalFindBar', () => {
  it('focuses/selects its input and exposes the current/total result', () => {
    const { element } = renderFind();
    const input = element.querySelector<HTMLInputElement>('[aria-label="Find text"]')!;

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('needle'.length);
    expect(element.querySelector('[data-testid="terminal-find-count"]')?.textContent).toBe('2/4');
  });

  it('reports controlled query changes', () => {
    const onQueryChange = vi.fn();
    const { element } = renderFind({ onQueryChange });
    const input = element.querySelector<HTMLInputElement>('[aria-label="Find text"]')!;

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'other');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onQueryChange).toHaveBeenCalledWith('other');
  });

  it('uses Enter/Shift+Enter for next/previous and Escape to close', () => {
    const { element, props } = renderFind();
    const input = element.querySelector<HTMLInputElement>('[aria-label="Find text"]')!;

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('toggles case mode and exposes button pressed state', () => {
    const onCaseSensitiveChange = vi.fn();
    const { element } = renderFind({ onCaseSensitiveChange });
    const button = element.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!;

    expect(button.getAttribute('aria-pressed')).toBe('false');
    act(() => button.click());
    expect(onCaseSensitiveChange).toHaveBeenCalledWith(true);
  });

  it('disables navigation for an empty query and announces zero results', () => {
    const { element } = renderFind({ query: '', results: { resultIndex: -1, resultCount: 0 } });

    expect(element.querySelector('[data-testid="terminal-find-count"]')?.textContent).toBe('Type to search');
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Previous result"]')?.disabled).toBe(true);
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Next result"]')?.disabled).toBe(true);
  });
});
