// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InterpreterFrame, RendererControl } from '../shared/ipc';
import { Block } from './Block';
import { BlockController } from './block-controller';
import { AppI18nProvider } from './i18n';

vi.mock('./PtyBlock', () => ({ PtyBlock: () => <div data-testid="mock-pty" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakePort {
  private listener: ((event: { data: InterpreterFrame }) => void) | null = null;
  addEventListener(_type: 'message', listener: (event: { data: InterpreterFrame }) => void): void { this.listener = listener; }
  start(): void {}
  postMessage(message: RendererControl): void { void message; }
  close(): void {}
  deliver(frame: InterpreterFrame): void { this.listener?.({ data: frame }); }
}

const START = new Date(2026, 9, 27, 14, 20, 5).getTime();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function tableRun(variant: 'default' | 'instrument', opts: { startedAtMs?: number } = {}) {
  const port = new FakePort();
  let now = START;
  const controller = new BlockController('ls src', port as unknown as MessagePort, { ...opts, clock: () => now });
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <Block controller={controller} variant={variant} blockId="run-7" menu={<button type="button" data-testid="block-menu">More</button>} />
    </AppI18nProvider>,
  ));
  act(() => {
    port.deliver({ type: 'start', commandText: 'ls src', cwd: 'C:\\Working\\EZTerminal' });
    port.deliver({ type: 'schema', shape: 'table', columns: [{ name: 'name', type: 'string' }] });
    port.deliver({ type: 'progress', count: 3, done: true });
    now = START + 240;
    port.deliver({ type: 'end', exitCode: 0, cwd: 'C:\\Working\\EZTerminal' });
  });
  return controller;
}

describe('Block default markup (Android and other surfaces)', () => {
  it('is the markup it was before the instrument variant', () => {
    const controller = tableRun('default', { startedAtMs: START });
    const block = container.querySelector('[data-testid="block"]')!;
    expect(block.className).toBe('block');
    expect(block.hasAttribute('data-block-id')).toBe(false);
    expect(container.querySelector('[data-testid="block-time"]')).toBeNull();
    expect(container.querySelector('[data-testid="block-menu"]')).toBeNull();
    expect(container.querySelector('.block-meta')).toBeNull();
    const head = container.querySelector('.block-head')!;
    expect([...head.children].map((child) => child.className)).toEqual([
      'block-toggle', 'block-cwd', 'prompt-sigil', 'block-command', 'block-count', 'block-status block-status--done',
    ]);
    expect(head.querySelector('.prompt-sigil')!.textContent).toBe('❯');
    expect(head.querySelector('[data-testid="row-count"]')!.className).toBe('block-count');
    controller.dispose();
  });
});

describe('Block instrument variant (desktop terminal)', () => {
  it('shows the start time, where it ran, the row count, how long and how it ended', () => {
    const controller = tableRun('instrument', { startedAtMs: START });
    const block = container.querySelector<HTMLElement>('[data-testid="block"]')!;
    expect(block.className).toBe('block block--instrument');
    expect(block.dataset.blockId).toBe('run-7');
    const time = container.querySelector<HTMLTimeElement>('[data-testid="block-time"]')!;
    expect(time.textContent).toBe('14:20');
    expect(time.dateTime).toBe(new Date(START).toISOString());
    expect(container.querySelector('.prompt-sigil')!.textContent).toBe('>');
    expect(container.querySelector('[data-testid="row-count"]')!.textContent).toBe('3');
    expect(container.querySelector('[data-testid="block-duration"]')!.textContent).toBe('0.2s');
    expect(container.querySelector('[data-testid="block-exit"]')!.textContent).toBe('exit 0');
    expect(container.querySelector('[data-testid="block-status"]')!.getAttribute('data-status')).toBe('done');
    expect(container.querySelector('[data-testid="block-cwd"]')!.getAttribute('title')).toBe('C:\\Working\\EZTerminal');
    expect(container.querySelector('[data-testid="block-menu"]')).not.toBeNull();
    controller.dispose();
  });

  it('leaves the time and duration empty for a run it did not see start', () => {
    const controller = tableRun('instrument');
    expect(container.querySelector('[data-testid="block-time"]')!.textContent).toBe('');
    expect(container.querySelector('[data-testid="block-duration"]')).toBeNull();
    expect(container.querySelector('[data-testid="block-exit"]')!.textContent).toBe('exit 0');
    controller.dispose();
  });
});
