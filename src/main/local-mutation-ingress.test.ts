import { describe, expect, it } from 'vitest';

import {
  LocalMutationIngress,
  LocalMutationIngressClosedError,
  raceLocalOperationWithAbort,
} from './local-mutation-ingress';

describe('LocalMutationIngress', () => {
  it('closes synchronously, rejects new work, and drains the exact admitted prefix', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const ingress = new LocalMutationIngress('desktop Agent mutations');
    const operation = ingress.run(async () => {
      await blocked;
      return 'finished';
    });

    let drainSettled = false;
    const draining = ingress.closeAndDrain();
    const drain = draining.then(() => { drainSettled = true; });
    expect(ingress.closeAndDrain()).toBe(draining);
    await expect(ingress.run(() => 'too late')).rejects.toBeInstanceOf(LocalMutationIngressClosedError);
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    release();
    await expect(operation).resolves.toBe('finished');
    await drain;
    expect(drainSettled).toBe(true);
  });

  it('tracks a handler before invoking it so a re-entrant close cannot miss that handler', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const ingress = new LocalMutationIngress('Project Map mutations');
    let drain: Promise<void> | undefined;

    const operation = ingress.run(async () => {
      drain = ingress.closeAndDrain();
      await blocked;
    });
    expect(drain).toBeDefined();
    let drainSettled = false;
    void drain!.then(() => { drainSettled = true; });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    release();
    await operation;
    await drain;
  });

  it('drains rejected handlers without changing their caller-visible failure', async () => {
    const error = new Error('mutation failed');
    const ingress = new LocalMutationIngress('failing mutations');
    const operation = ingress.run(async () => { throw error; });

    await ingress.closeAndDrain();
    await expect(operation).rejects.toBe(error);
  });

  it('aborts admitted cancellable work before waiting for the drain', async () => {
    const ingress = new LocalMutationIngress('cancellable mutations');
    let observedSignal: AbortSignal | undefined;
    const operation = ingress.run((signal) => new Promise<'aborted'>((resolve) => {
      observedSignal = signal;
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    }));

    const drain = ingress.closeAndDrain();
    await expect(operation).resolves.toBe('aborted');
    await drain;
    expect(observedSignal?.aborted).toBe(true);
  });

  it('releases the drain for a non-cancellable host operation and observes its late result', async () => {
    let resolveHost!: (value: string) => void;
    const hostOperation = new Promise<string>((resolve) => { resolveHost = resolve; });
    const ingress = new LocalMutationIngress('native dialog');
    const operation = ingress.run((signal) => raceLocalOperationWithAbort(hostOperation, signal));

    const drain = ingress.closeAndDrain();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await drain;

    // A native dialog can settle after the app-owned ingress is gone. The
    // helper keeps observing that Promise without re-entering product code.
    resolveHost('late native result');
    await Promise.resolve();
  });

  it('rejects synchronous remote callbacks after close without invoking them', async () => {
    const ingress = new LocalMutationIngress('remote Agent callbacks');
    await ingress.closeAndDrain();
    let invoked = false;

    const result = ingress.tryRunSync(() => {
      invoked = true;
      return 'mutated';
    });

    expect(result).toEqual({ accepted: false });
    expect(invoked).toBe(false);
  });
});
