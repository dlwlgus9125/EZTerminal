export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface GracefulShutdownTask {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly tasks: readonly GracefulShutdownTask[];
  readonly continueQuit: () => void;
  readonly timeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
}

type ShutdownPhase = 'idle' | 'draining' | 'exit-allowed';

export class GracefulShutdownTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Graceful shutdown exceeded ${String(timeoutMs)}ms`);
    this.name = 'GracefulShutdownTimeoutError';
  }
}

/**
 * Owns the Electron before-quit handshake.
 *
 * The first quit request is held while every registered cleanup starts once.
 * Repeated quit requests share that drain. Completion or a bounded timeout
 * then opens the exit gate before reissuing quit, so Electron's re-entrant
 * before-quit event can proceed without starting cleanup again.
 */
export class GracefulShutdownCoordinator {
  private readonly timeoutMs: number;
  private phase: ShutdownPhase = 'idle';

  constructor(private readonly options: GracefulShutdownOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
  }

  handleBeforeQuit(event: BeforeQuitEvent): void {
    if (this.phase === 'exit-allowed') return;

    event.preventDefault();
    if (this.phase === 'draining') return;

    this.phase = 'draining';
    this.startDrain();
  }

  private report(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics must not strand the shutdown sequence.
    }
  }

  private startDrain(): void {
    const pendingTasks = this.options.tasks.map((task) => {
      try {
        return Promise.resolve(task.run()).catch((error: unknown) => {
          this.report(`shutdown task "${task.name}" failed`, error);
        });
      } catch (error) {
        this.report(`shutdown task "${task.name}" failed`, error);
        return Promise.resolve();
      }
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const tasksSettled = Promise.all(pendingTasks).then(() => 'settled' as const);
    const timedOut = new Promise<'timed-out'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timed-out'), this.timeoutMs);
    });

    void Promise.race([tasksSettled, timedOut]).then((outcome) => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (outcome === 'timed-out') {
        this.report(
          'graceful shutdown timed out',
          new GracefulShutdownTimeoutError(this.timeoutMs),
        );
      }

      this.phase = 'exit-allowed';
      try {
        this.options.continueQuit();
      } catch (error) {
        this.report('continuing application quit failed', error);
      }
    });
  }
}
