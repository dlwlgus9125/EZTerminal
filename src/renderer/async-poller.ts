export interface AsyncPollOptions {
  readonly task: () => void | Promise<void>;
  readonly intervalMs: () => number;
  readonly runImmediately?: boolean;
  readonly onError?: (error: unknown) => void;
}

/**
 * Run one observational task at a time. The delay starts only after the prior
 * task settles, and stop() prevents late completions from scheduling again.
 */
export function startAsyncPoll(options: AsyncPollOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(run, Math.max(1, Math.trunc(delayMs)));
  };
  const run = (): void => {
    if (stopped) return;
    timer = null;
    void Promise.resolve()
      .then(options.task)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        if (!stopped) schedule(options.intervalMs());
      });
  };

  if (options.runImmediately === false) schedule(options.intervalMs());
  else run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
