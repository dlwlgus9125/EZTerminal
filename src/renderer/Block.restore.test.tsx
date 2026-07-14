// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InterpreterFrame, RendererControl } from '../shared/ipc';
import { Block } from './Block';
import { BlockController } from './block-controller';

vi.mock('./PtyBlock', () => ({ PtyBlock: () => <div data-testid="mock-pty" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakePort {
  private listener: ((event: { data: InterpreterFrame }) => void) | null = null;
  addEventListener(_type: 'message', listener: (event: { data: InterpreterFrame }) => void): void {
    this.listener = listener;
  }
  start(): void {}
  postMessage(message: RendererControl): void { void message; }
  close(): void {}
  deliver(frame: InterpreterFrame): void {
    this.listener?.({ data: frame });
  }
}

let root: Root;
let container: HTMLDivElement;
let port: FakePort;
let controller: BlockController;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  port = new FakePort();
  controller = new BlockController('!agent', port as unknown as MessagePort, { mirror: true });
  act(() => root.render(<Block controller={controller} />));
});

afterEach(() => {
  act(() => root.unmount());
  controller.dispose();
  container.remove();
});

describe('Block PTY restore warning', () => {
  it('renders the SSH late-attach warning above the terminal error', () => {
    act(() => {
      port.deliver({
        type: 'pty-restore-warning',
        reason: 'ssh-late-attach-unsupported',
        fallback: 'none',
      });
      port.deliver({ type: 'error', message: 'Late attach is not supported for SSH runs' });
    });

    const warning = container.querySelector<HTMLElement>('[data-testid="pty-restore-warning"]');
    expect(warning?.dataset.reason).toBe('ssh-late-attach-unsupported');
    expect(warning?.textContent).toContain('original session is still running');
    expect(container.querySelector('[data-testid="block-error"]')?.textContent).toContain(
      'Late attach is not supported',
    );
  });

  it('uses a generic content-free message for raw-ring fallback reasons', () => {
    act(() => {
      port.deliver({
        type: 'pty-restore-warning',
        reason: 'serializer-failed',
        fallback: 'raw-ring',
        snapshotEpoch: 10,
        streamEpoch: 11,
      });
    });
    const warning = container.querySelector('[data-testid="pty-restore-warning"]');
    expect(warning?.textContent).toBe(
      'Exact terminal state was unavailable; recent raw output was restored.',
    );
    expect(warning?.textContent).not.toContain('10');
  });
});
