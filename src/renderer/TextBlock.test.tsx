// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InterpreterFrame, RendererControl } from '../shared/ipc';
import { BlockController } from './block-controller';
import { TextBlock } from './TextBlock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakePort {
  private listener: ((event: { data: InterpreterFrame }) => void) | null = null;
  readonly posted: RendererControl[] = [];

  addEventListener(_type: 'message', listener: (event: { data: InterpreterFrame }) => void): void {
    this.listener = listener;
  }

  start(): void {}

  postMessage(message: RendererControl): void {
    this.posted.push(message);
  }

  close(): void {}

  deliver(frame: InterpreterFrame): void {
    this.listener?.({ data: frame });
  }
}

let root: Root;
let mount: HTMLDivElement;
let port: FakePort;
let controller: BlockController;

beforeEach(() => {
  document.documentElement.dataset.scrollback = '2';
  mount = document.createElement('div');
  document.body.append(mount);
  port = new FakePort();
  controller = new BlockController('text command', port as unknown as MessagePort);
  port.deliver({ type: 'schema', shape: 'text', columns: [{ name: 'value', type: 'html' }] });
  port.deliver({ type: 'progress', count: 3, done: true });
  root = createRoot(mount);
  act(() => root.render(<TextBlock controller={controller} />));
});

afterEach(() => {
  act(() => root.unmount());
  controller.dispose();
  mount.remove();
  delete document.documentElement.dataset.scrollback;
});

describe('TextBlock bounded retention', () => {
  it('preserves ANSI markup while retaining only the configured recent lines', () => {
    expect(port.posted).toContainEqual({ type: 'requestRows', start: 0, count: 3 });

    act(() => {
      port.deliver({
        type: 'chunk',
        start: 0,
        rows: [
          { value: '<span class="old">one\n</span>' },
          { value: '<span class="recent">two\n</span>' },
          { value: '<b>three</b>' },
        ],
      });
    });

    const output = mount.querySelector('[data-testid="text-output"]');
    expect(output?.textContent).toBe('two\nthree');
    expect(output?.querySelector('.old')).toBeNull();
    expect(output?.querySelector('.recent')?.textContent).toBe('two\n');
    expect(output?.querySelector('b')?.textContent).toBe('three');
  });

  it('sequentially consumes a final total beyond the controller window cap', () => {
    act(() => {
      port.deliver({ type: 'progress', count: 10_005, done: true });
    });
    // The initial three-row page is still outstanding, so a newer progress
    // frame must not advance the cache window and make that response stale.
    expect(port.posted).toEqual([
      { type: 'requestRows', start: 0, count: 3 },
    ]);

    act(() => {
      port.deliver({
        type: 'chunk',
        start: 0,
        rows: [{ value: 'a' }, { value: 'b' }, { value: 'c' }],
      });
    });
    expect(port.posted.at(-1)).toEqual({
      type: 'requestRows',
      start: 3,
      count: 10_000,
    });

    act(() => {
      port.deliver({
        type: 'chunk',
        start: 3,
        rows: Array.from({ length: 4_000 }, () => ({ value: 'x' })),
      });
    });
    // A byte-bounded response can split one requested page into many chunks.
    // Do not overlap another request until the complete current page is consumed.
    expect(port.posted).toHaveLength(2);

    act(() => {
      port.deliver({
        type: 'chunk',
        start: 4_003,
        rows: Array.from({ length: 6_000 }, () => ({ value: 'x' })),
      });
    });
    expect(port.posted.at(-1)).toEqual({
      type: 'requestRows',
      start: 10_003,
      count: 2,
    });

    act(() => {
      port.deliver({
        type: 'chunk',
        start: 10_003,
        rows: [{ value: 'y' }, { value: 'z' }],
      });
    });

    const output = mount.querySelector('[data-testid="text-output"]');
    expect(output?.textContent).toHaveLength(10_005);
    expect(output?.textContent?.slice(0, 3)).toBe('abc');
    expect(output?.textContent?.slice(-2)).toBe('yz');
  });
});
