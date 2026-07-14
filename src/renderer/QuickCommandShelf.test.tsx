// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  QuickCommandShelf,
  filterQuickCommands,
  resolvePrimaryQuickCommand,
} from './QuickCommandShelf';
import type { QuickCommand } from '../shared/quick-command';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const first: QuickCommand = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check status',
  command: 'git status --short',
  description: 'Repository state',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};
const second: QuickCommand = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'List packages',
  command: 'pnpm list',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderShelf(overrides: Partial<React.ComponentProps<typeof QuickCommandShelf>> = {}): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QuickCommandShelf
        commands={[first, second]}
        onInsert={vi.fn()}
        onRun={vi.fn()}
        onManage={vi.fn()}
        {...overrides}
      />,
    );
  });
  return container;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('HTMLInputElement.value setter unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  window.localStorage.clear();
});

describe('QuickCommandShelf model', () => {
  it('filters names, descriptions, and command text without case sensitivity', () => {
    expect(filterQuickCommands([first, second], 'REPOSITORY')).toEqual([first]);
    expect(filterQuickCommands([first, second], 'PNPM')).toEqual([second]);
  });

  it('uses the last-used id, falling back to the most recently updated command', () => {
    expect(resolvePrimaryQuickCommand([first, second], first.id)).toBe(first);
    expect(resolvePrimaryQuickCommand([first, second], 'missing')).toBe(second);
  });
});

describe('QuickCommandShelf interaction', () => {
  it('primary action inserts without running and remembers only the opaque id', () => {
    const onInsert = vi.fn();
    const onRun = vi.fn();
    const el = renderShelf({ onInsert, onRun });

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="quick-command-primary"]')!.click());

    expect(onInsert).toHaveBeenCalledWith(second.command);
    expect(onRun).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('ezterminal.quick-command.last-used-id')).toBe(second.id);
    expect(JSON.stringify(window.localStorage)).not.toContain(second.command);
  });

  it('searches and keeps Insert and Run as distinct explicit actions', () => {
    const onInsert = vi.fn();
    const onRun = vi.fn();
    const el = renderShelf({ onInsert, onRun });
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="quick-command-toggle"]')!.click());
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      setInputValue(search, 'status');
    });

    expect(el.querySelector(`[data-testid="quick-command-insert-${first.id}"]`)).not.toBeNull();
    expect(el.querySelector(`[data-testid="quick-command-insert-${second.id}"]`)).toBeNull();
    act(() => el.querySelector<HTMLButtonElement>(`[data-testid="quick-command-run-${first.id}"]`)!.click());
    expect(onRun).toHaveBeenCalledWith(first.command);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('explains and enforces disabled Insert/Run gates independently', () => {
    const el = renderShelf({
      insertDisabledReason: 'Terminal ended',
      runDisabledReason: 'Draft is not empty',
    });
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="quick-command-toggle"]')!.click());

    const insert = el.querySelector<HTMLButtonElement>(`[data-testid="quick-command-insert-${first.id}"]`)!;
    const run = el.querySelector<HTMLButtonElement>(`[data-testid="quick-command-run-${first.id}"]`)!;
    expect(insert.disabled).toBe(true);
    expect(insert.title).toBe('Terminal ended');
    expect(run.disabled).toBe(true);
    expect(run.title).toBe('Draft is not empty');
  });

  it('opens the manager from an empty state', () => {
    const onManage = vi.fn();
    const el = renderShelf({ commands: [], onManage });
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="quick-command-toggle"]')!.click());
    expect(el.textContent).toContain('No saved Quick Commands.');
    const manage = [...el.querySelectorAll('button')].find((button) => button.textContent?.includes('Manage'))!;
    act(() => manage.click());
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
