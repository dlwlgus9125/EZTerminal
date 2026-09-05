import { describe, expect, it, vi } from 'vitest';

import { OwnedStartupBarrier, waitForStartupGroup } from './owned-startup-barrier';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('OwnedStartupBarrier', () => {
  it.each([
    ['Agent hook infrastructure startup', 2],
    ['Project Map store startup', 4],
    ['Agent collaboration startup', 3],
  ] as const)('waits for every %s sibling after one of %i initializers rejects', async (name, count) => {
    const delayed = deferred<void>();
    const failure = new Error(`${name} failed`);
    let settled = false;
    const startup = waitForStartupGroup(name, [
      Promise.reject(failure),
      ...Array.from({ length: count - 2 }, () => Promise.resolve()),
      delayed.promise,
    ]).catch((error: unknown) => {
      settled = true;
      throw error;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    delayed.resolve();
    await expect(startup).rejects.toEqual(expect.objectContaining({
      errors: [failure],
    }));
    expect(settled).toBe(true);
  });

  it('prevents a deferred startup from publishing after shutdown and drains partial cleanup', async () => {
    const readiness = deferred<void>();
    const barrier = new OwnedStartupBarrier('main-owned runtime startup');
    const publish = vi.fn();
    const disposePartial = vi.fn();

    const startup = barrier.run(async (signal) => {
      try {
        await readiness.promise;
        barrier.checkpoint(signal);
        publish();
      } finally {
        if (signal.aborted) disposePartial();
      }
    }).catch(() => undefined);

    let stopped = false;
    const stopping = barrier.closeAndDrain().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    readiness.resolve();
    await Promise.all([startup, stopping]);

    expect(publish).not.toHaveBeenCalled();
    expect(disposePartial).toHaveBeenCalledOnce();
  });

  it('drains concurrent hook and interpreter startup before cleaning a late process', async () => {
    const hookStart = deferred<void>();
    const interpreterSpawn = deferred<{ stop(): void }>();
    const barrier = new OwnedStartupBarrier('main-owned runtime startup');
    const publishHook = vi.fn();
    const publishBroker = vi.fn();
    const publishSsh = vi.fn();
    const stopInterpreter = vi.fn();
    let interpreter: { stop(): void } | null = null;

    const hookStartup = barrier.run(async (signal) => {
      await hookStart.promise;
      barrier.checkpoint(signal);
      publishHook();
    }).catch(() => undefined);
    const terminalStartup = barrier.run(async (signal) => {
      interpreter = await interpreterSpawn.promise;
      barrier.checkpoint(signal);
      publishBroker();
      publishSsh();
    }).catch(() => undefined);

    let shutdownSettled = false;
    const shutdown = barrier.closeAndDrain().then(() => {
      interpreter?.stop();
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    hookStart.resolve();
    interpreterSpawn.resolve({ stop: stopInterpreter });
    await Promise.all([hookStartup, terminalStartup, shutdown]);

    expect(publishHook).not.toHaveBeenCalled();
    expect(publishBroker).not.toHaveBeenCalled();
    expect(publishSsh).not.toHaveBeenCalled();
    expect(stopInterpreter).toHaveBeenCalledOnce();
  });

  it('holds shutdown across a deferred interpreter recovery and discards its candidate', async () => {
    const spawned = deferred<{ kill(): void }>();
    const barrier = new OwnedStartupBarrier('main-owned runtime startup');
    const publishRecovery = vi.fn();
    const killCandidate = vi.fn();
    let candidate: { kill(): void } | null = null;

    const recovery = barrier.run(async (signal) => {
      try {
        candidate = await spawned.promise;
        barrier.checkpoint(signal);
        publishRecovery(candidate);
      } catch (error) {
        candidate?.kill();
        throw error;
      }
    }).catch(() => undefined);
    let shutdownSettled = false;
    const shutdown = barrier.closeAndDrain().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    spawned.resolve({ kill: killCandidate });
    await Promise.all([recovery, shutdown]);

    expect(publishRecovery).not.toHaveBeenCalled();
    expect(killCandidate).toHaveBeenCalledOnce();
    expect(shutdownSettled).toBe(true);
  });

  it('releases every registered cleanup once even when an earlier cleanup throws', () => {
    const barrier = new OwnedStartupBarrier('main-owned runtime startup');
    const first = vi.fn(() => { throw new Error('first cleanup failed'); });
    const second = vi.fn();
    barrier.addCleanup(first);
    barrier.addCleanup(second);

    expect(() => barrier.releaseCleanups()).toThrow(AggregateError);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    barrier.releaseCleanups();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
