import { describe, expect, it, vi } from 'vitest';

import { mintOpenClawChatTicket } from './openclaw-chat-ticket';

describe('mintOpenClawChatTicket', () => {
  it('mints for the current HTTP Control UI without consulting its retired insecure-auth switch', async () => {
    const proxy = { port: 7421, mintTicket: vi.fn(() => 'ticket-1') };
    const dependencies = {
      isDesktopRuntimeRunning: vi.fn(() => true),
      getGatewayStatus: vi.fn(async () => ({ state: 'running' as const, port: 18789 })),
      // OpenClaw 2026.8.1 no longer has this key. A current install therefore
      // reports the legacy probe as `unset`; that must not block its supported
      // pure-JS device-identity flow on a plain-HTTP origin.
      getLegacyInsecureAuthStatus: vi.fn(async () => 'unset' as const),
      getChatToken: vi.fn(async () => 'gateway-token'),
      ensureProxy: vi.fn(async () => proxy),
      stopProxy: vi.fn(async () => undefined),
    };

    await expect(mintOpenClawChatTicket(dependencies)).resolves.toEqual({
      ticket: 'ticket-1',
      proxyPort: 7421,
      token: 'gateway-token',
    });
    expect(dependencies.getLegacyInsecureAuthStatus).not.toHaveBeenCalled();
    expect(proxy.mintTicket).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown', 'gateway-unreachable'],
    ['stopped', 'gateway-stopped'],
  ] as const)('keeps the %s gateway failure typed as %s', async (state, reason) => {
    const ensureProxy = vi.fn(async () => null);

    await expect(mintOpenClawChatTicket({
      isDesktopRuntimeRunning: () => true,
      getGatewayStatus: async () => ({ state, port: 18789 }),
      getChatToken: async () => 'gateway-token',
      ensureProxy,
      stopProxy: async () => undefined,
    })).resolves.toEqual({ ticket: null, reason });
    expect(ensureProxy).not.toHaveBeenCalled();
  });

  it('stops a proxy that finishes starting after the desktop runtime exits', async () => {
    const proxy = { port: 7421, mintTicket: vi.fn(() => 'unused') };
    const stopProxy = vi.fn(async () => undefined);
    let runtimeChecks = 0;

    await expect(mintOpenClawChatTicket({
      isDesktopRuntimeRunning: () => runtimeChecks++ === 0,
      getGatewayStatus: async () => ({ state: 'running', port: 18789 }),
      getChatToken: async () => 'gateway-token',
      ensureProxy: async () => proxy,
      stopProxy,
    })).resolves.toEqual({ ticket: null, reason: 'proxy-unavailable' });
    expect(stopProxy).toHaveBeenCalledOnce();
    expect(proxy.mintTicket).not.toHaveBeenCalled();
  });
});
