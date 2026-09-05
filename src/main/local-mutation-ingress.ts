/** Raised when a renderer tries to begin a state-changing IPC after quit starts. */
export class LocalMutationIngressClosedError extends Error {
  constructor(readonly ingressName: string) {
    super(`${ingressName} is closed.`);
    this.name = 'LocalMutationIngressClosedError';
  }
}

/** Observe a non-cancellable host Promise while letting ingress shutdown stop waiting for it. */
export function raceLocalOperationWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = (): void => fail(
      signal.reason ?? new DOMException('Local operation was aborted.', 'AbortError'),
    );
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      fail,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Process-local admission fence for independently registered IPC handlers.
 *
 * A handler is tracked before its callback is invoked. Closing is synchronous,
 * excludes every later admission, and returns one stable Promise that resolves
 * only after every already-admitted callback has settled.
 */
export class LocalMutationIngress {
  private readonly active = new Set<Promise<void>>();
  private readonly lifecycle = new AbortController();
  private closed = false;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly name: string) {}

  /**
   * Gate a synchronous callback without adding it to the async drain. JavaScript
   * cannot run closeAndDrain between this admission check and callback return.
   */
  tryRunSync<T>(operation: () => T):
    | { readonly accepted: true; readonly value: T }
    | { readonly accepted: false } {
    if (this.closed) return { accepted: false };
    return { accepted: true, value: operation() };
  }

  run<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LocalMutationIngressClosedError(this.name));

    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    this.active.add(completion);
    return new Promise<T>((resolve, reject) => {
      let result: T | PromiseLike<T>;
      try {
        result = operation(this.lifecycle.signal);
      } catch (error) {
        this.finish(completion, finish);
        reject(error);
        return;
      }
      Promise.resolve(result).then(
        (value) => {
          this.finish(completion, finish);
          resolve(value);
        },
        (error: unknown) => {
          this.finish(completion, finish);
          reject(error);
        },
      );
    });
  }

  closeAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.closed = true;
    this.lifecycle.abort(new DOMException(`${this.name} is closed.`, 'AbortError'));
    const drain = this.drainActive();
    this.drainPromise = drain;
    return drain;
  }

  private finish(completion: Promise<void>, resolve: () => void): void {
    this.active.delete(completion);
    resolve();
  }

  private async drainActive(): Promise<void> {
    for (;;) {
      const active = [...this.active];
      if (active.length === 0) return;
      await Promise.all(active);
    }
  }
}
