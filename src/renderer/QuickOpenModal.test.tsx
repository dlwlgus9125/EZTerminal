// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuickCommand } from '../shared/quick-command';
import {
  QuickOpenModal,
  groupQuickOpenRows,
  validateQuickCommandDraft,
  type QuickCommandManagerConfig,
  type QuickOpenModalProps,
  type QuickOpenRow,
} from './QuickOpenModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const ROWS: readonly QuickOpenRow[] = [
  { id: 'pane-1', kind: 'pane', title: 'Terminal one', detail: 'C:\\work' },
  { id: 'file-1', kind: 'file', title: 'README.md', detail: 'docs/README.md' },
  { id: 'action-1', kind: 'action', title: 'Split right' },
];

function baseProps(overrides: Partial<QuickOpenModalProps> = {}): QuickOpenModalProps {
  return {
    mode: 'all',
    query: 'term',
    onQueryChange: vi.fn(),
    rows: ROWS,
    emptyRows: [],
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function renderModal(overrides: Partial<QuickOpenModalProps> = {}): {
  readonly element: HTMLDivElement;
  readonly props: QuickOpenModalProps;
} {
  const props = baseProps(overrides);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<QuickOpenModal {...props} />));
  return { element: container, props };
}

function key(element: Element, value: string, init: KeyboardEventInit = {}): void {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, ...init })));
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  document.querySelectorAll('[data-quick-open-fixture]').forEach((element) => element.remove());
});

describe('Quick Open row helpers', () => {
  it('groups rows by first group occurrence while preserving row order', () => {
    expect(groupQuickOpenRows([
      ROWS[0],
      { ...ROWS[1], groupLabel: 'Recent' },
      { ...ROWS[2], groupLabel: 'Recent' },
    ])).toEqual([
      { label: 'Open panes', rows: [ROWS[0]] },
      { label: 'Recent', rows: [expect.objectContaining({ id: 'file-1' }), expect.objectContaining({ id: 'action-1' })] },
    ]);
  });

  it('normalizes valid drafts and returns field-addressable validation errors', () => {
    expect(validateQuickCommandDraft({ name: ' Build ', command: ' pnpm build ', description: ' all ' }))
      .toEqual({
        ok: true,
        input: { name: 'Build', command: ' pnpm build ', description: 'all' },
      });
    expect(validateQuickCommandDraft({ name: '', command: 'one\ntwo', description: '' }))
      .toEqual({
        ok: false,
        fieldErrors: {
          name: 'name is required',
          command: 'command must be a single line and cannot contain NUL',
        },
      });
  });
});

describe('QuickOpenModal results', () => {
  it('focuses the controlled input and renders grouped badges, detail, and loading state', () => {
    const { element } = renderModal({ loading: true, loadingLabel: 'Indexing files…' });
    const input = element.querySelector<HTMLInputElement>('[data-testid="quick-open-input"]')!;

    expect(document.activeElement).toBe(input);
    expect(element.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect([...element.querySelectorAll('.quick-open-group h2')].map((node) => node.textContent))
      .toEqual(['Open panes', 'Files', 'Actions']);
    expect(element.querySelector('[data-kind="pane"] .quick-open-source')?.textContent).toBe('Pane');
    expect(element.querySelector('[data-kind="pane"] .quick-open-row-detail')?.textContent).toBe('C:\\work');
    expect(element.querySelector('[data-testid="quick-open-loading"]')?.textContent).toContain('Indexing files…');
  });

  it('uses caller-supplied empty-query rows and distinct empty/no-match messages', () => {
    const recent: QuickOpenRow[] = [
      { id: 'recent', kind: 'history', title: 'pnpm test', groupLabel: 'Recent' },
    ];
    const { element } = renderModal({ query: '', rows: ROWS, emptyRows: recent });
    expect(element.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(element.querySelector('.quick-open-group h2')?.textContent).toBe('Recent');

    act(() => root!.render(<QuickOpenModal {...baseProps({ query: 'missing', rows: [], noResultsMessage: 'Nothing found' })} />));
    expect(element.querySelector('[data-testid="quick-open-empty"]')?.textContent).toBe('Nothing found');

    act(() => root!.render(<QuickOpenModal {...baseProps({ query: '', rows: [], emptyRows: [], emptyMessage: 'No recent work' })} />));
    expect(element.querySelector('[data-testid="quick-open-empty"]')?.textContent).toBe('No recent work');
  });

  it('maps Enter, Shift+Enter, and Ctrl/Cmd+Enter to one exact action callback', () => {
    const onAction = vi.fn();
    const { element } = renderModal({ onAction });
    const input = element.querySelector<HTMLInputElement>('[data-testid="quick-open-input"]')!;

    key(input, 'Enter');
    key(input, 'ArrowDown');
    key(input, 'Enter', { shiftKey: true });
    key(input, 'End');
    key(input, 'Enter', { ctrlKey: true });
    key(input, 'Home');
    key(input, 'Enter', { metaKey: true });

    expect(onAction.mock.calls).toEqual([
      [ROWS[0], 'enter'],
      [ROWS[1], 'shift-enter'],
      [ROWS[2], 'mod-enter'],
      [ROWS[0], 'mod-enter'],
    ]);
  });

  it('supports ArrowUp/Down/Home/End and never activates a disabled row', () => {
    const onAction = vi.fn();
    const disabled: QuickOpenRow = {
      id: 'busy',
      kind: 'history',
      title: 'Run tests',
      disabledReason: 'The active pane is busy.',
    };
    const { element } = renderModal({ rows: [ROWS[0], disabled], onAction });
    const input = element.querySelector<HTMLInputElement>('[data-testid="quick-open-input"]')!;

    key(input, 'ArrowDown');
    expect(element.querySelector('[aria-selected="true"]')?.textContent).toContain('Run tests');
    expect(element.querySelector('.quick-open-footer-reason')?.textContent).toBe('The active pane is busy.');
    key(input, 'Enter', { ctrlKey: true });
    act(() => element.querySelector<HTMLElement>('[data-testid="quick-open-row-history-busy"]')!.click());
    expect(onAction).not.toHaveBeenCalled();

    key(input, 'ArrowUp');
    key(input, 'Enter');
    expect(onAction).toHaveBeenCalledWith(ROWS[0], 'enter');
  });

  it('reports controlled query changes without performing source work itself', () => {
    const onQueryChange = vi.fn();
    const { element } = renderModal({ onQueryChange });
    setInput(element.querySelector<HTMLInputElement>('[data-testid="quick-open-input"]')!, 'readme');
    expect(onQueryChange).toHaveBeenCalledWith('readme');
  });

  it('traps focus at both ends, closes on Escape, and restores the invoker after unmount', () => {
    const invoker = document.createElement('button');
    invoker.dataset.quickOpenFixture = 'true';
    document.body.append(invoker);
    invoker.focus();
    const onClose = vi.fn();

    function Closable(): JSX.Element | null {
      const [open, setOpen] = useState(true);
      return open ? (
        <QuickOpenModal
          {...baseProps({
            onClose: () => {
              onClose();
              setOpen(false);
            },
          })}
        />
      ) : null;
    }

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Closable />));
    const input = container.querySelector<HTMLInputElement>('[data-testid="quick-open-input"]')!;
    const close = container.querySelector<HTMLButtonElement>('.quick-open-close')!;
    expect(document.activeElement).toBe(input);

    key(input, 'Tab');
    expect(document.activeElement).toBe(close);
    key(close, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(input);
    key(input, 'Escape');

    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});

describe('Quick Command manager', () => {
  const saved: QuickCommand = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Build',
    command: 'pnpm build',
    description: 'All targets',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };

  function manager(overrides: Partial<QuickCommandManagerConfig> = {}): QuickCommandManagerConfig {
    return {
      commands: [saved],
      onCreate: vi.fn().mockResolvedValue({ ok: true }),
      onUpdate: vi.fn().mockResolvedValue({ ok: true }),
      onDelete: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    };
  }

  function openManager(config: QuickCommandManagerConfig): HTMLDivElement {
    const { element } = renderModal({ quickCommandManager: config });
    act(() => element.querySelector<HTMLButtonElement>('.quick-open-manage')!.click());
    return element;
  }

  it('shows field validation inline and does not call create for invalid input', () => {
    const config = manager();
    const element = openManager(config);
    const form = element.querySelector<HTMLFormElement>('.quick-command-editor-form')!;

    act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(config.onCreate).not.toHaveBeenCalled();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Fix the highlighted fields');
    expect(element.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
  });

  it('normalizes and forwards a valid create, then surfaces callback validation errors', async () => {
    const onCreate = vi
      .fn<QuickCommandManagerConfig['onCreate']>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        message: 'That name already exists.',
        fieldErrors: { name: 'Use a unique name.' },
      });
    const config = manager({ commands: [], onCreate });
    const element = openManager(config);
    const inputs = element.querySelectorAll<HTMLInputElement>('.quick-command-editor-form input');
    setInput(inputs[0], '  Test  ');
    setInput(inputs[1], 'pnpm test');
    setInput(inputs[2], '  Unit tests  ');

    await act(async () => {
      element.querySelector<HTMLFormElement>('.quick-command-editor-form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onCreate).toHaveBeenCalledWith({ name: 'Test', command: 'pnpm test', description: 'Unit tests' });
    expect(element.querySelector('[role="status"]')?.textContent).toContain('created');

    setInput(inputs[0], 'Test');
    setInput(inputs[1], 'pnpm test');
    await act(async () => {
      element.querySelector<HTMLFormElement>('.quick-command-editor-form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('That name already exists.');
    expect(element.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.getAttribute('id')).toContain('name');
  });

  it('forwards update and requires an explicit second click before delete', async () => {
    const config = manager();
    const element = openManager(config);
    act(() => element.querySelector<HTMLButtonElement>('.quick-command-editor-select')!.click());
    const name = element.querySelector<HTMLInputElement>('.quick-command-editor-form input')!;
    expect(name.value).toBe('Build');
    setInput(name, 'Build all');

    await act(async () => {
      element.querySelector<HTMLFormElement>('.quick-command-editor-form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(config.onUpdate).toHaveBeenCalledWith(saved.id, {
      name: 'Build all',
      command: saved.command,
      description: saved.description,
    });

    const deleteButton = element.querySelector<HTMLButtonElement>('.quick-command-editor-delete')!;
    act(() => deleteButton.click());
    expect(config.onDelete).not.toHaveBeenCalled();
    expect(deleteButton.textContent).toBe('Confirm');
    await act(async () => deleteButton.click());
    expect(config.onDelete).toHaveBeenCalledWith(saved.id);
  });
});
