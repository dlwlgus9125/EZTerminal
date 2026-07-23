import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../../src/shared/ipc';
import { getRunPortBroker } from '../../src/renderer/run-port-broker';
import { MobileSessionView } from './MobileSessionView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/Block', () => ({ Block: () => null }));

let host: HTMLDivElement;
let root: Root;
let rootMounted: boolean;
let previousApi: EzTerminalApi | undefined;

function apiWithoutHandoff(): EzTerminalApi {
  return {
    runCommand: vi.fn(() => Promise.resolve()),
    attachRun: vi.fn(() => Promise.resolve()),
    listRuns: vi.fn(() => Promise.resolve([])),
    onRunStarted: vi.fn(() => () => undefined),
    onSessionDead: vi.fn(() => () => undefined),
  } as unknown as EzTerminalApi;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submitRun(): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-testid="cmd-input"]')!;
  await act(async () => {
    setInputValue(input, 'echo pending');
  });
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="btn-run"]')!.click();
  });
}

beforeEach(async () => {
  previousApi = window.ezterminal;
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: apiWithoutHandoff(),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  rootMounted = true;
  await act(async () => {
    root.render(<MobileSessionView sessionId="session-handoff" connected />);
  });
});

afterEach(() => {
  if (rootMounted) act(() => root.unmount());
  host.remove();
  if (previousApi) {
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: previousApi,
    });
  } else {
    Reflect.deleteProperty(window, 'ezterminal');
  }
});

describe('MobileSessionView run-port lifecycle', () => {
  it('aborts a pending handoff when its terminal view unmounts', async () => {
    await submitRun();
    expect(getRunPortBroker().pendingCount).toBe(1);

    act(() => root.unmount());
    rootMounted = false;
    await act(async () => Promise.resolve());

    expect(getRunPortBroker().pendingCount).toBe(0);
  });

  it('aborts and removes a pending handoff on disconnect', async () => {
    await submitRun();
    expect(getRunPortBroker().pendingCount).toBe(1);
    expect(host.querySelectorAll('[data-testid="block"]')).toHaveLength(1);

    await act(async () => {
      root.render(<MobileSessionView sessionId="session-handoff" connected={false} />);
    });

    expect(getRunPortBroker().pendingCount).toBe(0);
    expect(host.querySelectorAll('[data-testid="block"]')).toHaveLength(0);
  });
});
