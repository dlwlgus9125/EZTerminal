import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';

export type DaemonAgentShutdownMode = 'explicit-quit' | 'process-loss';

/** Safe mode has no writable structured authority, so only provider cleanup is legal. */
export async function disposeAgentsForAuthorityAvailability(
  availability: Promise<DaemonAuthorityAvailability>,
  dispose: (mode: DaemonAgentShutdownMode) => Promise<void>,
): Promise<void> {
  const resolved = await availability;
  await dispose(resolved.state === 'ready' ? 'explicit-quit' : 'process-loss');
}

export interface DaemonAuthorityStoreCloseOptions {
  /** The exact authority shutdown barrier, not a process-guardian deadline. */
  readonly authorityStop: Promise<void>;
  readonly concurrentDrains: readonly (Promise<unknown> | undefined)[];
  readonly prepareForClose: () => void;
  readonly closeStore: () => Promise<void>;
}

/** Keeps the structured store open until every authority writer has drained. */
export async function closeDaemonStoreAfterAuthorityDrain(
  options: DaemonAuthorityStoreCloseOptions,
): Promise<void> {
  await Promise.all([options.authorityStop, ...options.concurrentDrains]);
  options.prepareForClose();
  await options.closeStore();
}

export interface DaemonAuthorityShutdownOptions {
  /** Rejects new external commands while preserving the already accepted FIFO prefix. */
  readonly closeCommandIngress: () => void;
  /** Removes desktop provider discovery/setup handlers and aborts their probes. */
  readonly closeProviderIngress: () => void;
  /** Cancels launch-capable provider work before waiting on the command FIFO. */
  readonly beginAgentShutdown: () => void;
  /** Stops automation dispatch and resolves only after its current dispatch drains. */
  readonly stopAutomation: () => Promise<void>;
  /** Persists the explicit Agent transition and then releases provider resources. */
  readonly stopAgents: () => Promise<void>;
  /** Revokes orchestration capabilities and closes the loopback MCP server. */
  readonly stopMcp: () => Promise<void>;
}

interface ShutdownFailure {
  readonly context: string;
  readonly error: unknown;
}

/**
 * Exact, idempotent shutdown barrier for the daemon command authority.
 *
 * Process guardians may put a deadline around this promise, but the SQLite
 * owner must await this exact promise before closing the authoritative store.
 */
export class DaemonAuthorityShutdown {
  private readonly startupAbortController = new AbortController();
  private stopping = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private startupSettled: Promise<void> = Promise.resolve();
  private startupBound = false;

  constructor(private readonly options: DaemonAuthorityShutdownOptions) {}

  bindStartup(startup: Promise<unknown>): void {
    if (this.startupBound) throw new Error('Daemon authority startup is already bound.');
    this.startupBound = true;
    // Startup failure is reported by its owner. Shutdown only needs proof that
    // no late startup continuation can create a new listener or provider task.
    this.startupSettled = Promise.resolve(startup).then(
      () => undefined,
      () => undefined,
    );
  }

  isStopping(): boolean {
    return this.stopping;
  }

  /** Process-lifetime gate for services that must never publish after Quit begins. */
  get startupSignal(): AbortSignal {
    return this.startupAbortController.signal;
  }

  hasStopped(): boolean {
    return this.stopped;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.startupAbortController.abort();
    const failures: ShutdownFailure[] = [];
    this.captureSynchronous('close daemon command ingress', this.options.closeCommandIngress, failures);
    this.captureSynchronous('close provider IPC ingress', this.options.closeProviderIngress, failures);
    this.captureSynchronous('begin Agent shutdown', this.options.beginAgentShutdown, failures);

    // Both calls synchronously close their respective ingress. Rejections are
    // observed immediately even though MCP is joined after startup settles.
    const automationStop = this.capture('drain automation dispatch', this.options.stopAutomation);
    const initialMcpStop = this.capture('stop orchestration MCP', this.options.stopMcp);
    this.stopPromise = this.finish(automationStop, initialMcpStop, failures);
    return this.stopPromise;
  }

  private async finish(
    automationStop: Promise<ShutdownFailure | undefined>,
    initialMcpStop: Promise<ShutdownFailure | undefined>,
    failures: ShutdownFailure[],
  ): Promise<void> {
    this.collect(await automationStop, failures);
    // daemonAuthorityReady owns the store-init barrier. Waiting for it before
    // the explicit transition prevents a slow successful migration from being
    // raced by an Agent write against an unopened database.
    await this.startupSettled;
    this.collect(await this.capture('persist and stop Agents', this.options.stopAgents), failures);
    this.collect(await initialMcpStop, failures);
    // stop() may have raced a start() before that start published its server.
    this.collect(await this.capture('stop late orchestration MCP', this.options.stopMcp), failures);
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        failures.map((failure) => failure.context).join('; '),
      );
    }
    this.stopped = true;
  }

  private capture(
    context: string,
    action: () => Promise<void>,
  ): Promise<ShutdownFailure | undefined> {
    try {
      return Promise.resolve(action()).then(
        () => undefined,
        (error): ShutdownFailure => ({ context, error }),
      );
    } catch (error) {
      return Promise.resolve({ context, error });
    }
  }

  private captureSynchronous(
    context: string,
    action: () => void,
    failures: ShutdownFailure[],
  ): void {
    try {
      action();
    } catch (error) {
      failures.push({ context, error });
    }
  }

  private collect(failure: ShutdownFailure | undefined, failures: ShutdownFailure[]): void {
    if (failure) failures.push(failure);
  }
}
