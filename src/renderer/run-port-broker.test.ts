// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RunPortBroker,
  RunPortError,
  type RunPortHandoffKind,
} from './run-port-broker';

interface TestPort extends MessagePort {
  readonly close: ReturnType<typeof vi.fn>;
}

function testPort(): TestPort {
  return {
    addEventListener: vi.fn(),
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    removeEventListener: vi.fn(),
    onmessage: null,
    onmessageerror: null,
  } as unknown as TestPort;
}

function handoff(
  kind: RunPortHandoffKind,
  runId: string,
  port: MessagePort,
  options?: {
    readonly source?: MessageEventSource | null;
    readonly origin?: string;
    readonly data?: unknown;
  },
): void {
  const event = new MessageEvent('message', {
    data: options?.data ?? (kind === 'run' ? { _ezPort: runId } : { _ezAttachPort: runId }),
    source: options?.source === undefined ? window : options.source,
    origin: options?.origin ?? '',
  });
  Object.defineProperty(event, 'ports', {
    value: [port],
    enumerable: true,
    configurable: true,
  });
  window.dispatchEvent(event);
}

const brokers: RunPortBroker[] = [];

function broker(): RunPortBroker {
  const result = new RunPortBroker(window);
  brokers.push(result);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  for (const instance of brokers.splice(0)) instance.dispose();
});

describe('RunPortBroker', () => {
  it('registers before send and accepts a synchronous mobile-style handoff', async () => {
    const instance = broker();
    const port = testPort();

    const result = instance.request({
      kind: 'run',
      runId: 'run-sync',
      send: () => handoff('run', 'run-sync', port),
    });

    await expect(result).resolves.toBe(port);
    expect(instance.pendingCount).toBe(0);
    expect(port.close).not.toHaveBeenCalled();
  });

  it('times out a missing handoff after the 15 second default', async () => {
    vi.useFakeTimers();
    const instance = broker();
    const result = instance.request({
      kind: 'run',
      runId: 'run-missing',
      send: () => undefined,
    });
    const rejection = expect(result).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(instance.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(instance.pendingCount).toBe(0);
  });

  it('accepts a delayed handoff that arrives before the deadline', async () => {
    vi.useFakeTimers();
    const instance = broker();
    const port = testPort();
    const result = instance.request({
      kind: 'attach',
      runId: 'run-delayed',
      send: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(14_999);
    handoff('attach', 'run-delayed', port);

    await expect(result).resolves.toBe(port);
  });

  it('closes duplicate and late ports instead of retaining orphan endpoints', async () => {
    vi.useFakeTimers();
    const instance = broker();
    const accepted = testPort();
    const duplicate = testPort();
    const late = testPort();
    const result = instance.request({
      kind: 'run',
      runId: 'run-duplicate',
      send: () => undefined,
    });

    handoff('run', 'run-duplicate', accepted);
    await expect(result).resolves.toBe(accepted);
    handoff('run', 'run-duplicate', duplicate);
    expect(duplicate.close).toHaveBeenCalledOnce();

    const timedOut = instance.request({
      kind: 'attach',
      runId: 'run-late',
      send: () => undefined,
      timeoutMs: 1,
    });
    const rejection = expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    handoff('attach', 'run-late', late);
    expect(late.close).toHaveBeenCalledOnce();
  });

  it('hands equivalent same-run attach ports to concurrent panes in FIFO order', async () => {
    const instance = broker();
    const firstPort = testPort();
    const secondPort = testPort();
    const first = instance.request({
      kind: 'attach',
      runId: 'shared-run',
      send: () => undefined,
    });
    const second = instance.request({
      kind: 'attach',
      runId: 'shared-run',
      send: () => undefined,
    });
    expect(instance.pendingCount).toBe(2);

    handoff('attach', 'shared-run', firstPort);
    handoff('attach', 'shared-run', secondPort);

    await expect(first).resolves.toBe(firstPort);
    await expect(second).resolves.toBe(secondPort);
    expect(instance.pendingCount).toBe(0);
  });

  it('rejects malformed matching schemas and closes their ports', async () => {
    const instance = broker();
    const port = testPort();
    const result = instance.request({
      kind: 'run',
      runId: 'run-schema',
      send: () => undefined,
    });

    handoff('run', 'run-schema', port, {
      data: { _ezPort: 'run-schema', unexpected: true },
    });

    await expect(result).rejects.toMatchObject({ code: 'protocol' });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('closes a wrong-source port without consuming the legitimate pending request', async () => {
    const instance = broker();
    const attackerPort = testPort();
    const acceptedPort = testPort();
    const result = instance.request({
      kind: 'run',
      runId: 'run-source',
      send: () => undefined,
    });

    handoff('run', 'run-source', attackerPort, { source: null });
    expect(attackerPort.close).toHaveBeenCalledOnce();
    expect(instance.pendingCount).toBe(1);

    handoff('run', 'run-source', acceptedPort);
    await expect(result).resolves.toBe(acceptedPort);
  });

  it.each(['unmount', 'disconnect'])(
    'aborts and idempotently cleans a pending request on %s',
    async (reason) => {
      const instance = broker();
      const controller = new AbortController();
      const result = instance.request({
        kind: 'attach',
        runId: `run-${reason}`,
        signal: controller.signal,
        send: () => undefined,
      });

      controller.abort(reason);
      controller.abort(reason);

      await expect(result).rejects.toMatchObject({
        code: 'aborted',
        cause: reason,
      });
      expect(instance.pendingCount).toBe(0);
    },
  );

  it('turns a synchronous or asynchronous send failure into unavailable', async () => {
    const instance = broker();
    await expect(instance.request({
      kind: 'run',
      runId: 'run-throw',
      send: () => {
        throw new Error('offline');
      },
    })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(instance.request({
      kind: 'attach',
      runId: 'run-reject',
      send: () => Promise.reject(new Error('offline')),
    })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects duplicate pending correlations without replacing the first request', async () => {
    const instance = broker();
    const controller = new AbortController();
    const first = instance.request({
      kind: 'run',
      runId: 'run-pending',
      signal: controller.signal,
      send: () => undefined,
    });
    const firstRejection = expect(first).rejects.toBeInstanceOf(RunPortError);

    await expect(instance.request({
      kind: 'run',
      runId: 'run-pending',
      send: () => undefined,
    })).rejects.toMatchObject({ code: 'protocol' });
    expect(instance.pendingCount).toBe(1);

    controller.abort();
    await firstRejection;
  });
});
