import { describe, expect, it, vi } from 'vitest';

import { DaemonAuthorityShutdown } from './daemon-authority-shutdown';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve: () => resolve?.() };
}

describe('DaemonAuthorityShutdown', () => {
  it('closes ingress synchronously, drains automation, then performs the durable Agent stop', async () => {
    const order: string[] = [];
    const automation = deferred();
    const agents = deferred();
    const startup = deferred();
    let mcpStops = 0;
    const shutdown = new DaemonAuthorityShutdown({
      closeCommandIngress: () => { order.push('ingress'); },
      beginAgentShutdown: () => { order.push('agent-abort'); },
      stopAutomation: () => {
        order.push('automation');
        return automation.promise;
      },
      stopAgents: () => {
        order.push('agents');
        return agents.promise;
      },
      stopMcp: async () => {
        mcpStops += 1;
        order.push(`mcp-${String(mcpStops)}`);
      },
    });
    shutdown.bindStartup(startup.promise);

    const stop = shutdown.stop();
    expect(shutdown.stop()).toBe(stop);
    expect(shutdown.isStopping()).toBe(true);
    expect(shutdown.hasStopped()).toBe(false);
    expect(order).toEqual(['ingress', 'agent-abort', 'automation', 'mcp-1']);

    automation.resolve();
    await vi.waitFor(() => expect(order).toContain('agents'));
    expect(order).not.toContain('mcp-2');

    agents.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).not.toContain('mcp-2');

    startup.resolve();
    await stop;
    expect(order).toEqual(['ingress', 'agent-abort', 'automation', 'mcp-1', 'agents', 'mcp-2']);
    expect(shutdown.hasStopped()).toBe(true);
  });

  it('still runs later shutdown stages and rejects the exact barrier when one stage fails', async () => {
    const stopAgents = vi.fn(async () => undefined);
    const stopMcp = vi.fn(async () => undefined);
    const shutdown = new DaemonAuthorityShutdown({
      closeCommandIngress: () => undefined,
      beginAgentShutdown: () => undefined,
      stopAutomation: async () => { throw new Error('automation drain failed'); },
      stopAgents,
      stopMcp,
    });
    shutdown.bindStartup(Promise.resolve());

    await expect(shutdown.stop()).rejects.toThrow(/drain automation dispatch/u);
    expect(stopAgents).toHaveBeenCalledOnce();
    expect(stopMcp).toHaveBeenCalledTimes(2);
    expect(shutdown.hasStopped()).toBe(false);
  });
});
