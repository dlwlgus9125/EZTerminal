// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../shared/ipc';
import { ConnectionInfoPanel } from './ConnectionInfoPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ConnectionInfoPanel security readiness', () => {
  it('surfaces the fail-closed token error and never requests the token', async () => {
    const getRemoteToken = vi.fn(async () => 'must-not-be-read');
    const api = {
      getRemoteConnectionInfo: async () => ({ urls: ['ws://127.0.0.1:7420'], port: 7420 }),
      getRemoteToken,
      getRemoteSecurityStatus: async () => ({
        state: 'error',
        error: 'The remote access token could not be stored securely. Remote access remains off.',
      }),
      getRemoteEnabled: async () => true,
    } as unknown as EzTerminalApi;
    Object.defineProperty(window, 'ezterminal', { configurable: true, value: api });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ConnectionInfoPanel />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="pairing-security-error"]')?.textContent).toMatch(/stored securely/);
    expect(getRemoteToken).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
