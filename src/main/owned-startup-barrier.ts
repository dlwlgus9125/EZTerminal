import { LocalMutationIngress } from './local-mutation-ingress';

/** Waits for every sibling initializer before reporting any startup failure. */
export async function waitForStartupGroup(
  name: string,
  startups: readonly PromiseLike<unknown>[],
): Promise<void> {
  const outcomes = await Promise.allSettled(startups);
  const failures = outcomes.flatMap((outcome) => (
    outcome.status === 'rejected' ? [outcome.reason] : []
  ));
  if (failures.length > 0) throw new AggregateError(failures, `${name} failed.`);
}

/** Owns one late-publishing startup sequence across an overlapping shutdown. */
export class OwnedStartupBarrier {
  private readonly ingress: LocalMutationIngress;
  private readonly cleanups = new Set<() => void>();

  constructor(readonly name: string) {
    this.ingress = new LocalMutationIngress(name);
  }

  run<T>(startup: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    return this.ingress.run(startup);
  }

  checkpoint(signal: AbortSignal): void {
    signal.throwIfAborted();
  }

  addCleanup(cleanup: () => void): void {
    this.cleanups.add(cleanup);
  }

  releaseCleanups(): void {
    const cleanups = [...this.cleanups];
    this.cleanups.clear();
    const failures: unknown[] = [];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${this.name} cleanup failed.`);
  }

  closeAndDrain(): Promise<void> {
    return this.ingress.closeAndDrain();
  }
}
