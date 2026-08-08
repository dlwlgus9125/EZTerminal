import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

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
