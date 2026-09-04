import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_RESOURCE_GRACE_MS = 3_000;
const DEFAULT_RESOURCE_FORCE_MS = 1_000;

export interface GuardedProcessResource {
  /** Stable diagnostic identity. Duplicate live ids are rejected. */
  readonly id: string;
  /** Ask the resource to drain protocol state and stop accepting work. */
  readonly gracefulStop: (reason: string) => void | Promise<void>;
  /** Terminate the underlying process or native process group. */
  readonly forceStop: (reason: string) => void | Promise<void>;
  /** Optional observation used when gracefulStop only drains an outer broker. */
  readonly hasStopped?: () => boolean;
}

export interface ProcessResourceGuardianOptions {
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface GuardedProcessRecord {
  readonly resource: GuardedProcessResource;
  stop: Promise<void> | null;
}

/**
 * App-level registry for terminal/provider process owners.
 *
 * The native ProcessGuardian below remains the crash-grade Windows Job Object
 * boundary. This registry supplies deterministic graceful-then-force shutdown
 * on an ordinary Quit, including resources registered while shutdown is
 * already in progress. Every resource's stop pipeline is created at most once.
 */
export class ProcessResourceGuardian {
  private readonly records = new Map<string, GuardedProcessRecord>();
  private readonly gracefulTimeoutMs: number;
  private readonly forceTimeoutMs: number;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private stopReason = 'app-quit';

  constructor(private readonly options: ProcessResourceGuardianOptions = {}) {
    this.gracefulTimeoutMs = Math.max(1, options.gracefulTimeoutMs ?? DEFAULT_RESOURCE_GRACE_MS);
    this.forceTimeoutMs = Math.max(1, options.forceTimeoutMs ?? DEFAULT_RESOURCE_FORCE_MS);
  }

  register(resource: GuardedProcessResource): () => void {
    if (!resource.id.trim()) throw new Error('Guarded process resource id is required.');
    if (this.records.has(resource.id)) {
      throw new Error(`Guarded process resource already registered: ${resource.id}`);
    }
    const record: GuardedProcessRecord = { resource, stop: null };
    this.records.set(resource.id, record);
    if (this.stopping) {
      // A process that appears during shutdown must join the same ownership
      // boundary instead of escaping because the initial snapshot was taken.
      record.stop = this.stopRecord(record, this.stopReason);
    }
    return () => {
      if (!record.stop && !this.stopping && this.records.get(resource.id) === record) {
        this.records.delete(resource.id);
      }
    };
  }

  stopAll(reason = 'app-quit'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopReason = reason;
    this.stopPromise = this.drain(reason);
    return this.stopPromise;
  }

  private async drain(reason: string): Promise<void> {
    let drained = false;
    while (!drained) {
      const records = [...this.records.values()];
      for (const record of records) {
        record.stop ??= this.stopRecord(record, reason);
      }
      await Promise.all(records.map((record) => record.stop));
      const current = [...this.records.values()];
      drained = current.length === records.length
        && current.every((record) => records.includes(record));
    }
  }

  private async stopRecord(record: GuardedProcessRecord, reason: string): Promise<void> {
    const { resource } = record;
    let gracefulCompleted = false;
    try {
      gracefulCompleted = await this.runBounded(
        () => resource.gracefulStop(reason),
        this.gracefulTimeoutMs,
      );
    } catch (error) {
      this.report(`graceful stop failed for "${resource.id}"`, error);
    }

    let stopped = false;
    if (gracefulCompleted) {
      try {
        stopped = resource.hasStopped?.() ?? true;
      } catch (error) {
        this.report(`stop observation failed for "${resource.id}"`, error);
      }
    }
    if (stopped) return;

    try {
      const forceCompleted = await this.runBounded(
        () => resource.forceStop(reason),
        this.forceTimeoutMs,
      );
      if (!forceCompleted) {
        this.report(
          `force stop timed out for "${resource.id}"`,
          new Error(`Force stop exceeded ${String(this.forceTimeoutMs)}ms.`),
        );
      }
    } catch (error) {
      this.report(`force stop failed for "${resource.id}"`, error);
    }
  }

  private async runBounded(
    action: () => void | Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const completed = Promise.resolve().then(action).then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([completed, timedOut]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private report(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics cannot be allowed to strand child processes.
    }
  }
}

interface GuardianReady {
  readonly type: 'ready';
  readonly owner_pid: number;
}

interface GuardianResult {
  readonly type: 'ok' | 'error';
  readonly id: string;
  readonly message?: string;
}

type GuardianMessage = GuardianReady | GuardianResult;

interface PendingCommand {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface ProcessGuardianStartOptions {
  readonly executablePath: string;
  readonly ownerPid: number;
  readonly readyTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly spawnProcess?: () => ChildProcessWithoutNullStreams;
  readonly reportError?: (message: string) => void;
}

/**
 * Main-side client for the native Windows Job Object owner.
 *
 * The child must remain outside the root job, so it is forked before the native
 * side assigns this main process. Losing either side closes the only job handle
 * and lets Windows terminate every enrolled descendant.
 */
export class ProcessGuardian {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly lines: ReadlineInterface;
  private readonly commandTimeoutMs: number;
  private exited = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    commandTimeoutMs: number,
    private readonly reportError: (message: string) => void,
  ) {
    this.commandTimeoutMs = Math.max(1, commandTimeoutMs);
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  }

  static start(options: ProcessGuardianStartOptions): Promise<ProcessGuardian> {
    const child = options.spawnProcess?.() ?? spawn(
      options.executablePath,
      ['--process-guardian', '--owner-pid', String(options.ownerPid)],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const guardian = new ProcessGuardian(
      child,
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      options.reportError ?? (() => undefined),
    );
    return guardian.awaitReady(
      options.ownerPid,
      Math.max(1, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
    );
  }

  private awaitReady(expectedOwnerPid: number, timeoutMs: number): Promise<ProcessGuardian> {
    return new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;
      const finishFailure = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        finishFailure(new Error(`process guardian did not become ready within ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });
      const onReadyLine = (line: string): void => {
        let message: GuardianMessage;
        try {
          message = JSON.parse(line) as GuardianMessage;
        } catch {
          finishFailure(new Error('process guardian emitted invalid startup JSON'));
          return;
        }
        if (message.type !== 'ready') {
          finishFailure(new Error('process guardian emitted a command result before ready'));
          return;
        }
        if (message.owner_pid !== expectedOwnerPid) {
          finishFailure(new Error('process guardian acknowledged the wrong owner process'));
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lines.off('line', onReadyLine);
        this.installRuntimeListeners();
        resolve(this);
      };
      this.lines.on('line', onReadyLine);
      this.child.once('error', (error) => finishFailure(error));
      this.child.once('exit', (code) => {
        finishFailure(new Error(
          `process guardian exited before ready (code=${String(code)}${stderr ? `, ${stderr.trim()}` : ''})`,
        ));
      });
    });
  }

  private installRuntimeListeners(): void {
    this.lines.on('line', (line) => this.handleLine(line));
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', (code) => {
      this.exited = true;
      this.failAll(new Error(`process guardian exited unexpectedly (code=${String(code)})`));
    });
    this.child.stderr.on('data', (chunk: string | Buffer) => {
      const message = chunk.toString().trim();
      if (message) this.reportError(`[process-guardian] ${message}`);
    });
  }

  private handleLine(line: string): void {
    let message: GuardianMessage;
    try {
      message = JSON.parse(line) as GuardianMessage;
    } catch {
      this.reportError('[process-guardian] ignored malformed response');
      return;
    }
    if (message.type === 'ready') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'ok') pending.resolve();
    else pending.reject(new Error(message.message ?? 'process guardian command failed'));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private command(payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.exited || !this.child.stdin.writable) {
      return Promise.reject(new Error('process guardian is unavailable'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`process guardian command timed out after ${String(this.commandTimeoutMs)}ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { timer, resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  createGroup(groupId: string, pid: number, parentGroupId?: string): Promise<void> {
    return this.command({
      type: 'create-group',
      group_id: groupId,
      pid,
      ...(parentGroupId ? { parent_group_id: parentGroupId } : {}),
    });
  }

  terminateGroup(groupId: string): Promise<void> {
    return this.command({ type: 'terminate-group', group_id: groupId });
  }

  armRootDeadline(timeoutMs: number): Promise<void> {
    return this.command({ type: 'arm-root-deadline', timeout_ms: Math.max(1, timeoutMs) });
  }

  shellHandoff(action: 'open' | 'reveal', target: string): Promise<void> {
    return this.command({ type: 'shell-handoff', action, target });
  }
}
