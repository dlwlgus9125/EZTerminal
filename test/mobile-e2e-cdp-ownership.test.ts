import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface WireRequest {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const wire = vi.hoisted(() => ({
  requests: [] as WireRequest[],
  evaluation: {} as Record<string, unknown>,
  failRelease: false,
  delayRelease: false,
  releaseReplies: [] as Array<() => void>,
  terminated: 0,
  removedForwards: 0,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn((_command: string, args: string[]) => {
    if (args.includes('devices')) return { status: 0, stdout: 'List of devices attached\nemulator-5558\tdevice\n', stderr: '' };
    if (args.includes('/proc/net/unix')) return { status: 0, stdout: '@webview_devtools_remote_7777', stderr: '' };
    if (args.includes('tcp:0')) return { status: 0, stdout: '34567', stderr: '' };
    if (args.includes('--remove')) {
      wire.removedForwards += 1;
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected adb command: ${args.join(' ')}`);
  }),
}));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class WebSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = 0;

    constructor() {
      super();
      queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }

    send(raw: string, callback: (error?: Error) => void): void {
      const request = JSON.parse(raw) as WireRequest;
      wire.requests.push(request);
      callback();
      const reply = (): void => {
        const response = request.method === 'Runtime.releaseObject' && wire.failRelease
          ? { id: request.id, error: { message: 'release failed' } }
          : { id: request.id, result: request.method === 'Runtime.evaluate' ? wire.evaluation : {} };
        this.emit('message', Buffer.from(JSON.stringify(response)));
      };
      if (request.method === 'Runtime.releaseObject' && wire.delayRelease) wire.releaseReplies.push(reply);
      else queueMicrotask(reply);
    }

    terminate(): void {
      this.readyState = 3;
      wire.terminated += 1;
      queueMicrotask(() => this.emit('close'));
    }
  }
  return { WebSocket };
});

import { closeMobileE2eResources, evaluateWebView } from '../mobile/e2e/lib.ts';

beforeEach(() => {
  wire.requests = [];
  wire.failRelease = false;
  wire.delayRelease = false;
  wire.releaseReplies = [];
  wire.terminated = 0;
  wire.removedForwards = 0;
  wire.evaluation = {
    result: { type: 'object', subtype: 'error', objectId: 'result-error' },
    exceptionDetails: { text: 'Uncaught', exception: { objectId: 'exception-error' } },
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => [{ type: 'page', url: 'http://localhost/', webSocketDebuggerUrl: 'ws://localhost:34567/page' }],
  })));
});

afterEach(() => {
  closeMobileE2eResources();
  vi.unstubAllGlobals();
});

describe('Android evaluation object ownership', () => {
  it('releases both exception references before rejecting the evaluation', async () => {
    wire.delayRelease = true;
    let rejected = false;
    const evaluation = evaluateWebView('throw new Error()').catch((error: unknown) => {
      rejected = true;
      throw error;
    });
    const assertion = expect(evaluation).rejects.toThrow('Uncaught');
    await vi.waitFor(() => expect(wire.releaseReplies).toHaveLength(1));
    expect(rejected).toBe(false);
    wire.releaseReplies.shift()!();
    await vi.waitFor(() => expect(wire.releaseReplies).toHaveLength(1));
    expect(rejected).toBe(false);
    wire.releaseReplies.shift()!();
    await assertion;
    expect(wire.requests.filter(row => row.method === 'Runtime.releaseObject').map(row => row.params.objectId))
      .toEqual(['result-error', 'exception-error']);
  });

  it('releases a shared reference once and preserves ordinary by-value results', async () => {
    wire.evaluation = {
      result: { objectId: 'shared-error' },
      exceptionDetails: { text: 'Uncaught', exception: { objectId: 'shared-error' } },
    };
    await expect(evaluateWebView('throw new Error()')).rejects.toThrow('Uncaught');
    expect(wire.requests.filter(row => row.method === 'Runtime.releaseObject')).toHaveLength(1);
    wire.evaluation = { result: { value: { ready: true } } };
    await expect(evaluateWebView('({ ready: true })')).resolves.toEqual({ ready: true });
    expect(wire.requests.filter(row => row.method === 'Runtime.releaseObject')).toHaveLength(1);
  });

  it('retires the inspector if object cleanup fails and preserves the original error', async () => {
    wire.failRelease = true;
    await expect(evaluateWebView('throw new Error()')).rejects.toThrow('Uncaught');
    expect(wire.terminated).toBe(1);
    expect(wire.removedForwards).toBe(1);
    wire.failRelease = false;
    wire.evaluation = { result: { value: 42 } };
    await expect(evaluateWebView('42')).resolves.toBe(42);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
