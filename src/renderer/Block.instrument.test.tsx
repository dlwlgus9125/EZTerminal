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

function tableRun(opts: { startedAtMs?: number } = {}) {
  const port = new FakePort();
  let now = START;
  const controller = new BlockController('ls src', port as unknown as MessagePort, { ...opts, clock: () => now });
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <Block controller={controller} blockId="run-7" menu={<button type="button" data-testid="block-menu">More</button>} />
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

describe('Block (the instrument block of the desktop and phone terminals)', () => {
  it('shows the start time, where it ran, the row count, how long and how it ended', () => {
    const controller = tableRun({ startedAtMs: START });
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
    const controller = tableRun();
    expect(container.querySelector('[data-testid="block-time"]')!.textContent).toBe('');
    expect(container.querySelector('[data-testid="block-duration"]')).toBeNull();
    expect(container.querySelector('[data-testid="block-exit"]')!.textContent).toBe('exit 0');
    controller.dispose();
  });
});
