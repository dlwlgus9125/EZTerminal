import { describe, expect, it, vi } from 'vitest';

import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';
import {
  DaemonAuthorityShutdown,
  closeDaemonStoreAfterAuthorityDrain,
  disposeAgentsForAuthorityAvailability,
} from './daemon-authority-shutdown';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve: () => resolve?.() };
}

describe('DaemonAuthorityShutdown', () => {
  it('closes all ingress, drains automation, and waits slow startup before the durable Agent stop', async () => {
    const order: string[] = [];
    const automation = deferred();
    const agents = deferred();
    const startup = deferred();
    const availability = Promise.resolve<DaemonAuthorityAvailability>({
      state: 'ready',
      supportedSchemaVersion: 3,
      currentSchemaVersion: 3,
    });
    const disposeAgents = vi.fn((mode: 'explicit-quit' | 'process-loss') => {
      order.push(`agents:${mode}`);
      return agents.promise;
    });
    let mcpStops = 0;
    const shutdown = new DaemonAuthorityShutdown({
      closeCommandIngress: () => { order.push('ingress'); },
      closeProviderIngress: () => { order.push('provider-ipc'); },
      beginAgentShutdown: () => { order.push('agent-abort'); },
      stopAutomation: () => {
        order.push('automation');
        return automation.promise;
      },
      stopAgents: () => disposeAgentsForAuthorityAvailability(availability, disposeAgents),
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
    expect(order).toEqual(['ingress', 'provider-ipc', 'agent-abort', 'automation', 'mcp-1']);

    automation.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).not.toContain('agents:explicit-quit');
    expect(order).not.toContain('mcp-2');

    startup.resolve();
    await vi.waitFor(() => expect(order).toContain('agents:explicit-quit'));
    expect(order).not.toContain('mcp-2');

    agents.resolve();
    await stop;
    expect(order).toEqual([
      'ingress',
      'provider-ipc',
      'agent-abort',
      'automation',
      'mcp-1',
      'agents:explicit-quit',
      'mcp-2',
    ]);
    expect(disposeAgents).toHaveBeenCalledWith('explicit-quit');
    expect(shutdown.hasStopped()).toBe(true);
  });

  it('uses process-loss cleanup in safe mode and closes the store only after the exact barrier', async () => {
    const order: string[] = [];
    const startupFailure = Promise.reject(new Error('database initialization failed'));
    const availability = startupFailure.then<
      DaemonAuthorityAvailability,
      DaemonAuthorityAvailability
    >(
      () => ({
        state: 'ready',
        supportedSchemaVersion: 3,
        currentSchemaVersion: 3,
      }),
      () => ({
        state: 'legacy-only-safe-mode',
        initializationCode: 'database-corrupt',
        databaseDisposition: 'quarantined',
        supportedSchemaVersion: 3,
      }),
    );
    const disposeAgents = vi.fn(async (mode: 'explicit-quit' | 'process-loss') => {
      order.push(`agents:${mode}`);
    });
    const concurrentDrain = deferred();
    const shutdown = new DaemonAuthorityShutdown({
      closeCommandIngress: () => { order.push('ingress'); },
      closeProviderIngress: () => { order.push('provider-ipc'); },
      beginAgentShutdown: () => { order.push('agent-abort'); },
      stopAutomation: async () => undefined,
      stopAgents: () => disposeAgentsForAuthorityAvailability(availability, disposeAgents),
      stopMcp: async () => undefined,
    });
    shutdown.bindStartup(startupFailure);

    const closeStore = vi.fn(async () => { order.push('store-close'); });
    const closing = closeDaemonStoreAfterAuthorityDrain({
      authorityStop: shutdown.stop(),
      concurrentDrains: [concurrentDrain.promise],
      prepareForClose: () => { order.push('prepare-store-close'); },
      closeStore,
    });

    await vi.waitFor(() => expect(disposeAgents).toHaveBeenCalledWith('process-loss'));
    expect(shutdown.hasStopped()).toBe(true);
    expect(closeStore).not.toHaveBeenCalled();

    concurrentDrain.resolve();
    await closing;
    expect(order.indexOf('agents:process-loss')).toBeLessThan(order.indexOf('store-close'));
    expect(order.slice(-2)).toEqual(['prepare-store-close', 'store-close']);
  });

  it('still runs later shutdown stages and rejects the exact barrier when one stage fails', async () => {
    const stopAgents = vi.fn(async () => undefined);
    const stopMcp = vi.fn(async () => undefined);
    const shutdown = new DaemonAuthorityShutdown({
      closeCommandIngress: () => undefined,
      closeProviderIngress: () => undefined,
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
