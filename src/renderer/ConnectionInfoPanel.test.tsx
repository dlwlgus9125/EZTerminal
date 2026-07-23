// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalApi } from '../shared/ipc';
import { createCapabilityAccess } from './capability-access';
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
      getRemoteRuntimeStatus: async () => ({
        desiredEnabled: true,
        state: 'error',
        port: 7420,
        errorCode: 'REMOTE_TOKEN_UNAVAILABLE',
        error: 'The remote access token is unavailable.',
      }),
      onRemoteRuntimeStatus: () => () => undefined,
    } as unknown as EzTerminalApi;
    const capabilities = createCapabilityAccess({
      readCore: () => api,
      readDesktop: () => undefined,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ConnectionInfoPanel capabilities={capabilities} />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="pairing-security-error"]')?.textContent).toMatch(/stored securely/);
    expect(getRemoteToken).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('shows bind failure and retry instead of pairing data until the listener is running', async () => {
    const retryRemoteRuntime = vi.fn(async () => ({
      desiredEnabled: true,
      state: 'running' as const,
      port: 7420,
      errorCode: null,
      error: null,
    }));
    const api = {
      getRemoteConnectionInfo: async () => ({ urls: ['ws://127.0.0.1:7420'], port: 7420 }),
      getRemoteToken: async () => 'pairing-token',
      getRemoteSecurityStatus: async () => ({ state: 'ready' as const, error: null }),
      getRemoteRuntimeStatus: async () => ({
        desiredEnabled: true,
        state: 'error' as const,
        port: 7420,
        errorCode: 'EADDRINUSE',
        error: 'Port 7420 is already in use.',
      }),
      retryRemoteRuntime,
      onRemoteRuntimeStatus: () => () => undefined,
    } as unknown as EzTerminalApi;
    const capabilities = createCapabilityAccess({
      readCore: () => api,
      readDesktop: () => undefined,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ConnectionInfoPanel capabilities={capabilities} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="pairing-runtime-error"]')?.textContent).toContain('7420');
    expect(container.querySelector('[data-testid="connection-url"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="pairing-runtime-retry"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(retryRemoteRuntime).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
