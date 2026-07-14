/**
 * A process-local FIFO gate for mutations that must not overlap.
 *
 * The first operation starts immediately (before runExclusive returns), which
 * preserves synchronous side effects such as posting create-session to the
 * interpreter. Later operations start only after the active operation settles.
 */
export interface MutationGate {
  runExclusive<T>(operation: () => T | PromiseLike<T>): Promise<T>;
}

export class AsyncMutationGate implements MutationGate {
  private busy = false;
  private readonly queue: Array<() => void> = [];

  runExclusive<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        let result: T | PromiseLike<T>;
        try {
          result = operation();
        } catch (error) {
          reject(error);
          this.finish();
          return;
        }
        Promise.resolve(result).then(
          (value) => {
            resolve(value);
            this.finish();
          },
          (error: unknown) => {
            reject(error);
            this.finish();
          },
        );
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    next();
  }

  private finish(): void {
    this.busy = false;
    this.pump();
  }
}
