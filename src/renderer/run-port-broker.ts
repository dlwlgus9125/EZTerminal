/**
 * Correlates the MessagePort handoff used by both Electron's preload bridge
 * and the mobile WebSocket adapter.
 *
 * There is exactly one window "message" listener per renderer. Callers add a
 * pending correlation before invoking the transport, which is important on
 * mobile because its in-process adapter dispatches the handoff synchronously.
 */

export type RunPortHandoffKind = 'run' | 'attach';

export type RunPortErrorCode =
  | 'timeout'
  | 'aborted'
  | 'disposed'
  | 'protocol'
  | 'unavailable';

export class RunPortError extends Error {
  readonly code: RunPortErrorCode;
  readonly kind: RunPortHandoffKind;
  readonly runId: string;

  constructor(
    code: RunPortErrorCode,
    kind: RunPortHandoffKind,
    runId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RunPortError';
    this.code = code;
    this.kind = kind;
    this.runId = runId;
  }
}

export interface RunPortRequest {
  readonly kind: RunPortHandoffKind;
  readonly runId: string;
  readonly send: () => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface PendingHandoff {
  readonly kind: RunPortHandoffKind;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly onAbort?: () => void;
  readonly resolve: (port: MessagePort) => void;
  readonly reject: (error: RunPortError) => void;
}

interface DecodedMarker {
  readonly kind: RunPortHandoffKind;
  readonly runId: string | null;
  readonly valid: boolean;
}

const DEFAULT_HANDOFF_TIMEOUT_MS = 15_000;

function markerKey(kind: RunPortHandoffKind, runId: string): string {
  return `${kind}:${runId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function decodeMarker(value: unknown): DecodedMarker | null {
  if (!isRecord(value)) return null;
  const hasRun = hasOwn(value, '_ezPort');
  const hasAttach = hasOwn(value, '_ezAttachPort');
  if (!hasRun && !hasAttach) return null;

  const kind: RunPortHandoffKind = hasAttach ? 'attach' : 'run';
  const rawRunId = value[hasAttach ? '_ezAttachPort' : '_ezPort'];
  const runId = typeof rawRunId === 'string' && rawRunId.length > 0 ? rawRunId : null;
  return {
    kind,
    runId,
    valid: hasRun !== hasAttach && Object.keys(value).length === 1 && runId !== null,
  };
}

function isUsablePort(value: unknown): value is MessagePort {
  if (!isRecord(value)) return false;
  return (
    typeof value.addEventListener === 'function'
    && typeof value.postMessage === 'function'
    && typeof value.start === 'function'
    && typeof value.close === 'function'
  );
}

export function closeRunPort(port: Pick<MessagePort, 'close'> | null | undefined): void {
  try {
    port?.close();
  } catch {
    // Closing a transferred/already-closed port is intentionally idempotent.
  }
}

/**
 * A renderer-local broker. The exported singleton is used in production;
 * constructing an instance is supported for focused protocol/lifecycle tests.
 */
export class RunPortBroker {
  private readonly pending = new Map<string, PendingHandoff[]>();
  private readonly onWindowMessage = (event: MessageEvent): void => {
    this.handleWindowMessage(event);
  };
  private disposed = false;

  constructor(private readonly targetWindow: Window) {
    targetWindow.addEventListener('message', this.onWindowMessage);
  }

  get pendingCount(): number {
    let count = 0;
    for (const queue of this.pending.values()) count += queue.length;
    return count;
  }

  request(options: RunPortRequest): Promise<MessagePort> {
    const { kind, runId, send, signal } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
    if (this.disposed) {
      return Promise.reject(this.error('disposed', kind, runId, 'Run-port broker is disposed.'));
    }
    if (runId.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(this.error('protocol', kind, runId, 'Invalid run-port request.'));
    }
    if (signal?.aborted) {
      return Promise.reject(this.abortedError(kind, runId, signal));
    }

    const key = markerKey(kind, runId);
    // A run is initiated once. Attach is different: several panes in the same
    // renderer may legitimately mirror one run, producing one same-runId port
    // transfer per caller. Those equivalent attach endpoints are handed out
    // FIFO; Electron dispatches same-channel requests in submission order.
    if (kind === 'run' && (this.pending.get(key)?.length ?? 0) > 0) {
      return Promise.reject(
        this.error('protocol', kind, runId, `A ${kind} handoff is already pending for ${runId}.`),
      );
    }

    const promise = new Promise<MessagePort>((resolve, reject) => {
      const onAbort = signal
        ? (): void => this.rejectPending(key, pending, this.abortedError(kind, runId, signal))
        : undefined;
      const pending: PendingHandoff = {
        kind,
        runId,
        signal,
        timeout: setTimeout(() => {
          this.rejectPending(
            key,
            pending,
            this.error('timeout', kind, runId, `Timed out waiting for the ${kind} port.`),
          );
        }, timeoutMs),
        onAbort,
        resolve,
        reject,
      };

      // Registration deliberately precedes send(): mobile dispatches the
      // corresponding MessageEvent before runCommand()/attachRun() returns.
      const queue = this.pending.get(key);
      if (queue) queue.push(pending);
      else this.pending.set(key, [pending]);
      signal?.addEventListener('abort', onAbort!, { once: true });

      try {
        void Promise.resolve(send()).catch((cause: unknown) => {
          this.rejectPending(
            key,
            pending,
            this.error('unavailable', kind, runId, `Failed to request the ${kind} port.`, cause),
          );
        });
      } catch (cause) {
        this.rejectPending(
          key,
          pending,
          this.error('unavailable', kind, runId, `Failed to request the ${kind} port.`, cause),
        );
      }
    });

    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.targetWindow.removeEventListener('message', this.onWindowMessage);
    for (const [key, queue] of [...this.pending]) {
      for (const pending of [...queue]) {
        this.rejectPending(
          key,
          pending,
          this.error('disposed', pending.kind, pending.runId, 'Run-port broker is disposed.'),
        );
      }
    }
  }

  private handleWindowMessage(event: MessageEvent): void {
    const marker = decodeMarker(event.data);
    if (!marker) return;

    const received = Array.from(event.ports ?? []);
    const closeReceived = (): void => {
      for (const port of received) closeRunPort(port);
    };

    // A real postMessage from an iframe has that frame as event.source. The
    // old source-OR-origin check admitted same-origin frames; both checks are
    // now mandatory. Empty origin is reserved for the mobile adapter's local
    // synthetic MessageEvent, which also has exact same-window identity.
    if (
      event.source !== this.targetWindow
      || !this.isExpectedOrigin(event.origin)
    ) {
      closeReceived();
      return;
    }

    if (!marker.valid || marker.runId === null) {
      closeReceived();
      if (marker.runId !== null) {
        const key = markerKey(marker.kind, marker.runId);
        const pending = this.pending.get(key)?.[0];
        if (pending) {
          this.rejectPending(
            key,
            pending,
            this.error('protocol', marker.kind, marker.runId, 'Malformed run-port handoff marker.'),
          );
        }
      }
      return;
    }

    const key = markerKey(marker.kind, marker.runId);
    const pending = this.pending.get(key)?.[0];
    if (!pending) {
      // Duplicate, late, or otherwise orphaned transfers must never retain a
      // live endpoint in the renderer.
      closeReceived();
      return;
    }

    const port = received.length === 1 ? received[0] : undefined;
    if (!isUsablePort(port)) {
      closeReceived();
      this.rejectPending(
        key,
        pending,
        this.error('protocol', marker.kind, marker.runId, 'Run-port handoff contained no usable port.'),
      );
      return;
    }

    this.removePending(key, pending);
    this.cleanupPending(pending);
    pending.resolve(port);
  }

  private isExpectedOrigin(origin: string): boolean {
    if (origin === this.targetWindow.location.origin) return true;
    if (this.targetWindow.location.protocol === 'file:' && origin === 'null') return true;
    return origin === '';
  }

  private rejectPending(
    key: string,
    pending: PendingHandoff,
    error: RunPortError,
  ): void {
    if (!this.removePending(key, pending)) return;
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private removePending(key: string, pending: PendingHandoff): boolean {
    const queue = this.pending.get(key);
    if (!queue) return false;
    const index = queue.indexOf(pending);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(key);
    return true;
  }

  private cleanupPending(pending: PendingHandoff): void {
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
  }

  private abortedError(
    kind: RunPortHandoffKind,
    runId: string,
    signal: AbortSignal,
  ): RunPortError {
    return this.error('aborted', kind, runId, 'Run-port handoff was aborted.', signal.reason);
  }

  private error(
    code: RunPortErrorCode,
    kind: RunPortHandoffKind,
    runId: string,
    message: string,
    cause?: unknown,
  ): RunPortError {
    return new RunPortError(code, kind, runId, message, cause === undefined ? undefined : { cause });
  }
}

let singleton: RunPortBroker | null = null;

export function getRunPortBroker(): RunPortBroker {
  singleton ??= new RunPortBroker(window);
  return singleton;
}
