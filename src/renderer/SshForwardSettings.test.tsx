// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalDesktopApi } from '../shared/ipc';
import type { SshForwardInfo } from '../shared/ssh-forward';
import { SshForwardSettings } from './SshForwardSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('SshForwardSettings', () => {
  it('lists bounded listener metadata and stops by connection ownership tuple', async () => {
    const forward: SshForwardInfo = {
      forwardId: 'forward-1',
      connectionId: 'connection-1234',
      bindHost: '127.0.0.1',
      localPort: 15432,
      remoteHost: 'db.internal',
      remotePort: 5432,
      state: 'listening',
    };
    const listSshForwards = vi.fn()
      .mockResolvedValueOnce([forward])
      .mockResolvedValue([]);
    const stopSshForward = vi.fn(async () => ({ ok: true, forwards: [forward] } as const));
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: { listSshForwards, stopSshForward } as unknown as EzTerminalDesktopApi,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SshForwardSettings />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('127.0.0.1:15432');
    expect(container.textContent).toContain('db.internal:5432');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-ssh-forward-stop-forward-1"]')!.click();
      await Promise.resolve();
    });
    expect(stopSshForward).toHaveBeenCalledWith('connection-1234', 'forward-1');
    expect(container.textContent).toContain('No active loopback forwards.');

    act(() => root.unmount());
  });
});
