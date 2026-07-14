import { describe, expect, it, vi } from 'vitest';

import type { RemotePort } from './interpreter-broker';
import { RemoteRunLeaseRegistry } from './remote-run-lease';

class FakePort implements RemotePort {
  closed = false;
  readonly posted: unknown[] = [];
  private readonly messages: Array<(event: { data: unknown }) => void> = [];
  private readonly closes: Array<() => void> = [];

  postMessage(message: unknown): void { this.posted.push(message); }
  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messages.push(listener as never);
    else this.closes.push(listener as never);
  }
  start(): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener();
  }
  emit(data: unknown): void { for (const listener of this.messages) listener({ data }); }
}

describe('RemoteRunLeaseRegistry', () => {
  it('keeps an orphan open, drains PTY output with cumulative acks, and transfers ownership', () => {
    const registry = new RemoteRunLeaseRegistry({ ttlMs: 1_000 });
    const port = new FakePort();
    registry.park('s1', 'r1', port);
    port.emit({ type: 'pty-data', data: new Uint8Array([1, 2]) });
    expect(port.posted).toEqual([{ type: 'pty-ack', bytes: Number.MAX_SAFE_INTEGER }]);
    expect(registry.take('s1', 'r1')).toBe(port);
    expect(port.closed).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('expires a lease and evicts the oldest entry at the cap', () => {
    vi.useFakeTimers();
    try {
      let now = 1;
      const registry = new RemoteRunLeaseRegistry({ ttlMs: 50, cap: 1, now: () => now++ });
      const first = new FakePort();
      const second = new FakePort();
      registry.park('s1', 'r1', first);
      registry.park('s2', 'r2', second);
      expect(first.closed).toBe(true);
      expect(second.closed).toBe(false);
      vi.advanceTimersByTime(50);
      expect(second.closed).toBe(true);
      expect(registry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replacing or disposing leases closes every displaced port', () => {
    const registry = new RemoteRunLeaseRegistry({ ttlMs: 1_000 });
    const first = new FakePort();
    const replacement = new FakePort();
    registry.park('s', 'r', first);
    registry.park('s', 'r', replacement);
    expect(first.closed).toBe(true);
    registry.dispose();
    expect(replacement.closed).toBe(true);
  });

  it('does not duplicate drain acknowledgements when the same port is taken and re-parked', () => {
    const registry = new RemoteRunLeaseRegistry({ ttlMs: 1_000 });
    const port = new FakePort();
    registry.park('s', 'r', port);
    expect(registry.take('s', 'r')).toBe(port);
    registry.park('s', 'r', port);
    port.emit({ type: 'pty-data', data: new Uint8Array([1]) });
    expect(port.posted).toHaveLength(1);
  });
});
