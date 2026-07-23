// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InterpreterFrame, RendererControl } from '../shared/ipc';
import { BlockController } from './block-controller';
import { AppI18nProvider } from './i18n';

// This suite exercises only the plain PTY branch. Avoid xterm/WebGL's import-
// time canvas probes, which jsdom intentionally does not implement.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));

import { PtyBlock } from './PtyBlock';

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
let pane: HTMLElement;
let mount: HTMLDivElement;
let commandInput: HTMLInputElement;
let controller: BlockController;
let port: FakePort;
let rafCallbacks: FrameRequestCallback[];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  pane = document.createElement('section');
  pane.className = 'pane';
  commandInput = document.createElement('input');
  commandInput.className = 'cmd-input';
  mount = document.createElement('div');
  pane.append(commandInput, mount);
  document.body.append(pane);

  port = new FakePort();
  controller = new BlockController('plain command', port as unknown as MessagePort);
  port.deliver({ type: 'schema', shape: 'pty', columns: [] });
  root = createRoot(mount);
  act(() => root.render(<PtyBlock controller={controller} />));
});

afterEach(() => {
  act(() => root.unmount());
  controller.dispose();
  pane.remove();
  delete document.documentElement.dataset.scrollback;
  vi.unstubAllGlobals();
});

function dispatchMenuKey(key: string, shiftKey = false): void {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }));
  });
}

function flushAnimationFrames(): void {
  const callbacks = rafCallbacks.splice(0);
  act(() => {
    for (const callback of callbacks) callback(0);
  });
}

describe('plain PTY keyboard context menu', () => {
  it('keeps the imperative plain-output DOM within the configured scrollback', () => {
    document.documentElement.dataset.scrollback = '100';
    act(() => {
      port.deliver({
        type: 'pty-data',
        data: new Uint8Array(Buffer.from(
          Array.from({ length: 150 }, (_, index) => `line-${index}`).join('\n'),
          'utf8',
        )),
      });
    });

    const text = mount.querySelector('[data-testid="text-output"]')?.textContent ?? '';
    expect(text.split('\n')).toHaveLength(100);
    expect(text).not.toContain('line-49\n');
    expect(text).toContain('line-50\n');
    expect(text).toContain('line-149');
  });

  it('exposes the terminal action menu label in Korean', () => {
    act(() => root.unmount());
    root = createRoot(mount);
    act(() => root.render(
      <AppI18nProvider locale="ko" languages={['ko']}>
        <PtyBlock controller={controller} />
      </AppI18nProvider>,
    ));

    commandInput.focus();
    dispatchMenuKey('ContextMenu');

    expect(mount.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('터미널 작업');
  });

  it('opens from Shift+F10 and restores its command invoker after Escape', () => {
    const composerBubbleHandler = vi.fn();
    commandInput.addEventListener('keydown', composerBubbleHandler);
    commandInput.focus();
    dispatchMenuKey('F10', true);

    expect(composerBubbleHandler).not.toHaveBeenCalled();
    const menu = mount.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(
      mount.querySelector<HTMLButtonElement>('[data-testid="term-ctx-paste"]'),
    );

    dispatchMenuKey('Escape');
    expect(mount.querySelector('[role="menu"]')).toBeNull();
    flushAnimationFrames();
    expect(document.activeElement).toBe(commandInput);
  });

  it('opens from ContextMenu and never restores focus across panes on outside click', () => {
    commandInput.focus();
    dispatchMenuKey('ContextMenu');
    expect(mount.querySelector('[role="menu"]')).not.toBeNull();

    const otherPane = document.createElement('section');
    otherPane.className = 'pane';
    const otherInput = document.createElement('input');
    otherPane.append(otherInput);
    document.body.append(otherPane);
    otherInput.focus();
    act(() => {
      otherInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    flushAnimationFrames();

    expect(mount.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(otherInput);
    otherPane.remove();
  });
});
