import type { InterpreterFrame, RendererControl } from '../shared/ipc';
import type { RemotePort } from './interpreter-broker';

/** A transient mobile disconnect keeps at most this many run ports alive. */
export const REMOTE_RUN_LEASE_CAP = 32;
/** Foreground/background network changes are recoverable for five minutes. */
export const REMOTE_RUN_LEASE_MS = 5 * 60 * 1000;

interface LeaseRecord {
  readonly key: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly port: RemotePort;
  readonly createdAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RemoteRunLeaseOptions {
  readonly ttlMs?: number;
  readonly cap?: number;
  readonly now?: () => number;
}

function leaseKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

/**
 * Owns MessagePorts whose mobile websocket disappeared unexpectedly.
 *
 * The port deliberately remains open so the interpreter's last-port-close
 * rule cannot kill the underlying PTY. While no renderer can flush xterm, the
 * registry acknowledges every PTY chunk and drops it; a later `resume-run`
 * opens an authoritative attach/replay port before this orphan is closed.
 */
export class RemoteRunLeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(options: RemoteRunLeaseOptions = {}) {
    this.ttlMs = options.ttlMs ?? REMOTE_RUN_LEASE_MS;
    this.cap = options.cap ?? REMOTE_RUN_LEASE_CAP;
    this.now = options.now ?? Date.now;
  }

  park(sessionId: string, runId: string, port: RemotePort): void {
    const key = leaseKey(sessionId, runId);
    this.releaseKey(key);

    while (this.leases.size >= this.cap) {
      const oldest = [...this.leases.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.releaseKey(oldest.key);
    }

    const timer = setTimeout(() => this.releaseKey(key), this.ttlMs);
    timer.unref?.();
    const record: LeaseRecord = {
      key,
      sessionId,
      runId,
      port,
      createdAt: this.now(),
      timer,
    };
    this.leases.set(key, record);

    // Keep the primary/attach subscriber below its high-water mark while the
    // phone is absent. MAX_SAFE_INTEGER is safe here: interpreter-side ack
    // logic clamps cumulative acknowledgements to bytes actually sent.
    port.on('message', (event: { data: unknown }) => {
      if (this.leases.get(key) !== record) return;
      const frame = event.data as InterpreterFrame;
      if (frame?.type !== 'pty-data') return;
      try {
        port.postMessage({ type: 'pty-ack', bytes: Number.MAX_SAFE_INTEGER } satisfies RendererControl);
      } catch {
        this.releaseKey(key, false);
      }
    });
    port.on('close', () => {
      if (this.leases.get(key) === record) this.releaseKey(key, false);
    });
  }

  has(sessionId: string, runId: string): boolean {
    return this.leases.has(leaseKey(sessionId, runId));
  }

  /** Remove a lease without closing it; caller closes it after replacement is live. */
  take(sessionId: string, runId: string): RemotePort | null {
    const key = leaseKey(sessionId, runId);
    const record = this.leases.get(key);
    if (!record) return null;
    clearTimeout(record.timer);
    this.leases.delete(key);
    return record.port;
  }

  release(sessionId: string, runId: string): void {
    this.releaseKey(leaseKey(sessionId, runId));
  }

  dispose(): void {
    for (const key of [...this.leases.keys()]) this.releaseKey(key);
  }

  get size(): number {
    return this.leases.size;
  }

  private releaseKey(key: string, close = true): void {
    const record = this.leases.get(key);
    if (!record) return;
    clearTimeout(record.timer);
    this.leases.delete(key);
    if (!close) return;
    try {
      record.port.close();
    } catch {
      // Already closed by interpreter/session teardown.
    }
  }
}
